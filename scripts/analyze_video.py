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
import random
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


def percentile(xs, q):
    """q（0〜1）の位置の値。補間はしない（本数が少ないので意味が薄い）。"""
    if not xs:
        return None
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


# ★参考動画の刻みを真似る時の乱数の種。**固定する。**
#   同じ参考動画からは毎回同じ割り付けが出なければならない
#   （CLAUDE.md「確率で出力が揺れる処理を構成に持ち込まない」）。
PLAN_SEED = 7

"""
★★カット長の下限（2026-09-22）。**分布をそのまま信じない。**

実測した競合の分布には 0.07秒（30fpsで2コマ）のカットが入っていた。
だがこれは「本当に2コマで切っている」のではなく、**速い動きを
カットと誤検出したもの**の可能性が高い。scene_score は
「前のコマとの違い」しか見ないので、手を素早く動かせば跳ねる。

そのまま真似ると、うちの映像は**チラつくだけ**になる。
測った値を使う時は、測定の誤りが混じる前提で下限を置く。

★0.35秒＝30fpsで約10コマ。人が「1カット見た」と認識できる下限あたり。
  フラッシュカットを意図的にやりたい回は --min で下げられる。
"""
MIN_SHOT_SECONDS = 0.35


def plan_shots(shot_lens, target_duration, seed=PLAN_SEED,
               min_shot=MIN_SHOT_SECONDS):
    """
    参考動画と同じ『刻みの癖』で、target_duration を埋めるカット長を提案する。

    ★★**平均を使わない。** ここが肝（考え方は ECC の TasteForge
      `taste/cadence.py::plan_shots` から。MIT / Copyright 2026 Affaan Mustafa）。

      平均で割ると全部同じ長さになり、**等間隔＝機械的**に見える。
      参考動画の実際のカット長の**分布からそのまま抽き直す**ことで、
      「長い・短い・また長い」という揺れごと真似る。

      うちで実際に外した例：競合を目で見て「1カット1.2秒」と言ったが、
      実測の分布は 0.07〜2.23秒とばらついていた。中央値だけ真似ても
      あの疾走感は出ない。**ばらつきが正体**だった。

    ★乱数は種を固定する。同じ入力からは毎回同じ結果が出る。

    @param shot_lens 参考動画の各カットの長さ（秒）
    @param target_duration 埋めたい尺（うちはナレーションの長さ）
    @return 提案するカット長の並び（秒）
    """
    # ★下限より短いカットは捨てる（誤検出を真似ないため。上の注記）
    pool = [d for d in (shot_lens or []) if d >= min_shot]
    if not pool:
        # ★全部が下限未満＝そもそも測れていない。等分に落として知らせる
        pool = [max(min_shot, (shot_lens or [min_shot])[0])]
    if target_duration <= 0:
        return []

    rng = random.Random(seed)
    out = []
    acc = 0.0
    # ★念のための上限。分布が極端に短いと延々と刻み続けうる
    while acc < target_duration and len(out) < 200:
        d = rng.choice(pool)
        remaining = target_duration - acc
        # ★残りが中途半端に短いなら、無理に1カット足さず打ち切る
        if remaining < d * 0.5:
            break
        d = min(d, remaining)
        out.append(round(d, 3))
        acc += d
    if not out:
        out = [round(target_duration, 3)]
    return out


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
        'shot_lens': shot_lens,          # ★分布そのもの。plan_shots が使う
        'shot_median': median(shot_lens),
        'shot_p25': percentile(shot_lens, 0.25),
        'shot_p75': percentile(shot_lens, 0.75),
        'shot_min': min(shot_lens) if shot_lens else None,
        'shot_max': max(shot_lens) if shot_lens else None,
        'cuts_per_min': (len(cut_idx) / dur * 60.0) if dur else None,
        'motion': (sum(moving) / len(moving)) if moving else None,
        'sound_ratio': speech_ratio(path, dur),
        'loudness': loudness(path),
        'brightness': brightness(path),
    }


def fmt(v, nd=2, dash='—'):
    return dash if v is None else (f'{v:.{nd}f}' if isinstance(v, float) else str(v))


def print_plan(ref, target, n_clips, min_shot=MIN_SHOT_SECONDS):
    """
    参考動画の刻みで target 秒を埋める割り付けを出し、
    **そのまま render_video の clips[].duration へ貼れる形**で見せる。

    ★手持ちのクリップ本数より多く刻む回は、同じクリップを
      `start` 違いで何度も使う（1本を切り刻む＝追加の生成費用は0円）。
    """
    plan = plan_shots(ref['shot_lens'], target, min_shot=min_shot)
    print()
    dropped = len([d for d in ref['shot_lens'] if d < min_shot])
    print(f"■ {ref['file']} の刻みで {target:.2f}秒 を埋める割り付け")
    if dropped:
        print(f"  ※下限{min_shot:.2f}秒 未満の {dropped} カットは誤検出とみなし除外")
    print(f"  提案カット数: {len(plan)}  合計 {sum(plan):.2f}秒")
    print(f"  長さ: {', '.join(f'{d:.2f}' for d in plan)}")
    if not n_clips:
        return
    print(f"  手持ちクリップ {n_clips}本 に割り当てると:")
    # ★同じクリップを続けて使わない。隣り合うと「止まった」ように見える
    for i, d in enumerate(plan):
        print(f"    カット{i + 1:>2}: clip[{i % n_clips}]  duration={d:.2f}")
    if len(plan) > n_clips:
        print(f"  ※{len(plan)}カットに対しクリップは{n_clips}本。"
              f"同じ素材を start 違いで使い回す想定（生成費用は増えない）")


def main():
    args = [a for a in sys.argv[1:]]
    target = None
    n_clips = 0
    # ★--plan 秒数 / --clips 本数 を取り出す（残りを動画ファイルとして扱う）
    for flag, setter in (('--plan', 'target'), ('--clips', 'clips')):
        if flag in args:
            i = args.index(flag)
            try:
                val = float(args[i + 1])
            except (IndexError, ValueError):
                sys.exit(f'{flag} のあとに数値が要ります')
            if setter == 'target':
                target = val
            else:
                n_clips = int(val)
            del args[i:i + 2]

    paths = args
    if not paths:
        sys.exit('使い方: python3 analyze_video.py a.mp4 [b.mp4 ...] '
                 '[--plan 秒数] [--clips 本数]')
    rows = [analyze(p) for p in paths]

    cols = [
        ('尺(秒)', lambda r: fmt(r['duration'])),
        ('解像度', lambda r: r['size']),
        ('fps', lambda r: fmt(r['fps'], 1)),
        ('カット数', lambda r: str(r['cuts'])),
        ('1カット中央値(秒)', lambda r: fmt(r['shot_median'])),
        ('p25-p75(秒)', lambda r: f"{fmt(r['shot_p25'])}-{fmt(r['shot_p75'])}"),
        ('最短/最長(秒)', lambda r: f"{fmt(r['shot_min'])}/{fmt(r['shot_max'])}"),
        ('カット/分', lambda r: fmt(r['cuts_per_min'], 1)),
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

    # ★--plan を渡した回は、1本目（＝参考動画）の刻みで割り付けを出す
    if target:
        print_plan(rows[0], target, n_clips)


if __name__ == '__main__':
    main()
