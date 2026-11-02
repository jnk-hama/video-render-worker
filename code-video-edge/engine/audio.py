#!/usr/bin/env python3
"""音の組み立て。timeline.json（絵と同じ時刻表）から、声・BGM・効果音を作って1本にする。
外部の音源は使わない（権利の心配が無いよう、全て合成）。声だけ edge-tts（0円）。"""
import json, subprocess, sys, os
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
FF = os.environ.get("FFMPEG") or subprocess.check_output(["python3", "-c", "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())"]).decode().strip()
TL = json.load(open("timeline.json"))
EV, CUTS, END, TICKS = TL["ev"], TL["cuts"], TL["end"], TL["ticks"]
BEAT = 60 / TL["bpm"]
N = int((END + 1.0) * SR)
rng = np.random.default_rng(20261002)          # 乱数は固定（毎回同じ音）

def T(d): return np.arange(int(d * SR)) / SR
def sos(kind, f, order=4): return signal.butter(order, f, btype=kind, fs=SR, output="sos")
def lp(x, f, o=4): return signal.sosfilt(sos("low", f, o), x)
def hp(x, f, o=4): return signal.sosfilt(sos("high", f, o), x)
def bp(x, f0, f1, o=3): return signal.sosfilt(sos("band", [f0, f1], o), x)
def noise(d): return rng.standard_normal(int(d * SR))
def ex(d, tau): return np.exp(-T(d) / tau)
def fade(x, a=0.004, r=0.01):
    n = len(x); na, nr = int(a * SR), int(r * SR); g = np.ones(n)
    if na: g[:na] = np.linspace(0, 1, na)
    if nr: g[-nr:] = np.linspace(1, 0, nr)
    return x * g

class Bus:
    def __init__(self): self.b = np.zeros((2, N))
    def put(self, x, t0, gain=1.0, pan=0.0):
        i = int(round(t0 * SR));
        if i >= N or i + len(x) <= 0: return
        a = max(0, -i); x = x[a:]; i = max(0, i); x = x[: N - i]
        gl, gr = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        self.b[0, i:i + len(x)] += x * gain * gl * 1.4142; self.b[1, i:i + len(x)] += x * gain * gr * 1.4142

# ---------------- 部品 ----------------
def kick(vel=1.0):
    d = 0.38; t = T(d); f = 46 + 130 * np.exp(-t / 0.04); ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * np.exp(-t / 0.15) + 0.35 * lp(noise(d), 2500) * np.exp(-t / 0.004)
    return np.tanh(1.5 * x) * vel
def snare_clap(vel=1.0):
    d = 0.35; x = np.zeros(int(d * SR)); n = bp(noise(d), 900, 3800)
    for k, off in enumerate([0, 0.011, 0.023]): i = int(off * SR); x[i:] += n[: len(x) - i] * np.exp(-T(d)[: len(x) - i] / 0.012) * (0.7 + 0.3 * (k == 2))
    x += n * np.exp(-T(d) / 0.09) * 0.55
    return np.tanh(1.2 * x) * vel
def hat(open_=False, vel=1.0):
    d = 0.16 if open_ else 0.06; return hp(noise(d), 7500) * ex(d, 0.07 if open_ else 0.014) * vel
def impact(vel=1.0, d=2.0):
    t = T(d); f = 38 + 70 * np.exp(-t / 0.13); ph = 2 * np.pi * np.cumsum(f) / SR
    sub = np.sin(ph) * np.exp(-t / 0.62)
    burst = lp(noise(d), 4200) * np.exp(-t / 0.16) * 0.55
    air = hp(noise(d), 2500) * np.exp(-t / 0.35) * 0.18
    return np.tanh(1.3 * (sub + burst + air)) * vel
def whoosh(d=0.5, f0=250, f1=4500, vel=1.0, peak=0.62):
    t = T(d); x = t / d; f = f0 * (f1 / f0) ** x; ph = 2 * np.pi * np.cumsum(f) / SR
    n = lp(noise(d), 700) * np.cos(ph) * 2.0
    env = np.where(x < peak, np.sin(x / peak * np.pi / 2) ** 2, np.cos((x - peak) / (1 - peak) * np.pi / 2) ** 2)
    return fade(n * env, 0.01, 0.02) * vel
def tick(f=2600, vel=1.0):
    d = 0.05; t = T(d); return (np.sin(2 * np.pi * f * t) * np.exp(-t / 0.007) + 0.4 * hp(noise(d), 4000) * np.exp(-t / 0.002)) * vel
def tock(f=330, vel=1.0):
    d = 0.14; t = T(d); fr = f * (1 + 0.5 * np.exp(-t / 0.02)); ph = 2 * np.pi * np.cumsum(fr) / SR
    return np.sin(ph) * np.exp(-t / 0.05) * vel
def bell(f, vel=1.0, d=1.6):
    t = T(d); x = np.zeros(len(t))
    for r, w, tau in [(1, 1, .75), (2.0, .38, .42), (2.76, .22, .28), (4.1, .10, .16), (5.4, .06, .10)]:
        x += w * np.sin(2 * np.pi * f * r * t) * np.exp(-t / tau)
    return fade(x * np.minimum(1, t / 0.002), 0, 0.05) * vel
def shimmer(d=0.9, vel=1.0):
    t = T(d); x = np.zeros(len(t))
    for k, f in enumerate([2093, 2637, 3136, 3951, 4699]):
        x += np.sin(2 * np.pi * f * t + k) * np.exp(-((t - 0.28 - 0.05 * k) ** 2) / (2 * 0.12 ** 2)) / (1 + k * 0.4)
    return x * vel * 0.5
def riser(d=1.3, vel=1.0):
    t = T(d); x = t / d; f = 600 * (10000 / 600) ** x; ph = 2 * np.pi * np.cumsum(f) / SR
    n = lp(noise(d), 900) * np.cos(ph) * 2.0
    return fade(n * (x ** 2.2), 0.01, 0.01) * vel
def glide(d, f0, f1, vel=1.0):
    t = T(d); x = t / d; f = f0 + (f1 - f0) * x ** 1.5; ph = 2 * np.pi * np.cumsum(f) / SR
    return fade(np.sin(ph) * (0.5 + 0.5 * x) * (1 + 0.18 * np.sin(2 * np.pi * 9 * t)), 0.02, 0.05) * vel
def pad(freqs, d, vel=1.0):
    t = T(d); x = np.zeros(len(t))
    for f in freqs:
        for cents in (-9, 0, 9):
            x += signal.sawtooth(2 * np.pi * f * (2 ** (cents / 1200)) * t)
    x = lp(x, 1500, 3) / (len(freqs) * 3)
    env = np.minimum(1, t / 0.55) * np.minimum(1, (d - t) / 0.55)
    return x * env * vel
def pluck(f, vel=1.0):
    d = 0.5; t = T(d); mod = 2.4 * np.exp(-t / 0.05) * np.sin(2 * np.pi * f * t)
    return hp(np.sin(2 * np.pi * f * t + mod) * np.exp(-t / 0.22), 220) * vel
def bass(f, d=0.42, vel=1.0):
    t = T(d); x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t)
    return np.tanh(2.2 * x) * np.exp(-t / 0.3) * np.minimum(1, t / 0.006) * vel * 0.8

def reverb(bus, rt=1.5, mix=0.2, damp=5200):
    n = int(rt * 1.6 * SR); t = np.arange(n) / SR; out = np.zeros_like(bus)
    for c in range(2):
        ir = rng.standard_normal(n) * np.exp(-t / (rt / 6.9)); ir = lp(ir, damp, 2); ir[: int(0.018 * SR)] *= 0
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        out[c] = signal.fftconvolve(bus[c], ir)[: bus.shape[1]]
    return bus * (1 - mix * 0.3) + out * mix

# ---------------- 声 ----------------
def decode(path):
    raw = subprocess.run([FF, "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)
def speech_span(x):
    w = int(0.01 * SR); r = np.sqrt(np.convolve(x ** 2, np.ones(w) / w, "same")); thr = r.max() * 10 ** (-42 / 20)
    idx = np.where(r > thr)[0]; return max(0, idx[0] / SR - 0.03), idx[-1] / SR + 0.12
voice = Bus(); vmono = np.zeros(N)
for v in TL["voice"]:
    p = f"assets/line{v['line']}.mp3"; x = decode(p); s, e = speech_span(x)
    chain = (f"atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS,atempo={v['tempo']},highpass=f=85,"
             "equalizer=f=240:t=q:w=1:g=-1.5,equalizer=f=3200:t=q:w=1.1:g=2.6,equalizer=f=7600:t=q:w=1:g=1.0,"
             "acompressor=threshold=-27dB:ratio=3.2:attack=4:release=90:makeup=5,alimiter=limit=0.85")
    raw = subprocess.run([FF, "-loglevel", "error", "-i", p, "-af", chain, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
    y = np.frombuffer(raw, dtype=np.float32).astype(np.float64); y = fade(y, 0.006, 0.05)
    voice.put(y, v["start"], 1.0, 0.0); i = int(v["start"] * SR); vmono[i:i + len(y)] += np.abs(y)[: N - i]

# ---------------- 効果音（絵の出来事と同じ時刻） ----------------
sfx = Bus(); C = CUTS
sfx.put(impact(1.0), EV["slam"], 0.42)
sfx.put(whoosh(0.35, 1500, 6000, 1.0, 0.5), 0.0, 0.18, -0.4); sfx.put(whoosh(0.35, 1500, 6000, 1.0, 0.5), EV["wordB"], 0.16, 0.3)
sfx.put(shimmer(0.9), EV["sweep1"], 0.20, 0.2)
sfx.put(riser(0.55, 1.0), EV["wordC"] - 0.55, 0.30)
sfx.put(impact(0.9, 1.3), EV["wordC"], 0.34); sfx.put(snare_clap(1.0), EV["wordC"], 0.22)
for k in range(1, len(C)):
    sfx.put(whoosh(0.42, 280, 3600, 1.0, 0.7), C[k] - 0.40, 0.34, -0.5 if k % 2 else 0.5)
    sfx.put(tock(110, 1.0), C[k] - 0.02, 0.5)
for i, f in enumerate([1318.5, 1568.0, 1975.5]): sfx.put(bell(f, 1.0, 1.2), EV[f"chip{i}"], 0.20, -0.25 + 0.25 * i); sfx.put(tick(2200 + 300 * i), EV["leader"] + 0.16 * i, 0.12, 0.3)
sfx.put(tick(1800), EV["c2_head"], 0.10)
for i in range(5):
    ti = EV["rail0"] + i * ((EV["rail1"] - EV["rail0"]) / 4.6)
    if i < 4: sfx.put(tock(300 + 40 * i), ti, 0.30, -0.4 + 0.2 * i)
    else: sfx.put(bell(1568, 1.0, 1.4), ti, 0.22, 0.2); sfx.put(tock(420), ti, 0.35)
sfx.put(bell(2093, 1.0, 1.4), EV["c3_badge"], 0.16, 0.3)
sfx.put(shimmer(0.8), EV["c4_glint"], 0.16, 0.4)
for k, tt in enumerate(TICKS["c4"]): sfx.put(tick(2000 + 90 * k), tt, 0.13, -0.2)
sfx.put(whoosh(0.30, 500, 3000, 1.0, 0.8), EV["c4_bar0"] - 0.05, 0.16, -0.3); sfx.put(whoosh(0.38, 500, 3600, 1.0, 0.8), EV["c4_bar1"] - 0.05, 0.18, 0.3)
sfx.put(bell(1976, 1.0, 1.4), EV["c4_cnt1"], 0.16, 0.2)
sfx.put(whoosh(0.5, 400, 2800, 1.0, 0.6), EV["c5_bracket"], 0.18, 0.4)
for k, tt in enumerate(TICKS["c5"]): sfx.put(tick(2600 - 110 * k), tt, 0.13, 0.2)
sfx.put(tock(180, 1.0), EV["c5_num1"], 0.5); sfx.put(bell(1568, 1.0, 1.2), EV["c5_num1"], 0.15)
sfx.put(glide(EV["c6_ring1"] - EV["c6_ring0"], 330, 990, 1.0), EV["c6_ring0"], 0.11, -0.2)
for k in range(1, 7):
    p = k / 6; x = 0.5 + 0.5 * 0   # 絵のイージング(inOutC)の逆算
    lo, hi = 0.0, 1.0
    for _ in range(40):
        m = (lo + hi) / 2; v = 4 * m ** 3 if m < .5 else 1 - (-2 * m + 2) ** 3 / 2
        lo, hi = (m, hi) if v < p else (lo, m)
    tt = EV["c6_ring0"] + (EV["c6_ring1"] - EV["c6_ring0"]) * (lo + hi) / 2
    sfx.put(tick(2000 + 220 * k), tt, 0.10, 0.1)
sfx.put(bell(2093, 1.0, 1.8), EV["c6_ding"], 0.26); sfx.put(bell(2637, 1.0, 1.8), EV["c6_ding"] + 0.05, 0.16)
sfx.put(riser(1.0, 1.0), C[6] - 1.0, 0.24)
sfx.put(impact(0.8, 1.6), C[6], 0.50)
sfx.put(bell(1568, 1.0, 1.6), EV["c7_star0"] + 0.1, 0.18, -0.3)
for k, tt in enumerate(TICKS["c7"]): sfx.put(tick(2300 + 60 * (k % 10)), tt, 0.10, -0.2 if k < 8 else 0.2)
cta = EV["c7_cta"]
sfx.put(tock(260), cta, 0.5); sfx.put(whoosh(0.3, 600, 4200, 1.0, 0.7), cta - 0.22, 0.24)
for f, dl in [(1046.5, 0), (1318.5, 0.045), (1568.0, 0.09), (2093.0, 0.135)]: sfx.put(bell(f, 1.0, 2.2), cta + dl, 0.18, (dl - 0.07) * 4)
sfx.put(shimmer(1.0), EV["c7_cta"] + 0.35, 0.16, 0.0)

# ---------------- BGM（C メジャー・120BPM。カットごとに和音が変わる） ----------------
mus = Bus()
note = lambda m: 440.0 * 2 ** ((m - 69) / 12)
CH = [  # (ルート, 和音のMIDI, ベース)
    ("Cmaj7", [48, 55, 59, 64], 36), ("Am7", [45, 52, 55, 60], 33), ("Fmaj7", [41, 48, 52, 57], 41),
    ("G", [43, 50, 55, 59], 43), ("Am7", [45, 52, 55, 60], 45), ("Fmaj7", [41, 48, 52, 57], 41), ("Cmaj9", [48, 55, 59, 62, 64], 36)]
ends = C[1:] + [END + 0.6]
arp_idx = [0, 2, 1, 3, 2, 1, 3, 2]
for k in range(len(C)):
    name, notes, root = CH[k]; t0, t1 = C[k], ends[k]
    mus.put(pad([note(m) for m in notes], (t1 - t0) + 0.5, 1.0), t0 - 0.1, 0.34, 0.0)
    nb = int(round((t1 - t0) / BEAT))
    for b in range(nb):
        tb = t0 + b * BEAT; g = int(round(tb / BEAT))           # 全体の拍番号
        if tb >= EV["wordC"] - 0.01:
            mus.put(kick(1.0), tb, 0.40 if k else 0.46)
        if k >= 1 and b % 1 == 0:
            mus.put(hat(False, 0.8), tb + BEAT / 2, 0.075 + 0.02 * (k >= 3))
            if k >= 3: mus.put(hat(False, 0.5), tb + BEAT / 4, 0.04); mus.put(hat(False, 0.5), tb + 3 * BEAT / 4, 0.04)
        if k >= 2 and g % 2 == 1: mus.put(snare_clap(0.7), tb, 0.20)
        if k >= 1:
            # ベース：拍のアタマ＋裏のシンコペ
            mus.put(bass(note(root), 0.44), tb, 0.34)
            if b % 2 == 1: mus.put(bass(note(root + (7 if k % 2 else 12)), 0.30), tb + BEAT * 0.75, 0.22)
        if k >= 1:
            for h in range(2):                                 # 8分のアルペジオ
                ts = tb + h * BEAT / 2; ai = arp_idx[(g * 2 + h) % 8] % len(notes)
                mus.put(pluck(note(notes[ai] + 24), 1.0), ts, 0.14 if h else 0.10, -0.4 if (g + h) % 2 else 0.4)
mus.put(bell(note(84), 1.0, 2.4), C[6], 0.0)

# ---------------- ミックス ----------------
# 声が出ている所だけ 1 になる合図（20msの実効値が閾値を超えた所）。BGM・効果音をそこで下げる
w = int(0.02 * SR); vr = np.sqrt(np.convolve(vmono ** 2, np.ones(w) / w, "same"))
act = (vr > np.max(vr) * 10 ** (-34 / 20)).astype(float)
# 単語の間の短い息継ぎで BGM が戻らないよう、0.18秒ぶん広げる
k = int(0.18 * SR); act = np.convolve(act, np.ones(k), "same"); act = np.clip(act, 0, 1)
duck = np.zeros(N); g = 0.0; a = 1 - np.exp(-1 / (0.025 * SR)); r = 1 - np.exp(-1 / (0.28 * SR))
for i in range(0, N, 16):
    tgt = act[i]; g += (tgt - g) * (a if tgt > g else r) * 16; duck[i:i + 16] = g
duck = np.clip(duck, 0, 1)
mus.b = np.stack([hp(mus.b[0], 42, 2), hp(mus.b[1], 42, 2)]) * (1 - 0.64 * duck)
sfx.b *= (1 - 0.40 * duck)
mus.b = reverb(mus.b, 1.2, 0.14); sfx.b = reverb(sfx.b, 1.6, 0.20); voice.b = reverb(voice.b, 0.55, 0.05)
mix = voice.b * 1.0 + mus.b * 0.92 + sfx.b * 0.80
for nm, bb in (('voice', voice.b), ('music', mus.b * 0.92), ('sfx', sfx.b * 0.80)): wavfile.write(f'stem_{nm}.wav', SR, (np.clip(bb[:, :int(END*SR)], -1, 1).T * 32767).astype(np.int16))
# 終わりは音楽を自然に落とす
fadeout = np.ones(N); i0 = int((END - 0.9) * SR); i1 = int(END * SR); fadeout[i0:i1] = np.linspace(1, 0, i1 - i0) ** 1.5; fadeout[i1:] = 0
mix *= fadeout
mix = np.tanh(mix * 0.9) / 0.9 if np.max(np.abs(mix)) > 1.0 else mix
mix = mix[:, : int(END * SR)]
wavfile.write("mix_raw.wav", SR, (np.clip(mix, -1, 1).T * 32767).astype(np.int16))
print("raw peak", float(np.max(np.abs(mix))))
# ラウドネス：-14 LUFS（TikTok・Reels の一般的な基準）、真のピーク -1.0dB
m1 = subprocess.run([FF, "-hide_banner", "-i", "mix_raw.wav", "-af", "loudnorm=I=-14:TP=-1.0:LRA=9:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
j = json.loads(m1[m1.rindex("{"): m1.rindex("}") + 1])
ln = (f"loudnorm=I=-14:TP=-1.0:LRA=9:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true")
subprocess.run([FF, "-loglevel", "error", "-y", "-i", "mix_raw.wav", "-af", ln, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "audio.m4a"], check=True)
subprocess.run([FF, "-loglevel", "error", "-y", "-i", "mix_raw.wav", "-af", ln, "-ar", "48000", "mix.wav"], check=True)
print("measured before:", j["input_i"], "LUFS  TP", j["input_tp"])
