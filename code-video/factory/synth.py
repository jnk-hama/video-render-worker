#!/usr/bin/env python3
"""合成の音色（BGM・効果音）。外部の音源は使わない（権利の心配が無いよう全て合成）。factory/audio.py が使う"""
import json, subprocess, sys, os
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
FF = os.environ.get("FFMPEG") or subprocess.check_output(["python3", "-c", "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())"]).decode().strip()
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

