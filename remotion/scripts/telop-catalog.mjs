/*
 * 巨大テロップの演出パターン一覧を、**実物のコードから**書き出す。
 *
 * ★手で書いた一覧は必ず実装とずれる。ここで生成すれば、演出を足した時に
 *   `node scripts/telop-catalog.mjs > ../docs/telop-presets.md` を叩くだけで
 *   一覧が追従する。
 *
 * 使い方:
 *   cd remotion && node scripts/telop-catalog.mjs > ../docs/telop-presets.md
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.resolve(`.catalog.${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.resolve("src/components/HookTelop.tsx")],
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
const { TELOP_STYLES, PALETTE_FOR_TELOP, layoutTelop, advanceEm, seedOf, shuffledBySeed } = mod;

const W = 1080, H = 1920;
const BAND_TOP = H * 0.12, BAND_H = H * 0.58 - BAND_TOP;

const move = (s) => {
  const p = [];
  if (s.popFrom > 1.4) p.push(`${s.popFrom}倍から圧縮`);
  else if (s.popFrom > 1.0) p.push(`${s.popFrom}倍から`);
  if (s.dropRatio > 0) p.push("上から落下");
  if (s.dropRatio < 0) p.push("下から突き上げ");
  if (s.slideRatio) p.push(s.slideRatio < 0 ? "左から横入り" : "右から横入り");
  if (s.shake) p.push("着地で揺れ");
  return p.length ? p.join(" / ") : "なし";
};
const glowName = { steady: "常時発光", slow: "ゆっくり明滅(0.6Hz)", blink: "点滅(2.2Hz)" };

console.log("# 巨大テロップ 演出パターン一覧");
console.log("");
console.log("> **このファイルは自動生成です。手で編集しないでください。**");
console.log("> `cd remotion && node scripts/telop-catalog.mjs > ../docs/telop-presets.md`");
console.log("");
console.log("演出は **job_id を種にして並べ替え**て割り当てます。乱数は使いません。");
console.log("同じ動画は何度描いても1フレームも変わらず、動画ごとに並びは変わります。");
console.log("");
console.log(`## 演出（${TELOP_STYLES.length}種類）`);
console.log("");
console.log("| # | 名前 | 傾き | 光り方 | 縁の太さ | 二重縁 | 動き |");
console.log("|---|---|---|---|---|---|---|");
TELOP_STYLES.forEach((s, i) => {
  console.log(
    `| ${i + 1} | ${s.name} | ${s.tiltDeg}° | ${glowName[s.glow]} | ${s.outlineRatio} | ` +
    `${s.ringOutline ? "あり" : "—"} | ${move(s)} |`,
  );
});
console.log("");
console.log("縁の太さは文字サイズに対する割合です。二重縁は黒縁の外側にもう1枚、");
console.log("その回の色で縁を重ねます（外側1.9倍まで張り出す）。");
console.log("");
console.log(`## 色（${PALETTE_FOR_TELOP.length}色）`);
console.log("");
console.log(PALETTE_FOR_TELOP.map((c) => `\`${c}\``).join(" / "));
console.log("");
console.log("暗い色は入れていません。背景（ストック映像を暗く落としてある）に沈むためです。");
console.log("色の並びも job_id で決まります。");
console.log("");
console.log("## 実際の描画サイズ（1080x1920・傾き0°）");
console.log("");
console.log("| 文字列 | 行割り | 文字サイズ | 画面幅比 |");
console.log("|---|---|---|---|");
for (const t of ["沼", "神ツール", "スマホ首", "値段がバグ", "もう戻れない",
                 "夜が静かすぎる", "AIに全部やらせた", "SNSが終わる"]) {
  const r = layoutTelop(t, W, BAND_H, 0, "ja", 0.12);
  console.log(`| ${t} | ${r.lines.join(" / ")} | ${Math.round(r.fontSize)}px | ${(r.fontSize / W * 100).toFixed(0)}% |`);
}
console.log("");
console.log("| 英語 | 行割り | 文字サイズ | 画面幅比 |");
console.log("|---|---|---|---|");
for (const t of ["INSANE", "3 SECONDS", "THIS IS INSANE", "IT COST ME EVERYTHING",
                 "WHY IS NOBODY TALKING ABOUT THIS"]) {
  const r = layoutTelop(t, W, BAND_H, 0, "en", 0.12);
  console.log(`| ${t} | ${r.lines.join(" / ")} | ${Math.round(r.fontSize)}px | ${(r.fontSize / W * 100).toFixed(0)}% |`);
}
console.log("");
console.log("## 割り当ての例（job_id で決まる）");
console.log("");
console.log("| job_id | 1枚目 | 2枚目 | 3枚目 | 4枚目 | 5枚目 |");
console.log("|---|---|---|---|---|---|");
for (const id of ["telop-check6", "a1b2c3", "994fef3d"]) {
  const names = shuffledBySeed(TELOP_STYLES, seedOf(id)).slice(0, 5).map((s) => s.name);
  console.log(`| \`${id}\` | ${names.join(" | ")} |`);
}
console.log("");
console.log("## 置ける範囲");
console.log("");
console.log(`- 縦: 画面高さの 12% 〜 58%（走る字幕は 60% にある）`);
console.log("- 上端を 7% から 12% へ下げた。3行になる長いフックで上端が7.0%まで");
console.log("  達しており、TikTok上部のタブに隠れる危険があったため");
console.log("- **★TikTok公式はセーフゾーンの具体的な%を公開していない。**");
console.log("  「キャプションの長さやアドオンで変わる」「テンプレートを");
console.log("  ダウンロードして確認せよ」としている。ここでは確認できない数字を");
console.log("  採用せず、方向（上端を下げる）だけを採った。");
console.log("  **右側のUI列との干渉は未確認。** 実機に投稿できたら実測すること");
