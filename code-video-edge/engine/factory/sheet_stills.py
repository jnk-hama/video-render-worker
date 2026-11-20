#!/usr/bin/env python3
# 試し描きの静止画を1枚の一覧にする：python3 factory/sheet_stills.py <静止画のフォルダ> <出力.jpg> [1枚の幅=300] [1行の枚数=7]
import glob, os, sys
from PIL import Image, ImageDraw
d, out = sys.argv[1:3]; W = int(sys.argv[3]) if len(sys.argv) > 3 else 300; N = int(sys.argv[4]) if len(sys.argv) > 4 else 7
fs = sorted(glob.glob(os.path.join(d, "t_*.jpg"))); H = W * 16 // 9
if not fs: sys.exit("静止画が無い")
sh = Image.new("RGB", (W * min(N, len(fs)), (H + 22) * ((len(fs) + N - 1) // N)), "white"); dr = ImageDraw.Draw(sh)
for i, f in enumerate(fs):
    x, y = (i % N) * W, (i // N) * (H + 22); sh.paste(Image.open(f).resize((W, H)), (x, y + 22)); dr.text((x + 6, y + 5), os.path.basename(f)[2:-4] + "s", fill="black")
sh.save(out, quality=86); print(sh.size, len(fs))
