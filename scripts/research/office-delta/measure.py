import sys, io, re, zipfile, zlib, struct, hashlib
import fastcdc
def raw_members(b):
    z=zipfile.ZipFile(io.BytesIO(b)); out=[]
    for i in z.infolist():
        h=b[i.header_offset:i.header_offset+30]; n,e=struct.unpack('<HH',h[26:30]); s=i.header_offset+30+n+e
        out.append((i.filename, b[s:s+i.compress_size], z.read(i.filename)))
    return out
def build(members):  # members: list of (name, rawdeflate, data) -> zip bytes (stored raw streams as-is)
    buf=io.BytesIO(); cd=b''; 
    for name,raw,data in members:
        nb=name.encode(); off=buf.tell(); crc=zlib.crc32(data)
        buf.write(struct.pack('<IHHHHHIIIHH',0x04034b50,20,6,8,0,0x21,crc,len(raw),len(data),len(nb),0)+nb+raw)
        cd+=struct.pack('<IHHHHHHIIIHHHHHII',0x02014b50,20,20,6,8,0,0x21,crc,len(raw),len(data),len(nb),0,0,0,0,0,off)+nb
    o=buf.tell(); buf.write(cd); buf.write(struct.pack('<IHHHHIIH',0x06054b50,0,0,len(members),len(members),len(cd),o,0)); return buf.getvalue()
def deflate1(d):
    c=zlib.compressobj(1,8,-15); return c.compress(d)+c.flush()
def chunks(d,avg):
    if not d: return []
    return [(c.hash, c.length, bytes(c.data)) for c in fastcdc.fastcdc(d, avg//4, avg, avg*8, fat=True, hf=hashlib.sha256)]
def newbytes(before_blobs, after_blobs, avg, compress=False):
    seen=set(h for b in before_blobs for h,_,_ in chunks(b,avg)); new=0; cnt=0
    for b in after_blobs:
        for h,l,d in chunks(b,avg):
            cnt+=1
            if h not in seen: seen.add(h); new+= len(zlib.compress(d,6)) if compress else l
    return new,cnt
def flip(text, frac):
    for m in re.finditer(r'<t[^>]*>([^<]*)</t>', text):
        if m.start() < int(len(text)*frac) and frac>0: continue
        for k,c in enumerate(m.group(1)):
            if c.isascii() and c.isalnum():
                j=m.start(1)+k; r='x' if c!='x' else 'y'; return text[:j]+r+text[j+1:]
    return flip(text,0) if frac>0 else text
def flipv(text, frac):
    i=text.find('<v>',int(len(text)*frac))+3; c=text[i]; r='7' if c!='7' else '8'
    return text[:i]+r+text[i+1:]
def touch_core(t): return re.sub(r'(<dcterms:modified[^>]*>)[^<]*', r'\g<1>2026-11-23T01:02:03Z', t)
EDITS={'ss_mid':('xl/sharedStrings.xml',lambda t:flip(t,0.5)),'ss_head':('xl/sharedStrings.xml',lambda t:flip(t,0.02)),
       'ss_tail':('xl/sharedStrings.xml',lambda t:flip(t,0.97)),'sheet_head':('xl/worksheets/sheet1.xml',lambda t:flipv(t,0.02))}
for p in sys.argv[1:]:
    orig=open(p,'rb').read(); mem=raw_members(orig); name=p.split('/')[-1]
    for en,(part,fn) in EDITS.items():
        def make(edit):
            out=[]
            for n,raw,data in mem:
                if n==part or n=='docProps/core.xml':
                    d=data.decode('utf-8')
                    if edit: d=fn(d) if n==part else touch_core(d)
                    d=d.encode(); out.append((n,deflate1(d),d))
                else: out.append((n,raw,data))
            return out
        A=make(False); B=make(True); za=build(A); zb=build(B)
        assert zipfile.ZipFile(io.BytesIO(zb)).testzip() is None
        changed=sum(1 for x,y in zip(A,B) if x[2]!=y[2])
        row=[name,en,f"{len(zb)/1024:.0f}KB"]
        for avg in (8192,2048):
            r1,_=newbytes([za],[zb],avg)
            r2,c2=newbytes([d for _,_,d in A],[d for _,_,d in B],avg,compress=True)
            r3,c3=newbytes([r for _,r,_ in A],[r for _,r,_ in B],avg)
            row+= [f"{avg//1024}K: そのまま {r1/len(zb)*100:.1f}% / 展開 {r2/len(zb)*100:.2f}% (一覧{c2*32/1024:.0f}KB) / 圧縮流を保持 {r3/len(zb)*100:.1f}%"]
        print(' | '.join(row), f'| 変わった部品 {changed}')
