#!/bin/bash
# 1本作る： factory/build.sh <product.json> [出力名]
#   時刻表 → 音 → 絵（4並列・60fps・8サブフレーム）→ 合成 → 点検（qc.py）
set -euo pipefail
cd "$(dirname "$0")/.."
PJ=$(realpath "$1"); KEY=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['product_key'])" "$PJ")
TPL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['template'])" "$PJ")
D=stage/p/$KEY; OUT=${2:-$D/out}; mkdir -p "$OUT"
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())") PAGE=stage/$TPL.html TL=$(realpath -m "$OUT")/timeline.json PRODUCT=$PJ
python3 factory/timeline.py "$PJ" "$D" "$TL"
python3 factory/audio.py "$PJ" "$D" "$TL" "$OUT/audio.m4a" | tee "$OUT/audio.json"
FRAMES=$(python3 -c "import json;print(round(json.load(open('$TL'))['end']*60))"); Q=$((FRAMES/4))
rm -f "$OUT"/seg*.mp4
node render.mjs segment 60 8 0 $Q "$OUT/seg0.mp4" &
node render.mjs segment 60 8 $Q $((Q*2)) "$OUT/seg1.mp4" &
node render.mjs segment 60 8 $((Q*2)) $((Q*3)) "$OUT/seg2.mp4" &
node render.mjs segment 60 8 $((Q*3)) $FRAMES "$OUT/seg3.mp4" &
wait
printf "file 'seg0.mp4'\nfile 'seg1.mp4'\nfile 'seg2.mp4'\nfile 'seg3.mp4'\n" > "$OUT/list.txt"
$FFMPEG -loglevel error -y -f concat -safe 0 -i "$OUT/list.txt" -i "$OUT/audio.m4a" -map 0:v -map 1:a -c:v copy -c:a copy -shortest -movflags +faststart "$OUT/final.mp4"
python3 factory/qc.py "$PJ" "$OUT" | tee "$OUT/qc.json"
echo built "$OUT/final.mp4"
