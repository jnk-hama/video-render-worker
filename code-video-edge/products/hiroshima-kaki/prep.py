#!/usr/bin/env python3
# 広島産ジャンボかき 2kg の下ごしらえ（v2・絵コンテの型 board・jmas #377）：python3 prep.py <取った素材の置き場> <出力先 b3d/> [組]
#   組は1回に1つ（BiRefNet を1つの処理で2回呼ぶとメモリが膨らんで落ちた）：base → one → pile
#   商品は販売ページの写真だけ（描き変えない）。写真は奥行きで動かす（画素の場所を動かすだけ・#343）。場面は Pexels の本物の映像。
#   素材の順（assets.json）：asp0=箸で持ち上げた1粒（鍋）／asp1=60粒の山（黒地）／asp2=1粒（黒地）／asp3=湯の上の1粒／asp4=かき鍋／asp5=カキフライ
#                          vid0=鍋と青い炎／vid1=青い氷／vid2=霜の面／vid3=霜の結晶／vid4=油の泡／vid5=青白い煙（黒地）／vid6=白い煙（黒地）
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

def cutout(i, box, name):
    """黒地の写真から切り抜く（BiRefNet）。余白を少し残して切り、2倍に拡大"""
    from rembg import remove, new_session
    c = remove(A(i).crop(box), session=new_session("birefnet-general", providers=["CPUExecutionProvider"]), only_mask=False, post_process_mask=False)
    a = np.array(c)[:, :, 3]; ys, xs = np.where(a > 128)
    if not len(xs): sys.exit(f"{name} の切り抜きが空（読まずに進めない）")
    c = c.crop((max(0, xs.min() - 6), max(0, ys.min() - 6), min(c.width, xs.max() + 7), min(c.height, ys.max() + 7)))
    c = c.resize((c.width * 2, c.height * 2), Image.LANCZOS); c.save(os.path.join(img, name + ".png")); print(name, c.size)
    return c

if G == "one":   # 1粒の切り抜き（黒地の写真）
    cutout(2, (40, 140, 460, 470), "one")
elif G == "pile":   # 60粒の山の切り抜き（黒地と縁の白い光を外し、氷の映像の上に手前の被写体として置く）
    cutout(1, (0, 325, 950, 905), "pile")
elif G == "base":
    # 1) 奥行きで動かす写真：店のロゴ・字・賞の札・料理名の札を外した範囲（元の画像の画素・目で決めた）と、出す大きさ
    #    奥行き（depth/asp*.png・16bit・白＝近い）は、範囲の中の最小〜最大を 0〜1 に伸ばす
    SHOTS = {"hero": (0, (212, 150, 800, 640), (1080, 900)), "heroW": (0, (0, 150, 800, 640), (1080, 662)), "lift": (3, (400, 20, 900, 470), (1080, 972)),
             "nabe": (4, (0, 185, 502, 635), (1040, 932)), "fry": (5, (0, 215, 502, 635), (1040, 870))}
    for name, (i, bx, _) in SHOTS.items():
        A(i).crop(bx).save(os.path.join(sb, f"{name}.png"))
        d = np.asarray(Image.open(os.path.join(src, "depth", f"asp{i}.png"))).astype(np.float32); d = d[bx[1]:bx[3], bx[0]:bx[2]]
        d = (d - d.min()) / max(1e-6, d.max() - d.min()); Image.fromarray((d * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2)).save(os.path.join(sb, f"{name}_d.png"))
    # 2) カメラ（ここ1か所）。名前 → (写真, コマ数, u(0〜1) → zoom, dx, dy)。30コマ/秒。どれも「理由のある1つの動き」
    #    dolly 0.6＝カメラごと近づく（近い物ほど大きくなる）。focus＝動かない奥行き（牡蠣＝手前）。寄りの中心は牡蠣
    ios = lambda u: 0.5 - 0.5 * math.cos(math.pi * u); oc = lambda u: 1 - (1 - u) ** 3
    CAM = {"hero_in": ("hero", 54, lambda u: (1.00 + 0.16 * oc(u), -0.014 + 0.028 * ios(u), 0.006 * ios(u))),          # 止める：1粒へ寄る
           "hero_out": ("hero", 110, lambda u: (1.28 - 0.28 * ios(u), 0.020 - 0.036 * ios(u), -0.008 + 0.012 * ios(u))),   # 山場：寄った所から引いて全体が見える
           "hero_end": ("heroW", 130, lambda u: (1.00 + 0.05 * ios(u), 0.016 - 0.032 * ios(u), 0.0)),                    # 締め：1カット目と同じ1粒を引きで。横へゆっくり回る
           "lift": ("lift", 80, lambda u: (1.06 - 0.06 * oc(u), -0.016 + 0.032 * ios(u), -0.004 * ios(u))),              # 解凍：湯の上の1粒
           "nabe": ("nabe", 54, lambda u: (1.00 + 0.09 * oc(u), 0.014 - 0.028 * ios(u), -0.006 * ios(u))),
           "fry": ("fry", 50, lambda u: (1.10 - 0.10 * oc(u), -0.014 + 0.028 * ios(u), 0.0))}
    jobs = {}
    for name, (ph, n, cam) in CAM.items():
        w, h = SHOTS[ph][2]; jobs[name] = []
        for k in range(n):
            z, dx, dy = cam(k / (n - 1))
            jobs[name].append({"src": f"{ph}.png", "depth": f"{ph}_d.png", "w": w, "h": h, "zoom": round(z, 5), "dx": round(dx, 5), "dy": round(dy, 5),
                               "focus": 0.8, "dolly": 0.6, "ox": 0.52, "oy": 0.5, "out": f"{name}_{k:04d}.jpg"})
    jp = os.path.join(sb, "depth_jobs.json"); json.dump(jobs, open(jp, "w"))
    subprocess.run([sys.executable, os.path.join("factory", "depthwarp.py"), jp, sb, dp], check=True)   # 作業場所の直下で動かす（factory/ がある所）
    for name, (ph, n, _) in CAM.items():
        m = len([f for f in os.listdir(dp) if f.startswith(name + "_")])
        if m != n: sys.exit(f"奥行きの連番 {name} が足りない {m}/{n}")

    # 3) 映像のコマ（開始秒・長さ）。30コマ/秒・1080×1920
    CLIPS = {"pot": ("vid0", 0.0, 7.8), "ice": ("vid1", 0.0, 7.0), "bed": ("vid2", 0.0, 6.0), "frost": ("vid3", 2.0, 6.0), "oil": ("vid4", 0.0, 0.9),
             "mist": ("vid5", 0.0, 4.6), "steam": ("vid6", 0.0, 9.0)}
    for k, (v, ss, dur) in CLIPS.items():
        subprocess.run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", os.path.join(src, v + ".mp4"),
                        "-vf", "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "3", "-start_number", "0", os.path.join(fv, f"{k}_%04d.jpg")], check=True)
        n = len([f for f in os.listdir(fv) if f.startswith(k + "_")])
        if n < int(dur * 30) - 4: sys.exit(f"映像 {k} のコマが足りない {n}")
        print("clip", k, n)

    # 4) フィルムの粒子の素（乱数の種は固定）
    g = np.random.default_rng(7).normal(128, 26, (512, 512)).clip(0, 255).astype(np.uint8)
    Image.fromarray(g, "L").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(img, "grain.png")); print("grain")
else:
    sys.exit(f"組の名前が違う: {G}")
