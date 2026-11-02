// humid.html の CYCLES_JOBS() を取り出して <出力先>/jobs_day.json・jobs_night.json に書く（#337）
//   node factory/cycles_jobs.mjs <stage/humid.html> <timing.json> <product.json> <出力先>
//   カメラの動きは humid.html の CAM 1か所。ここはそれを描く側（video-render-worker の cycles/）へ渡すだけ
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { chromeArgs } from "../chrome.mjs";
import fs from "node:fs"; import path from "node:path";
const [page, tl, pj, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: chromeArgs(["--no-sandbox", "--allow-file-access-from-files"]) });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
p.on("pageerror", (e) => { console.error("ERR", e.message); process.exitCode = 1; });
await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [JSON.parse(fs.readFileSync(tl)), JSON.parse(fs.readFileSync(pj))]);
await p.goto("file://" + path.resolve(page)); await p.waitForFunction(() => window.CYCLES_JOBS || window.DEPTH_JOBS);   // 3D の部屋が無い型（lamp.html）は奥行きの写真だけ
const j = await p.evaluate(() => window.CYCLES_JOBS ? window.CYCLES_JOBS() : {});
fs.mkdirSync(out, { recursive: true });
for (const m of Object.keys(j)) fs.writeFileSync(path.join(out, `jobs_${m}.json`), JSON.stringify(j[m]));
console.log(JSON.stringify(Object.fromEntries(Object.entries(j).map(([m, v]) => [m, v.length]))));
// 実写真を奥行きで動かす連番の一覧（#343・humid.html の DEPTH_JOBS）。あれば depth_jobs.json に書く → factory/depthwarp.py
const dj = await p.evaluate(() => window.DEPTH_JOBS ? window.DEPTH_JOBS() : null);
if (dj) { fs.writeFileSync(path.join(out, "depth_jobs.json"), JSON.stringify(dj)); console.log(JSON.stringify(Object.fromEntries(Object.entries(dj).map(([m, v]) => [m, v.length])))); }
await b.close();
