#!/usr/bin/env python3
# 箱の商品を立体にする下ごしらえ（#359）： python3 box3d_prep.py <取った素材 asp*.jpg> <出力 p/nagomilab-toilet/b3d>
#   販売ページの写真の画素は描き変えない。斜めに写った面を四隅で長方形に戻す（射影変換）だけ。
#   正面・上＝asp8（正面から撮った箱・高解像度）、左の側面＝asp0（斜めから撮った箱）。右・後ろ・底は写真が無い＝見せない（型の側で回す角度を絞る）
#   中身（白い防臭袋・凝固剤・ティッシュ・黒い袋）は asp8 の右の列から切り抜く。白い物（袋・凝固剤）は背景の白を外周から塗って外す
#   （BiRefNet では白い袋が白い背景に溶けて欠け、凝固剤は半分透けた）。ティッシュ・黒い袋は BiRefNet
import json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

src, out = sys.argv[1:3]; os.makedirs(out, exist_ok=True)
CV = os.environ.get("CVPY", "/home/user/.motion-work/venv-cv/bin/python")   # Actions では opencv の入った python を渡す（edge-video.yml）
# 四隅（左上・右上・右下・左下）。写真を 3倍に拡大して目盛りで読んだ値
FRONT = ("asp8", [(5, 135), (1142, 135), (1142, 1400), (5, 1400)])
TOP = ("asp8", [(110, 22), (990, 22), (1142, 135), (5, 135)])         # 上の面（奥の辺・手前の辺）。奥の左の角は x=30 では背景の白が入った
LEFT = ("asp0", [(13, 33), (172, 108), (172, 818), (13, 653)])        # 左の側面（奥・手前の角）。下の辺は (60,700)(120,760)(172,818) の直線を x=13 へ延ばした
W = 1137; H = 1263; D = round(W * 0.85)   # 正面の縦横は写真から。奥行きは写真で測れない＝立方体に近い箱として 0.85（推測。動画では寸法を言わない）
WARP = ("import cv2,numpy as np,sys,json; a=json.loads(sys.argv[3]); im=cv2.imread(sys.argv[1]); w,h=a['size'];"
        "M=cv2.getPerspectiveTransform(np.float32(a['q']),np.float32([[0,0],[w,0],[w,h],[0,h]])); cv2.imwrite(sys.argv[2], cv2.warpPerspective(im,M,(w,h),flags=cv2.INTER_CUBIC))")
ONLY = sys.argv[3:]   # 名前を渡すとその物だけ（BiRefNet は1つの処理で2回続けると 14GB まで膨らみ落ちた＝1回ずつ別の処理で呼ぶ）
for name, (asp, q), size in [("front", FRONT, (W, H)), ("top", TOP, (W, D)), ("left", LEFT, (D, H))]:
    if ONLY and name not in ONLY: continue
    subprocess.run([CV, "-c", WARP, os.path.join(src, f"{asp}.jpg"), os.path.join(out, f"{name}.png"), json.dumps({"q": q, "size": size})], check=True)
    print(name, size)
# 中身：asp8 の右の列。名前: 箱（x0,y0,x1,y1）
from rembg import remove, new_session
sess = new_session("birefnet-general", providers=["CPUExecutionProvider"]) if not ONLY or set(ONLY) & {"tissue", "black"} else None
PARTS = {"white": (1148, 0, 1480, 300), "sachet": (1148, 318, 1500, 770), "tissue": (1148, 800, 1500, 1010), "black": (1155, 1060, 1495, 1430)}
im8 = Image.open(os.path.join(src, "asp8.jpg")).convert("RGB")
meta = json.load(open(os.path.join(out, "box.json"))) if os.path.exists(os.path.join(out, "box.json")) else {"parts": {}}
meta["box"] = {"w": W, "h": H, "d": D}
def white_bg(c, cut=()):   # 外周につながる白（全色 248 以上）だけを透明に。中の白（袋の面）は灰の縁で囲まれているので残る
    a = np.asarray(c).min(axis=2) >= 248; lab, _ = ndimage.label(a); edge = set(np.unique(np.r_[lab[0], lab[-1], lab[:, 0], lab[:, -1]])) - {0}
    m = np.where(np.isin(lab, list(edge)), 0, 255).astype(np.uint8)
    for x0, y0, x1, y1 in cut: m[y0:y1, x0:x1] = 0
    return Image.fromarray(m).filter(ImageFilter.MinFilter(3))
WHITE = {"white": [(292, 250, 332, 300)], "sachet": []}   # 白い袋の箱の右下に凝固剤1袋の角が入る＝消す
for name, box in PARTS.items():
    if ONLY and name not in ONLY: continue
    c = im8.crop(box)
    m = white_bg(c, WHITE[name]) if name in WHITE else remove(c, session=sess, only_mask=True, post_process_mask=False).convert("L").filter(ImageFilter.MinFilter(3))
    Image.fromarray(np.dstack([np.asarray(c), np.asarray(m)])).save(os.path.join(out, f"{name}.png")); meta["parts"][name] = {"w": c.width, "h": c.height}
    print(name, c.size, flush=True)
# 凝固剤の1袋（右上の1つ）：数える場面で並べる。並べるのは同じ写真の写し（数は販売ページの数字どおり）
if not ONLY or "one" in ONLY:
  one = im8.crop((1443, 326, 1492, 393)).resize((196, 268), Image.LANCZOS); m1 = white_bg(one)   # 箱は白の塗りの切れ目で測った1袋ちょうど（隣の袋が入らない）。4倍に
  Image.fromarray(np.dstack([np.asarray(one), np.asarray(m1)])).save(os.path.join(out, "one.png"))
  meta["parts"]["one"] = {"w": 196, "h": 268}
json.dump(meta, open(os.path.join(out, "box.json"), "w"), indent=1)
