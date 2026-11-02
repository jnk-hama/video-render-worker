#!/bin/bash
# BALMUDA 版を全部作り直す：時刻表 → 音 → 絵(4並列・60fps・8サブフレーム) → 合成
set -e
cd /home/user/.motion-work
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())") PAGE=stage/salonia.html TL=p4/timeline_s.json
python3 p4/timeline_s.py > /dev/null
python3 p4/audio_s.py | tail -1
FRAMES=$(python3 -c "import json;t=json.load(open('p4/timeline_s.json'));print(round(t['end']*60))")
Q=$((FRAMES/4))
rm -f p4/seg*.mp4
node render.mjs segment 60 8 0 $Q p4/seg0.mp4 &
node render.mjs segment 60 8 $Q $((Q*2)) p4/seg1.mp4 &
node render.mjs segment 60 8 $((Q*2)) $((Q*3)) p4/seg2.mp4 &
node render.mjs segment 60 8 $((Q*3)) $FRAMES p4/seg3.mp4 &
wait
printf "file 'seg0.mp4'\nfile 'seg1.mp4'\nfile 'seg2.mp4'\nfile 'seg3.mp4'\n" > p4/list.txt
$FFMPEG -loglevel error -y -f concat -safe 0 -i p4/list.txt -i p4/audio_s.m4a -map 0:v -map 1:a -c:v copy -c:a copy -shortest -movflags +faststart p4/final-salonia.mp4
echo built
