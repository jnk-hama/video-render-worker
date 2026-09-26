#!/usr/bin/env python3
"""
喋った内容から字幕を作り、喋り・絵の不具合で止める（決定#177・2026-09-26）。

【なぜ要るか（E-033）】
字幕を台本から作っていたので、Veo が言い足した「そう」「やつね」や、
崩れた発音（色落ち加工→「色打ち加工」、character→「care」）が
**字幕と音声の食い違い**として出ていた。画面下に Veo が勝手に描いた
意味不明の文字も、人が全コマを見るまで気づけなかった。

【やること】
  1. transcribe()        … 繋いだ音声を faster-whisper で文字起こし（語ごとの時刻つき）
  2. captions_from_words … その語から字幕を組む（tts.group_words を使い回す）
  3. check_speech()      … 言ってはいけない言い回し／言うべき語が言えているか
  4. find_burned_text()  … 画面の上下の帯に文字が焼き込まれていないか（OCR）

★確率で揺れない設定にする: temperature=0（再サンプリングしない）、beam 固定。
★字幕の区切り方は TTS の回と同じ関数（tts.group_words）を使う。二重に持たない。
"""

import os
import re
import subprocess

WHISPER_MODEL = 'large-v3'
WHISPER_BEAM = 5
# 喋りの言語ごとに、既定で言ってはいけない言い回し（オーナー指摘 2026-09-25）
# ★「なのです」「出るのです」: Veo が「〜の。」の後ろに足す誤用。マリーの口調ではない
# ★★架空の体験談・反響（決定#178）。Veo は自然な喋り（#176）で言い足すことがあるので、
#   台本の検査（jmas-ai-os の findFakeTestimony）とは別に、**口から出た言葉**も見る。
#   話し手（マリー）は実在しないので、体験も他人の反応も事実として言えない。
FORBID_DEFAULT = {
    'ja': ['のです', 'よく聞かれ', 'って聞かれ', 'って言われ', '褒められ', 'ほめられ',
           '買ってよかった', '使ってみたら', '毎日着てる', '愛用'],
    'en': ['keeps asking', 'keep asking', 'people ask me', 'everyone asks',
           "i've been wearing", "i've been using", 'i bought', 'compliments'],
}
# OCR を掛ける帯（画面の高さに対する割合）。Veo の焼き込み字幕は下に出た（E-033）。
# ★胸のプリント（商品の柄）は中央付近なので帯から外れる
OCR_BANDS = ((0.80, 1.00), (0.00, 0.12))
OCR_MIN_SCORE = 0.5
OCR_FRAMES_PER_PART = 3
# 語をカットへ振り分ける時、カットの開始より何秒手前から「そのカットの語」とみなすか
WORD_START_SLACK = 0.15
# 日本語の字幕1枚の上限。手で書いていた字幕は最長14文字（「それ彼氏の？ってよく聞かれる」）
JA_MAX_CHARS = 16


def _norm(text, lang):
    """照合用に空白と句読点を落とす。英語は小文字へ。"""
    t = re.sub(r'[\s、。，．,.!?！？「」"\'…・ー〜~-]+', '', str(text))
    return t.lower() if lang == 'en' else t


def transcribe(audio_path, lang):
    """
    @return [{'text','start','end'}] 語ごと。区間の時刻は audio_path の時間軸。
    """
    from faster_whisper import WhisperModel
    model = WhisperModel(WHISPER_MODEL, device='cpu', compute_type='int8')
    segs, _info = model.transcribe(
        audio_path, language=lang, word_timestamps=True,
        beam_size=WHISPER_BEAM, temperature=0.0, vad_filter=False,
        condition_on_previous_text=False)
    words = []
    for s in segs:
        for w in (s.words or []):
            t = str(w.word).strip()
            if t:
                words.append({'text': t, 'start': float(w.start), 'end': float(w.end)})
    return words


def part_windows(durations, trans):
    """
    各パートが完成品のどこに来るか [(start, end)]。
    ★xfade/acrossfade と同じ数え方: k本目の開始 = 先頭k本の合計 - k*重なり
    """
    out = []
    acc = 0.0
    for i, d in enumerate(durations):
        st = acc - i * trans
        out.append((max(0.0, st), st + d))
        acc += d
    return out


def words_by_part(words, windows):
    """
    語を「その語が言い始められたカット」へ振り分ける。語は1つも捨てない。

    ★★真ん中の時刻で振ると、重なり（crossfade）の中で言い始めた次のカットの
      1語目が前のカットに入った（実データ: 「萌」が「大きさなのです」側へ。
      check_speech_qa.py で検出）。**開始時刻がそのカットの開始以降なら
      そのカット**、とする。前のカットの語尾は重なりの前に言い始めているので混ざらない。
    ★★さらに WORD_START_SLACK だけ手前から数える。Whisper は語の開始を20〜30ms
      早めに置くことがあり、本番（run 36211844791）で「萌」「リ」が前のカットへ落ち、
      「リンクが聞き取れない」と**誤って止めた**。カットは喋り終わり＋0.3秒で切るので、
      次のカットの直前 0.15秒に前のカットの語が始まることは無い。
    """
    starts = [w0 for w0, _ in windows]
    parts = [[] for _ in windows]
    for w in words:
        k = 0
        for i, st in enumerate(starts):
            if w['start'] >= st - WORD_START_SLACK:
                k = i
        parts[k].append(w)
    return parts


def part_text(ws, lang):
    return (' ' if lang == 'en' else '').join(w['text'] for w in ws)


def _ja_chunks(ws):
    """
    日本語の1カットを、JA_MAX_CHARS 以下になるまで**一番長い間**で割る。

    ★★tts.group_words を使わない理由: あれは TTS の語（「値段」「は」）を前提に
      点数で割る。Whisper の日本語は**1〜2文字ずつ**来るので、同じ関数に渡すと
      「こな／れ感」のように語の途中で割れた（実データ・check_speech_qa.py）。
    ★割る場所の優先順（上から。全部決め打ちなので毎回同じ結果になる）:
      1. 句読点の直後
      2. 長い間（息継ぎ）
      3. ひらがな → 漢字/カタカナ に変わる所（文節の切れ目になりやすい。「よく｜聞かれる」）
      4. 真ん中に近い所
      ★large-v3 の語の時刻は隙間なく並ぶことが多く、2だけでは「そうよ｜く」と割れた（実データ）。
    """
    text = ''.join(w['text'] for w in ws)
    if len(text) <= JA_MAX_CHARS or len(ws) < 2:
        return [ws]
    mid = len(ws) / 2.0

    def score(i):
        a, b = ws[i]['text'], ws[i + 1]['text']
        gap = ws[i + 1]['start'] - ws[i]['end']
        punct = a[-1] in '、。，！？!?'
        script = _is_hira(a[-1]) and (_is_kanji(b[0]) or _is_kata(b[0]))
        return (punct, round(gap, 1), script, -abs(i + 1 - mid))

    i = max(range(len(ws) - 1), key=score)
    return _ja_chunks(ws[:i + 1]) + _ja_chunks(ws[i + 1:])


def _is_hira(c):
    return 'ぁ' <= c <= 'ゟ'


def _is_kata(c):
    return '゠' <= c <= 'ヿ'


def _is_kanji(c):
    return '一' <= c <= '鿿'


def _caption(ws, sep):
    return {
        'text': sep.join(w['text'] for w in ws),
        'start': ws[0]['start'],
        'end': ws[-1]['end'],
        # ASS の \k へ渡す語ごとの持ち時間（センチ秒）。tts.group_words と同じ形
        'word_cs': [max(1, int(round((w['end'] - w['start']) * 100))) for w in ws],
    }


def captions_from_words(parts, lang, group_words):
    """
    パートごとの語から字幕を組む。
    ★パートの境目は必ず字幕の境目にする（別のカットの言葉を1枚に混ぜない）。
    ★英語は TTS の回と同じ group_words（語数で割る）。日本語は _ja_chunks（上の理由）。
    """
    caps = []
    for ws in parts:
        if not ws:
            continue
        if lang == 'en':
            caps.extend(group_words(ws, text=part_text(ws, lang)))
        else:
            caps.extend(_caption(c, '') for c in _ja_chunks(ws))
    return caps


def check_speech(parts, clips, lang, forbid=None):
    """
    @return 問題のリスト（空なら合格）。各要素は人が読める1行。
    ★forbid を渡さなければ言語の既定（FORBID_DEFAULT）を使う。
    ★must_say はパートごと。文字列か、言い換えの候補のリスト。
    """
    issues = []
    forbid = FORBID_DEFAULT.get(lang, []) if forbid is None else forbid
    for i, ws in enumerate(parts):
        said = part_text(ws, lang)
        n = _norm(said, lang)
        for f in forbid:
            if _norm(f, lang) and _norm(f, lang) in n:
                issues.append('カット%d: 言ってはいけない「%s」を言っている → 「%s」'
                              % (i + 1, f, said))
        spec = clips[i] if i < len(clips) else {}
        for must in (spec.get('must_say') or []):
            alts = must if isinstance(must, list) else [must]
            if not any(_norm(a, lang) in n for a in alts if _norm(a, lang)):
                issues.append('カット%d: 「%s」が聞き取れない → 実際は「%s」'
                              % (i + 1, ' / '.join(map(str, alts)), said or '（無音）'))
    return issues


def find_burned_text(part_paths, ocr=None):
    """
    各パートの上下の帯に文字が無いか見る。@return [(カット番号, 秒, 読めた文字, 確からしさ)]
    ★パートは字幕を焼く前のものを渡すこと（自分の字幕を拾わない）。
    ★inset で切り落とした後のパートを見るので、切れば通る。
    """
    import numpy as np
    from PIL import Image
    if ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        ocr = RapidOCR()
    hits = []
    for i, p in enumerate(part_paths):
        dur = _duration(p)
        for k in range(OCR_FRAMES_PER_PART):
            t = dur * (k + 1) / (OCR_FRAMES_PER_PART + 1)
            png = p + '.ocr%d.png' % k
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', '%.3f' % t, '-i', p,
                            '-frames:v', '1', png], check=True)
            im = np.array(Image.open(png).convert('RGB'))
            os.remove(png)
            h = im.shape[0]
            for a, b in OCR_BANDS:
                res, _ = ocr(im[int(h * a):int(h * b)])
                for _box, txt, sc in (res or []):
                    if float(sc) >= OCR_MIN_SCORE and len(str(txt).strip()) >= 2:
                        hits.append((i + 1, round(t, 2), str(txt), round(float(sc), 2)))
    return hits


def _duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    try:
        return float(out.strip())
    except ValueError:
        return 0.0
