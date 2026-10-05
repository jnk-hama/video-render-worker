# 設計書（product.json）と声の長さ（実測）から時刻表を作る。絵と音の唯一の出どころ
import json, re, subprocess, sys, os
FF = os.environ.get("FFMPEG") or subprocess.check_output(["python3", "-c", "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())"]).decode().strip()
TEMPO = 1.15          # 喋りの速さ（video-render-worker の SPEECH_SPEED と同じ）
LEAD = 0.25           # カットの頭から喋り始めまで
TAIL = {"cover": 0.55, "counter": 0.6, "macro_broll": 0.6, "ring": 0.7, "compare": 0.7, "chips": 0.55, "finale": 1.6,
        "problem": 0.75, "airflow": 0.7, "slash": 0.8, "colors": 0.7,
        "hook": 0.55, "chips": 0.6, "cells": 0.75, "bars": 0.7, "explode": 1.0}
MIN = {"explode": 6.2}   # 分解は動きの段取りが決まっている（最後の文字が1秒以上読める長さ）

def speech_end(path):
    """喋りの終わり（最後の無音の始まり）。末尾に無音が無ければ全体の長さ"""
    err = subprocess.run([FF, "-hide_banner", "-i", path, "-af", "silencedetect=n=-40dB:d=0.12", "-f", "null", "-"], capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", err)]
    dur = float(re.search(r"Duration: (\d+):(\d+):([0-9.]+)", err).groups()[2])
    return starts[-1] if starts and starts[-1] > 0.5 else dur

def build(product_path, asset_dir, out):
    P = json.load(open(product_path)); t = 0.0; beats = []
    for b in P["beats"]:
        s = speech_end(os.path.join(asset_dir, "voice", b["voice"]))
        d = max(LEAD + s / TEMPO + b.get("tail", TAIL[b["kind"]]), MIN.get(b["kind"], 0))
        beats.append({"kind": b["kind"], "t0": round(t, 3), "t1": round(t + d, 3), "voice": {"file": b["voice"], "start": round(t + LEAD, 3), "tempo": TEMPO, "len": round(s / TEMPO, 3)}})
        t += d
    tl = {"cuts": [b["t0"] for b in beats], "end": round(t, 3), "beats": beats, "voice": [b["voice"] for b in beats], "bpm": P.get("music", {}).get("bpm", 96)}
    json.dump(tl, open(out, "w"), ensure_ascii=False, indent=1)
    print("長さ %.2f秒 / カット %s" % (t, [b["t0"] for b in beats]))
    if not 15 <= t <= 21: print("★注意：15〜20秒の型（#267）から外れています")

if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], sys.argv[3])
