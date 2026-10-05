# 投稿文（TikTok 用・X 用）を設計書から作る。0円（LLM を使わない）。規約：冒頭に #PR・※の条件・価格を書かない・体験談を作らない
#   post.py <product.json>  → {"tiktok": "...", "x": "..."}
import json, re, sys, unicodedata
P = json.load(open(sys.argv[1])); B = P["beats"]; post = P.get("post", {})
plain = lambda s: re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", " ", s or "")).strip()
hook, close = B[0]["say"], B[-1]["say"]
points = [b["say"] for b in B[1:-1] if b.get("say")]
notes = []
for b in B:
    for n in plain(b.get("note", "")).split("※")[1:]:
        n = "※" + n.strip()
        if n not in notes and "イメージ映像" not in n: notes.append(n)
tags = post.get("tags", [])
url = post.get("affiliate_url")
tiktok = "\n".join(["#PR " + hook, ""] + ["✔ " + p for p in points] + [""] + notes + ["", "商品リンクはプロフィールから", " ".join(["#楽天"] + tags)])
def xlen(s):   # X の数え方：URL は 23、全角は 2、半角は 1（上限 280）
    s2 = re.sub(r"https?://\S+", "x" * 23, s); return sum(2 if unicodedata.east_asian_width(c) in "WFA" else 1 for c in s2)
def xtext(k):
    lines = ["#PR " + hook] + ["・" + p for p in points[:k]] + (["※条件は動画内に記載"] if notes else []) + [url if url else "リンクはプロフィールから"]
    return "\n".join(lines)
k = len(points)
while k > 0 and xlen(xtext(k)) > 280: k -= 1
x = xtext(k)
out = {"tiktok": tiktok, "x": x}
if not url: out["warn"] = "affiliate_url が未設定（X はプロフィール誘導で出す）"
print(json.dumps(out, ensure_ascii=False, indent=1))
