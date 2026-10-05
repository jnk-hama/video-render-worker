# 見出しの A/B（#267-4）：設計書の hooks を1本目のカットに重ねた設計書を、見出しごとに書き出す
#   variants.py <product.json> <出力の親フォルダ>  → <親>/<id>/product.json を書き、id を1行ずつ出す
import json, os, sys, copy
P = json.load(open(sys.argv[1])); root = sys.argv[2]
hooks = P.get("hooks") or [{"id": "A"}]
for h in hooks:
    Q = copy.deepcopy(P); Q["variant"] = h["id"]; Q["beats"][0].update({k: v for k, v in h.items() if k != "id"}); Q.pop("hooks", None)
    d = os.path.join(root, h["id"]); os.makedirs(d, exist_ok=True); json.dump(Q, open(os.path.join(d, "product.json"), "w"), ensure_ascii=False, indent=1)
    print(h["id"])
