# 音：声（1.15倍）＋BGM（合成）＋効果音（カットの種類ごとに型の時刻と同じ所）。外部の音源は使わない
import json, subprocess, sys, os, numpy as np
from scipy.io import wavfile
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); import synth; g = vars(synth)
SR, FF = g["SR"], g["FF"]
product, asset_dir, tl_path, out = sys.argv[1:5]
P = json.load(open(product)); TL = json.load(open(tl_path)); Bs, END = TL["beats"], TL["end"]
N = int((END + 0.6) * SR)
def stereo(): return np.zeros((2, N))
def put(bus, x, t, gain=1.0, pan=0.0):
    i = int(t * SR); x = x[: max(0, N - i)] * gain
    bus[0, i:i + len(x)] += x * (1 - max(0, pan)); bus[1, i:i + len(x)] += x * (1 + min(0, pan))
def decode(path, tempo):
    raw = subprocess.run([FF, "-v", "error", "-i", path, "-af", f"atempo={tempo},highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=80",
                          "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)
voice = stereo()
for v in TL["voice"]: put(voice, decode(os.path.join(asset_dir, "voice", v["file"]), v["tempo"]), v["start"], 0.9)
env = np.abs(voice[0]); env = g["lp"](env, 6, 2); env = np.clip(env / (env.max() + 1e-9) * 3, 0, 1)
# BGM（型ごとに和音を変えられる・既定は落ち着いた長調）
B = 60 / TL.get("bpm", 96); f = lambda m: 440 * 2 ** ((m - 69) / 12)
prog = P.get("music", {}).get("prog") or [[62, 66, 69, 73, 76], [59, 62, 66, 69, 73], [55, 59, 62, 66, 71], [57, 61, 64, 66, 69]]
music = stereo(); t = 0.0; k = 0
while t < END + 0.5:
    ch = prog[(k // 8) % 4]
    if k % 8 == 0: put(music, g["pad"]([f(m - 12) for m in ch[:4]], 8 * B + 0.5, 0.5), t, 0.30)
    if k % 2 == 0: put(music, g["bass"](f(ch[0] - 24), 0.9, 0.55), t, 0.32)
    put(music, g["pluck"](f(ch[[0, 2, 4, 3, 1, 3, 2, 4][k % 8]] + (12 if k % 16 >= 8 else 0)), 0.45 + 0.15 * (k % 2 == 0)), t, 0.22, pan=0.25 * np.sin(k))
    t += B / 2; k += 1
if P.get("music", {}).get("style") == "beat":
    music = stereo(); M = P["music"]; arp = [0, 2, 1, 3, 2, 1, 3, 2]
    h0 = Bs[0]; kick_from = h0["voice"]["start"] + h0["voice"]["len"] * 0.5 if Bs[0]["kind"] == "hook" else 0
    for k, b in enumerate(Bs):
        notes, root = M["chords"][k % len(M["chords"])], M["roots"][k % len(M["roots"])]; ta, tb_ = b["t0"], (Bs[k + 1]["t0"] if k + 1 < len(Bs) else END + 0.6)
        put(music, g["pad"]([f(m) for m in notes], tb_ - ta + 0.5, 1.0), max(0, ta - 0.1), 0.34)
        for j in range(int(round((tb_ - ta) / B))):
            tq = ta + j * B; gi = int(round(tq / B))
            if tq >= kick_from - 0.01: put(music, g["kick"](1.0), tq, 0.40)
            if k >= 1:
                put(music, g["hat"](False, 0.8), tq + B / 2, 0.075 + 0.02 * (k >= 3))
                if k >= 3: put(music, g["hat"](False, 0.5), tq + B / 4, 0.04); put(music, g["hat"](False, 0.5), tq + 3 * B / 4, 0.04)
                put(music, g["bass"](f(root), 0.44), tq, 0.34)
                if j % 2 == 1: put(music, g["bass"](f(root + (7 if k % 2 else 12)), 0.30), tq + B * 0.75, 0.22)
                for hh in range(2): put(music, g["pluck"](f(notes[arp[(gi * 2 + hh) % 8] % len(notes)] + 24), 1.0), tq + hh * B / 2, 0.14 if hh else 0.10, pan=-0.4 if (gi + hh) % 2 else 0.4)
            if k >= 2 and gi % 2 == 1: put(music, g["snare_clap"](0.7), tq, 0.20)
    music = g["reverb"](music, 1.2, 0.14) * (1 - 0.64 * env); music *= np.clip(np.arange(N) / (0.6 * SR), 0, 1) * np.clip((END + 0.4 - np.arange(N) / SR) / 1.2, 0, 1)
else:
    music = g["reverb"](music, 2.4, 0.38) * (1 - 0.72 * env)
music *= np.clip(np.arange(N) / (0.6 * SR), 0, 1) * np.clip((END + 0.4 - np.arange(N) / SR) / 1.2, 0, 1)
# 効果音（型の時刻と同じ定数）
sfx = stereo()
for i, b in enumerate(Bs):
    t0, t1, kind, bp = b["t0"], b["t1"], b["kind"], P["beats"][i]
    if i: put(sfx, g["whoosh"](0.6, 240, 3600, 0.5), t0 - 0.3, 0.32, pan=0.2 * (-1) ** i)       # パネルのめくり
    if kind == "cover": put(sfx, g["riser"](1.0, 0.4), 0.0, 0.18); put(sfx, g["impact"](0.5, 1.4), t0 + 0.2, 0.25)
    if kind == "counter":
        put(sfx, g["riser"](1.0, 0.5), t0 + 0.35, 0.16)
        for k2 in range(bp.get("count", 0)): put(sfx, g["tock"](420 + 60 * k2, 0.6), t0 + 1.5 + k2 * 0.5, 0.35)
    if kind == "macro_broll": put(sfx, g["whoosh"](0.5, 300, 2600, 0.45), t0 + 1.05, 0.28)
    if kind == "ring": put(sfx, g["bell"](1174.66, 0.7, 2.2), min(t0 + 2.0, t1 - 0.6), 0.32)
    if kind == "compare":
        for k2 in range(len(bp["rows"]) + 1): put(sfx, g["tick"](2400 + 120 * k2, 0.4), t0 + 0.85 + k2 * 0.32, 0.22)
    if kind == "finale" and P["template"] == "editorial":
        PB = t0 + 1.96 if bp.get("ranking") else t0
        if bp.get("ranking"): put(sfx, g["tock"](360, 0.7), t0 + 0.08, 0.4); put(sfx, g["shimmer"](1.0, 0.7), t0 + 0.25, 0.25); put(sfx, g["whoosh"](0.6, 260, 3600, 0.5), PB - 0.3, 0.3)
        put(sfx, g["shimmer"](1.1, 0.7), PB + 0.4, 0.22); put(sfx, g["bell"](1567.98, 0.6, 1.8), PB + 0.8, 0.28)
    # ポップの型（時刻は pop.html の各カットと同じ定数）
    if kind == "problem" and i == 0: put(sfx, g["whoosh"](0.7, 200, 4200, 0.6), 0.0, 0.4)
    if kind == "airflow":
        put(sfx, g["riser"](1.1, 0.6), t0 - 0.9, 0.22); put(sfx, g["whoosh"](1.4, 900, 7000, 0.7), t0 + 0.1, 0.30); put(sfx, g["impact"](0.7, 1.2), t0 + 0.7, 0.32)
    if kind == "slash": put(sfx, g["whoosh"](0.25, 1200, 9000, 0.7), t0 + 1.25, 0.45); put(sfx, g["impact"](0.8, 1.0), t0 + 1.55, 0.35)
    if kind == "colors": put(sfx, g["whoosh"](0.5, 300, 3000, 0.5), t0 + 1.55, 0.3); put(sfx, g["shimmer"](0.9, 0.7), t0 + 1.95, 0.25)
    if kind == "finale" and P["template"] == "pop": put(sfx, g["tock"](420, 0.7), t0 + 0.15, 0.35); put(sfx, g["bell"](1567.98, 0.6, 1.8), t0 + 1.6, 0.28)
    # 紙の型（時刻は paper.html の各カットと同じ定数）
    if kind == "hook":
        wC = b["voice"]["start"] + b["voice"]["len"] * 0.5
        put(sfx, g["impact"](1.0), 0.25, 0.42); put(sfx, g["whoosh"](0.35, 1500, 6000, 1.0, 0.5), t0 + 0.22, 0.16, 0.3); put(sfx, g["shimmer"](0.9), 0.85, 0.2, 0.2)
        put(sfx, g["riser"](0.55, 1.0), wC - 0.55, 0.3); put(sfx, g["impact"](0.9, 1.3), wC, 0.34); put(sfx, g["snare_clap"](1.0), wC, 0.22)
    if P["template"] == "paper" and i: put(sfx, g["tock"](110, 1.0), t0 - 0.02, 0.5)
    if kind == "chips":
        put(sfx, g["tick"](1800), t0 + 0.12, 0.10)
        for k2, fq in enumerate([1318.5, 1568.0, 1975.5][: len(bp["chips"])]): put(sfx, g["bell"](fq, 1.0, 1.2), t0 + 0.75 + k2 * 0.5, 0.2, -0.25 + 0.25 * k2); put(sfx, g["tick"](2200 + 300 * k2), t0 + 1.9 + k2 * 0.16, 0.12, 0.3)
    if kind == "cells":
        n, r0 = bp.get("cells", 5), t0 + 0.85; r1 = min(t1 - 0.75, r0 + 1.4)   # paper.html と同じ
        for k2 in range(n):
            ti = r0 + k2 * ((r1 - r0) / (n - 0.4))
            if k2 < n - 1: put(sfx, g["tock"](300 + 40 * k2), ti, 0.3, -0.4 + 0.2 * k2)
            else: put(sfx, g["bell"](1568, 1.0, 1.4), ti, 0.22, 0.2); put(sfx, g["tock"](420), ti, 0.35)
        put(sfx, g["bell"](2093, 1.0, 1.4), r1, 0.16, 0.3)
    if kind == "bars":
        c0, c1 = t0 + 0.35, t0 + 1.55; put(sfx, g["shimmer"](0.8), t0 + 0.3, 0.16, 0.4)
        for k2 in range(1, 15):   # 数え上げ（outC の逆算＝表示が進む所で鳴る）
            put(sfx, g["tick"](2000 + 90 * k2), c0 + (c1 - c0) * (1 - (1 - k2 / 15) ** (1 / 3)), 0.13, -0.2)
        for k2 in range(len(bp["bars"])): put(sfx, g["whoosh"](0.3 + 0.08 * k2, 500, 3000 + 600 * k2, 1.0, 0.8), t0 + 1.65 + k2 * 0.5, 0.17, -0.3 + 0.6 * k2)
        put(sfx, g["bell"](1976, 1.0, 1.4), c1, 0.16, 0.2)
    if kind == "finale" and P["template"] == "paper":
        put(sfx, g["riser"](1.0, 1.0), t0 - 1.0, 0.24); put(sfx, g["impact"](0.8, 1.6), t0, 0.5); put(sfx, g["bell"](1568, 1.0, 1.6), t0 + 0.35, 0.18, -0.3)
        for k2 in range(1, 12): put(sfx, g["tick"](2300 + 60 * k2), t0 + 0.8 + 1.1 * (1 - (1 - k2 / 12) ** (1 / 3)), 0.10, 0.2)
        cta = t0 + 2.1; put(sfx, g["tock"](260), cta, 0.5); put(sfx, g["whoosh"](0.3, 600, 4200, 1.0, 0.7), cta - 0.22, 0.24)
        for fq, dl in [(1046.5, 0), (1318.5, 0.045), (1568.0, 0.09), (2093.0, 0.135)]: put(sfx, g["bell"](fq, 1.0, 2.2), cta + dl, 0.18, (dl - 0.07) * 4)
sfx = g["reverb"](sfx, 1.6, 0.25) * (1 - 0.5 * env)
if P["template"] == "paper": music *= 0.4; sfx *= 0.45   # 拍と効果音が多い型。声との差 9dB 以上を守る（#267-7）
mix = voice + music * 0.55 + sfx * 0.6; mix /= np.abs(mix).max() / 0.8
wav = out.replace(".m4a", ".wav"); wavfile.write(wav, SR, mix.T.astype(np.float32))
subprocess.run([FF, "-v", "error", "-y", "-i", wav, "-af", "loudnorm=I=-14:TP=-1.5:LRA=7", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", out], check=True)
bed = music * 0.55 + sfx * 0.6; m = env > 0.5
r = lambda x: 20 * np.log10(np.sqrt(np.mean(x[:, m] ** 2)) + 1e-12)
print(json.dumps({"voice_over_bed_db": round(r(voice) - r(bed), 1), "music_db": round(r(voice) - r(music * 0.55), 1), "sfx_db": round(r(voice) - r(sfx * 0.6), 1)}))
