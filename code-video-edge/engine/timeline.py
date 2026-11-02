# 時間の唯一の出どころ。HTML（絵）と音の組み立て（audio.py）の両方がこれを読む。
import json, math
BPM = 120; BEAT = 60 / BPM
cuts = [0.0, 3.0, 6.0, 9.0, 12.0, 14.5, 17.5]
END = 21.5
# 声：各カットの頭から0.28秒後に始め、カットの終わり(-0.08)までに収まるよう速度(atempo)を決める
speech = [2.41, 2.24, 2.75, 2.92, 2.30, 2.42, 2.86]          # silencedetect で実測した喋りの長さ(秒)
ends = cuts[1:] + [END]
voice = []
for i, (c, e, L) in enumerate(zip(cuts, ends, speech)):
    start = c + 0.28
    room = e - 0.08 - start
    tempo = max(1.0, L / room) if L > room else 1.0
    voice.append({"line": i, "start": round(start, 3), "tempo": round(tempo, 3), "len": round(L / tempo, 3)})

def ease_out_cubic(x): return 1 - (1 - x) ** 3
def inv_ease_out_cubic(y): return 1 - (1 - y) ** (1 / 3)

ev = {}
c = cuts
ev.update(dict(slam=0.25, wordA=0.0, wordB=0.22, wordC=1.50, sweep1=0.85))
ev.update(dict(c2_head=c[1] + 0.12, chip0=c[1] + 0.75, chip1=c[1] + 1.25, chip2=c[1] + 1.75, leader=c[1] + 1.9))
ev.update(dict(c3_label=c[2] + 0.12, c3_num=c[2] + 0.30, rail0=c[2] + 0.85, rail1=c[2] + 2.45, c3_badge=c[2] + 2.45))
ev.update(dict(c4_label=c[3] + 0.12, c4_cnt0=c[3] + 0.35, c4_cnt1=c[3] + 1.55, c4_bar0=c[3] + 1.70, c4_bar1=c[3] + 2.20, c4_glint=c[3] + 0.30))
ev.update(dict(c5_label=c[4] + 0.12, c5_bracket=c[4] + 0.35, c5_num0=c[4] + 0.45, c5_num1=c[4] + 1.35, c5_sub=c[4] + 1.40))
ev.update(dict(c6_label=c[5] + 0.12, c6_ring0=c[5] + 0.45, c6_ring1=c[5] + 1.85, c6_note=c[5] + 1.55, c6_ding=c[5] + 1.85))
ev.update(dict(c7_star0=c[6] + 0.25, c7_star1=c[6] + 1.15, c7_rev0=c[6] + 0.80, c7_rev1=c[6] + 1.90, c7_cta=c[6] + 2.10, c7_name=c[6] + 2.45))

# カウンターの「数字が変わる瞬間」＝音の目盛り。見た目と同じイージングで逆算する
def tick_times(t0, t1, steps):
    return [round(t0 + (t1 - t0) * inv_ease_out_cubic((k + 1) / steps), 3) for k in range(steps)]
ticks = {
    "c4": tick_times(ev["c4_cnt0"], ev["c4_cnt1"], 14),
    "c5": tick_times(ev["c5_num0"], ev["c5_num1"], 9),
    "c7": tick_times(ev["c7_star0"], ev["c7_star1"], 8) + tick_times(ev["c7_rev0"], ev["c7_rev1"], 10),
}
json.dump({"bpm": BPM, "cuts": cuts, "end": END, "voice": voice, "ev": {k: round(v, 3) for k, v in ev.items()}, "ticks": ticks},
          open("timeline.json", "w"), ensure_ascii=False, indent=1)
print("cuts", cuts, "end", END); print("voice", [(v["start"], v["tempo"], round(v["start"] + v["len"], 2)) for v in voice])
