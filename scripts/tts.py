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

# 100ナノ秒 → 秒
TICKS_PER_SECOND = 10_000_000

# 既定の声。落ち着きすぎない、短い動画に合う声を選ぶ
DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural'

# 読み上げ速度。ショート動画は少し速い方がテンポに合う
DEFAULT_RATE = '+12%'


class TtsUnavailable(Exception):
    """edge-tts が使えない。呼び出し側は字幕なしへ降りる。"""


def _require_edge_tts():
    try:
        import edge_tts  # noqa: F401
        return edge_tts
    except Exception as e:
        raise TtsUnavailable('edge-tts を読み込めません: %s' % e)


async def _synth(text, voice, rate, out_path):
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
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary='WordBoundary')

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


def synthesize(text, out_path, voice=None, rate=None):
    """
    本文を読み上げた音声ファイルを作り、単語ごとの時刻を返す。

    @return {'path': str, 'words': [{'text','start','end'}], 'duration': float}
    @raises TtsUnavailable 使えない場合。呼び出し側は必ず捕まえること
    """
    body = str(text or '').strip()
    if not body:
        raise TtsUnavailable('読み上げる本文が空です。')

    _require_edge_tts()

    words = asyncio.run(_synth(body, voice or DEFAULT_VOICE,
                               rate or DEFAULT_RATE, out_path))

    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
        raise TtsUnavailable('音声を生成できませんでした（ファイルが空）。')

    # ★WordBoundary が1つも来ないことがある（記号だけの本文など）。
    #   その場合は音声だけ使い、字幕は呼び出し側で均等割りへ降りる。
    duration = words[-1]['end'] if words else 0.0
    return {'path': out_path, 'words': words, 'duration': duration}


# 日本語の1枚あたりの文字数。語ではなく文字で区切る（下の説明）。
JA_CHARS_PER_CHUNK = 9


def _is_cjk(text):
    return re.search(r'[\u3040-\u30ff\u3400-\u9fff]', str(text or '')) is not None


def group_words(words, per_chunk=3):
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
    """
    out = []
    groups = []
    cjk = bool(words) and _is_cjk(''.join(w['text'] for w in words))
    if cjk:
        cur = []
        for w in words:
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
            if re.search(r'[。！？!?]$', str(w['text'])):
                groups.append(cur)
                cur = []
        if cur:
            groups.append(cur)
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
