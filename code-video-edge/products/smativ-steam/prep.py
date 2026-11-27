#!/usr/bin/env python3
# スチームクリーナー（Smativ+）の下ごしらえ（型 kinetic・安定した品質 6-0）：python3 prep.py <取った素材の置き場> <出力先 b3d/> [組]
#   商品は販売ページの写真だけ（描き変えない・字や札の無い範囲を切る）。写真は奥行きで動かす（画素の場所を動かすだけ・#343）。場面は Pexels の本物の映像（明るい朝の家）。
#   素材の順（assets.json）：asp2=床を拭く人（縦）／asp3=場面集（サッシ）／asp8=ハンディ（コンロ・レンジフード）／asp9=スティック（床）／asp16=セット内容
#                          vid0=朝日の台所（流し）／vid1=明るい台所の台／vid2=朝日の窓辺の机
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
up = lambda im, w: im.resize((w, round(im.height * w / im.width)), Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.4, 50, 2))

if G != "base": sys.exit(f"組の名前が違う: {G}")
# 1) 平らに使う写真（字・札・枠の無い範囲＝元の画像の画素・目で決めた）。2倍に拡大
FLAT = {"stove": (8, (0, 415, 640, 700)), "hood": (8, (700, 410, 1500, 700)), "sash": (3, (700, 740, 1500, 1250)),
        "kwall": (3, (0, 520, 640, 790)), "set": (16, (0, 180, 1500, 610))}
for name, (i, bx) in FLAT.items():
    im = A(i).crop(bx); im = up(im, im.width * 2); im.save(os.path.join(img, f"{name}.jpg"), quality=93); print(name, im.size)
# 2) 奥行きで動かす写真と出す大きさ（奥行き＝depth/asp*.png・白＝近い。範囲の中で 0〜1 に伸ばす）
SHOTS = {"woman": (2, (0, 300, 600, 1367), (1080, 1920)), "floor": (9, (0, 420, 620, 1180), (1080, 1324))}
for name, (i, bx, _) in SHOTS.items():
    A(i).crop(bx).save(os.path.join(sb, f"{name}.png"))
    d = np.asarray(Image.open(os.path.join(src, "depth", f"asp{i}.png"))).astype(np.float32)[bx[1]:bx[3], bx[0]:bx[2]]
    d = (d - d.min()) / max(1e-6, d.max() - d.min()); Image.fromarray((d * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2)).save(os.path.join(sb, f"{name}_d.png"))
# 3) カメラ（ここ1か所）：名前 → (写真, コマ数, u → zoom, dx, dy, ox, oy)。30コマ/秒・dolly 0.6
oc = lambda u: 1 - (1 - u) ** 3; ios = lambda u: 0.5 - 0.5 * math.cos(math.pi * u)
CAM = {"woman_in": ("woman", 90, lambda u: (1.00 + 0.10 * oc(u), 0.0, -0.01 * oc(u), 0.5, 0.62)),     # 掃除する人へゆっくり寄る（床のモップ）
       "floor_in": ("floor", 120, lambda u: (1.02 + 0.08 * ios(u), -0.02 + 0.04 * ios(u), 0.0, 0.55, 0.7)),  # 床のヘッドへ寄りながら横へ
       "woman_end": ("woman", 120, lambda u: (1.06 - 0.06 * oc(u), 0.0, 0.0, 0.5, 0.55))}            # 行動：引いて全体
DOF = {"floor_in": lambda u: {"at": 0.85, "k": 5, "range": 0.55}}
jobs = {}
for name, (ph, n, cam) in CAM.items():
    w, h = SHOTS[ph][2]; jobs[name] = []
    for k in range(n):
        z, dx, dy, ox, oy = cam(k / (n - 1))
        jobs[name].append({"src": f"{ph}.png", "depth": f"{ph}_d.png", "w": w, "h": h, "zoom": round(z, 5), "dx": round(dx, 5), "dy": round(dy, 5),
                           "focus": 0.8, "dolly": 0.6, "ox": ox, "oy": oy, "out": f"{name}_{k:04d}.jpg", "dof": DOF[name](k / (n - 1)) if name in DOF else None})
jp = os.path.join(sb, "depth_jobs.json"); json.dump(jobs, open(jp, "w"))
subprocess.run([sys.executable, os.path.join("factory", "depthwarp.py"), jp, sb, dp], check=True)   # 作業場所の直下で動かす（factory/ がある所）
for name, (ph, n, _) in CAM.items():
    m = len([f for f in os.listdir(dp) if f.startswith(name + "_")])
    if m != n: sys.exit(f"奥行きの連番 {name} が足りない {m}/{n}")
# 4) 映像のコマ（開始秒・長さ）。30コマ/秒・1080×1920
CLIPS = {"kit": ("vid0", 0.5, 7.0), "counter": ("vid1", 0.5, 8.0), "window": ("vid2", 2.0, 8.0)}
for k, (v, ss, dur) in CLIPS.items():
    subprocess.run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", os.path.join(src, v + ".mp4"),
                    "-vf", "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "3", "-start_number", "0", os.path.join(fv, f"{k}_%04d.jpg")], check=True)
    n = len([f for f in os.listdir(fv) if f.startswith(k + "_")])
    if n < int(dur * 30) - 4: sys.exit(f"映像 {k} のコマが足りない {n}")
    print("clip", k, n)
g = np.random.default_rng(7).normal(128, 26, (512, 512)).clip(0, 255).astype(np.uint8)   # フィルムの粒子の素（種は固定）
Image.fromarray(g, "L").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(img, "grain.png")); print("grain")
