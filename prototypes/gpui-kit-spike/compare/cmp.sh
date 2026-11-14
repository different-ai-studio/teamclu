set -e
cd "$(dirname "$0")"
IDS=$(swift winid.swift)
screencapture -x -o -l"$(echo "$IDS" | awk '/^TeamClu /{print $2}')" desktop.png
screencapture -x -o -l"$(echo "$IDS" | awk '/gpui-kit-spike/{print $2}')" spike.png
python3 - <<'PY'
from PIL import Image
a=Image.open("desktop.png").convert("RGB"); b=Image.open("spike.png").convert("RGB")
print(a.size,b.size)
W,H=a.size
for name,box in {"nav":(0,0,440,H),"list":(440,0,1000,H),"chattop":(1000,0,W,900),"chatbot":(1000,800,W,H)}.items():
    w=box[2]-box[0]; h=box[3]-box[1]
    im=Image.new("RGB",(w*2+10,h),"red"); im.paste(a.crop(box),(0,0)); im.paste(b.crop(box),(w+10,0)); im.save(f"cmp-{name}.png")
PY
