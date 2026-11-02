# BALMUDA The Pot の時刻表（絵と音の唯一の出どころ）
import json
TEMPO = 1.15                                    # 喋りの速さ（video-render-worker の SPEECH_SPEED と同じ）
speech = [2.82, 3.62, 2.53, 2.16, 4.61, 2.66, 3.03]   # silencedetect で実測した喋りの終わり(秒・頭0.17含む)
tail = [0.50, 0.55, 0.50, 0.70, 0.50, 0.50, 1.60]     # 喋り終わってから次のカットまで（輪・CTA は長め）
LEAD = 0.25
cuts, t = [], 0.0
voice = []
for i, (s, tl) in enumerate(zip(speech, tail)):
    cuts.append(round(t, 3))
    voice.append({"line": i, "start": round(t + LEAD, 3), "tempo": TEMPO, "len": round(s / TEMPO, 3)})
    t += LEAD + s / TEMPO + tl
END = round(t, 3)
c = cuts
ev = dict(
    c1_line=0.25, c1_head=0.08, c1_head2=0.36, c1_name=1.9, c1_glint=1.2,
    c2_num0=c[1] + 0.35, c2_num1=c[1] + 1.35, c2_cup0=c[1] + 1.5, c2_cup1=c[1] + 2.0, c2_cup2=c[1] + 2.5,
    c3_line0=c[2] + 0.55, c3_line1=c[2] + 1.6, c3_label=c[2] + 0.25,
    c4_ring0=c[3] + 0.35, c4_ring1=c[3] + 2.0, c4_label=c[3] + 0.2, c4_ding=c[3] + 2.0,
    c5_old=c[4] + 0.35, c5_arrow=c[4] + 1.0, c5_new=c[4] + 1.35, c5_body=c[4] + 2.1, c5_note=c[4] + 2.6,
    c6_chip0=c[5] + 0.45, c6_chip1=c[5] + 1.35, c6_glint=c[5] + 0.3,
    c7_white=c[6] + 0.15, c7_star0=c[6] + 0.55, c7_star1=c[6] + 1.35, c7_rev0=c[6] + 0.9, c7_rev1=c[6] + 1.8, c7_cta=c[6] + 2.2,
)
json.dump({"bpm": 84, "cuts": cuts, "end": END, "voice": voice, "ev": {k: round(v, 3) for k, v in ev.items()}},
          open("p2/timeline_b.json", "w"), ensure_ascii=False, indent=1)
print("cuts", cuts, "end", END)
