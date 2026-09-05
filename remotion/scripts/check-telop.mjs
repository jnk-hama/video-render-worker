/*
 * 巨大テロップの行割りを、**描画せずに数値だけで**検証する。
 *
 * ★実物の HookTelop.tsx を esbuild でそのまま読み込む。
 *   以前は正規表現でソースから関数を切り出していたが、実装を触るたびに
 *   抽出が壊れ、**テストが実物とずれる**。それでは検証にならない。
 *
 * 使い方: node scripts/check-telop.mjs
 * 落ちたら（画面外へ出る／単語が割れる）終了コード1。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const src = path.resolve("src/components/HookTelop.tsx");
/*
 * ★出力は**このパッケージの中**へ書く。data: URL から読むと
 *   "react" のような裸の指定を node が解決できない（実際に落ちた）。
 */
const tmp = path.resolve(`.check-telop.${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [src],
  outfile: tmp,
  bundle: true,
  format: "esm",
  external: ["react", "remotion", "react/jsx-runtime"],
  loader: { ".tsx": "tsx" },
});
let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  fs.rmSync(tmp, { force: true });
}
const { layoutTelop, TELOP_STYLES, seedOf, shuffledBySeed, advanceEm } = mod;

const W = 1080, H = 1920;
const BAND_TOP = H * 0.07, BAND_H = H * 0.56 - BAND_TOP;
const CAPTION_TOP = H * 0.6; // 走る字幕の上端

const JA = ["沼", "神ツール", "スマホ首", "値段がバグ", "もっと安い", "夜が静かすぎる",
  "もう戻れない", "熱意ある人材", "ぐっすり寝れる", "財布が死んだ", "スマホが熱い",
  "値段バグってる", "朝までゲーム", "3秒で終わる", "AIに全部やらせた", "SNSが終わる",
  "これは知らないと損する話", "メモリが死ぬ", "はやい", "ととのう場所"];
const EN = ["INSANE", "THIS IS INSANE", "I WASTED 3 YEARS", "STOP SCROLLING",
  "NOBODY TOLD ME", "YOUR PHONE IS LYING TO YOU",
  "WHY IS NOBODY TALKING ABOUT THIS", "IT COST ME EVERYTHING", "3 SECONDS"];

let fail = 0;
const line = (t, lines, px) =>
  `${t.padEnd(34)} ${JSON.stringify(lines).padEnd(46)} ${String(Math.round(px)).padStart(4)}px ${(px / W * 100).toFixed(0).padStart(3)}%`;

for (const [market, list] of [["ja", JA], ["en", EN]]) {
  console.log(`\n=== ${market === "ja" ? "B（日本語 / Dela Gothic One）" : "A（英語 / Anton）"} ===`);
  for (const t of list) {
    const r = layoutTelop(t, W, BAND_H, 0, market);
    console.log(" " + line(t, r.lines, r.fontSize));
    // 英語は単語を割ってはいけない
    if (market === "en") {
      const back = r.lines.join(" ").replace(/\s+/g, " ").trim();
      if (back !== t.replace(/\s+/g, " ").trim()) {
        console.log("   ★単語が割れた"); fail++;
      }
    }
  }
}

console.log("\n=== 5演出 × 両市場：画面からはみ出さないか ===");
let n = 0;
for (const [market, list] of [["ja", JA], ["en", EN]]) {
  for (const st of TELOP_STYLES) {
    for (const t of list) {
      n++;
      const { lines, fontSize } = layoutTelop(t, W, BAND_H, st.tiltDeg, market);
      const em = Math.max(...lines.map((l) =>
        Array.from(l).reduce((s, c) => s + advanceEm(c, market), 0)));
      const w = em * fontSize, h = lines.length * fontSize;
      const rad = Math.abs(st.tiltDeg) * Math.PI / 180;
      const bw = w * Math.cos(rad) + h * Math.sin(rad);
      const bh = w * Math.sin(rad) + h * Math.cos(rad);
      const cx = W / 2, cy = BAND_TOP + BAND_H / 2;
      if (cx - bw / 2 < -0.5 || cx + bw / 2 > W + 0.5 ||
          cy - bh / 2 < -0.5 || cy + bh / 2 > CAPTION_TOP + 0.5) {
        console.log(` ★はみ出し ${market} ${st.name} 「${t}」`); fail++;
      }
    }
  }
}
console.log(fail === 0 ? ` 全 ${n} 通り: 画面内・走る字幕(${CAPTION_TOP}px)にも当たらない` : ` ★${fail}件`);

console.log("\n=== 演出の割り当てが job_id だけで決まるか（乱数を使っていないこと）===");
const names = (id) => shuffledBySeed(TELOP_STYLES, seedOf(id)).map((x) => x.name.slice(0, 4)).join(" ");
for (const id of ["telop-check6", "telop-check6", "a1b2c3"]) console.log(` ${id.padEnd(14)} ${names(id)}`);
if (names("telop-check6") !== names("telop-check6")) { console.log(" ★揺れている"); fail++; }
const dup = 5 - new Set(shuffledBySeed(TELOP_STYLES, seedOf("telop-check6")).slice(0, 5)).size;
console.log(` 5シーン中の演出の重複: ${dup} 件`);

console.log("\n=== 異常系 ===");
for (const [t, m] of [["", "ja"], [" ", "ja"], ["あ", "ja"], ["。。。", "ja"],
                      ["あ".repeat(30), "ja"], ["", "en"], ["A", "en"],
                      ["SUPERCALIFRAGILISTICEXPIALIDOCIOUS", "en"]]) {
  const r = layoutTelop(t, W, BAND_H, -7, m);
  const h = r.lines.length * r.fontSize;
  const okH = h <= BAND_H + 1;
  console.log(` ${m} ${JSON.stringify(t.slice(0, 12)).padEnd(16)} ${JSON.stringify(r.lines).slice(0, 40).padEnd(42)} ${Math.round(r.fontSize)}px ${okH ? "高さOK" : "★高さ超過"}`);
  if (!okH) fail++;
}

console.log(fail === 0 ? "\n合格" : `\n★不合格 ${fail}件`);
process.exit(fail === 0 ? 0 : 1);
