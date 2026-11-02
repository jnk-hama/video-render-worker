#!/bin/bash
# 動く下書き（#352・product-launch-motion／Claude-Video-Skills の animatic）：本描画（約8分）の前に、30fps・動きのぶれ無しで全編を約100秒で描く。
#   factory/draft.sh <product.json> <outdir> <voice_dir>   → <outdir>/draft.mp4（音つき）
#   静止画では見えない「動きの途中で字を横切る・間が長い・速すぎる」を、普通の速さで見つけるため。点検（qc_edge）はしない＝下書き
set -euo pipefail
cd "$(dirname "$0")/.."
PJ=$(realpath "$1"); OUT=$(realpath -m "$2"); VDIR=$(realpath "$3"); mkdir -p "$OUT"
TPL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['template'])" "$PJ")
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())") PAGE=stage/$TPL.html TL=$OUT/timing.json PRODUCT=$PJ
export WEBGL=$(python3 -c "import json,sys;print('1' if json.load(open(sys.argv[1])).get('webgl') else '')" "$PJ")   # 3D の型だけ CPU の WebGL（build_edge.sh と同じ）
python3 factory/lint_swallow.py "$PAGE" stage/motionkit.js stage/edge_tokens.js stage/stagekit.js   # 下書きの前にも（#354）
[ -f "$TL" ] || python3 factory/score_edge.py "$OUT" "$VDIR" "$PJ" > /dev/null   # 時刻表が無ければ語りから作る（絵の時刻はこれだけが決める）
FR=$(python3 -c "import json;print(round(json.load(open('$TL'))['end']*30))"); Q=$((FR/4)); T0=$(date +%s)
for k in 0 1 2 3; do a=$((Q*k)); b=$([ $k = 3 ] && echo $FR || echo $((Q*(k+1)))); node render.mjs segment 30 1 $a $b "$OUT/draft$k.mp4" & done; wait
printf "file 'draft0.mp4'\nfile 'draft1.mp4'\nfile 'draft2.mp4'\nfile 'draft3.mp4'\n" > "$OUT/draft_list.txt"
$FFMPEG -loglevel error -y -f concat -safe 0 -i "$OUT/draft_list.txt" -i "$OUT/audio.m4a" -map 0:v -map 1:a -c copy -shortest "$OUT/draft.mp4"
rm -f "$OUT"/draft[0-3].mp4 "$OUT/draft_list.txt"; echo "下書き $OUT/draft.mp4（$(( $(date +%s) - T0 ))秒）"
