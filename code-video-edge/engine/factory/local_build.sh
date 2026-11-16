#!/bin/bash
# 手元で1本描いて点検する：bash factory/local_build.sh <商品の key> [出力フォルダ名=out]
#   なぜ：CHROME の指定・点検だけ python3.13（python3 は PIL が壊れている）を毎回手で書いていて、忘れると途中で落ちた（2026-11-16）。
#   無人の定時の制作でも同じ1行で通るようにする。最後の行が「QC ok」でなければ送らない。
set -u
cd "$(dirname "$0")/.."
K=$1; O=${2:-out}; P=stage/p/$K
W=${WORKS:-/home/user/jmas-ai-os/samples/motion/works}/$K
export CHROME=${CHROME:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome | tail -1)}
[ -x "$CHROME" ] || { echo "QC NG: Chrome が無い"; exit 1; }
SUB=${SUB:-4} bash factory/build_edge.sh $P/v/product.json $P/$O $W/facts.json $P/voice > $P/build.log 2>&1   # 最後の点検は python3 で落ちる（下で 3.13 でやり直す）
[ -s $P/$O/final.mp4 ] || { tail -5 $P/build.log; echo "QC NG: 描画が終わっていない（$P/build.log）"; exit 1; }
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())") TL=$P/$O/timing.json PRODUCT=$P/v/product.json
export PAGE=stage/$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['template'])" $PRODUCT).html   # 点検のページ読みが使う（無いと結果が空になる）
python3.13 factory/qc_edge.py $P/v/product.json $P/$O $W/facts.json > $P/$O/qc.json 2> $P/qc.err
python3 - "$P/$O/qc.json" <<'PY'
import json, sys
try: q = json.load(open(sys.argv[1]))
except Exception as e: print("QC NG: 結果が読めない", e); sys.exit(1)
items = {k: v for k, v in q.items() if isinstance(v, dict)}
bad = [k for k, v in items.items() if not v.get("ok")]
if len(items) < 20: print(f"QC NG: 項目が {len(items)} 個しか無い"); sys.exit(1)   # 空振りを合格にしない（E-021）
print(f"QC {'ok' if q.get('ok') and not bad else 'NG'} {len(items) - len(bad)}/{len(items)}", *bad)
sys.exit(0 if q.get("ok") and not bad else 1)
PY
