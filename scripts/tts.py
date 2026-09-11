#!/usr/bin/env python3
"""
本文を音声にして、単語ごとの発声時刻を返す。

★★2026-08-24、オーナー判断「A 音声にしてやく」。

【なぜ Whisper を使わないか】
Whisper は「既にある音声」を推定するもの。こちらは音声を自分で作るので、
推定する必要が無い。edge-tts は合成時に WordBoundary を返すので、
どの単語が何秒に鳴るかが **推定ではなく確定値** で手に入る。

  ・精度  … 推定誤差ゼロ
  ・速度  … CPUで実時間より速い（Whisperのlarge-v3はCPUで5〜10倍かかる）
  ・費用  … 0円・APIキー不要

Whisperを積むのは「人の声が既に入っている素材」を扱う時だけでよい。
うちの素材（Pexels/Pixabay）は無音なので、その出番が無い。

【WordBoundary の単位】
offset / duration は 100ナノ秒（tick）。
  秒 = ticks / 10_000_000

【この環境での制約】
開発用サンドボックスは WebSocket を通さないため、ここでは実行できない。
Colab と GitHub Actions では問題にならない（MoneyPrinterTurbo-SETUP.md に
同じ事象の記録あり）。ここでは import に失敗しても落ちないようにしてある。
"""

import asyncio
import os
import re
import shutil
import subprocess
import tempfile

# 100ナノ秒 → 秒
TICKS_PER_SECOND = 10_000_000

# 既定の声。落ち着きすぎない、短い動画に合う声を選ぶ
DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural'

# 読み上げ速度。ショート動画は少し速い方がテンポに合う
DEFAULT_RATE = '+12%'
DEFAULT_PITCH = '+0Hz'
DEFAULT_VOLUME = '+0%'

"""
★★抑揚（2026-09-10・決定#127）。オーナー指示「ナレーションも最大限に抑揚つけて」。

【なぜ文ごとに分けて合成するのか】
edge-tts は **本文をHTMLエスケープしてから** SSML を組み立てる
（edge_tts.communicate.mkssml で確認）。つまり `<prosody>` を本文へ
埋め込む方法は使えない。抑揚を付けられるのは Communicate() の
引数（rate / volume / pitch）だけで、これは**1回の合成につき1組**しかない。

  → 全文を1回で合成する限り、最初から最後まで必ず一本調子になる。
  → 文ごとに分けて呼び、文ごとに違う設定を与え、繋ぐしかない。

【設定は文の"役割"で決める。乱数を使わない】
同じ台本なら毎回同じ音でなければならない（E-017・描き直しは設計された動作）。
"""
"""
★★2026-09-11、振れ幅を広げた（オーナー指示「声抑揚もっと」）。

  前:  rate +4〜+18% / pitch +0〜+12Hz  → 実測F0 231.9〜275.9Hz（44Hz幅）
  後:  rate -8〜+26% / pitch +0〜+26Hz

★**音量も振るようにした。** 前は rate と pitch だけ。抑揚は高さだけでなく
  「強く言う／引いて言う」でも作られる。edge-tts は volume も受け取れるのに
  使っていなかった。
★最終文を **-8%（初めて基準より遅く）** にした。前は +4% で、
  「落として言い切る」と書きながら実際には基準より速かった。
★上限の目安：pitch を素の声の2割以上動かすと別人に聞こえ始める。
  男性(約140Hz)で +26Hz は約19%、女性(約250Hz)で約10%。**男性側が限界に近い。**
"""
HOOK_PROSODY = {'rate': '+26%', 'pitch': '+20Hz', 'volume': '+12%'}
QUESTION_PROSODY = {'rate': '+2%', 'pitch': '+26Hz', 'volume': '+6%'}
CLOSING_PROSODY = {'rate': '-8%', 'pitch': '+10Hz', 'volume': '+14%'}
BODY_PROSODY = {'rate': '+14%', 'pitch': '+0Hz', 'volume': '+0%'}


class TtsUnavailable(Exception):
    """edge-tts が使えない。呼び出し側は字幕なしへ降りる。"""


def _require_edge_tts():
    try:
        import edge_tts  # noqa: F401
        return edge_tts
    except Exception as e:
        raise TtsUnavailable('edge-tts を読み込めません: %s' % e)


async def _synth(text, voice, rate, out_path, pitch=DEFAULT_PITCH,
                 volume=DEFAULT_VOLUME):
    """
    合成しつつ WordBoundary を集める。

    ★stream() を使う。save() だと音声しか得られず、単語の時刻が捨てられる。
    """
    edge_tts = _require_edge_tts()
    """
    ★★2026-08-28、GitHub Actionsで初めて実走させて発見した。

    edge-tts 7.2.8 は Communicate() の boundary 既定値を
    'SentenceBoundary' に変えていた（本コード執筆時は 'WordBoundary' が
    既定だった）。boundary を明示しないと、来るイベントは文単位になり、
    下の "elif t == 'WordBoundary':" に一つも一致しない。

    結果、音声合成そのものは成功するのに words が常に空になり、
    「単語の時刻が取れませんでした」を経て、モードTは
    「narration か captions が要ります」で毎回落ちていた。
    ネットワークとは無関係の、ライブラリ側のデフォルト変更が原因。
    開発環境はWebSocketを通さずTTSを試せないため、今まで一度も
    気づけなかった。
    """
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch,
                                volume=volume, boundary='WordBoundary')

    words = []
    with open(out_path, 'wb') as f:
        async for chunk in comm.stream():
            t = chunk.get('type')
            if t == 'audio':
                f.write(chunk['data'])
            elif t == 'WordBoundary':
                start = float(chunk['offset']) / TICKS_PER_SECOND
                dur = float(chunk['duration']) / TICKS_PER_SECOND
                words.append({
                    'text': str(chunk.get('text', '')),
                    'start': round(start, 3),
                    'end': round(start + dur, 3)
                })
    return words


def split_sentences(text):
    """本文を文へ分ける。文末記号は文の側へ残す（読点では切らない）。"""
    body = str(text or '')
    parts = re.findall(r'[^%s]*[%s]+|[^%s]+$'
                       % (SENTENCE_END, SENTENCE_END, SENTENCE_END), body)
    return [p for p in (x.strip() for x in parts) if p]


def prosody_for(index, total, sentence):
    """
    その文をどう読ませるか。**位置と形だけで決める**（決定#127）。

    ★乱数を使わない。同じ台本なら毎回まったく同じ音でなければならない
      （E-017。描き直しは設計された動作なので、鳴り方が変わってはいけない）。
    """
    if index == 0:
        return HOOK_PROSODY                       # 掴み。ここで離脱が決まる
    if sentence.rstrip().endswith(('？', '?')):
        return QUESTION_PROSODY                   # 問いかけは上げて終わる
    if index == total - 1:
        return CLOSING_PROSODY                    # 最後は落として言い切る
    return BODY_PROSODY


def _run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _audio_seconds(path):
    """デコード後の実尺（秒）。**時刻の繰り下げはこの値でなければならない。**"""
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', path],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return float(r.stdout.strip())


"""
★★文と文のあいだの間（2026-09-10・決定#127）。

【実測して直した】
文ごとに合成して繋いだ音を測ったら、**継ぎ目に約1秒の無音**が入っていた。

  0.94秒 / 1.03秒 / 1.00秒 / 1.07秒（silencedetect -40dB）

edge-tts は1回の合成ごとに前後へ無音を付ける。5文を繋ぐとその無音が
そのまま積もる。15秒の動画で**4秒が無音**になり、尺も 15.21秒 → 16.63秒 に
伸びていた。テンポを上げるための抑揚なのに、逆に間延びしていた。

→ 各文の前後の無音を**切り落とし**、こちらが決めた長さの間を差し込む。
★★切った頭のぶんだけ、その文の単語時刻を**前へずらす**。
  ここを忘れると字幕が音声より遅れて出る。
"""
GAP_SECONDS = 0.14          # 文と文のあいだ。息継ぎに聞こえる最小限
SILENCE_DB = '-40dB'


def _speech_bounds(wav):
    """
    その音声で「声が鳴っている区間」(開始秒, 終了秒) を返す。

    ★ffmpeg の silencedetect の出力を読む。前後の無音だけが対象で、
      文の途中の間（読点など）は残す（読み上げの自然さを壊さないため）。
    """
    dur = _audio_seconds(wav)
    r = subprocess.run(
        ['ffmpeg', '-v', 'info', '-i', wav, '-af',
         'silencedetect=noise=%s:d=0.05' % SILENCE_DB, '-f', 'null', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    spans = []
    start = None
    for m in re.finditer(r'silence_(start|end):\s*(-?[\d.]+)', r.stdout):
        kind, val = m.group(1), float(m.group(2))
        if kind == 'start':
            start = val
        elif start is not None:
            spans.append((start, val))
            start = None
    if start is not None:            # 末尾の無音は end が出ないことがある
        spans.append((start, dur))

    head = 0.0
    tail = dur
    for a, b in spans:
        if a <= 0.02:                # 先頭から続く無音
            head = max(head, b)
        if b >= dur - 0.02:          # 末尾まで続く無音
            tail = min(tail, a)
    if tail <= head:                 # 全部無音に見えた回は切らない
        return 0.0, dur
    return head, tail


def synthesize(text, out_path, voice=None, rate=None, prosody=True):
    """
    本文を読み上げた音声ファイルを作り、単語ごとの時刻を返す。

    @return {'path': str, 'words': [{'text','start','end'}], 'duration': float}
    @raises TtsUnavailable 使えない場合。呼び出し側は必ず捕まえること

    ★prosody=True なら**文ごとに設定を変えて**合成し、繋いで1本にする
      （決定#127）。ffmpeg が無い回・1文しかない回は従来どおり1回で合成する。
    """
    body = str(text or '').strip()
    if not body:
        raise TtsUnavailable('読み上げる本文が空です。')

    _require_edge_tts()

    sentences = split_sentences(body) if prosody else []
    can_join = bool(shutil.which('ffmpeg')) and bool(shutil.which('ffprobe'))
    if len(sentences) > 1 and can_join:
        words, duration = _synth_by_sentence(sentences, voice, rate, out_path)
    else:
        if len(sentences) > 1 and not can_join:
            # ★黙って一本調子へ落とさない。なぜそうなったかを残す
            print('ffmpeg が無いので抑揚を付けられません（1回で合成します）', flush=True)
        words = asyncio.run(_synth(body, voice or DEFAULT_VOICE,
                                   rate or DEFAULT_RATE, out_path))
        duration = words[-1]['end'] if words else 0.0

    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
        raise TtsUnavailable('音声を生成できませんでした（ファイルが空）。')

    # ★WordBoundary が1つも来ないことがある（記号だけの本文など）。
    #   その場合は音声だけ使い、字幕は呼び出し側で均等割りへ降りる。
    return {'path': out_path, 'words': words, 'duration': duration}


def _synth_by_sentence(sentences, voice, rate, out_path):
    """
    文ごとに合成して繋ぐ。戻り値は (単語の列, 実尺)。

    ★★**mp3のまま繋がない。** mp3はフレーム単位でエンコーダの詰め物が入るので、
      文ごとに数十ミリ秒ずつ積もり、後半ほど字幕がずれる。
      wavへ直して繋ぎ、**最後に1回だけ**mp3へ落とす。

    ★★単語の時刻は文ごとに0秒始まりで返ってくる。
      **デコード後の実尺**（_audio_seconds）で繰り下げる。
      ここを間違えると全字幕がずれるので、検査で最終単語と実尺を突き合わせる。
    """
    work = tempfile.mkdtemp(prefix='tts_prosody_')
    try:
        wavs = []
        words = []
        offset = 0.0
        for i, s in enumerate(sentences):
            p = prosody_for(i, len(sentences), s)
            mp3 = os.path.join(work, 'seg%02d.mp3' % i)
            seg = asyncio.run(_synth(s, voice or DEFAULT_VOICE,
                                     rate or p['rate'], mp3, p['pitch'],
                                     p.get('volume', DEFAULT_VOLUME)))
            raw = os.path.join(work, 'raw%02d.wav' % i)
            _run(['ffmpeg', '-v', 'error', '-y', '-i', mp3,
                  '-ar', '24000', '-ac', '1', raw])

            # ★前後の無音を落とす。積もると継ぎ目が1秒近い空白になる
            head, tail = _speech_bounds(raw)
            wav = os.path.join(work, 'seg%02d.wav' % i)
            _run(['ffmpeg', '-v', 'error', '-y', '-i', raw,
                  '-ss', '%.3f' % head, '-to', '%.3f' % tail,
                  '-c:a', 'pcm_s16le', wav])
            dur = _audio_seconds(wav)

            # ★★切った頭のぶん、その文の単語時刻を**前へずらす**。
            #   忘れると字幕が音声より遅れて出る。
            for w in seg:
                words.append({'text': w['text'],
                              'start': round(max(0.0, w['start'] - head) + offset, 3),
                              'end': round(max(0.0, w['end'] - head) + offset, 3)})
            print('  文%d: %s rate=%s pitch=%s vol=%s → %.2f秒（無音を頭%.2f/尻%.2f切除）'
                  % (i + 1, s[:18], rate or p['rate'], p['pitch'],
                     p.get('volume', DEFAULT_VOLUME), dur,
                     head, _audio_seconds(raw) - tail), flush=True)
            offset += dur
            wavs.append(wav)
            # ★文の切れ目に、こちらが決めた長さの間を入れる（最後の文の後には入れない）
            if i < len(sentences) - 1:
                gap = os.path.join(work, 'gap%02d.wav' % i)
                _run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
                      '-i', 'anullsrc=r=24000:cl=mono',
                      '-t', '%.3f' % GAP_SECONDS, '-c:a', 'pcm_s16le', gap])
                wavs.append(gap)
                offset += GAP_SECONDS

        lst = os.path.join(work, 'list.txt')
        with open(lst, 'w', encoding='utf-8') as f:
            for w in wavs:
                f.write("file '%s'\n" % w.replace("'", "'\\''"))
        _run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0',
              '-i', lst, '-c:a', 'libmp3lame', '-q:a', '4', out_path])
        return words, offset
    finally:
        shutil.rmtree(work, ignore_errors=True)


# 日本語の1枚あたりの文字数。語ではなく文字で区切る（下の説明）。
JA_CHARS_PER_CHUNK = 9


def _is_cjk(text):
    return re.search(r'[\u3040-\u30ff\u3400-\u9fff]', str(text or '')) is not None


SENTENCE_END = '。！？!?'


def sentence_end_after(words, text):
    """
    「この語の直後が文の終わりか」を、**元の本文と突き合わせて**返す。
    戻り値は words と同じ長さの真偽値のリスト。

    ★★なぜ本文と突き合わせるのか（2026-09-10・決定#126）。

      決定#119では `w['text']` の末尾が 。！？ かどうかで判定していた。
      ところが **edge-tts の WordBoundary は句読点を返さない**。
      「安すぎん」「ペット」…と、句読点の落ちた語だけが並ぶ。
      つまりその判定は**一度も真にならず、文またぎは直っていなかった**。

      本番の動画で確認した実害:
        「…しんどくない？」＋「これ置くだけで」 → 「ないこれ」
        「…安すぎん？」  ＋「ペットの毛も」   → 「は安すぎん」「ペットの」

      ★検査（check_group_words.py）は句読点を**含む**語を自分で組み立てて
        渡していたので通っていた。
        「検査が通った ≠ 検査が本物の入力を読んだ」の形。

    ★TTSが句読点を返す実装もあり得るので**両方**見る。
      本文が渡らなかった回は従来どおり語の末尾だけで判定する。
    """
    flags = [bool(re.search(r'[%s]$' % SENTENCE_END, str(w.get('text') or '')))
             for w in words]
    if not text:
        return flags

    src = str(text)
    pos = 0
    for i, w in enumerate(words):
        t = str(w.get('text') or '')
        if not t:
            continue
        # ★語を本文の中で追う。見つからない回は文字数ぶん進めて先へ行く
        #   （TTSが読みを正規化することがある。そこで止めない）
        found = src.find(t, pos)
        pos = found + len(t) if found >= 0 else min(len(src), pos + len(t))
        # 直後の空白を飛ばし、文末記号が続いていればそこが文の終わり
        j = pos
        while j < len(src) and src[j].isspace():
            j += 1
        if j < len(src) and src[j] in SENTENCE_END:
            flags[i] = True
            while j < len(src) and src[j] in SENTENCE_END:
                j += 1   # 「！？」のように続く回もあるのでまとめて飛ばす
            pos = j
    return flags


def _merge_short_tails(groups, ends, words):
    """
    文末で切った結果できた**極端に短い枚**を、前の枚へ戻す（決定#126）。

    ★文末で必ず切ると、「…しんどくない？」の末尾が「ない」だけの枚になる。
      2文字が0.3秒だけ光って消えるのは読めないし、目障りでもある。
    ★戻してよいのは**同じ文の中**だけ。文をまたいで繋ぐと、
      せっかく直した文またぎが復活する。
    ★繋いだ結果が長くなりすぎないこと。字幕側は16文字まで2行に収める
      のを保証しているので、その内側に収める。
    """
    if len(groups) < 2:
        return groups
    limit = JA_CHARS_PER_CHUNK + 3          # 12文字。字幕側の保証(16)の内側
    min_len = 3                             # これ未満の枚は単独で出さない
    index = {id(w): i for i, w in enumerate(words)}

    out = [groups[0]]
    for grp in groups[1:]:
        n = sum(len(w['text']) for w in grp)
        prev = out[-1]
        # ★前の枚の最後の語が文末なら、この枚は**次の文**。繋いではいけない
        crosses = ends[index[id(prev[-1])]]
        if (n < min_len and not crosses
                and sum(len(w['text']) for w in prev) + n <= limit):
            prev.extend(grp)
            continue
        out.append(grp)
    return out


def group_words(words, per_chunk=3, text=None):
    """
    単語を「画面に一度に出す塊」へまとめる。

    ★1枚3語。MrBeast系の字幕がこの単位で出るのは、
      視線を動かさずに一目で読めるのがこの長さだから。

    ★塊の中の単語ごとの時刻は保持する。カラオケの塗り替えに使う。

    ★★日本語（2026-09-02）は語数ではなく文字数で区切る。
      日本語の WordBoundary は「この」「扇風機」「は」のように短い語で
      来るので、3語だと1枚に4〜5文字しか載らず、切り替えが速すぎて
      読めない。文字数で JA_CHARS_PER_CHUNK を超えたら次の枚へ送る。
      語の途中では切らない（時刻は語単位でしか取れない）。

    ★text には**元のナレーション本文**を渡す。文の切れ目の判定に使う
      （決定#126。TTSは句読点を返さないので、語だけでは判定できない）。
    """
    out = []
    groups = []
    cjk = bool(words) and _is_cjk(''.join(w['text'] for w in words))
    if cjk:
        ends = sentence_end_after(words, text)
        cur = []
        for i, w in enumerate(words):
            # ★句読点だけの語は前の枚に付ける。「！」1文字だけの枚を作らない
            punct = not re.search(r'[0-9A-Za-z\u3040-\u30ff\u3400-\u9fff]', w['text'])
            if (cur and not punct
                    and sum(len(x['text']) for x in cur) + len(w['text']) > JA_CHARS_PER_CHUNK):
                groups.append(cur)
                cur = []
            cur.append(w)
            # ★★文の終わりで必ず区切る（2026-09-10・決定#119）。
            #   ここが無いと、依頼側が文ごとに割ってくれた字幕を
            #   一度つなげてから9文字で刻み直すため、
            #     「ステーションに消えてく。」＋「ゴミ捨ての不快感から」
            #       → 「に消えてくゴミ捨て」
            #   のように**文をまたぐ枚**ができる。実際に本番で出た。
            # ★判定そのものは決定#126で直した（上の sentence_end_after）
            if ends[i]:
                groups.append(cur)
                cur = []
        if cur:
            groups.append(cur)
        groups = _merge_short_tails(groups, ends, words)
    else:
        n = max(1, int(per_chunk))
        groups = [words[i:i + n] for i in range(0, len(words), n)]
    """
    ★★語のつなぎ方（2026-09-10・決定#119）。

    **日本語は空白で繋がない。** 前の版は言語を問わず ' '.join だったため、
    edge-tts の WordBoundary（「値段」「は」「安すぎ」…）がそのまま
      「値段 は 安すぎ ん」
    と**単語のあいだに空白が入った字幕**になっていた。実際の動画で確認。
    日本語は分かち書きしないので、これは誤りであるうえ、
    空白のぶん1枚が約2割広くなり、行が余計に折り返されていた。

    ★英語は空白で繋ぐ（分かち書きするので当然）。
    """
    sep = '' if cjk else ' '
    for grp in groups:
        if not grp:
            continue
        out.append({
            'text': sep.join(w['text'] for w in grp),
            'start': grp[0]['start'],
            'end': grp[-1]['end'],
            # 単語ごとの持ち時間（センチ秒）。ASSの \k へそのまま渡せる
            'word_cs': [max(1, int(round((w['end'] - w['start']) * 100))) for w in grp]
        })
    return out


if __name__ == '__main__':
    import json
    import sys
    ap_text = sys.argv[1] if len(sys.argv) > 1 else 'that landing had no business working'
    ap_out = sys.argv[2] if len(sys.argv) > 2 else 'narration.mp3'
    try:
        r = synthesize(ap_text, ap_out)
        print(json.dumps({'duration': r['duration'],
                          'chunks': group_words(r['words'])},
                         ensure_ascii=False, indent=2))
    except TtsUnavailable as e:
        print('TTS を使えません: %s' % e)
        sys.exit(1)
