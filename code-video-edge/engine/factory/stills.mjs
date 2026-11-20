// 試し描きの静止画：node factory/stills.mjs <出力フォルダ> <秒> <秒> …（PAGE・TL・PRODUCT・CHROME は build_edge.sh と同じ環境変数）
//   全部を描く前に、決めた時刻の絵だけを見る（10人会議の「試し描きを見て直す」用・#377）。ページのエラーは止める
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { chromeArgs } from "../chrome.mjs";
import fs from "node:fs"; import path from "node:path";
const [out, ...ts] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TL = JSON.parse(fs.readFileSync(path.resolve(root, process.env.TL))), PR = JSON.parse(fs.readFileSync(path.resolve(root, process.env.PRODUCT)));
const b = await chromium.launch({ executablePath: process.env.CHROME, args: chromeArgs(["--no-sandbox", "--allow-file-access-from-files"]) });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } }); let err = 0;
p.on("pageerror", (e) => { console.error("ERR", e.message); err = 1; });
await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, PR]);
await p.goto("file://" + path.join(root, process.env.PAGE)); await p.evaluate(() => window.READY);
for (const t of ts) { await p.evaluate((t) => window.seek(t), +t); await p.waitForTimeout(60); await p.screenshot({ path: path.join(out, `t_${(+t).toFixed(2).padStart(5, "0")}.jpg`), type: "jpeg", quality: 88 }); }
await b.close(); process.exit(err);
