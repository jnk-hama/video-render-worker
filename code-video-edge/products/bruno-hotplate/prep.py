#!/usr/bin/env python3
# BRUNO コンパクトホットプレートの下ごしらえ（#382 A：素材の良い商品・合成しない）：python3 prep.py <取った素材の置き場> <出力先 b3d/> [組]
#   販売ページの写真（1600px）の字の無い範囲を、縦 9:16 に切って全画面に使う（約2倍まで）。奥行きで動かす（画素の場所を動かすだけ・#343）。
#   切り抜きを別の映像に貼らない（#382）。湯気は本物の映像（黒地）を料理の上に明るい所だけ重ねる。
#   素材の順（assets.json）：asp2=たこ焼きパーティー（手）／asp4=たこ焼きの寄り（赤）／asp8=持つ人／asp9=プレート2枚とふた／asp10=平面プレートの串焼き（湯気）／asp11=赤とパエリア／asp12=棚の収納
#                          vid0=黒地の細い湯気／vid1=黒地の濃い湯気／vid2=クリスマスの食卓
import json, math, os, subprocess, sys
import numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1:3]; G = sys.argv[3] if len(sys.argv) > 3 else "base"; root = os.path.dirname(out.rstrip("/"))
img, fv, sb, dp = (os.path.join(root, d) for d in ("img", "fv", "sb", "dp"))
for d in (img, fv, sb, dp): os.makedirs(d, exist_ok=True)
try:
    import imageio_ffmpeg; FF = imageio_ffmpeg.get_ffmpeg_exe()
except Exception: FF = os.environ.get("FFMPEG", "ffmpeg")
A = lambda i: Image.open(os.path.join(src, f"asp{i}.jpg")).convert("RGB")
if G != "base": sys.exit(f"組の名前が違う: {G}")
# 1) 縦 9:16 の範囲（元の画素・字の無い所・目で決めた）→ 1080×1920
SHOTS = {"party": (2, (0, 655, 531, 1600)), "center": (2, (520, 650, 1054, 1600)), "hands2": (2, (1069, 655, 1600, 1600)), "close": (4, (540, 370, 1063, 1300)), "open": (9, (450, 350, 1153, 1600)),
         "grill": (10, (280, 400, 932, 1560)), "paella": (11, (520, 240, 1094, 1260)), "hold": (8, (1088, 540, 1543, 1350)),
         "shelf": (12, (500, 300, 1100, 1367))}
for name, (i, bx) in SHOTS.items():
    A(i).crop(bx).save(os.path.join(sb, f"{name}.png"))
    d = np.asarray(Image.open(os.path.join(src, "depth", f"asp{i}.png"))).astype(np.float32)[bx[1]:bx[3], bx[0]:bx[2]]
    d = (d - d.min()) / max(1e-6, d.max() - d.min()); Image.fromarray((d * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2)).save(os.path.join(sb, f"{name}_d.png"))
# 2) カメラ（ここ1か所）：名前 → (写真, コマ数, u → zoom, dx, dy, ox, oy)。30コマ/秒・dolly 0.6（カメラごと近づく）
oc = lambda u: 1 - (1 - u) ** 3; ios = lambda u: 0.5 - 0.5 * math.cos(math.pi * u)
CAM = {"party_in": ("party", 90, lambda u: (1.00 + 0.10 * oc(u), -0.01 + 0.02 * ios(u), 0.0, 0.5, 0.62)),     # 2人の手が串でたこ焼きを返す所へ寄る（左）
       "hands2_in": ("hands2", 90, lambda u: (1.08 - 0.07 * oc(u), 0.0, 0.0, 0.4, 0.5)),                    # 右の手から引く（評価の場面・別の手）
       "close_in": ("close", 90, lambda u: (1.04 + 0.10 * ios(u), 0.02 - 0.04 * ios(u), 0.0, 0.5, 0.5)),       # 寄りながら横へ
       "open_in": ("open", 100, lambda u: (1.10 - 0.08 * oc(u), 0.0, 0.01 * oc(u), 0.5, 0.45)),               # 24の穴を見せて引く
       "grill_in": ("grill", 90, lambda u: (1.02 + 0.09 * ios(u), -0.02 + 0.03 * ios(u), 0.0, 0.5, 0.5)),     # 串の上を横へ
       "paella_in": ("paella", 110, lambda u: (1.00 + 0.12 * oc(u), 0.0, -0.01 * oc(u), 0.5, 0.48)),          # 山場：ふたの BRUNO と鍋へゆっくり寄る
       "hold_in": ("hold", 100, lambda u: (1.08 - 0.06 * oc(u), 0.0, 0.0, 0.5, 0.55)),                       # 持つ所から引く
       "shelf_in": ("shelf", 100, lambda u: (1.00 + 0.08 * oc(u), 0.0, 0.0, 0.5, 0.55)),
       "party_end": ("center", 120, lambda u: (1.12 - 0.10 * oc(u), 0.0, 0.0, 0.5, 0.6))}
ONLY = [s for s in os.environ.get("ONLY", "").split(",") if s]   # 直しの時は描き直す連番だけ（全部で約20分かかるため）
if ONLY: CAM = {k: v for k, v in CAM.items() if k in ONLY}
DOF = {"paella_in": lambda u: {"at": 0.75, "k": 4, "range": 0.6}, "close_in": lambda u: {"at": 0.8, "k": 3, "range": 0.6}}
jobs = {}
for name, (ph, n, cam) in CAM.items():
    jobs[name] = []
    for k in range(n):
        z, dx, dy, ox, oy = cam(k / (n - 1))
        jobs[name].append({"src": f"{ph}.png", "depth": f"{ph}_d.png", "w": 1080, "h": 1920, "zoom": round(z, 5), "dx": round(dx, 5), "dy": round(dy, 5),
                           "focus": 0.8, "dolly": 0.6, "ox": ox, "oy": oy, "out": f"{name}_{k:04d}.jpg", "dof": DOF[name](k / (n - 1)) if name in DOF else None})
jp = os.path.join(sb, "depth_jobs.json"); json.dump(jobs, open(jp, "w"))
subprocess.run([sys.executable, os.path.join("factory", "depthwarp.py"), jp, sb, dp], check=True)   # 作業場所の直下で動かす（factory/ がある所）
for name, (ph, n, _) in CAM.items():
    m = len([f for f in os.listdir(dp) if f.startswith(name + "_")])
    if m != n: sys.exit(f"奥行きの連番 {name} が足りない {m}/{n}")
# 3) 映像のコマ（開始秒・長さ）。30コマ/秒・1080×1920
CLIPS = {"steam": ("vid0", 0.5, 8.0), "steam2": ("vid1", 1.0, 8.0), "xmas": ("vid2", 1.0, 8.0)}
for k, (v, ss, dur) in CLIPS.items():
    subprocess.run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", os.path.join(src, v + ".mp4"),
                    "-vf", "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "3", "-start_number", "0", os.path.join(fv, f"{k}_%04d.jpg")], check=True)
    n = len([f for f in os.listdir(fv) if f.startswith(k + "_")])
    if n < int(dur * 30) - 4: sys.exit(f"映像 {k} のコマが足りない {n}")
    print("clip", k, n)
g = np.random.default_rng(7).normal(128, 26, (512, 512)).clip(0, 255).astype(np.uint8)
Image.fromarray(g, "L").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(img, "grain.png")); print("grain")
