#!/bin/bash
# 1商品を見出し違い（hooks・#267-4）ごとに全部作る： factory/make.sh <product.json>
#   → stage/p/<key>/out-<id>/{final.mp4, qc.json, post.json}
set -euo pipefail
cd "$(dirname "$0")/.."
PJ=$(realpath "$1"); KEY=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['product_key'])" "$PJ"); D=stage/p/$KEY
for id in $(python3 factory/variants.py "$PJ" "$D/v"); do
  bash factory/build.sh "$D/v/$id/product.json" "$D/out-$id"
  python3 factory/post.py "$D/v/$id/product.json" > "$D/out-$id/post.json"
done
