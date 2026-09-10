#!/usr/bin/env python3
"""
抑揚を付けた合成（決定#127）を、**音声を作らずに**検査する。

【何を守るか】
  1. 文の分け方で文字が欠けない
  2. 設定の割り当てが決定的（同じ台本なら毎回同じ）
  3. **文を繋いだ後の単語時刻がずれない** ← ここが最大のリスク
  4. ffmpeg が無い環境では黙って一本調子へ落ちる（落ちたことを言う）

★★3が壊れると、字幕が**全部**ずれる。しかも動画は正常に出来上がるので、
  見るまで気づかない（E-010 と同じ壊れ方）。だからここだけは
  実物の _synth を差し替えて、繋ぎの計算そのものを検査する。

使い方: python3 scripts/check_tts_prosody.py
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tts  # noqa: E402

fail = 0


def ok(cond, label, extra=""):
    global fail
    print(("  OK   " if cond else " ★NG  ") + label + (("  " + str(extra)) if extra else ""))
    if not cond:
        fail += 1


NARRATION = (
    "夜中にゴミ捨てへ行くの、正直しんどくない？"
    "これ置くだけでゴミを勝手に吸い上げてくれる。"
    "この機能でこの価格は安すぎん？"
    "ペットの毛も毎日ちゃんと消えてく。"
    "正確な値段はプロフに載せといたよ。"
)

print("=== 文の分け方 ===")
sents = tts.split_sentences(NARRATION)
print("   →", sents)
ok(len(sents) == 5, "5文に分かれる", len(sents))
ok("".join(sents) == NARRATION, "文字が1つも欠けない")
ok(all(s.strip() for s in sents), "空の文ができない")

print("\n=== 設定の割り当て ===")
p = [tts.prosody_for(i, len(sents), s) for i, s in enumerate(sents)]
for i, (s, x) in enumerate(zip(sents, p)):
    print("   %d %-26s rate=%-6s pitch=%s" % (i + 1, s[:26], x["rate"], x["pitch"]))
ok(p[0] == tts.HOOK_PROSODY, "1文目は掴みの設定")
ok(p[2] == tts.QUESTION_PROSODY, "「安すぎん？」は疑問の設定")
ok(p[4] == tts.CLOSING_PROSODY, "最終文は締めの設定")
ok(p[1] == tts.BODY_PROSODY, "説明の文は従来のまま")
# 決定的であること（E-017）
ok(all(tts.prosody_for(i, len(sents), s) == p[i] for _ in range(20)
       for i, s in enumerate(sents)), "20回とも同じ割り当て")

print("\n=== 繋いだ後の単語時刻（最大のリスク）===")
"""
★実物の _synth を、**時刻を返すだけの偽物**へ差し替える。
  各文は 0秒始まりで単語を返し、音声は「その文の長さ」の無音とする。
  つまり期待値が計算で出せる。繋ぎの計算だけを純粋に検査できる。
"""
SEG_SECONDS = [2.0, 3.0, 1.5, 2.5, 2.0]
WORDS_PER_SEG = 3

if not (tts.shutil.which("ffmpeg") and tts.shutil.which("ffprobe")):
    print("  … ffmpeg が無いのでこの検査は飛ばします")
else:
    calls = []

    async def fake_synth(text, voice, rate, out_path, pitch=tts.DEFAULT_PITCH):
        i = len(calls)
        calls.append({"text": text, "rate": rate, "pitch": pitch})
        sec = SEG_SECONDS[i]
        # その長さちょうどの無音を書く（実物と同じ mp3 で作る）
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", "anullsrc=r=24000:cl=mono", "-t", "%.3f" % sec,
             "-c:a", "libmp3lame", "-q:a", "4", out_path],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        step = sec / WORDS_PER_SEG
        return [{"text": "w%d_%d" % (i, k),
                 "start": round(k * step, 3),
                 "end": round((k + 1) * step, 3)} for k in range(WORDS_PER_SEG)]

    real = tts._synth
    tts._synth = fake_synth
    try:
        out = os.path.join(tempfile.mkdtemp(prefix="chk_"), "out.mp3")
        words, duration = tts._synth_by_sentence(sents, None, None, out)
    finally:
        tts._synth = real

    ok(len(calls) == 5, "文の数だけ合成を呼ぶ", len(calls))
    ok([c["pitch"] for c in calls] == [x["pitch"] for x in p],
       "文ごとに違う pitch で呼んでいる", [c["pitch"] for c in calls])
    ok([c["rate"] for c in calls] == [x["rate"] for x in p],
       "文ごとに違う rate で呼んでいる", [c["rate"] for c in calls])

    ok(len(words) == 5 * WORDS_PER_SEG, "単語が全部残る", len(words))
    ok(all(words[i]["start"] <= words[i + 1]["start"] for i in range(len(words) - 1)),
       "時刻が単調に増える（繰り下げが効いている）")

    # ★2文目の先頭は、1文目の実尺のぶんだけ後ろにいるはず
    seg0 = tts._audio_seconds  # 実尺はデコード後で測る（詰め物込み）
    print("   合計 %.3f秒 / 最終単語 end=%.3f秒" % (duration, words[-1]["end"]))
    ok(abs(words[WORDS_PER_SEG]["start"] - SEG_SECONDS[0]) < 0.06,
       "2文目の先頭が1文目の実尺ぶん繰り下がっている",
       "%.3f vs %.3f" % (words[WORDS_PER_SEG]["start"], SEG_SECONDS[0]))

    # ★★最終単語が音声の中に収まっている。ここがずれると字幕が全部ずれる
    ok(words[-1]["end"] <= duration + 0.06,
       "最終単語が音声の尺を超えない",
       "end=%.3f / 尺=%.3f" % (words[-1]["end"], duration))
    ok(abs(duration - sum(SEG_SECONDS)) < 0.25,
       "合計の尺が各文の合計と一致する",
       "%.3f vs %.3f" % (duration, sum(SEG_SECONDS)))

    # ★出来た音声そのものを測る。計算だけ合っていても意味がない
    actual = tts._audio_seconds(out)
    ok(abs(actual - duration) < 0.25,
       "**実際に出来た音声**の尺が、報告した尺と一致する",
       "実測 %.3f / 報告 %.3f" % (actual, duration))

print("\n=== 1文だけの回・抑揚を切った回 ===")
ok(len(tts.split_sentences("これだけ。")) == 1, "1文なら1つ")
ok(tts.split_sentences("") == [], "空文字なら空")
ok(tts.split_sentences("句読点なしの文") == ["句読点なしの文"], "文末記号が無くても拾う")

print("\n合格" if fail == 0 else "\n★不合格 %d件" % fail)
sys.exit(0 if fail == 0 else 1)
