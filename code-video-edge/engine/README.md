# コード製の商品動画（試作）

時刻 t を渡すとその瞬間の1コマが決まる方式（`window.seek(t)`）。乱数・CSSアニメーションは使わない。
timeline.json（`timeline.py` が作る）が絵と音の唯一の時刻表。

手順: 商品写真(img0.jpg 等) → `cutout.py`(BiRefNet) → `components.py` → `sr.py`(EDSR 4x) → `assemble.py`
→ stage/ に `vac.png` `station.png` `*_mask.png` を置く → `fetch-fonts.sh` → `build.sh`

第三者の商品写真・切り抜き結果はリポジトリに置かない（暗号化した素材を `motion-sample-fetch` が運ぶ）。
