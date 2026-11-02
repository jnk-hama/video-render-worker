#!/bin/bash
# 全部を作り直す: 時刻表 → 絵(4並列) → 音 → 合成 → 点検
set -e
cd /home/user/.motion-work
export FFMPEG=$(python3 -c "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())")
python3 timeline.py > /dev/null
python3 audio.py | tail -1
FRAMES=$(python3 -c "import json;t=json.load(open('timeline.json'));print(round(t['end']*60))")
Q=$((FRAMES/4))
rm -f seg*.mp4
node render.mjs segment 60 8 0 $Q seg0.mp4 &
node render.mjs segment 60 8 $Q $((Q*2)) seg1.mp4 &
node render.mjs segment 60 8 $((Q*2)) $((Q*3)) seg2.mp4 &
node render.mjs segment 60 8 $((Q*3)) $FRAMES seg3.mp4 &
wait
printf "file 'seg0.mp4'\nfile 'seg1.mp4'\nfile 'seg2.mp4'\nfile 'seg3.mp4'\n" > list.txt
$FFMPEG -loglevel error -y -f concat -safe 0 -i list.txt -i audio.m4a -map 0:v -map 1:a -c:v copy -c:a copy -shortest -movflags +faststart final-9x16.mp4
echo built
