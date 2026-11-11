# 下ごしらえ（film の型・デロンギ v3・#371。real v2 と同じ素材で、部屋の映像だけ全編を取る）： python3 prep.py <取った素材 dl-<key>> <出力 p/<key>/b3d>
#   商品は販売ページの実物の写真だけ（3DCG で作らない）。場面は Pexels の本物の映像（商用可・帰属は credits.json）。
#   ★写真の画素は描き変えない：切り抜く・範囲を切る・拡大する（Lanczos）だけ。店の飾り文字（橙の札）が入らない範囲を切る
#   入力：asp0＝本体（白地）・asp1＝フィンの寄り・asp2＝タイマー・asp3＝キャスター（assets.json の順）／vid0＝本を読む人・vid1＝窓の雪・vid2＝眠る猫
#   出力：img/cut.png（本体の切り抜き）・img/{fin,timer,caster}.jpg・img/grain.png・fv/{a,b,c}_####.jpg（映像のコマ・30コマ/秒）
import os, subprocess, sys
import numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1:3]; root = os.path.dirname(out.rstrip("/")); img = os.path.join(root, "img"); fv = os.path.join(root, "fv")
os.makedirs(img, exist_ok=True); os.makedirs(fv, exist_ok=True)
try:
    import imageio_ffmpeg; FF = imageio_ffmpeg.get_ffmpeg_exe()
except Exception: FF = os.environ.get("FFMPEG", "ffmpeg")

# 1) 本体の切り抜き（BiRefNet）。白い本体が白い地に溶けないかは、濃い地に置いて目で確かめた（2026-11-10）
from rembg import remove, new_session
sess = new_session("birefnet-general", providers=["CPUExecutionProvider"])
c = remove(Image.open(os.path.join(src, "asp0.jpg")).convert("RGB"), session=sess, only_mask=False, post_process_mask=False)
a = np.array(c)[:, :, 3]; ys, xs = np.where(a > 128)
if not len(xs): sys.exit("切り抜きが空（読まずに進めない）")
box = (max(0, xs.min() - 6), max(0, ys.min() - 6), min(c.width, xs.max() + 7), min(c.height, ys.max() + 7))
c = c.crop(box); c = c.resize((c.width * 2, c.height * 2), Image.LANCZOS); c.save(os.path.join(img, "cut.png")); print("cut", c.size)

# 2) 細部（飾り文字の無い範囲だけ）。2倍に拡大して少しだけ輪郭を締める
CROPS = {"fin": ("asp1", (0, 130, 405, 470)), "timer": ("asp2", (60, 242, 600, 532)), "caster": ("asp3", (0, 135, 410, 600))}
for name, (asp, bx) in CROPS.items():
    im = Image.open(os.path.join(src, f"{asp}.jpg")).convert("RGB").crop(bx); im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.6, 60, 2))
    im.save(os.path.join(img, f"{name}.jpg"), quality=93); print(name, im.size)

# 3) 映像のコマ（開始秒・長さ）。場面の長さ＋溶かす分。30コマ/秒・1080×1920
CLIPS = {"a": ("vid0", 0.2, 10.6), "b": ("vid1", 2.0, 5.6), "c": ("vid2", 0.4, 3.2)}   # a＝部屋の映像は全編（film の型：見出し・細部3場面・締めの奥に使う）
for k, (v, ss, dur) in CLIPS.items():
    subprocess.run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", os.path.join(src, v + ".mp4"),
                    "-vf", "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "3", "-start_number", "0", os.path.join(fv, f"{k}_%04d.jpg")], check=True)
    n = len([f for f in os.listdir(fv) if f.startswith(k + "_")])
    if n < int(dur * 30) - 2: sys.exit(f"映像 {k} のコマが足りない {n}")
    print("clip", k, n)

# 4) フィルムの粒子の素（乱数の種は固定＝毎回同じ）。型が位置をずらして重ねる
g = np.random.default_rng(7).normal(128, 26, (512, 512)).clip(0, 255).astype(np.uint8)
Image.fromarray(g, "L").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(img, "grain.png")); print("grain")
