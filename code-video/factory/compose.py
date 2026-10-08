# 組み合わせ生成（#301・#302）：理解したモーショングラフィックの部品を、商品ごとに組み合わせて1本の設計にする
#   compose.py <product.json> [seed]  → 各カットの kind（場面の種類）と style（見せ方）を設計書に書き込む
# オーナー「組み合わせると何万通りにもなる。その商品の最適解をランダムに生成。高級なモーショングラフィックで差別化」
# ★#302：「モーショングラフィック全く同じです。それをするなと言いました」
#   #301 は同じ骨組みの色や向きだけを変えていた＝見る人には同じ動画。**場面の種類（kind）そのものを選ぶ**。
#   決まり：①前の動画で使った場面の種類は、別の候補がある限り使わない ②地（暗いスタジオ／白いスタジオ）は前の動画と変える
#          ③暗いスタジオの時だけ、色・カードの並べ方などの細かい見せ方も最近と違う物を選ぶ ④種を残す（同じ種で作り直せる）
#   設計書の各カットに "kinds"（その中身で作れる場面の候補）を書いておく。候補が1つしか無いカットはそれを使う
import json, os, random, sys, itertools
HERE = os.path.dirname(os.path.abspath(__file__)); HIST = os.path.join(HERE, "history.json")

THEMES = ["dark", "white"]   # 暗いスタジオ（光が弾ける・金）／白いスタジオ（家電の CM の白・線の図）
OPTIONS = {   # 暗いスタジオの細かい見せ方（cm.html の style が読む）
    "palette": ["amber", "sapphire", "champagne", "graphite"],   # 光の色の組
    "deck": ["ring", "stack", "arc"],                             # 利点のカードの並べ方：3Dの輪／積み重ね／弧
    "head": ["mask", "blur"],                                      # 見出しの出方：線から立ち上がる／ぼけから寄って止まる
    "rapid": ["wall", "punch"],                                    # 連打の背景：斜めに流れるカードの壁／回る光の筋と速さの線
    "burst": ["full", "flare"],                                    # 光の弾け方：火花／横に伸びる光芒（どちらもド派手）
    "bokeh": [16, 30],                                             # 漂う玉ぼけの数
}
PALETTE_BY_GENRE = {"heating": ["amber"], "appliance": ["amber", "champagne", "graphite"], "gadget": ["sapphire", "graphite", "champagne"],
    "beauty": ["champagne", "sapphire"], "apparel": ["champagne", "amber", "graphite"], "food": ["amber", "champagne"]}
DARK_ONLY = {"hook", "unveil", "orbit", "orbitrap", "cascade", "finale3d", "pain", "flip"}   # 光・金・輪の場面（白い地では使わない）
WHITE_ONLY = {"pocket", "flapin", "callout", "snap", "fill", "checklist", "turntable"}       # 線の図・白い台の場面

def compose(P, seed):
    R = random.Random(seed); hist = json.load(open(HIST)) if os.path.exists(HIST) else []
    last = hist[-1] if hist else {}; used = set(last.get("kinds", []))
    themes = [t for t in THEMES if t != last.get("theme")] or THEMES
    # 候補の場面で作れる地だけを残す（全カットに、その地で使える候補がある事）
    ok = [t for t in themes if all([k for k in b.get("kinds", [b["kind"]]) if (k not in WHITE_ONLY if t == "dark" else k not in DARK_ONLY)] for b in P["beats"])]
    theme = R.choice(ok or THEMES)
    kinds = []
    for b in P["beats"]:
        cand = [k for k in b.get("kinds", [b["kind"]]) if (k not in WHITE_ONLY if theme == "dark" else k not in DARK_ONLY)] or b.get("kinds", [b["kind"]])
        fresh = [k for k in cand if k not in used] or cand   # 前の動画に無い場面を優先
        kinds.append(R.choice(fresh))
    style = {"theme": theme}
    if theme == "dark":
        o = dict(OPTIONS); o["palette"] = PALETTE_BY_GENRE.get(P.get("genre"), OPTIONS["palette"])
        if sum(k == "orbit" for k in kinds) < 3: o["deck"] = [d for d in o["deck"] if d != "ring"]
        combos = [dict(zip(o, v)) for v in itertools.product(*o.values())]
        recent = [h["style"] for h in hist[-5:] if h.get("style", {}).get("theme", "dark") == "dark"]
        dist = lambda c: min([sum(c.get(k) != r.get(k) for k in OPTIONS) for r in recent] or [len(OPTIONS)])
        best = max(dist(c) for c in combos); style.update(R.choice([c for c in combos if dist(c) == best]), lux=True)
    else: style["accent"] = P.get("accent", "#5B4FA6")
    same = sorted(set(kinds) & used)
    return kinds, style, {"seed": seed, "theme": theme, "kinds": kinds, "same_as_last": same}

if __name__ == "__main__":
    path = sys.argv[1]; P = json.load(open(path)); seed = int(sys.argv[2]) if len(sys.argv) > 2 else random.SystemRandom().randrange(10 ** 6)
    kinds, style, rec = compose(P, seed)
    for b, k in zip(P["beats"], kinds): b["kind"] = k
    P["style"] = style; P["recipe"] = rec
    json.dump(P, open(path, "w"), ensure_ascii=False, indent=1)
    hist = json.load(open(HIST)) if os.path.exists(HIST) else []
    hist.append({"product_key": P["product_key"], "theme": style["theme"], "kinds": kinds, "style": style, "seed": seed}); json.dump(hist, open(HIST, "w"), ensure_ascii=False, indent=1)
    print(json.dumps(rec, ensure_ascii=False))
    if rec["same_as_last"]: print("★注意：前の動画と同じ場面の種類:", rec["same_as_last"], file=sys.stderr)
