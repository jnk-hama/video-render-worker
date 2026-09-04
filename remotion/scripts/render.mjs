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

/*
 * ★既存の依頼（ffmpeg版の payload）をそのまま受ける（決定#088）。
 *
 * 依頼側（process-job / GAS）の台本生成は変えない、というのが方針。
 * AI社員の出力契約（キー名の追加・変更の禁止）に触れないためでもある。
 * なので**変換はここで行う**。依頼側に足すのは renderer の1項目だけ。
 *
 *   clips[i]        → シーンi の背景
 *   foreground.url  → 製品（あれば insitu、無ければ背景だけのシーン）
 *   captions        → そのまま
 *   design_tokens   → accent
 */
const adaptLegacyPayload = (s) => {
  if (Array.isArray(s.scenes) && s.scenes.length) return s; // 既にRemotion形式

  const clips = Array.isArray(s.clips) ? s.clips : [];
  if (!clips.length) return s;

  const each = Number(s.clip_seconds) || 3.0;
  const product = s.foreground && s.foreground.url ? s.foreground.url : null;
  // 運鏡は順に変える。同じ動きが続くと単調になる
  const moves = ["orbit", "push_in", "pan_right", "pull_out"];

  s.scenes = clips.map((c, i) => {
    const seconds = Number(c.duration) || each;
    const camera = moves[i % moves.length];
    // ★製品は最初のシーンにだけ置く。全シーンに出すとくどく、
    //   背景が変わるたびに製品が瞬間移動して見える
    if (product && i === 0) {
      return {
        kind: "insitu",
        seconds,
        camera,
        backgroundUrl: c.url,
        productUrl: product,
        heightRatio: Number(s.foreground.height_ratio) || 0.42,
        yRatio: Number(s.foreground.y_ratio) || 0.58,
        ambient: s.foreground.ambient === undefined ? 0.25 : Number(s.foreground.ambient),
      };
    }
    return { kind: "talk", seconds, camera, backgroundUrl: c.url, headline: "" };
  });

  s.market = s.target_market || s.market || "ja";
  s.accent = (s.design_tokens && s.design_tokens.accent_color_hex) || s.accent || "#8b5cf6";
  s.width = Number(s.width) || 1080;
  s.height = Number(s.height) || 1920;
  s.fps = Number(s.fps) || 30;
  console.log(`既存形式の依頼を ${s.scenes.length} シーンへ変換しました`);
  return s;
};

adaptLegacyPayload(script);

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

/*
 * ★製品画像だけ data URI にして埋め込む（実測して直した）。
 *
 * 【何が起きたか】
 * 環境光（ambient）は、製品の形＝アルファでCSSマスクを切る。ところが
 * 別オリジンの画像をマスクに使うと Chrome が取得を拒否し（ERR_FAILED）、
 * 1本目の描画では**環境光が丸ごと効いていなかった**。
 * `<Img>` は表示できるのにマスクだけ失敗するので、絵を見ても気づきにくい。
 *
 * 【なぜ data URI か】
 * 同一オリジン扱いになるので、CORSの設定に依存しない。素材の置き場所が
 * Supabase Storage でもASPのCDNでも、こちら側だけで完結する。
 * 背景動画は大きいのでURLのまま（OffthreadVideo は別オリジンでも読める）。
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const toDataUri = async (url) => {
  if (!url || url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url; // ローカルパスはそのまま
  const res = await fetch(url);
  if (!res.ok) throw new Error(`製品画像を取得できません: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_INLINE_BYTES) {
    throw new Error(`製品画像が大きすぎます（${buf.byteLength}バイト）`);
  }
  const type = res.headers.get("content-type") || "image/png";
  return `data:${type};base64,${buf.toString("base64")}`;
};

/*
 * ★音声もローカルのファイルなら data URI にする。
 *   <Audio> は file:// を読めず、public/ 経由も404になった（実測）ので、
 *   フォント・製品画像と同じ手筋に揃える。13秒のmp3で約100KB。
 */
const fileToDataUri = (p, mime) => {
  if (!p || /^(https?:|data:)/i.test(p)) return p;
  if (!fs.existsSync(p)) {
    console.warn(`  音声が見つかりません（無音で続行）: ${p}`);
    return null;
  }
  const buf = fs.readFileSync(p);
  return `data:${mime};base64,${buf.toString("base64")}`;
};

for (const key of ["narrationUrl", "bgmUrl"]) {
  if (script[key]) {
    script[key] = fileToDataUri(script[key], "audio/mpeg");
  }
}

for (const scene of script.scenes) {
  if (scene.kind !== "insitu" || !scene.productUrl) continue;
  try {
    scene.productUrl = await toDataUri(scene.productUrl);
    console.log("  製品画像を埋め込みました（CSSマスクのため）");
  } catch (e) {
    // ★埋め込めなくても描画は続ける。環境光が効かないだけで動画は成立する
    console.warn(`  製品画像を埋め込めませんでした（環境光なしで続行）: ${e.message}`);
  }
}

/*
 * ★日本語フォントをリポジトリ同梱のTTFから埋め込む。
 *   ffmpeg版（libass）と同じファイルを使うので、書体が1バイトも違わない。
 *   ネットワークへ取りに行かないので、外部の障害で描画が落ちない。
 */
const FONT_BY_MARKET = {
  ja: "assets/ja/fonts/DelaGothicOne-Regular.ttf",
  en: "assets/en/fonts/Anton-Regular.ttf",
};

try {
  const rel = FONT_BY_MARKET[script.market] ?? FONT_BY_MARKET.ja;
  // remotion/ の1つ上がリポジトリの根
  const fontPath = path.resolve("..", rel);
  const buf = fs.readFileSync(fontPath);
  script.fontDataUri = `data:font/ttf;base64,${buf.toString("base64")}`;
  console.log(`フォント: ${rel}（${(buf.byteLength / 1024).toFixed(0)}KB）を埋め込みました`);
} catch (e) {
  // ★読めなくても描画は続ける。ただし書体が変わる事実は必ず残す
  console.warn(`フォントを読めませんでした（既定の書体で続行）: ${e.message}`);
  script.fontDataUri = null;
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
