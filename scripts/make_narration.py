#!/usr/bin/env python3
"""
ナレーション音声と、単語同期の字幕を作る。

    python3 scripts/make_narration.py --payload payload.json \
        --audio narration.mp3 --out payload_with_audio.json

【なぜ切り出したか】
ffmpeg版（render_video.py）はTTSを内部で回すが、Remotion版は音声ファイルを
外から受け取る形にしている。両方から同じ手順を呼べるように、TTSと
字幕の割り付けだけをここへ出した。**同じ台本から同じ音声・同じ字幕時刻**を
作れるので、2つの描画方式を並べて比べられる。

★字幕の時刻はTTSが返した実測値を使う。文字数からの推定へ降りるのは
  WordBoundary が1つも来なかった時だけで、その場合はログに明記する。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tts import JA_CHARS_PER_CHUNK, TtsUnavailable, group_words, synthesize  # noqa: E402


def log(msg):
    print(msg, flush=True)


def narration_text(job):
    """台本からナレーション本文を組み立てる。"""
    if job.get("narration"):
        return str(job["narration"])
    # Remotion版の台本には narration が無いので、字幕を繋いで作る
    return "".join(str(c.get("text") or "") for c in (job.get("captions") or []))


def fallback_captions(text, duration):
    """
    TTSが単語の時刻を返さなかった時の予備。

    ★9文字ずつに割る。1シーン1枚にすると25文字前後になり、描画側が
      画面幅に収めるため文字を半分まで縮める（実測して直した）。
    """
    chunks = [text[i:i + JA_CHARS_PER_CHUNK]
              for i in range(0, len(text), JA_CHARS_PER_CHUNK)]
    if not chunks or duration <= 0:
        return []
    per = duration / len(chunks)
    return [{"text": c,
             "start": round(i * per, 2),
             "end": round((i + 1) * per, 2)}
            for i, c in enumerate(chunks)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", required=True)
    ap.add_argument("--audio", default="narration.mp3")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    raw = json.load(open(args.payload, encoding="utf-8"))
    job = raw.get("job") if isinstance(raw.get("job"), dict) else raw

    text = narration_text(job)
    if not text.strip():
        log("ナレーション本文が空です。音声は作りません。")
        json.dump(raw, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
        return

    voice = job.get("voice") or "ja-JP-NanamiNeural"
    try:
        r = synthesize(text, args.audio, voice=voice)
    except TtsUnavailable as e:
        # ★ここで落とさない。音声なしでも動画は出す（既存の方針と揃える）
        log("TTSを使えません（無音で続行）: %s" % e)
        json.dump(raw, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
        return

    duration = float(r.get("duration") or 0)
    words = r.get("words") or []

    if words:
        chunks = group_words(words)
        captions = [{"text": c["text"],
                     "start": round(float(c["start"]), 2),
                     "end": round(float(c["end"]), 2)} for c in chunks]
        log("字幕 %d枚（TTSの実測時刻）" % len(captions))
    else:
        captions = fallback_captions(text, duration)
        log("★WordBoundaryが返らなかったため、%d枚を均等割りにしました（推定）"
            % len(captions))

    job["narrationUrl"] = args.audio
    job["captions"] = captions

    # シーンの尺を音声に合わせて引き伸ばす。合計が音声より短いと絵が先に終わる
    scenes = job.get("scenes") or []
    total = sum(float(s.get("seconds") or 0) for s in scenes)
    if scenes and duration > 0 and total > 0 and abs(total - duration) > 0.2:
        k = duration / total
        for s in scenes:
            s["seconds"] = round(float(s["seconds"]) * k, 3)
        log("シーンの尺を音声に合わせました: %.2f秒 → %.2f秒" % (total, duration))

    """
    ★★2026-09-05、**既存形式（clips）でも同じ調整をする**ようにした。

    上の処理は scenes を持つ台本にしか効かない。ところが依頼側
    （process-job / GAS）が送ってくるのは今も clips 形式で、scenes へ
    変換するのは描画の直前（render.mjs の adaptLegacyPayload）である。
    つまり**本番の経路では一度も効いていなかった**。

    実行#41でそれが出た:
      音声 21.14秒 ／ 台本: 5シーン / 30.0秒
    ナレーションが21秒で終わり、残り9秒が無音のまま流れる。
    30秒のうち3割が無言の動画は、最後まで見られない。

    clip_seconds（全シーン共通）と clips[].duration（個別指定）の
    両方を同じ比率で伸縮させる。★どちらが使われるかは描画側が決めるので、
    片方だけ直すと不整合になる。
    """
    clips = job.get("clips") or []
    if not scenes and clips and duration > 0:
        each = float(job.get("clip_seconds") or 0)
        total = sum(float(c.get("duration") or each) for c in clips)
        if total > 0 and abs(total - duration) > 0.2:
            k = duration / total
            if each:
                job["clip_seconds"] = round(each * k, 3)
            for c in clips:
                if c.get("duration"):
                    c["duration"] = round(float(c["duration"]) * k, 3)
            log("シーンの尺を音声に合わせました: %.2f秒 → %.2f秒（clips形式）"
                % (total, duration))

    json.dump(raw, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
    log("音声 %.2f秒 / %s" % (duration, args.audio))


if __name__ == "__main__":
    main()
