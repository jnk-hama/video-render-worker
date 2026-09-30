#!/usr/bin/env python3
"""
台本の読み上げでカットの声を差し替える口（render_video.speak_line・決定#238）の検査。
★2026-09-30 RR35 本番：崩れた喋り（「ゴミ捨て不要不要タイタイル」）と幻聴（「ご視聴ありがとうございました」）を
  字幕に焼いた。見つけたカットは、台本を読み上げた声と字幕に差し替えてから繋ぐ。
★本物の edge-tts は呼ばない（ネットに出ない）。ffmpeg で作った音で長さと時刻の直し方だけを見る。
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_video as rv  # noqa: E402

fails = []


def expect(cond, msg):
    print('  %s   %s' % ('OK' if cond else 'NG', msg))
    if not cond:
        fails.append(msg)


def dur(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                         capture_output=True, text=True).stdout
    return float(out or 0)


d = tempfile.mkdtemp()
seen = {}


def synth_long(text, out, voice=None):
    seen['voice'] = voice
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-ar', '24000', out], check=True)
    return {'path': out, 'duration': 6.0, 'words': [{'text': 'a', 'start': 0.0, 'end': 3.0}, {'text': 'b', 'start': 3.0, 'end': 6.0}]}


def synth_short(text, out, voice=None):
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ar', '24000', out], check=True)
    return {'path': out, 'duration': 2.0, 'words': [{'text': 'a', 'start': 0.0, 'end': 2.0}]}


print('=== 台本の読み上げでカットの声を差し替える（#238）===')
dest = os.path.join(d, 'long.wav')
w = rv.speak_line('最大約5か月、ゴミ捨て不要', dest, 4.0, 'ja', synth=synth_long)
expect(abs(dur(dest) - 4.0) < 0.05, '長い読み上げも、カットと同じ長さ（4秒）になる（口と後ろのカットがずれない）')
expect(w and abs(w[1]['start'] - 2.0) < 0.01 and all(x['end'] <= 4.0 for x in w), '速めた分だけ字幕の時刻も縮める（1.5倍）')
expect(seen['voice'] == 'ja-JP-NanamiNeural', '日本語は部署Bの声（ja-JP-NanamiNeural）')
dest2 = os.path.join(d, 'short.wav')
w2 = rv.speak_line('細かいゴミも', dest2, 4.0, 'ja', synth=synth_short)
expect(abs(dur(dest2) - 4.0) < 0.05 and w2[0]['end'] == 2.0, '短い読み上げは速めず、残りを無音で埋める')


def synth_down(*a, **k):
    raise RuntimeError('edge-tts down')


expect(rv.speak_line('x', os.path.join(d, 'x.wav'), 4.0, 'ja', synth=synth_down) is None, '読み上げを作れなければ None（呼ぶ側は字幕を外す）')
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'render_video.py'), encoding='utf-8').read()
expect(src.index('speech_qa.bad_speech(by_part') < src.index("audio_path = os.path.join(work, 'clip_audio.wav')")
       and 'if by_part is None:' in src and "log('⚠ 注意: ' + r_)" in src,
       '差し替えは音声を繋ぐ前・字幕はその結果から作る・差し替えたことは ⚠ 注意 で LINE の確認欄へ')

print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
