#!/usr/bin/env node
/*
 * 台本(JSON)を1本のMP4にする。GitHub Actions から呼ばれる入口。
 *
 *   node scripts/render.mjs --payload payload.json --out out.mp4
 *
 * ★ffmpeg版の render_video.py と**同じ引数**にしてある。
 *   ワークフローが2つの描画方式を出し分けても、呼び方が変わらない。
 *
 * ★描画にかかった秒数を必ず出す。無料枠2,000分/月に対して
 *   1本あたり何分かかるかが、そのまま1日に出せる本数を決める。
 *   測らずに本数を決めて3倍外した過去がある（#079）。
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const payloadPath = arg("payload");
const outPath = arg("out", "out.mp4");
if (!payloadPath) {
  console.error("--payload が必要です");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
// 依頼は {job:{...}} で包まれてくる（GitHub の client_payload 制限のため）
const script = raw.job ?? raw;

// ★最低限の検査。壊れた台本で長時間まわしてから落ちるのを防ぐ
for (const key of ["width", "height", "fps", "scenes"]) {
  if (script[key] === undefined) {
    console.error(`台本に ${key} がありません`);
    process.exit(1);
  }
}
if (!Array.isArray(script.scenes) || script.scenes.length === 0) {
  console.error("scenes が空です");
  process.exit(1);
}
const totalSeconds = script.scenes.reduce((s, x) => s + Number(x.seconds || 0), 0);
if (!(totalSeconds > 0)) {
  console.error("尺が0秒です");
  process.exit(1);
}

const started = Date.now();
console.log(
  `台本: ${script.scenes.length}シーン / ${totalSeconds.toFixed(1)}秒 / ` +
    `${script.width}x${script.height}@${script.fps}`,
);

/*
 * ★publicDir を明示する。省くと public/ が配信されず、素材が
 *   すべて 404 になる（実測。エラーは「フレームを取り出せない」としか
 *   出ないので、原因にたどり着くのに時間がかかる）。
 *   同梱素材（BGM・効果音・フォント）をここから配る。
 */
const serveUrl = await bundle({
  entryPoint: path.resolve("src/index.ts"),
  publicDir: path.resolve("public"),
  onProgress: (p) => {
    if (p % 25 === 0) console.log(`  束ね中 ${p}%`);
  },
});

const composition = await selectComposition({
  serveUrl,
  id: "Main",
  inputProps: { script },
});

let lastLogged = -1;
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: outPath,
  inputProps: { script },
  // ★並列数はランナーのコア数に任せる。固定すると2コアの無料ランナーで
  //   詰まるか、逆に使い切れない
  concurrency: null,
  onProgress: ({ progress }) => {
    const pct = Math.floor(progress * 100);
    if (pct >= lastLogged + 10) {
      lastLogged = pct;
      console.log(`  描画中 ${pct}%`);
    }
  },
});

const elapsed = (Date.now() - started) / 1000;
const size = fs.statSync(outPath).size;
if (size < 10 * 1024) {
  console.error(`出力が小さすぎます（${size}B）。壊れています。`);
  process.exit(1);
}

console.log(
  `完成: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB / ` +
    `${totalSeconds.toFixed(1)}秒の動画 / 描画に ${elapsed.toFixed(1)}秒)`,
);
console.log(`実測: 動画1秒あたり ${(elapsed / totalSeconds).toFixed(2)} 秒かかった`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `render_seconds=${elapsed.toFixed(1)}\nbytes=${size}\n`,
  );
}
