// node ovl.mjs <t0> <t1> <step> <outdir>  商品レイヤーと文字レイヤーを別撮りして重なり画素を数える
import { chromium } from "./node_modules/playwright-core/index.mjs";
import fs from "node:fs"; import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname);
const TL = JSON.parse(fs.readFileSync(path.resolve(dir, process.env.TL || "timeline.json"), "utf8"));
const [t0, t1, st, out] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, process.env.PRODUCT ? JSON.parse(fs.readFileSync(process.env.PRODUCT, "utf8")) : null]);
await p.goto("file://" + path.join(dir, process.env.PAGE || "stage/index.html")); await p.evaluate(() => window.READY); await p.waitForTimeout(250);
await p.addStyleTag({ content: "html,body{background:transparent!important} #bg,#grain,#vig,#halo,#table,#ring,#life,#rank,#broll,#brollShade,#wipe,#redbg,#altbg,.blob,#air,#silk,#under,#over,.scrim{display:none!important}" });
for (let t = t0; t <= t1 + 1e-6; t += st) {
  await p.evaluate((t) => { window.seek(t); (document.getElementById("stage")||{style:{}}).style.transform = "none"; document.getElementById("ui").style.display = ""; (document.getElementById("behind")||{style:{}}).style.display = ""; }, t);
  const tag = t.toFixed(2);
  await p.evaluate(() => { window.__wd = document.getElementById("world").style.display; document.getElementById("world").style.display = "none";
    document.querySelectorAll(".prod").forEach((e) => { e.dataset.d = e.style.display; e.style.display = "none"; }); });   // 分解の部品画像は商品の側（#272）
  await p.screenshot({ path: path.join(out, `txt_${tag}.png`), omitBackground: true });
  await p.evaluate(() => { document.getElementById("world").style.display = window.__wd || ""; document.getElementById("ui").style.display = "none"; (document.getElementById("behind")||{style:{}}).style.display = "none";
    document.querySelectorAll(".prod").forEach((e) => { e.style.display = e.dataset.d || ""; });
    // ピントを外した奥の商品（画面で3px以上ぼかした物）は背景として扱う（分解で寄った時の本体など）
    const m = new DOMMatrix(getComputedStyle(document.getElementById("world")).transform), sc = Math.hypot(m.a, m.b);
    document.querySelectorAll("#world > .m").forEach((e) => { const f = /blur\(([0-9.]+)px\)/.exec(e.style.filter || ""); e.dataset.v = e.style.visibility; if ((f && +f[1] * sc >= 3) || e.dataset.backdrop === "1") e.style.visibility = "hidden"; }); });   // ぼかした奥の物・画面いっぱいの質感は背景
  await p.screenshot({ path: path.join(out, `prd_${tag}.png`), omitBackground: true });
  await p.evaluate(() => { document.getElementById("ui").style.display = ""; (document.getElementById("behind")||{style:{}}).style.display = ""; document.querySelectorAll("#world > .m").forEach((e) => { e.style.visibility = e.dataset.v || ""; }); });
}
await b.close();
