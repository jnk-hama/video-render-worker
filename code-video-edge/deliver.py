# 届ける（edge-video.yml）：点検 23項目に通った1本を Storage（videos）へ上げ、LINE へ承認依頼＋投稿文を送る（video-scene の notify_review）
#   deliver.py <product.json> <outdir> <job_id>     環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
#   code-video/factory/deliver.py と同じ送り方。違うのは点検の項目名（qc_edge.py の名前）だけ
# ★公開リポジトリの Actions で動く。URL・鍵・返りの本文はログへ出さない（状態と件数だけ）
import json, os, re, sys, urllib.error, urllib.request
pj, outdir, job = sys.argv[1:4]
P = json.load(open(pj)); qc = json.load(open(os.path.join(outdir, "qc.json"))); post = json.load(open(os.path.join(outdir, "post.json")))
if not re.fullmatch(r"marie-code-[a-z0-9-]{3,70}", job): sys.exit("job_id の形が違います")
if not qc.get("ok"):
    print("点検に落ちたので届けません:", ", ".join(k for k, v in qc.items() if isinstance(v, dict) and not v.get("ok"))); sys.exit(2)
if not post.get("x", "").startswith("#PR") or "hb.afl.rakuten.co.jp" not in post.get("x", ""):
    sys.exit("X の投稿文の先頭に #PR が無いか、楽天のリンクが無い（設計書に affiliate_url を入れる）")
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
notes = [f"コード動画（{P['template']}の型）",   # 前は「商品そのものの 3D」と固定で書いていた＝実物の写真の型（real・film）でも 3D と伝えていた
         "点検 %d項目すべて合格（長さ %.1f秒・音量 %.1f LUFS・声と背景の差 %.1f dB）" % (len(q), q["長さ・大きさ・fps"]["秒"], q["ラウドネス"]["LUFS"], q["声と背景の差"]["dB"])]
body = {"action": "notify_review", "clip_ids": [], "notes": notes, "post_texts": {k: post[k] for k in ("tiktok", "x") if post.get(k)},
        "title": P.get("name", P["product_key"])[:60], "job_id": job,
        "video_url": f"https://{host}/storage/v1/object/public/videos/{path}"}
req = urllib.request.Request(f"https://{host}/functions/v1/video-scene", data=json.dumps(body).encode(), headers=dict(H, **{"Content-Type": "application/json"}))
try:
    with urllib.request.urlopen(req, timeout=40) as r: print("LINE へ承認依頼を送りました（HTTP %d・1通の形: %s）" % (r.status, json.loads(r.read() or b"{}").get("single")))
except urllib.error.HTTPError as e: sys.exit("LINE へ送れません（HTTP %d）" % e.code)
