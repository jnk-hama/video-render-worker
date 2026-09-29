#!/usr/bin/env python3
"""
出来上がった動画の品質検査（決定#225）。ffmpeg の公式フィルターだけで測る。0円・決定論的（LLMも外部サービスも使わない）。

  python3 scripts/qc_video.py out.mp4 [--size 1080x1920] [--warn-only]

【なぜ要るか】render-video.yml の既存の検査は「音声トラックがあるか」だけだった（ffprobe は壊れていないことまでしか保証しない）。
  黒いコマ・固まった映像・途中の無音・音量の外れ・大きさの違いは、目視の前に機械で落とす。
【何を測るか】数字はこのファイルの定数だけが持つ（同じ量を2箇所に書かない）。
  ・落とす（fail）: 大きさが違う／黒いコマ 0.3秒以上／映像の固まり 2秒以上／途中の無音 2秒以上／音量が -20〜-9 LUFS の外
  ・注意（warn）  : 無音 1秒以上／音量が -16〜-12 LUFS の外／ピークが -1.0 dBTP を超える／30fps でない
  実測の基準：カベーニの完成動画は -14.17 LUFS・ピーク -1.43 dBTP・黒/固まり/無音なし（TikTok の目安は約 -14 LUFS）
★測れなかった時（フィルターの出力が読めない）は合格にしない。「何も起きなかった」と「問題なし」を取り違えない（E-021・E-036）。
★VMAF は使わない：基準動画が要る（完成動画には無い）うえ、鮮明化するだけで点が上がる指標で、画質の良し悪しを取り違える。
"""
import json
import re
import subprocess
import sys

SIZE = (1080, 1920)
FPS = 30
BLACK_FAIL_S = 0.3
FREEZE_FAIL_S = 2.0
SILENCE_WARN_S = 1.0
SILENCE_FAIL_S = 2.0
LUFS_FAIL = (-20.0, -9.0)
LUFS_WARN = (-16.0, -12.0)
TP_WARN = -1.0
EDGE_S = 0.2          # 始まりと終わりの黒（フェード）は数えない


def _ff(args):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-v', 'info'] + args, capture_output=True, text=True)
    return r.returncode, r.stderr


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
                        '-show_entries', 'format=duration', '-of', 'json', path], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('ffprobe が読めません: %s' % r.stderr.strip()[:200])
    d = json.loads(r.stdout)
    v = next((s for s in d.get('streams', []) if s.get('codec_type') == 'video'), None)
    a = next((s for s in d.get('streams', []) if s.get('codec_type') == 'audio'), None)
    if not v:
        raise SystemExit('映像トラックがありません')
    num, den = (v.get('r_frame_rate') or '0/1').split('/')
    return {'w': int(v['width']), 'h': int(v['height']), 'fps': float(num) / float(den or 1),
            'duration': float(d['format']['duration']), 'has_audio': a is not None}


def intervals(stderr, start_key, dur_key):
    """freezedetect / silencedetect の出力から (開始, 長さ) を取る"""
    starts = [float(x) for x in re.findall(start_key + r'[:=]\s*([\d.]+)', stderr)]
    durs = [float(x) for x in re.findall(dur_key + r'[:=]\s*([\d.]+)', stderr)]
    return list(zip(starts, durs))


def black(path):
    _, err = _ff(['-i', path, '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-an', '-f', 'null', '-'])
    return [(float(s), float(e) - float(s)) for s, e in
            re.findall(r'black_start:([\d.]+)\s+black_end:([\d.]+)', err)]


def freeze(path):
    _, err = _ff(['-i', path, '-vf', 'freezedetect=n=-60dB:d=0.5', '-an', '-f', 'null', '-'])
    starts = [float(x) for x in re.findall(r'freeze_start:\s*([\d.]+)', err)]
    durs = [float(x) for x in re.findall(r'freeze_duration:\s*([\d.]+)', err)]
    # 最後まで固まったままの区間は freeze_duration が出ない（終わりが来ない）。その分は尺から補う
    return starts, durs, err


def silence(path):
    _, err = _ff(['-i', path, '-af', 'silencedetect=noise=-45dB:d=0.5', '-vn', '-f', 'null', '-'])
    starts = [float(x) for x in re.findall(r'silence_start:\s*([\d.]+)', err)]
    durs = [float(x) for x in re.findall(r'silence_duration:\s*([\d.]+)', err)]
    return starts, durs


def loudness(path):
    _, err = _ff(['-i', path, '-af', 'loudnorm=print_format=json', '-vn', '-f', 'null', '-'])
    m = re.search(r'\{[^{}]*"input_i"[^{}]*\}', err, re.S)
    if not m:
        return None
    j = json.loads(m.group(0))
    try:
        return float(j['input_i']), float(j['input_tp'])
    except (KeyError, ValueError):
        return None


def _tail(starts, durs, total):
    """終わりまで続いた区間（duration が出ない分）を (開始, 尺-開始) で足す"""
    out = list(zip(starts, durs))
    if len(starts) > len(durs):
        out.append((starts[-1], max(0.0, total - starts[-1])))
    return out


def evaluate(path, size=SIZE):
    """(測った値の辞書, fails, warns)"""
    fails, warns = [], []
    p = probe(path)
    m = dict(p)
    if (p['w'], p['h']) != tuple(size):
        fails.append('大きさが %dx%d（%dx%d のはず）' % (p['w'], p['h'], size[0], size[1]))
    if abs(p['fps'] - FPS) > 0.5:
        warns.append('フレームレートが %.1f（%d のはず）' % (p['fps'], FPS))
    if p['duration'] <= 0.5:
        fails.append('尺が短すぎます（%.2f秒）' % p['duration'])

    bl = [(s, d) for s, d in black(path) if s > EDGE_S and s + d < p['duration'] - EDGE_S]
    m['black'] = bl
    for s, d in bl:
        if d >= BLACK_FAIL_S:
            fails.append('黒いコマが %.1f秒から %.1f秒間' % (s, d))

    fs, fd, _ = freeze(path)
    fr = _tail(fs, fd, p['duration'])
    m['freeze'] = fr
    for s, d in fr:
        if d >= FREEZE_FAIL_S:
            fails.append('映像が %.1f秒から %.1f秒間 固まっている' % (s, d))

    if p['has_audio']:
        ss, sd = silence(path)
        sl = [(s, d) for s, d in _tail(ss, sd, p['duration']) if s + d < p['duration'] - 0.5 or d >= SILENCE_FAIL_S]
        m['silence'] = sl
        for s, d in sl:
            if d >= SILENCE_FAIL_S:
                fails.append('無音が %.1f秒から %.1f秒間' % (s, d))
            elif d >= SILENCE_WARN_S:
                warns.append('無音が %.1f秒から %.1f秒間' % (s, d))
        ld = loudness(path)
        m['loudness'] = ld
        if ld is None:
            fails.append('音量を測れませんでした（loudnorm の出力が読めない）。合格にしません')
        else:
            i, tp = ld
            if not (LUFS_FAIL[0] <= i <= LUFS_FAIL[1]):
                fails.append('音量が %.1f LUFS（%.0f〜%.0f の外）' % (i, LUFS_FAIL[0], LUFS_FAIL[1]))
            elif not (LUFS_WARN[0] <= i <= LUFS_WARN[1]):
                warns.append('音量が %.1f LUFS（目安 %.0f〜%.0f の外）' % (i, LUFS_WARN[0], LUFS_WARN[1]))
            if tp > TP_WARN:
                warns.append('音のピークが %.2f dBTP（%.1f を超える。割れる恐れ）' % (tp, TP_WARN))
    else:
        m['silence'] = None
        m['loudness'] = None
    return m, fails, warns


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        raise SystemExit(__doc__)
    path = args[0]
    size = SIZE
    if '--size' in args:
        w, h = args[args.index('--size') + 1].lower().split('x')
        size = (int(w), int(h))
    m, fails, warns = evaluate(path, size)
    print('動画の品質検査: %dx%d / %.1ffps / %.1f秒 / 音声%s' % (
        m['w'], m['h'], m['fps'], m['duration'], 'あり' if m['has_audio'] else 'なし'))
    if m['loudness']:
        print('  音量 %.2f LUFS / ピーク %.2f dBTP' % m['loudness'])
    print('  黒 %d 区間 / 固まり %d 区間 / 無音 %s 区間' % (
        len(m['black']), len(m['freeze']), '-' if m['silence'] is None else len(m['silence'])))
    for w in warns:
        print('  ⚠ 注意: ' + w)
    for f in fails:
        print('  ★NG: ' + f)
    if fails and '--warn-only' not in args:
        print('品質検査で %d 件の問題' % len(fails))
        return 1
    print('品質検査: 合格' + ('（注意 %d 件）' % len(warns) if warns else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
