# 投稿文（TikTok 用・X 用）を設計書から作る。0円（LLM を使わない）。規約：冒頭に #PR・※の条件・価格を書かない・体験談を作らない
#   post.py <product.json> [outdir]  → {"tiktok": "...", "x": "..."}
#   outdir に credits.json（#331・使った素材の所有者名）があれば、帰属表示が必要な物を説明文へ入れる
import json, re, sys, os, unicodedata
P = json.load(open(sys.argv[1])); B = P["beats"]; post = P.get("post", {})
# #331 帰属表示（CC-BY 等）：所有者名を説明文に記載する。cc0/pdm は記載不要
credit_lines = []
if len(sys.argv) > 2:
    cp = os.path.join(sys.argv[2], "credits.json")
    if os.path.exists(cp):
        for c in json.load(open(cp)):
            if c.get("attribution_required"):
                credit_lines.append(f"音源: {(c.get('title') or '').strip()} by {c.get('creator') or '不明'}（{(c.get('license') or '').upper()}） {c.get('source') or ''}".strip())
plain = lambda s: re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", " ", s or "")).strip()
# 語りの無い動画（#333 音楽＋効果音だけ）は画面の文字を代わりに使う
say = lambda b: b.get("say") or plain(" ".join(b[k] for k in ("label", "lead", "head", "sub") if b.get(k)))
hook, close = say(B[0]), say(B[-1])
# 評価・件数には取得日を付ける（決まり）。画面に出している date（例「楽天市場 2026年10月29日時点」）を投稿文にも写す＝簡易トイレの投稿文に日付が無かった
dated = lambda b: (say(b).rstrip("。") + f"（{plain(b['date'])}）。") if b.get("date") and say(b) else say(b)
points = [dated(b) for b in B[1:-1] if say(b)]
notes = []
for b in B:
    for n in plain(b.get("note", "")).split("※")[1:]:
        n = "※" + n.strip()
        if n not in notes and "イメージ映像" not in n: notes.append(n)
tags = post.get("tags", [])
url = post.get("affiliate_url") or P.get("affiliate_url")   # 設計書の上の段に置いた物も読む（UGREEN は rakuten の取り込みで上の段に入っていた）
tiktok = "\n".join(["#PR " + hook, ""] + ["✔ " + p for p in points] + [""] + notes + ["", "商品リンクはプロフィールから", " ".join(["#楽天"] + tags)] + ([""] + credit_lines if credit_lines else []))
def xlen(s):   # X の数え方：URL は 23、全角は 2、半角は 1（上限 280）
    s2 = re.sub(r"https?://\S+", "x" * 23, s); return sum(2 if unicodedata.east_asian_width(c) in "WFA" else 1 for c in s2)
def xtext(k):
    # 3DCG の時は X でも先に言う（#366 の例外の条件）。★注釈は行の最後か別の行に（行の途中の # がリンクの足し算を飲んだ・#367）
    lines = ["#PR " + hook] + ["・" + p for p in points[:k]] + ([("※3DCG・" if any("3DCG" in n for n in notes) else "※") + "条件は動画内に記載"] if notes else []) + credit_lines + [url if url else "リンクはプロフィールから"]
    return "\n".join(lines)
k = len(points)
while k > 0 and xlen(xtext(k)) > 280: k -= 1
x = xtext(k)
out = {"tiktok": tiktok, "x": x}
if not url: out["warn"] = "affiliate_url が未設定（X はプロフィール誘導で出す）"
print(json.dumps(out, ensure_ascii=False, indent=1))
