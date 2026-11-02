# 商品選びの点数（#284 オーナー「この時期にこたつは少しナンセンス」「他のアフィリエイターも出してるから購買意欲が高まらない。
#   ランキングトップ5〜30 か ギリギリ入らないくらいの商品が良さそう」）
#   pick.py season [日付 MM-DD]      … 今が窓の中にあるジャンル（ワンシーズン先取り）を出す
#   pick.py score <ranking.json>...  … rakuten_probe {"ranking":true} の返事を並べて点数順の表にする
# 点数は「選ぶ材料」。選ぶのはオーナー（商材選定は事業判断）。動画で見せられるか・誰に刺さるかは説明文と画像を読んで別に決める
import json, math, os, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
TOP_EXCLUDE = 4          # 1〜4位は外す（みんなが紹介している）
BAND = (5, 30)           # 本命の順位帯
NEAR = (31, 45)          # ギリギリ入らないくらい（2ページ目の頭）
MIN_REVIEWS = 30         # 売れている根拠（締めの★とレビュー件数に使う）。少ない物は新製品で根拠が弱い
MIN_REWARD = 150         # 1件の報酬（円）。小さいと再生が伸びても稼げない（#103）


def in_window(mmdd, w):
    f, t = w["from"], w["to"]
    return f <= mmdd <= t if f <= t else (mmdd >= f or mmdd <= t)   # 年をまたぐ窓


def season(mmdd=None):
    mmdd = mmdd or datetime.date.today().strftime("%m-%d")
    W = json.load(open(os.path.join(HERE, "season.json")))["windows"]
    return [w for w in W if in_window(mmdd, w)]


def score(it):
    """点数と、外した理由（外さない時は None）"""
    r, rv, rw = it["rank"], it.get("reviews") or 0, it.get("expected_reward_yen")
    if r <= TOP_EXCLUDE: return 0, "1〜4位（みんなが紹介している）"
    if rv < MIN_REVIEWS: return 0, f"レビュー{rv}件（売れている根拠が弱い）"
    if rw is None: return 0, "料率が分からない"
    if rw < MIN_REWARD: return 0, f"1件の報酬{rw}円"
    if (it.get("images") or 0) < 2: return 0, "画像が少ない"
    band = 1.0 if BAND[0] <= r <= BAND[1] else 0.9 if NEAR[0] <= r <= NEAR[1] else 0.6
    proof = min(1.0, math.log10(rv) / 3)            # 1000件で満点
    reward = min(1.0, math.log10(rw) / math.log10(2000))
    avg = it.get("review_avg") or 0
    return round(100 * band * (0.45 * reward + 0.35 * proof + 0.20 * min(1, max(0, avg - 3.5) / 1.3)), 1), None


def table(files):
    rows, cut = [], []
    for f in files:
        d = json.load(open(f))
        for it in d.get("items", []):
            s, why = score(it)
            (cut if why else rows).append({**it, "genre_id": d.get("genre_id"), "score": s, "why": why})
    rows.sort(key=lambda x: -x["score"])
    return rows, cut


if __name__ == "__main__":
    if sys.argv[1] == "season":
        for w in season(sys.argv[2] if len(sys.argv) > 2 else None): print(f'{w["name"]}\t{w["keyword"]}\t{w["from"]}〜{w["to"]}\t{w["why"]}')
    else:
        rows, cut = table(sys.argv[2:])
        print("| 点 | 順位 | レビュー | ★ | 1件の報酬 | 商品 | item_code |\n|---|---|---|---|---|---|---|")
        for x in rows[:20]: print(f'| {x["score"]} | {x["rank"]} | {x["reviews"]} | {x["review_avg"]} | {x["expected_reward_yen"]}円 | {x["name"][:30]} | {x["item_code"]} |')
        import collections, re
        why = collections.Counter(re.sub(r"\d+", "N", c["why"]) for c in cut)
        print(f"\n外した {len(cut)} 件：" + "／".join(f"{k} {v}件" for k, v in why.most_common()))
