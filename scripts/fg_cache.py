#!/usr/bin/env python3
"""
透過した商品画像を使い回す（決定#089）。

    # 描画の前：キャッシュにあるか見る。あれば落として使う
    python3 scripts/fg_cache.py --check --payload payload.json --dest .fgwork/fg.png

    # 透過した後：次回のために置いておく
    python3 scripts/fg_cache.py --put --payload payload.json --src .fgwork/fg.png

【なぜ要るか（実測）】
背景の透過（rembg）は 2コアのランナーで **33秒**、その前に rembg /
onnxruntime を入れるのに **20秒**かかる。合わせて53秒で、これは
描画そのもの（13秒の動画で約115秒）に次ぐ重さ。

同じ商品で何本も作るので、**1度抜いたら二度と抜かない**のが効く。
キャッシュに当たれば rembg を入れる必要すら無くなる。

【キーの決め方】
元画像のURLのSHA-256。URLが同じなら中身も同じという前提を置く。
★ASPが同じURLで画像を差し替えた場合は古い抜き画像が出続ける。
  その時はキーが変わらないので気づけない。**商品を差し替える運用が
  始まったら、キーにETagか更新日時を混ぜる必要がある**（現状は未対応）。

【置き場所】
Supabase Storage の videos バケットの cutouts/ 配下。
新しいバケットを作らない（RLSと公開設定を増やさないため）。
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

CACHE_PREFIX = "cutouts"
BUCKET = "videos"


def log(msg):
    print(msg, flush=True)


def clean_base_url(raw):
    """
    Secrets の貼り付けミスを吸収する。render-video.yml の掃除と同じ方針で、
    URLに出てくる文字だけを残す（不可視文字を確実に落とす）。
    """
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:/._-")
    s = "".join(c for c in str(raw or "") if c in allowed)
    for scheme in ("https://", "http://"):
        if s.startswith(scheme):
            s = s[len(scheme):]
            break
    host = s.split("/")[0]
    if host and "." not in host:
        host += ".supabase.co"
    return ("https://" + host) if host else ""


def clean_key(raw):
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    return "".join(c for c in str(raw or "") if c in allowed)


def source_url(payload_path):
    raw = json.load(open(payload_path, encoding="utf-8"))
    job = raw.get("job") if isinstance(raw.get("job"), dict) else raw
    fg = job.get("foreground") or {}
    return str(fg.get("url") or "")


def cache_path(url):
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
    return "%s/%s.png" % (CACHE_PREFIX, digest)


def emit(hit):
    """GitHub Actions へ結果を返す。無い環境でも落とさない"""
    line = "hit=%s" % ("true" if hit else "false")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    log(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", required=True)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--put", action="store_true")
    ap.add_argument("--dest")
    ap.add_argument("--src")
    args = ap.parse_args()

    base = clean_base_url(os.environ.get("SUPABASE_URL"))
    key = clean_key(os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    url = source_url(args.payload)

    # ★鍵が無い・前景が無い回は「キャッシュ無し」として静かに通す。
    #   キャッシュはあくまで速くするための仕組みで、無くても動く。
    if not url:
        log("前景の指定なし。キャッシュは使いません。")
        emit(False)
        return
    if not base or not key:
        log("Supabaseの設定が無いのでキャッシュは使いません。")
        emit(False)
        return

    path = cache_path(url)
    public = "%s/storage/v1/object/public/%s/%s" % (base, BUCKET, path)

    if args.check:
        if not args.dest:
            sys.exit("--check には --dest が必要です")
        try:
            with urllib.request.urlopen(public, timeout=30) as r:
                data = r.read()
            if len(data) < 1024:
                raise ValueError("小さすぎる（%dバイト）" % len(data))
            os.makedirs(os.path.dirname(args.dest) or ".", exist_ok=True)
            with open(args.dest, "wb") as f:
                f.write(data)
            log("透過済みの画像をキャッシュから取りました（%.0fKB）: %s"
                % (len(data) / 1024, path))
            emit(True)
        except Exception as e:
            log("キャッシュにありません（今回抜きます）: %s" % str(e)[:100])
            emit(False)
        return

    if args.put:
        if not args.src or not os.path.exists(args.src):
            log("置くファイルがありません。何もしません。")
            return
        data = open(args.src, "rb").read()
        req = urllib.request.Request(
            "%s/storage/v1/object/%s/%s" % (base, BUCKET, path),
            data=data, method="POST",
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "image/png",
                     "x-upsert": "true"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status != 200:
                    raise ValueError("HTTP %s" % r.status)
            log("次回のために保存しました: %s" % path)
        except Exception as e:
            # ★保存に失敗しても止めない。今回の動画は既に出来ている
            log("キャッシュに保存できませんでした（今回の動画には影響なし）: %s"
                % str(e)[:120])
        return

    sys.exit("--check か --put のどちらかを指定してください")


if __name__ == "__main__":
    main()
