#!/usr/bin/env python3
# 直す前と直した後の動画を比べ、絵が変わった時刻と場所だけを数で出す：
#   python3.13 factory/diffspans.py <前.mp4> <後.mp4> [--fps 10] [--floor 24] [--expect 12.0-18.5 ...]
#   なぜ：直しの報告で「直した所以外は変わっていない」を目で言っていた（video-revision-round）。うちの型は seek(t) だけで決まる
#   ＝同じ設計書なら同じ絵になるので、比べれば変わった所が分かる。
#   測り方（kajisho5/ffmpeg-skill・MIT の check.py --compare --expect-changed の考え方）：両方を RGB にして引き算し、
#   1コマを 32×18 のます（縦長は 18×32）に縮めて、ますの中の一番大きい差が floor（既定 24/255）を越えたら「変わった」。
#   --expect に書いた時刻の外で変わったら「申告の外」として出し、終了コード 1。比べられない（大きさ・コマ数が違う）時も 1（測れないを「変わらない」にしない）
import argparse, json, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("a"); ap.add_argument("b"); ap.add_argument("--fps", type=float, default=10.0); ap.add_argument("--floor", type=int, default=24)
ap.add_argument("--expect", action="append", default=[], help="変わってよい時刻（秒-秒）。繰り返し可")
ap.add_argument("--json", action="store_true")
A = ap.parse_args()
try:
    import imageio_ffmpeg; FF = imageio_ffmpeg.get_ffmpeg_exe()
except Exception: FF = "ffmpeg"

def frames(path):
    """fps で間引いて、縦長なら 18×32 のますの大きさ（各ます 1 画素＝面積平均）にした RGB の列"""
    p = subprocess.run([FF, "-v", "error", "-i", path, "-vf", f"fps={A.fps},scale=18:32:flags=area,format=rgb24", "-f", "rawvideo", "-"], capture_output=True)
    if p.returncode != 0: sys.exit(f"読めない: {path}: {p.stderr.decode()[-300:]}")
    a = np.frombuffer(p.stdout, np.uint8)
    if a.size == 0 or a.size % (18 * 32 * 3): sys.exit(f"コマが取れない: {path}")
    return a.reshape(-1, 32, 18, 3).astype(np.int16)

fa, fb = frames(A.a), frames(A.b)
if len(fa) != len(fb):
    print(json.dumps({"ok": False, "理由": f"コマ数が違う（{len(fa)} / {len(fb)}）＝比べられない"}, ensure_ascii=False)); sys.exit(1)
peak = np.abs(fa - fb).max(axis=3)                 # ますごとの一番大きい差（色の3つのうち）
changed = peak > A.floor; per = changed.mean((1, 2))   # コマごとの変わったますの割合
ts = np.arange(len(fa)) / A.fps
spans, cur = [], None
for t, on, k in zip(ts, per > 0, range(len(per))):
    if on and cur is None: cur = [t, t, 0.0, k]
    if on: cur[1] = t; cur[2] = max(cur[2], float(per[k]))
    if not on and cur is not None: spans.append(cur); cur = None
if cur is not None: spans.append(cur)
exp = [tuple(map(float, e.split("-"))) for e in A.expect]
inside = lambda t: any(a - 1 / A.fps <= t <= b + 1 / A.fps for a, b in exp)
out = [{"秒": f"{s:.1f}-{e:.1f}", "変わったますの最大%": round(m * 100, 1)} for s, e, m, _ in spans]
undeclared = [o for (s, e, m, _), o in zip(spans, out) if exp and not (inside(s) and inside(e))]
quiet = int(peak[~changed].max()) if (~changed).any() else 0
res = {"ok": not undeclared, "コマ": len(fa), "fps": A.fps, "floor": A.floor, "変わった時刻": out, "申告の外": undeclared,
       "変わらなかった所で一番大きい差": quiet, "変わったコマの割合%": round(float((per > 0).mean()) * 100, 1)}
print(json.dumps(res, ensure_ascii=False, indent=None if not A.json else 1))
sys.exit(0 if res["ok"] else 1)
