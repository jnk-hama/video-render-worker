// ページを開いて「1コマ目に商品と見出しが見えるか」「見えている文字の最小サイズ」を測る
import { chromium } from "../node_modules/playwright-core/index.mjs";
import fs from "node:fs"; import path from "node:path";
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const TL = JSON.parse(fs.readFileSync(path.resolve(root, process.env.TL), "utf8"));
const PR = JSON.parse(fs.readFileSync(process.env.PRODUCT, "utf8"));
const b = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, PR]);
await p.goto("file://" + path.join(root, process.env.PAGE)); await p.evaluate(() => window.READY);
const probe = () => {
  const vis = (e) => { let x = e; while (x && x !== document.body) { const cs = getComputedStyle(x); if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.5) return false; x = x.parentElement; } return true; };
  const inView = (r) => r.width > 4 && r.height > 4 && r.right > 0 && r.left < 1080 && r.bottom > 0 && r.top < 1920;
  const texts = [...document.querySelectorAll("#ui *, #behind *")].filter((e) => e.id !== "pr" && !e.closest("#pr") && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(e) && inView(e.getBoundingClientRect()));
  const minFont = texts.length ? Math.min(...texts.map((e) => parseFloat(getComputedStyle(e).fontSize))) : null;
  const w = document.getElementById("world"); const wr = w && w.getBoundingClientRect();
  const productWorld = !!(w && getComputedStyle(w).display !== "none" && [...w.querySelectorAll("img")].some((im) => vis(im) && inView(im.getBoundingClientRect())));
  const productCard = [...document.querySelectorAll(".card img")].some((im) => vis(im) && inView(im.getBoundingClientRect()));
  return { texts: texts.length, minFont, product: productWorld || productCard };
};
const out = { frame0: null, minFont: 999 };
await p.evaluate(() => window.seek(0.04)); out.frame0 = await p.evaluate(probe);
for (let t = 0.3; t < TL.end; t += 0.5) { await p.evaluate((t) => window.seek(t), t); const r = await p.evaluate(probe); if (r.minFont !== null) out.minFont = Math.min(out.minFont, r.minFont); }
console.log(JSON.stringify(out)); await b.close();
