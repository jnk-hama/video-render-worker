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
open(os.path.join(d, "f60.js"), "w").write(f"window.F60 = {m};\n")   # 型が読む＝無いコマを指さない
print(f"3D の絵 {n}コマ（30/秒）→ {m}コマ（60/秒）")
