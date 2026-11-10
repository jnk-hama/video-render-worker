# 下ごしらえ（stove3d の型・アルパカ）： python3 prep.py <取った素材 dl-<key>> <出力 p/<key>/b3d>
#   写真を画面に使わない（本体も部屋も 3DCG・jmas #366）＝置く物は無い。build.sh が必ず呼ぶので形だけ置く
import os, sys
os.makedirs(os.path.join(os.path.dirname(sys.argv[2].rstrip("/")), "img"), exist_ok=True); print("写真なし（3DCG）")
