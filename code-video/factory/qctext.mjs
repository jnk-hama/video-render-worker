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
const SKIP = new Set(["kind", "voice", "say", "source", "broll", "frames", "alt_bg", "cam", "open", "mv", "why", "image", "icons", "glint", "slide_hero", "leader", "widths", "gold", "accent", "count", "value", "rating", "reviews", "cells", "tail", "step", "cut", "size", "part_rect", "pair", "anchor", "angle", "box", "at", "motif", "native"]);
const expected = [];
const walk = (v, key) => {
  if (SKIP.has(key)) return;
  if (typeof v === "string" && /\.(png|jpe?g|mp3|mp4)$/i.test(v)) return;   // ファイル名は画面に出ない
  if (typeof v === "string") v.split(/<br\s*\/?>/i).forEach((s) => { s = s.replace(/<[^>]+>/g, ""); if (s.trim()) expected.push(s); });
  else if (Array.isArray(v)) (key === "bars" ? v.map((x) => x[0]) : v).forEach((x) => walk(x, key));   // 棒は名前だけ（色名は出ない）
  else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
};
PR.beats.forEach((b) => walk(b, ""));
if (PR.name) expected.push(PR.name);   // 商品名は必ず画面に出す（#276）
if (PR.target && PR.target.who) expected.push(PR.target.who);   // 誰に向けた動画かも画面に出す（#283）
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
  const texts = [], vb = []; let pr = false;
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
      const ca = getComputedStyle(e).color.match(/[\d.]+/g).map(Number), ok = boxes.length > 0 && effOpacity(e) >= 0.9 && (ca.length < 4 || ca[3] >= 0.9) && boxes.every((r) => r.left >= 8 && r.right <= 1072 && r.top >= 8 && r.bottom <= 1912 && !clipped(e, r));
      if (ok) { const m = getComputedStyle(e).color.match(/[\d.]+/g).map(Number), u = boxes.reduce((q, r) => ({ x0: Math.min(q.x0, r.left), y0: Math.min(q.y0, r.top), x1: Math.max(q.x1, r.right), y1: Math.max(q.y1, r.bottom) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
        vb.push({ text: s.trim().slice(0, 14), c: m.slice(0, 3), x0: Math.max(0, u.x0), y0: Math.max(0, u.y0), x1: Math.min(1080, u.x1), y1: Math.min(1920, u.y1) }); }
      if (e.closest("#pr")) { pr = pr || ok; continue; }
      if (ok) texts.push(s); } });
  return { line: texts.join(""), pr, vb };
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
// 4) 文字と背景の明るさの差（#277）：0.5秒ごとに、見えている文字の色と、その文字の下の背景（文字を消して撮った画面）の明るさを比べる。3:1 未満は読めない
const lowc = [];
for (let t = 0.25; t < TL.end; t += 0.5) {
  await p.evaluate((t) => window.seek(t), t);
  const boxes = (await p.evaluate(sample)).vb;   // 欠けずに見えている文字だけ（動いて消える途中の字は見ない）
  if (!boxes.length) continue;
  // 文字だけ消す（札・ボタン・暗幕の地の色は残す＝文字のすぐ下の本当の背景）
  await p.evaluate(() => { const st = document.createElement("style"); st.id = "__noText"; st.textContent = "#ui *, #behind * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }"; document.head.appendChild(st); });
  const png = (await p.screenshot({ type: "png" })).toString("base64");
  await p.evaluate(() => document.getElementById("__noText").remove());
  const bad = await p.evaluate(async ([b64, boxes]) => {
    const im = new Image(); im.src = "data:image/png;base64," + b64; await im.decode();
    const cv = document.createElement("canvas"); cv.width = 1080; cv.height = 1920; const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
    const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    return boxes.flatMap((b) => { const w = Math.max(1, Math.round(b.x1 - b.x0)), h = Math.max(1, Math.round(b.y1 - b.y0)); const d = g.getImageData(Math.round(b.x0), Math.round(b.y0), w, h).data, ls = [];
      for (let i = 0; i < d.length; i += 16) ls.push(L([d[i], d[i + 1], d[i + 2]])); ls.sort((a, c) => a - c); const bg = ls[Math.floor(ls.length / 2)], fg = L(b.c);
      const cr = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05); return cr < 3 ? [`${b.text}（${cr.toFixed(1)}:1）`] : []; });
  }, [png, boxes]);
  bad.forEach((x) => { if (!lowc.some((y) => y.startsWith(x.split("（")[0]))) lowc.push(`${x} ${t.toFixed(1)}秒`); });
}
out.lowContrast = lowc;
out.prRatio = Math.round((prN / n) * 100) / 100; out.expected = expected.length;
console.log(JSON.stringify(out)); await b.close();
