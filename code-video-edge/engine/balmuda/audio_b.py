# BALMUDA の音：声（1.15倍）＋静かな BGM（84bpm・ピアノ風の粒と温かいパッド）＋効果音。全て合成（外部の音源なし）
import json, subprocess, numpy as np
from scipy.io import wavfile
src = open("audio.py").read().split("# ---------------- 声 ----------------")[0]
g = {}; exec(src, g)
SR, FF = g["SR"], g["FF"]
TL = json.load(open("p2/timeline_b.json")); EV, C, END = TL["ev"], TL["cuts"], TL["end"]
N = int((END + 0.6) * SR)
def stereo(): return np.zeros((2, N))
def put(bus, x, t, gain=1.0, pan=0.0):
    i = int(t * SR); x = x[: max(0, N - i)] * gain
    bus[0, i:i + len(x)] += x * (1 - max(0, pan)); bus[1, i:i + len(x)] += x * (1 + min(0, pan))
def decode(path, tempo):
    raw = subprocess.run([FF, "-v", "error", "-i", path, "-af", f"atempo={tempo},highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=80",
                          "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)
# 声
voice = stereo()
for v in TL["voice"]:
    x = decode(f"p2/assets/line{v['line']}.mp3", v["tempo"]); put(voice, x, v["start"], 0.9)
env = np.abs(voice[0]); env = g["lp"](env, 6, 2); env = np.clip(env / (env.max() + 1e-9) * 3, 0, 1)
# BGM：Dmaj9 → Bm9 → Gmaj7 → A6（2小節ずつ）。粒は8分で、和音の音を上下に
BPM = TL["bpm"]; B = 60 / BPM
prog = [[62, 66, 69, 73, 76], [59, 62, 66, 69, 73], [55, 59, 62, 66, 71], [57, 61, 64, 66, 69]]
f = lambda m: 440 * 2 ** ((m - 69) / 12)
music = stereo(); t = 0.0; k = 0
while t < END + 0.5:
    ch = prog[(k // 8) % 4]
    if k % 8 == 0: put(music, g["pad"]([f(m - 12) for m in ch[:4]], 8 * B + 0.5, 0.5), t, 0.30)
    if k % 2 == 0: put(music, g["bass"](f(ch[0] - 24), 0.9, 0.55), t, 0.32)
    note = ch[[0, 2, 4, 3, 1, 3, 2, 4][k % 8]] + (12 if k % 16 >= 8 else 0)
    put(music, g["pluck"](f(note), 0.45 + 0.15 * (k % 2 == 0)), t, 0.22, pan=0.25 * np.sin(k))
    t += B / 2; k += 1
music = g["reverb"](music, 2.4, 0.38)
music *= (1 - 0.72 * env)                                          # 声の間は下がる
fade = np.clip(np.arange(N) / (0.6 * SR), 0, 1) * np.clip((END + 0.4 - np.arange(N) / SR) / 1.2, 0, 1)
music *= fade
# 効果音
sfx = stereo()
put(sfx, g["riser"](1.2, 0.5), 0.0, 0.25)
put(sfx, g["whoosh"](0.9, 160, 2400, 0.6), 1.45, 0.45)              # 一気に引く
put(sfx, g["impact"](0.6, 1.6), 2.1, 0.32)
for tt in (3.1, 6.95, 9.95, 12.75, 17.5, 20.55):                     # カメラの大きな移動
    put(sfx, g["whoosh"](0.7, 220, 3200, 0.5), tt, 0.32, pan=0.2)
for i in range(3): put(sfx, g["tock"](420 + 60 * i, 0.6), EV[f"c2_cup{i}"], 0.35)   # カップ
put(sfx, g["glide"](1.0, 600, 260, 0.4), EV["c3_line0"], 0.18)      # 注ぎの線
put(sfx, g["bell"](1174.66, 0.7, 2.2), EV["c4_ding"], 0.32)         # 輪が一周
put(sfx, g["tick"](2600, 0.5), EV["c5_arrow"], 0.3); put(sfx, g["shimmer"](0.9, 0.6), EV["c5_new"], 0.25)
for i in (0, 1): put(sfx, g["tock"](300, 0.6), EV[f"c6_chip{i}"], 0.35)
put(sfx, g["shimmer"](1.1, 0.7), EV["c6_glint"], 0.22); put(sfx, g["shimmer"](1.1, 0.7), C[6] + 1.0, 0.22)
put(sfx, g["tock"](360, 0.7), C[6] + 0.08, 0.4); put(sfx, g["shimmer"](1.0, 0.7), C[6] + 0.25, 0.25)   # ランキングのカード
put(sfx, g["whoosh"](0.6, 260, 3600, 0.5), C[6] + 1.75, 0.3)                                          # C7 の中の切り替え
put(sfx, g["whoosh"](0.5, 300, 2600, 0.45), C[2] + 1.05, 0.28)                                        # 実写へ
put(sfx, g["bell"](1567.98, 0.6, 1.8), C[6] + 2.8, 0.28)
sfx = g["reverb"](sfx, 1.6, 0.25) * (1 - 0.5 * env)
mix = voice * 1.0 + music * 0.55 + sfx * 0.6
mix /= np.abs(mix).max() / 0.8
wavfile.write("p2/mix_b.wav", SR, mix.T.astype(np.float32))
subprocess.run([FF, "-v", "error", "-y", "-i", "p2/mix_b.wav", "-af", "loudnorm=I=-14:TP=-1.5:LRA=7", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "p2/audio_b.m4a"], check=True)
print("audio ok", END)
# 点検：喋っている間、声が BGM＋効果音より何dB上か
bed = music * 0.55 + sfx * 0.6; m = env > 0.5
r = lambda x: 20 * np.log10(np.sqrt(np.mean(x[:, m] ** 2)) + 1e-12)
print("声と背景の差（喋っている間）: %.1f dB" % (r(voice) - r(bed)))
