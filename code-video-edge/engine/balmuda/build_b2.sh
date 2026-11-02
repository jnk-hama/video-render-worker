#!/bin/bash
# BALMUDA 版を全部作り直す：時刻表 → 音 → 絵(4並列・60fps・8サブフレーム) → 合成
set -e
cd /home/user/.motion-work
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())") PAGE=stage/balmuda2.html TL=p2/timeline_b.json
python3 p2/timeline_b.py > /dev/null
python3 p2/audio_b.py | tail -1
FRAMES=$(python3 -c "import json;t=json.load(open('p2/timeline_b.json'));print(round(t['end']*60))")
Q=$((FRAMES/4))
rm -f p2/s2eg*.mp4
node render.mjs segment 60 8 0 $Q p2/s2eg0.mp4 &
node render.mjs segment 60 8 $Q $((Q*2)) p2/s2eg1.mp4 &
node render.mjs segment 60 8 $((Q*2)) $((Q*3)) p2/s2eg2.mp4 &
node render.mjs segment 60 8 $((Q*3)) $FRAMES p2/s2eg3.mp4 &
wait
printf "file 's2eg0.mp4'\nfile 's2eg1.mp4'\nfile 's2eg2.mp4'\nfile 's2eg3.mp4'\n" > p2/list2.txt
$FFMPEG -loglevel error -y -f concat -safe 0 -i p2/list2.txt -i p2/audio_b.m4a -map 0:v -map 1:a -c:v copy -c:a copy -shortest -movflags +faststart p2/final-balmuda2.mp4
echo built
