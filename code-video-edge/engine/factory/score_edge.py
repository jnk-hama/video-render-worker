#!/usr/bin/env python3
# ============================================================
# 音から先に作る（UGREEN「一本の線」・#333）。v3：語り（VOICEVOX WhiteCUL・#308）つき・20〜25秒
#   1) 語りの長さ（実測）から場面の長さを決める。場面の切れ目は 120BPM の拍の上
#   2) 山場＝「最大15ワット」の「ジュウゴ」が拍の頭に来るよう、その行の置き場所を決める
#   3) 出来事（効果音と絵のきっかけ）は言葉の時刻（#312 cue）か場面の切れ目にだけ置く
#   4) 音楽を合成（外部音源なし・固定シード）→ 声の下で下げ、声と背景の差 14dB（#309）
#   5) 書き出した音楽から拍を検出し、意図した拍とのずれを測る → timing.json（映像の時刻の唯一の源）
#   6) ミックス −14 LUFS・TP −1.5 dBTP（2パスの線形 loudnorm）。純音楽版も別に書き出す
#
# 使い方： python3 factory/score_edge.py <outdir> <voice_dir> <product.json>
#   場面・語り・山場・出来事・効果音は product.json の "score" に書く（商品ごとにこのファイルを写さない・一度決めたら全部で強制）
# ============================================================
import json, math, os, subprocess, sys
import numpy as np
from scipy.io import wavfile
from scipy import signal
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import synth, timeline; g = dict(vars(synth))
SR, FF = synth.SR, synth.FF
OUT, VDIR = sys.argv[1], sys.argv[2]; os.makedirs(OUT, exist_ok=True)
SC = json.load(open(sys.argv[3]))["score"]

FPS, BPM = 60, 120
B = 60 / BPM                                  # 1拍＝0.5秒＝30フレーム
TEMPO = timeline.TEMPO                        # 喋りの速さ（コード動画と同じ定数）
LEAD, END_TAIL = 0.1, 0.7                     # 切れ目→喋り始め／最後の行の後の余韻
fr = lambda t: int(round(t * FPS))
note = lambda m: 440 * 2 ** ((m - 69) / 12)
ceil_b = lambda t: math.ceil(t / B - 1e-6)    # 秒 → それ以上で一番近い拍の番号

# ---------------- 語り（声の長さと言葉の時刻は実測） ----------------
def vlen(f):
    """喋りの長さ（喋りの速さを掛けた後の秒）。無音検出が文の途中の間で止まる事があるので、最後の音の時刻でも測って長い方"""
    tm = json.load(open(os.path.join(VDIR, f[:-4] + ".timing.json")))
    return max(timeline.speech_end(os.path.join(VDIR, f)), tm[-1]["t"] + 0.15) / TEMPO
def cue(f, kana):
    """その言葉を言い始める時刻（行の頭からの秒）。見つからなければ止める（黙ってずらさない・#312）"""
    return round(timeline.cue_time(os.path.join(VDIR, f[:-4]), kana, 0.0), 3)

# 場面と語り（[場面, 声のファイル, 最短の秒]）。最短の秒は、文字を読む時間が要る場面だけ。山場＝[場面, その言葉の読み]
SCRIPT = [tuple(x) for x in SC["scenes"]]
CLIMAX_CUE = tuple(SC["climax"])
# 切れ目は「前の行を言い終えた後の最初の拍」、次の行はその直後（LEAD）から。
# v3 r1 は前の行の終わりを次の場面に 0.2〜0.5秒かけた（J カット）が、レビューで「聞いている文から絵が先に去る」（v3 R1）。
# 場面ごとに頭と尻の間を別に取って拍へ切り上げる形は 27.5秒、言い終えた後の「拍」で切ると 26.0秒で、25秒の上限（#325）を超えた
# → 切れ目は8分（半拍）の格子に置く（音楽の格子の上のまま）。山場だけは拍の頭
ceil_h = lambda t: math.ceil(t / (B / 2) - 1e-6) / 2      # 秒 → それ以上で一番近い半拍（拍の番号・0.5刻み）
SCENES, VOICE, cuts, prev_end = [], [], [], None
for k, (sid, f, mn) in enumerate(SCRIPT):
    L = vlen(f)
    if k == 0: cb, vs = 0, LEAD
    else:
        p_b0, p_mn = cuts[-1], SCRIPT[k - 1][2]
        cb = max(ceil_h(prev_end), ceil_h(p_b0 * B + p_mn)); vs = cb * B + LEAD   # 切れ目は前の行を言い終えた後の拍。前の場面の最短の長さ（文字を読む時間）も守る
    if sid == CLIMAX_CUE[0]:
        c = cue(f, CLIMAX_CUE[1]); CLIMAX_B = ceil_b(vs + c); vs = CLIMAX_B * B - c
    cuts.append(cb); VOICE.append({"scene": sid, "file": f, "start": round(vs, 3), "len": round(L, 3)}); prev_end = vs + L
END_B = ceil_b(prev_end + END_TAIL)
SCENES = [(SCRIPT[k][0], cuts[k], cuts[k + 1] if k + 1 < len(cuts) else END_B) for k in range(len(cuts))]
END = END_B * B; N = int(round(END * SR))
S = {s: (x0, x1) for s, x0, x1 in SCENES}; V = {v["scene"]: v for v in VOICE}
bt = lambda b: b * B
at = lambda sid, kana: V[sid]["start"] + cue(V[sid]["file"], kana)   # その言葉の動画の秒
if not 20 <= END <= 25: sys.exit(f"長さ {END}秒 が 20〜25秒（オーナー指定・#325 の上限25秒）から外れる")

def stereo(): return np.zeros((2, N))
# 本物の録音（#339・Openverse の商用可ライセンスのみ・sfx_fetch）：<声の置き場の隣>/rec/ の wav。d 秒で切り、出入りを短く緩める
#   長さ d を先に取る＝持続音（sustain）の呼び方 g[名](長さ, *引数) と同じ形。出来事なら ["rec", 秒, "名.wav"]
REC = os.path.join(os.path.dirname(os.path.abspath(VDIR)), "rec")
def rec(d, name, fin=0.03, fout=0.35):
    from scipy.io import wavfile as _w
    sr, x = _w.read(os.path.join(REC, name)); x = x.astype(np.float64); x = x.mean(1) if x.ndim > 1 else x
    if sr != SR: x = signal.resample_poly(x, SR, sr)
    if d: x = x[: int(d * SR)]
    n = len(x); x = x / (np.abs(x).max() + 1e-12); x[: int(fin * SR)] *= np.linspace(0, 1, int(fin * SR)); x[n - int(fout * SR):] *= np.linspace(1, 0, int(fout * SR)); return x
# 部屋の空気の音（ルームトーン）：低くこもった雑音。乱数は自分専用の種（他の音の乱数の並びを変えない）
def roomtone(d, *_):
    r = np.random.default_rng(339); x = r.standard_normal(int(d * SR)); x = g["lp"](g["hp"](x, 60, 2), 700, 2); return x * np.clip(np.arange(len(x)) / SR / 0.4, 0, 1) * np.clip((len(x) / SR - np.arange(len(x)) / SR) / 0.4, 0, 1)
g["rec"], g["roomtone"] = rec, roomtone
def put(bus, x, t, gain=1.0, pan=0.0):
    i = int(round(t * SR))
    if i < 0: x, i = x[-i:], 0
    x = x[: max(0, N - i)] * gain
    bus[0, i:i + len(x)] += x * (1 - max(0, pan)); bus[1, i:i + len(x)] += x * (1 + min(0, pan))

# ---------------- 音楽（区切りは場面から） ----------------
# 和音：山場の前は F△7 | Am7 を交互、山場の場面は G6（溜め）→ F△9（山場）、山場の後は Am9 | F△9 を交互、最後の場面は Dm9 →(+2拍) C△9（解決）
F7, AM7, G6, F9, AM9, DM9, C9 = ([53, 57, 60, 64], 41), ([57, 60, 64, 67], 45), ([55, 59, 62, 64], 43), ([53, 57, 60, 64, 67], 41), ([57, 60, 64, 67, 71], 45), ([50, 53, 57, 60, 64], 38), ([48, 52, 55, 59, 62], 36)
ids = [s for s, *_ in SCENES]; ci = ids.index(CLIMAX_CUE[0]); CHORDS = []
for i, sid in enumerate(ids):
    if i == len(ids) - 1: CHORDS += [(S[sid][0], *DM9), (S[sid][0] + 2, *C9)]
    elif i == ci: CHORDS += [(S[sid][0], *G6), (CLIMAX_B, *F9)]
    else: CHORDS.append((S[sid][0], *((F7, AM7)[i % 2] if i < ci else (AM9, F9)[(i - ci - 1) % 2])))
BUILD, PRE, DRUM_END = math.ceil(S[ids[2]][0]), math.ceil(S[ids[ci]][0]), math.ceil(S[ids[-1]][0])   # 太鼓：3場面目から2拍ごと／山場の場面から毎拍（溜め）／山場から手拍子／最後の場面で止めて解決
LAST_NOTE_B = END_B - 2                                      # 最後の2拍は余韻だけ（休符）
# 静かな場面（score.music.quiet）：太鼓・低音・分散和音・ハイハットを抜き、和音の帯だけを小さく残す。
#   山場が静かな場面の時は、盛り上げとシンバルを「静けさが明ける」場面の頭へ移す（Opus 5.5 の指示文：暗転で太鼓を抜き、戻りで叩く・#334）
QUIET = SC.get("music", {}).get("quiet", [])
inq = lambda b: any(S[q][0] <= b < S[q][1] for q in QUIET)
QUIET_CLIMAX = CLIMAX_CUE[0] in QUIET
DROP_B = S[ids[ids.index(CLIMAX_CUE[0]) + 1]][0] if QUIET_CLIMAX else CLIMAX_B   # 音の山（シンバル・太鼓の一段上げ）の拍
def chord_at(b):
    c = CHORDS[0]
    for x in CHORDS:
        if x[0] <= b + 1e-9: c = x
    return c
music = stereo()
for k, (c0, ch, root) in enumerate(CHORDS):
    c1 = CHORDS[k + 1][0] if k + 1 < len(CHORDS) else END_B
    vel = 0.30 if c0 < BUILD else 0.32 if c0 < CLIMAX_B else 0.50 if c0 < DRUM_END else 0.34
    if inq(c0): vel = 0.24
    put(music, g["pad"]([note(m - 12) for m in ch[:4]], (c1 - c0) * B + 0.45, vel), bt(c0), 1.0)
for i in range(0, 2 * LAST_NOTE_B + 1):        # 分散和音（8分の格子）：序盤は4分、山場は8分＋オクターブ、終わりは4分
    b = i / 2; _, ch, _ = chord_at(b)
    if (b < BUILD or DRUM_END <= b) and i % 2: continue
    if inq(b): continue
    tone = ch[[0, 2, 1, 3, 2, 1, 3, 2][i % 8] % len(ch)] + (12 if (DROP_B <= b < DRUM_END and i % 4 == 3) else 0)
    vel = 0.20 if b < BUILD else 0.22 if b < DROP_B else 0.24 if b < DRUM_END else 0.20
    put(music, g["pluck"](note(tone + 12), 1.0), bt(b), vel, pan=0.35 * (-1) ** i)
for b in range(BUILD, DRUM_END):
    if (b < PRE and b % 2) or inq(b): continue
    put(music, g["kick"](1.0), bt(b), 0.30 if b < DROP_B else 0.44)   # 溜めは控えめ・山場で一段上げる（ledger R1）
    if b >= DROP_B and b % 2 == 1: put(music, g["snare_clap"](0.8), bt(b), 0.17)
for i in range(math.ceil(2 * S[ids[1]][0]), 2 * DRUM_END):  # ハイハット：2場面目から裏の8分
    if i % 2 == 1 and not inq(i / 2): put(music, g["hat"](False, 0.8), bt(i / 2), 0.05 if i / 2 < DROP_B else 0.07, pan=0.3)
for b in range(BUILD, DRUM_END):               # ベース：4分、山場から8分
    _, _, root = chord_at(b)
    if inq(b): continue
    put(music, g["bass"](note(root - 12), 0.42), bt(b), 0.30)
    if b >= DROP_B: put(music, g["bass"](note(root), 0.24), bt(b) + B / 2, 0.16)
put(music, g["bass"](note(38 - 12), 1.0), bt(DRUM_END), 0.26)        # エンドカードの低音（D）
put(music, g["pluck"](note(62 + 24), 1.0), bt(DRUM_END), 0.26)       # エンドカードの着地を1オクターブ上の音で示す（太鼓が止まる拍・ledger R1）
put(music, g["bass"](note(36 - 12), 1.6), bt(DRUM_END + 2), 0.30)    # 解決の低音（C）
put(music, g["riser"](1.3, 0.6), bt(DROP_B) - 1.3, 0.10)            # 山場（静かな山場なら、明ける所）へ上がる
cr = g["hp"](g["noise"](2.2), 5200) * np.exp(-np.arange(int(2.2 * SR)) / SR / 0.7)   # 山場のシンバル（合成・固定シード）
music_dry = music.copy()                              # 拍は「残響と声の下げの前」の乾いた音楽で測る（#335）：残響の反射（乱数の響きで商品ごとに位置が変わる）を拍の頭と取り違えて
                                                      #   26ms 早く出た・声の切れ目で音楽が戻る上がりも取り違えた。どちらも音の頭の時刻は動かさない（乾いた音はそのまま混ざっている）
                                                      #   シンバル（雑音）も入れない：減衰の途中の雑音の揺れを次の拍の頭と取り違えた（Espresso：山場の2拍後が 23ms 早く出た）
put(music, cr, bt(DROP_B), 0.10, pan=-0.2)
music = g["reverb"](music, 1.8, 0.22)
music *= np.clip((END - np.arange(N) / SR) / 0.6, 0, 1)           # 最後の0.6秒で引く

# ---------------- 出来事（効果音と絵のきっかけ）。時刻は言葉か場面の切れ目から ----------------
# 出来事は product.json の score.events を上から順に読む（効果音の合成の順＝並びの順なので、並びを変えると音も変わる）
#   at：["cue", 場面, 読み, ずらす秒] ／ ["t0"|"t1", 場面, ずらす秒] ／ ["climax", ずらす秒] ／ ["ev", 前の出来事, ずらす秒]
#   sfx：[synth の音の名前, 引数…]（無ければ絵だけのきっかけ）。whoosh は動きの頂点が出来事に来るよう前から鳴らす
t1 = lambda sid: bt(S[sid][1]); t0 = lambda sid: bt(S[sid][0]); E = {}
def when(a):
    k, *r = a
    if k == "cue": return at(r[0], r[1]) + (r[2] if len(r) > 2 else 0)
    if k in ("t0", "t1"): return (t0 if k == "t0" else t1)(r[0]) + (r[1] if len(r) > 1 else 0)
    if k == "climax": return bt(CLIMAX_B) + (r[0] if r else 0)
    if k == "ev": return E[r[0]] + (r[1] if len(r) > 1 else 0)
    sys.exit(f"at の形が分からない: {a}")
EVENTS = []
for ev in SC["events"]:
    E[ev["id"]] = when(ev["at"]); fx = ev.get("sfx")
    EVENTS.append((ev["id"], E[ev["id"]], ev.get("what", ""), (lambda f: (lambda: g[f[0]](*f[1:])))(fx) if fx else None, ev.get("band", "")))
# 持続音（満ちる間・溜めの間。長さが言葉で決まるので出来事の後に作る）
EVENTS_SUS = [(x["id"], when(x["from"]), when(x["to"]) - when(x["from"]), x["sfx"]) for x in SC.get("sustain", [])]

SWISH = {e["id"] for e in SC["events"] if (e.get("sfx") or [""])[0] == "whoosh"}    # 動きの頂点が出来事に来るよう前から鳴らす（whoosh の頂点＝長さ×0.62）
SUS = {x["id"] for x in SC.get("sustain", [])}
# 役割ごとの大きさ（窓の RMS を音楽と比べた dB）：打つ音＋1.5／スウィッシュ−2／持続音−8。頂点は＋2dB 上限（ledger R1）
OVER = {x["id"]: x["over_db"] for x in SC["events"] + SC.get("sustain", []) if "over_db" in x}   # 録音・空気の音は設計書で大きさを決める
over_db = lambda eid: OVER.get(eid, -8.0 if eid in SUS else -2.0 if eid in SWISH else 1.5)
rms = lambda a: np.sqrt(np.mean(a ** 2)) + 1e-12
sfx = stereo(); WIN = {}
def place(eid, t, x):
    lead = len(x) / SR * 0.62 if eid in SWISH else 0.0
    i0 = max(0, int(round((t - lead) * SR))); i1 = min(N, i0 + len(x)); WIN[eid] = (i0, i1); m = music[:, i0:i1]; xs = x[: i1 - i0]; o = over_db(eid)
    gain = min(rms(m) * 10 ** (o / 20) / rms(xs), np.abs(m).max() * 10 ** ((o + 2.0) / 20) / (np.abs(xs).max() + 1e-12))
    put(sfx, x, t - lead, gain)
for eid, t, what, fn, band in EVENTS:
    if fn: place(eid, t, fn())
for eid, t, d, fx in EVENTS_SUS: place(eid, t, g[fx[0]](d, *fx[1:]))
# 山場の前の静けさ（score.music.hush：[[from, to], …]・時刻は at の形）：音楽だけを 0.12秒で −24dB まで下げて戻す（lemo-opuscar DIRECTOR §6「山場の前に本当の静けさ」）。
#   効果音の大きさは下げる前の音楽で決めた後に下げる（下げた後で決めると、静けさの直後のカチッまで小さくなる）。拍の検出は乾いた音楽のまま
for a, b in SC.get("music", {}).get("hush", []):
    ta, tb = when(a), when(b); tt = np.arange(N) / SR
    music *= 1 - (1 - 10 ** (-24 / 20)) * np.clip((tt - ta) / 0.12, 0, 1) * np.clip((tb - tt) / 0.12, 0, 1)
sfx *= np.clip((END - np.arange(N) / SR) / 0.3, 0, 1)

# ---------------- 声：置く・背景を下げる（声と背景の差 14dB・#309） ----------------
voice = stereo()
for v in VOICE: put(voice, synth.voice_decode(os.path.join(VDIR, v["file"]), TEMPO), v["start"], 0.9)
env = np.abs(voice[0]); env = g["lp"](env, 6, 2); env = np.clip(env / (env.max() + 1e-9) * 3, 0, 1)
music *= 1 - 0.72 * env; sfx *= 1 - 0.35 * env       # 言葉と同時に鳴る打つ音（cue）は残したいので効果音は浅く下げる
vm = env > 0.5; r = lambda x: 20 * np.log10(np.sqrt(np.mean(x[:, vm] ** 2)) + 1e-12)
need = 14.0 - (r(voice) - r(music + sfx))
if need > 0: music *= 10 ** (-need / 20); sfx *= 10 ** (-need / 20)
voice_over_bed = round(r(voice) - r(music + sfx), 1)

# ---------------- 書き出し・ラウドネス ----------------
def write(path, bus): wavfile.write(path, SR, bus.T.astype(np.float32))
mix = voice + music + sfx
peak = np.abs(mix).max(); mix /= peak / 0.8; music_n = music / (peak / 0.8); sfx_n = sfx / (peak / 0.8)
write(f"{OUT}/music.wav", music_n); write(f"{OUT}/sfx.wav", sfx_n); write(f"{OUT}/mix_raw.wav", mix)

def measure(path):
    e = subprocess.run([FF, "-hide_banner", "-i", path, "-af", "loudnorm=I=-14:TP=-1.5:LRA=7:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    i = e.rindex("{"); return json.loads(e[i:e.index("}", i) + 1])   # loudnorm の JSON の後ろに ffmpeg の行が続くので {…} だけ取る
def norm(src, dst, codec=True):
    m = measure(src)
    af = (f"loudnorm=I=-14:TP=-1.5:LRA=7:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    args = ["-c:a", "aac", "-b:a", "192k"] if codec else []
    subprocess.run([FF, "-v", "error", "-y", "-i", src, "-af", af, "-ar", "48000", "-t", f"{END:.3f}", *args, dst], check=True)
norm(f"{OUT}/mix_raw.wav", f"{OUT}/audio.m4a"); norm(f"{OUT}/mix_raw.wav", f"{OUT}/audio_mix.wav", codec=False)
norm(f"{OUT}/music.wav", f"{OUT}/music_only.m4a")    # 純音楽版（声も効果音もなし）
final = measure(f"{OUT}/audio_mix.wav"); stem_m = measure(f"{OUT}/music.wav"); stem_s = measure(f"{OUT}/sfx.wav")
pk = lambda bus, w: 20 * np.log10(np.abs(bus[:, w[0]:w[1]]).max() + 1e-12)
local = [{"id": eid, "sfx_minus_music_db": round(pk(sfx_n, w) - pk(music_n, w), 1)} for eid, w in WIN.items()]

# ---------------- ビート検出（書き出した音楽から） ----------------
# 拍の時刻＝2kHz 以上の包絡が一番急に上がった所（全帯域だと残響の前遅れで遅く、しきい値だと上がり音で早く出た・ledger R1）
mono = g["hp"](music_dry.mean(0) / (peak / 0.8), 2000); hop = int(0.001 * SR)
envh = np.sqrt(np.convolve(mono ** 2, np.ones(hop * 2) / (hop * 2), "same"))[::hop]
beats, worst = [], 0.0
for b in range(0, END_B):
    t = bt(b)
    if b > LAST_NOTE_B or inq(b): beats.append({"b": b, "t": t, "frame": fr(t), "rest": True}); continue   # 最後の余韻・静かな場面（音の頭を置いていない拍）
    c = int(t * 1000); lo, hi = max(0, c - 40), min(len(envh), c + 40)
    d = np.diff(envh[lo:hi]); k = lo + int(np.argmax(d)) + 1
    det = k / 1000; err = (det - t) * FPS
    worst = max(worst, abs(err)); beats.append({"b": b, "t": round(t, 3), "frame": fr(t), "detected_t": round(det, 4), "err_frames": round(err, 2)})

timing = {
    "fps": FPS, "bpm": BPM, "end": END, "frames": fr(END), "beat_sec": B, "climax": {"b": CLIMAX_B, "t": bt(CLIMAX_B), "frame": fr(bt(CLIMAX_B))},
    "scenes": [{"id": s, "b0": x0, "b1": x1, "t0": bt(x0), "t1": bt(x1), "f0": fr(bt(x0)), "f1": fr(bt(x1))} for s, x0, x1 in SCENES],
    "voice": VOICE,
    "events": [{"id": e, "t": round(t, 3), "frame": fr(t), "what": w, "sfx": fn is not None, "band": band} for e, t, w, fn, band in EVENTS],
    "beats": beats, "beat_sync_worst_frames": round(worst, 2),
    "loudness": {"mix_I": final["input_i"], "mix_TP": final["input_tp"], "music_stem_I": stem_m["input_i"], "sfx_stem_I": stem_s["input_i"],
                 "voice_over_bed_db": voice_over_bed,
                 # 積算 LUFS はゲートで無音を除く＝まばらな効果音は「鳴っている間だけ」の大きさになる。全体の取り分は無ゲートの Leq で見る
                 "music_Leq_db": round(10 * np.log10(np.mean(music_n ** 2) + 1e-20), 1), "sfx_Leq_db": round(10 * np.log10(np.mean(sfx_n ** 2) + 1e-20), 1),
                 "sfx_below_music_integrated": float(stem_s["input_i"]) < float(stem_m["input_i"]),
                 "sfx_below_music_Leq": bool(np.mean(sfx_n ** 2) < np.mean(music_n ** 2)), "sfx_local_peaks": local},
}
json.dump(timing, open(f"{OUT}/timing.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({"end": END, "scenes": [(s, bt(x0), bt(x1)) for s, x0, x1 in SCENES], "climax_t": bt(CLIMAX_B), "beat_sync_worst_frames": timing["beat_sync_worst_frames"],
                  "voice_over_bed_db": voice_over_bed, **{k: v for k, v in timing["loudness"].items() if k not in ("sfx_local_peaks", "voice_over_bed_db")}}, ensure_ascii=False))
