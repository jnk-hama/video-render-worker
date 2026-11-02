#!/usr/bin/env python3
# 実写真を奥行きで立体に動かした連番を作る（#343）：
#   python3 factory/depthwarp.py <depth_jobs.json> <写真と奥行きの置き場 sb/> <出力先 dp/>
#   一覧（humid.html の DEPTH_JOBS＝カメラの式の1か所）の1コマごとに、出力の各画素が「元の写真のどこから来たか」を
#   奥行きで8回たどって決める（近い物ほど大きく動く＝本物の視差）。写真は描き変えない（画素の場所を少し動かすだけ）。
#   ブラウザの WebGL でやると画面全体の描画が遅くなり打ち切られたので、ここで先に作る。乱数なし＝毎回同じ
import json, os, sys
import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

jobs, src, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
cache = {}
for name, frames in json.load(open(jobs)).items():
    for j in frames:
        if name not in cache:
            im = np.asarray(Image.open(os.path.join(src, j["src"])).convert("RGB")).astype(np.float32)
            dp = np.asarray(Image.open(os.path.join(src, j["depth"])).convert("L")).astype(np.float32) / 255
            if dp.shape != im.shape[:2]: sys.exit(f"{name}: 写真と奥行きの大きさが違う {im.shape[:2]} / {dp.shape}")
            cache[name] = (im, dp)
        im, dp = cache[name]; H, W = dp.shape
        ys, xs = np.mgrid[0:j["h"], 0:j["w"]].astype(np.float32)
        ox, oy = j.get("ox", 0.5), j.get("oy", 0.5)   # 寄る中心（0〜1・無ければ真ん中＝前と同じ）。写真の元の画素から寄るので、拡大の甘さが出ない
        u = (xs + 0.5) / j["w"]; v = (ys + 0.5) / j["h"]
        # dolly（0〜1・r8 カメラマンの考え方）：0＝ズーム（全部が同じ割合で大きくなる＝前と同じ）。1＝カメラごと近づく（ドリー）＝近い物ほど大きくなる。
        #   遠近はカメラと物の距離で決まる（焦点距離ではない）。奥行き d（近い＝1）から距離 z=1/(0.25+d)、ピントの面 z_f の寄りが zoom になる距離 Δ だけ進む → 倍率 z/(z−Δ)
        dolly = j.get("dolly", 0.0); zf = 1 / (0.25 + j["focus"]); Dz = zf * (1 - 1 / j["zoom"])
        mag = lambda d: (1 - dolly) * j["zoom"] + dolly * (lambda z: z / np.maximum(z - Dz, 0.2 * z))(1 / (0.25 + d))
        cx = (u - ox) / j["zoom"] + ox; cy = (v - oy) / j["zoom"] + oy   # 0〜1 の位置（寄りの分だけ寄る中心へ）
        px, py = cx.copy(), cy.copy()
        for _ in range(8):
            d = map_coordinates(dp, [np.clip(py, 0, 1) * (H - 1), np.clip(px, 0, 1) * (W - 1)], order=1)
            m = mag(d) if dolly else j["zoom"]
            px = (u - ox) / m + ox + j["dx"] * (d - j["focus"]); py = (v - oy) / m + oy + j["dy"] * (d - j["focus"])
        coords = [np.clip(py, 0, 1) * (H - 1), np.clip(px, 0, 1) * (W - 1)]
        rgb = np.stack([map_coordinates(im[..., c], coords, order=1) for c in range(3)], -1)
        Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(out, j["out"]), quality=92)
    print(name, len(frames), "コマ")
