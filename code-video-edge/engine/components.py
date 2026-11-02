# cut0.png（BiRefNetで切り抜いた全体）→ 部品ごとの高品質RGBA。色のにじみ（旧背景の縁取り）を除いて保存する。
import numpy as np, cv2
from PIL import Image
from pymatting import estimate_foreground_ml
src = np.array(Image.open("assets/img0.jpg").convert("RGB")).astype(np.float64) / 255
cut = np.array(Image.open("cut0.png").convert("RGBA"))
alpha = cut[..., 3].astype(np.float64) / 255
m = (alpha > 0.16).astype(np.uint8)
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
names = {"vac": None, "station": None, "white": None}
comps = sorted([i for i in range(1, n) if st[i][4] > 3000], key=lambda i: st[i][0])  # 左→右
# bbox の x で判別: 左端=掃除機, 中=ステーション, 右端=白
by = sorted(comps, key=lambda i: -st[i][4])
vac = max(comps, key=lambda i: st[i][3])           # 最も背が高い
white = max(comps, key=lambda i: st[i][0])         # 最も右
station = [i for i in comps if i not in (vac, white)][0]
for name, i in (("vac", vac), ("station", station), ("white", white)):
    x, y, w, h, _ = st[i]
    pad = 6
    x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(720, x + w + pad), min(720, y + h + pad)
    sel = (lab[y0:y1, x0:x1] == i)
    # 他の部品に属する画素は透明に（重なる領域の取り違え防止）。同じ部品の近傍は残す
    keep = cv2.dilate(sel.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    a = alpha[y0:y1, x0:x1] * keep
    img = src[y0:y1, x0:x1]
    fg = estimate_foreground_ml(img, a)
    out = np.dstack([np.clip(fg, 0, 1), a])
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").save(f"comp_{name}.png")
    print(name, (x0, y0, x1, y1), "size", (x1 - x0, y1 - y0), "touches bottom edge:", y1 >= 719)
