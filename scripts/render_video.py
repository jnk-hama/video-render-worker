#!/usr/bin/env python3
"""
縦型ショート動画を1本組み立てる。2つのモードを持つ。

★★2026-08-24、オーナー判断
   「フォロワーとViewを稼ぐ為に金を払う意味がない」
   JSON2Video も映像ライセンスも使わず、ffmpeg だけで作る。
   GitHub Actions の無料枠でも Colab でも、同じこのファイルが動く。

┌─ モードA（エンタメ・衝撃系）─────────────────────────
│  本文を読み上げた音声を作り、その **発声時刻に合わせて**
│  単語ごとにポップする字幕を焼き込む。
│
│  ★Whisper は使わない。音声をこちらで作るので、
│    「どの単語が何秒に鳴るか」は推定ではなく確定値で手に入る
│    （edge-tts の WordBoundary）。詳細は scripts/tts.py
│
│  音声が用意できなかった回は、無音のまま均等割りの字幕へ降りる。
│  字幕が出ないより、少しずれても出る方が伝わる。
└──────────────────────────────────────────────

┌─ モードB（ハイテンポなカット割り）─────────────────────
│  音声解析も字幕付与も **一切行わない**（オーナー指示）。
│  短いクリップをランダムに抜き、1〜3秒のハードカットで連結。
│  15〜30秒のMAD風にする。
└──────────────────────────────────────────────

【共通の工程】
  1. クリップURLを順に取得（1本欠けても止めない。全滅なら中止）
  2. 各クリップを切り出し、9:16へ揃える（規格を揃えないと連結が壊れる）
  3. 連結
  4. モードAなら字幕を焼き、音声を載せる
  5. MP4を出す

【なぜ moviepy を使わないか】
  必要なのは編集だけで、ラッパーを挟むと依存が94パッケージ増え、
  ffmpeg のエラーが握り潰されて原因が追えなくなる。

【入力】stdin か --payload でJSON
{
  "job_id": "...", "mode": "A" | "B",
  "width": 1080, "height": 1920, "fps": 30,
  "clips":     [{"url": "https://...", "start": 0, "duration": 1.6}, ...],
  "narration": "読み上げる本文",           // モードA
  "captions":  [{"text","start","end"}],   // モードA。TTSが使えない時の予備
  "voice": "en-US-AndrewMultilingualNeural"
}

【出力】--out で指定したパスへ MP4
【異常時】必ず 0 以外で終了する。黙って空の動画を出さない
"""

import argparse
import json
import math
import os
import random
import shlex
import subprocess
import sys
import tempfile

# 1本のクリップの上限。極端に長いものを拾うと転送で時間を食う
MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024
DOWNLOAD_TIMEOUT_SEC = 60

"""
★★以下3つは MoneyPrinterTurbo（harry0703、MITライセンス、117,416スター）を
  読んで取り込んだ知見（2026-08-28）。あちらのコードは移植していない。
  「どういう問題に、どういう数字で対処しているか」だけを参考にした。
"""

# 映像の尺に持たせる余裕（秒）。
# ★FFmpegはフレームレートの丸めで最終尺がわずかに短くなることがある。
#   映像が音声より1フレームでも短いと -shortest がナレーションを切る。
#   長い方へ倒しておけば、余った映像は -shortest が音声に合わせて切るだけ。
VIDEO_DURATION_SAFETY_MARGIN = 0.5

# 素材として受け付ける最小の辺（px）。これ未満は 1080x1920 へ引き伸ばすと
# 明らかにぼやける。無料ストックには小さい素材が混ざっている。
MIN_MATERIAL_DIMENSION = 480

# BGMの音量比。ナレーションを1.0としたときの倍率。
# ★0.2 より上げるとナレーションが聞き取りにくくなる。
BGM_VOLUME = 0.2

# 終わりのBGMフェードアウト（秒）。ぶつ切りで終わると素人臭くなる。
BGM_FADEOUT_SEC = 3.0


def log(msg):
    print(msg, flush=True)


def run(cmd, **kw):
    """失敗したら stderr をそのまま見せる。握り潰さない。"""
    log('$ ' + ' '.join(shlex.quote(c) for c in cmd))
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        log(p.stdout[-4000:])
        log(p.stderr[-4000:])
        raise RuntimeError('コマンドが失敗しました: ' + cmd[0])
    return p


def download(url, dest):
    """
    1本落とす。失敗しても例外にしない（呼び出し側が次のクリップへ進む）。

    ★1本の欠損で動画ごと落とすと、素材CDNの一時障害で毎回失敗する。
    """
    try:
        run(['curl', '-sSL', '--fail',
             '--max-time', str(DOWNLOAD_TIMEOUT_SEC),
             '--max-filesize', str(MAX_DOWNLOAD_BYTES),
             '-o', dest, url])
    except Exception as e:
        log('  取得できませんでした（次のクリップへ）: %s' % e)
        return False
    return os.path.exists(dest) and os.path.getsize(dest) > 1024


def probe_resolution(path):
    """
    素材の縦横を測る。取れなければ (0, 0)。

    ★★2026-08-28追加。MoneyPrinterTurbo が
      is_material_resolution_acceptable で同じ足切りをしていた。
    """
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height',
             '-of', 'csv=p=0:s=x', path],
            capture_output=True, text=True, timeout=30).stdout.strip()
        wv, hv = out.split('x')[:2]
        return int(wv), int(hv)
    except Exception:
        return 0, 0


def resolution_is_acceptable(path):
    """
    引き伸ばしても見られる大きさか。

    ★無料ストックには小さい素材が混ざっている。1080x1920 へ
      引き伸ばすと明らかにぼやけ、「くそ動画」の一因になる。
      測れなかった場合は通す。測れないことを理由に素材を捨てると、
      ffprobe が無い環境で全部落ちる。
    """
    rw, rh = probe_resolution(path)
    if not rw or not rh:
        return True
    return rw >= MIN_MATERIAL_DIMENSION and rh >= MIN_MATERIAL_DIMENSION


def normalize(src, dest, start, duration, w, h, fps):
    """
    1クリップを「指定秒数・9:16・同一規格」に揃える。

    ★連結の前に必ず揃える。解像度やfpsが違うまま concat すると、
      音ズレや再エンコード失敗の原因になる。

    scale=increase → crop で、横長素材を縦型に切り出す（余白を作らない）。
    """
    vf = (
        'scale={w}:{h}:force_original_aspect_ratio=increase,'
        'crop={w}:{h},setsar=1,fps={fps},format=yuv420p'
    ).format(w=w, h=h, fps=fps)

    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-ss', str(start), '-t', str(duration), '-i', src,
         '-an', '-vf', vf,
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
         dest])
    return os.path.exists(dest) and os.path.getsize(dest) > 1024


# 静止画かどうか。拡張子とContent-Typeの両方が当てにならないので、
# URLの拡張子とファイルの中身の両方を見る
IMAGE_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.bmp')


def looks_like_image(url, path):
    """
    その素材が静止画か。

    ★★アフィリエイトの公式素材は静止画である（2026-08-25）。
      FANZAの商品情報APIが返すのは imageURL（商品パッケージ画像）で、
      動画のURLは含まれない。つまり「公式素材で動画を作る」なら、
      静止画を動かす工程が必ず要る。
    """
    if str(url).lower().split('?')[0].endswith(IMAGE_EXT):
        return True
    try:
        p = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=codec_name,nb_frames',
             '-of', 'default=nw=1', path],
            capture_output=True, text=True)

        """
        ★★行ごとに「値」で判定する（2026-08-25、実行して直した）。

        最初は `'nb_frames=1' in out` と書いていた。これだと
        nb_frames=150 にも nb_frames=10 にも一致してしまい、
        **普通の動画を静止画だと誤判定**していた。
        その結果 `-loop 1` を動画へ付けて
        「Option loop not found」で落ちていた（実行して発見）。

        部分一致で数値を見ない。
        """
        codec = ''
        frames = ''
        for line in (p.stdout or '').splitlines():
            line = line.strip()
            if line.startswith('codec_name='):
                codec = line.split('=', 1)[1].strip()
            elif line.startswith('nb_frames='):
                frames = line.split('=', 1)[1].strip()

        if codec in ('mjpeg', 'png', 'webp', 'bmp', 'gif'):
            return True
        if frames == '1':
            return True
    except Exception:
        pass
    return False


def still_to_clip(src, dest, duration, w, h, fps, rng):
    """
    静止画を「動くカット」にする（Ken Burns）。

    ★止まった絵をそのまま挟むと、そこだけ時間が止まって見える。
      ハイテンポなカット割りの中では特に目立つ。
      ゆっくり寄る／引くだけで、映像として成立する。

    ★寄りと引きを毎回ランダムに選ぶ。全部同じ動きだと、
      枚数が増えたときに単調さが際立つ。

    元画像より大きく作ってから切り出す。等倍のまま拡大すると
    輪郭が甘くなるため。
    """
    frames = max(2, int(round(duration * fps)))
    big_w, big_h = int(w * 1.5), int(h * 1.5)

    zoom_in = rng.random() < 0.5
    if zoom_in:
        # 1.0 → 1.18 へゆっくり寄る
        z = "min(zoom+%.5f,1.18)" % (0.18 / frames)
    else:
        # 1.18 から引く。max()で下限を止める
        z = "if(eq(on,1),1.18,max(zoom-%.5f,1.0))" % (0.18 / frames)

    vf = (
        'scale={bw}:{bh}:force_original_aspect_ratio=increase,'
        'crop={bw}:{bh},'
        "zoompan=z='{z}':d={d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        ':s={w}x{h}:fps={fps},setsar=1,format=yuv420p'
    ).format(bw=big_w, bh=big_h, z=z, d=frames, w=w, h=h, fps=fps)

    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-loop', '1', '-i', src, '-t', str(duration),
         '-an', '-vf', vf,
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
         dest])
    return os.path.exists(dest) and os.path.getsize(dest) > 1024


def ass_time(sec):
    """ASSの時刻表記 h:mm:ss.cc"""
    if sec < 0:
        sec = 0
    cs = int(round(sec * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return '%d:%02d:%02d.%02d' % (h, m, s, cs)


def ass_escape(text):
    """ASSの制御文字を無効化する。字幕文字列は外から来るので必ず通す。"""
    return (str(text)
            .replace('\\', '')
            .replace('{', '(')
            .replace('}', ')')
            .replace('\n', ' ')
            .strip())


# ★1文字あたりの幅 ÷ フォントサイズ。DejaVu Sans Bold を実際に描画して測った値。
#   110pxで "HAD NO BUSINESS"（15文字）が約960px → 64/110 ≒ 0.58。
#   はみ出す側の失敗の方が痛いので、少し大きめの 0.60 を使う。
CHAR_WIDTH_RATIO = 0.60

# 字幕は最大2行まで。3行以上は映像を隠しすぎる
MAX_CAPTION_LINES = 2


def fit_caption(words, w, font_size):
    """
    画面幅に収まる文字サイズと、改行位置を決める。

    ★★2026-08-24、実測してから直した。
      最初は「文字数から一律に縮小する」だけにしていたが、
      読めなくならないよう下限を置いた結果、その下限が効いて
      長い語が画面の外へはみ出した（実際にフレームを抜いて確認）。

      縮小だけで解決しようとしたのが誤り。人が作る字幕と同じで、
      入らなければ**折る**。折った上で、それでも入らない時に縮める。

    @return (フォントサイズ, [1行目の語数, ...])
    """
    usable = w - 120                       # 左右60pxずつ余白
    floor = max(40, int(font_size * 0.5))  # これ以下は読めない

    size = font_size
    while True:
        per_char = CHAR_WIDTH_RATIO * size
        lines = []
        cur = []
        for wd in words:
            trial = cur + [wd]
            if cur and len(' '.join(trial)) * per_char > usable:
                lines.append(cur)
                cur = [wd]
            else:
                cur = trial
        if cur:
            lines.append(cur)

        # 1語だけで幅を超える場合も、これ以上は折れない
        too_wide = any(len(' '.join(ln)) * per_char > usable for ln in lines)
        if (len(lines) <= MAX_CAPTION_LINES and not too_wide) or size <= floor:
            return size, [len(ln) for ln in lines]
        size -= 6


def build_ass(captions, w, h, font_size, center=False):
    """
    単語ごとに色が変わる字幕（karaoke）を作る。

    ★これが「トップYouTuber特有の字幕」の正体。
      \\k タグで単語ごとに PrimaryColour へ塗り替わる。
      さらに \\t でわずかに拡大させ、ポップして出るように見せる。

    ★ミュート再生でも内容が伝わることが要件なので、
      画面中央よりやや下に大きく置く。
    """
    head = [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: %d' % w,
        'PlayResY: %d' % h,
        'WrapStyle: 2',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        ('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, '
         'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
         'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
         'Alignment, MarginL, MarginR, MarginV, Encoding'),
        # PrimaryColour(塗られた後)=黄 / SecondaryColour(塗られる前)=白
        # 太い黒縁を付けないと、明るい映像の上で読めなくなる
        ('Style: Pop,DejaVu Sans,%d,&H0000FFFF,&H00FFFFFF,&H00000000,'
         '&H80000000,-1,0,0,0,100,100,0,0,1,7,3,5,60,60,60,1' % font_size),
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ]

    """
    ★置く高さは、背景に映像があるかどうかで変える。

    映像がある回（モードA）は下寄せにする。中央に置くと被写体の顔を
    塞ぐし、そもそも主役は映像側なので邪魔をしない位置がよい。

    ★★モードT（背景が単色）は中央に置く（2026-08-26）。
      最初は下寄せのまま出したところ、画面の上7割が完全に死んだ
      真っ黒の帯になった（実際にフレームを抜いて確認）。
      文字が主役の回に、その文字を隅へ寄せる理由が無い。
    """
    y = int(h * (0.50 if center else 0.74))
    lines = []
    for c in captions:
        text = ass_escape(c.get('text', ''))
        if not text:
            continue
        start = float(c.get('start', 0))
        end = float(c.get('end', start + 1.2))
        if end <= start:
            continue

        words = [wd for wd in text.split() if wd]
        if not words:
            continue

        size, line_breaks = fit_caption(words, w, font_size)
        fs = '' if size >= font_size else ('\\fs%d' % size)

        # 折り返す語の位置（そこへ来る前に \N を挟む）
        breaks = {}
        at = 0
        for n in line_breaks[:-1]:
            at += n
            breaks[at] = True

        """
        ★★単語ごとの持ち時間（センチ秒）。

        TTSが実際の発声時刻(word_cs)を返している時は、必ずそれを使う。
        均等割りにすると「音は次の語へ進んでいるのに、色が前の語を
        塗っている」というずれが出る。音に合わせて塗るのがこの字幕の
        肝なので、ここを推定で埋めてはいけない。

        word_cs が無いのは、TTSが使えず均等割りの予備へ降りた回だけ。
        """
        total_cs = int(round((end - start) * 100))
        given = c.get('word_cs')
        if given and len(given) == len(words):
            per_word = [max(1, int(x)) for x in given]
        else:
            per = max(1, total_cs // len(words))
            per_word = [per] * len(words)
            per_word[-1] = max(1, total_cs - per * (len(words) - 1))

        karaoke = ''
        for i, wd in enumerate(words):
            if breaks.get(i):
                karaoke = karaoke.rstrip() + '\\N'
            karaoke += '{\\k%d}%s ' % (per_word[i], wd.upper())

        # 出だしで少し大きく → 元のサイズへ戻す（ポップ）
        effect = ('{\\pos(%d,%d)%s\\fad(60,60)'
                  '\\fscx70\\fscy70\\t(0,110,\\fscx106\\fscy106)'
                  '\\t(110,190,\\fscx100\\fscy100)}' % (w // 2, y, fs))

        lines.append('Dialogue: 0,%s,%s,Pop,,0,0,0,,%s%s'
                     % (ass_time(start), ass_time(end), effect, karaoke.strip()))

    return '\n'.join(head + lines) + '\n'


def probe_duration(path):
    """クリップの尺（秒）。取れなければ 0。"""
    try:
        p = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                            'format=duration', '-of', 'default=nw=1:nk=1', path],
                           capture_output=True, text=True)
        return float((p.stdout or '0').strip() or 0)
    except Exception:
        return 0.0


def pick_cut_window(src_path, want, rng):
    """
    そのクリップのどこを切るか決める。

    ★★頭から切らない（モードB）。
      ストック映像は冒頭が静止していることが多く、
      毎回0秒から切ると「動かないカット」ばかりが並ぶ。
      尺が足りる時は中盤からランダムに取る。

    @return (開始秒, 実際に切れる長さ)
    """
    dur = probe_duration(src_path)
    if dur <= 0:
        return 0.0, want
    if dur <= want + 0.2:
        # 短い素材。頭から取れるだけ取る
        return 0.0, max(0.4, dur - 0.05)
    latest = dur - want - 0.05
    return round(rng.uniform(0.0, min(latest, dur * 0.6)), 2), want


def build_captions_from_tts(narration, work, voice):
    """
    本文を音声にして、実際の発声時刻から字幕を組み立てる。

    @return (音声ファイル, 字幕リスト, 音声の長さ) / 使えなければ (None, [], 0)
    """
    if not narration:
        return None, [], 0.0
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import tts as tts_mod
    except Exception as e:
        log('TTSモジュールを読み込めません（無音で続行）: %s' % e)
        return None, [], 0.0

    audio = os.path.join(work, 'narration.mp3')
    try:
        r = tts_mod.synthesize(narration, audio, voice=voice)
    except Exception as e:
        # ★ここで落とさない。音声が無くても動画は出す
        log('音声を作れませんでした（無音で続行）: %s' % e)
        return None, [], 0.0

    chunks = tts_mod.group_words(r['words'])
    if not chunks:
        log('単語の時刻が取れませんでした。音声だけ使い、字幕は均等割りにします。')
    return r['path'], chunks, float(r['duration'] or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--payload', help='JSONファイル。省略時は stdin')
    ap.add_argument('--out', required=True)
    ap.add_argument('--workdir', default=None)
    args = ap.parse_args()

    raw = open(args.payload, encoding='utf-8').read() if args.payload else sys.stdin.read()
    job = json.loads(raw)

    """
    ★★2026-08-25、送信経路の天井を外した。

    GitHub の repository_dispatch は client_payload の
    **最上位プロパティを10個までしか受け付けない**（超えると 422 で、
    ワークフローは起動すらしない）。

    モードAの送信内容を数えると
      job_id / account / mode / width / height / fps /
      clip_seconds / clips / narration / captions
    でちょうど 10。**余白がゼロだった。**

    このファイルは voice / seed / font_size も読む作りになっているのに、
    どれか1つでも足した瞬間に全部の描画が止まる状態で、
    つまり実装済みの機能へ永久に手が届かなかった。

    入れ子（{"job": {...}}）で受ければ最上位は1個で済み、天井が消える。
    旧い平置きも読めるようにしてあるので、GAS 側が古いままでも動く。
    """
    if isinstance(job.get('job'), dict):
        job = job['job']

    mode = str(job.get('mode') or 'A').upper()
    if mode not in ('A', 'B', 'T'):
        raise SystemExit('mode は A / B / T です: %r' % mode)

    w = int(job.get('width') or 1080)
    h = int(job.get('height') or 1920)
    fps = int(job.get('fps') or 30)
    # ★モードTは文字が主役なので、既定を一回り大きくする
    default_font = max(64, int(w * (0.13 if mode == 'T' else 0.10)))
    font_size = int(job.get('font_size') or default_font)
    clips = job.get('clips') or []
    seed = job.get('seed')

    """
    ★★2026-08-26、モードT（タイポグラフィ）を追加した。

    【なぜ要るか】
    Pexels/Pixabay の無料素材では、題材に噛み合う映像が手に入らない。
    実際に起きたこと：本文は「Riotのアーティストが手描きフレームに
    才能を注いでいる」で、映像は検索語 hand drawing lineart ink pen
    close up で拾った暗くてぼやけた手元。**題材とは一致している**のに、
    見て面白くない。オーナー評価は「出すくらいなら出さない方がマシ」。

    検索語を何度書き直しても同じ壁に当たった。無料ストックは
    「それっぽい別のもの」しか持っていない。素材を良くする方向は
    行き止まりだと判断した。

    【何をするか】
    素材を一切使わない。黒一色の背景に、本文を単語ごとに
    ポップさせて焼く。文字そのものを絵にする。

    build_ass() は既にカラオケ字幕（\\k で単語ごとに色替え、\\t で
    拡大）を出せるので、背景を差し替えるだけで成立する。
    新しく書くのは背景生成だけ。

    【この形が向いている理由】
    ・素材の質という変数が消える（ここが今までの最大の不確定要素だった）
    ・ミュート再生で完全に成立する
    ・GitHub Actions の CPU だけで作れる。追加費用0
    """
    if mode != 'T' and not clips:
        raise SystemExit('clips が空です。組み立てる素材がありません。')

    work = args.workdir or tempfile.mkdtemp(prefix='render_')
    os.makedirs(work, exist_ok=True)
    rng = random.Random(seed if seed is not None else os.urandom(8))

    log('モード %s / クリップ %d本' % (mode, len(clips)))

    # ------------------------------------------------------------------
    # モードA: 先に音声を作る。尺も字幕の時刻もここで決まる
    # ------------------------------------------------------------------
    audio_path = None
    captions = []
    target_seconds = 0.0

    if mode in ('A', 'T'):
        audio_path, captions, target_seconds = build_captions_from_tts(
            job.get('narration'), work, job.get('voice'))

        # ★TTSが使えない・単語が取れない時の予備。呼び出し側が用意した
        #   均等割りの字幕を使う。字幕が消えるより、少しずれても出す
        if not captions:
            captions = job.get('captions') or []
        if not target_seconds:
            target_seconds = max((float(c.get('end') or 0) for c in captions),
                                 default=0.0)
    else:
        # ★モードBは音声解析も字幕も一切行わない（オーナー指示）
        log('モードB: 音声解析と字幕付与は行いません。')

    # ------------------------------------------------------------------
    # モードT: 素材を使わない。背景をここで作って、下の連結を飛ばす
    # ------------------------------------------------------------------
    if mode == 'T':
        if not captions:
            raise SystemExit('モードTは字幕が本体です。narration か captions が要ります。')

        # 音声が無い回は字幕の終端が尺になる。最低でも3秒は見せる
        total = max(3.0, float(target_seconds or 0))

        """
        ★真っ黒ではなく、ごくわずかに明るい中心を作る。

        完全な #000000 は、多くの端末の黒背景UIと同化して
        「動画が読み込めていない」ように見える。ごく淡い放射状の
        グラデーションを敷くと、面として認識されて文字が締まる。
        vignette は計算が軽く、CPUだけのランナーでも負荷にならない。
        """
        bg = os.path.join(work, 'bg.mp4')
        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-f', 'lavfi',
             '-i', 'color=c=0x0d0d12:s=%dx%d:d=%.2f:r=%d' % (w, h, total, fps),
             '-vf', 'vignette=a=0.7,noise=alls=6:allf=t+u,format=yuv420p',
             '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
             bg])
        if not (os.path.exists(bg) and os.path.getsize(bg) > 1024):
            raise SystemExit('背景を作れませんでした。')

        log('モードT: 素材を使わず、%.1f秒の背景に字幕%d枚を焼きます。'
            % (total, len(captions)))
        parts = [bg]
        target = 1
    else:
        parts = None      # 下のクリップ処理で埋める

    # ------------------------------------------------------------------
    # クリップを切り出して揃える
    # ------------------------------------------------------------------
    want_each = float(job.get('clip_seconds') or 1.6)

    """
    ★★何本必要か（target）と、何本まで試すか（pool）を分ける。

    最初は「必要な本数だけ」を並べて回していた。すると
    モードAで音声が短い回に target=1 となり、その1本が死んでいるだけで
    「使えるクリップが1本もありません」で全体が落ちた（テストで発見）。
    素材CDNは普通に欠けるので、必ず予備を用意して回す。

    pool は必要数 + 手持ち全部。必要数に達したところで止めるので、
    全部が生きていれば余分なダウンロードは起きない。
    """
    # ★モードTは背景を作り終えているので、素材の取得は一切行わない
    if parts is None:
      if mode == 'A' and target_seconds > 0:
        """
        ★★2026-08-28、round() を切り上げへ直した。
          ナレーションが途中で切れる不具合の修正。

        【何が起きていたか】
        round() は半分の確率で切り捨てる。切り捨てると映像が音声より短くなり、
        仕上げの -shortest は「短い方」に合わせるので、
        **ナレーションが言い終わる前に動画が終わる。**

          ナレーション 9.0秒 / 1カット1.4秒
            round(9.0 / 1.4) = round(6.43) = 6カット = 8.40秒
            → 0.6秒ぶん、喋っている途中で切れる

        実際に8パターンで計算したところ5パターンで切れていた。頻度が高い。
        文の途中で切れる動画は、内容が良くても最後まで見てもらえない。

        【なぜ余裕も足すのか】
        MoneyPrinterTurbo が同じ問題に安全余裕で対処していた
        （_get_required_video_duration。「FFmpegはフレームレートの丸めで
        最終尺がわずかに短くなることがある」）。こちらも fps の丸めで
        数フレームぶん足りなくなり得るので、切り上げに加えて余裕を持たせる。
        余った映像は -shortest が音声に合わせて切るので、長い方へ倒すのが安全。
        """
        need = target_seconds + VIDEO_DURATION_SAFETY_MARGIN
        target = max(1, int(math.ceil(need / want_each)))
        log('音声 %.1f秒 に合わせて %d カット（映像 %.2f秒・余裕 %.1f秒込み）'
            % (target_seconds, target, target * want_each,
               VIDEO_DURATION_SAFETY_MARGIN))
      elif mode == 'B':
        target = len(clips)
      else:
        target = len(clips)

      order = list(clips)
      if mode == 'B':
        # ★ランダムに並べ替える。毎回同じ順だと「同じ動画」に見える
        rng.shuffle(order)

      # 必要数ぶん並べ、その後ろに予備として手持ちをもう一巡足す
      pool = [order[i % len(order)] for i in range(target)] + order

      parts = []
      for i, c in enumerate(pool):
          if len(parts) >= target:
              break
          url = c.get('url')
          if not url:
              continue
          src = os.path.join(work, 'src_%02d.mp4' % i)
          dst = os.path.join(work, 'part_%02d.mp4' % i)
          log('[%d/%d] %s' % (len(parts) + 1, target, str(url)[:110]))

          if not download(url, src):
              continue

          """
          ★小さすぎる素材はここで捨てる（2026-08-28追加）。

          1080x1920 へ引き伸ばせば形にはなるが、明らかにぼやける。
          プールに予備を積んであるので、1本捨てても次が使われる。
          静止画は Ken Burns で寄せるため、この足切りの対象にしない。
          """
          if not looks_like_image(url, src) and not resolution_is_acceptable(src):
              rw, rh = probe_resolution(src)
              log('  解像度が足りないので使いません（%dx%d < %d）'
                  % (rw, rh, MIN_MATERIAL_DIMENSION))
              try:
                  os.remove(src)
              except OSError:
                  pass
              continue

          if mode == 'B':
              # ★どこを切るかを毎回変える。頭から切ると静止画が並ぶ
              each = float(c.get('duration') or rng.uniform(1.0, 3.0))
              st, each = pick_cut_window(src, each, rng)
          else:
              st = float(c.get('start') or 0.5)
              each = float(c.get('duration') or want_each)

          try:
              if looks_like_image(url, src):
                  # ★静止画は動かしてから連結する（Ken Burns）
                  ok = still_to_clip(src, dst, each, w, h, fps, rng)
              else:
                  ok = normalize(src, dst, st, each, w, h, fps)
          except Exception as e:
              log('  変換に失敗（次のクリップへ）: %s' % e)
              ok = False
          if ok:
              parts.append(dst)
          try:
              os.remove(src)
          except OSError:
              pass

    # --- Abort ゲート -------------------------------------------------
    if not parts:
        raise SystemExit('使えるクリップが1本もありませんでした。')
    if mode == 'B' and len(parts) < 2:
        # ★1本だけならMADにならない。黙って出さない
        raise SystemExit('モードBは2本以上必要です（使えたのは %d本）。' % len(parts))

    log('使えたクリップ: %d 本（目標 %d）' % (len(parts), target))

    # --- 連結 ---
    # ★concat デマルチプレクサは、リスト内の相対パスを
    #   「リストファイルのある場所」から解決する。
    #   相対のまま書くと ./work/./work/part_00.mp4 を探して落ちる（実測）。
    listfile = os.path.join(work, 'concat.txt')
    with open(listfile, 'w', encoding='utf-8') as f:
        for p in parts:
            ap_ = os.path.abspath(p)
            f.write("file '%s'\n" % ap_.replace("'", "'\\''"))

    joined = os.path.join(work, 'joined.mp4')
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-f', 'concat', '-safe', '0', '-i', listfile,
         '-c', 'copy', joined])

    # ------------------------------------------------------------------
    # 仕上げ
    # ------------------------------------------------------------------
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', joined]

    """
    ★★BGM（2026-08-28追加）。

    無音、あるいは声だけの動画は、内容が良くても素人の作ったものに見える。
    MoneyPrinterTurbo は BGM をナレーションの 0.2 倍で重ね、終わりを
    3秒かけて絞っている。数字はそのまま参考にした（BGM_VOLUME /
    BGM_FADEOUT_SEC）。0.2 より上げるとナレーションが埋もれる。

    ★音源は同梱しない。あちらの resource/songs には29曲入っているが、
      コードのMITライセンスが音源にも及ぶとは限らず、確認できていない。
      **確認できない権利の素材を投稿に載せない**（PART 1 の方針と同じ）。
      使う音源は job の bgm で明示的に渡す。
    """
    bgm_path = None
    bgm_src = str(job.get('bgm') or '').strip()
    if bgm_src:
        if bgm_src.startswith(('http://', 'https://', 'file://')):
            cand = os.path.join(work, 'bgm_src')
            bgm_path = cand if download(bgm_src, cand) else None
            if not bgm_path:
                log('BGMを取得できませんでした（BGM無しで続行）: %s' % bgm_src[:80])
        elif os.path.exists(bgm_src):
            bgm_path = bgm_src
        else:
            log('BGMが見つかりません（BGM無しで続行）: %s' % bgm_src[:80])

    if audio_path:
        cmd += ['-i', audio_path]
    else:
        # ★無音でも音声トラックは付ける。音声ストリームが無い動画は
        #   プラットフォームによって扱いが不安定になるため。
        cmd += ['-f', 'lavfi', '-i',
                'anullsrc=channel_layout=stereo:sample_rate=44100']

    """
    ★BGMは本編より短いことがあるので、尽きたら頭から繰り返す
      （-stream_loop -1）。長い分は下の -shortest が切る。
    """
    if bgm_path:
        cmd += ['-stream_loop', '-1', '-i', bgm_path]

    cmd += ['-shortest']

    # --- 映像フィルタ（字幕）---
    # ★モードTは字幕そのものが本体。ここを 'A' で決め打ちにすると
    #   背景だけの真っ黒な動画が出る（実際に一度そうなった）
    if mode in ('A', 'T') and captions:
        assfile = os.path.join(work, 'caption.ass')
        with open(assfile, 'w', encoding='utf-8') as f:
            f.write(build_ass(captions, w, h, font_size, center=(mode == 'T')))
        cmd += ['-vf', 'ass=' + assfile.replace('\\', '/').replace(':', r'\:')]

    """
    ★音声フィルタ。BGMがある回だけ、2本を混ぜて1本にする。

      [1:a] ナレーション（または無音）
      [2:a] BGM … 音量を落とし、終わりをフェードアウトする

    amix の duration=first は「1本目（ナレーション）の長さで終える」。
    これを付けないと、繰り返し続けるBGM側に引きずられて終わらなくなる。
    normalize=0 は amix の自動音量調整を切る指定。切らないと
    混ぜた瞬間にナレーションの音量まで一緒に下がる。
    """
    if bgm_path:
        """
        ★フェードアウトを始める位置は「完成後の尺」から逆算する。
          -shortest が効くので、完成尺は映像と音声の短い方になる。
          どちらかが取れない時はフェードを諦める（BGMは重ねる）。
        """
        vid_len = probe_duration(joined)
        aud_len = float(target_seconds or 0)
        lens = [x for x in (vid_len, aud_len) if x and x > 0]
        final_len = min(lens) if lens else 0.0
        fade_start = max(0.0, final_len - BGM_FADEOUT_SEC)
        bgm_chain = 'volume=%.2f' % BGM_VOLUME
        if fade_start > 0:
            bgm_chain += ',afade=t=out:st=%.2f:d=%.2f' % (
                fade_start, BGM_FADEOUT_SEC)
        cmd += ['-filter_complex',
                '[2:a]%s[bgm];[1:a][bgm]amix=inputs=2:duration=first:normalize=0[aout]'
                % bgm_chain,
                '-map', '0:v', '-map', '[aout]']
        log('BGMを重ねます（音量 %.2f / 終わり %.1f秒でフェードアウト）'
            % (BGM_VOLUME, BGM_FADEOUT_SEC))

    cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-c:a', 'aac', '-b:a', '96k', args.out]
    run(cmd)

    # --- 出来上がりを検品する ---
    if not os.path.exists(args.out):
        raise SystemExit('出力が作られませんでした。')
    size = os.path.getsize(args.out)
    if size < 10 * 1024:
        raise SystemExit('出力が小さすぎます（%dB）。壊れています。' % size)

    dur = probe_duration(args.out)
    if dur < 1.0:
        raise SystemExit('出力が短すぎます（%.2f秒）。' % dur)

    log('完成: %s (%.1f MB / %.1f秒 / モード%s / 字幕%d枚)'
        % (args.out, size / 1024 / 1024, dur, mode, len(captions)))

    gh_out = os.environ.get('GITHUB_OUTPUT')
    if gh_out:
        with open(gh_out, 'a', encoding='utf-8') as f:
            f.write('bytes=%d\n' % size)
            f.write('seconds=%.1f\n' % dur)
            f.write('clips_used=%d\n' % len(parts))
            f.write('mode=%s\n' % mode)


if __name__ == '__main__':
    main()
