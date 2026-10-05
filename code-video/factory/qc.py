# 品質の門番（#267-7・文字は #270）。1つでも落ちたら ok=false（投稿に回さない）
import json, os, re, subprocess, sys, glob
import numpy as np
from PIL import Image
pj, outdir = sys.argv[1], sys.argv[2]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FF = os.environ["FFMPEG"]; V = os.path.join(outdir, "final.mp4"); R = {}
env = dict(os.environ)
# 1) 1コマ目・文字の最小サイズ
pg = json.loads(subprocess.run(["node", os.path.join(ROOT, "factory/qcpage.mjs")], capture_output=True, text=True, env=env, cwd=ROOT).stdout.strip().splitlines()[-1])
R["1コマ目に商品"] = {"ok": pg["frame0"]["product"]}
R["1コマ目に見出し"] = {"ok": pg["frame0"]["texts"] > 0, "数": pg["frame0"]["texts"]}
R["文字の最小サイズ"] = {"ok": pg["minFont"] >= 23, "px": pg["minFont"]}
# 2) 文字と商品の重なり（実体の重なり 500画素超を落とす）
ov = os.path.join(outdir, "ov"); subprocess.run(["node", os.path.join(ROOT, "ovl.mjs"), "0.1", str(json.load(open(os.path.join(ROOT, env["TL"])))["end"] - 0.1), "0.3", ov], cwd=ROOT, env=env, check=True)
bad = []
for f in sorted(glob.glob(f"{ov}/txt_*.png")):
    a = np.array(Image.open(f).convert("RGBA"))[:, :, 3] > 20; b = np.array(Image.open(f.replace("txt_", "prd_")).convert("RGBA"))[:, :, 3] > 60
    n = int((a & b).sum())
    if n > 500: bad.append([re.findall(r"txt_(\d+\.\d+)", f)[0], n])
R["文字と商品の重なり"] = {"ok": not bad, "重なったコマ": bad[:10]}
# 2b) 文字（#270）：文字化け・豆腐（同梱フォントに無い字）・出るべき文字が欠けずに 0.5秒以上見える・PR が95%以上見える
tx = json.loads(subprocess.run(["node", os.path.join(ROOT, "factory/qctext.mjs")], capture_output=True, text=True, env=env, cwd=ROOT).stdout.strip().splitlines()[-1])
MOJI = re.compile(r"\uFFFD|[\u00C3\u00C2][\u0080-\u00BF]|[縺繧繝譁蜿]")
pp = os.path.join(outdir, "post.json"); post = json.load(open(pp)) if os.path.exists(pp) else {}
tx["mojibake"] += [f"投稿文({k})" for k in ("tiktok", "x") if MOJI.search(post.get(k, ""))]
R["文字化け"] = {"ok": not tx["mojibake"], "見つけた所": tx["mojibake"][:10]}
R["豆腐（字の欠け）"] = {"ok": not tx["tofu"], "字": tx["tofu"][:10]}
R["出るべき文字が見える"] = {"ok": not tx["missing"] and tx["prRatio"] >= 0.95, "見えない文字": tx["missing"][:10], "PRが見える割合": tx["prRatio"], "調べた文字列": tx["expected"]}
# 3) 黒いコマ・止まったコマ
e = subprocess.run([FF, "-hide_banner", "-i", V, "-vf", "blackdetect=d=0.05:pix_th=0.03,freezedetect=n=0.0005:d=0.5", "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
R["黒いコマ"] = {"ok": "black_start" not in e}; R["止まったコマ"] = {"ok": "freeze_start" not in e}
# 4) 音量・声と背景の差・長さ
e = subprocess.run([FF, "-hide_banner", "-i", V, "-vn", "-af", "loudnorm=print_format=summary", "-f", "null", "-"], capture_output=True, text=True).stderr
I = float(re.search(r"Input Integrated:\s+(-?[0-9.]+)", e).group(1)); TP = float(re.search(r"Input True Peak:\s+(-?[0-9.]+)", e).group(1))
R["音量"] = {"ok": abs(I + 14) <= 1.0 and TP <= -1.0, "LUFS": I, "TP": TP}
vb = json.load(open(os.path.join(outdir, "audio.json")))["voice_over_bed_db"]; R["声と背景の差"] = {"ok": vb >= 9, "dB": vb}
d = float(re.search(r"Duration: (\d+):(\d+):([0-9.]+)", subprocess.run([FF, "-hide_banner", "-i", V], capture_output=True, text=True).stderr).group(3))
R["長さ"] = {"ok": 15 <= d <= 21, "秒": d}
kbps = os.path.getsize(V) * 8 / 1000 / d; R["配信の重さ"] = {"ok": kbps <= 8000, "kbps": round(kbps)}   # スマホで見て止まらない重さ（オーナー指摘）
R["ok"] = all(v["ok"] for v in R.values() if isinstance(v, dict))
print(json.dumps(R, ensure_ascii=False, indent=1))
