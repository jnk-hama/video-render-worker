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
const { layoutTelop, TELOP_STYLES, seedOf, shuffledBySeed, advanceEm,
        BAND_TOP_RATIO, BAND_BOTTOM_RATIO } = mod;

const W = 1080, H = 1920;
// ★★実装から読む。ここに数値をコピーすると、実装を動かした時に
//   検査だけが古い帯を測り続ける（2026-09-09、実際にそれで見逃した）。
const BAND_TOP = H * BAND_TOP_RATIO, BAND_H = H * BAND_BOTTOM_RATIO - BAND_TOP;
/*
 * ★★2026-09-09、判定の下限を変えた。
 *
 *   【以前】走る字幕の上端 0.6（1152px）に当たらないこと。
 *     巨大テロップと字幕が**同時に出る**設計だったので、この条件は正しかった。
 *
 *   【今】Video.tsx が巨大テロップを「シーン頭の1.4秒だけ」に変え、
 *     その区間は字幕を出さない（決定#108）。つまり2つが同時に画面へ
 *     出ることは無く、**字幕の位置と重なるかどうかは意味を持たない**。
 *     テストを緩めたのではなく、**守るべき条件そのものが変わった**。
 *
 *   【では何を守るか】SNSのUIに食われないこと。
 *     ★TikTokは安全域の具体的な%を公開していない（テンプレートを配って
 *       各自で確認せよ、という形）。よってここでも数字を断定できない。
 *       下端 0.72 は「UI帯（ユーザー名・投稿文）より確実に上」という
 *       保守的な線として置いた**推定値**である。実機に投稿できたら実測して
 *       詰め直すこと。
 */
const SAFE_BOTTOM = H * 0.72;

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

console.log(`\n=== ${TELOP_STYLES.length}演出 × 両市場：縁まで含めて画面に収まるか ===`);
console.log("  ★字面だけでなく**縁の張り出し**も足して測る。8方向の複製を");
console.log("    ±outline ずらしており、色の縁を足す回は外側1.9倍まで出る。");
let n = 0;
let worstTop = 1e9, worstRight = -1e9, worstBottom = -1e9;
for (const [market, list] of [["ja", JA], ["en", EN]]) {
  for (const st of TELOP_STYLES) {
    for (const t of list) {
      n++;
      const padEm = st.outlineRatio; // 黒縁までを保証対象にする
      const { lines, fontSize, accents } = layoutTelop(t, W, BAND_H, st.tiltDeg, market, padEm);
      /*
       * ★1文字ごとの大きさ（accents）を掛けて測る。実装が span ごとに
       *   fontSize を変えているので、**掛けないと実物より細く・低く見積もる**。
       *   ここを等倍のままにすると、はみ出しているのに合格が出る。
       */
      const scaleAt = (li, ci) => accents[li]?.[ci]?.scale ?? 1;
      const glyphEm = Math.max(...lines.map((l, li) =>
        Array.from(l).reduce((s, c, ci) => s + advanceEm(c, market) * scaleAt(li, ci), 0)));
      const maxScale = Math.max(1, ...accents.flat().map((a) => a.scale));
      // 縁は左右・上下の両側へ出る
      const w = (glyphEm + padEm * 2) * fontSize;
      const h = (lines.length * maxScale + padEm * 2) * fontSize;
      const rad = Math.abs(st.tiltDeg) * Math.PI / 180;
      const bw = w * Math.cos(rad) + h * Math.sin(rad);
      const bh = w * Math.sin(rad) + h * Math.cos(rad);
      const cx = W / 2, cy = BAND_TOP + BAND_H / 2;
      const top = cy - bh / 2, bottom = cy + bh / 2;
      const left = cx - bw / 2, right = cx + bw / 2;
      worstTop = Math.min(worstTop, top);
      // ★下端も見る。UIに食われるのは下側なので、ここが実務上いちばん効く
      worstBottom = Math.max(worstBottom, bottom);
      worstRight = Math.max(worstRight, right);
      if (left < -0.5 || right > W + 0.5 || top < -0.5 || bottom > SAFE_BOTTOM + 0.5) {
        console.log(` ★はみ出し ${market} ${st.name} 「${t}」 上${top.toFixed(0)} 下${bottom.toFixed(0)} 左${left.toFixed(0)} 右${right.toFixed(0)}`);
        fail++;
      }
    }
  }
}
console.log(fail === 0 ? ` 全 ${n} 通り: 画面内・UIの安全域(下端${SAFE_BOTTOM}px)に収まる` : ` ★${fail}件`);
console.log(`  最も上に来る位置  ${worstTop.toFixed(0)}px = 画面高さの ${(worstTop / H * 100).toFixed(1)}%`);
console.log(`  最も下に来る位置  ${worstBottom.toFixed(0)}px = 画面高さの ${(worstBottom / H * 100).toFixed(1)}%`);
console.log(`  最も右に来る位置  ${worstRight.toFixed(0)}px = 画面幅の ${(worstRight / W * 100).toFixed(1)}%`);

/*
 * ★★2026-09-09 追加（オーナー指示「一列にしましょう」）。
 *   台本側の契約（telop_main2 は4〜9文字）を守った文面が、**必ず一列で
 *   出ること**を数値で確かめる。ここが1件でも2行になったら、実装ではなく
 *   一列の下限（ONE_LINE_MIN_RATIO）か文字数の契約のどちらかが間違っている。
 */
console.log("\n=== 和文は一列で出るか（4〜9文字の契約） ===");
let multi = 0;
for (const st of TELOP_STYLES) {
  for (const t of JA) {
    const n9 = Array.from(t).length;
    if (n9 < 4 || n9 > 9) continue;
    const r = layoutTelop(t, W, BAND_H, st.tiltDeg, "ja", st.outlineRatio);
    if (r.lines.length !== 1) {
      console.log(` ★2行以上 ${st.name} 「${t}」 → ${JSON.stringify(r.lines)}`);
      multi++; fail++;
    }
  }
}
console.log(multi === 0 ? " 契約内(4〜9文字)は全演出で一列" : ` ★${multi}件が一列にならなかった`);
{
  // 契約を外れる長さは、潰れる前に改行へ戻ること（一列を強制しない）
  const long = layoutTelop("これは知らないと損する話", W, BAND_H, 0, "ja", 0.12);
  console.log(` 参考: 12文字「これは知らないと損する話」→ ${long.lines.length}行 ${Math.round(long.fontSize)}px`);
}

console.log("\n=== 演出の割り当てが job_id だけで決まるか（乱数を使っていないこと）===");
const names = (id) => shuffledBySeed(TELOP_STYLES, seedOf(id)).map((x) => x.name.slice(0, 4)).join(" ");
for (const id of ["telop-check6", "telop-check6", "a1b2c3"]) console.log(` ${id.padEnd(14)} ${names(id)}`);
if (names("telop-check6") !== names("telop-check6")) { console.log(" ★揺れている"); fail++; }
const dup = 5 - new Set(shuffledBySeed(TELOP_STYLES, seedOf("telop-check6")).slice(0, 5)).size;
console.log(` 5シーン中の演出の重複: ${dup} 件（${TELOP_STYLES.length}種類から5つ取る）`);
if (dup !== 0) fail++;

console.log("\n=== 異常系 ===");
for (const [t, m] of [["", "ja"], [" ", "ja"], ["あ", "ja"], ["。。。", "ja"],
                      ["あ".repeat(30), "ja"], ["", "en"], ["A", "en"],
                      ["SUPERCALIFRAGILISTICEXPIALIDOCIOUS", "en"]]) {
  const r = layoutTelop(t, W, BAND_H, -7, m);
  const maxScale = Math.max(1, ...r.accents.flat().map((a) => a.scale));
  const h = r.lines.length * r.fontSize * maxScale;
  const okH = h <= BAND_H + 1;
  console.log(` ${m} ${JSON.stringify(t.slice(0, 12)).padEnd(16)} ${JSON.stringify(r.lines).slice(0, 40).padEnd(42)} ${Math.round(r.fontSize)}px ${okH ? "高さOK" : "★高さ超過"}`);
  if (!okH) fail++;
}

console.log(fail === 0 ? "\n合格" : `\n★不合格 ${fail}件`);
process.exit(fail === 0 ? 0 : 1);
