#!/usr/bin/env python3
"""
字幕の「1枚のまとめ方」を検証する（決定#119）。

★実物の tts.py から group_words を読み込む。写しを持たない。

【何を守るか】
  1. 日本語は**空白で繋がない**（「値段 は 安すぎ ん」になっていた）
  2. **文をまたがない**（「ステーションに消えてく。」＋「ゴミ捨ての…」が
     つながって「に消えてくゴミ捨て」という枚ができていた）
  3. 英語は空白で繋ぐ（分かち書きするので）
  4. 1枚が JA_CHARS_PER_CHUNK を大きく超えない
  5. 時刻が壊れない（start <= end、順番が保たれる）

使い方: python3 scripts/check_group_words.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from tts import (  # noqa: E402
    JA_CHARS_PER_CHUNK,
    JA_CHUNK_MIN,
    LEADING_NG,
    group_words,
    sentence_end_after,
    _split_by_score,
)

fail = 0


def ok(cond, label, extra=""):
    global fail
    print(("  OK   " if cond else " ★NG  ") + label + (("  " + str(extra)) if extra else ""))
    if not cond:
        fail += 1


def words(*pairs):
    """(text, start, end) の並びから語の列を作る"""
    return [{"text": t, "start": s, "end": e} for t, s, e in pairs]


print("=== 日本語は空白で繋がない ===")
w = words(("値段", 0.0, 0.3), ("は", 0.3, 0.4), ("安すぎ", 0.4, 0.8), ("ん", 0.8, 0.9))
g = group_words(w)
ok(all(" " not in c["text"] for c in g), "空白が入らない", [c["text"] for c in g])
ok("".join(c["text"] for c in g) == "値段は安すぎん", "文字が欠けない", [c["text"] for c in g])

print("\n=== 文をまたがない（本番で出た形の再現）===")
w = words(
    ("ステーション", 0.0, 0.6), ("に", 0.6, 0.7), ("消えて", 0.7, 1.1), ("く", 1.1, 1.2),
    ("。", 1.2, 1.25),
    ("ゴミ", 1.3, 1.6), ("捨て", 1.6, 1.9), ("の", 1.9, 2.0), ("不快感", 2.0, 2.5),
    ("から", 2.5, 2.7),
)
g = group_words(w)
texts = [c["text"] for c in g]
print("   →", texts)
ok(not any("。" in t and not t.endswith("。") for t in texts),
   "「。」が枚の途中に来ない（＝文をまたいでいない）", texts)
ok(any(t.endswith("。") for t in texts), "文の終わりで区切れている")

"""
★★ここからが本物の入力の形（2026-09-10・決定#126）。

上の検査は「。」を**語として自分で組み立てて**渡していた。ところが
**edge-tts の WordBoundary は句読点を返さない**。つまり上の検査は
本番に存在しない入力を検査しており、決定#119の修正が効いていない
ことに気づけなかった。実際の動画では文またぎが出続けていた。

  「…しんどくない？」＋「これ置くだけで」 → 「ないこれ」
  「…安すぎん？」  ＋「ペットの毛も」   → 「は安すぎん」「ペットの」

★句読点の**無い**語の列と、元の本文を渡して検査する。
"""
print("\n=== 句読点の無い語＋本文（edge-tts が実際に返す形）===")
NARRATION = "夜中にゴミ捨てへ行くの、正直しんどくない？これ置くだけでゴミを勝手に吸い上げてくれる。"
w = words(
    ("夜中", 0.0, 0.3), ("に", 0.3, 0.4), ("ゴミ", 0.4, 0.7), ("捨て", 0.7, 1.0),
    ("へ", 1.0, 1.1), ("行く", 1.1, 1.4), ("の", 1.4, 1.5),
    ("正直", 1.5, 1.9), ("しんどく", 1.9, 2.4), ("ない", 2.4, 2.7),
    ("これ", 2.8, 3.1), ("置く", 3.1, 3.4), ("だけ", 3.4, 3.7), ("で", 3.7, 3.8),
    ("ゴミ", 3.8, 4.1), ("を", 4.1, 4.2), ("勝手", 4.2, 4.6), ("に", 4.6, 4.7),
    ("吸い", 4.7, 5.0), ("上げて", 5.0, 5.4), ("くれる", 5.4, 5.9),
)
g = group_words(w, text=NARRATION)
texts = [c["text"] for c in g]
print("   →", texts)
ok(not any("ないこれ" in t for t in texts), "「ないこれ」が出ない（本番で出た形）", texts)
ok(any(t.endswith("ない") for t in texts), "「…ない」で1枚が終わる（？の位置で切れている）", texts)
ok("".join(texts) == "".join(x["text"] for x in w), "文字が欠けない")

"""
★★**この検査が本物であることを、その場で確かめる。**

以前はここで「本文を渡さなければ文またぎが起きるはず」と、**結果**で
確かめていた。ところが決定#136で割り方を点数式にしたら、本文が無くても
たまたま同じ位置で切れるようになり、この canary が鳴らなくなった。
**たまたま通ることがある検査は、検査ではない。**

→ 結果ではなく**仕組み**を見る。「文の切れ目は本文から来ている」を直接
  確かめる。edge-tts の語には句読点が無いので、本文が無ければ
  文の切れ目は**1つも見つからないはず**である。
"""
ends_with_text = sentence_end_after(w, NARRATION)
ends_no_text = sentence_end_after(w, None)
ok(any(ends_with_text), "本文を渡すと文の切れ目が見つかる",
   [x["text"] for x, e in zip(w, ends_with_text) if e])
ok(not any(ends_no_text),
   "本文が無いと文の切れ目は1つも見つからない（＝句読点だけの判定は効かない）")

"""
★★決定#136。**助詞・語尾の断片から始まる枚を作らない。**

実測（job gen135 の描画）で出ていた形:
  「これ、床に置いとくだけでいい。」→「これ床に」「置いとく」「だけでいい」
  「勝手に吸って、勝手に基地に戻る。」→「って勝手」「に吸って」
声と合っていても、**目では読めない**。
"""
print("\n=== 行頭が助詞・語尾の断片にならない（決定#136）===")
CASES = [
    ("これ、床に置いとくだけでいい。勝手に出てって、勝手に吸って、勝手に基地に戻る。",
     ["これ", "床", "に", "置い", "とく", "だけ", "で", "いい",
      "勝手", "に", "出", "て", "って", "勝手", "に", "吸っ", "て",
      "勝手", "に", "基地", "に", "戻る"]),
    ("毛もホコリも、朝起きたら消えてる。自分で掃除したっていう感覚が、もう無いんよ。",
     ["毛", "も", "ホコリ", "も", "朝", "起き", "たら", "消え", "てる",
      "自分", "で", "掃除", "し", "た", "って", "いう", "感覚", "が",
      "もう", "無い", "ん", "よ"]),
    ("ただ、値段だけはここで言えない。見た瞬間ちょっと固まったから、プロフに置いとくね。",
     ["ただ", "値段", "だけ", "は", "ここ", "で", "言え", "ない",
      "見", "た", "瞬間", "ちょっと", "固まっ", "た", "から",
      "プロフ", "に", "置い", "とく", "ね"]),
]
for narration, toks in CASES:
    t = 0.0
    ws = []
    for tok in toks:
        ws.append({"text": tok, "start": t, "end": t + 0.1 * len(tok)})
        t += 0.1 * len(tok)
    g = group_words(ws, text=narration)
    texts = [c["text"] for c in g]
    print("   →", " / ".join(texts))
    """
    ★行頭の語は、まとめた後の文字列からは分からない（「とくだけ」の
      先頭が「と」なのか「とく」なのかは、語の列を見ないと決まらない）。
      なので**割り方を決めている当人**（_split_by_score）に直接聞く。
    """
    ends_c = sentence_end_after(ws, narration)
    heads = []
    sent = []
    for x, e in zip(ws, ends_c):
        sent.append(x)
        if e:
            heads += [grp[0]["text"] for grp in _split_by_score(sent)]
            sent = []
    if sent:
        heads += [grp[0]["text"] for grp in _split_by_score(sent)]
    ok(not any(h in LEADING_NG for h in heads),
       "行頭が助詞・語尾の断片でない", [h for h in heads if h in LEADING_NG] or heads)
    ok("".join(texts) == "".join(toks), "文字が欠けない")
    """
    ★短すぎる枚も作らない。ただし**1文がそれより短い**回は仕方がない
      （「はい。」だけの文を無理に他の文と繋いだら文またぎになる）。
    """
    ends = sentence_end_after(ws, narration)
    sent_lens = []
    n = 0
    for x, e in zip(ws, ends):
        n += len(x["text"])
        if e:
            sent_lens.append(n)
            n = 0
    if n:
        sent_lens.append(n)
    shortest_sentence = min(sent_lens)
    short = [x for x in texts if len(x) < JA_CHUNK_MIN]
    ok(not short or shortest_sentence < JA_CHUNK_MIN,
       f"{JA_CHUNK_MIN}文字未満の枚を作らない", short)

"""
★★この検査も、その場で本物か確かめる。
  点数から「行頭が助詞」の罰を外したら、上の検査は落ちるはずである。
"""
import tts as _tts  # noqa: E402
_saved = _tts.LEADING_NG
_tts.LEADING_NG = ()
narration, toks = CASES[0]
t = 0.0
ws = []
for tok in toks:
    ws.append({"text": tok, "start": t, "end": t + 0.1 * len(tok)})
    t += 0.1 * len(tok)
ends_off = sentence_end_after(ws, narration)
heads_off = []
sent = []
for x, e in zip(ws, ends_off):
    sent.append(x)
    if e:
        heads_off += [grp[0]["text"] for grp in _tts._split_by_score(sent)]
        sent = []
if sent:
    heads_off += [grp[0]["text"] for grp in _tts._split_by_score(sent)]
_tts.LEADING_NG = _saved
ok(any(h in LEADING_NG for h in heads_off),
   "罰を外すと行頭に助詞が出る（＝この検査は本当に効いている）", heads_off)

print("\n=== 英語は空白で繋ぐ ===")
w = words(("STOP", 0.0, 0.4), ("SCROLLING", 0.4, 1.0), ("NOW", 1.0, 1.3))
g = group_words(w)
ok(all(" " in c["text"] or len(c["text"].split()) == 1 for c in g), "空白で繋がれている",
   [c["text"] for c in g])
ok("".join(c["text"] for c in g).replace(" ", "") == "STOPSCROLLINGNOW", "語が欠けない")

print("\n=== 1枚の長さ ===")
w = words(*[(("あ" * 3), i * 0.3, i * 0.3 + 0.3) for i in range(10)])
g = group_words(w)
longest = max(len(c["text"]) for c in g)
ok(longest <= JA_CHARS_PER_CHUNK + 3, f"1枚が {JA_CHARS_PER_CHUNK}+3 文字以内", f"最長 {longest}")

print("\n=== 時刻が壊れない ===")
w = words(("これ", 0.0, 0.3), ("は", 0.3, 0.4), ("テスト", 0.4, 0.9), ("です", 0.9, 1.2),
          ("。", 1.2, 1.25), ("次", 1.3, 1.5), ("の", 1.5, 1.6), ("文", 1.6, 1.8))
g = group_words(w)
ok(all(c["start"] <= c["end"] for c in g), "start <= end")
ok(all(g[i]["end"] <= g[i + 1]["start"] + 1e-9 for i in range(len(g) - 1)), "枚の順番が保たれる",
   [(c["start"], c["end"]) for c in g])

print("\n=== 異常系 ===")
ok(group_words([]) == [], "語が0件でも落ちない")
g = group_words(words(("。", 0.0, 0.1)))
ok(len(g) == 1 and g[0]["text"] == "。", "句読点1つだけでも落ちない", g)

print("\n合格" if fail == 0 else f"\n★不合格 {fail}件")
sys.exit(0 if fail == 0 else 1)
