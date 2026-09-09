/*
 * 走る字幕の改行を、**描画せずに数値だけで**検証する。
 *
 * ★実物の HookTelop.tsx から wrapByWidth を読み込む（check-telop.mjs と同じ作り）。
 *
 * 【何を守るか】
 *   1. 語の途中で切らない（本番で「ゴ／ミ箱」「な／ら」と切れていた）
 *   2. 禁則を守る（行頭に小書き仮名・句読点・閉じ括弧を置かない）
 *   3. どの行も箱の幅に収まる（収まらないとブラウザが**もう一度折り返す**）
 *   4. 文字が1つも失われない
 *
 * 使い方: node scripts/check-caption-wrap.mjs
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const src = path.resolve("src/components/HookTelop.tsx");
const tmp = path.resolve(`.check-caption.${process.pid}.mjs`);
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
const { wrapByWidth, advanceEm } = mod;
if (typeof wrapByWidth !== "function") {
  console.error("★実装から wrapByWidth を取り出せませんでした。検査になっていません");
  process.exit(1);
}

/*
 * ★Captions.tsx と同じ値。**コピーだが、下でその一致を検査している。**
 *   （定数のコピーが実装とずれて検査が意味を失った前例がある → 決定#112）
 */
const W = 1080, INSET_L = 60, INSET_R = 200, FONT = 108;
const BOX = W - INSET_L - INSET_R;

const capSrc = fs.readFileSync(path.resolve("src/components/Captions.tsx"), "utf8");
let fail = 0;
for (const [name, val] of [["INSET_LEFT", INSET_L], ["INSET_RIGHT", INSET_R], ["FONT_SIZE", FONT]]) {
  if (!new RegExp(`const ${name} = ${val};`).test(capSrc)) {
    console.log(` ★Captions.tsx の ${name} が ${val} ではありません。検査の前提が古い`);
    fail++;
  }
}

const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  OK  " : " ★NG "} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};
const widthOf = (line) =>
  Array.from(line).reduce((s, c) => s + advanceEm(c, "ja") * FONT, 0);

/** 実際にナレーションから出てくる形の字幕 */
const CASES = [
  "罪悪感ヤバいゴミ箱",
  "スタンド付きなら",
  "ペットの毛が毎日散らばって",
  "夜中にゴミ箱へ",
  "これ買ったせいで週末のダラダラ時間が増えた",
  "置くだけでゴミを勝手に吸い上げてくれる",
  "正確な値段はプロフに載せといたよ",
  "え、ちょっと待って",
  "短い",
  "掃除機",
];

console.log(`箱の幅 ${BOX}px / 文字 ${FONT}px（和字は1文字 ${Math.round(advanceEm("あ", "ja") * FONT)}px）\n`);
console.log("=== 行に割った結果 ===");
for (const t of CASES) {
  const lines = wrapByWidth(t, BOX, FONT, "ja");
  const widths = lines.map((l) => Math.round(widthOf(l)));
  console.log(`  ${t}`);
  console.log(`    → ${JSON.stringify(lines)}  幅 ${widths.join(" / ")}px`);

  // 4. 文字が失われていない
  ok(lines.join("") === t, "   文字が欠けない", "");
  // 3. どの行も箱に収まる
  ok(
    widths.every((w) => w <= BOX + 0.5),
    "   どの行も箱に収まる",
    `最大 ${Math.max(...widths)}px ≤ ${BOX}px`,
  );
  // 2. 行頭禁則
  const badHead = lines.slice(1).find((l) => "、。，．,.・:：;；?？!！ー―‐〜～)）]］}｝」』】〉》>'’\"”%‰℃ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞヽヾ".includes(Array.from(l)[0]));
  ok(!badHead, "   行頭禁則を守る", badHead ? `「${badHead}」` : "");
}

/*
 * ★★依頼側は字幕を**9文字ずつ**に割って送ってくる
 *   （process-job の JA_CHARS_PER_CHUNK）。つまり実際に来る字幕は
 *   最大9文字であり、**そこで2行に収まること**がこの実装の約束である。
 *   長い文はここに来ない（来たら依頼側の割り方が壊れている）。
 */
console.log("\n=== 実際に来る長さ（9文字以下）は2行に収まるか ===");
{
  const real = CASES.filter((t) => Array.from(t).length <= 9);
  let over = 0;
  for (const t of real) {
    const n = wrapByWidth(t, BOX, FONT, "ja").length;
    if (n > 2) {
      console.log(` ★3行以上になった「${t}」→ ${n}行`);
      over++;
    }
  }
  ok(over === 0, `9文字以下 ${real.length}件すべてが2行以内`);
}

console.log("\n=== 本番で実際に割れていた2件（決定#115 の再現）===");
{
  const lines = wrapByWidth("罪悪感ヤバいゴミ箱", BOX, FONT, "ja");
  ok(!lines.some((l) => l.endsWith("ゴ")), "「ゴ／ミ箱」で切らない", JSON.stringify(lines));
}
{
  const lines = wrapByWidth("スタンド付きなら", BOX, FONT, "ja");
  ok(!lines.some((l) => l === "ら"), "「な／ら」で切らない", JSON.stringify(lines));
}

console.log("\n=== 異常系 ===");
ok(wrapByWidth("", BOX, FONT, "ja").join("") === "", "空文字");
ok(wrapByWidth("あ", 0, FONT, "ja").length === 1, "幅0でも落ちない");
ok(wrapByWidth("あ", BOX, 0, "ja").length === 1, "文字サイズ0でも落ちない");
{
  const long = "あ".repeat(60);
  const lines = wrapByWidth(long, BOX, FONT, "ja");
  ok(lines.join("") === long, "60文字でも欠けない", `${lines.length}行`);
  ok(lines.every((l) => widthOf(l) <= BOX + 0.5), "60文字でも全行が収まる");
}
{
  // 句読点だけ：禁則で切れないので1行のまま出るのが正しい
  const lines = wrapByWidth("。。。。。。。。。。", BOX, FONT, "ja");
  ok(lines.join("") === "。。。。。。。。。。", "句読点だけでも欠けない", JSON.stringify(lines));
}

console.log("\n=== 揺れないこと ===");
{
  const runs = new Set(
    Array.from({ length: 20 }, () => JSON.stringify(wrapByWidth(CASES[4], BOX, FONT, "ja"))),
  );
  ok(runs.size === 1, "20回とも同じ", [...runs][0]);
}

console.log(fail === 0 ? "\n合格" : `\n★不合格 ${fail}件`);
process.exit(fail === 0 ? 0 : 1);
