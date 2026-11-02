import sys, glob, re, numpy as np, cv2
from PIL import Image
d = sys.argv[1]; pad = int(sys.argv[2]); ker = np.ones((pad*2+1, pad*2+1), np.uint8)
print("近接(文字から%dpx以内に商品)" % pad)
for f in sorted(glob.glob(f"{d}/txt_*.png"), key=lambda p: float(re.findall(r"txt_(\d+\.\d+)", p)[0])):
    t = re.findall(r"txt_(\d+\.\d+)", f)[0]
    a = (np.array(Image.open(f))[:, :, 3] > 20).astype(np.uint8); b = np.array(Image.open(f.replace("txt_", "prd_")))[:, :, 3] > 60
    n = int((cv2.dilate(a, ker) > 0)[b].sum())
    if n > 80:
        ys, xs = np.where((cv2.dilate(a, ker) > 0) & b); print(t, n, xs.min(), ys.min(), xs.max(), ys.max())
