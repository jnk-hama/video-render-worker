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
    if kind == "warmup":   # editorial.html の warmup：差し込み（0.25〜0.95）→ 温風と色（0.9〜）→ 輪が満ちる
        put(sfx, g["whoosh"](0.7, 200, 2600, 0.5, 0.7), t0 + 0.25, 0.26); put(sfx, g["tock"](240, 0.8), t0 + 0.95, 0.3); put(sfx, g["glide"](1.8, 260, 620, 0.5), t0 + 0.9, 0.16)
        put(sfx, g["bell"](1318.5, 0.7, 1.6), t0 + 2.5, 0.22)
    # CM の型（cm.html・#298）
    if kind == "pain": put(sfx, g["whoosh"](1.8, 120, 600, 0.25, 0.9), t0 + 0.05, 0.12)   # 冷たい夜の低い風
    if kind == "flip":
        put(sfx, g["whoosh"](0.5, 300, 2200, 0.5), t0 + 0.1, 0.18); put(sfx, g["tock"](240, 0.8), t0 + 0.72, 0.3)   # 倒れて差さる
        put(sfx, g["riser"](1.0, 0.4), t0 + 0.6, 0.14); put(sfx, g["shimmer"](1.6, 0.6), t0 + 0.8, 0.18)   # 暖色が広がる
    if kind == "reveal": put(sfx, g["whoosh"](0.7, 250, 3000, 0.5), t0, 0.16); put(sfx, g["shimmer"](1.0, 0.4), t0 + 0.4, 0.1)
    if kind == "held":
        put(sfx, g["whoosh"](0.6, 300, 2600, 0.5), t0, 0.14)
        for k2 in range(8): put(sfx, g["tick"](2400 + 90 * k2, 0.3), t0 + 0.45 + k2 * 0.1, 0.06)
    if kind == "cshoes": put(sfx, g["whoosh"](0.6, 300, 2600, 0.5), t0, 0.14); put(sfx, g["glide"](1.4, 280, 640, 0.5), t0 + 0.5, 0.12)
    if kind == "rapid":
        n = len(bp.get("words", [])); sl = (t1 - 0.25 - t0 - 0.05) / max(1, n)
        for k2 in range(n): put(sfx, g["tock"](300 + 60 * k2, 0.7), t0 + 0.05 + k2 * sl, 0.24)   # 1語ごとに1つ（拍）
    if kind == "cmend": put(sfx, g["shimmer"](1.4, 0.5), t0 + 0.1, 0.14); put(sfx, g["bell"](1318.5, 0.7, 1.6), t0 + 1.0, 0.2)
    # CM 版2（#299）：輪が回る音・連打・ボタンに広がる音
    if kind in ("orbit", "orbitrap"): put(sfx, g["whoosh"](0.7, 220, 2800, 0.5), t0 - 0.42, 0.18); put(sfx, g["tock"](260, 0.6), t0 + 0.05, 0.16)
    if kind == "orbit" and bp.get("nums"):
        for k2 in range(8): put(sfx, g["tick"](2400 + 90 * k2, 0.3), t0 + 0.35 + k2 * 0.1, 0.05)
    if kind == "orbitrap":
        n = len(bp.get("words", [])); sl = (t1 - 0.25 - t0 - 0.05) / max(1, n)
        for k2 in range(n): put(sfx, g["tock"](320 + 60 * k2, 0.7), t0 + 0.05 + k2 * sl, 0.24)
    # CM 版3（#300）：差した瞬間の衝撃・カメラを突き抜ける風・1語ごとの打ち込み
    if kind == "flip" and bp.get("burst"): put(sfx, g["impact"](0.6, 1.6), t0 + 0.75, 0.34)
    if kind == "cascade":
        put(sfx, g["whoosh"](0.7, 160, 3600, 0.6, 0.6), t0 - 0.4, 0.16)
        n = len(bp.get("words", [])); sl = (t1 - 0.25 - t0 - 0.05) / max(1, n)
        for k2 in range(n): put(sfx, g["impact"](0.35, 1.0), t0 + 0.05 + k2 * sl, 0.08); put(sfx, g["tock"](320 + 60 * k2, 0.7), t0 + 0.05 + k2 * sl, 0.12)
    # 組み合わせ生成（#301）：どの商品にも使える悩み・転換
    if kind == "hook": put(sfx, g["whoosh"](1.8, 120, 600, 0.25, 0.9), t0 + 0.05, 0.12)
    if kind == "unveil":
        put(sfx, g["riser"](0.5, 0.6), max(0, t0 - 0.4), 0.1); put(sfx, g["impact"](0.6, 1.6), t0 + 0.12, 0.22); put(sfx, g["shimmer"](1.6, 0.6), t0 + 0.2, 0.12)
        put(sfx, g["whoosh"](0.6, 300, 2600, 0.5), t0 + 0.5, 0.16); put(sfx, g["tick"](2600, 0.5), t0 + 1.05, 0.14)   # 横を向く・厚みの線
    # #302 場面の種類を増やした分の音（動きの時刻と同じ定数）
    if kind == "edgehook":   # 暗いスタジオの低い響き → 正面を向く瞬間の光芒にきらめき
        put(sfx, g["pad"]([55.0, 82.41, 110.0], 2.4, 0.6), t0, 0.16); put(sfx, g["riser"](1.2, 0.5), t0 + 0.7, 0.1)
        put(sfx, g["whoosh"](0.9, 200, 2400, 0.4), t0 + 1.25, 0.12); put(sfx, g["shimmer"](1.4, 0.6), t0 + 1.9, 0.16)
    if kind == "pocket":
        for k2 in range(4): put(sfx, g["tock"](180, 0.5), t0 + 0.17 + k2 * 0.7, 0.12)   # 箱が押し込まれては止まる
    if kind == "flapin":
        put(sfx, g["whoosh"](0.7, 250, 3000, 0.5), t0, 0.16); put(sfx, g["shimmer"](1.2, 0.5), t0 + 0.1, 0.1)
        for k2 in range(14): put(sfx, g["tick"](2200 + 40 * k2, 0.3), t0 + 0.45 + k2 * 0.06, 0.05)   # パタパタ
        put(sfx, g["tock"](300, 0.7), t0 + 1.35, 0.16)
    if kind == "callout": put(sfx, g["glide"](0.6, 300, 700, 0.5), t0 + 0.45, 0.1); put(sfx, g["tick"](2600, 0.5), t0 + 1.15, 0.12); put(sfx, g["tick"](2900, 0.5), t0 + 1.4, 0.12)
    if kind == "snap": put(sfx, g["whoosh"](0.6, 300, 2600, 0.5), t0, 0.16); put(sfx, g["tock"](420, 0.9), t0 + 0.85, 0.28)   # カチッ
    if kind == "fill":
        for k2 in range(5): put(sfx, g["tick"](1800 + 200 * k2, 0.4), t0 + 0.35 + k2 * 0.24, 0.1)
    if kind == "checklist":
        n = len(bp.get("words", [])); sl = (t1 - 0.6 - t0 - 0.05) / max(1, n)
        for k2 in range(n): put(sfx, g["tock"](320 + 60 * k2, 0.7), t0 + 0.05 + k2 * sl, 0.14)
    if kind == "turntable": put(sfx, g["shimmer"](1.4, 0.5), t0 + 0.2, 0.1); put(sfx, g["bell"](1318.5, 0.7, 1.6), t0 + 1.1, 0.16)
    if kind == "finale3d": put(sfx, g["whoosh"](0.8, 200, 1800, 0.4, 0.8), t0 - 0.3, 0.14); put(sfx, g["shimmer"](1.4, 0.5), t0 + 0.2, 0.12); put(sfx, g["bell"](1318.5, 0.7, 1.6), t0 + 1.6, 0.2)
    if kind == "match":   # lookbook.html の match：猫（0.35＋0.55k）→ 矢印 → 平置き（0.8＋0.55k）
        for k2 in range(len(bp.get("pairs", []))): put(sfx, g["whoosh"](0.4, 400, 2600, 0.5), t0 + 0.35 + k2 * 0.55, 0.12); put(sfx, g["tock"](320 + 40 * k2, 0.7), t0 + 0.8 + k2 * 0.55, 0.2)
    if kind == "worn":   # lookbook.html の worn：写真が上がる（0.1〜）→ 寸法線（0.6〜1.5）→ 数字（1.2〜）→ 札（1.7〜）
        put(sfx, g["whoosh"](0.5, 300, 2600, 0.5), t0 + 0.1, 0.16); put(sfx, g["glide"](0.9, 300, 700, 0.5), t0 + 0.6, 0.12); put(sfx, g["tock"](300, 0.7), t0 + 1.5, 0.22)
        for k2 in range(3): put(sfx, g["tick"](2400 + 160 * k2, 0.3), t0 + 1.7 + k2 * 0.18, 0.09)
    if kind == "texture":   # editorial.html の texture：丸が開く（0.05〜）→ なでる（0.6〜2.0）→ 雲（0.4〜）
        put(sfx, g["whoosh"](0.6, 300, 2400, 0.5), t0 + 0.05, 0.16); put(sfx, g["whoosh"](1.4, 150, 900, 0.3, 0.8), t0 + 0.6, 0.14); put(sfx, g["shimmer"](1.3, 0.5), t0 + 1.6, 0.14)
    if kind == "shoes":   # editorial.html の shoes：靴（0.1〜）→ 腕（0.45〜）→ 本体が立つ（0.85）→ 温風と水の粒（1.2〜）
        put(sfx, g["whoosh"](0.5, 300, 2800, 0.5), t0 + 0.1, 0.2); put(sfx, g["tock"](260, 0.8), t0 + 0.95, 0.32); put(sfx, g["glide"](1.6, 280, 640, 0.5), t0 + 1.2, 0.14)
        for k2 in range(6): put(sfx, g["tick"](2600 + 120 * k2, 0.3), t0 + 1.4 + k2 * 0.24, 0.07, -0.3 + 0.12 * k2)
    if kind == "spec":
        put(sfx, g["tick"](2300, 0.5), t0 + 0.45, 0.15); put(sfx, g["tick"](2600, 0.5), t0 + 0.85, 0.15)
        for k2 in range(1, 10): put(sfx, g["tick"](2000 + 80 * k2, 0.4), t0 + 0.9 + 0.9 * (1 - (1 - k2 / 10) ** (1 / 3)), 0.08)
        put(sfx, g["impact"](0.7, 1.2), t0 + 1.8, 0.3); put(sfx, g["tock"](240, 0.9), t0 + 1.82, 0.35)
    if kind == "slice":   # editorial.html の slice と同じ時刻：一切れが前へ（0.75〜1.6）→ 寄りと光（1.75〜）
        put(sfx, g["whoosh"](0.8, 200, 2400, 0.5, 0.7), t0 + 0.7, 0.24); put(sfx, g["tock"](220, 0.8), t0 + 1.6, 0.3); put(sfx, g["glide"](1.4, 300, 700, 0.5), t0 + 1.75, 0.12); put(sfx, g["shimmer"](1.2, 0.6), t0 + 1.95, 0.2)
    if kind == "points":   # editorial.html の points と同じ時刻
        gp = min(0.5, (t1 - t0 - 1.6) / len(bp["items"]))
        for k2 in range(len(bp["items"])): put(sfx, g["tick"](2200 + 200 * k2, 0.6), t0 + 0.35 + k2 * gp, 0.16, -0.2 + 0.2 * k2); put(sfx, g["tock"](380 + 40 * k2, 0.5), t0 + 0.38 + k2 * gp, 0.2)
    if kind == "tour":   # 中身めぐり（editorial.html の tour と同じ時刻）
        D = (t1 - t0 - 0.45) / len(bp["items"])
        for k2 in range(len(bp["items"])): put(sfx, g["whoosh"](0.5, 300, 3200, 0.5), t0 + 0.3 + k2 * D - 0.1, 0.22, -0.3 + 0.3 * k2); put(sfx, g["shimmer"](0.7, 0.5), t0 + 0.3 + (k2 + 0.5) * D, 0.12)
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
    if kind == "explode":   # 分解（paper.html の explode と同じ時刻・元は filter_audio.py）
        e = t0 + bp["cam"].get("mv", {}).get("dur", 0.6) / 2
        for f, dt, gn, pn in [(g["whoosh"](0.9, 180, 2600, 0.7), 0.05, 0.5, 0), (g["tock"](260, 1.0), 1.0, 0.9, 0), (g["tick"](3400, 0.6), 1.03, 0.5, 0), (g["glide"](0.7, 300, 900, 0.6), 1.5, 0.35, 0),
                              (g["whoosh"](0.8, 400, 5200, 0.6), 2.0, 0.45, 0.2), (g["impact"](0.7, 1.4), 2.8, 0.55, 0), (g["shimmer"](0.9, 0.8), 2.75, 0.4, 0), (g["bell"](1318.5, 0.6, 1.4), 3.1, 0.3, 0),
                              (g["tock"](220, 0.8), 3.35, 0.6, 0), (g["whoosh"](0.35, 800, 6000, 0.5), 4.0, 0.35, -0.2), (g["bell"](1567.98, 0.7, 1.6), 4.3, 0.32, 0), (g["shimmer"](0.8, 0.7), 4.3, 0.3, 0)]:
            put(sfx, f, e + dt, gn, pan=pn)
    if kind == "num":   # 数字の見せ方（numfx.js と同じ時刻・#279）
        m = bp["motif"]
        if m == "flap":
            n = sum(c.isdigit() for c in str(bp["value"]))
            for k2 in range(n):
                for q in range(6 + k2 * 2): put(sfx, g["tick"](2600 + 80 * k2, 0.3), t0 + (0.6 + k2 * 0.28) * q / (6 + k2 * 2), 0.05, -0.3 + 0.15 * k2)
                put(sfx, g["tock"](380 + 30 * k2, 0.5), t0 + 0.6 + k2 * 0.28, 0.22, -0.3 + 0.15 * k2)
        if m == "magnify":
            put(sfx, g["riser"](0.9, 0.6), t0 + 0.6, 0.2); put(sfx, g["impact"](0.8, 1.2), t0 + 1.7, 0.35); put(sfx, g["tock"](240, 0.9), t0 + 1.72, 0.4)
        if m == "calendar":
            n = bp["months"]; gap = min(0.3, 1.2 / max(n - 1, 1)); end = 0.35 + (n - 1) * gap + 0.3
            for k2 in range(n - 1): put(sfx, g["whoosh"](0.25, 700, 4200, 0.5, 0.6), t0 + 0.35 + k2 * gap, 0.16, -0.3 + 0.15 * k2)
            put(sfx, g["bell"](1568, 1.0, 1.4), t0 + end, 0.2)
            if bp.get("badge"): put(sfx, g["impact"](0.7, 1.2), t0 + end + 0.25, 0.3); put(sfx, g["tock"](240, 0.9), t0 + end + 0.27, 0.35)
        if m == "dims": put(sfx, g["glide"](0.9, 300, 800, 0.5), t0 + 0.2, 0.12); put(sfx, g["tick"](2400, 0.5), t0 + 1.1, 0.16); put(sfx, g["tick"](2700, 0.5), t0 + 1.45, 0.16)
        if m == "cup": put(sfx, g["glide"](1.6, 220, 520, 0.5), t0 + 0.3, 0.16); put(sfx, g["bell"](1318.5, 0.7, 1.6), t0 + 1.9, 0.22)
        if m == "donut": put(sfx, g["glide"](1.0, 400, 900, 0.5), t0 + 0.3, 0.14); put(sfx, g["bell"](1568, 0.7, 1.4), t0 + 1.6, 0.2)
        if m == "figures":
            for k2 in range(len(bp["sizes"])): put(sfx, g["tock"](320 + 30 * k2, 0.6), t0 + 0.3 + k2 * 0.14, 0.24, -0.4 + 0.1 * k2)
    # ルックブックの型（lookbook.html と同じ時刻）。静かめ：紙をめくる音・柔らかい鈴
    if P["template"] == "lookbook":
        if kind == "cover": put(sfx, g["shimmer"](1.1, 0.6), 0.6, 0.22)
        if kind == "gauge":
            for k2 in range(1, 13): put(sfx, g["tick"](2100 + 70 * k2, 0.5), t0 + 0.4 + 1.1 * (1 - (1 - k2 / 13) ** (1 / 3)), 0.11, 0.2)
            put(sfx, g["bell"](1318.5, 0.6, 1.6), t0 + 1.5, 0.22)
        if kind == "swatch":
            for k2 in range(len(bp["items"])): put(sfx, g["whoosh"](0.25, 600, 3800, 0.5, 0.6), t0 + 0.4 + k2 * 0.16, 0.14, -0.5 + 0.2 * k2)
        if kind == "sizes":
            for k2 in range(len(bp["sizes"])): put(sfx, g["tock"](320 + 30 * k2, 0.6), t0 + 0.55 + k2 * 0.11, 0.26, -0.4 + 0.1 * k2)
        if kind == "touch": put(sfx, g["shimmer"](1.3, 0.5), t0 + 0.5, 0.2); put(sfx, g["whoosh"](0.9, 200, 1800, 0.4, 0.7), t0 + 0.1, 0.18)
        if kind == "callouts":
            put(sfx, g["glide"](1.0, 400, 900, 0.5), t0 + 0.4, 0.12)
            for k2 in range(len(bp["points"])): put(sfx, g["tick"](2400 + 300 * k2, 0.6), t0 + 0.9 + k2 * 0.45, 0.14, -0.3 + 0.6 * k2)
        if kind == "choose":
            for k2 in range(len(bp["items"])): put(sfx, g["whoosh"](0.22, 600, 3800, 0.5, 0.6), t0 + 0.3 + k2 * 0.12, 0.12, -0.5 + 0.2 * k2)
            for k2 in range(len(bp["sizes"])): put(sfx, g["tock"](320 + 30 * k2, 0.5), t0 + 1.1 + k2 * 0.07, 0.18, -0.4 + 0.1 * k2)
        if kind == "finale": put(sfx, g["tock"](300, 0.7), t0 + 0.25, 0.35); put(sfx, g["bell"](1567.98, 0.6, 1.8), t0 + 1.9, 0.26); put(sfx, g["shimmer"](1.0, 0.6), t0 + 2.2, 0.2)
    if kind == "finale" and P["template"] == "paper":
        put(sfx, g["riser"](1.0, 1.0), t0 - 1.0, 0.24); put(sfx, g["impact"](0.8, 1.6), t0, 0.5); put(sfx, g["bell"](1568, 1.0, 1.6), t0 + 0.35, 0.18, -0.3)
        for k2 in range(1, 12): put(sfx, g["tick"](2300 + 60 * k2), t0 + 0.8 + 1.1 * (1 - (1 - k2 / 12) ** (1 / 3)), 0.10, 0.2)
        cta = t0 + 2.1; put(sfx, g["tock"](260), cta, 0.5); put(sfx, g["whoosh"](0.3, 600, 4200, 1.0, 0.7), cta - 0.22, 0.24)
        for fq, dl in [(1046.5, 0), (1318.5, 0.045), (1568.0, 0.09), (2093.0, 0.135)]: put(sfx, g["bell"](fq, 1.0, 2.2), cta + dl, 0.18, (dl - 0.07) * 4)
sfx = g["reverb"](sfx, 1.6, 0.25) * (1 - 0.5 * env)
if P["template"] == "paper": music *= 0.4; sfx *= 0.45   # 拍と効果音が多い型。声との差 9dB 以上を守る（#267-7）
m = env > 0.5; r = lambda x: 20 * np.log10(np.sqrt(np.mean(x[:, m] ** 2)) + 1e-12)
need = 10.5 - (r(voice) - r(music * 0.55 + sfx * 0.6))   # 声との差 9dB 以上（#267-7）を、型や声の長さに関わらず自動で守る（短い声の CM で 8.0dB になった・#301）
if need > 0: music *= 10 ** (-need / 20); sfx *= 10 ** (-need / 20)
mix = voice + music * 0.55 + sfx * 0.6; mix /= np.abs(mix).max() / 0.8
wav = out.replace(".m4a", ".wav"); wavfile.write(wav, SR, mix.T.astype(np.float32))
subprocess.run([FF, "-v", "error", "-y", "-i", wav, "-af", "loudnorm=I=-14:TP=-1.5:LRA=7", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", out], check=True)
bed = music * 0.55 + sfx * 0.6
print(json.dumps({"voice_over_bed_db": round(r(voice) - r(bed), 1), "music_db": round(r(voice) - r(music * 0.55), 1), "sfx_db": round(r(voice) - r(sfx * 0.6), 1)}))
