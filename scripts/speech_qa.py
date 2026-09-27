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
# ★★カットの**言い終わり**で止める語（決定#178・2026-09-26）。
#   Veo は口語のセリフの後ろに「です」を足す。「のです」（9/25）に続き、自然な喋り（#176）でも
#   「着れるやつです」「かわいくないです」が出た。後者は**問いかけが否定に変わる**（意味が逆）。
#   文中の「です」（「頭まですっぽり」）は正しいので、**言い終わりだけ**を見る。
#   マリーの口調はタメ口なので、言い終わりの丁寧語は必ず誤り。
# ★「ください」も足す（2026-09-27。CTA が「リンクから見てみてください。」で通った。タメ口の子が急に敬語になる）
FORBID_END_DEFAULT = {'ja': ['です', 'ます', 'ですね', 'ますね', 'ください'], 'en': []}
# OCR を掛ける帯（画面の高さに対する割合）。Veo の焼き込み字幕は下に出た（E-033）。
# ★胸のプリント（商品の柄）は中央付近なので帯から外れる
OCR_BANDS = ((0.80, 1.00), (0.00, 0.12))
OCR_MIN_SCORE = 0.5
OCR_FRAMES_PER_PART = 3
# カット前後の無音を詰める（決定#179）。喋り始めの何秒前・喋り終わりの何秒後まで残すか。
# ★後ろを長めに残すのは、言い終わりの余韻（息・表情）を切ると不自然になるため
TRIM_LEAD = 0.10
TRIM_TAIL = 0.25
TRIM_MIN = 1.0
# 語をカットへ振り分ける時、カットの開始より何秒手前から「そのカットの語」とみなすか
WORD_START_SLACK = 0.15
# 日本語の字幕1枚の上限。手で書いていた字幕は最長14文字（「それ彼氏の？ってよく聞かれる」）
JA_MAX_CHARS = 16


def _norm(text, lang):
    """照合用に空白と句読点を落とす。英語は小文字へ。"""
    t = re.sub(r'[\s、。，．,.!?！？「」"\'…・ー〜~-]+', '', str(text))
    return t.lower() if lang == 'en' else t


_MODEL = None


def _model():
    """★1回の描画で何度も呼ぶ（カットごとの無音詰め＋全体の字幕）。読み込みは1回だけ"""
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel
        _MODEL = WhisperModel(WHISPER_MODEL, device='cpu', compute_type='int8')
    return _MODEL


def speech_window(words, clip_start, clip_len, lead=None, tail=None):
    """
    無音を詰めた切り出し範囲 (start, duration) を返す（決定#179・video-use の考え方）。

    ★喋り始めの TRIM_LEAD 秒前から、喋り終わりの TRIM_TAIL 秒後まで。
      語が取れない（喋っていない）カットは元の範囲のまま（映像だけのカットを消さない）。
    ★元の範囲の外へは出ない。短くなりすぎる時（TRIM_MIN 未満）も元のまま。
    @param words 切り出し範囲の頭を 0 とした語の時刻
    """
    lead = TRIM_LEAD if lead is None else lead
    tail = TRIM_TAIL if tail is None else tail
    if not words:
        return clip_start, clip_len
    a = max(0.0, words[0]['start'] - lead)
    b = min(clip_len, words[-1]['end'] + tail)
    if b - a < TRIM_MIN:
        return clip_start, clip_len
    return clip_start + a, b - a


# 言い終わりの丁寧語を切った時、最後の語の後ろに残す秒（TRIM_TAIL だと「で」の頭が残る）
POLITE_TAIL = 0.04
# ★切った音声を起こし直してまだ丁寧語が聞こえたら、この秒ずつ手前へ下げる（決定#189）。
#   Whisper の語の終わりは緩く、「楽です」の割合切りでは「で」の頭が残り「楽しいです」と聞こえた（run 36256567902）
POLITE_STEP = 0.05
POLITE_TRIES = 6


def ends_polite(text, lang):
    """文字列の言い終わりが丁寧語（FORBID_END_DEFAULT）か。check_speech と同じ基準（#189）"""
    n = _norm(text, lang)
    return bool(n) and any(n.endswith(_norm(e, lang)) for e in FORBID_END_DEFAULT.get(lang, []) if _norm(e, lang))


def polite_cut_ok(heard, kept, lang):
    """
    切った音声の聞こえ方が合格か（決定#189）。
    ★丁寧語が聞こえない、**かつ残したい最後の語（「楽」）が聞こえる**こと。
      0.12秒下げた回に「楽」まで消え「座っても」で終わる喋りが検査を通った（run 36276637562）。
      言いかけで終わる喋りは「です」より悪いので、通さない（切らずに検査へ任せる＝止まる）。
    """
    if not heard or not kept or strip_polite_end(heard, lang)[1]:
        return False
    return _norm(part_text(heard, lang), lang).endswith(_norm(kept[-1]['text'], lang))


def polite_cut_candidates(words):
    """丁寧語を外した語から、試す切り位置（最後の語の終わり）を手前へ POLITE_STEP ずつ並べる"""
    if not words:
        return []
    last = words[-1]
    return [max(last['start'] + 0.05, last['end'] - k * POLITE_STEP) for k in range(POLITE_TRIES)]


def strip_polite_end(words, lang):
    """
    言い終わりの丁寧語（FORBID_END_DEFAULT）を語の時刻から外す（決定#189）。
    ★Veo はタメ口のセリフの後ろに「です」を足す（4回目）。このままだと品質ゲートが
      動画ごと止め、Veo の費用が無駄になる。セリフの計画に丁寧語は無いので、外せば計画どおりに戻る。
    ★「楽です」のように1語へ繋がった時は、文字数の割合で切る位置を決める（決まった規則）。
    ★全部が丁寧語（喋りが「です」だけ）なら外さない（カットが消える）。
    @return (外した後の語, 外したか)。時刻は受け取った words と同じ時間軸
    """
    ends = sorted(FORBID_END_DEFAULT.get(lang, []), key=len, reverse=True)
    if not words or not ends:
        return words, False
    whole = _norm(part_text(words, lang), lang)
    hit = next((e for e in ends if whole.endswith(_norm(e, lang)) and len(whole) > len(_norm(e, lang))), None)
    if not hit:
        return words, False
    left = len(_norm(hit, lang))
    out = [dict(w) for w in words]
    while out and left > 0:
        w = out[-1]
        n = len(_norm(w['text'], lang))
        if n <= left:
            out.pop()
            left -= n
            continue
        keep = n - left
        w['end'] = w['start'] + (w['end'] - w['start']) * keep / n
        w['text'] = _norm(w['text'], lang)[:keep]
        left = 0
    return (out, True) if out else (words, False)


def transcribe(audio_path, lang):
    """
    @return [{'text','start','end'}] 語ごと。区間の時刻は audio_path の時間軸。
    """
    model = _model()
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


def transcribe_parts(part_audio, windows, lang, transcribe_fn=None):
    """
    カットごとの音声を1本ずつ文字起こしし、完成品の時間軸へずらして返す [[語...], ...]。

    ★★繋いだ音声を1回で起こして時刻で振り分けると、無音を詰めた回（#179）は
      カットの間が0.35秒しか無く、Whisper が次のカットの1語目の開始を前の無音へ
      はみ出させる。run 36227562528 で全カットの頭の1文字が前のカットへ落ちた
      （「…すっぽり被れちゃうんだよね袖」「楽です気」）。カットの音声を別々に起こせば
      語がカットをまたぐことは起きない。
    """
    fn = transcribe_fn or transcribe
    out = []
    for path, (st, _end) in zip(part_audio, windows):
        out.append([dict(w, start=w['start'] + st, end=w['end'] + st) for w in fn(path, lang)])
    return out


CUT_PAD = 0.15   # カット番号で指定したカード・パネルを、切れ目から少し内側へ置く


def timed_by_cut(items, windows, pad=CUT_PAD):
    """
    cut_index（clips の添字）で指定したカード・パネルへ、実際の秒を入れて返す（決定#182）。

    ★無音を詰める（#179）と各カットの長さは描画するまで分からない。秒で書かせると
      依頼側が2回描画して測る羽目になった（v3b→v3c）。カット番号なら描画側で解ける。
    ★cut_index の無い物は秒指定のまま通す。範囲外の番号は捨てる（別のカットに出さない）。
    """
    out = []
    for it in items or []:
        if 'cut_index' not in it:
            out.append(it)
            continue
        k = int(it['cut_index'])
        if not 0 <= k < len(windows):
            continue
        st, en = windows[k]
        out.append(dict(it, start=round(st + pad, 3), end=round(max(st + pad, en - pad), 3)))
    return out


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


# ★同じ読みで漢字だけ違う取り違え（決定#180）。run 36225782849 で「ガチで盛れる」が
#   「ガチで漏れる」と字幕に出た。音（もれる）は合っていて、Whisper が辞書で多い方の
#   漢字を選んだだけ。字幕の表記だけ直し、check_speech には掛けない（音の誤りを隠さない）。
#   ★台本の俗語（process-job #179）のうち、読みが同じ別の語がある物だけを置く。
JA_CAPTION_FIX = {'漏れる': '盛れる', '漏れた': '盛れた', '漏れて': '盛れて'}


def fix_caption_text(caps, lang):
    if lang != 'ja':
        return caps
    for c in caps:
        for wrong, right in JA_CAPTION_FIX.items():
            c['text'] = c['text'].replace(wrong, right)
        # ★カットごとに起こすと Whisper が「。」「、」を付ける（run 36227979886）。
        #   縦型の字幕に句点は置かず、末尾の読点も落とす（文中の読点は区切りとして残す）
        c['text'] = c['text'].replace('。', '').rstrip('、')
    return caps


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
    return fix_caption_text(caps, lang)


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
        for e in FORBID_END_DEFAULT.get(lang, []):
            if n and n.endswith(_norm(e, lang)):
                issues.append('カット%d: 言い終わりが丁寧語「%s」（タメ口のはず・意味が変わりうる） → 「%s」'
                              % (i + 1, e, said))
                break
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
