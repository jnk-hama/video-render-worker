#!/usr/bin/env python3
# Cycles で描いた 3D の部屋の絵（video-render-worker の Release「cycles-room」）を取り込む（#337）
#   python3 factory/cycles_frames.py <cycles-frames.tar> <出力先 cy/> <いまの jobs_day.json と jobs_night.json がある所>
#   ★取り込む前に照合する：描いた本体（cycles_room.py）の sha256 と、カメラの一覧（jobs）が今の物と同じか。
#     違えば止まる（古い絵・別のカメラの絵を黙って使わない＝一度決めたら全部で強制）
import hashlib, json, os, sys, tarfile

tar, dest, jobs_dir = sys.argv[1:4]
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = hashlib.sha256(open(os.path.join(here, "cycles_room.py"), "rb").read()).hexdigest()
with tarfile.open(tar) as tf:
    got = tf.extractfile("./SOURCE.sha256").read().decode().strip()
    if got != src: sys.exit(f"描いた本体が今の cycles_room.py と違う（描いた {got[:12]} ／ 今 {src[:12]}）。描き直す")
    for m in ("day", "night"):
        a = json.load(tf.extractfile(f"./jobs_{m}.json")); b = json.load(open(os.path.join(jobs_dir, f"jobs_{m}.json")))
        if a != b: sys.exit(f"カメラの一覧（{m}）が今の humid.html の物と違う。描き直す")
    names = [n for n in tf.getnames() if n.endswith(".png")]
    want = sum(len(json.load(open(os.path.join(jobs_dir, f"jobs_{m}.json")))) for m in ("day", "night"))
    if len(names) != want: sys.exit(f"コマが足りない {len(names)} / {want}")
    os.makedirs(dest, exist_ok=True)
    for n in names:
        with open(os.path.join(dest, os.path.basename(n)), "wb") as f: f.write(tf.extractfile(n).read())
print(json.dumps({"ok": True, "frames": len(names), "source": src[:12]}))
