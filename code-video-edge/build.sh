#!/bin/bash
# 箱・服・商品そのものの 3D のコード動画（jmas-ai-os の engine・build_edge.sh）を Actions で1本描いて点検する（edge-video.yml）
#   bash code-video-edge/build.sh <product_key> <作業場所>
#   engine/ は jmas-ai-os の samples/motion/engine の写し。並べ方は jmas-ai-os の motion-workspace（setup.sh の dest）と同じ
#   products/<key>/ に product.json・facts.json・prep.py（下ごしらえ）・assets.json（素材の取り方）を置く
# ★公開リポジトリ：商品画像・切り抜きはコミットしない（実行時に取り、ジョブと一緒に消える）
set -euo pipefail
KEY=$1; W=$2; HERE=$(cd "$(dirname "$0")" && pwd); PK=$HERE/products/$KEY
[[ "$KEY" =~ ^[a-z0-9][a-z0-9-]{2,60}$ ]] || { echo "::error::product_key の形が違います"; exit 1; }
for f in product.json facts.json prep.py assets.json; do [ -f "$PK/$f" ] || { echo "::error::products/$KEY/$f が無い"; exit 1; }; done
mkdir -p "$W/stage" "$W/factory"
# engine → 作業場所（factory/ はそのまま・.html と .js は stage/・他は上の段）
(cd "$HERE/engine" && find . -type f ! -path '*__pycache__*' | sed 's#^\./##') | while read -r rel; do
  case "$rel" in factory/*) d="$W/$rel";; *.html|*.js) d="$W/stage/$rel";; *) d="$W/$rel";; esac
  mkdir -p "$(dirname "$d")"; cp "$HERE/engine/$rel" "$d"
done
cp "$HERE/package.json" "$HERE/package-lock.json" "$W/"
cd "$W"
npm ci --no-audit --no-fund >/dev/null
mkdir -p stage/vendor && cp node_modules/three/build/three.module.min.js stage/vendor/ && cp -r node_modules/three/examples/jsm stage/vendor/
# 字：fonts（Dela Gothic One・Noto Sans JP 500/700/900）と fonts2（型が読む残り）。fonts2 は fetch-fonts.sh と同じ取り方で family だけ変える
bash fetch-fonts.sh >/dev/null
mkdir -p stage/fonts2 && (cd stage/fonts2 && UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" &&
  curl -fsS -A "$UA" "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;500&family=Noto+Sans+JP:wght@300;400&family=Shippori+Mincho:wght@500;700&display=block" -o fonts.css &&
  for u in $(grep -oE 'https://fonts.gstatic.com[^)]+' fonts.css | sort -u); do f=$(echo "$u" | md5sum | cut -c1-12).woff2; curl -fsS -o "$f" "$u"; sed -i "s#$u#$f#g" fonts.css; done)
P=stage/p/$KEY; mkdir -p "$P/v" "$P/voice" "$P/out" "$P/b3d" "dl-$KEY"
cp "$PK/product.json" "$P/v/product.json"
# 素材：楽天の商品画像（各店の cabinet だけ）と VOICEVOX の声（engine の prep.vv_synth＝jmas-ai-os の取り寄せと同じ処理）
python3 - "$PK/assets.json" "dl-$KEY" "$P/voice" <<'PY'
import json, os, re, subprocess, sys
a, dl, vdir = sys.argv[1:4]; A = json.load(open(a))
for i, u in enumerate(A["asp_images"]):
    if not re.fullmatch(r"https://(image\.rakuten\.co\.jp|shop\.r10s\.jp)/[\w-]+/cabinet/[\w./-]+\.jpe?g", u): sys.exit(f"楽天の画像の住所ではない: {i}")
    subprocess.run(["curl", "-fsSL", "-A", "Mozilla/5.0", "-o", f"{dl}/asp{i}.jpg", u], check=True)
sys.path.insert(0, "factory"); import prep
for i, line in enumerate(A["lines"]):
    prep.vv_synth(line, f"{vdir}/line{i}.mp3")
print("画像", len(A["asp_images"]), "枚・声", len(A["lines"]), "行")
PY
# 下ごしらえ：組ごとに別の処理で（BiRefNet は1つの処理で2回呼ぶとメモリが 14GB まで膨らんで落ちた）
python3 -c "import json,sys;[print(' '.join(g)) for g in json.load(open(sys.argv[1]))['prep']]" "$PK/assets.json" | while read -r g; do
  # shellcheck disable=SC2086
  python3 "$PK/prep.py" "dl-$KEY" "$P/b3d" $g
done
SUB=4 bash factory/build_edge.sh "$P/v/product.json" "$P/out" "$PK/facts.json" "$P/voice"
python3 -c "import json,sys;q=json.load(open(sys.argv[1]));bad=[k for k,v in q.items() if isinstance(v,dict) and not v['ok']];print('点検', 'ok' if q['ok'] else 'NG', bad);sys.exit(0 if q['ok'] else 2)" "$P/out/qc.json"
