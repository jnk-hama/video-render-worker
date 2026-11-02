import sys, glob, os, re
from PIL import Image, ImageDraw
d, out, cols, w = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
files = sorted(glob.glob(os.path.join(d, "f_*.png")), key=lambda p: float(re.findall(r"f_([\d.]+)\.png", p)[0]))
h = int(w * 16 / 9); rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (w + 8) + 8, rows * (h + 8) + 8), "white")
dr = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB").resize((w, h), Image.LANCZOS)
    x, y = 8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + 8)
    sheet.paste(im, (x, y)); dr.rectangle([x, y, x + 74, y + 22], fill=(0, 0, 0)); dr.text((x + 5, y + 5), "t=" + re.findall(r"f_([\d.]+)\.png", f)[0], fill=(255, 255, 255))
sheet.save(out); print(sheet.size)
