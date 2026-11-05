# 下ごしらえ（cine の型・#364）： python3 prep.py <取った素材 dl-<key>> <出力 p/<key>/b3d>
#   切り抜きも射影もしない。販売ページの写真をそのまま、型が読む名前（販売ページの番号）で p/<key>/img/ に置くだけ（画素は描き変えない・#068）
import os, shutil, sys
src, out = sys.argv[1:3]; img = os.path.join(os.path.dirname(out.rstrip("/")), "img"); os.makedirs(img, exist_ok=True)
NAMES = ["asp6", "asp25", "asp27", "asp29"]   # assets.json の asp_images の順（dl の asp0〜3）
for i, n in enumerate(NAMES):
    shutil.copyfile(os.path.join(src, f"asp{i}.jpg"), os.path.join(img, f"{n}.jpg")); print(n)
