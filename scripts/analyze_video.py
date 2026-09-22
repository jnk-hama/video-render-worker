#!/usr/bin/env python3
"""
動画を**数字で**測る。競合と自社を同じ物差しに載せるための道具。

【なぜ要るか】
「もっとテンポよく」「AI臭い」は感想であって、実装に落ちない。
実装に落とすには**どの数値をいくつにするか**が要る。
参考にした実物と自社の出力を同じ関数で測れば、差が数値で出る。

★★この道具は**渡された動画ファイルしか読まない。**
  SNSから機械で掻き集める機能は持たない（CLAUDE.md「各SNS・ASPの
  規約違反・BANリスクを一切含めない（スクレイピング等）」）。
  比較したい動画は人が手元に用意する。

【何を測るか】
  尺 / 解像度 / fps
  カット数・1カットの長さ（中央値・最短・最長）
  動きの量（隣り合うコマの差の平均。★カットの瞬間は除く）
  発話の占める割合（無音でない時間の比率）
  音量（平均・最大）
  明るさ（画面全体の輝度の平均）

★カットと動きは同じ1回の走査から出す。scene_score は
  「前のコマとどれだけ違うか」なので、**大きく跳ねた所がカット、
  それ以外の平均が動きの量**になる。2回測らない。

使い方: python3 analyze_video.py a.mp4 [b.mp4 ...]
"""
import json
import re
import subprocess
import sys

# カットとみなす境目。これ以上コマが変われば「切り替わった」
CUT_THRESHOLD = 0.15


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def probe(path):
    r = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height,r_frame_rate',
             '-show_entries', 'format=duration',
             '-of', 'json', path])
    d = json.loads(r.stdout or '{}')
    st = (d.get('streams') or [{}])[0]
    fr = st.get('r_frame_rate', '0/1')
    try:
        num, den = fr.split('/')
        fps = float(num) / float(den) if float(den) else 0.0
    except Exception:
        fps = 0.0
    return {
        'w': st.get('width'), 'h': st.get('height'), 'fps': fps,
        'duration': float((d.get('format') or {}).get('duration') or 0),
    }


def scene_scores(path):
    """コマごとの『前のコマとの違い』を全部返す。"""
    r = run(['ffmpeg', '-v', 'error', '-i', path,
             '-vf', "select='gte(scene,0)',metadata=print:file=-",
             '-f', 'null', '-'])
    return [float(x) for x in
            re.findall(r'lavfi\.scene_score=([0-9.]+)', r.stdout)]


def speech_ratio(path, duration):
    """
    声が鳴っている時間の割合。

    ★無音の判定は -35dB。BGMだけの区間も「鳴っている」に入るので、
      これは**発話率そのものではなく「音が詰まっている度合い」**である。
      名前で誤解しないよう、報告では「音アリ率」と書く。
    """
    r = run(['ffmpeg', '-v', 'error', '-i', path,
             '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'])
    out = r.stdout + r.stderr
    silent = 0.0
    for m in re.finditer(r'silence_duration:\s*([0-9.]+)', out):
        silent += float(m.group(1))
    if not duration:
        return None
    return max(0.0, min(1.0, 1.0 - silent / duration))


def loudness(path):
    r = run(['ffmpeg', '-hide_banner', '-i', path, '-af', 'volumedetect',
             '-f', 'null', '/dev/null'])
    out = r.stdout + r.stderr
    if 'Audio:' not in out:
        return None            # ★音声トラックが無い回
    mean = re.search(r'mean_volume:\s*(-?[0-9.]+)', out)
    peak = re.search(r'max_volume:\s*(-?[0-9.]+)', out)
    return {
        'mean_db': float(mean.group(1)) if mean else None,
        'max_db': float(peak.group(1)) if peak else None,
    }


def brightness(path):
    r = run(['ffmpeg', '-v', 'error', '-i', path,
             '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'])
    vals = [float(x) for x in
            re.findall(r'lavfi\.signalstats\.YAVG=([0-9.]+)', r.stdout)]
    return sum(vals) / len(vals) if vals else None


def median(xs):
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def analyze(path):
    info = probe(path)
    dur, fps = info['duration'], info['fps']

    scores = scene_scores(path)
    cut_idx = [i for i, v in enumerate(scores) if v > CUT_THRESHOLD]
    # ★動きの量からカットの瞬間を外す。外さないと
    #   「カットが多い＝よく動く」という誤った読みになる
    moving = [v for i, v in enumerate(scores) if v <= CUT_THRESHOLD]

    # カットの間隔（秒）。先頭とカット位置から出す
    shot_lens = []
    if fps and dur:
        marks = [0] + [i / fps for i in cut_idx] + [dur]
        shot_lens = [b - a for a, b in zip(marks, marks[1:]) if b - a > 0.05]

    return {
        'file': path.split('/')[-1],
        'duration': dur,
        'size': f"{info['w']}x{info['h']}",
        'fps': round(fps, 2),
        'cuts': len(cut_idx),
        'shots': len(shot_lens),
        'shot_median': median(shot_lens),
        'shot_min': min(shot_lens) if shot_lens else None,
        'shot_max': max(shot_lens) if shot_lens else None,
        'motion': (sum(moving) / len(moving)) if moving else None,
        'sound_ratio': speech_ratio(path, dur),
        'loudness': loudness(path),
        'brightness': brightness(path),
    }


def fmt(v, nd=2, dash='—'):
    return dash if v is None else (f'{v:.{nd}f}' if isinstance(v, float) else str(v))


def main():
    paths = sys.argv[1:]
    if not paths:
        sys.exit('使い方: python3 analyze_video.py a.mp4 [b.mp4 ...]')
    rows = [analyze(p) for p in paths]

    cols = [
        ('尺(秒)', lambda r: fmt(r['duration'])),
        ('解像度', lambda r: r['size']),
        ('fps', lambda r: fmt(r['fps'], 1)),
        ('カット数', lambda r: str(r['cuts'])),
        ('1カット中央値(秒)', lambda r: fmt(r['shot_median'])),
        ('最短/最長(秒)', lambda r: f"{fmt(r['shot_min'])}/{fmt(r['shot_max'])}"),
        ('動きの量', lambda r: fmt(r['motion'], 4)),
        ('音アリ率', lambda r: fmt(r['sound_ratio'], 2)),
        ('平均音量(dB)', lambda r: fmt((r['loudness'] or {}).get('mean_db'), 1)),
        ('明るさ(0-255)', lambda r: fmt(r['brightness'], 1)),
    ]
    name_w = max(len(r['file']) for r in rows)
    label_w = max(len(c[0]) for c in cols)
    print(f"{'項目'.ljust(label_w)} | " + " | ".join(r['file'].ljust(name_w) for r in rows))
    print('-' * (label_w + 3 + (name_w + 3) * len(rows)))
    for label, get in cols:
        print(f"{label.ljust(label_w)} | " + " | ".join(get(r).ljust(name_w) for r in rows))


if __name__ == '__main__':
    main()
