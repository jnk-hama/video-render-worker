# 分解シーンの効果音だけ（試作）。音の部品は audio.py の関数をそのまま使う
import numpy as np
from scipy.io import wavfile
src = open("audio.py").read().split("# ---------------- 声 ----------------")[0]
g = {}; exec(src, g)
SR, D = g["SR"], 6.2
bus = np.zeros((2, int(D * SR)))
def put(x, t, gain=1.0, pan=0.0):
    i = int(t * SR); x = x[: bus.shape[1] - i] * gain
    bus[0, i:i + len(x)] += x * (1 - max(0, pan)); bus[1, i:i + len(x)] += x * (1 + min(0, pan))
put(g["whoosh"](0.9, 180, 2600, 0.7), 0.05, 0.5)          # 寄り
put(g["tock"](260, 1.0), 1.0, 0.9); put(g["tick"](3400, 0.6), 1.03, 0.5)   # カップが外れる「カチッ」
put(g["glide"](0.7, 300, 900, 0.6), 1.5, 0.35)             # フィルターが出てくる
put(g["whoosh"](0.8, 400, 5200, 0.6), 2.0, 0.45, 0.2)      # 見せ場へ
put(g["impact"](0.7, 1.4), 2.8, 0.55)                       # 見出し
put(g["shimmer"](0.9, 0.8), 2.75, 0.4)                      # 光の走り
put(g["bell"](1318.5, 0.6, 1.4), 3.1, 0.3)
put(g["tock"](220, 0.8), 3.35, 0.6)
put(g["whoosh"](0.35, 800, 6000, 0.5), 4.0, 0.35, -0.2)
put(g["bell"](1567.98, 0.7, 1.6), 4.3, 0.32); put(g["shimmer"](0.8, 0.7), 4.3, 0.3)
bus = g["reverb"](bus, 1.4, 0.22)
bus /= max(1e-9, np.abs(bus).max()) / 0.7
wavfile.write("filter_sfx.wav", SR, bus.T.astype(np.float32)); print("ok", bus.shape)
