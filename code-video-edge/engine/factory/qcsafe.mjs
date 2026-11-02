// 文字のセーフ領域（#333）：見えている文字の字面の箱が、右の操作列・下の説明文・左上の LIVE 印を避けた枠に入っているか
//   0.25秒ごとに #ui の文字（テキストノード）の箱を測る。枠は EDGE.SAFE（edge_tokens.js）＝一度決めた値を読む
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { chromeArgs } from "../chrome.mjs";
import fs from "node:fs"; import path from "node:path";
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const TL = JSON.parse(fs.readFileSync(path.resolve(root, process.env.TL), "utf8"));
const PR = JSON.parse(fs.readFileSync(process.env.PRODUCT, "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: chromeArgs(["--no-sandbox", "--allow-file-access-from-files"]) });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, PR]);
await p.goto("file://" + path.join(root, process.env.PAGE)); await p.evaluate(() => window.READY);
const out = [];
for (let t = 0.05; t < TL.end; t += 0.25) {
  await p.evaluate((t) => window.seek(t), t);
  const bad = await p.evaluate(() => {
    const S = window.EDGE.SAFE, res = [];
    const vis = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.05) return false; } return true; };
    const w = document.createTreeWalker(document.getElementById("ui"), NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim() || !vis(n.parentElement)) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {
        if (r.width < 1) continue;
        // .ln は overflow:hidden のマスク。出入りの途中は .ln の内側だけが見えるので、その重なりを測る
        //   （字の箱全体で測ると、上へ抜ける途中の字が画面の上にはみ出したことになった・R3）
        const v = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        const ln = n.parentElement.closest(".ln"); if (ln) { const q = ln.getBoundingClientRect();
          v.left = Math.max(v.left, q.left); v.top = Math.max(v.top, q.top); v.right = Math.min(v.right, q.right); v.bottom = Math.min(v.bottom, q.bottom);
          if (v.right - v.left < 1 || v.bottom - v.top < 1) continue; }
        if (v.left < S.x0 - 4 || v.right > S.x1 + 4 || v.top < S.y0 - 4 || v.bottom > S.y1 + 4)
          res.push(`${n.textContent.trim().slice(0, 12)}（${Math.round(v.left)},${Math.round(v.top)}–${Math.round(v.right)},${Math.round(v.bottom)}）`);
      }
    }
    return res;
  });
  bad.forEach((x) => { if (!out.some((y) => y.startsWith(x.split("（")[0]))) out.push(`${x} ${t.toFixed(2)}秒`); });
}
console.log(JSON.stringify({ outside: out })); await b.close();
