# 組み合わせ生成（#301）：理解したモーショングラフィックの部品を、商品ごとに組み合わせて1本の設計にする
#   compose.py <product.json> [seed]  → 設計書の style（見せ方）と recipe（何を選んだか・種・総数）を書き込む
# オーナー「組み合わせると何万通りにもなる。その商品の最適解をランダムに生成。高級なモーショングラフィックで差別化」
#   最適解＝商品に合わない組み合わせを決まりで外す（RULES）→ 最近使った組み合わせから遠い物を優先（同じ見た目の動画を続けない）→ 残りから種で選ぶ
#   種（seed）を設計書に残す＝同じ種なら同じ動画が作り直せる（再現性）
import json, os, random, sys, itertools
HERE = os.path.dirname(os.path.abspath(__file__)); HIST = os.path.join(HERE, "history.json")

OPTIONS = {   # 部品の選択肢（cm.html の style が読む）
    "palette": ["amber", "sapphire", "champagne", "graphite"],   # 光の色の組
    "deck": ["ring", "stack", "arc"],                             # 利点のカードの並べ方：3Dの輪／積み重ね／弧
    "head": ["mask", "blur"],                                      # 見出しの出方：線から立ち上がる／ぼけから寄って止まる
    "rapid": ["wall", "punch"],                                    # 連打の背景：斜めに流れるカードの壁／回る光の筋と速さの線
    "burst": ["full", "flare"],                                    # 光の弾け方：閃光＋輪＋光の筋＋火花／閃光＋輪＋光の筋＋横に伸びる光（レンズの光芒）。どちらもド派手（オーナー「ド派手で高級」）
    "bokeh": [16, 30],                                             # 漂う玉ぼけの数（0 は地味になるので選ばない）
}
PALETTE_BY_GENRE = {   # 色の組の決まり：温める物は暖色、ガジェットは青・銀・シャンパン、美容はシャンパン・青
    "heating": ["amber"], "appliance": ["amber", "champagne", "graphite"], "gadget": ["sapphire", "graphite", "champagne"],
    "beauty": ["champagne", "sapphire"], "apparel": ["champagne", "amber", "graphite"], "food": ["amber", "champagne"]}

def allowed(P):
    o = dict(OPTIONS); o["palette"] = PALETTE_BY_GENRE.get(P.get("genre"), OPTIONS["palette"])
    n = sum(1 for b in P["beats"] if b["kind"] == "orbit")
    if n < 3: o["deck"] = [d for d in o["deck"] if d != "ring"]   # 輪は3枚以上ないと輪に見えない
    return o

def distance(a, b): return sum(a.get(k) != b.get(k) for k in OPTIONS)

def compose(P, seed):
    o = allowed(P); combos = [dict(zip(o, v)) for v in itertools.product(*o.values())]
    hist = json.load(open(HIST)) if os.path.exists(HIST) else []
    recent = [h["style"] for h in hist[-5:]]
    # 最近の5本のどれとも、なるべく多くの部品が違う物だけを残す（差別化＝同じ見た目を続けない）
    score = lambda c: min([distance(c, r) for r in recent] or [len(OPTIONS)])
    best = max(score(c) for c in combos); pool = [c for c in combos if score(c) == best]
    pick = random.Random(seed).choice(pool)
    total = len(list(itertools.product(*OPTIONS.values())))
    return pick, {"seed": seed, "pool": len(pool), "allowed": len(combos), "total": total, "recent_distance": best}

if __name__ == "__main__":
    path = sys.argv[1]; P = json.load(open(path)); seed = int(sys.argv[2]) if len(sys.argv) > 2 else random.SystemRandom().randrange(10 ** 6)
    pick, rec = compose(P, seed)
    P["style"] = {"lux": True, **pick}; P["recipe"] = rec
    json.dump(P, open(path, "w"), ensure_ascii=False, indent=1)
    hist = json.load(open(HIST)) if os.path.exists(HIST) else []
    hist.append({"product_key": P["product_key"], "style": pick, "seed": seed}); json.dump(hist, open(HIST, "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"style": pick, **rec}, ensure_ascii=False))
