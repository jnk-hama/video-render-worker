/*
 * 巨大テロップを**実物のコンポーネントで描いて目で見る**ための道具。
 *
 * ============================================================
 * 【なぜ作ったか（2026-09-09・決定#112）】
 *
 * テロップの見た目を変えるたびに、確かめる方法が
 *   ① 本番を1本描く（7分。しかもDBにジョブを積む必要がある）
 *   ② check-telop.mjs の数値を見る（**絵は見えない**）
 * の2つしか無かった。
 *
 * ★実際にこれで間違えた。一列化の作業中、その場で書いた props に
 *   **フォントを入れ忘れたまま**静止画を描き、細い代替書体で出た結果を
 *   「塗りが壊れた」と読み違えて、無い不具合を30分追いかけた。
 *   本当の不具合（グラデーションが小さい字に当たらない）は別にあり、
 *   本番の1フレームと並べて初めて分かった。
 *
 * ★**道具が無いから間違えた。** だから道具にする。ここを通せば
 *   フォントは必ず入り、実物のコンポーネントが実物の寸法で描かれる。
 * ============================================================
 *
 * 使い方:
 *   node scripts/preview-telop.mjs                     # 見本の文で全8演出
 *   node scripts/preview-telop.mjs これで十分 値段がバグ   # 文を指定
 *   node scripts/preview-telop.mjs --market=en "STOP SCROLLING"
 *   node scripts/preview-telop.mjs --job=abc123        # 演出の並びを固定する種
 *   node scripts/preview-telop.mjs --out=/tmp/x.png
 *   node scripts/preview-telop.mjs --bg=assets/shared/xxx.mp4  # 背景を差し替える
 *
 * 字幕（走るテロップ）を見る時:
 *   node scripts/preview-telop.mjs --at=2.4 \
 *     --captions=この機能でこの価格は安すぎん,置くだけでゴミを勝手に吸い上げてくれる \
 *     --emphasis=安すぎん,勝手に
 *
 * ★--at が要る理由。既定の 0.6秒 は**巨大テロップが出ている区間**で、
 *   そこでは字幕を出さない決まりになっている（決定#108「2個被らせない」）。
 *   つまり既定のまま描いても**字幕は1枚も映らない**。
 *   テロップの出る 1.4秒 より後ろを指す必要がある。
 * ★--emphasis は台本の telop_emphasis と同じ。その語だけ大きく色を変える
 *   （決定#124）ので、**幅の見積りが効いているかは絵でしか確かめられない**。
 *
 * ★--bg は**色や明るさの変更をA/Bする時に要る**。既定の中立な背景は
 *   暗い単色なので、暗さ・彩度の調整が効いているかどうかが分からない。
 *   実写に近い素材を置いて、掛ける／掛けないの2枚を測ること（決定#114）。
 *
 * 出す物: 横に並べた1枚のPNG（ffmpegがあれば）と、各フレームのPNG。
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve("..");
const W = 1080;
const H = 1920;
const FPS = 30;
const SCENE_SEC = 3.0;

/** 市場ごとの書体。**ここを通れば入れ忘れようがない** */
const FONTS = {
  ja: "assets/ja/fonts/DelaGothicOne-Regular.ttf",
  en: "assets/en/fonts/Anton-Regular.ttf",
};

const SAMPLES = {
  ja: ["これで十分", "値段がバグ", "自動ゴミ回収", "夜が静かすぎる", "沼"],
  en: ["INSANE", "STOP SCROLLING", "NOBODY TOLD ME", "3 SECONDS"],
};

// ------------------------------------------------------------
// 引数
// ------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const market = flag("market", "ja");
const jobId = flag("job", "preview");
const outFile = path.resolve(flag("out", "preview-telop.png"));
const texts = argv.filter((a) => !a.startsWith("--"));
const telops = texts.length ? texts : SAMPLES[market] ?? SAMPLES.ja;

/*
 * ★字幕を見るための3つ。既定のままなら今までと同じ絵が出る（既存の使い方を壊さない）。
 */
const list = (name) => flag(name, "").split(",").map((s) => s.trim()).filter(Boolean);
/** 何秒目を描くか。既定 0.6秒 は巨大テロップの区間なので**字幕は映らない** */
const atSec = Number(flag("at", "0.6"));
if (!Number.isFinite(atSec) || atSec < 0 || atSec >= SCENE_SEC) {
  console.error(`★--at は 0以上 ${SCENE_SEC}未満 の秒数です（受け取った値: ${flag("at", "")}）`);
  process.exit(1);
}
const emphasisWords = list("emphasis");
/** ★実際に来る形（依頼側は9文字ずつに刻む）を既定にする */
const DEFAULT_CAPTIONS = ["罪悪感ヤバいゴミ箱", "スタンド付きなら", "ペットの毛が毎日", "え、ちょっと待って", "安すぎて二度見"];
const givenCaptions = list("captions");
/** テロップの枚数ぶん用意する。足りなければ先頭から繰り返す */
const source = givenCaptions.length ? givenCaptions : DEFAULT_CAPTIONS;
const captionTexts = telops.map((_, i) => source[i % source.length]);

if (!FONTS[market]) {
  console.error(`★market は ${Object.keys(FONTS).join(" / ")} のいずれかです（受け取った値: ${market}）`);
  process.exit(1);
}

// ------------------------------------------------------------
// 書体。**無ければ止める。**
//
// ★ここが今回の道具の主目的。代替書体で描かれた絵を見て判断すると、
//   縁の太さも文字幅も実物と違うので、**必ず読み違える**。
// ------------------------------------------------------------
const fontPath = path.join(REPO, FONTS[market]);
if (!fs.existsSync(fontPath)) {
  console.error(`★書体が見つかりません: ${fontPath}`);
  console.error("  代替書体で描くと縁も文字幅も実物と違うので、ここで止めます。");
  process.exit(1);
}
const fontDataUri = `data:font/ttf;base64,${fs.readFileSync(fontPath).toString("base64")}`;
console.log(`書体: ${FONTS[market]}（${(fs.statSync(fontPath).size / 1024 / 1024).toFixed(1)}MB）`);

// ------------------------------------------------------------
// 背景。**外に出ない。** 同梱の中立な背景をローカルのHTTPで配る。
//
// ★Remotion の OffthreadVideo は URL を要求する。file:// は環境で
//   挙動が変わるので、127.0.0.1 に立てて確実に読ませる。
// ------------------------------------------------------------
const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
  const file = path.join(REPO, rel);
  // ★リポジトリの外を読ませない
  if (!file.startsWith(REPO + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "video/mp4" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const script = {
  jobId,
  width: W,
  height: H,
  fps: FPS,
  market,
  accent: "#FF3D8A",
  disclosure: "PR / アフィリエイト広告を含みます",
  fontDataUri,
  // ★字幕を1本入れておく。巨大テロップと**重なっていないこと**も
  //   同時に見たいため（決定#108。テロップの間は字幕を出さない）
  captions: captionTexts.map((text, i) => ({
    text,
    start: i * SCENE_SEC,
    end: (i + 1) * SCENE_SEC,
    highlight: "",
  })),
  highlightWords: emphasisWords,
  scenes: telops.map(() => ({
    kind: "talk",
    seconds: SCENE_SEC,
    camera: "hold",
    backgroundUrl: `${base}/${flag("bg", "assets/shared/neutral-gradient.mp4")}`,
    headline: "",
  })),
  hookTelops: telops,
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "telop-preview-"));
const propsFile = path.join(work, "props.json");
fs.writeFileSync(propsFile, JSON.stringify({ script }));

// ------------------------------------------------------------
// 描画。各シーンの頭（テロップが出ている 1.4秒 の途中）を1枚ずつ
// ------------------------------------------------------------
/*
 * ★**spawnSync を使わない。** 同期で待つとこのプロセスのイベントループが
 *   止まり、上で立てたHTTPサーバが背景動画を返せなくなる。
 *   （実際にそれで「1枚も描けません」になった。Remotion側からは
 *     背景の取得が終わらないだけなので、原因が見えにくい）
 */
const render = (args) =>
  new Promise((resolve) => {
    const p = spawn("npx", args, { encoding: "utf8" });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });

const frames = [];
let failed = 0;
for (const [i, t] of telops.entries()) {
  const frame = Math.round((i * SCENE_SEC + atSec) * FPS);
  const png = path.join(work, `f${String(i).padStart(2, "0")}.png`);
  const r = await render([
    "remotion", "still", "src/index.ts", "Main", png,
    `--frame=${frame}`, `--props=${propsFile}`, "--log=error",
  ]);
  if (r.code !== 0 || !fs.existsSync(png)) {
    console.error(`★「${t}」の描画に失敗しました\n${r.out}`);
    failed++;
    continue;
  }
  console.log(`  描画 ${i + 1}/${telops.length}  「${t}」`);
  frames.push(png);
}
server.close();

if (!frames.length) {
  console.error("★1枚も描けませんでした");
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// ------------------------------------------------------------
// 横に並べて1枚にする。ffmpegが無い環境では個別のPNGだけ残す
// ------------------------------------------------------------
const outDir = path.dirname(outFile);
fs.mkdirSync(outDir, { recursive: true });
const stacked = spawnSync(
  "ffmpeg",
  ["-y", "-loglevel", "error",
   ...frames.flatMap((f) => ["-i", f]),
   "-filter_complex",
   frames.map((_, i) => `[${i}]`).join("") +
     `hstack=inputs=${frames.length},scale=${Math.min(1800, frames.length * 380)}:-1`,
   outFile],
  { encoding: "utf8" },
);

if (stacked.status === 0 && fs.existsSync(outFile)) {
  console.log(`\n並べた1枚: ${outFile}`);
} else {
  // ffmpegが無い／失敗した回でも、絵は残す
  const kept = frames.map((f) => {
    const dest = path.join(outDir, path.basename(f));
    fs.copyFileSync(f, dest);
    return dest;
  });
  console.log(`\nffmpegで並べられなかったので個別に置きました:\n  ${kept.join("\n  ")}`);
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
