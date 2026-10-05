// node render.mjs frames <t1,t2,...> <outdir>
// node render.mjs segment <fps> <sub> <startFrame> <endFrame> <out.mp4>
import { chromium } from "./node_modules/playwright-core/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname);
const TL = JSON.parse(fs.readFileSync(path.resolve(dir, process.env.TL || "timeline.json"), "utf8"));
const FF = process.env.FFMPEG;
const [mode, ...args] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--font-render-hinting=none", "--disable-lcd-text", "--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE", m.text()); });
await page.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, process.env.PRODUCT ? JSON.parse(fs.readFileSync(process.env.PRODUCT, "utf8")) : null]);
await page.goto("file://" + path.join(dir, process.env.PAGE || "stage/index.html"));
await page.evaluate(() => window.READY);
await page.waitForTimeout(250);
if (mode === "frames") {
  const [list, out] = args; fs.mkdirSync(out, { recursive: true });
  for (const t of list.split(",").map(Number)) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: path.join(out, `f_${t.toFixed(2)}.png`) });
  }
} else {
  const [fps, sub, f0, f1, out] = [Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]), args[4]];
  const vf = `tmix=frames=${sub}:weights='${Array(sub).fill(1).join(" ")}',select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/${fps}/TB`;
  const ff = spawn(FF, ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps * sub), "-i", "-", "-vf", vf, "-r", String(fps), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "15", "-preset", "medium", out], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = f0 * sub - (sub - 1); i < f1 * sub - (sub - 1); i++) {
    await page.evaluate((t) => window.seek(Math.max(0, t)), i / (fps * sub));
    const buf = await page.screenshot({ type: "jpeg", quality: 93 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end(); await new Promise((r) => ff.on("close", r));
}
await browser.close();
