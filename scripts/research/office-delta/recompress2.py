# 追加: strategy・memLevel・wbits を広げても一致しないか(小さいファイルで全探索)
import sys, zipfile, zlib, struct
p=sys.argv[1]; z=zipfile.ZipFile(p); f=open(p,'rb'); hit=0; n=0
for i in z.infolist():
    f.seek(i.header_offset); h=f.read(30); a,b=struct.unpack('<HH',h[26:30]); f.seek(i.header_offset+30+a+b); raw=f.read(i.compress_size); data=z.read(i.filename); n+=1
    ok=False
    for lvl in range(0,10):
        for mem in range(1,10):
            for wb in range(-15,-8):
                for st in (0,1,2,3,4):
                    try: c=zlib.compressobj(lvl,8,wb,mem,st)
                    except Exception: continue
                    if c.compress(data)+c.flush()==raw: ok=True; break
                if ok: break
            if ok: break
        if ok: break
    hit+=ok
print(f"{p.split('/')[-1]}: 全探索で一致 {hit}/{n} 部品")
