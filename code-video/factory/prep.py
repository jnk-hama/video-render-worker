# 素材の下ごしらえを1コマンドに（M4）
#   prep.py request <product.json>  … 取り寄せの依頼（samples/motion/request.json）を書く。push すると motion-sample-fetch が動く
#   prep.py unpack  <product.json>  … 届いた暗号文を開け（手元）、assets と同じことをする
#   prep.py fetch   <product.json>  … （Actions）Storage の商品画像・Pexels・edge-tts を stage/p/<key>/src へ直接取る
#   prep.py assets  <product.json>  … src から切り抜き・板・実写の駒・声を stage/p/<key>/ に並べ、確認用の一覧を出す
# 設計書の "prep" に書いた通りに作る（手作業の切り抜き範囲・実写の区間は Claude が画像を見て決めて書く）
import json, os, subprocess, sys, tarfile, io, glob, shutil
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
REPO = os.environ.get("REPO", "/home/user/jmas-ai-os"); KEYPEM = os.path.join(ROOT, "key.pem")
FF = os.environ.get("FFMPEG") or subprocess.check_output(["python3", "-c", "import imageio_ffmpeg as i;print(i.get_ffmpeg_exe())"]).decode().strip()
CV = os.environ.get("CVPY") or (os.path.join(ROOT, "venv-cv/bin/python") if os.path.exists(os.path.join(ROOT, "venv-cv")) else sys.executable)   # EDSR（opencv-contrib）
GRADE = {   # 実写の色合わせ（型の背景に寄せる）
    "blush": "curves=all='0/0.20 0.5/0.62 1/0.98',colorchannelmixer=rr=1.0:rg=0.05:gg=0.92:bb=0.82:br=0.04,eq=saturation=0.72:contrast=0.92,colorbalance=rs=0.10:gs=0.0:bs=0.02:rm=0.06:gm=-0.02:bm=0.0:rh=0.04:gh=0.0:bh=0.02",   # SALONIA で決めた色
    "warm": "eq=contrast=1.06:saturation=0.9:gamma=0.97,colorbalance=rs=0.06:gs=0.02:bs=-0.06:rm=0.04:bm=-0.04",   # BALMUDA で決めた色
    "none": "null"}

def tts_text(s, P):
    """読み上げ用の文：読み違える言葉を読みに置き換える（factory/readings.json＋設計書の readings）。画面の文字は変えない"""
    rd = {k: v for k, v in json.load(open(os.path.join(HERE, "readings.json"))).items() if k != "_"}; rd.update(P.get("readings", {}))
    for k in sorted(rd, key=len, reverse=True): s = s.replace(k, rd[k])
    return s

def voices(P):
    """読み上げの一覧 [(文, 置く名前)]：各カット → 見出しの別案（hooks の2つ目以降）の順。line<i>.mp3 の i がこの並び"""
    vs = (P.get("variants") or P.get("hooks") or [])[1:]
    v = [(b.get("say"), b["voice"]) for b in P["beats"]] + [(h.get("say"), h.get("voice")) for h in vs if h.get("say")] + [(b.get("say"), b.get("voice")) for h in vs for b in (h.get("replace") or {}).values()]
    bad = [f for s, f in v if not s or not f]
    if bad: sys.exit(f"say（読み上げの文）か voice（置く名前）が無い: {bad}")
    return v

def request(P):
    pr = P["prep"]; path = os.path.join(REPO, "samples/motion/request.json")
    old = json.load(open(path)) if os.path.exists(path) else {}
    req = {"images": pr["images"], "voice": pr.get("voice", "ja-JP-NanamiNeural"), "rate": pr.get("rate", "+8%"),
           "lines": [tts_text(s, P) for s, _ in voices(P)], "videos": pr.get("videos", []), "nonce": old.get("nonce", 0) + 1}
    json.dump(req, open(path, "w"), ensure_ascii=False, indent=2); print("書いた:", path, "nonce", req["nonce"]); print("次：commit・push → Actions の完了を待って unpack")

def decrypt(dst):
    enc = os.path.join(REPO, "samples/motion")
    k = subprocess.run(["openssl", "pkeyutl", "-decrypt", "-inkey", KEYPEM, "-pkeyopt", "rsa_padding_mode:oaep", "-in", f"{enc}/assets.key.enc"], capture_output=True, check=True).stdout
    kf = os.path.join(dst, ".k"); open(kf, "wb").write(k)
    tar = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", f"file:{kf}", "-in", f"{enc}/assets.tar.enc"], capture_output=True, check=True).stdout
    os.remove(kf); tarfile.open(fileobj=io.BytesIO(tar)).extractall(dst, filter="data")

CUT = r'''
import sys, numpy as np, cv2
from PIL import Image
from rembg import remove, new_session
src, out = sys.argv[1:3]; keep_all = len(sys.argv) > 3 and sys.argv[3] == "1"
o = remove(Image.open(src).convert("RGB"), session=new_session("birefnet-general", providers=["CPUExecutionProvider"]), post_process_mask=False)
a = np.array(o)
if not keep_all:   # 一番大きい塊だけ（画像の文字を落とす）。部品が離れて写っている物は keep_all
    m = (a[:, :, 3] > 40).astype(np.uint8); _, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    k = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA]); a[:, :, 3] = np.where(lab == k, a[:, :, 3], 0)
o = Image.fromarray(a); o = o.crop(o.getbbox()); o.save(out); print(out, o.size)
'''
SR = r'''
import sys, cv2
sr = cv2.dnn_superres.DnnSuperResImpl_create(); sr.readModel(sys.argv[3]); sr.setModel("edsr", 4)
cv2.imwrite(sys.argv[2], sr.upsample(cv2.imread(sys.argv[1])))
'''

# 1枚の写真に複数の商品が並ぶ時（RR35：掃除機・ステーション）。全体を切り抜いて塊に分け、色のにじみを除き、EDSR で4倍・輪郭を戻す
SPLIT_CUT = r"""
import sys
from PIL import Image
from rembg import remove, new_session
remove(Image.open(sys.argv[1]).convert("RGB"), session=new_session("birefnet-general", providers=["CPUExecutionProvider"]), only_mask=False, post_process_mask=False).save(sys.argv[2])
"""
SPLIT_PARTS = r"""
import sys, json, numpy as np, cv2
from PIL import Image
from pymatting import estimate_foreground_ml
src_p, cut_p, parts, outdir, excl = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4], json.loads(sys.argv[5])
src = np.array(Image.open(src_p).convert("RGB")).astype(np.float64) / 255
cut = np.array(Image.open(cut_p).convert("RGBA")); alpha = cut[..., 3].astype(np.float64) / 255; H, W = alpha.shape
m = cv2.morphologyEx((alpha > 0.16).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
comps = sorted([i for i in range(1, n) if st[i][4] > 3000], key=lambda i: st[i][0]); pick = {}   # 左→右
def choose(rule, left): return max(left, key=lambda i: st[i][3]) if rule == "tallest" else max(left, key=lambda i: st[i][0]) if rule == "rightmost" else min(left, key=lambda i: st[i][0]) if rule == "leftmost" else left[0]
for rule in excl: comps.remove(choose(rule, comps))   # 使わない塊（RR35 の白い別製品など）を先に外す
for name, rule in sorted(parts.items(), key=lambda kv: kv[1] == "rest"):
    left = [i for i in comps if i not in pick.values()]
    pick[name] = choose(rule, left)
for name, i in pick.items():
    x, y, w, h, _ = st[i]; pad = 6
    x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad)
    keep = cv2.dilate((lab[y0:y1, x0:x1] == i).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)   # 隣の部品の画素は透明に
    a = alpha[y0:y1, x0:x1] * keep; fg = estimate_foreground_ml(src[y0:y1, x0:x1], a)
    Image.fromarray((np.dstack([np.clip(fg, 0, 1), a]) * 255 + 0.5).astype(np.uint8), "RGBA").save(f"{outdir}/comp_{name}")
    print(name, (x0, y0, x1, y1))
"""
SPLIT_SR = r"""
import sys, cv2, numpy as np
comp_p, out, model = sys.argv[1:4]
im = cv2.imread(comp_p, cv2.IMREAD_UNCHANGED); bgr = im[..., :3]; a = im[..., 3]
sr = cv2.dnn_superres.DnnSuperResImpl_create(); sr.readModel(model); sr.setModel("edsr", 4)
filled = cv2.inpaint(bgr, (a < 8).astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)   # 透明部をまわりの色で埋めてから拡大（黒いにじみを作らない）
rgb = sr.upsample(filled); H, W = rgb.shape[:2]
def smoothstep(e0, e1, x): t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
a4 = smoothstep(0.30, 0.70, cv2.GaussianBlur(cv2.resize(a.astype(np.float32) / 255, (W, H), interpolation=cv2.INTER_CUBIC), (0, 0), 1.1))   # 輪郭をくっきり
rgb = cv2.addWeighted(rgb, 1.35, cv2.GaussianBlur(rgb, (0, 0), 2.0), -0.35, 0)   # EDSR の甘さを少し戻す
cv2.imwrite(out, np.dstack([rgb, (a4 * 255 + 0.5).astype(np.uint8)])); print(out, rgb.shape)
"""

# 説明図の赤い線（図の飾り）を消す。商品の形・色は変えない（RR35 のフィルターで決めた処理）
DERED = r"""
import sys, cv2, numpy as np
c = cv2.imread(sys.argv[1]); hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
red = (((hsv[..., 0] < 12) | (hsv[..., 0] > 165)) & (hsv[..., 1] > 80) & (hsv[..., 2] > 80)).astype(np.uint8) * 255
cv2.imwrite(sys.argv[1], cv2.inpaint(c, cv2.dilate(red, np.ones((5, 5), np.uint8)), 4, cv2.INPAINT_TELEA))
"""

def fade_bottom(png, cut):
    """下の端（画像の注記の切れ端が残る所）を高さの割合 cut から柔らかく消して詰め直す（SALONIA で決めた処理）"""
    import numpy as np; from PIL import Image
    a = np.array(Image.open(png)).astype(np.float32); y = np.arange(a.shape[0])[:, None] / a.shape[0]
    a[:, :, 3] *= np.clip((cut + 0.06 - y) / 0.06, 0, 1); o = Image.fromarray(a.astype(np.uint8)); o = o.crop(o.getbbox()); o.save(png); print(png, "下を消した", o.size)

PLATE = r'''
import sys, json, cv2
src, out, model, sr, size = sys.argv[1:6]; a = cv2.imread(src); size = json.loads(size)
if sr == "1": m = cv2.dnn_superres.DnnSuperResImpl_create(); m.readModel(model); m.setModel("edsr", 4); a = m.upsample(a)
if size: a = cv2.resize(a, tuple(size), interpolation=cv2.INTER_AREA)
cv2.imwrite(out, a, [cv2.IMWRITE_JPEG_QUALITY, 92])
'''

def focus_candidates(png):
    """寄る点の候補（世界の単位＝画素/4）：重心・上端・下端・左端・右端。Claude が一覧で目で確かめて選ぶ"""
    import numpy as np; from PIL import Image
    a = np.array(Image.open(png))[:, :, 3] > 128; ys, xs = np.nonzero(a); q = lambda v: round(float(v) / 4)
    pick = lambda idx: [q(xs[idx]), q(ys[idx])]
    return {"size": [q(a.shape[1]), q(a.shape[0])], "body": [q(xs.mean()), q(ys.mean())], "top": pick(ys.argmin()), "bottom_y": q(ys.max()),
            "left": pick(xs.argmin()), "right": pick(xs.argmax())}

def dirs(P):
    D = os.path.join(ROOT, "stage/p", P["product_key"]); S = os.path.join(D, "src"); os.makedirs(S, exist_ok=True); return D, S

def unpack(P):
    D, S = dirs(P); decrypt(S); print("取り出し:", sorted(os.listdir(S))); assets(P)

def fetch(P):
    """Actions 用：motion-sample-fetch と同じ物を、暗号化せずに作業場所へ直接取る（公開リポジトリには置かない）"""
    import re
    pr = P["prep"]; D, S = dirs(P)
    raw = re.sub(r"[^A-Za-z0-9:/._-]", "", os.environ.get("SUPABASE_URL", "")); host = re.sub(r"^https?://", "", raw).split("/")[0]
    host = host if "." in host else host + ".supabase.co"
    for i, p in enumerate(pr["images"]):
        if not re.fullmatch(r"product/[a-z0-9-]+\.jpg", p): sys.exit(f"bad image path: {p}")
        subprocess.run(["curl", "-fsSL", "-o", os.path.join(S, f"img{i}.jpg"), f"https://{host}/storage/v1/object/public/images/{p}"], check=True)
    for i, u in enumerate(pr.get("videos", [])):
        if not re.fullmatch(r"https://videos\.pexels\.com/video-files/\d+/[\w-]+\.mp4", u): sys.exit(f"bad video url: {u}")
        subprocess.run(["curl", "-fsSL", "-o", os.path.join(S, f"vid{i}.mp4"), u], check=True)   # Pexels は Python の urllib を 403 で断る（curl は通る・2026-10-05 実測）
    import time
    for i, (say, _) in enumerate(voices(P)):
        for k in range(3):   # edge-tts は相手側の 500 で時々落ちる（2026-10-05 実測）。間を空けて3回まで
            if subprocess.run(["edge-tts", "--voice", pr.get("voice", "ja-JP-NanamiNeural"), f"--rate={pr.get('rate', '+8%')}", "--text", tts_text(say, P), "--write-media", os.path.join(S, f"line{i}.mp3")]).returncode == 0: break
            if k == 2: sys.exit(f"edge-tts が3回とも失敗: line{i}")
            time.sleep(10 * (k + 1))
    print("取得:", len(pr["images"]), "画像", len(pr.get("videos", [])), "動画", len(voices(P)), "声")

def assets(P):
    pr = P["prep"]; D, S = dirs(P)
    from PIL import Image
    os.makedirs(os.path.join(D, "voice"), exist_ok=True)
    for i, (_, f) in enumerate(voices(P)): shutil.copy(os.path.join(S, f"line{i}.mp3"), os.path.join(D, "voice", f))
    cand = {}
    for c in pr.get("cutouts", []):   # 範囲を切る → EDSR で4倍 → BiRefNet（1枚ずつ別の処理＝メモリ不足を避ける）
        crop = os.path.join(S, f"{c['out']}_src.png"); sr = os.path.join(S, f"{c['out']}_sr.png")
        Image.open(os.path.join(S, c["src"] + ".jpg")).convert("RGB").crop(tuple(c["crop"])).save(crop)
        if c.get("remove_red"): subprocess.run([CV, "-c", DERED, crop], check=True)
        subprocess.run([CV, "-c", SR, crop, sr, os.path.join(ROOT, "models/EDSR_x4.pb")], check=True)
        subprocess.run(["python3", "-c", CUT, sr, os.path.join(D, c["out"]), "1" if c.get("keep_all") else "0"], check=True)
        if c.get("fade_bottom"): fade_bottom(os.path.join(D, c["out"]), c["fade_bottom"])
        cand[c["out"]] = focus_candidates(os.path.join(D, c["out"]))
    for sp in pr.get("split", []):
        cut = os.path.join(S, f"{sp['src']}_cut.png")
        subprocess.run(["python3", "-c", SPLIT_CUT, os.path.join(S, sp["src"] + ".jpg"), cut], check=True)
        subprocess.run(["python3", "-c", SPLIT_PARTS, os.path.join(S, sp["src"] + ".jpg"), cut, json.dumps(sp["parts"]), S, json.dumps(sp.get("exclude", []))], check=True)
        for name in sp["parts"]:
            subprocess.run([CV, "-c", SPLIT_SR, os.path.join(S, f"comp_{name}"), os.path.join(D, name), os.path.join(ROOT, "models/EDSR_x4.pb")], check=True)
            cand[name] = focus_candidates(os.path.join(D, name))
    for p in pr.get("plates", []):    # 板（暮らしの写真・ランキング画像など）：範囲を切って幅をそろえる
        im = Image.open(os.path.join(S, p["src"] + ".jpg")).convert("RGB"); src = os.path.join(S, f"{p['out']}_src.png")
        (im.crop(tuple(p["crop"])) if p.get("crop") else im).save(src)
        subprocess.run([CV, "-c", PLATE, src, os.path.join(D, p["out"]), os.path.join(ROOT, "models/EDSR_x4.pb"), "1" if p.get("sr") else "0", json.dumps(p.get("size"))], check=True)
    for r in pr.get("broll", []):     # 実写：区間・速さ・切り抜き・色合わせ → 25fps の駒
        out = os.path.join(D, r["out"]); shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
        vf = ",".join(x for x in [r.get("crop") and f"crop={r['crop']}", f"setpts=PTS/{r.get('speed', 1)}", "fps=25", "scale=720:1280:flags=lanczos", GRADE[r.get("grade", "none")]] if x)
        subprocess.run([FF, "-loglevel", "error", "-ss", str(r.get("ss", 0)), "-t", str(r["t"]), "-i", os.path.join(S, r["src"] + ".mp4"), "-vf", vf, "-q:v", "3", f"{out}/f_%03d.jpg"], check=True)
        n = len(glob.glob(f"{out}/f_*.jpg")); print(r["out"], n, "駒（設計書の frames に書く）"); cand[r["out"]] = {"frames": n}
    sheet(D, pr); json.dump(cand, open(os.path.join(D, "prep.json"), "w"), ensure_ascii=False, indent=1); print(json.dumps(cand, ensure_ascii=False))

def sheet(D, pr):
    """確認用の一覧：切り抜き（寄る点の候補つき）・板・実写の頭/中/尻"""
    from PIL import Image, ImageDraw
    tiles = []
    for name in [c["out"] for c in pr.get("cutouts", [])] + [n for sp in pr.get("split", []) for n in sp["parts"]]:
        im = Image.open(os.path.join(D, name)).convert("RGBA"); bg = Image.new("RGBA", im.size, (235, 228, 218, 255)); bg.alpha_composite(im)
        f = focus_candidates(os.path.join(D, name)); d = ImageDraw.Draw(bg)
        for k, col in (("body", "red"), ("top", "blue"), ("left", "green"), ("right", "orange")):
            x, y = f[k][0] * 4, f[k][1] * 4; d.ellipse((x - 14, y - 14, x + 14, y + 14), outline=col, width=6)
        tiles.append(bg.convert("RGB"))
    for p in pr.get("plates", []): tiles.append(Image.open(os.path.join(D, p["out"])).convert("RGB"))
    for r in pr.get("broll", []):
        fs = sorted(glob.glob(os.path.join(D, r["out"], "f_*.jpg"))); tiles += [Image.open(fs[k]).convert("RGB") for k in (0, len(fs) // 2, -1)]
    H = 400; tiles = [t.resize((max(1, round(t.width * H / t.height)), H)) for t in tiles]
    out = Image.new("RGB", (sum(t.width + 10 for t in tiles), H), "white"); x = 0
    for t in tiles: out.paste(t, (x, 0)); x += t.width + 10
    out.save(os.path.join(D, "prep-sheet.png")); print("一覧:", os.path.join(D, "prep-sheet.png"))

if __name__ == "__main__":
    mode, pj = sys.argv[1], sys.argv[2]; P = json.load(open(pj))
    {"request": request, "unpack": unpack, "fetch": fetch, "assets": assets}[mode](P)
