// 文字の点検（オーナー「文字化けや文字が出てないとかは絶対に失敗するな」・#270）
//   1) 文字化け：設計書・画面の文字に U+FFFD や典型的な化け字が無い
//   2) 豆腐：画面に出る全ての字が、同梱フォント（@font-face の unicode-range）に入っている＋インクが出る
//      （システムのフォントに頼らない＝手元でも Actions でも同じ字形になる）
//   3) 出るべき文字：設計書に書いた文字が、画面内に欠けずに（はみ出し・切れ・半透明なし）0.5秒以上見える。PR は95%以上の時間見える
import { chromium } from "../node_modules/playwright-core/index.mjs";
import fs from "node:fs"; import path from "node:path";
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const TL = JSON.parse(fs.readFileSync(path.resolve(root, process.env.TL), "utf8"));
const PR = JSON.parse(fs.readFileSync(process.env.PRODUCT, "utf8"));
const MOJI = /�|[ÃÂ][\u0080-¿]|[縺繧繝譁蜿]|ã[\u0080-¿]/;
// 画面に出ない項目（読み上げ・出典・素材の指定など）
const SKIP = new Set(["kind", "voice", "say", "source", "broll", "frames", "alt_bg", "cam", "open", "mv", "why", "image", "icons", "glint", "slide_hero", "leader", "widths", "gold", "accent", "count", "value", "rating", "reviews", "cells", "tail", "step"]);
const expected = [];
const walk = (v, key) => {
  if (SKIP.has(key)) return;
  if (typeof v === "string") v.split(/<br\s*\/?>/i).forEach((s) => { s = s.replace(/<[^>]+>/g, ""); if (s.trim()) expected.push(s); });
  else if (Array.isArray(v)) (key === "bars" ? v.map((x) => x[0]) : v).forEach((x) => walk(x, key));   // 棒は名前だけ（色名は出ない）
  else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
};
PR.beats.forEach((b) => walk(b, ""));
const norm = (s) => s.replace(/[\s,~〜]/g, "");
const out = { mojibake: [], tofu: [], missing: [], prRatio: 0 };
// 1) 設計書の文字化け（読み上げの文も見る）
const allStr = []; const all = (v) => { if (typeof v === "string") allStr.push(v); else if (v && typeof v === "object") Object.values(v).forEach(all); }; all(PR);
allStr.forEach((s) => { if (MOJI.test(s)) out.mojibake.push(s.slice(0, 40)); });

const b = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--allow-file-access-from-files"] });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.addInitScript((a) => { window.TIMELINE = a[0]; window.PRODUCT = a[1]; }, [TL, PR]);
await p.goto("file://" + path.join(root, process.env.PAGE)); await p.evaluate(() => window.READY);

// 画面のその時刻に「欠けずに見えている」字を DOM の順に並べる（1字ずつ動く見出しも1行として読める）
const sample = () => {
  const roots = [...document.querySelectorAll("#ui, #behind")];
  const texts = []; let pr = false;
  const g = (window.__qg ||= document.createElement("canvas").getContext("2d"));
  const effOpacity = (e) => { let o = 1; for (let x = e; x && x !== document.body; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === "none" || cs.visibility === "hidden") return 0; o *= +cs.opacity; } return o; };
  // 字面（インクの箱）：行の箱は字面より上下に広い（Dela Gothic は約3割）ので、canvas で実際の字面を測って画面の大きさに合わせる
  const inkBoxes = (e, n) => { const cs = getComputedStyle(e); g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = g.measureText(n.textContent.trim() || n.textContent), fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
    const rg = document.createRange(); rg.selectNodeContents(n);
    return [...rg.getClientRects()].filter((r) => r.width > 0).map((r) => { const k = r.height / (fa + fd);
      return { left: r.left, right: r.right, top: r.top + (fa - m.actualBoundingBoxAscent) * k, bottom: r.top + (fa + m.actualBoundingBoxDescent) * k }; }); };
  const clipped = (e, r) => { for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) { const cs = getComputedStyle(x);
      if (cs.clipPath !== "none" && cs.clipPath.startsWith("polygon")) continue;   // 斬る演出の上下半分（わざと）
      if (cs.overflow !== "visible" || cs.clipPath !== "none") { const q = x.getBoundingClientRect(); if (r.left < q.left - 1 || r.right > q.right + 1 || r.top < q.top - 1 || r.bottom > q.bottom + 1) return true; } } return false; };
  roots.forEach((rt) => { const w = document.createTreeWalker(rt, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const s = n.textContent; if (!s.trim()) continue; const e = n.parentElement, boxes = inkBoxes(e, n);
      const ok = boxes.length > 0 && effOpacity(e) >= 0.9 && boxes.every((r) => r.left >= 8 && r.right <= 1072 && r.top >= 8 && r.bottom <= 1912 && !clipped(e, r));
      if (e.closest("#pr")) { pr = pr || ok; continue; }
      if (ok) texts.push(s); } });
  return { line: texts.join(""), pr };
};
// 2) 豆腐：画面に出る全ての字（全時刻）× その字のフォント指定で、同梱フォントが受け持つか＋インクが出るか
const glyphs = await p.evaluate(async (end) => {
  const used = new Map();   // "family|weight|style" → 字の集合
  for (let t = 0; t <= end; t += 0.25) { window.seek(t);
    document.querySelectorAll("#ui *, #behind *").forEach((e) => { [...e.childNodes].forEach((n) => { if (n.nodeType !== 3 || !n.textContent.trim()) return;
      const cs = getComputedStyle(e), key = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}`; if (!used.has(key)) used.set(key, new Set()); [...n.textContent].forEach((c) => c.trim() && used.get(key).add(c)); }); }); }
  const faces = [...document.fonts]; const parse = (ur) => ur.split(",").map((x) => x.trim().replace(/^U\+/i, "")).map((x) => { const [a, b2] = x.includes("-") ? x.split("-") : [x, x]; return x.includes("?") ? [parseInt(x.replace(/\?/g, "0"), 16), parseInt(x.replace(/\?/g, "F"), 16)] : [parseInt(a, 16), parseInt(b2, 16)]; });
  const wIn = (fw, w) => { const [a, b2] = String(fw).split(" ").map(Number); return b2 ? w >= a && w <= b2 : a === w; };
  const bad = [], cv = document.createElement("canvas"); cv.width = 120; cv.height = 120; const g = cv.getContext("2d", { willReadFrequently: true });
  for (const [key, set] of used) { const [fam, wt, st] = key.split("|"), w = +wt, fams = fam.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter((f) => !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(f));
    const text = [...set].join(""); for (const f of fams) await document.fonts.load(`${st} ${w} 40px "${f}"`, text).catch(() => 0);
    for (const ch of set) { const cp = ch.codePointAt(0);
      const face = faces.find((fc) => fams.includes(fc.family.replace(/^["']|["']$/g, "")) && wIn(fc.weight, w) && (fc.style === st || fc.style === "normal") && parse(fc.unicodeRange).some(([a, b2]) => cp >= a && cp <= b2));
      g.clearRect(0, 0, 120, 120); g.font = `${st} ${w} 80px ${fam}`; g.fillStyle = "#000"; g.textBaseline = "middle"; g.fillText(ch, 10, 60);
      const d = g.getImageData(0, 0, 120, 120).data; let ink = 0; for (let i = 3; i < d.length; i += 4) ink += d[i] > 40;
      if (!face || face.status !== "loaded" || ink < 12) bad.push(`${ch}（U+${cp.toString(16).toUpperCase()}・${fams[0] || fam}・${w}${!face ? "・同梱フォントに無い" : face.status !== "loaded" ? "・読み込めていない" : "・インクが出ない"}）`); } }
  return bad;
}, TL.end);
out.tofu = glyphs;
// 3) 出るべき文字：0.1秒ごとに見えている文字列を取り、各期待文字列が連続 0.5秒以上ふくまれるか
const run = new Map(expected.map((s) => [s, { cur: 0, best: 0 }])); let prN = 0, n = 0;
for (let t = 0.05; t < TL.end; t += 0.1) {
  await p.evaluate((t) => window.seek(t), t); const r = await p.evaluate(sample); n++; if (r.pr) prN++;
  const L = norm(r.line), mm = r.line.match(MOJI); if (mm && !out.mojibake.some((x) => x.startsWith(`画面: ${mm[0]}`))) out.mojibake.push(`画面: ${mm[0]}（${t.toFixed(1)}秒〜）`);
  for (const [s, v] of run) { if (L.includes(norm(s))) { v.cur += 0.1; v.best = Math.max(v.best, v.cur); } else v.cur = 0; }
}
for (const [s, v] of run) if (v.best < 0.5 - 1e-6) out.missing.push(`${s}（最長 ${v.best.toFixed(1)}秒）`);
out.prRatio = Math.round((prN / n) * 100) / 100; out.expected = expected.length;
console.log(JSON.stringify(out)); await b.close();
