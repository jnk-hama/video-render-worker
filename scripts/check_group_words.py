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
from tts import JA_CHARS_PER_CHUNK, group_words  # noqa: E402

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

本文を渡さなければ（＝決定#119のままの判定）文またぎが起きるはず。
起きなければ、この検査は何も見張っていないことになる。
"""
g_old = group_words(w)          # 本文を渡さない＝句読点だけで判定する古い挙動
texts_old = [c["text"] for c in g_old]
ok(any("ないこれ" in t for t in texts_old),
   "本文を渡さないと文をまたぐ（＝この検査は本当に効いている）", texts_old)

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
