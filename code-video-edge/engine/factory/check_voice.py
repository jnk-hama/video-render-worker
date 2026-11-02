#!/usr/bin/env python3
# ============================================================
# 声の流用検査（E-050 の再発防止）
#   この商品が使う voice/*.mp3 が、別商品の声とバイト単位で同一なら落とす。
#   新商品を別商品の構成からコピーした時、声まで残って「アパレルで布団の
#   ナレーション」になった事故（E-050）を、描画の前に機械で止める。
#
# 使い方： python3 factory/check_voice.py <product.json> <D(=stage/p/<key>)>
#   一致あり → 違反を出して exit 1（build.sh がここで止まる）
#   一致なし → exit 0
#
# 意図的に声を共有する組み合わせは ALLOW に (商品key, 相手key) を理由付きで足す。
# ============================================================
import sys, os, json, hashlib, glob

ALLOW = set()   # 例： ("foo-cm","bar-cm") … 意図的に同じ声を使うと人が確認した対のみ

def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()

def main():
    pj, D = sys.argv[1], sys.argv[2]
    P = json.load(open(pj, encoding="utf-8"))
    key = P["product_key"]
    stage_p = os.path.dirname(os.path.abspath(D))   # stage/p（D=stage/p/<key> の親）

    # この商品が実際に使う声（beats の voice 名）
    used = sorted({b["voice"] for b in P["beats"] if b.get("voice")})
    mine = {}
    for name in used:
        f = os.path.join(D, "voice", name)
        if not os.path.exists(f):
            sys.exit(f"声のファイルが無い: {f}（先に声を生成する）")
        mine[name] = md5(f)

    # 他商品の声の md5 → [(key, ファイル)]
    others = {}
    for vf in glob.glob(os.path.join(stage_p, "*", "voice", "*.mp3")):
        okey = os.path.basename(os.path.dirname(os.path.dirname(vf)))
        if okey == key:
            continue
        others.setdefault(md5(vf), []).append((okey, os.path.basename(vf)))

    viol = []
    for name, h in mine.items():
        for okey, ofile in others.get(h, []):
            if (key, okey) in ALLOW or (okey, key) in ALLOW:
                continue
            viol.append(f"{name} が別商品 {okey}/{ofile} と同一（声の流用の疑い・E-050）")

    if viol:
        print(f"声の流用検査: 違反 {len(viol)}件", file=sys.stderr)
        for v in viol:
            print("  " + v, file=sys.stderr)
        print("  → この商品の say から声を作り直す。意図的な共有なら check_voice.py の ALLOW に対を足す。", file=sys.stderr)
        sys.exit(1)
    print(f"声の流用検査: OK（{len(mine)}本・別商品と重複なし）")

main()
