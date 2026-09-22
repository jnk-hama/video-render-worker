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
import io
import json
import math
import os
import random
import re
import shlex
import shutil
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

"""
★★効果音（2026-09-03）。

【なぜ自前で作った音を同梱するか】
外部の音源サイトから落とすと、ライセンス確認が毎回発生し、
配布元が消えれば描画が止まる。ffmpeg の合成音（サイン波・ピンクノイズ）で
作れば **第三者の権利が最初から無い**。生成コマンドは
assets/sfx/README.md に残してあるので、いつでも作り直せる。

【音量】
ピークを -6dB へ揃えてある。ここで倍率を掛けるだけで狙った大きさになる。
0.35 より上げるとナレーションの語頭を食う（BGMの 0.2 と同じ考え方）。
"""
SFX_VOLUME = 0.35
SFX_DIR_NAME = 'sfx'
# 台本の fx タグと同じ名前にする。新しい出力項目をGeminiに足さないため
SFX_TAGS = ('fire', 'neon', 'pop', 'shock', 'clean')

# ------------------------------------------------------------------
# 前景合成（決定#087）。透過した商品画像を背景動画へ直接重ねる。
#
# ★この工程は「素材の利用許諾が済んでいる」ことを前提に動く。
#   許諾の判断は上流（依頼を組み立てる側）で完結させる取り決めで、
#   ここでは条件を付けずに渡された素材をそのまま処理する。
# ------------------------------------------------------------------
FG_WIDTH_RATIO = 0.62      # 画面幅に対する前景の幅
FG_HEIGHT_RATIO = 0.42     # 画面高に対する前景の高さ（縦長の商品はこちらで決まる）
FG_Y_RATIO = 0.44          # 前景の中心を画面のどこに置くか（0=上, 1=下）
FG_ZOOM = 0.10             # 尺全体で何割ゆっくり拡大するか
FG_SWAY_PX = 18            # 上下に揺れる幅（片側）
FG_SWAY_SEC = 5.0          # 揺れの周期
FG_SHADOW_ALPHA = 0.55     # 影の濃さ
FG_SHADOW_BLUR = 30        # 影のぼかし半径
FG_SHADOW_DROP = 34        # 影を下へずらす量


def has_alpha(path):
    """
    その画像がアルファ面を持っているか。

    ★持っていない画像に alphaextract を掛けると
      "Requested planes not available" でフィルタ構築ごと落ちる（実測）。
      掛ける前に必ず確かめる。
    """
    try:
        p = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', path],
            capture_output=True, text=True, timeout=20)
        pix = (p.stdout or '').strip().lower()
    except Exception:
        return False
    # rgba / bgra / yuva420p / pal8 など。pal8 は透過色を持ち得る
    if not (('a' in pix.replace('yuv', '').replace('gbr', '')) or pix == 'pal8'):
        return False

    """
    ★★2026-09-04、ここで**実際に透明な画素があるか**まで確かめる。

    【何が起きたか（実測）】
    商品画像は RGBA で保存されていても、アルファが全面255
    （＝完全に不透明）のことがある。「アルファ面がある＝抜き済み」と
    判断すると背景を抜く工程を飛ばし、**背景の四角がそのまま動画に乗る**。
    実際に nova-pulse.png で四角い箱が映った（アルファのYMIN=255）。

    アルファの最小値を見れば一発で分かる。255なら透明な画素は1つも無い。
    """
    try:
        p = subprocess.run(
            ['ffmpeg', '-hide_banner', '-loglevel', 'info', '-y', '-i', path,
             '-vf', 'format=rgba,alphaextract,signalstats,'
                    'metadata=print:key=lavfi.signalstats.YMIN',
             '-f', 'null', '-'],
            capture_output=True, text=True, timeout=60)
        m = re.findall(r'YMIN=(\d+)', p.stderr or '')
        if not m:
            return True          # 測れないなら抜き済みとして扱う（従来の挙動）
        return int(m[-1]) < 250  # 完全に不透明なら「抜き済み」ではない
    except Exception:
        return True


def probe_size(path):
    """幅と高さ。測れなければ (None, None)。"""
    try:
        p = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x',
             path], capture_output=True, text=True, timeout=20)
        w, h = (p.stdout or '').strip().split('x')[:2]
        return int(w), int(h)
    except Exception:
        return None, None


def trim_alpha(path):
    """
    透明な余白を詰める。詰められたら True。

    【なぜ要るか（実測）】
    ASPの商品画像は商品の周りに大きな白い余白があることが多い。背景を抜くと
    その余白は「透明」として残り、そのまま枠へ収めると**余白ごと縮められて
    商品が痩せる**。実測では画面の24%しか占めず、参考にした動画
    （商品が主役）とは別物の絵になった。

    【やり方】
    アルファ面を白黒画像として取り出し、cropdetect に黒縁として測らせる。
    PIL や numpy を足さずに ffmpeg だけで完結する。

    ★測れない・結果が不自然な場合は何もしない。詰められなくても動画は
      成立するので、ここで落とさない。
    """
    try:
        p = subprocess.run(
            ['ffmpeg', '-hide_banner', '-loglevel', 'info', '-y',
             '-loop', '1', '-i', path, '-t', '0.3', '-r', '10',
             '-vf', 'format=rgba,alphaextract,'
                    'cropdetect=limit=0.02:round=2:reset=0',
             '-f', 'null', '-'],
            capture_output=True, text=True, timeout=60)
    except Exception as e:
        log('  余白を測れませんでした（そのまま使います）: %s' % str(e)[:80])
        return False

    found = re.findall(r'crop=(\d+):(\d+):(\d+):(\d+)', p.stderr or '')
    if not found:
        return False
    cw, chh, cx, cy = (int(v) for v in found[-1])
    if cw < 16 or chh < 16:
        log('  余白の判定が不自然（%dx%d）。そのまま使います。' % (cw, chh))
        return False

    src_w, src_h = probe_size(path)
    if src_w and src_h and cw >= src_w - 2 and chh >= src_h - 2:
        return False                      # 詰める余白が無い

    tmp = path + '.trim.png'
    try:
        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-i', path, '-vf', 'crop=%d:%d:%d:%d' % (cw, chh, cx, cy),
             '-frames:v', '1', tmp])
    except Exception as e:
        log('  余白を詰められませんでした（そのまま使います）: %s' % str(e)[:80])
        return False

    if os.path.exists(tmp) and os.path.getsize(tmp) > 512:
        os.replace(tmp, path)
        log('  余白を詰めました: %sx%s → %dx%d' % (src_w, src_h, cw, chh))
        return True
    return False


def prepare_foreground(src, dest):
    """
    前景を「アルファ付きPNG」に揃える。

    既に透過済みなら何もしない。透過していなければ cutout.py で背景を抜く
    （rembg。使えない回は自前の領域成長へ降りる。cutout.py 側の設計）。

    ★抜けなかった場合は False を返し、呼び出し側は前景の合成を丸ごと
      諦めて動画自体は出す。**1枚の素材の失敗で動画を落とさない。**
      素材CDNの一時障害で毎回失敗するようになるため（download() と同じ方針）。
    """
    if has_alpha(src):
        shutil.copyfile(src, dest)
        trim_alpha(dest)          # 透過済みの素材にも余白はある
        return True

    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from cutout import cutout
        info = cutout(src, dest)
        if os.path.exists(dest) and os.path.getsize(dest) > 1024:
            log('  背景を抜きました（方式 %s）' % info.get('method', '不明'))
            trim_alpha(dest)      # 抜いた後に残る透明の余白を詰める
            return True
        log('  背景を抜けませんでした。前景の合成は行いません。')
    except Exception as e:
        log('  背景を抜く処理に失敗（前景なしで続行）: %s' % str(e)[:120])
    return False


def foreground_filter(w, h, fps, seconds, spec):
    """
    前景（透過PNG）を背景動画の上へ重ねる filter_complex を組み立てる。

    【なぜ影を別レイヤーにするか（実測して直した）】
    影を焼いた1枚のPNGを作ってから重ねる書き方は**使えない**。
    overlay は「下地を不透明として扱う」ため、透過画像の上へ重ねると
    下地（＝影）のアルファが 255 に潰れ、影が黒い塊になる。
    背景動画（不透明）の上で、影 → 前景 の順に別々に重ねる。

    【なぜ枝ごとに format=rgba を書くか（実測して直した）】
    scale や split を通るとアルファ面の指定が落ちることがあり、
    alphaextract が "Requested planes not available" で落ちる。
    枝の入口で毎回 rgba を宣言する。冗長に見えるが、ここは冗長にする。

    【動き】
    ・zoompan で尺全体をかけて FG_ZOOM ぶんゆっくり拡大する
    ・overlay の y に sin を入れて上下に漂わせる
    静止画のまま貼ると「画像を貼っただけ」に見えるうえ、
    フレーム間の差分が無くなる。
    """
    """
    ★枠は「幅」と「高さ」の両方で決める。

    正方形に収める作りにすると、縦長の商品（ボトル・スプレー等）が
    幅ではなく高さで頭打ちになり、画面の2割しか占めない痩せた絵になる。
    実際にそうなったので直した。幅 fw × 高さ fh の枠に収めれば、
    横長は幅で、縦長は高さで決まる。
    """
    fw = int(w * float(spec.get('width_ratio') or FG_WIDTH_RATIO))
    fw -= fw % 2                                   # 偶数に揃える
    fh = int(h * float(spec.get('height_ratio') or FG_HEIGHT_RATIO))
    fh -= fh % 2
    y_ratio = float(spec.get('y_ratio') or FG_Y_RATIO)
    zoom = float(spec.get('zoom') if spec.get('zoom') is not None else FG_ZOOM)
    sway = float(spec.get('sway_px') if spec.get('sway_px') is not None
                 else FG_SWAY_PX)
    period = float(spec.get('sway_sec') or FG_SWAY_SEC)
    shadow_on = spec.get('shadow') is not False    # 既定は付ける

    frames = max(2, int(round(seconds * fps)))
    # ★1フレームあたりの増分から出す。d を尺に合わせないと
    #   途中で拡大が止まり、残りが静止画になる
    step = zoom / frames
    zexpr = "min(zoom+%.6f,%.4f)" % (step, 1.0 + zoom)

    """
    ★商品そのものを切り取らせない作り。

    zoompan は出力サイズを固定したまま寄るので、素直に掛けると
    拡大した分だけ**商品の端が画面外へ出る**。
    そこで、商品を目標幅 fw に収めたうえで、周囲に透明な余白を足して
    枠より一回り大きい canvas にしておく。寄ると最初に食われるのは余白で、
    z が上限に達した時に商品がちょうど収まりきる。
    見かけの大きさは fw/(1+zoom) → fw へ、zoom ぶん大きくなる。
    """
    cw = int(fw * (1.0 + zoom)) + 2
    cw -= cw % 2
    ch = int(fh * (1.0 + zoom)) + 2
    ch -= ch % 2

    y_center = "(%.4f*H-h/2)" % y_ratio
    sway_expr = "" if sway <= 0 else "+%.1f*sin(2*PI*t/%.3f)" % (sway, period)

    # 枠に収めてから、寄る余地ぶんの透明な余白を足す
    fit = ("[1:v]format=rgba,"
           "scale=%d:%d:force_original_aspect_ratio=decrease,"
           "pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=0x00000000,"
           "setsar=1,format=rgba" % (fw, fh, cw, ch))

    chains = [
        fit + (",split=3[fgbase][shcol_in][shalpha_in]"
               if shadow_on else "[fgbase]")
    ]

    if shadow_on:
        chains += [
            # 影の色（真っ黒）。アルファは捨てて色面だけ作る
            "[shcol_in]format=rgba,lut=r=0:g=0:b=0,format=rgb24[shcol]",
            # 影の形（元のアルファをぼかしたもの）
            "[shalpha_in]format=rgba,alphaextract,boxblur=%d:2,format=gray[shalpha]"
            % FG_SHADOW_BLUR,
            "[shcol][shalpha]alphamerge,colorchannelmixer=aa=%.2f,format=rgba,"
            "zoompan=z='%s':d=%d:s=%dx%d:fps=%d,format=rgba[shadow]"
            % (FG_SHADOW_ALPHA, zexpr, frames, cw, ch, fps),
        ]

    chains.append(
        "[fgbase]zoompan=z='%s':d=%d:s=%dx%d:fps=%d,format=rgba[fg]"
        % (zexpr, frames, cw, ch, fps))

    if shadow_on:
        chains.append(
            "[0:v][shadow]overlay=x='(W-w)/2':y='%s+%d%s':format=auto[withshadow]"
            % (y_center, FG_SHADOW_DROP, sway_expr))
        base = "[withshadow]"
    else:
        base = "[0:v]"

    chains.append(
        "%s[fg]overlay=x='(W-w)/2':y='%s%s':format=auto:shortest=1,"
        "format=yuv420p[v]" % (base, y_center, sway_expr))

    return ';'.join(chains)


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


def download(url, dest, market=None):
    """
    1本落とす。失敗しても例外にしない（呼び出し側が次のクリップへ進む）。

    ★1本の欠損で動画ごと落とすと、素材CDNの一時障害で毎回失敗する。

    ★★2026-08-31、リポジトリ同梱の素材を使えるようにした。
      スキームの無いパス（'assets/demo/x.png' など）は、このリポジトリの
      中を指しているものとして解決する。

      【なぜ要るか】
      ロゴ・イントロ・商品画像のように「毎回同じものを使う素材」は、
      外部から毎回落とす理由が無い。同梱すれば外部が落ちても描画が
      止まらず、通信も減る。フォントを同梱したのと同じ考え方。

      ★リポジトリの外は指させない。'../' で外へ出る指定は弾く。
        描画ジョブは外から来るので、パスをそのまま信用しない。
    """
    if '://' not in str(url):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        rel = str(url).lstrip('/')
        src = os.path.normpath(os.path.join(root, rel))
        if not src.startswith(root + os.sep):
            log('  リポジトリの外を指しています（使いません）: %s' % url)
            return False

        """
        ★★2026-09-04、部門をまたいだ素材を**描かずに落とす**（決定#082）。

        assets/en/ の映像がBライン（日本語）の動画に混ざる事故を、
        注意ではなく構造で潰す。ここは「使わずに次のクリップへ」ではなく
        **例外で止める**。黙って別の映像に差し替わる方が危険で、
        出来上がった動画を見るまで誰も気づかないため。
        """
        if market:
            for other in MARKETS:
                if other == market:
                    continue
                if rel.startswith('assets/%s/' % other):
                    raise SystemExit(
                        '部門をまたいだ素材が指定されました（描画を中止）。\n'
                        '  依頼の市場: %s / 素材: %s\n'
                        '  assets/%s/ は %s ライン専用です。'
                        '両部門で使うものは assets/shared/ に置いてください。'
                        % (market, rel, other, other))

        if not os.path.exists(src):
            log('  同梱素材が見つかりません: %s' % url)
            return False
        try:
            shutil.copyfile(src, dest)
        except Exception as e:
            log('  同梱素材を読めません: %s' % e)
            return False
        return os.path.getsize(dest) > 1024

    """
    ★★2026-09-03、セキュリティ点検で3点足した。

    (1) --proto / --proto-redir で http(s) 以外を落とす。
        curl は file:// も gopher:// も喋る。素材URLは依頼者が決めるが、
        依頼の中身は外部（Supabase / GAS）で組み立てられるので、
        `file:///etc/passwd` のような指定が通る余地を残さない。
        転送先（-L の飛び先）にも同じ制限を掛ける。

    (2) URLの前に `--` を置く。`-o /path` のような**URLに見せかけた
        オプション**を渡されると、curl はそれをオプションとして解釈する
        （引数の注入）。`--` 以降は必ずURLとして扱われる。

    (3) 素材の置き場所は外部の公開サーバーなので、これで機能は落ちない。
    """
    try:
        run(['curl', '-sSL', '--fail',
             '--proto', '=https,http',
             '--proto-redir', '=https,http',
             '--max-time', str(DOWNLOAD_TIMEOUT_SEC),
             '--max-filesize', str(MAX_DOWNLOAD_BYTES),
             '-o', dest, '--', url])
    except Exception as e:
        log('  取得できませんでした（次のクリップへ）: %s' % e)
        return False
    return os.path.exists(dest) and os.path.getsize(dest) > 1024


def resolve_sfx(cues, total_seconds):
    """
    効果音の指定を「ファイルと鳴らす秒数」の並びへ直す。

    受け付ける形（1件ぶん）:
      {"tag": "pop", "at": 1.2}        … 秒で指定
      {"tag": "pop", "at_ratio": 0.35} … 全体の尺に対する割合で指定

    ★なぜ割合を受けるか：依頼側（Supabase）は**音声の尺を知らない**。
      尺が決まるのはTTSを実行するこちら側なので、依頼側は
      「台本の何文字目あたり」を割合として渡し、秒への変換はここでやる。
      これなら依頼側に推定を書かせずに済む（推定値を持ち込まない）。

    @return [(パス, 秒), ...]。鳴らせないものは黙って落とす
    """
    if not cues:
        return []
    here = os.path.dirname(os.path.abspath(__file__))
    sfx_dir = os.path.join(os.path.dirname(here), 'assets', SHARED_DIR, SFX_DIR_NAME)
    out = []
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        tag = str(cue.get('tag') or '').strip().lower()
        if tag not in SFX_TAGS:
            log('  知らない効果音タグなので飛ばします: %r' % tag)
            continue
        path = os.path.join(sfx_dir, tag + '.mp3')
        if not os.path.exists(path):
            log('  効果音が見つかりません: %s' % path)
            continue

        if cue.get('at') is not None:
            at = float(cue.get('at') or 0)
        else:
            at = float(cue.get('at_ratio') or 0) * float(total_seconds or 0)

        # 尺の外へ置くと ffmpeg は黙って捨てる。手前へ寄せる
        if total_seconds and at > total_seconds - 0.3:
            at = max(0.0, total_seconds - 0.3)
        out.append((path, max(0.0, at)))

    # 同じ瞬間に何本も重ねない（音が濁るだけで、意味が増えない）
    out.sort(key=lambda x: x[1])
    kept = []
    for path, at in out:
        if kept and at - kept[-1][1] < 0.25:
            continue
        kept.append((path, at))
    return kept


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


def normalize(src, dest, start, duration, w, h, fps, dim=False):
    """
    1クリップを「指定秒数・9:16・同一規格」に揃える。

    ★連結の前に必ず揃える。解像度やfpsが違うまま concat すると、
      音ズレや再エンコード失敗の原因になる。

    scale=increase → crop で、横長素材を縦型に切り出す（余白を作らない）。
    """
    vf = (
        'scale={w}:{h}:force_original_aspect_ratio=increase,'
        'crop={w}:{h},{dim}setsar=1,fps={fps},format=yuv420p'
    ).format(w=w, h=h, fps=fps, dim=dim_filter(dim))

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


def still_to_clip(src, dest, duration, w, h, fps, rng, dim=False):
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
        'crop={bw}:{bh},{dim}'
        "zoompan=z='{z}':d={d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        ':s={w}x{h}:fps={fps},setsar=1,format=yuv420p'
    ).format(bw=big_w, bh=big_h, z=z, d=frames, w=w, h=h, fps=fps,
             dim=dim_filter(dim))

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


"""
★★2026-08-28、フォントを Anton へ変更し、文字幅の比率を測り直した。

【なぜ変えたか】
DejaVu Sans は Linux の標準フォントで、機能はするが縦型ショート動画の
字幕としては幅を取りすぎる。Anton は縦長・高ウェイトで、この用途の
定番。同じ文字数が **6割の幅** に収まるので、同じ画面に大きく出せる。

【比率を測り直した理由（ここが重要）】
CHAR_WIDTH_RATIO は fit_caption が「何文字で折るか」を決める唯一の根拠。
フォントを変えたのに比率を変えないと、折る位置がずれて画面からはみ出す。

実測（同じ文字列 "HAD NO BUSINESS" 15文字をサイズ110で描画し、
白画素の左端と右端から実幅を測った）:

    DejaVu Sans Bold   1127px → 0.683
    Archivo             999px → 0.605
    Anton               698px → 0.423   ← 採用

★旧コードは 0.60 を使っていたが、DejaVu の実測は 0.683 だった。
  11文字を size140 で出すと、実際の描画は 1004px。
  使える幅として想定していた 960px を超え、左右の余白が
  60px の想定に対し 37〜39px しか残っていなかった（実測）。
  画面外には出ていなかったが、根拠のない数字で動いていた。

はみ出す側の失敗の方が痛いので、実測値に少し余裕を足して使う。
"""

# 字幕に使うフォント。ワークフローが google/fonts から取得して置く。
# ★google/fonts のリポジトリは 3.3GB あるので clone しない。
#   必要な1ファイルだけ raw から取る（Anton は 168KB）。
CAPTION_FONT_NAME = 'Anton'
CAPTION_FONT_FILE = 'Anton-Regular.ttf'
CAPTION_FONT_URL = ('https://raw.githubusercontent.com/google/fonts/main/'
                    'ofl/anton/Anton-Regular.ttf')

# 1文字あたりの幅 ÷ フォントサイズ。上の実測値に余裕を足したもの。
CHAR_WIDTH_RATIO = 0.45          # Anton（実測 0.423）
CHAR_WIDTH_RATIO_FALLBACK = 0.70  # DejaVu（実測 0.683）

"""
★★2026-09-02、日本語の字幕（jmas-ai-os 側＝日本市場の部署）。

Anton は欧文専用で、日本語を渡すと全部が豆腐（□）になる。
日本語の回だけ Dela Gothic One（SIL OFL）へ切り替える。

【なぜ Dela Gothic One か】
 ・極太の1ウェイト静的フォント。TikTok の物販動画で主流の「太ゴシック」
 ・google/fonts に静的 TTF が1本だけある（2.5MB）。漢字 7,654 字
   （fontTools で数えた。JIS第1・第2水準を覆う）
 ・Noto Sans JP は google/fonts に可変フォントしか無く、libass は
   既定インスタンス（Thin＝100）で描く。細すぎて字幕にならない
   （実際に描いて確認）。静的の Black を出す公式配布が raw では 404。

【幅】全角は 1文字≒1em。半角英数が混じると縮む。字幕は1枚ずつ
      measure_char_ratio で実測するので、ここの値は測れない時の予備。
"""
"""
★★2026-09-04、部門ごとに素材を分けた（決定#082）。

【なぜ】
Pexelsが素材を返さなかった時のフォールバックが、Aライン（英語圏・
AIモデル）の映像を指していた。日本語の商品紹介動画にそれが出る形で、
実際に一度そうなりかけた。「気をつける」では防げないので、
**置き場所で分ける**。

    assets/shared/ … 両部門（bgm / sfx / 逃げ場の映像）
    assets/en/     … Aライン専用（Anton / アンナ / 検証用クリップ）
    assets/ja/     … Bライン専用（Dela Gothic One）

依頼の target_market と違う側のディレクトリを指したら、
**描かずに落とす**（download() 内で検査）。取り違えを構造で潰す。
"""
MARKETS = ('ja', 'en')
SHARED_DIR = 'shared'

CAPTION_FONT_JA_NAME = 'Dela Gothic One'
CAPTION_FONT_JA_FILE = 'DelaGothicOne-Regular.ttf'
CHAR_WIDTH_RATIO_JA = 1.05

# 字幕は最大2行まで。3行以上は映像を隠しすぎる
MAX_CAPTION_LINES = 2

"""
★★安全領域（2026-09-03）。

【なぜ要るか】
SNSのUIは動画の**上に重なって表示される**。今までの置き方を実測したところ、
1080x1920 で字幕が x 46〜1007 / y 1382〜1471 に描かれていた。
TikTokの縦画面では、右端のアイコン列（いいね・コメント・共有・音源）と
下部の本文・音源テロップがこの範囲に重なる。つまり**字幕の右端が
アイコンに隠れる**。広告表記も y 139〜174 にあり、上部の検索・タブと重なる。

【数字の出どころ】
UI各部の占有範囲は、TikTokが公開している安全領域の指針に基づく
（右 140px / 下 320px / 上 160px を目安に、余裕を足した）。
★この数値は公式の指針を私の記憶から書いたもので、**この環境からは
  公式ページへ到達できず再確認していない**（推定ではないが、未再確認）。
  実機のスクリーンショットに重ねて詰めるのが確実。

【なぜ中央からずらすか】
右だけ広く空けるので、中心も左へ動かさないと文字が右へ寄る。
中心 = (左余白 + (幅 - 右余白)) / 2。
"""
SAFE_AREAS = {
    # 何も指定しない回。従来どおり（英語圏部門のXはUIの重なりが浅い）
    'none':   {'left': 60, 'right': 60,  'caption_y': 0.74, 'note_y': 0.062},
    # TikTok / リール系。右のアイコン列と下部テロップを避ける
    'tiktok': {'left': 60, 'right': 200, 'caption_y': 0.60, 'note_y': 0.105},
}

# 広告表記の大きさ（字幕の基準サイズに対する比）。実測して決めた値。
#   0.26 → 字高16px（読めない）
#   0.65 → 字高38px（字幕120pxの約1/3。読めて邪魔にならない）
NOTE_SIZE_RATIO = 0.65

"""
★★2026-08-31、背景を沈める加工。既定では掛けない（送られた回だけ）。

【なぜ要るか】
映像の上に白い字を乗せると、背景が明るい所で字が読めなくなる。

【何が効いているかを実測した（ここが重要）】
字幕が乗る帯（下1/4）の輝度を、3種類の画像で測った。

                        平均輝度      ばらつき
  加工なし                 基準          基準
  ぼかすだけ boxblur=12    -0%          -2〜-5%   ← ほぼ効かない
  暗くするだけ             -47〜-71%     -4〜-36%
  ぼかす＋暗く             -47〜-71%     -6〜-41%

**ぼかしは輝度のばらつきをほとんd下げない。効いているのは暗くする方。**
「boxblurで高級感を出す」という説明をよく見るが、読みやすさへの寄与は
測る限り暗くする処理が担っている。ぼかしは競合する細部を消す効果が
あるはずだが、輝度統計には現れない。**測れない効果を根拠にしない。**

【コスト】
1カット3秒の書き出しで 2.07秒 → 1.43秒。**加工した方が速い。**
暗くしてぼかすと細部が減り、x264の符号化が軽くなるため。
フィルタの計算量を上回って得をする。だから両方入れて構わない。

【掛けてはいけない場合（実際に描いて気づいた）】
**商品画像には掛けない。** 商品動画では商品そのものが主役なので、
ぼかすと主役がぼやける。架空商品で実際に掛けてみたところ、商品の輪郭も
一緒に沈んだ。これは「文字の後ろに敷く一般的なB-roll」を沈めるための
機能であって、被写体が主役の回には使わない。
既定で掛けないのはそのため。送る側が用途を判断すること。
"""
DIM_BLUR = 12          # boxblur の半径
DIM_BRIGHTNESS = -0.12  # eq の brightness
DIM_SATURATION = 0.85   # 少しだけ彩度を落とす。字の色を目立たせるため


def dim_filter(enabled):
    """
    背景を沈めるフィルタ列を返す。掛けない時は空文字。

    @param enabled False / True（ぼかし＋暗く） / 'dark'（暗くするだけ）

    ★★2026-09-03、'dark' を足した。

    【なぜ分けるか】
    #066 で実測したとおり、字幕の読みやすさに効いているのは
    **暗くすること**で、ぼかしはほぼ効いていない。一方ぼかしは
    エンコード時間を確実に食う（GitHub Actionsの無料枠2,000分/月に効く）。

    さらに日本部門の映像は**背景そのものが主役**（商品を使っている場面）
    なので、ぼかすと見せたいものが見えなくなる。読みやすさは黒縁と
    暗さで足りているため、既定を 'dark' にできるようにした。
    """
    if not enabled:
        return ''
    chain = ''
    if enabled is not True and str(enabled).lower() != 'blur':
        # 'dark' 等：暗くするだけ
        return 'eq=brightness=%.2f:saturation=%.2f,' % (DIM_BRIGHTNESS, DIM_SATURATION)
    return ('boxblur=%d:2,eq=brightness=%.2f:saturation=%.2f,'
            % (DIM_BLUR, DIM_BRIGHTNESS, DIM_SATURATION))

# 字幕の黒縁の太さ。明るい映像の上で文字を読ませるために要る。
# ★幅の計算に効く。縁は文字の左右へこの分だけはみ出すので、
#   使える幅から左右2本ぶん引いておかないと余白がその分だけ痩せる
#   （実測：引く前は狙い60pxに対し42pxしか残らなかった）。
CAPTION_OUTLINE = 7


def hex_to_ass(value, alpha=0x00):
    """
    '#rrggbb' を ASS の色表記へ変換する。読めなければ None。

    ★★ASSの色は &HAABBGGRR。**BGRの順で、RGBではない。**
      #8b5cf6（紫）をRGBのまま &H008B5CF6 と書くと、libassは
      B=8b G=5c R=f6 と読んで **水色** で描く。
      色が違って出るだけでエラーは出ないので、気づけない類の間違い。
      だからここは単体テストを先に書いてから実装した。

    ★AA は透明度。0x00 が不透明、値が大きいほど透ける
      （ASSはこの向き。CSSの opacity とは逆）。

    @return {?string} '&HAABBGGRR' 形式。読めない入力は None
    """
    if not isinstance(value, str):
        return None
    h = value.strip().lstrip('#')
    if len(h) != 6:
        return None
    try:
        r = int(h[0:2], 16)
        g = int(h[2:4], 16)
        b = int(h[4:6], 16)
    except ValueError:
        return None
    return '&H%02X%02X%02X%02X' % (alpha & 0xFF, b, g, r)


def hex_to_ffmpeg(value):
    """
    '#rrggbb' を ffmpeg の color= 用へ変換する。読めなければ None。

    ★こちらは **RGBのまま**（0xRRGGBB）。ASSと逆なので混ぜないこと。
    """
    if not isinstance(value, str):
        return None
    h = value.strip().lstrip('#')
    if len(h) != 6:
        return None
    try:
        int(h, 16)
    except ValueError:
        return None
    return '0x' + h.lower()


def build_theme(tokens, highlight_words):
    """
    design_tokens と強調語の一覧から、描画に使う色一式を作る。

    ★★2026-08-29、Semantic Highlighting のために足した。

    【なぜ「1語だけ色を変える」のか】
    全部の文字を同じ強さで出すと、視聴者はどこを読めばよいか分からない。
    1文につき最も効く1語だけ色を変えると、その語が先に目に入る。

    【なぜ本文色と離れた色でないと効かないのか（実測）】
    背景 #09090b に対するコントラスト比と、本文 #f4f4f5 に対する比:

        #38bdf8 Sky   … 対背景 9.29 / 対本文 1.95
        #a3e635 Lime  … 対背景13.19 / 対本文 1.37
        #8b5cf6 Violet… 対背景 4.70 / 対本文 3.85  ← 採用
        #3b82f6 Blue  … 対背景 5.41 / 対本文 3.35

    背景に対して明るいだけの色は、隣の本文（オフホワイト）と同化して
    **強調にならない**。離すべき相手は背景ではなく本文の方である。

    @return {?dict} 使わない時は None（呼び出し側は現行の黄/白のまま）
    """
    tokens = tokens if isinstance(tokens, dict) else {}
    text = hex_to_ass(tokens.get('text_color_hex'))
    accent = hex_to_ass(tokens.get('accent_color_hex'))
    if not text and not accent:
        return None

    """
    ★塗られる前は同じ色を薄くして出す。別の色にすると、カラオケが
      「色が変わる」ではなく「別物に入れ替わる」ように見える。
    """
    dim = 0x80
    return {
        'primary': text,
        'secondary': hex_to_ass(tokens.get('text_color_hex'), dim) if text else None,
        'accent': accent,
        'accent_dim': hex_to_ass(tokens.get('accent_color_hex'), dim) if accent else None,
        'words': set(normalize_word(w) for w in (highlight_words or [])
                     if normalize_word(w)),
        # ★日本語は語の中に埋まって来るので、位置を取るために原文も持つ
        'words_raw': [str(w).strip() for w in (highlight_words or []) if str(w).strip()],
    }


def normalize_word(w):
    """
    強調語の照合用に、記号を落として小文字へ揃える。

    ★字幕は wd.upper() で描くので、そのままでは一致しない。
      また "answer." のように句点が付くため、記号も落とす必要がある。
    """
    # ★日本語の文字は残す。消すと強調語が空文字になり、一致しなくなる
    return re.sub(r'[^0-9A-Za-z\u3040-\u30ff\u3400-\u9fff]', '', str(w or '')).lower()


def resolve_market(job, sample_text):
    """
    この依頼がどちらの部門のものかを決める。

    @return 'ja' | 'en'

    ★★2026-09-04（決定#082）。

    【なぜ未指定を即エラーにしないか】
    英語圏部門（GAS）は現在このフラグを送っていない。ここで落とすと、
    描画側を更新した瞬間に**Aラインが全部止まる**。デプロイの順番で
    壊れる設計は、既に2度踏んでいる（#076のcron、#079のYAML）。

    したがって当面は:
      ・指定あり  … その値を使う。不正な値なら**落とす**（呼び出し側のバグ）
      ・指定なし  … 本文の文字種から推定し、警告を出す
      ・指定と中身が食い違う … **落とす**（取り違えの本体はこれ）

    ★依頼側（GAS / Supabase）の両方が送るようになったら、
      「指定なし」も落とす側へ倒す。切り替え条件は assets/NOTES.md に書いた。
    """
    given = str(job.get('target_market') or '').strip().lower()
    inferred = 'ja' if has_cjk(sample_text) else 'en'

    if not given:
        log('★target_market が未指定です。本文から %s と判断しました。'
            '（依頼側で明示してください）' % inferred)
        return inferred

    if given not in MARKETS:
        raise SystemExit('target_market が不正です: %r（%s のいずれか）'
                         % (given, ' / '.join(MARKETS)))

    if given != inferred:
        raise SystemExit(
            '依頼の市場と本文の言語が食い違っています（描画を中止）。\n'
            '  target_market=%s ですが、本文は %s に見えます。\n'
            '  取り違えたまま描くと、別部門のアカウントへ出す動画になります。'
            % (given, inferred))
    return given


def has_cjk(text):
    """日本語（ひらがな・カタカナ・漢字）を含むか。字幕のフォントと
    語の連結（空白を入れるか）をこれで切り替える。"""
    return re.search(r'[\u3040-\u30ff\u3400-\u9fff]', str(text or '')) is not None


def resolve_product(job):
    """
    \u3053\u306e\u4f9d\u983c\u304c\u6271\u3046\u5546\u54c1\u30921\u3064\u306b\u78ba\u5b9a\u3059\u308b\u3002

    @return product_key\uff08\u6587\u5b57\u5217\uff09\u307e\u305f\u306f None\uff08\u6307\u5b9a\u306a\u3057\u306e\u56de\uff09

    \u2605\u26052026-09-20\uff08\u6c7a\u5b9a#159\uff09\u3002\u30aa\u30fc\u30ca\u30fc\u6307\u793a:
      \u300c\u30a2\u30d5\u30a3\u30ea\u30a8\u30a4\u30c8\u5546\u54c1\u6bce\u306b\u3061\u3083\u3093\u3068\u4ed5\u5206\u3051\u3057\u3066\u52d5\u753b\u3092\u751f\u6210\u3059\u308b\u3002
        \u5546\u54c1\u3084\u30c6\u30ed\u30c3\u30d7\u306a\u3069\u6df7\u5408\u3057\u306a\u3044\u305f\u3081\u306b\u69cb\u7bc9\u300d

    \u3010\u306a\u305c\u8981\u308b\u304b\u3011
    \u30e9\u30a4\u30d6\u30e9\u30ea\u306f genre\uff08'hoodie' \u7b49\uff09\u3067\u3057\u304b\u5206\u304b\u308c\u3066\u3044\u306a\u3044\u3002\u540c\u3058 genre \u306e
    \u5225\u5546\u54c1\u304c2\u3064\u5165\u3063\u305f\u77ac\u9593\u3001**A\u5546\u54c1\u306e\u52d5\u753b\u306bB\u5546\u54c1\u306e\u7d20\u6750\u304c\u6df7\u3056\u308b**\u3002
    \u6c17\u3065\u3051\u308b\u306e\u306f\u51fa\u6765\u4e0a\u304c\u3063\u305f\u52d5\u753b\u3092\u4eba\u304c\u898b\u305f\u6642\u3060\u3051\u3067\u3001\u305d\u308c\u3067\u306f\u9045\u3044\u3002

    \u2605\u6ce8\u610f\u3067\u5b88\u3089\u306a\u3044\u3002**\u69cb\u9020\u3067\u6b62\u3081\u308b**\uff08target_market \u3092\u6b62\u3081\u305f #082 \u3068\u540c\u3058\uff09\u3002
      \u300c\u4f7f\u308f\u305a\u306b\u6b21\u306e\u30af\u30ea\u30c3\u30d7\u3078\u300d\u3067\u306f\u306a\u304f**\u63cf\u304b\u305a\u306b\u843d\u3068\u3059**\u3002\u9ed9\u3063\u3066\u5225\u306e\u7d20\u6750\u306b
      \u5dee\u3057\u66ff\u308f\u308b\u65b9\u304c\u5371\u967a\u3067\u3001\u51fa\u6765\u4e0a\u304c\u308a\u3092\u898b\u308b\u307e\u3067\u8ab0\u3082\u6c17\u3065\u304b\u306a\u3044\u3002

    \u3010\u672a\u6307\u5b9a\u3092\u5373\u30a8\u30e9\u30fc\u306b\u3057\u306a\u3044\u7406\u7531\u3011
    \u4f9d\u983c\u5074\uff08GAS / Supabase\uff09\u306f\u307e\u3060 product_key \u3092\u9001\u3063\u3066\u3044\u306a\u3044\u3002\u3053\u3053\u3067
    \u843d\u3068\u3059\u3068\u3001\u63cf\u753b\u5074\u3092\u66f4\u65b0\u3057\u305f\u77ac\u9593\u306b**\u5168\u90e8\u306e\u4f9d\u983c\u304c\u6b62\u307e\u308b**\u3002
    \u30c7\u30d7\u30ed\u30a4\u306e\u9806\u756a\u3067\u58ca\u308c\u308b\u8a2d\u8a08\u306f\u65e2\u306b3\u5ea6\u8e0f\u3093\u3067\u3044\u308b\uff08#076 / #079 / #082\uff09\u3002
    \u2192 \u9001\u3063\u3066\u304d\u305f\u56de\u3060\u3051\u7a81\u304d\u5408\u308f\u305b\u308b\u3002\u4e21\u65b9\u304c\u9001\u308b\u3068\u78ba\u8a8d\u3067\u304d\u305f\u3089\u5fc5\u9808\u3078\u5012\u3059\u3002
    """
    top = str(job.get('product_key') or '').strip()

    # \u7d20\u6750\u5074\u304c\u540d\u4e57\u3063\u3066\u3044\u308b product_key \u3092\u96c6\u3081\u308b
    seen = {}

    def note(where, value):
        v = str(value or '').strip()
        if v:
            seen.setdefault(v, []).append(where)

    for i, c in enumerate(job.get('clips') or []):
        if isinstance(c, dict):
            note('clips[%d]' % i, c.get('product_key'))
    fg = job.get('foreground')
    if isinstance(fg, dict):
        note('foreground', fg.get('product_key'))

    if not top and not seen:
        return None

    keys = set(seen)
    if top:
        keys.add(top)
    if len(keys) > 1:
        detail = '\n'.join(
            '  %-16s %s' % (k, ', '.join(seen.get(k, ['job.product_key'])))
            for k in sorted(keys))
        raise SystemExit(
            '1\u672c\u306e\u52d5\u753b\u306b\u8907\u6570\u306e\u5546\u54c1\u304c\u6df7\u3056\u3063\u3066\u3044\u307e\u3059\uff08\u63cf\u753b\u3092\u4e2d\u6b62\uff09\u3002\n'
            '%s\n'
            '  \u2605\u6df7\u3056\u3063\u305f\u307e\u307e\u63cf\u304f\u3068\u3001\u5225\u5546\u54c1\u306e\u6620\u50cf\u306b\u3053\u306e\u5546\u54c1\u306e\u30ea\u30f3\u30af\u304c\u4ed8\u304d\u307e\u3059\u3002'
            % detail)

    key = top or next(iter(keys))
    log('\u5546\u54c1: %s\uff08\u7d20\u6750 %d\u4ef6\u304c\u540c\u3058\u5546\u54c1\u3092\u6307\u3057\u3066\u3044\u307e\u3059\uff09'
        % (key, sum(len(v) for v in seen.values())))
    return key


def caption_font(sample=''):
    """
    字幕に使うフォントを決める。

    @param sample 描く文字列の見本（本文＋字幕）。日本語を含めば日本語フォント
    @return (フォント名, フォントを置いたディレクトリ or None, 文字幅の比率)

    ★見つからなければ黙って DejaVu へ降りる。フォントが無いことを
      理由に動画を1本落とすのは損。ただし比率は必ず一緒に切り替える。
      比率だけ Anton のまま DejaVu で描くと、1.5倍の幅で描かれて
      画面からはみ出す（比率とフォントは必ず対で扱う）。
    """
    if has_cjk(sample):
        name, fname, ratio = CAPTION_FONT_JA_NAME, CAPTION_FONT_JA_FILE, CHAR_WIDTH_RATIO_JA
        market = 'ja'
    else:
        name, fname, ratio = CAPTION_FONT_NAME, CAPTION_FONT_FILE, CHAR_WIDTH_RATIO
        market = 'en'
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    # ★市場ごとのフォントだけを見る。混ざらないよう探索先も分ける
    for d in (os.path.join(root, 'assets', market, 'fonts'),
              os.path.join(here, 'fonts')):
        if os.path.exists(os.path.join(d, fname)):
            return name, d, ratio
    # ★日本語フォントが無い回は DejaVu へ降りても豆腐になる。黙って出さず、
    #   ここで止める（字幕が読めない動画は投稿できない）。
    if name == CAPTION_FONT_JA_NAME:
        raise SystemExit('%s が見つかりません。日本語の字幕を描けません。' % fname)
    log('%s が見つかりません。DejaVu Sans で描きます。' % fname)
    return 'DejaVu Sans', None, CHAR_WIDTH_RATIO_FALLBACK


# 幅を測る時の基準サイズと下地。
# ★幅はフォントサイズに正比例する（実測：Anton "PERFORMANCE" は
#   size100で306px / size140で429px、比率はどちらも0.278）。
#   だから測るのは一度、基準サイズだけでよい。
# ★下地は「どんなに長い行でも切れない」幅にする。狭いと画面端で
#   文字が欠け、欠けたぶん細く測れてしまう（DejaVuの15文字で実際に起きた）。
MEASURE_FONT_SIZE = 100
MEASURE_CANVAS_W = 4000
MEASURE_CANVAS_H = 300


def measure_char_ratio(text, font_name, font_dir):
    """
    その文字列を libass に実際に描かせて幅を測り、
    「1文字あたりの幅 ÷ フォントサイズ」を返す。測れなければ None。

    ★★2026-08-29、固定値をやめて実測に切り替えた。

    【なぜ固定値では駄目か】
    1文字あたりの幅は文字列の中身で大きく変わる。同じ Anton でも
    実測（libass、基準サイズ100）でこれだけ開く:

        "WOW"              0.350   ← W が並ぶと太い
        "PERFORMANCE"      0.278
        "HAD NO BUSINESS"  0.244   ← 空白が混ざると細い

    最も太い側に合わせれば短い語が小さく出るし、細い側に合わせれば
    長い行が画面からはみ出す。**どの一つの数字を選んでも必ず外れる。**
    実測なら外れない。

    【ffmpegを1回余分に叩くコストについて】
    1回およそ0.18秒（実測、8回で1.45秒）。字幕20枚で4秒ほど。
    描画ジョブの持ち時間は20分なので、精度に対して十分に安い。

    【measure に失敗した時】
    Noneを返し、呼び出し側は従来の固定値へ降りる。字幕の大きさが
    多少ずれるだけで済ませ、動画を1本落とさない。
    """
    body = str(text or '').strip()
    if not body:
        return None
    d = tempfile.mkdtemp(prefix='measure-')
    try:
        ass = os.path.join(d, 'm.ass')
        with io.open(ass, 'w', encoding='utf-8') as f:
            f.write(build_ass_head(MEASURE_CANVAS_W, MEASURE_CANVAS_H,
                                   MEASURE_FONT_SIZE, font_name,
                                   outline=0) + '\n')
            f.write('Dialogue: 0,0:00:00.00,0:00:02.00,Pop,,0,0,0,,'
                    '{\\an5\\pos(%d,%d)}%s\n'
                    % (MEASURE_CANVAS_W // 2, MEASURE_CANVAS_H // 2, body))
        arg = 'ass=' + ass.replace('\\', '/').replace(':', r'\:')
        if font_dir:
            arg += ':fontsdir=' + font_dir.replace('\\', '/').replace(':', r'\:')
        # ★縦を1pxへ潰してから読む。1080x1920を素で走査すると
        #   200万バイトをPythonで舐めることになり、そこだけで遅くなる。
        #   面積平均で潰せば、文字のある列は必ず下地より明るくなる。
        raw = subprocess.run(
            ['ffmpeg', '-v', 'error', '-f', 'lavfi',
             '-i', 'color=c=black:s=%dx%d:d=0.1:r=1'
             % (MEASURE_CANVAS_W, MEASURE_CANVAS_H),
             '-vf', arg + ',format=gray,scale=%d:1:flags=area' % MEASURE_CANVAS_W,
             '-frames:v', '1', '-f', 'rawvideo', '-'],
            capture_output=True).stdout
    except Exception as e:
        log('字幕の幅を測れませんでした（固定値で描きます）: %s' % e)
        return None
    finally:
        shutil.rmtree(d, ignore_errors=True)

    if len(raw) < MEASURE_CANVAS_W:
        return None
    # ★下地は yuv の黒（0ではない）。行の最小値を下地とみなす
    base = min(raw)
    on = [i for i, v in enumerate(raw) if v > base + 1]
    if not on:
        return None
    width = on[-1] - on[0] + 1
    if width >= MEASURE_CANVAS_W - 2:
        return None                       # 下地に収まっていない。信用しない
    return width / float(len(body) * MEASURE_FONT_SIZE)


def fit_caption(words, w, font_size, ratio=None, h_hint=0, sep=' ', usable=None):
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
    # 呼び出し側が安全領域から出した幅を優先する。無ければ従来どおり
    usable = usable or (w - 120 - CAPTION_OUTLINE * 2)
    floor = max(40, int(font_size * 0.5))  # これ以下は読めない

    size = font_size
    while True:
        per_char = (ratio or CHAR_WIDTH_RATIO) * size
        lines = []
        cur = []
        for wd in words:
            trial = cur + [wd]
            if cur and len(sep.join(trial)) * per_char > usable:
                lines.append(cur)
                cur = [wd]
            else:
                cur = trial
        if cur:
            lines.append(cur)

        # 1語だけで幅を超える場合も、これ以上は折れない
        too_wide = any(len(sep.join(ln)) * per_char > usable for ln in lines)
        if (len(lines) <= MAX_CAPTION_LINES and not too_wide) or size <= floor:
            """
            ★★2026-08-28、縮小だけでなく拡大もするようにした。

            【なぜ要るか】
            フォントを Anton（縦長・細身）へ替えたら、字幕が
            画面の4割しか使わなくなった（実測 429px / 1080px）。
            この関数は「入らなければ縮める」しかせず、
            **余っていても広げない**作りだった。
            DejaVu は元から幅を取るので問題が表に出ていなかっただけで、
            細いフォントに替えた瞬間に「小さくて読みにくい字幕」になる。

            縦型ショート動画の字幕は、画面幅をしっかり使ってこそ効く。
            一番長い行が使える幅に届くまで広げる。

            【上限を置く理由】
            1語だけの回（"WOW" など）に上限が無いと、文字が画面から
            はみ出すほど巨大になる。基準サイズの2.2倍で止める。
            さらに2行ぶんの高さが画面の1/4を超えないようにする。
            """
            longest = max((len(sep.join(ln)) for ln in lines), default=0)
            if longest:
                ceiling = int(font_size * 2.2)
                if h_hint:
                    # 行の高さはおよそ font_size * 1.25。
                    # ★実際の行数で割る。MAX_CAPTION_LINES で決め打ちすると、
                    #   1行しかない回まで2行ぶんの上限で抑え込まれ、
                    #   短い語（"WOW" など）が小さいまま出る。
                    ceiling = min(ceiling,
                                  int((h_hint * 0.25) / (len(lines) * 1.25)))
                grown = int(usable / (longest * (ratio or CHAR_WIDTH_RATIO)))
                size = max(size, min(grown, ceiling))
            return size, [len(ln) for ln in lines]
        size -= 6


def split_by_highlight(word, raws):
    """
    日本語の1語を「強調語の前 / 強調語 / 後ろ」へ割る。

    @return [(文字列, 光らせるか), ...]。該当が無ければ [(word, False)]
    """
    best = None
    for h in raws or []:
        at = word.find(h)
        if at >= 0 and (best is None or at < best[0]):
            best = (at, h)
    if not best:
        return [(word, False)]
    at, h = best
    out = []
    if word[:at]:
        out.append((word[:at], False))
    out.append((h, True))
    if word[at + len(h):]:
        out.append((word[at + len(h):], False))
    return out


def build_ass_head(w, h, font_size, font_name, outline=CAPTION_OUTLINE,
                   primary=None, secondary=None):
    """
    ASSのヘッダ（[Script Info] と [V4+ Styles]）を作る。

    ★実測（measure_char_ratio）でも本番と同じスタイル定義を使う。
      別々に書くと、片方だけ Bold を直した時に測った幅と描いた幅が
      食い違う。同じ関数から出すことで、その事故を構造的に潰す。

    @param outline 黒縁の太さ。測る時だけ0にする（縁の分だけ太く
                   測れてしまい、字幕が実際より小さく出るため）
    @param primary   塗られた後の色（ASS表記）。None なら現行の黄
    @param secondary 塗られる前の色（ASS表記）。None なら現行の白

    ★★色を引数にしたのは design_tokens を受けるため（2026-08-29）。
      **既定値は現行のハードコード値と同一**にしてある。
      色を渡さない限り、出力は1バイトも変わらない。
    """
    primary = primary or '&H0000FFFF'      # 黄
    secondary = secondary or '&H00FFFFFF'  # 白
    return '\n'.join([
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
        # ★Bold は Anton では -1 にしない。Anton は元から極太で、
        #   さらに合成太字を掛けると輪郭が潰れる（実測して判断）
        ('Style: Pop,%s,%d,%s,%s,&H00000000,'
         '&H80000000,%d,0,0,0,100,100,0,0,1,%d,3,5,60,60,60,1'
         % (font_name, font_size, primary, secondary,
            0 if font_name in (CAPTION_FONT_NAME, CAPTION_FONT_JA_NAME) else -1,
            outline)),
        # ★広告表記用。字幕と同じスタイルを使い回さない。
        #   字幕は \\fs や \\1c を回ごとに上書きするので、混ぜると
        #   表記まで一緒に動いてしまう。別スタイルにして固定する。
        #
        # ★★2026-08-31、大きさを 0.26 → 0.65 へ上げた。**実測して直した。**
        #   0.26 だと 1920px の画面で **字の高さが16px** しかなく、
        #   スマホの実表示では6px程度になる。事実上読めない。
        #   広告表記は「一般消費者が広告だと判別できる」ことが要件なので、
        #   読めない大きさでは表記した事にならない。
        #
        #   0.65 で字高38px（画面幅の25%）。字幕本体の字高は120px前後なので
        #   約1/3。読めるが、主役の字幕とは競合しない大きさ。
        ('Style: Note,%s,%d,&H20FFFFFF,&H20FFFFFF,&H00000000,'
         '&H80000000,0,0,0,0,100,100,0,0,1,3,0,8,40,40,40,1'
         % (font_name, max(28, int(font_size * NOTE_SIZE_RATIO)))),
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ])


def build_ass(captions, w, h, font_size, center=False,
              font_name='DejaVu Sans', ratio=None, font_dir=None,
              theme=None, disclosure=None, safe=None):
    """
    単語ごとに色が変わる字幕（karaoke）を作る。

    ★これが「トップYouTuber特有の字幕」の正体。
      \\k タグで単語ごとに PrimaryColour へ塗り替わる。
      さらに \\t でわずかに拡大させ、ポップして出るように見せる。

    ★ミュート再生でも内容が伝わることが要件なので、
      画面中央よりやや下に大きく置く。
    """
    head = build_ass_head(
        w, h, font_size, font_name,
        primary=(theme or {}).get('primary'),
        secondary=(theme or {}).get('secondary')).split('\n')

    """
    ★置く高さは、背景に映像があるかどうかで変える。

    映像がある回（モードA）は下寄せにする。中央に置くと被写体の顔を
    塞ぐし、そもそも主役は映像側なので邪魔をしない位置がよい。

    ★★モードT（背景が単色）は中央に置く（2026-08-26）。
      最初は下寄せのまま出したところ、画面の上7割が完全に死んだ
      真っ黒の帯になった（実際にフレームを抜いて確認）。
      文字が主役の回に、その文字を隅へ寄せる理由が無い。
    """
    safe = safe or SAFE_AREAS['none']
    """
    ★モードT（背景が単色）は中央のまま。UIと重なる位置に文字を置かない、
      という目的は同じだが、あちらは画面全部が文字の場なので上下中央でよい。
    """
    y = int(h * (0.50 if center else safe['caption_y']))
    # 右を広く空けたぶん、中心も左へ寄せる（寄せないと文字が右へ張り出す）
    center_x = (safe['left'] + (w - safe['right'])) // 2
    usable_w = (w - safe['left'] - safe['right']) - CAPTION_OUTLINE * 2
    lines = []

    """
    ★★広告表記（2026-08-31）。

    【なぜ動画にも要るか】
    アフィリエイト商品を扱う動画は、それが広告であることを分かる形で
    示す必要がある（景表法のステマ規制／各SNSの規約）。
    投稿本文に書くだけでは足りない。動画は本文と切り離されて
    再生・保存・転載されるので、**動画そのものが表記を持つ**必要がある。

    【なぜ画面上部か】
    字幕は下（モードA）か中央（モードT）に出る。上に置けばどちらとも
    衝突しない。小さく薄くするが、消しはしない。

    【なぜ全編に出すか】
    途中から見た人にも見える必要がある。冒頭数秒だけでは意味が無い。
    """
    if disclosure:
        lines.append(
            'Dialogue: 0,0:00:00.00,9:59:59.99,Note,,0,0,0,,'
            '{\\pos(%d,%d)}%s' % (center_x, int(h * safe['note_y']),
                                 ass_escape(str(disclosure))))
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

        """
        ★★2026-08-29、ここに2つ不具合があった。

        (1) 幅の見積りが固定値だった。
            実際に描く文字列で実測し、その1枚だけに使う。
            文字の並びで幅は 0.244〜0.350 まで変わるので（Anton実測）、
            1枚ごとに測らないと必ずどちらかへ外れる。
            ★描くのは wd.upper()。測る側も大文字で測らないと、
              小文字の細い字で測って大文字で描くことになり細く出る。

        (2) fit_caption が拡大しても、その結果を捨てていた。
            `size >= font_size` の時に \\fs を付けない書き方だったため、
            拡大した回は必ず基準サイズで描かれていた。
            拡大の実装を入れても画面上は何も変わらず、
            実測しても幅が 429px から1pxも動かなかった原因がこれ。
        """
        """
        ★★日本語（2026-09-02）。語の間に空白を入れない。
          TTS の WordBoundary は日本語でも語ごとに来るが、日本語の字幕は
          分かち書きしない。空白を挟むと「この 扇風機 は」のように
          見え、素人臭くなる。大文字化も掛けない（英字が混じった時に
          商品名の綴りを変えてしまう）。
        """
        cjk = has_cjk(text)
        sep = '' if cjk else ' '
        shown = sep.join(wd if cjk else wd.upper() for wd in words)
        measured = measure_char_ratio(shown, font_name, font_dir) or ratio

        size, line_breaks = fit_caption(words, w, font_size, measured, h,
                                        sep=sep, usable=usable_w)
        fs = '' if size == font_size else ('\\fs%d' % size)

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

        """
        ★★強調語だけ色を差し替える（2026-08-29）。

        \\1c が塗られた後の色、\\2c が塗られる前の色。
        スタイル既定はPrimary/Secondaryなので、強調語の前で上書きし、
        **その語の直後に必ず戻す**。戻し忘れると、以降の語まで
        全部その色で描かれる（1語だけ光らせる意味が消える）。

        ★theme が無い回はこの分岐へ一切入らない。従来どおりに描く。
        """
        hi = (theme or {}).get('words') or set()
        accent = (theme or {}).get('accent')
        accent_dim = (theme or {}).get('accent_dim')
        back = ''
        if accent and theme.get('primary'):
            back = '{\\1c%s\\2c%s}' % (theme['primary'],
                                       theme.get('secondary') or theme['primary'])

        karaoke = ''
        raws = (theme or {}).get('words_raw') or []
        for i, wd in enumerate(words):
            if breaks.get(i):
                karaoke = karaoke.rstrip() + '\\N'

            """
            ★★2026-09-02、日本語の強調語。

            英語は空白で語が切れるので、語まるごとで一致を見れば足りる。
            日本語は「図書館より静かな二」のような塊で1枚に来るので、
            完全一致では**一度も光らない**。かといって塊ごと光らせると
            行全体が着色され、「どこを読むか」を示す目的が消える
            （どちらも実際に描いて確認した）。
            強調語の位置で3つに割り、その部分だけ塗る。
            持ち時間（\\k）は文字数の比で割り振る。
            """
            if cjk and accent and raws:
                parts = split_by_highlight(wd, raws)
            else:
                parts = [(wd if cjk else wd.upper(),
                          bool(accent) and normalize_word(wd) in hi)]

            total_len = sum(len(t) for t, _ in parts) or 1
            spent = 0
            for n, (piece, lit) in enumerate(parts):
                # 端数は最後の断片へ寄せる。合計が per_word[i] からずれると
                # 音と色のずれが後ろの語まで積み上がる
                if n == len(parts) - 1:
                    cs = max(1, per_word[i] - spent)
                else:
                    cs = max(1, int(round(per_word[i] * len(piece) / total_len)))
                    spent += cs
                if lit:
                    karaoke += '{\\1c%s\\2c%s}' % (accent, accent_dim or accent)
                karaoke += '{\\k%d}%s' % (cs, piece)
                if lit and back:
                    karaoke += back
            karaoke += sep

        # 出だしで少し大きく → 元のサイズへ戻す（ポップ）
        effect = ('{\\pos(%d,%d)%s\\fad(60,60)'
                  '\\fscx70\\fscy70\\t(0,110,\\fscx106\\fscy106)'
                  '\\t(110,190,\\fscx100\\fscy100)}' % (center_x, y, fs))

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

    """
    ★★2026-09-22、**text= を渡していなかった**（決定#126の配線漏れ）。

    group_words は文の切れ目を「元の本文と突き合わせて」判定する。
    ところがここが `group_words(r['words'])` で、**本文を渡していなかった**。
    渡さないと語の末尾の 。！？ で判定する側へ落ちるが、
    **edge-tts の WordBoundary は句読点を返さない**ので、
    文の切れ目が1つも見つからず、**字幕が文をまたぎ続けていた**。

    実際に出ていた形（job anna-redial-telop-v2 のコマで確認）:
      「サイズ豊富で体型を」「選ばないすっぽり」「小顔見え手の甲まで」
      → 「選ばない。」で終わる文と「すっぽりフード…」が1枚に同居していた。

    ★tts.py 側の実装も check_group_words.py も正しかった。
      **直っていなかったのは呼び出し側だけ**である。
      単体が通っていることと、本番経路で使われていることは別（E-021と同じ形）。
    """
    chunks = tts_mod.group_words(r['words'], text=narration)
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

    sample_text = '%s %s' % (
        job.get('narration') or '',
        ' '.join(str(c.get('text') or '') for c in (job.get('captions') or [])))

    # ★どちらの部門の依頼か。素材の取り違えはここで止める（決定#082）
    market = resolve_market(job, sample_text)
    log('部門: %s ライン' % market)

    # ★どの商品の依頼か。**混ざっていたら描かずに落とす**（決定#159）
    resolve_product(job)

    font_name, font_dir, font_ratio = caption_font(sample_text)
    log('モード %s / クリップ %d本 / 字幕フォント %s（幅は1枚ずつ実測'
        '／測れない時の予備 %.2f）' % (mode, len(clips), font_name, font_ratio))

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
        """
        ★背景色。design_tokens が無ければ従来の 0x0d0d12 のまま。
          ffmpeg の color= は **RGBのまま**（ASSのBGRと逆）なので、
          変換関数を取り違えないこと。
        """
        bg_color = hex_to_ffmpeg((job.get('design_tokens') or {})
                                 .get('bg_color_hex')) or '0x0d0d12'
        bg = os.path.join(work, 'bg.mp4')
        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-f', 'lavfi',
             '-i', 'color=c=%s:s=%dx%d:d=%.2f:r=%d' % (bg_color, w, h, total, fps),
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
    """
    ★★2026-08-31、本数の根拠を実際の尺に合わせた。

    【何が起きていたか】
    本数は clip_seconds から計算するのに、実際の尺は各クリップの
    duration を使っていた（下の each の行）。この2つが食い違うと
    尺が壊れる。実測：clip_seconds=1.6 / duration=3.2 のとき
    **字幕16.2秒に対し動画35.2秒**（2倍以上）になった。

    本番のGASは両方に同じ値を入れているので今まで表面化していない。
    片方だけ変えた瞬間に出る類の不整合なので、根拠を1つに寄せる。
    """
    # ★背景を沈めるか。False / True（ぼかし＋暗く） / 'dark'（暗くするだけ）
    #   送られなければ従来どおり素材をそのまま使う
    dim = job.get('dim_background') or False

    want_each = float(job.get('clip_seconds') or 1.6)
    given = [float(c.get('duration')) for c in (job.get('clips') or [])
             if c and c.get('duration')]
    if given:
        # 実際に使うのは各クリップの duration。本数もそちらで数える
        want_each = sum(given) / len(given)

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

          if not download(url, src, market=market):
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
                  ok = still_to_clip(src, dst, each, w, h, fps, rng, dim)
              else:
                  ok = normalize(src, dst, st, each, w, h, fps, dim)
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
    """
    ★★2026-09-22、**繋ぎ目を重ねられるようにした**（transition_seconds）。

    【なぜ】オーナー指摘「カットが次に行くのが早い。ブツブツ感が気になる」。
      原因は**尺ではなく繋ぎ方**だった。クリップは1本ずつ別に生成した
      もので、同じ人物が同じ部屋のまま**別のポーズへ瞬間移動する**。
      これが「ブツブツ」の正体である。

    ★★ここを読み違えて「1カット1.2秒へ刻む」と提案していた。**逆だった。**
      参考にしたTikTokが1.2秒でも保つのは、**実写で動きが連続している**から。
      こちらは静止画から起こした短いクリップなので、刻むほど破綻する。

    ★既定は 0（従来どおりのハードカット）。渡さない限り出力は変わらない。
    """
    trans = float(job.get('transition_seconds') or 0)
    joined = os.path.join(work, 'joined.mp4')

    if trans > 0 and len(parts) >= 2:
        durs = [probe_duration(p) or 0.0 for p in parts]
        # ★重なりは一番短いクリップの半分まで。超えるとそのカットが
        #   「出た瞬間に消える」ことになる
        trans = min(trans, min(durs) / 2.0)
        cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error']
        for p in parts:
            cmd += ['-i', p]
        """
        ★xfade は「前の映像の“出来上がり”の時間軸」で offset を数える。
          k本目の重なりの位置 = (先頭からk本の合計) - k*重なり
          ここを素の累計にすると、重ねたぶんだけ後ろへずれていく。
        """
        chain = []
        prev = '0:v'
        acc = 0.0
        for i in range(1, len(parts)):
            acc += durs[i - 1]
            offset = max(0.0, acc - i * trans)
            out = 'vx%d' % i
            chain.append(
                '[%s][%d:v]xfade=transition=fade:duration=%.3f:offset=%.3f[%s]'
                % (prev, i, trans, offset, out))
            prev = out
        cmd += ['-filter_complex', ';'.join(chain), '-map', '[%s]' % prev,
                '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                joined]
        run(cmd)
        log('繋ぎ目を %.2f秒 重ねました（%d本・%.2f秒)'
            % (trans, len(parts), sum(durs) - (len(parts) - 1) * trans))
    else:
        # ★concat デマルチプレクサは、リスト内の相対パスを
        #   「リストファイルのある場所」から解決する。
        #   相対のまま書くと ./work/./work/part_00.mp4 を探して落ちる（実測）。
        listfile = os.path.join(work, 'concat.txt')
        with open(listfile, 'w', encoding='utf-8') as f:
            for p in parts:
                ap_ = os.path.abspath(p)
                f.write("file '%s'\n" % ap_.replace("'", "'\\''"))

        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-f', 'concat', '-safe', '0', '-i', listfile,
             '-c', 'copy', joined])

    """
    ★★2026-08-28。映像が音声より短い回に、最後の絵を伸ばして埋める。

    【切り上げ修正だけでは塞がらなかった穴】
    カット数を切り上げても、素材の取得が失敗すれば目標本数に届かない。
    実測した例（素材4本中3本が404）：

      音声 12.0秒 に合わせて 9 カット
      使えたクリップ: 3 本（目標 9）
      完成: 4.5秒

    **12秒のナレーションが4.5秒で切れた。** ログは「3本（目標9）」と
    正しく言っているのに、そのまま出力していた。半分以上が黙って消える。
    ストックCDNは普通に欠けるので、これは珍しい事故ではない。

    【なぜ黒画面ではなく静止で埋めるのか】
    Pixelle-Video は不足分を黒画面で埋めていた（color=c=black を連結）。
    黒はプレイヤーの読み込み失敗と見分けが付かず、事故に見える。
    tpad の stop_mode=clone は最後のフレームを保持するので、
    「間を取っている」ように見え、少なくとも壊れて見えない。
    """
    need_len = float(target_seconds or 0)
    if need_len > 0:
        vid_len = probe_duration(joined) or 0.0
        # 0.05秒は測定誤差。これ未満のズレで再エンコードしない
        if vid_len > 0 and vid_len < need_len - 0.05:
            short_by = need_len - vid_len
            padded = os.path.join(work, 'padded.mp4')
            log('映像が音声より %.2f秒 短いので、最後の絵を伸ばして埋めます'
                '（%.2f秒 → %.2f秒）' % (short_by, vid_len, need_len))
            try:
                run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                     '-i', joined, '-an',
                     '-vf', 'tpad=stop_mode=clone:stop_duration=%.2f' % short_by,
                     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                     '-pix_fmt', 'yuv420p', padded])
                if os.path.exists(padded) and os.path.getsize(padded) > 1024:
                    joined = padded
                else:
                    log('  埋められませんでした。そのまま続行します。')
            except Exception as e:
                # ★ここで落とさない。埋められなくても動画は出す
                log('  埋める処理に失敗（そのまま続行）: %s' % str(e)[:80])

    # ------------------------------------------------------------------
    # 前景の合成（決定#087）
    # ------------------------------------------------------------------
    # 背景動画の上に、透過した商品画像を直接重ねる。白い枠や下敷きは置かない。
    #
    # ★字幕を焼く前に済ませる。順番が逆だと、前景が字幕の上に乗って
    #   文字が読めなくなる。読めない字幕は無いのと同じ。
    #
    # ★ここで失敗しても動画は出す。前景が無いだけの動画は成立するが、
    #   例外で落とすとその回の動画が丸ごと消える。
    fg_spec = job.get('foreground')
    if isinstance(fg_spec, dict) and fg_spec.get('url'):
        try:
            raw = os.path.join(work, 'fg_raw')
            png = os.path.join(work, 'fg.png')
            log('前景を合成します: %s' % str(fg_spec.get('url'))[:100])

            if not download(str(fg_spec['url']), raw,
                            market=job.get('target_market')):
                raise RuntimeError('前景の素材を取得できませんでした')

            if not prepare_foreground(raw, png):
                raise RuntimeError('前景を透過できませんでした')

            fg_seconds = float(target_seconds or probe_duration(joined) or 0)
            if fg_seconds <= 0:
                raise RuntimeError('尺が測れないため前景を合成できません')

            composed = os.path.join(work, 'composed.mp4')
            run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                 '-i', joined, '-loop', '1', '-i', png,
                 '-filter_complex',
                 foreground_filter(w, h, fps, fg_seconds, fg_spec),
                 '-map', '[v]', '-an',
                 '-t', '%.3f' % fg_seconds,
                 '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                 '-pix_fmt', 'yuv420p', composed])

            if os.path.exists(composed) and os.path.getsize(composed) > 1024:
                joined = composed
                log('  前景を重ねました（%.1f秒 / 幅 %d%% / %.0f%%拡大）'
                    % (fg_seconds,
                       int(100 * float(fg_spec.get('width_ratio')
                                       or FG_WIDTH_RATIO)),
                       100 * float(fg_spec.get('zoom')
                                   if fg_spec.get('zoom') is not None
                                   else FG_ZOOM)))
            else:
                log('  前景の合成に失敗しました。前景なしで続行します。')
        except Exception as e:
            log('  前景の合成を飛ばします（動画は出します）: %s' % str(e)[:160])

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

    """
    ★"random" と書けば assets/bgm/ から1本選ぶ（2026-08-28）。

    GAS側が曲名を知らなくて済むようにする。曲を足したり入れ替えたり
    しても、GAS側のコードは触らなくてよい。
    """
    if bgm_src.lower() == 'random':
        here = os.path.dirname(os.path.abspath(__file__))
        bgm_dir = os.path.join(os.path.dirname(here), 'assets', SHARED_DIR, 'bgm')
        pool = []
        if os.path.isdir(bgm_dir):
            pool = sorted(f for f in os.listdir(bgm_dir)
                          if f.lower().endswith(('.mp3', '.m4a', '.ogg', '.wav')))
        if pool:
            bgm_src = os.path.join(bgm_dir, rng.choice(pool))
            log('BGMを選びました: %s' % os.path.basename(bgm_src))
        else:
            log('assets/shared/bgm/ に音源がありません。BGM無しで続行します。')
            bgm_src = ''

    if bgm_src:
        if bgm_src.startswith(('http://', 'https://', 'file://')):
            cand = os.path.join(work, 'bgm_src')
            bgm_path = cand if download(bgm_src, cand, market=market) else None
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

    """
    ★★効果音（2026-09-03）。BGMの後ろへ入力として並べる。
      adelay で鳴らす位置まで無音を挟み、最後に全部を1本へ混ぜる。
      短いファイル（0.1〜0.6秒）なので、本数が増えても負荷は小さい。
    """
    sfx_cues = resolve_sfx(job.get('sfx'), target_seconds or probe_duration(joined))
    for path, _ in sfx_cues:
        cmd += ['-i', path]

    cmd += ['-shortest']

    # --- 映像フィルタ（字幕）---
    # ★モードTは字幕そのものが本体。ここを 'A' で決め打ちにすると
    #   背景だけの真っ黒な動画が出る（実際に一度そうなった）
    if mode in ('A', 'T') and captions:
        assfile = os.path.join(work, 'caption.ass')
        with open(assfile, 'w', encoding='utf-8') as f:
            f.write(build_ass(captions, w, h, font_size,
                              center=(mode == 'T'),
                              font_name=font_name, ratio=font_ratio,
                              font_dir=font_dir,
                              theme=build_theme(job.get('design_tokens'),
                                                job.get('highlight_words')),
                              disclosure=job.get('disclosure'),
                              safe=SAFE_AREAS.get(
                                  str(job.get('safe_area') or 'none').lower(),
                                  SAFE_AREAS['none'])))

        """
        ★fontsdir で libass に探し場所を教える。
          fc-cache を叩いてシステムへ登録する必要はない。
        """
        assarg = 'ass=' + assfile.replace('\\', '/').replace(':', r'\:')
        if font_dir:
            assarg += ':fontsdir=' + font_dir.replace('\\', '/').replace(':', r'\:')
        cmd += ['-vf', assarg]

    """
    ★音声フィルタ。BGMがある回だけ、2本を混ぜて1本にする。

      [1:a] ナレーション（または無音）
      [2:a] BGM … 音量を落とし、終わりをフェードアウトする

    amix の duration=first は「1本目（ナレーション）の長さで終える」。
    これを付けないと、繰り返し続けるBGM側に引きずられて終わらなくなる。
    normalize=0 は amix の自動音量調整を切る指定。切らないと
    混ぜた瞬間にナレーションの音量まで一緒に下がる。
    """
    if bgm_path or sfx_cues:
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

        """
        入力の並びは固定:
          0 = 映像 / 1 = ナレーション（か無音） / 2 = BGM（あれば）
          その後ろに効果音が1本ずつ。ここでずれると別の音を混ぜるので、
          番号は上の cmd を組んだ順とそろえる。
        """
        chains = []
        mix_labels = ['[1:a]']
        idx = 2

        if bgm_path:
            bgm_chain = 'volume=%.2f' % BGM_VOLUME
            if fade_start > 0:
                bgm_chain += ',afade=t=out:st=%.2f:d=%.2f' % (
                    fade_start, BGM_FADEOUT_SEC)
            chains.append('[%d:a]%s[bgm]' % (idx, bgm_chain))
            mix_labels.append('[bgm]')
            idx += 1

        for n, (path, at) in enumerate(sfx_cues):
            # adelay はミリ秒。all=1 で全チャンネルへ同じ遅延を掛ける
            chains.append('[%d:a]volume=%.2f,adelay=%d:all=1[sfx%d]'
                          % (idx, SFX_VOLUME, int(round(at * 1000)), n))
            mix_labels.append('[sfx%d]' % n)
            idx += 1

        """
        ★duration=first は「1本目（ナレーション）の長さで終える」。
          これが無いと、繰り返すBGM側に引きずられて終わらなくなる。
          normalize=0 は amix の自動音量調整を切る指定。切らないと
          混ぜた瞬間にナレーションの音量まで一緒に下がる。
          ★効果音を足しても同じ。inputs の数だけが変わる。
        """
        chains.append('%samix=inputs=%d:duration=first:normalize=0[aout]'
                      % (''.join(mix_labels), len(mix_labels)))
        cmd += ['-filter_complex', ';'.join(chains),
                '-map', '0:v', '-map', '[aout]']

        if bgm_path:
            log('BGMを重ねます（音量 %.2f / 終わり %.1f秒でフェードアウト）'
                % (BGM_VOLUME, BGM_FADEOUT_SEC))
        if sfx_cues:
            log('効果音を %d 本重ねます（音量 %.2f）: %s'
                % (len(sfx_cues), SFX_VOLUME,
                   ', '.join('%s@%.1fs' % (os.path.basename(p), t)
                             for p, t in sfx_cues)))

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
