# 数字の見せ方を選ぶ（オーナー「数字の見せ方はランダムに最適解で実装しましょう」）
#   数字の種類に合う見せ方だけを候補にし（最適解）、その中から乱数で1つ選ぶ（ランダム）。
#   乱数の種は「商品・版・カット番号」＝同じ設計書なら何度作っても同じ絵（4並列の描画が食い違わない）。
#   版A と 版B は同じカットで別の見せ方にする（どれが売れるかのデータを取る）。
#   元の型の見せ方（gauge・cells・bars・counter・sizes）も候補に残す。
import random

KEEP = ("voice", "say", "source", "note", "mark", "tail", "label", "sub")


def candidates(b):
    """このカットの数字に合う見せ方 → [(見せ方, 中身)]。元の型の見せ方は (None, b)"""
    k, out = b["kind"], []
    base = {x: b[x] for x in KEEP if x in b}
    if k in ("gauge", "counter", "bars", "cells", "sizes"): out.append((None, b))   # 元の型の見せ方（num には無い）
    v, u = b.get("value"), b.get("unit", "")
    if k == "num":   # 設計書に見せ方を書かず数字だけ書いた時（形は numfx.js の各見せ方の項目）
        if b.get("base"): k = "bars"; b = {**b, "bars": [[b.get("base_label", ""), b["base"]], [b.get("value_label", ""), v]]}
        elif b.get("months"): k = "cells"; b = {**b, "cells": b["months"]}
        elif b.get("sizes"): k = "sizes"
        else: k = "gauge"
    if k in ("gauge", "counter", "bars") and isinstance(v, (int, float)):
        out.append(("flap", {**base, "value": v, "unit": u}))
    if k in ("gauge", "counter") and u.lower() == "ml" and 50 <= v <= 3000:
        mx = -(-v * 1.09 // 100) * 100   # 少し上まで目盛り（550ml → 600）
        out.append(("cup", {**base, "value": v, "unit": u, "max": int(mx)}))
    if k == "bars" and len(b.get("bars", [])) >= 2:
        lo, hi = b["bars"][0], b["bars"][-1]
        if lo[1] > 0 and hi[1] / lo[1] >= 1.3:
            note = (b.get("note", "") + " 倍率は販売ページの数値からの計算です。").strip()
            out.append(("magnify", {**base, "note": note, "base": lo[1], "base_label": lo[0], "value": hi[1], "value_label": hi[0], "unit": u}))
    if k == "cells" and 2 <= b.get("cells", 0) <= 6 and "月" in u:
        out.append(("calendar", {**base, "months": b["cells"], "num": b.get("num", str(b["cells"])), "unit": u, "cell_label": b.get("cell_label", ""), "badge": b.get("badge", "")}))
    if b.get("parts") and abs(sum(p[1] for p in b["parts"]) - 100) < 0.5:
        out.append(("donut", {**base, "parts": b["parts"]}))
    if k == "sizes" and 3 <= len(b.get("sizes", [])) <= 8:
        out.append(("figures", {**base, "sizes": b["sizes"]}))
    return out


def pick(products):
    """版ごとの設計書（同じ商品）を受け取り、数字のカットの見せ方を決めて書き換える。選んだ見せ方を返す"""
    used, log = {}, []
    for Q in products:
        chosen = {}
        for i, b in enumerate(Q["beats"]):
            if b.get("motif") and b["kind"] == "num": chosen[i] = b["motif"]; continue   # 設計書で決めてある
            c = [x for x in candidates(b) if x[0] or b["kind"] != "num"]
            if len(c) < (1 if b["kind"] == "num" else 2): continue
            fresh = [x for x in c if (x[0] or b["kind"]) not in used.get(i, set())] or c
            m, body = random.Random(f'{Q["product_key"]}:{Q.get("variant", "A")}:{i}').choice(fresh)
            name = m or b["kind"]; used.setdefault(i, set()).add(name); chosen[i] = name
            if m: Q["beats"][i] = {"kind": "num", "motif": m, "native": b["kind"], **body}
        Q["motifs"] = chosen; log.append(chosen)
    return log
