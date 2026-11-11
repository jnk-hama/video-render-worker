#!/bin/bash
# UGREEN「一本の線」を作る（#333）： factory/build_edge.sh <product.json> <outdir> <facts.json> <voice_dir>
#   語りと音を先に（score_edge.py → timing.json）→ 絵（4並列・60fps・8サブフレームの動きのブレ）→ 合成 → 投稿文 → 点検（qc_edge.py）
set -euo pipefail
cd "$(dirname "$0")/.."
PJ=$(realpath "$1"); OUT=$(realpath -m "$2"); FACTS=$(realpath "$3"); VDIR=$(realpath "$4"); mkdir -p "$OUT"
TPL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['template'])" "$PJ")   # 型は設計書から（edge＝UGREEN・humid＝SwitchBot 加湿器）
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())") PAGE=stage/$TPL.html TL=$OUT/timing.json PRODUCT=$PJ
export WEBGL=$(python3 -c "import json,sys;print('1' if json.load(open(sys.argv[1])).get('webgl') else '')" "$PJ")   # 3D の型だけ CPU の WebGL を使う（chrome.mjs）
node factory/test_motionkit.mjs   # 動きの部品（ばね・洪水・ふるえ）の検査。落ちたら描かない（#334）
python3 factory/lint_swallow.py "$PAGE" stage/motionkit.js stage/edge_tokens.js stage/stagekit.js factory/post.py factory/qc_edge.py   # 行の途中の // に飲まれたコード（3回起きた・#354）。落ちたら描かない
grep -q "MK.phys" "$PAGE" && node factory/test_physbake.mjs   # 先に焼いた物理を使う型だけ：同じ spec で同じ表になるか（#354）
python3 factory/score_edge.py "$OUT" "$VDIR" "$PJ"
node factory/qc_seek.mjs   # 途中の時刻から描いても同じ絵か（#370：4つに分けて描くので、前のコマの状態に頼る型は区間の頭で絵が変わる）。落ちたら描かない
FR=$(python3 -c "import json;print(json.load(open('$TL'))['frames'])"); END=$(python3 -c "import json;print(json.load(open('$TL'))['end'])"); Q=$((FR/4))
# 動きのぶれは1コマに SUB 枚を重ねる（既定 8）。3D の型（全画面の CPU の WebGL）は1枚が約 0.3秒なので 4 にして約半分の時間にする（#356）
rm -f "$OUT"/seg*.mp4
node render.mjs segment 60 ${SUB:-8} 0 $Q "$OUT/seg0.mp4" &
node render.mjs segment 60 ${SUB:-8} $Q $((Q*2)) "$OUT/seg1.mp4" &
node render.mjs segment 60 ${SUB:-8} $((Q*2)) $((Q*3)) "$OUT/seg2.mp4" &
node render.mjs segment 60 ${SUB:-8} $((Q*3)) $FR "$OUT/seg3.mp4" &
wait
printf "file 'seg0.mp4'\nfile 'seg1.mp4'\nfile 'seg2.mp4'\nfile 'seg3.mp4'\n" > "$OUT/list.txt"
# 配信向け：平均6Mbps以下・60fps・2秒ごとの鍵フレーム。尺は timing.json の end ちょうど
$FFMPEG -loglevel error -y -f concat -safe 0 -i "$OUT/list.txt" -i "$OUT/audio.m4a" -map 0:v -map 1:a -c:v libx264 -preset slow -crf 18 -maxrate 6M -bufsize 12M -g 120 -profile:v high -pix_fmt yuv420p -r 60 -c:a copy -t "$END" -movflags +faststart "$OUT/final.mp4"
$FFMPEG -loglevel error -y -i "$OUT/final.mp4" -i "$OUT/music_only.m4a" -map 0:v -map 1:a -c copy -t "$END" -movflags +faststart "$OUT/final_music_only.mp4"   # 純音楽版（声も効果音もなし）
# 帰属表示（#331）：credits.json は作品フォルダ（facts.json の隣）にある。写さないと投稿文に作者名が入らない（Espresso は毎回手で写していた）
[ -f "$(dirname "$FACTS")/credits.json" ] && cp "$(dirname "$FACTS")/credits.json" "$OUT/credits.json"
python3 factory/post.py "$PJ" "$OUT" > "$OUT/post.json"
python3 factory/qc_edge.py "$PJ" "$OUT" "$FACTS" | tee "$OUT/qc.json"
echo built "$OUT/final.mp4"
