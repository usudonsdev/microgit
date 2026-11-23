import sys, zipfile, zlib, struct
def raw_members(path):
    z=zipfile.ZipFile(path); f=open(path,'rb'); out=[]
    for i in z.infolist():
        f.seek(i.header_offset); h=f.read(30)
        n,e=struct.unpack('<HH',h[26:30]); f.seek(i.header_offset+30+n+e)
        out.append((i, f.read(i.compress_size), z.read(i.filename)))
    return out
def tryall(data, raw):
    hits=[]
    for lvl in range(1,10):
        for mem in (8,9):
            for wb in (-15,):
                c=zlib.compressobj(lvl,zlib.DEFLATED,wb,mem); r=c.compress(data)+c.flush()
                if r==raw: hits.append((lvl,mem))
    return hits
for p in sys.argv[1:]:
    tot=ok=0; bt=bok=0
    for i,raw,data in raw_members(p):
        h=tryall(data,raw); tot+=1; bt+=len(raw)
        if h: ok+=1; bok+=len(raw)
        print(f"{p.split('/')[-1]:12} {i.filename[:40]:40} {len(data):>8} -> {len(raw):>7}  zlib一致: {h[:4] if h else 'なし'}")
    print(f"  => 一致 {ok}/{tot} 部品, 圧縮後バイトで {bok}/{bt}")
