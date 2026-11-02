#!/usr/bin/env python3
# UGREEN「一本の線」の品質の門番（#333・v3 語りつき）。プロンプトの品質基準＋社内の点検（qcpage/qctext/ovl を再利用）
#   python3 factory/qc_edge.py <product.json> <outdir> <facts.json>
#   1つでも落ちたら ok=false。結果は JSON（qc.json）
import json, os, re, subprocess, sys, glob, shutil
import numpy as np
from PIL import Image
pj, outdir, factsp = sys.argv[1:4]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FF = os.environ["FFMPEG"]; V = os.path.join(outdir, "final.mp4"); env = dict(os.environ, QC_CONTRAST="4.5"); R = {}
TL = json.load(open(os.path.join(ROOT, env["TL"]) if not os.path.isabs(env["TL"]) else env["TL"]))
node = lambda js: json.loads(subprocess.run(["node", os.path.join(ROOT, js)], capture_output=True, text=True, env=env, cwd=ROOT).stdout.strip().splitlines()[-1])

# 1) 長さ・大きさ・フレームレート（完全に一致）
e = subprocess.run([FF, "-hide_banner", "-i", V, "-map", "0:v", "-f", "null", "-"], capture_output=True, text=True).stderr   # ffprobe は同梱されないので ffmpeg で数える
nfr = int(re.findall(r"frame=\s*(\d+)", e)[-1]); wh = re.search(r", (\d{3,4})x(\d{3,4})", e); fps = float(re.search(r"(\d+(?:\.\d+)?) fps", e).group(1))
h_, m_, s_ = re.search(r"Duration: (\d+):(\d+):([0-9.]+)", e).groups(); dur = int(h_) * 3600 + int(m_) * 60 + float(s_)
w_, hh_ = int(wh.group(1)), int(wh.group(2))
R["長さ・大きさ・fps"] = {"ok": nfr == TL["frames"] and (w_, hh_) == (1080, 1920) and abs(fps - TL["fps"]) < 1e-6 and abs(dur - TL["end"]) <= 1 / TL["fps"],
                     "フレーム数": nfr, "期待": TL["frames"], "大きさ": f"{w_}x{hh_}", "fps": fps, "秒": round(dur, 3)}

# 2) 1コマ目（完成した絵：商品と見出し）・文字の最小サイズ
pg = node("factory/qcpage.mjs")
R["1コマ目に商品"] = {"ok": pg["frame0"]["product"]}; R["1コマ目に見出し"] = {"ok": pg["frame0"]["texts"] > 0, "数": pg["frame0"]["texts"]}
R["文字の最小サイズ"] = {"ok": pg["minFont"] >= 23, "px": pg["minFont"]}

# 3) 文字と写真の重なり（エレメントの干渉なし）
ov = os.path.join(outdir, "ov"); shutil.rmtree(ov, ignore_errors=True)
subprocess.run(["node", os.path.join(ROOT, "ovl.mjs"), "0.1", str(TL["end"] - 0.1), "0.3", ov], cwd=ROOT, env=env, check=True, capture_output=True)
bad = []
for f in sorted(glob.glob(f"{ov}/txt_*.png")):
    a = np.array(Image.open(f).convert("RGBA"))[:, :, 3] > 20; b = np.array(Image.open(f.replace("txt_", "prd_")).convert("RGBA"))[:, :, 3] > 60
    n = int((a & b).sum())
    if n > 500: bad.append([re.findall(r"txt_(\d+\.\d+)", f)[0], n])
R["文字と写真の重なり"] = {"ok": not bad, "重なったコマ": bad[:10]}

# 4) 文字：文字化け・豆腐・コントラスト 4.5:1・出るべき文字が欠けずに 0.5秒以上・PR 95%
tx = node("factory/qctext.mjs")
R["文字化け"] = {"ok": not tx["mojibake"], "見つけた所": tx["mojibake"][:10]}
R["豆腐（字の欠け）"] = {"ok": not tx["tofu"], "字": tx["tofu"][:10]}
R["コントラスト4.5:1"] = {"ok": not tx.get("lowContrast"), "読みにくい文字": tx.get("lowContrast", [])[:10]}
R["出るべき文字が見える"] = {"ok": not tx["missing"] and tx["prRatio"] >= 0.95, "見えない文字": tx["missing"][:10], "PRが見える割合": tx["prRatio"], "調べた文字列": tx["expected"]}

# 5) セーフ領域
sf = node("factory/qcsafe.mjs"); R["セーフ領域"] = {"ok": not sf["outside"], "はみ出し": sf["outside"][:10]}

# 6) 凍結・静止（0.5秒を超える静止が無い）・黒いコマ・1コマだけ飛び出すコマ
e = subprocess.run([FF, "-hide_banner", "-i", V, "-vf", "blackdetect=d=0.05:pix_th=0.03,freezedetect=n=0.0005:d=0.5", "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
R["静止0.5秒超え"] = {"ok": "freeze_start" not in e, "区間": re.findall(r"freeze_start: ([0-9.]+)", e)[:10]}
R["黒いコマ"] = {"ok": "black_start" not in e}
# 止まって見える時間（echris6/motion-video-kit の frozen-time・MIT）：上の freezedetect は「完全に同じ絵」しか拾わない。
#   10fps・幅320の明るさの差の平均が 0.35 未満の所を「止まって見える」とし、1か所 0.6秒を超えたら落とす（最後のボタンの 2秒は除く・キットの quality-bar）
e = subprocess.run([FF, "-hide_banner", "-i", V, "-vf", "fps=10,scale=320:-1,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
yv = [float(x) for x in re.findall(r"YAVG=([0-9.]+)", e)]
if not yv: sys.exit("止まり時間：明るさの差が1つも読めない（読まずに合格にしない）")
runs, cur = [], None
for i, y in enumerate(yv):
    tt = (i + 1) / 10
    if y < 0.35 and tt < TL["end"] - 2.0: cur = cur or [tt, tt]; cur[1] = tt
    elif cur: runs.append(cur); cur = None
if cur: runs.append(cur)
long_ = [[round(a, 1), round(b + 0.1, 1)] for a, b in runs if b + 0.1 - a > 0.6]
R["止まって見える時間"] = {"ok": not long_, "0.6秒を超えた所": long_, "合計秒": round(sum(b + 0.1 - a for a, b in runs), 1), "読んだ数": len(yv)}
raw = subprocess.run([FF, "-v", "error", "-i", V, "-vf", "scale=72:128,format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, 128, 72).astype(np.float32)
da, db, dc = (np.abs(fr[1:-1] - fr[:-2]).mean((1, 2)), np.abs(fr[2:] - fr[1:-1]).mean((1, 2)), np.abs(fr[2:] - fr[:-2]).mean((1, 2)))
pops = (np.nonzero((da > 4) & (db > 4) & (dc < 0.35 * np.minimum(da, db)))[0] + 1).tolist()
R["1コマだけ飛び出すコマ"] = {"ok": not pops, "コマ": pops[:10]}
# 1コマで画面の 30% 超が変わらない（洪水・アイリスを速く緩めると1コマで画面の半分が変わる・#334。v3 の最大 13.6%／直す前の v4 55.5%）
chg = (np.abs(fr[1:] - fr[:-1]) > 30).mean((1, 2)); big = [[round((i + 1) / TL["fps"], 3), round(float(chg[i]) * 100, 1)] for i in np.argsort(chg)[::-1][:5] if chg[i] > 0.30]
R["1コマで画面の30%超が変わらない"] = {"ok": not big, "最大%": round(float(chg.max()) * 100, 1), "越えたコマ": big}

# 7) 音：−14 LUFS・TP ≤ −1・拍の同期（1フレーム以内）・効果音は全体として音楽より下
e = subprocess.run([FF, "-hide_banner", "-i", V, "-vn", "-af", "loudnorm=print_format=summary", "-f", "null", "-"], capture_output=True, text=True).stderr
I = float(re.search(r"Input Integrated:\s+(-?[0-9.]+)", e).group(1)); TP = float(re.search(r"Input True Peak:\s+(-?[0-9.]+)", e).group(1))
R["ラウドネス"] = {"ok": abs(I + 14) <= 1.0 and TP <= -1.0, "LUFS": I, "TP": TP}
if "voice_over_bed_db" in TL["loudness"]:   # 語りの時：声と背景の差（合格 9dB 以上・#267-7／狙い 14dB・#309）
    R["声と背景の差"] = {"ok": TL["loudness"]["voice_over_bed_db"] >= 9, "dB": TL["loudness"]["voice_over_bed_db"]}
if tx.get("credit") is not None:   # #308 VOICEVOX の声の時だけ。クレジット「VOICEVOX:話者名」が出ているか
    R["VOICEVOXクレジット"] = {"ok": tx["credit"]["ok"], **{k: v for k, v in tx["credit"].items() if k != "ok"}}
R["拍の同期"] = {"ok": TL["beat_sync_worst_frames"] <= 1.0, "最大のずれ（フレーム）": TL["beat_sync_worst_frames"], "休符": [b["b"] for b in TL["beats"] if b.get("rest")]}
Lq = TL["loudness"]; R["効果音は音楽より下（全体）"] = {"ok": Lq["sfx_below_music_Leq"], "音楽Leq": Lq["music_Leq_db"], "効果音Leq": Lq["sfx_Leq_db"],
                                              "参考_積算LUFS（ゲートで無音を除く）": {"音楽": Lq["music_stem_I"], "効果音": Lq["sfx_stem_I"]}}

# 8) 色（描画されたブランド色）：1コマ目の地＝#F5F6F8・「8.6」の銅色の画素がある
f0 = os.path.join(outdir, "frame0.png"); subprocess.run([FF, "-v", "error", "-y", "-i", V, "-frames:v", "1", f0], check=True)
im = np.array(Image.open(f0).convert("RGB")).astype(int)
# 地の色と要の色は設計書の brand（商品ごと）。要の色は1コマ目の大きな数字の箱 [x0,y0,x1,y1] の中で数える
BR = json.load(open(pj)).get("brand") or sys.exit("設計書に brand（ground・accent・accent_box）が無い")
ground = im[60:120, 900:1040].reshape(-1, 3).mean(0); hexv = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)])
x0, y0, x1, y1 = BR["accent_box"]; reg = im[y0:y1, x0:x1].reshape(-1, 3); acc = np.abs(reg - hexv(BR["accent"])).max(1) <= 8
R["描画されたブランド色"] = {"ok": bool(np.abs(ground - hexv(BR["ground"])).max() <= 3 and acc.sum() > 2000),
                     "地（実測）": "#%02X%02X%02X" % tuple(int(round(v)) for v in ground), "地（設計）": BR["ground"], "要の色の画素数": int(acc.sum())}

# 9) 事実：画面の各文字の出典 id が facts.json にある／画面の数字がすべて facts.json の原文にある
P = json.load(open(pj)); FA = json.load(open(factsp)); ids = {c["id"] for c in FA["claims"]}
corpus = json.dumps(FA, ensure_ascii=False)
def strings(v):
    if isinstance(v, str): yield v
    elif isinstance(v, list):
        for x in v: yield from strings(x)
    elif isinstance(v, dict):
        for k, x in v.items():
            if k not in ("kind", "source"): yield from strings(x)
miss_id, miss_num = [], []
for b in P["beats"]:
    for i in [x.strip() for x in b.get("source", "").split(",") if x.strip()]:
        if i not in ids: miss_id.append(f'{b["kind"]}:{i}')
    for s in strings(b):
        for n in re.findall(r"\d+(?:\.\d+)?", s):
            if n == "4" and "F7" in b.get("source", ""): continue    # 「4色」＝F7 の色の数（グレー 水色 ホワイト ピンク）
            if n not in corpus: miss_num.append(f'{b["kind"]}「{s[:16]}」の {n}')
R["事実（出典）"] = {"ok": not miss_id and not miss_num, "出典の無い id": miss_id, "原文に無い数字": miss_num}

# 10) 配信の重さ
kbps = os.path.getsize(V) * 8 / 1000 / dur; R["配信の重さ"] = {"ok": kbps <= 8000, "kbps": round(kbps)}
R["ok"] = all(v["ok"] for v in R.values() if isinstance(v, dict))
print(json.dumps(R, ensure_ascii=False, indent=1))
