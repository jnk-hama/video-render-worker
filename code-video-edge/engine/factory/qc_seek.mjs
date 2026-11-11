// 途中の時刻から描いても同じ絵になるか（#370）：node factory/qc_seek.mjs
//   本描画は動画を4つに分けて並行で描く＝各区間は途中の時刻から始まる。型が「前のコマの状態」に頼っていると、区間の頭で絵が変わる
//   （real.html：S1 用の実物の写真が、12秒から描き始めた区間で初期状態のまま残った。頭から順にめくる点検 23項目は通った）。
//   見方：新しいページでいきなり t へ飛んだ絵 と、0 から順にめくって t に着いた絵 を比べる。区間の頭（4等分）と各場面の真ん中で見る
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { chromeArgs } from "../chrome.mjs";
import fs from "node:fs"; import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), TL = JSON.parse(fs.readFileSync(path.resolve(root, process.env.TL))), PR = JSON.parse(fs.readFileSync(process.env.PRODUCT));
const b = await chromium.launch({ executablePath: process.env.CHROME, args: chromeArgs(["--no-sandbox", "--allow-file-access-from-files"]) });
const open = async () => { const p = await b.newPage({ viewport: { width: 1080, height: 1920 } }); await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, PR]);
  await p.goto("file://" + path.join(root, process.env.PAGE)); await p.evaluate(() => window.READY); return p; };
const shot = async (p, t) => { await p.evaluate((t) => window.seek(t), t); await p.waitForTimeout(80); return (await p.screenshot({ type: "png" })).toString("base64"); };
const times = [...new Set([1, 2, 3].map((k) => +(TL.end * k / 4).toFixed(3)).concat(TL.scenes.map((s) => +((s.t0 + s.t1) / 2).toFixed(3))))].sort((a, c) => a - c);
const seq = await open(), bad = []; let n = 0;
for (const t of times) {
  for (let u = Math.max(0, t - 1.5); u < t; u += 0.25) await seq.evaluate((u) => window.seek(u), u);   // 順にめくる側：手前の 1.5秒を 0.25秒ずつ通る（0 から始めた状態を引き継ぐ）
  const A = await shot(seq, t), fresh = await open(), B = await shot(fresh, t); await fresh.close();
  const d = await seq.evaluate(async ([a, c]) => { const L = async (s) => { const im = new Image(); im.src = "data:image/png;base64," + s; await im.decode(); const cv = document.createElement("canvas"); cv.width = 270; cv.height = 480; const g = cv.getContext("2d"); g.drawImage(im, 0, 0, 270, 480); return g.getImageData(0, 0, 270, 480).data; };
    const x = await L(a), y = await L(c); let k = 0; for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 60) k++; return k / (270 * 480); }, [A, B]);
  n++; if (d > 0.002) bad.push(`${t}秒（画面の ${(d * 100).toFixed(1)}% が違う）`);
}
await b.close();
if (!n) { console.error("1つも比べられなかった"); process.exit(1); }
console.log(`途中から描いても同じ絵か：${n} か所` + (bad.length ? `・違う ${bad.join("、")}` : "・同じ"));
process.exit(bad.length ? 1 : 0);
