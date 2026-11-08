#!/usr/bin/env python3
# 行の途中の「//」（Python は「#」）の後ろにコードが残っていないかを見る（#354・#367）：python3 factory/lint_swallow.py <型や部品のファイル…>
#   直しを足す時に、コードの後ろへ「// 理由」を書き、さらにその後ろへ元のコードが続くと、そのコードは注釈に飲まれて動かない。
#   r6（S5 の d(t)）・r9（影の床の sc.add・光の向きの target）で3回起きた。人の注意で防がず、描く前にここで止める。
#   見る形：注釈の中に「; の後ろに名前」「); 」「const/let/return」「名前.名前(…);」が出る行。見つけたら行番号を出して exit 1
import re
import sys

CODE = re.compile(r";\s*[A-Za-z_$][\w$.]*\s*[(=.\[]|\)\s*;|\b(const|let|var|return)\s+[A-Za-z_$]|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([^)]*\)\s*;")
PYCODE = re.compile(r"\s\+\s*[\[A-Za-z_(]|\]\s*\+|\bfor\s+\w+\s+in\b|\)\s*\+|=\s*[A-Za-z_]\w*\(|;\s*[A-Za-z_][\w.]*(\[[^\]]*\])*(\.[A-Za-z_]\w*)*\s*[(=]")   # 注釈の中に足し算・内包・呼び出しの代入が残る形
#   ★「; 名前(…)」「; 名前.名前 = …」も（2026-11-08 cycles_delonghi.py・cycles_kamado.py：注釈の後ろの「; nt.links.new(…)」が飲まれ、熱の色の輪・素焼きの色むらがつながらなかった）
bad, n = [], 0
for path in sys.argv[1:]:
    for i, line in enumerate(open(path, encoding="utf-8"), 1):
        n += 1
        s = line.strip()
        if s.startswith("//") or s.startswith("*") or s.startswith("<!--"):
            continue
        if path.endswith(".py"):   # Python は「#」の後ろ（#367：post.py の行の途中の # が「+ credit_lines + [url…]」を飲み、X の文からリンクが消えた）
            if s.startswith("#"): continue
            q = re.sub(r"\"[^\"]*\"|'[^']*'", '""', line)   # 文字列の中の # は除く
            m = re.search(r"#(.*)$", q)
            if m and PYCODE.search(m.group(1)): bad.append(f"{path}:{i}: {s[:140]}")
            continue
        m = re.search(r"(?<![:\"'\\])//(.*)$", line)   # http:// や文字列の中の // は除く
        if m and CODE.search(m.group(1)):
            bad.append(f"{path}:{i}: {s[:140]}")
if not n:
    sys.exit("1行も読めなかった（ファイルの指定を確かめる）")
print(f"注釈に飲まれたコードの検査：{len(sys.argv) - 1} ファイル {n} 行" + ("・見つかった 0" if not bad else f"・見つかった {len(bad)}"))
for b in bad:
    print("  " + b)
sys.exit(1 if bad else 0)
