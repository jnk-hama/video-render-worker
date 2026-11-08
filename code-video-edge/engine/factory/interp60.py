#!/usr/bin/env python3
# 3D の絵（Cycles・30コマ/秒 k_####.jpg）を 60コマ/秒（f_####.jpg）へ補う（#368）：python3 factory/interp60.py <cy のフォルダ>
#   X の投稿で紹介された RIFE（MIT）と同じ役目。RIFE の重みは Google Drive にしか無く、Actions から確実に取れない＝ffmpeg に入っている minterpolate を使う（0円・重みなし・決定論）
#   動画は 60コマ/秒なのに 3D は 30コマ/秒＝1枚を2コマ見せていた（カメラが回る所で段が付く）。補ったコマは間の動きを動きベクトルで作る
#   場面の切れ目は scd（コマの差で切れ目を見つける）で補わない＝別のショットどうしを混ぜない
import os, subprocess, sys
import imageio_ffmpeg
d = sys.argv[1]; FF = imageio_ffmpeg.get_ffmpeg_exe()
n = len([f for f in os.listdir(d) if f.startswith("k_") and f.endswith(".jpg")])
if not n: sys.exit("k_####.jpg が無い")
subprocess.run([FF, "-v", "error", "-y", "-framerate", "30", "-i", os.path.join(d, "k_%04d.jpg"),
                "-vf", "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=8",
                "-q:v", "2", "-start_number", "0", os.path.join(d, "f_%04d.jpg")], check=True)
m = len([f for f in os.listdir(d) if f.startswith("f_")])
if m < 2 * n - 4: sys.exit(f"60コマ/秒のコマが足りない {m} / {2 * n}")   # 最後の1枚の後ろは補えない（実測 675→1347）
# 熱の色のコマ（t_####.jpg・デロンギ）：途中の番号から続く一部分だけある＝同じ補い方で g_####.jpg（60コマ/秒の番号）へ
ts = sorted(int(f[2:6]) for f in os.listdir(d) if f.startswith("t_") and f.endswith(".jpg"))
g0 = g1 = 0
if ts:
    a0 = ts[0]
    if ts != list(range(a0, a0 + len(ts))): sys.exit(f"t_ のコマが続いていない（{a0}〜{ts[-1]}・{len(ts)}枚）")
    tmp = os.path.join(d, "_g"); os.makedirs(tmp, exist_ok=True)
    subprocess.run([FF, "-v", "error", "-y", "-framerate", "30", "-start_number", str(a0), "-i", os.path.join(d, "t_%04d.jpg"),
                    "-vf", "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=8",
                    "-q:v", "2", "-start_number", "0", os.path.join(tmp, "g_%04d.jpg")], check=True)
    gs = sorted(os.listdir(tmp))
    if len(gs) < 2 * len(ts) - 4: sys.exit(f"熱の色の 60コマ/秒が足りない {len(gs)} / {2 * len(ts)}")
    for j, f in enumerate(gs): os.replace(os.path.join(tmp, f), os.path.join(d, f"g_{2 * a0 + j:04d}.jpg"))
    os.rmdir(tmp); g0, g1 = 2 * a0, 2 * a0 + len(gs)
    print(f"熱の色 {len(ts)}コマ → {len(gs)}コマ（g_{g0:04d}〜）")
open(os.path.join(d, "f60.js"), "w").write(f"window.F60 = {m}; window.G60 = [{g0}, {g1}];\n")   # 型が読む＝無いコマを指さない
print(f"3D の絵 {n}コマ（30/秒）→ {m}コマ（60/秒）")
