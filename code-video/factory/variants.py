# 見出しの A/B（#267-4）：設計書の hooks を1本目のカットに重ねた設計書を、見出しごとに書き出す
#   variants.py <product.json> <出力の親フォルダ>  → <親>/<id>/product.json を書き、id を1行ずつ出す
import json, os, sys, copy
P = json.load(open(sys.argv[1])); root = sys.argv[2]
hooks = P.get("variants") or P.get("hooks") or [{"id": "A"}]   # hooks＝見出し違い・variants は中身のカットを差し替えた版も書ける（replace）
for h in hooks:
    Q = copy.deepcopy(P); Q["variant"] = h["id"]; Q["beats"][0].update({k: v for k, v in h.items() if k not in ("id", "replace")}); Q.pop("hooks", None); Q.pop("variants", None)
    for k, beat in (h.get("replace") or {}).items(): Q["beats"][int(k)] = beat
    d = os.path.join(root, h["id"]); os.makedirs(d, exist_ok=True); json.dump(Q, open(os.path.join(d, "product.json"), "w"), ensure_ascii=False, indent=1)
    print(h["id"])
