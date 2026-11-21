#!/usr/bin/env python3
# 使い方：python3.13 factory/pitchspread.py <声.mp3> …（直す前と後を並べて測る。合否の線は置かない＝一次情報の基準が無いので、前後の比較だけに使う・#380）
# 1行の声の高さの広がり（半音・10〜90パーセンタイル）と、句の間（無音 0.15秒以上）を測る。
#   考え方は JuneYaooo/rea-video（Apache-2.0）の prosody.py（「どう言ったかを数で」）。実装は自前（自己相関で基本周波数）
import subprocess, sys, numpy as np, imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()
def load(p, sr=16000):
    b = subprocess.run([FF, "-v", "error", "-i", p, "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True).stdout
    return np.frombuffer(b, np.int16).astype(np.float32) / 32768, sr
for p in sys.argv[1:]:
    x, sr = load(p); W, H = int(0.04 * sr), int(0.01 * sr); f0 = []; rms = []
    for i in range(0, len(x) - W, H):
        fr = x[i:i + W] - x[i:i + W].mean(); e = float(np.sqrt((fr ** 2).mean())); rms.append(e)
        if e < 0.02: continue
        ac = np.correlate(fr, fr, "full")[W - 1:]; lo, hi = sr // 500, sr // 120
        k = lo + int(np.argmax(ac[lo:hi])); 
        if ac[k] / ac[0] > 0.5: f0.append(sr / k)
    st = 12 * np.log2(np.array(f0) / np.median(f0)); sp = np.percentile(st, 90) - np.percentile(st, 10)
    rms = np.array(rms); sil = rms < 0.01; gaps = []; c = 0
    for s_ in sil:
        if s_: c += 1
        else:
            if c * 0.01 >= 0.15: gaps.append(round(c * 0.01, 2))
            c = 0
    print(f"{p.split('/')[-2]}/{p.split('/')[-1]}: 長さ {len(x)/sr:.2f}秒 高さの広がり {sp:.1f} 半音  間(0.15秒以上) {gaps}")
