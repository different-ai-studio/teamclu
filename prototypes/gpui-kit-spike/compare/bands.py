import sys
from PIL import Image
import os; D=os.path.dirname(os.path.abspath(__file__))+"/"
a=Image.open(D+"desktop.png").convert("L"); b=Image.open(D+"spike.png").convert("L")
def bands(im,x0,x1,y0,y1,thr=150):
    out=[];start=None
    pa=im.load()
    for y in range(y0*2,y1*2):
        dark=any(pa[x,y]<thr for x in range(x0*2,x1*2,1))
        if dark and start is None: start=y
        if not dark and start is not None:
            out.append((start/2,y/2)); start=None
    return out
regions={k:tuple(map(int,v.split(","))) for k,v in (r.split("=") for r in sys.argv[1:])}
for name,(x0,x1,y0,y1) in regions.items():
    ba=bands(a,x0,x1,y0,y1); bb=bands(b,x0,x1,y0,y1)
    print(name)
    for i in range(max(len(ba),len(bb))):
        da=ba[i] if i<len(ba) else None; db=bb[i] if i<len(bb) else None
        delta = (db[0]-da[0], (db[1]-db[0])-(da[1]-da[0])) if da and db else ""
        print("  D",da," S",db," d(top,h)",delta)
