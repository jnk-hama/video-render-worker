#!/usr/bin/env python3
"""
依頼の中の前景画像（商品）を、透過PNGに揃えてから台本へ差し戻す。

    python3 scripts/prepare_foreground_cli.py \
        --payload payload.json --out payload_fg.json --work .fgwork

【なぜ切り出したか】
ffmpeg版は render_video.py の中で透過処理をしている。Remotion版は
Node側で描くので、同じ処理を呼べない。**透過だけを外へ出して、
両方式が同じ結果の画像を使う**ようにする。

これをしないと、Remotion版だけ背景の四角が乗ったまま描かれる
（nova-pulse.png で実際にそうなった）。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import render_video as rv  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", default=".fgwork")
    args = ap.parse_args()

    raw = json.load(open(args.payload, encoding="utf-8"))
    job = raw.get("job") if isinstance(raw.get("job"), dict) else raw

    fg = job.get("foreground") or {}
    url = fg.get("url")
    if not url:
        json.dump(raw, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
        print("前景の指定なし。そのまま通します。")
        return

    os.makedirs(args.work, exist_ok=True)
    src = os.path.join(args.work, "fg_raw")
    dst = os.path.join(args.work, "fg.png")

    """
    ★★2026-09-05、キャッシュ（決定#089）。

    前段（fg_cache.py --check）が既に透過済みPNGを置いていたら、
    **抜き直さない**。透過は2コアで33秒、その前のrembg導入で20秒かかる。
    同じ商品で何本も作るので、ここが一番大きく効く。
    """
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        job["foreground"] = dict(fg, url=dst)
        print("キャッシュの透過画像を使います: %s" % dst)
        json.dump(raw, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)
        return

    if not rv.download(str(url), src, market=job.get("target_market")):
        # ★落とせなくても止めない。前景なしで描く（既存の方針と揃える）
        print("前景の素材を取得できませんでした。前景なしで通します。")
        job.pop("foreground", None)
    elif rv.prepare_foreground(src, dst):
        job["foreground"] = dict(fg, url=dst)
        print("透過済みの前景: %s" % dst)
    else:
        print("透過できませんでした。前景なしで通します。")
        job.pop("foreground", None)

    json.dump(raw, open(args.out, "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    main()
