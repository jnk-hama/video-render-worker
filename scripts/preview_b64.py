#!/usr/bin/env python3
"""
画像をログへ出して**実装者が目で確かめる**ための道具。

【なぜ要るか】
開発サンドボックスは画像サイトへ出られず（CONNECT 403）、
private リポジトリの Release 資産も認証なしでは取れない。
つまり「取り寄せた素材を、使う前に見る」ができない状態だった。

★★見ていない素材を使って実際に失敗している（assets/NOTES.md の
  b-*.mp4 の件）。見る手段が無いなら、見る手段を作る方が先である。

【なぜこの形か】
・**1行で出す。** 200文字ずつ改行して出したら、受け取り側で継ぎ目が
  ずれて 11,840文字が 11,619文字になった。**壊れても気づけない。**
・**sha256 と文字数を併記する。** 長さだけでは中身のずれを検出できない。
  指紋が一致した時だけ「見た」と言える。
・**小さくする。** ログを流さないため、既定は1枚200px・品質50。

使い方:
    python3 scripts/preview_b64.py a.jpg b.jpg --cols 4 --max 160
"""
import argparse
import base64
import hashlib
import io
import sys

from PIL import Image

# ★既定値はここだけに置く。呼び出し側で同じ数字を書かない
DEFAULT_MAX = 200      # 1枚の長辺（px）
DEFAULT_COLS = 4       # 横に並べる枚数
DEFAULT_QUALITY = 50   # JPEG品質


def build_sheet(paths, cell, cols):
    """複数枚を格子に並べて1枚にする。1枚なら並べずそのまま縮小する。"""
    thumbs = []
    for p in paths:
        im = Image.open(p).convert('RGB')
        im.thumbnail((cell, cell))
        thumbs.append(im)
    if not thumbs:
        raise SystemExit('画像が1枚もありません。プレビューになっていません')
    if len(thumbs) == 1:
        return thumbs[0]

    cols = max(1, min(cols, len(thumbs)))
    rows = (len(thumbs) + cols - 1) // cols
    w = max(t.width for t in thumbs)
    h = max(t.height for t in thumbs)
    # ★背景は中間グレー。白でも黒でも、素材の端がどこまでか分からなくなる
    sheet = Image.new('RGB', (w * cols, h * rows), (96, 96, 96))
    for i, t in enumerate(thumbs):
        x = (i % cols) * w + (w - t.width) // 2
        y = (i // cols) * h + (h - t.height) // 2
        sheet.paste(t, (x, y))
    return sheet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--max', type=int, default=DEFAULT_MAX)
    ap.add_argument('--cols', type=int, default=DEFAULT_COLS)
    ap.add_argument('--quality', type=int, default=DEFAULT_QUALITY)
    a = ap.parse_args()

    sheet = build_sheet(a.paths, a.max, a.cols)
    buf = io.BytesIO()
    sheet.save(buf, format='JPEG', quality=a.quality)
    raw = buf.getvalue()
    b = base64.b64encode(raw).decode()

    print('PREVIEW_B64 %dx%d n=%d chars=%d sha256=%s'
          % (sheet.width, sheet.height, len(a.paths), len(b),
             hashlib.sha256(raw).hexdigest()))
    print(b)
    # ★並び順を明記する。格子だけ見せても、どれがどのファイルか分からない
    print('PREVIEW_ORDER %s' % ' | '.join(a.paths))
    return 0


if __name__ == '__main__':
    sys.exit(main())
