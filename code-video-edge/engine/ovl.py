import sys, glob, re, numpy as np
from PIL import Image
d = sys.argv[1]; thr = int(sys.argv[2]) if len(sys.argv) > 2 else 0
rows = []
for f in sorted(glob.glob(f"{d}/txt_*.png"), key=lambda p: float(re.findall(r"txt_(\d+\.\d+)", p)[0])):
    t = re.findall(r"txt_(\d+\.\d+)", f)[0]
    a = np.array(Image.open(f))[:, :, 3] > 20; b = np.array(Image.open(f.replace("txt_", "prd_")))[:, :, 3] > 60
    o = a & b; n = int(o.sum())
    if n > thr:
        ys, xs = np.where(o); rows.append((t, n, int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())))
print("t, 重なり画素, bbox(x0,y0,x1,y1)")
for r in rows: print(*r)
print("flagged:", len(rows), "/", len(glob.glob(f"{d}/txt_*.png")))
