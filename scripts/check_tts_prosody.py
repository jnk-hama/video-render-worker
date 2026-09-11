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

"""
★★**pitch の上げ幅に歯止めをかける**（2026-09-11）。

  「2割を超えると別人に聞こえ始める」とコメントに書いていたのに、
  その倍（実測 中央比±22%）を出して、オーナーに
  「突然ナレーター替えないで」と言われた。
  **コメントに書いた上限は上限ではない。** 機械で止める。

★pitch だけを見張る理由：rate と volume はいくら振っても同じ人のまま
  聞こえるが、pitch は声の同一性に直結する。
"""
def _hz(v):
    return abs(int(str(v).replace("Hz", "").replace("+", "") or 0))

worst = max(_hz(x["pitch"]) for x in
            (tts.HOOK_PROSODY, tts.QUESTION_PROSODY,
             tts.CLOSING_PROSODY, tts.BODY_PROSODY))
ok(worst <= tts.MAX_PITCH_HZ,
   "pitch の上げ幅が上限(%dHz)以内" % tts.MAX_PITCH_HZ,
   "最大 %dHz" % worst)
# 男性声(約140Hz)での比率。ここが2割を超えたら別人に聞こえる
ok(worst / 140.0 <= 0.20,
   "男性声(140Hz)に対して2割以内", "%.0f%%" % (worst / 140.0 * 100))
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
PAD = 0.30          # edge-tts が文の前後に付ける無音を模す
VOICED = [s - 2 * PAD for s in SEG_SECONDS]   # 切り落とした後に残る長さ

"""
★★飛ばしたら**不合格にする**（2026-09-11）。

  以前はここを黙って飛ばして「合格」と出していた。コンテナが作り直されて
  ffmpeg が消えた回に、**この検査（いちばん大事な繋ぎの計算）が1行も
  走っていないのに合格と表示された。** 自分で何度も書いている
  「検査が通った ≠ 検査が対象を読んだ」を、自分の検査でやった。

  CIには ffmpeg があるので本番の守りは効いているが、手元で
  「合格」と出ること自体が嘘なので、飛ばした回は落とす。
"""
if not (tts.shutil.which("ffmpeg") and tts.shutil.which("ffprobe")):
    ok(False, "ffmpeg/ffprobe が無いため繋ぎの検査を実行できませんでした"
              "（この検査は飛ばさない。入れてから再実行してください）")
else:
    calls = []

    async def fake_synth(text, voice, rate, out_path, pitch=tts.DEFAULT_PITCH,
                         volume=tts.DEFAULT_VOLUME):
        """
        ★edge-tts と**同じ形**の音を返す：前後に無音が付いた音声。
          こうしないと「前後の無音を切る」処理が検査されない。
          （実物の edge-tts は1回の合成ごとに前後へ無音を付ける。
            それが積もって継ぎ目が約1秒になっていた）
        """
        i = len(calls)
        calls.append({"text": text, "rate": rate, "pitch": pitch,
                      "volume": volume})
        sec = SEG_SECONDS[i]
        voiced = sec - 2 * PAD
        # 無音 + 音 + 無音。音は聞こえる強さのトーンにする
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y",
             "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
             "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=24000",
             "-filter_complex",
             "[0]atrim=0:%.3f[a];[1]atrim=0:%.3f,volume=0.5[b];"
             "[0]atrim=0:%.3f[c];[a][b][c]concat=n=3:v=0:a=1[out]"
             % (PAD, voiced, PAD),
             "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "4", out_path],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # ★単語は「音が鳴っている区間」に並ぶ（実物もそう）
        step = voiced / WORDS_PER_SEG
        return [{"text": "w%d_%d" % (i, k),
                 "start": round(PAD + k * step, 3),
                 "end": round(PAD + (k + 1) * step, 3)} for k in range(WORDS_PER_SEG)]

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
    # ★volume は後から足した。渡し忘れても音は出てしまうので必ず見張る
    ok([c["volume"] for c in calls] == [x.get("volume", tts.DEFAULT_VOLUME) for x in p],
       "文ごとに違う volume で呼んでいる", [c["volume"] for c in calls])

    ok(len(words) == 5 * WORDS_PER_SEG, "単語が全部残る", len(words))
    ok(all(words[i]["start"] <= words[i + 1]["start"] for i in range(len(words) - 1)),
       "時刻が単調に増える（繰り下げが効いている）")

    print("   合計 %.3f秒 / 最終単語 end=%.3f秒" % (duration, words[-1]["end"]))

    # ★1文目の先頭の単語は0秒付近。頭の無音ぶん前へずれているはず
    ok(words[0]["start"] < 0.08,
       "1文目の先頭が0秒付近（頭の無音ぶん前へずれている）",
       "%.3f" % words[0]["start"])

    # ★2文目の先頭 ＝ 1文目の実尺（無音を切った後）＋ 間
    want = VOICED[0] + tts.GAP_SECONDS
    ok(abs(words[WORDS_PER_SEG]["start"] - want) < 0.08,
       "2文目の先頭が「1文目の実尺＋間」の位置にある",
       "%.3f vs %.3f" % (words[WORDS_PER_SEG]["start"], want))

    # ★★最終単語が音声の中に収まっている。ここがずれると字幕が全部ずれる
    ok(words[-1]["end"] <= duration + 0.08,
       "最終単語が音声の尺を超えない",
       "end=%.3f / 尺=%.3f" % (words[-1]["end"], duration))

    want_total = sum(VOICED) + tts.GAP_SECONDS * (len(sents) - 1)
    ok(abs(duration - want_total) < 0.30,
       "合計の尺 ＝ 各文の実尺＋間",
       "%.3f vs %.3f" % (duration, want_total))

    # ★出来た音声そのものを測る。計算だけ合っていても意味がない
    actual = tts._audio_seconds(out)
    ok(abs(actual - duration) < 0.30,
       "**実際に出来た音声**の尺が、報告した尺と一致する",
       "実測 %.3f / 報告 %.3f" % (actual, duration))

    """
    ★★**継ぎ目の無音が積もっていないこと**（これが今回の直しの本体）。
      直す前は継ぎ目が 0.94〜1.07秒 あった。15秒の動画で4秒が無音だった。
    """
    r = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", out, "-af",
         "silencedetect=noise=%s:d=0.10" % tts.SILENCE_DB, "-f", "null", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    import re as _re
    gaps = [float(x) for x in _re.findall(r"silence_duration:\s*([\d.]+)", r.stdout)]
    longest = max(gaps) if gaps else 0.0
    print("   継ぎ目の無音: %s" % ([round(g, 2) for g in gaps] or "なし"))
    ok(longest < tts.GAP_SECONDS + 0.25,
       "継ぎ目の無音が積もっていない（1秒の空白が復活していない）",
       "最長 %.2f秒 / 設定 %.2f秒" % (longest, tts.GAP_SECONDS))

print("\n=== 1文だけの回・抑揚を切った回 ===")
ok(len(tts.split_sentences("これだけ。")) == 1, "1文なら1つ")
ok(tts.split_sentences("") == [], "空文字なら空")
ok(tts.split_sentences("句読点なしの文") == ["句読点なしの文"], "文末記号が無くても拾う")

print("\n合格" if fail == 0 else "\n★不合格 %d件" % fail)
sys.exit(0 if fail == 0 else 1)
