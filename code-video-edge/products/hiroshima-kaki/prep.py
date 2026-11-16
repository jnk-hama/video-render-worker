# 下ごしらえ（dish の型・ジャンボ広島かき 2kg）： python3 prep.py <取った素材 dl-<key>> <出力 p/<key>/b3d> <組 base|one|pile>
#   ★切り抜き（BiRefNet）は1つの処理で2回呼ぶとメモリが膨らんで落ちる（実測）＝組ごとに別の処理で呼ぶ（assets.json の prep）
#   商品は販売ページの実物の写真だけ（#068・#370）。範囲を切る・切り抜く・拡大（Lanczos）だけで、画素は描き変えない。店の字・ロゴ・賞の札が入らない範囲を切る
#   入力：asp0＝箸で持ち上げた1粒（鍋）／asp1＝60粒の山／asp2＝1粒（黒地）／asp3＝箸で持ち上げた1粒（湯気）／asp4＝かき鍋／asp5＝かきフライ（assets.json の順）
#         vid0＝鍋のふた・青い火／vid1＝鍋から立つ湯気／vid2＝こんろの鍋の湯気／vid3＝食卓の鍋（すくう手）
#   出力：img/{hero,lift,nabe,fry}.jpg・img/one.png（1粒の切り抜き）・img/pile.png（60粒の山の切り抜き）・img/grain.png・fv/{a,b,c,d}_####.jpg
import json, os, subprocess, sys
import numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1:3]; G = sys.argv[3] if len(sys.argv) > 3 else "base"; root = os.path.dirname(out.rstrip("/")); img = os.path.join(root, "img"); fv = os.path.join(root, "fv")
os.makedirs(img, exist_ok=True); os.makedirs(fv, exist_ok=True)
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

if G == "one":   # 2) 1粒の切り抜き（黒地の写真）
    cutout(2, (40, 140, 460, 470), "one")
elif G == "pile":   # 3) 60粒の山の切り抜き（黒地と縁の白い光を外し、映像の上に手前の被写体として置く）
    cutout(1, (0, 325, 950, 905), "pile")
elif G == "base":
    # 1) 写真の範囲（店のロゴ・字・賞の札・料理名の札を外す。座標は元の画像の画素で、目で決めた）
    CROPS = {"hero": (0, (0, 150, 800, 640)), "lift": (3, (400, 20, 900, 470)),
             "nabe": (4, (0, 185, 502, 635)), "fry": (5, (0, 215, 502, 635))}
    for name, (i, bx) in CROPS.items():
        im = A(i).crop(bx); im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.4, 50, 2))
        im.save(os.path.join(img, f"{name}.jpg"), quality=93); print(name, im.size)

    # 4) 映像のコマ（開始秒・長さ）。30コマ/秒・1080×1920
    CLIPS = {"a": ("vid0", 0.0, 7.8), "b": ("vid1", 0.0, 5.9), "c": ("vid2", 0.0, 6.9), "d": ("vid3", 0.5, 9.0)}
    for k, (v, ss, dur) in CLIPS.items():
        subprocess.run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(dur), "-i", os.path.join(src, v + ".mp4"),
                        "-vf", "fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-q:v", "3", "-start_number", "0", os.path.join(fv, f"{k}_%04d.jpg")], check=True)
        n = len([f for f in os.listdir(fv) if f.startswith(k + "_")])
        if n < int(dur * 30) - 4: sys.exit(f"映像 {k} のコマが足りない {n}")
        print("clip", k, n)

    # 5) フィルムの粒子の素（乱数の種は固定）
    g = np.random.default_rng(7).normal(128, 26, (512, 512)).clip(0, 255).astype(np.uint8)
    Image.fromarray(g, "L").filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(img, "grain.png")); print("grain")
else:
    sys.exit(f"組の名前が違う: {G}")
