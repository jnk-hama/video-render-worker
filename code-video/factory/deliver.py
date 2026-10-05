# 届ける（M5・M6）：点検に通った1本を Storage（videos）へ上げ、LINE へ承認依頼＋投稿文を送る（video-scene の notify_review）
#   deliver.py <product.json> <outdir> <job_id>     環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
# ★公開リポジトリの Actions で動く。URL・鍵・返りの本文はログへ出さない（状態と件数だけ）
# ★点検（qc.json）が ok でない物は上げない・送らない（#267-7）
import json, os, re, sys, urllib.error, urllib.request
pj, outdir, job = sys.argv[1:4]
P = json.load(open(pj)); qc = json.load(open(os.path.join(outdir, "qc.json"))); post = json.load(open(os.path.join(outdir, "post.json")))
if not re.fullmatch(r"marie-code-[a-z0-9-]{3,70}", job): sys.exit("job_id の形が違います")
if not qc.get("ok"):
    print("点検に落ちたので届けません:", ", ".join(k for k, v in qc.items() if isinstance(v, dict) and not v.get("ok"))); sys.exit(2)
raw = re.sub(r"[^A-Za-z0-9:/._-]", "", os.environ.get("SUPABASE_URL") or ""); host = re.sub(r"^https?://", "", raw).split("/")[0]
host = host if "." in host else host + ".supabase.co"; key = re.sub(r"[^A-Za-z0-9._-]", "", os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "")
if not host or not key: sys.exit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がありません")
H = {"Authorization": "Bearer " + key, "apikey": key}
path = f"code/{job}.mp4"
req = urllib.request.Request(f"https://{host}/storage/v1/object/videos/{path}", data=open(os.path.join(outdir, "final.mp4"), "rb").read(),
                             headers=dict(H, **{"Content-Type": "video/mp4", "x-upsert": "true"}), method="POST")
try:
    with urllib.request.urlopen(req, timeout=120) as r: print("Storage へ上げました（HTTP %d）" % r.status)
except urllib.error.HTTPError as e: sys.exit("Storage へ上げられません（HTTP %d）" % e.code)
q = {k: v for k, v in qc.items() if isinstance(v, dict)}
notes = [f"コード動画・見出し{P.get('variant', 'A')}（{P['template']}の型）",
         "点検 %d項目すべて合格（長さ %.1f秒・音量 %.1f LUFS・声と背景の差 %.1f dB）" % (len(q), q["長さ"]["秒"], q["音量"]["LUFS"], q["声と背景の差"]["dB"]),
         f"X に出す時は LINE に「X投稿 {job}」と送る"]
if post.get("warn"): notes.append(post["warn"])
body = {"action": "notify_review", "clip_ids": [], "notes": notes, "post_texts": {k: post[k] for k in ("tiktok", "x") if post.get(k)},
        "title": f"{P.get('name', P['product_key'])} {P.get('variant', 'A')}"[:60], "job_id": job,
        "video_url": f"https://{host}/storage/v1/object/public/videos/{path}"}
req = urllib.request.Request(f"https://{host}/functions/v1/video-scene", data=json.dumps(body).encode(), headers=dict(H, **{"Content-Type": "application/json"}))
try:
    with urllib.request.urlopen(req, timeout=40) as r: print("LINE へ承認依頼を送りました（HTTP %d）" % r.status)
except urllib.error.HTTPError as e: sys.exit("LINE へ送れません（HTTP %d）" % e.code)
