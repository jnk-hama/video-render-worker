#!/usr/bin/env python3
"""
描画の回帰試験（黄金の出力との突き合わせ・決定#190）。

★決まった入力（ffmpeg で作る合成クリップ2本＋商品パネル。文字の無い絵に限る＝焼き込み検査に掛からない）を render_video.py で実際に描き、
  決まった時刻のコマを保存済みの基準（tests/golden/render/*.png）と SSIM で比べる。
  尺・音声の有無・カードとパネルと効果音の位置も見る。
★なぜ要るか：2026-09-26 の夜だけで描画を3回直した（丁寧語の切り取り・効果音・カット番号）。
  部品の検査は通っても「出来上がった動画が前と同じか」を見る物が無く、壊れは本番の描画まで届く。
  HyperFrames 等が CI でやっている golden master の考え方を、ffmpeg だけで小さく持ち込む。
★基準は「前と同じ」を測る物で、「良い」を測る物ではない。見た目を意図して変えた時は
  `--update` で作り直し、差分のコマを人が見てからコミットする。
★ネットワークも重い推論も使わない（文字起こしをしない回＝captions_from_speech: false）。
  ただし clip_audio の回は焼き込み文字の検査（RapidOCR）が走るので、その依存は要る。

使い方: python3 scripts/check_render_golden.py [--update]
"""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORK_REL = '.golden_work'                     # 素材はリポジトリの中から渡す（download が外を指させないため）
WORK = os.path.join(ROOT, WORK_REL)
GOLDEN = os.path.join(ROOT, 'tests', 'golden', 'render')
# 比べる時刻（秒）。カード1枚目・カード2枚目＋商品パネル・終わり際
FRAMES = (0.8, 3.8, 5.0)
SSIM_MIN = 0.995                              # 変更なしで 1.0000（実測）。カードを動かすと 0.94〜0.977 だった
THUMB = '270:480'                             # 基準は縮小して持つ（リポジトリを重くしない）
SPEED = 1.15
CLIP_SECONDS = 3.0

fails = []


def expect(cond, msg):
    print(('  OK   ' if cond else '  NG   ') + msg)
    if not cond:
        fails.append(msg)


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def make_fixtures():
    """決まった合成素材を作る（毎回同じ中身になる lavfi のみ）"""
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    for name, src, hz in (('clip0.mp4', 'rgbtestsrc=size=720x1280:rate=30', 440),
                          ('clip1.mp4', 'smptehdbars=size=720x1280:rate=30', 660)):
        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-f', 'lavfi', '-i', '%s:duration=%s' % (src, CLIP_SECONDS),
             '-f', 'lavfi', '-i', 'sine=frequency=%d:sample_rate=44100:duration=%s' % (hz, CLIP_SECONDS),
             '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
             os.path.join(WORK, name)])
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-f', 'lavfi', '-i', 'color=c=0x3366cc:size=600x600', '-frames:v', '1',
         os.path.join(WORK, 'panel.png')])


def job():
    return {'job': {
        'job_id': 'golden', 'mode': 'A', 'width': 1080, 'height': 1920, 'fps': 30,
        'target_market': 'ja', 'product_key': 'golden-test',
        'clip_audio': True, 'captions_from_speech': False, 'transition_seconds': 0,
        'speech_speed': SPEED, 'quality_gate': 'block',
        'captions': [{'text': 'ゴールデン試験', 'start': 0.2, 'end': 2.2}],
        'design_tokens': {'text_color_hex': '#ffffff', 'accent_color_hex': '#ff3b5c'},
        'clips': [{'url': '%s/clip%d.mp4' % (WORK_REL, i), 'start': 0, 'duration': CLIP_SECONDS,
                   'product_key': 'golden-test'} for i in (0, 1)],
        'info_cards': [{'text': '大きめフード', 'cut_index': 0}, {'text': '長め袖', 'cut_index': 1}],
        'sfx': [{'tag': 'pop', 'cut_index': 0}, {'tag': 'pop', 'cut_index': 1}],
        'product_panel': {'cut_index': 1, 'title': '2色', 'images': ['%s/panel.png' % WORK_REL], 'cutout': False},
        'cta_arrow': {'cut_index': 1},
    }}


def probe(path, entries):
    out = run(['ffprobe', '-v', 'error', '-show_entries', entries, '-of', 'json', path]).stdout
    return json.loads(out)


def frame(src, t, dest):
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-ss', '%.2f' % t, '-i', src,
         '-frames:v', '1', '-vf', 'scale=%s' % THUMB, dest])


def ssim(a, b):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'],
                       capture_output=True, text=True)
    m = re.search(r'All:([0-9.]+)', r.stderr)
    return float(m.group(1)) if m else 0.0


def unit_checks():
    """描かずに確かめられる部品（#204）"""
    sys.path.insert(0, HERE)
    import render_video as rv
    import shot_plan
    print('=== 部品 ===')
    name, fdir, ratio = rv.caption_font('あ')
    m = lambda t: rv.measure_char_ratio(t, name, fdir)  # noqa: E731
    maxw = 1080 - 120 - 2 * rv.CARD_BOX_PAD
    expect(rv.card_font_size(['グレー・ブラックの2色展開'], 86, ratio, maxw, m) == 86,
           '収まる札は縮めない（実測で見る・固定値だけだと縮めてしまう）')
    small = rv.card_font_size(['吸引力26400Paのパワフル吸引で細かいゴミも'], 86, ratio, maxw, m)
    expect(int(86 * rv.CARD_MIN_SCALE) <= small < 86, '長い札は枠に収まるまで縮める（下限あり）: %d' % small)
    ev = rv.cta_arrow_events(10.0, 13.5, 540, 1560, None)
    expect(len(ev) == 7 and all('\\p1' in e for e in ev), 'CTA の矢印は往復ごとに1行（3.5秒で7行）')
    job = shot_plan.render_job({'product_key': 'x'}, {'cuts': [{'role': 'hook', 'seconds': 6, 'line': 'a'},
                                                               {'role': 'cta', 'seconds': 4, 'line': 'b'}]},
                               ['u0', 'u1'], 'preview/x.mp4')['job']
    expect(job.get('cta_arrow') == {'cut_index': 1}, '依頼は最後の CTA カットに矢印を付ける')


def main():
    update = '--update' in sys.argv
    unit_checks()
    make_fixtures()
    jp, out = os.path.join(WORK, 'job.json'), os.path.join(WORK, 'out.mp4')
    json.dump(job(), open(jp, 'w', encoding='utf-8'), ensure_ascii=False)
    r = subprocess.run([sys.executable, os.path.join(HERE, 'render_video.py'), '--payload', jp, '--out', out],
                       capture_output=True, text=True, cwd=ROOT)
    log = r.stdout + r.stderr
    expect(r.returncode == 0 and os.path.exists(out), '描画が最後まで通る')
    if r.returncode != 0:
        print(log[-3000:])
        return finish()

    print('=== 形 ===')
    info = probe(out, 'format=duration:stream=codec_type')
    dur = float(info['format']['duration'])
    want = 2 * CLIP_SECONDS / SPEED
    expect(abs(dur - want) < 0.15, '尺は（2本×%.1f秒）÷%.2f＝%.2f秒（実際 %.2f秒）' % (CLIP_SECONDS, SPEED, want, dur))
    kinds = [s['codec_type'] for s in info['streams']]
    expect('video' in kinds and 'audio' in kinds, '映像と音声の両方がある')

    print('=== 置き場所（ログ）===')
    pops = [float(x) for x in re.findall(r'pop\.mp3@([0-9.]+)s', log)]
    expect(len(pops) == 2, '効果音はカードの数だけ（2本）')
    cut1 = CLIP_SECONDS / SPEED
    expect(len(pops) == 2 and pops[0] < 0.5 and abs(pops[1] - (cut1 + 0.15)) < 0.2,
           '効果音はカードの出る瞬間（1本目の頭・2本目の頭＋0.15秒）: %s' % pops)
    m = re.search(r'商品パネルを重ねました（1枚 / ([0-9.]+)〜([0-9.]+)秒）', log)
    expect(bool(m) and float(m.group(1)) >= cut1, '商品パネルは2本目のカットに出る')

    print('=== コマ（基準との SSIM）===')
    os.makedirs(GOLDEN, exist_ok=True)
    for t in FRAMES:
        name = 't%04.1f.png' % t
        got = os.path.join(WORK, name)
        frame(out, t, got)
        gold = os.path.join(GOLDEN, name)
        if update or not os.path.exists(gold):
            shutil.copy(got, gold)
            print('  --   基準を書きました: tests/golden/render/%s（見てからコミットすること）' % name)
            continue
        s = ssim(got, gold)
        expect(s >= SSIM_MIN, '%.1f秒のコマが基準と同じ（SSIM %.4f ≥ %.3f）' % (t, s, SSIM_MIN))
    return finish()


def finish():
    print()
    if fails:
        print('不合格 %d 件' % len(fails))
        sys.exit(1)
    print('合格')


if __name__ == '__main__':
    main()
