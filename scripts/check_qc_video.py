#!/usr/bin/env python3
"""qc_video.py の検査。欠陥を仕込んだ動画を ffmpeg で作り、落とすべき物を落とし、通すべき物を通すかを見る。

★「通る」だけを見る検査は、検査が壊れて常に合格でも通ってしまう（E-021・E-036）。
  だから落とす側を先に・多く置く。各例は「何が理由で落ちたか」まで見る（別の理由で落ちて偶然合っても合格にしない）。
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qc_video  # noqa: E402

fails = 0
ran = 0
TMP = tempfile.mkdtemp(prefix='qc_test_')

# 音量の作り方：sine フィルターの既定の振幅は満振幅の 1/8。実測で volume なしが約 -21.9 LUFS なので、そこから狙う
# （当初「満振幅で約 -3 LUFS」と決め打ちして外れた。狙いは実測で決める）
SINE = 'sine=frequency=300:duration=4:sample_rate=44100'
OK_VOL = ',volume=8dB'          # 約 -14 LUFS（目安の範囲の中）


def make(name, vf='testsrc2=size=1080x1920:rate=30:duration=4', af=SINE + OK_VOL, extra=None):
    out = os.path.join(TMP, name + '.mp4')
    cmd = ['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', vf]
    if af:
        cmd += ['-f', 'lavfi', '-i', af]
    cmd += (extra or []) + ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast']
    if af:
        cmd += ['-c:a', 'aac', '-shortest']
    cmd += [out]
    subprocess.run(cmd, check=True)
    return out


def expect(name, cond):
    global fails, ran
    ran += 1
    print('  %s %s' % ('OK  ' if cond else '★NG ', name))
    if not cond:
        fails += 1


def has(items, word):
    return any(word in s for s in items)


print('=== 落とす（fail）===')
m, f, w = qc_video.evaluate(make('black', vf='testsrc2=size=1080x1920:rate=30:duration=4,'
                                             "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,2)'"))
expect('途中の黒いコマ（1秒間）→ 「黒い」で落ちる', has(f, '黒い'))
m, f, w = qc_video.evaluate(make('freeze', vf='color=c=0x336699:size=1080x1920:rate=30:duration=4'))
expect('固まった映像（4秒）→ 「固まっ」で落ちる', has(f, '固まっ'))
m, f, w = qc_video.evaluate(make('silence', af='anullsrc=r=44100:cl=stereo:d=4'))
expect('ずっと無音 → 「無音」で落ちる', has(f, '無音'))
m, f, w = qc_video.evaluate(make('midsilence', af=SINE + OK_VOL + ",volume=enable='between(t,1,3.5)':volume=0"))
expect('途中に2.5秒の無音 → 「無音」で落ちる', has(f, '無音'))
m, f, w = qc_video.evaluate(make('quiet', af=SINE + ',volume=-30dB'))
expect('小さすぎる音量 → 「音量」で落ちる', has(f, '音量'))
m, f, w = qc_video.evaluate(make('loud', af=SINE + ',volume=14dB'))
expect('大きすぎる音量 → 「音量」で落ちる', has(f, '音量'))
m, f, w = qc_video.evaluate(make('small', vf='testsrc2=size=720x1280:rate=30:duration=4'))
expect('大きさ違い（720x1280）→ 「大きさ」で落ちる', has(f, '大きさ'))
r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'qc_video.py'), os.path.join(TMP, 'black.mp4')],
                   capture_output=True, text=True)
expect('落ちた時の終了コードは 1', r.returncode == 1 and '★NG' in r.stdout)
r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'qc_video.py'), os.path.join(TMP, 'black.mp4'),
                    '--warn-only'], capture_output=True, text=True)
expect('--warn-only は記録だけで 0（既存の quality_gate:"warn" と同じ）', r.returncode == 0 and '★NG' in r.stdout)

print('=== 注意（warn。落とさない）===')
m, f, w = qc_video.evaluate(make('fps24', vf='testsrc2=size=1080x1920:rate=24:duration=4'))
expect('24fps → 注意だけ（落とさない）', not f and has(w, 'フレームレート'))
m, f, w = qc_video.evaluate(make('midsilence1', af=SINE + OK_VOL + ",volume=enable='between(t,1,2.3)':volume=0"))
expect('1.3秒の無音 → 注意だけ', not has(f, '無音') and has(w, '無音'))
m, f, w = qc_video.evaluate(make('bit_quiet', af=SINE + ',volume=4dB'))
expect('やや小さい音量 → 注意だけ', not has(f, '音量') and has(w, '音量'))

print('=== 通す ===')
m, f, w = qc_video.evaluate(make('good'))
expect('欠陥なしは合格（fail なし・注意なし）', not f and not w)
expect('測った値が入っている（黒0・固まり0・無音0・音量あり）',
       m['black'] == [] and m['freeze'] == [] and m['silence'] == [] and m['loudness'] is not None)
m, f, w = qc_video.evaluate(make('fade', vf="testsrc2=size=1080x1920:rate=30:duration=4,fade=t=in:st=0:d=0.3,fade=t=out:st=3.6:d=0.4"))
expect('始まりと終わりのフェード（黒）は数えない', not has(f, '黒い'))
m, f, w = qc_video.evaluate(make('noaudio', af=None))
expect('音声なしの動画は、音声の検査を飛ばす（音声の有無は render-video.yml が見る）',
       not f and m['loudness'] is None and m['silence'] is None)

print('=== 実際の工程に配線されている（書いてあるだけで走っていない、を防ぐ）===')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rv = open(os.path.join(ROOT, '.github', 'workflows', 'render-video.yml'), encoding='utf-8').read()
ck = open(os.path.join(ROOT, '.github', 'workflows', 'check.yml'), encoding='utf-8').read()
expect('render-video.yml が qc_video.py を呼ぶ', 'scripts/qc_video.py out.mp4' in rv)
expect('render-video.yml は job.video_qc（既定 warn）で落とすかを決める', "j.get('video_qc') or 'warn'" in rv)
expect('check.yml が check_qc_video.py を回す', 'scripts/check_qc_video.py' in ck)
sp = open(os.path.join(ROOT, 'scripts', 'shot_plan.py'), encoding='utf-8').read()
expect('マリーの依頼（shot_plan.render_job）は video_qc を block にする', "'video_qc': product.get('video_qc') or 'block'" in sp)

print('=== 本物の完成動画（カベーニ・-14.17 LUFS）===')
real = os.environ.get('QC_REAL_VIDEO')
if real and os.path.exists(real):
    m, f, w = qc_video.evaluate(real)
    expect('本物は合格し、音量を実際に測っている', not f and m['loudness'] is not None and abs(m['loudness'][0] - (-14.17)) < 0.5)
else:
    print('  （QC_REAL_VIDEO が無いので飛ばす。手元では QC_REAL_VIDEO=path/to/video.mp4）')

print()
if ran < 15:
    print('★検査が %d 件しか走っていません（少なすぎる）' % ran)
    sys.exit(1)
if fails:
    print('不合格 %d 件' % fails)
    sys.exit(1)
print('合格（%d 件）' % ran)
