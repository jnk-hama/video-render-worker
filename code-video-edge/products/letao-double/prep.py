#!/usr/bin/env python3
# ルタオ ドゥーブルフロマージュの下ごしらえ（奥行きの型 kinetic・#379）：python3 prep.py <取った素材の置き場> <出力先 b3d/> [組]
#   組は1回に1つ（BiRefNet を1つの処理で2回呼ぶとメモリが膨らんで落ちた）：base → cake → whole
#   商品は販売ページの写真だけ（描き変えない）。写真は奥行きで動かす（画素の場所を動かすだけ・#343）。場面は Pexels の本物の映像。
#   素材の順（assets.json）：asp0=セット（ロゴ・字・賞の札あり）／asp3=全体と1切れ／asp4=直径12cm／asp5=ロール／asp6=ヴェネチア／asp7=チョコ／asp14=材料
#                          vid0=金のきらめき／vid1=明るいツリー／vid2=注がれる牛乳／vid3=白い雪の面／vid4=暖かい金のボケ
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

if G == "cake":   # 直径12cm の全体（クリーム色の地から切り抜く。上の「直径12cm」の字は範囲の外）
    from rembg import remove, new_session
    c = remove(A(4).crop((140, 440, 765, 875)), session=new_session("birefnet-general", providers=["CPUExecutionProvider"]), only_mask=False, post_process_mask=False)
    a = np.array(c)[:, :, 3]; ys, xs = np.where(a > 128)
    if not len(xs): sys.exit("cake の切り抜きが空（読まずに進めない）")
    c = c.crop((max(0, xs.min() - 6), max(0, ys.min() - 6), min(c.width, xs.max() + 7), min(c.height, ys.max() + 7)))
    c = c.resize((c.width * 2, c.height * 2), Image.LANCZOS); c.save(os.path.join(img, "cake.png")); print("cake", c.size)
elif G == "whole":   # r2：切った跡のある全体（皿ごと）を切り抜き、本物のツリーの映像の中に置く（上下のぼかし帯をやめる・5人会議 r2）
    from rembg import remove, new_session
    c = remove(A(3).crop((60, 690, 840, 1270)), session=new_session("birefnet-general", providers=["CPUExecutionProvider"]), only_mask=False, post_process_mask=False)
    a = np.array(c)[:, :, 3]; ys, xs = np.where(a > 128)
    if not len(xs): sys.exit("whole の切り抜きが空（読まずに進めない）")
    c = c.crop((max(0, xs.min() - 6), max(0, ys.min() - 6), min(c.width, xs.max() + 7), min(c.height, ys.max() + 7)))
    c = c.resize((round(c.width * 1.6), round(c.height * 1.6)), Image.LANCZOS); c.save(os.path.join(img, "whole.png")); print("whole", c.size)
elif G == "base":
    # 1) 平らに使う写真（材料・選べる3種）：店の字・枠・説明の札を外した範囲（元の画像の画素・目で決めた）。2倍に拡大
    FLAT = {"milk": (14, (0, 905, 300, 1345)), "cheese": (14, (560, 1355, 900, 1795)), "masc": (14, (0, 1805, 360, 2245)), "cream": (14, (450, 2255, 900, 2700)),
            "roll": (5, (55, 700, 860, 1150)), "ven": (6, (60, 430, 850, 1030)), "choco": (7, (60, 410, 850, 900))}
    for name, (i, bx) in FLAT.items():
        im = A(i).crop(bx); im = up(im, im.width * 2); im.save(os.path.join(img, f"{name}.jpg"), quality=93); print(name, im.size)
    # 2) 奥行きで動かす写真と出す大きさ（奥行き＝depth/asp*.png・16bit・白＝近い。範囲の中で 0〜1 に伸ばす）
    SHOTS = {"whole": (3, (60, 690, 840, 1270), (1080, 803)), "slice": (3, (60, 1370, 840, 1950), (1080, 803)), "set": (0, (305, 195, 882, 877), (1080, 1277)),
             "slicep": (3, (240, 1370, 660, 1950), (1080, 1491))}   # r2：画面の下から上の 78% までを断面で埋める（縦長に切る・帯にしない）
    for name, (i, bx, _) in SHOTS.items():
        A(i).crop(bx).save(os.path.join(sb, f"{name}.png"))
        d = np.asarray(Image.open(os.path.join(src, "depth", f"asp{i}.png"))).astype(np.float32)[bx[1]:bx[3], bx[0]:bx[2]]
        d = (d - d.min()) / max(1e-6, d.max() - d.min()); Image.fromarray((d * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(1.2)).save(os.path.join(sb, f"{name}_d.png"))
    # 3) カメラ（ここ1か所）：名前 → (写真, コマ数, u → zoom, dx, dy, ox, oy)。30コマ/秒。dolly 0.6＝カメラごと近づく（近い物ほど大きくなる）
    oc = lambda u: 1 - (1 - u) ** 3; ex = lambda u: 1 - 2 ** (-10 * u) if u < 1 else 1; ios = lambda u: 0.5 - 0.5 * math.cos(math.pi * u)
    CAM = {"whole_in": ("whole", 48, lambda u: (1.00 + 0.30 * ex(u), -0.02 + 0.03 * oc(u), 0.01 * oc(u), 0.62, 0.52)),     # フック：切った所へ急接近してぴたっと止まる
           "slice_mac": ("slicep", 56, lambda u: (1.30 - 0.10 * oc(u), 0.02 - 0.03 * oc(u), 0.0, 0.5, 0.42)),          # くちどけ：上の層（レアチーズ）の大写し（全画面）
           "slice_wide": ("slicep", 100, lambda u: (1.02 + 0.06 * ios(u), -0.02 + 0.04 * ios(u), 0.0, 0.5, 0.5)),      # 2層：溜め。横へゆっくり回る
           "slice_low": ("slicep", 150, lambda u: (1.08 + 0.04 * ios(u), 0.015 - 0.03 * ios(u), 0.0, 0.5, 0.55)),      # 評価の下
           "set_in": ("set", 70, lambda u: (1.18 - 0.16 * oc(u), 0.02 - 0.03 * oc(u), 0.0, 0.5, 0.5)),                 # 2,700万個：引いてセットが見える
           "set_end": ("set", 140, lambda u: (1.00 + 0.07 * ios(u), -0.015 + 0.03 * ios(u), 0.0, 0.5, 0.5))}           # 行動：ゆっくり寄る
    DOF = {"slice_mac": lambda u: {"at": 0.25 + 0.6 * oc(min(1, u * 1.6)), "k": 9, "range": 0.45},   # ピント送り（最初の 0.6 で奥→手前）
           "slice_wide": lambda u: {"at": 0.8, "k": 5, "range": 0.55}, "slice_low": lambda u: {"at": 0.8, "k": 6, "range": 0.5}}
    jobs = {}
    for name, (ph, n, cam) in CAM.items():
        w, h = SHOTS[ph][2]; jobs[name] = []
        for k in range(n):
            z, dx, dy, ox, oy = cam(k / (n - 1))
            jobs[name].append({"src": f"{ph}.png", "depth": f"{ph}_d.png", "w": w, "h": h, "zoom": round(z, 5), "dx": round(dx, 5), "dy": round(dy, 5),
                               "focus": 0.8, "dolly": 0.6, "ox": ox, "oy": oy, "out": f"{name}_{k:04d}.jpg",
                               "dof": DOF[name](k / (n - 1)) if name in DOF else None})
    jp = os.path.join(sb, "depth_jobs.json"); json.dump(jobs, open(jp, "w"))
    subprocess.run([sys.executable, os.path.join("factory", "depthwarp.py"), jp, sb, dp], check=True)   # 作業場所の直下で動かす（factory/ がある所）
    for name, (ph, n, _) in CAM.items():
        m = len([f for f in os.listdir(dp) if f.startswith(name + "_")])
        if m != n: sys.exit(f"奥行きの連番 {name} が足りない {m}/{n}")
    # 4) 映像のコマ（開始秒・長さ）。30コマ/秒・1080×1920
    CLIPS = {"glit": ("vid0", 0.0, 6.0), "tree": ("vid1", 2.0, 6.0), "milk": ("vid2", 3.0, 4.0), "snow": ("vid3", 0.0, 7.0), "bokeh": ("vid4", 1.0, 6.0)}
    for k, (v, ss, dur) in CLIPS.items():
        subprocess.run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", os.path.join(src, v + ".mp4"),
                        "-vf", "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "3", "-start_number", "0", os.path.join(fv, f"{k}_%04d.jpg")], check=True)
        n = len([f for f in os.listdir(fv) if f.startswith(k + "_")])
        if n < int(dur * 30) - 4: sys.exit(f"映像 {k} のコマが足りない {n}")
        print("clip", k, n)
    g = np.random.default_rng(7).normal(128, 26, (512, 512)).clip(0, 255).astype(np.uint8)   # フィルムの粒子の素（種は固定）
    Image.fromarray(g, "L").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(img, "grain.png")); print("grain")
else:
    sys.exit(f"組の名前が違う: {G}")
