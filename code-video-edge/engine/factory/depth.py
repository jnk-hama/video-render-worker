#!/usr/bin/env python3
# 実写真の奥行きを推定する（#343・Actions の中だけで動く）： python3 factory/depth.py <取った素材の置き場>
#   <置き場>/asp*.jpg を1枚ずつ読み、<置き場>/depth/asp*.png（16bit・白＝近い）を書く。
#   モデルは Depth Anything V2 Small（Apache-2.0＝商用可）。版は初回に読んだ番号を記録し、次から固定する。CPU の推論は同じ入力で同じ結果。
#   開発環境からは Hugging Face に出られない（403）ので、ここで推定して暗号化アセットに入れて持ち帰る
import glob, os, sys
import numpy as np
from PIL import Image
from transformers import pipeline

MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
REV = "5426e4f0f36572d16453bbda7a8389317b1bef99"   # 2026-10-21 の初回の実行で読んだ版（depth/MODEL.txt の記録）。別の版を黙って使わない

out = os.path.join(sys.argv[1], "depth"); os.makedirs(out, exist_ok=True)
pipe = pipeline("depth-estimation", model=MODEL, revision=REV, device="cpu")
fs = sorted(glob.glob(os.path.join(sys.argv[1], "asp*.jpg")))
if not fs: sys.exit("depth: asp*.jpg が1枚も無い（asp_images を一緒に依頼する）")
open(os.path.join(out, "MODEL.txt"), "w").write(f"{MODEL}@{getattr(pipe.model.config, '_commit_hash', None)}\n")
for f in fs:
    im = Image.open(f).convert("RGB")
    d = np.asarray(pipe(im)["predicted_depth"].squeeze().float().numpy(), dtype=np.float64)
    d = (d - d.min()) / max(1e-9, d.max() - d.min())   # 0〜1（大きいほど近い＝Depth Anything の出力の向き）
    d = np.clip(np.asarray(Image.fromarray(d.astype(np.float32), mode="F").resize(im.size, Image.BICUBIC)), 0, 1)   # 16bit のまま拡大できないので小数で拡大してから詰める
    Image.fromarray((d * 65535).astype(np.uint16)).save(os.path.join(out, os.path.basename(f)[:-4] + ".png"))
    print("depth:", os.path.basename(f), im.size)
