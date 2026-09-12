#!/usr/bin/env node
/**
 * 機能紹介チップが**画面からはみ出さない**ことを数値で確かめる。
 *
 * 【なぜ要るか】
 * チップは依頼側（Supabase / GAS）が書いた文字列をそのまま出す。
 * 長い仕様名が来た時に黙ってはみ出すと、**動画が出来上がるまで
 * 誰も気づかない**（描画は1本7分。テロップで同じ失敗を踏んでいる）。
 *
 * ★本物のコードを読んで測る。ここで幅の式を書き直すと、
 *   検査と本番が別物になって意味が無くなる（決定#115と同じ理由）。
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ★実物の FeatureChips.tsx をそのまま読む（check-telop.mjs と同じ手筋）。
//   ここで幅の式を書き直すと、検査と本番が別物になる。
const tmp = path.resolve(`.check-chips.${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.resolve("src/components/FeatureChips.tsx")],
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
const { FONT_SIZE, MIN_FONT_SIZE, chipTextEm, fitChipFontSize, MAX_FEATURES } = mod;

const WIDTH = 1080;
const INSET = 56;
const CHROME_PX = 9 + 20 + 30 + 18;
const CHECK_SCALE = 0.92;

/** チップ1枚が実際に占める横幅（px）。コンポーネントの style と同じ積み方 */
const chipWidth = (text, market) => {
  const fs = fitChipFontSize(text, market, WIDTH);
  return CHROME_PX + CHECK_SCALE * fs + chipTextEm(text, market) * fs;
};

/*
 * 実際に来そうな仕様の文字列。
 * ★「1つも入っていない」「英数字だけ」「長すぎる」を必ず含める。
 *   普通のものだけ並べても、壊れる入力を見つけられない。
 */
const CASES = [
  ["吸引力 5000Pa", "ja"],
  ["静音 55dB", "ja"],
  ["60日ゴミ自動収集", "ja"],
  ["水拭き＆吸引 同時", "ja"],
  ["連続 180分 稼働", "ja"],
  ["高さ 7.8cm 家具の下OK", "ja"],
  ["アプリで進入禁止エリア設定", "ja"], // 長め。縮んで入るはず
  ["5000Pa / 180min / 55dB", "ja"], // ASCIIだけ。書体の実測表が効く所
  ["Self-emptying for 60 days", "en"],
];

let ng = 0;
const room = WIDTH - INSET; // 右端まで。右の余白は詰めても構わないが超えたら負け

console.log("文字列                                 市場  文字   幅px   右端");
for (const [text, market] of CASES) {
  const fs = fitChipFontSize(text, market, WIDTH);
  const w = chipWidth(text, market);
  const right = INSET + w;
  const bad = right > room || fs < MIN_FONT_SIZE - 0.001 || fs > FONT_SIZE + 0.001;
  if (bad) ng++;
  console.log(
    "%s %s  %s  %s  %s%s",
    text.padEnd(38),
    market,
    fs.toFixed(1).padStart(5),
    w.toFixed(0).padStart(5),
    right.toFixed(0).padStart(5),
    bad ? "  ★NG" : "",
  );
}

/*
 * ★縮める仕組みが**本当に効いているか**も確かめる。
 *   常に FONT_SIZE を返す実装でも、上の検査は「短い文字列なら」通ってしまう。
 */
const longText = "アプリで進入禁止エリアと侵入禁止ラインを自由に設定できる";
const shrunk = fitChipFontSize(longText, "ja", WIDTH);
if (!(shrunk < FONT_SIZE)) {
  console.log("★NG 長い文字列でも縮んでいない（%s px のまま）", shrunk);
  ng++;
} else {
  console.log("\n長文で %s px まで縮む（既定 %s px）", shrunk.toFixed(1), FONT_SIZE);
}

/*
 * ★下限に張り付いてもはみ出す入力があるなら、それは知っておく必要がある。
 *   ここでは「下限でも入らない長さ」を求めて出しておく（落とさない）。
 */
let maxChars = 0;
for (let n = 1; n <= 80; n++) {
  const t = "あ".repeat(n);
  if (INSET + chipWidth(t, "ja") <= room) maxChars = n;
}
console.log("和文で入る上限: %d文字（下限%dpxまで縮めた場合）", maxChars, MIN_FONT_SIZE);

if (MAX_FEATURES !== 3) {
  console.log("★NG 1画面のチップ数は3枚までのはず（今: %d）", MAX_FEATURES);
  ng++;
}

if (ng) {
  console.log("\n★%d件 NG", ng);
  process.exit(1);
}
console.log("\n機能紹介チップ: 合格");
