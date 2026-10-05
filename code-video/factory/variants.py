# 見出しの A/B（#267-4）：設計書の hooks を1本目のカットに重ねた設計書を、見出しごとに書き出す
#   variants.py <product.json> <出力の親フォルダ>  → <親>/<id>/product.json を書き、id を1行ずつ出す
import json, os, sys, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import motif
P = json.load(open(sys.argv[1])); root = sys.argv[2]
hooks = P.get("variants") or P.get("hooks") or [{"id": "A"}]   # hooks＝見出し違い・variants は中身のカットを差し替えた版も書ける（replace）
Qs = []
for h in hooks:
    Q = copy.deepcopy(P); Q["variant"] = h["id"]; Q["beats"][0].update({k: v for k, v in h.items() if k not in ("id", "replace")}); Q.pop("hooks", None); Q.pop("variants", None)
    for k, beat in (h.get("replace") or {}).items(): Q["beats"][int(k)] = beat
    Qs.append(Q)
for Q, m in zip(Qs, motif.pick(Qs)):   # 数字の見せ方（版ごとに別・#279）
    if m: print(Q["variant"], "数字の見せ方", m, file=sys.stderr)
for Q in Qs:
    d = os.path.join(root, Q["variant"]); os.makedirs(d, exist_ok=True); json.dump(Q, open(os.path.join(d, "product.json"), "w"), ensure_ascii=False, indent=1)
    print(Q["variant"])
