#!/usr/bin/env bash
# 確認用の画像を、**孤児ブランチ `preview` に1枚だけ**置く。
#
# 【なぜ要るか】
# 実装者のサンドボックスは Supabase にも Pexels にも出られず、
# private リポジトリの Release 資産も認証なしでは取れない。
# 唯一通るのが **git** である（push/fetch は実際に通っている）。
#
# base64 をログへ出す手も用意してあるが、**枚数が増えると転記で壊れる**。
# 実測: 1枚4,888文字は写せたが、8枚の一覧14,852文字は写しきれなかった。
# 「壊れたことに気づける（sha256）」だけでは足りず、壊れない経路が要る。
#
# ★★孤児ブランチにして毎回 force push する。履歴に画像を溜めない。
#   main には1バイトも入らない。
#
# ★★**他社の商品写真をここへ置かないこと。** このリポジトリは公開化が
#   決まっており、ブランチも公開される。置いてよいのは
#   ・自社素材（assets/ 以下）
#   ・ライセンスを確認した素材（Pexels 等）
#   ・自分たちが描画した結果
#   の3つだけ。商品写真の切り出し確認はログの base64 で行う。
#
# 受け取り側:
#   git fetch origin preview
#   git show origin/preview:preview.jpg > /tmp/preview.jpg
set -euo pipefail

SRC="${1:-preview.jpg}"
NOTE="${2:-preview}"

if [ ! -s "$SRC" ]; then
  echo "★$SRC がありません。置く物がないので何もしません" >&2
  exit 1
fi

cp "$SRC" /tmp/_preview_upload.jpg

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# 孤児ブランチ。作業ツリーは残るので、追跡対象から全部外してから1枚だけ足す
git checkout -q --orphan preview-tmp
git rm -rq --cached . >/dev/null 2>&1 || true
cp /tmp/_preview_upload.jpg preview.jpg
git add -f preview.jpg
git commit -q -m "chore(preview): ${NOTE}"
git push -q -f origin HEAD:preview

echo "preview ブランチへ置きました: ${NOTE}"
echo "  git fetch origin preview && git show origin/preview:preview.jpg > /tmp/preview.jpg"
