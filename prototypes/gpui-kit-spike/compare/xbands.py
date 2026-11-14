import sys
from PIL import Image
import os; D=os.path.dirname(os.path.abspath(__file__))+"/"
a=Image.open(D+"desktop.png").convert("L"); b=Image.open(D+"spike.png").convert("L")
def bands(im,x0,x1,y0,y1,thr,gap):
    p=im.load(); cols=[any(p[x,y]<thr for y in range(y0*2,y1*2)) for x in range(x0*2,x1*2)]
    out=[];start=None;last=None
    for i,c in enumerate(cols):
        if c:
            if start is None: start=i
            elif i-last>gap*2: out.append(((x0*2+start)/2,(x0*2+last)/2)); start=i
            last=i
    if start is not None: out.append(((x0*2+start)/2,(x0*2+last)/2))
    return out
for arg in sys.argv[1:]:
    name,v=arg.split("="); x0,x1,y0,y1,thr,gap=map(int,v.split(","))
    ba=bands(a,x0,x1,y0,y1,thr,gap); bb=bands(b,x0,x1,y0,y1,thr,gap)
    print(name)
    for i in range(max(len(ba),len(bb))):
        da=ba[i] if i<len(ba) else None; db=bb[i] if i<len(bb) else None
        print("  D",da," S",db, (db[0]-da[0], (db[1]-db[0])-(da[1]-da[0])) if da and db else "")
