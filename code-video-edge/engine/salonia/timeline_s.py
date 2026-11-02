# SALONIA スピーディーイオンドライヤーの時刻表
import json
TEMPO = 1.15
speech = [2.39, 2.34, 2.97, 3.25, 3.10]     # silencedetect の実測（頭0.17含む）
tail = [0.75, 0.70, 0.80, 0.70, 1.70]
LEAD = 0.25
cuts, voice, t = [], [], 0.0
for i, (s, tl) in enumerate(zip(speech, tail)):
    cuts.append(round(t, 3)); voice.append({"line": i, "start": round(t + LEAD, 3), "tempo": TEMPO, "len": round(s / TEMPO, 3)})
    t += LEAD + s / TEMPO + tl
END = round(t, 3); c = cuts
ev = dict(c0_t1=0.05, c0_t2=0.55, c0_bar=0.3,
          c1_big=c[1] + 0.2, c1_fast=c[1] + 0.7,
          c2_dmg=c[2] + 0.2, c2_slash=c[2] + 1.25, c2_cut=c[2] + 1.55,
          c3_a=c[3] + 0.2, c3_swap=c[3] + 1.65,
          c4_star=c[4] + 0.15, c4_rev=c[4] + 0.5, c4_cta=c[4] + 1.6)
json.dump({"bpm": 104, "cuts": cuts, "end": END, "voice": voice, "ev": {k: round(v, 3) for k, v in ev.items()}},
          open("p4/timeline_s.json", "w"), ensure_ascii=False, indent=1)
print("cuts", cuts, "end", END)
