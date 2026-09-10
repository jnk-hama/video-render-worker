/*
 * 走る字幕の改行を、**描画せずに数値だけで**検証する。
 *
 * ★実物の HookTelop.tsx / Captions.tsx から関数をそのまま読み込む。
 *   **検査側に計算を書き写さない。** 写した定数が実装とずれて検査が
 *   意味を失った前例がある（決定#112）。
 *
 * 【何を守るか】
 *   1. 語の途中で切らない（本番で「ゴ／ミ箱」「な／ら」と切れていた）
 *   2. 禁則を守る（行頭に小書き仮名・句読点・閉じ括弧を置かない）
 *   3. どの行も箱の幅に収まる（収まらないとブラウザが**もう一度折り返す**）
 *   4. 文字が1つも失われない
 *   5. **2行以内に収まる**（決定#124・オーナー指示「多くて二列に」）
 *   6. 強調語の拡大を幅に織り込む（織り込まないと「計算2行・実際3行」）
 *   7. 巨大テロップと同じ言葉の字幕を出さない（決定#124）
 *
 * 使い方: node scripts/check-caption-wrap.mjs
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/*
 * ★2ファイルから読むので、両方を再輸出する入口を一時的に作って束ねる。
 *   Captions.tsx は react/remotion を参照するが、使うのは純関数だけなので
 *   それらは外部化する（読み込み時に評価されない）。
 */
const entry = path.resolve(`.check-caption-entry.${process.pid}.ts`);
const tmp = path.resolve(`.check-caption.${process.pid}.mjs`);
fs.writeFileSync(
  entry,
  'export * from "./src/components/HookTelop";\n' +
    'export { isDuplicateOfTelop, pickEmphasis, layoutCaption, captionCharEm } from "./src/components/Captions";\n',
);
let mod;
try {
  await esbuild.build({
    entryPoints: [entry],
    outfile: tmp,
    bundle: true,
    format: "esm",
    external: ["react", "remotion", "react/jsx-runtime"],
    loader: { ".tsx": "tsx", ".ts": "ts" },
  });
  mod = await import(pathToFileURL(tmp).href);
} finally {
  fs.rmSync(tmp, { force: true });
  fs.rmSync(entry, { force: true });
}
const { wrapByWidth, advanceEm, layoutCaption, captionCharEm, isDuplicateOfTelop, pickEmphasis } = mod;
for (const [n, f] of Object.entries({
  wrapByWidth, advanceEm, layoutCaption, captionCharEm, isDuplicateOfTelop, pickEmphasis,
})) {
  if (typeof f !== "function") {
    console.error(`★実装から ${n} を取り出せませんでした。検査になっていません`);
    process.exit(1);
  }
}

/*
 * ★Captions.tsx と同じ値。**コピーだが、下でその一致を検査している。**
 */
const W = 1080, INSET_L = 60, INSET_R = 200, FONT = 108, MAX_LINES = 2, MIN_FONT = 74;
const BOX = W - INSET_L - INSET_R;

const capSrc = fs.readFileSync(path.resolve("src/components/Captions.tsx"), "utf8");
let fail = 0;
for (const [name, val] of [
  ["INSET_LEFT", INSET_L], ["INSET_RIGHT", INSET_R], ["FONT_SIZE", FONT],
  ["MAX_LINES", MAX_LINES], ["MIN_FONT_SIZE", MIN_FONT],
]) {
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

/**
 * **実際に描かれる幅**。layoutCaption と同じ1文字幅（字間・強調の拡大込み）で測る。
 * ★ここが箱を超えると、ブラウザが計算とは別に折り返す。3行になった原因はこれ。
 */
const realWidths = (text, emphasis, lines, fontSize) => {
  const em = captionCharEm(text, emphasis, "ja");
  let i = 0;
  return lines.map((l) => {
    let acc = 0;
    for (const ch of Array.from(l)) acc += em(ch, i++) * fontSize;
    return Math.round(acc);
  });
};

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
 * ★★ここからが決定#124の本体。**layoutCaption をそのまま呼ぶ。**
 *
 *   ★これ以前は wrapByWidth だけを検査していたので、
 *     「縮めて2行に入れる」ループも「強調語の拡大」も検査されていなかった。
 *     本番のフレームで初めて3行だと分かった。
 */
console.log("\n=== 2行以内に収まるか（決定#124）===");
{
  /** [字幕, 強調語] — 強調語ありの回は幅が 1.34倍に膨らむ側で検査する */
  const REAL = [
    ["この機能でこの価格は安すぎん", "安すぎん"],
    ["置くだけでゴミを勝手に吸い上げてくれる", undefined],
    ["週末のダラダラ時間が増えた", "ダラダラ"],
    ["正確な値段はプロフに載せといたよ", "プロフ"],
    ["罪悪感ヤバいゴミ箱", "ヤバい"],
    ["ペットの毛が毎日散らばって", undefined],
    ["え、ちょっと待って", "ちょっと"],
    ["夜中にゴミ箱へ", undefined],
    ["短い", undefined],
  ];
  for (const [t, emp] of REAL) {
    const { lines, fontSize } = layoutCaption(t, emp, BOX, "ja");
    const widths = realWidths(t, emp, lines, fontSize);
    console.log(`  ${t}${emp ? `（強調「${emp}」）` : ""}`);
    console.log(`    → ${lines.length}行 ${fontSize}px ${JSON.stringify(lines)} 実寸 ${widths.join("/")}px`);
    ok(lines.length <= MAX_LINES, "   2行以内", `${lines.length}行`);
    ok(
      widths.every((w) => w <= BOX + 0.5),
      "   実寸が箱に収まる（ブラウザが再折返ししない）",
      `最大 ${Math.max(...widths)}px ≤ ${BOX}px`,
    );
    ok(lines.join("") === t, "   文字が欠けない");
    ok(fontSize >= MIN_FONT, "   下限より小さくしない", `${fontSize}px`);
  }
}

/*
 * ★★**2行に収まる長さの上限を測り、依頼側の刻み幅より広いことを確かめる。**
 *
 *   ★「2行以内」は無条件の約束ではない。どこまで守れるかは実測でしか言えない。
 *     ここを測らずに「2行になる」と書くと、長い字幕が来た日に静かに破れる。
 *   ★依頼側（scripts/tts.py の JA_CHARS_PER_CHUNK = 9）は9文字で刻む。
 *     ただし語の途中では切らないので、長い語1つぶんはみ出る。
 *     本番の動画で実測した最長は13文字だった。
 *     余裕を見て**16文字までは必ず2行**であることを守る。
 */
console.log("\n=== 2行を守れる長さの上限（実測）===");
{
  const CONTRACT = 16; // 依頼側は9文字刻み・実測最長13文字。これを上回っていること
  const base = "これ買ったせいで週末のダラダラ時間が増えて困った毎日が続いている";
  const limitOf = (withEmphasis) => {
    let last = 0;
    for (let n = 8; n <= Array.from(base).length; n++) {
      const t = Array.from(base).slice(0, n).join("");
      const emp = withEmphasis && n >= 15 ? Array.from(t).slice(11, 15).join("") : undefined;
      if (layoutCaption(t, emp, BOX, "ja").lines.length > MAX_LINES) break;
      last = n;
    }
    return last;
  };
  const a = limitOf(false);
  const b = limitOf(true);
  console.log(`    強調なし ${a}文字まで2行 / 強調あり ${b}文字まで2行（依頼側の刻みは9文字・実測最長13文字）`);
  ok(a >= CONTRACT, `強調なしで${CONTRACT}文字まで2行`, `${a}文字`);
  ok(b >= CONTRACT, `強調ありで${CONTRACT}文字まで2行`, `${b}文字`);
}

/*
 * ★★**総当りで確かめる。** 手で選んだ例だけでは足りなかった。
 *
 *   決定#124の作業中、例を5つ並べて全部通ったので「2行に収まった」と
 *   判断しかけた。実際は**14文字で3行になる組み合わせがあり**、
 *   ナレーション全文から部分文字列を総当りして初めて出た（44件）。
 *   しかもそれは文字が大きすぎたのではなく、
 *     「手に吸い／上げてくれる／ステーシ」＝ 313/470/313px（箱は820px）
 *   と**割り方が悪い**だけだった（→ splitTwoLines を足した）。
 *
 *   ★手で選んだ例は、自分が思いつく壊れ方しか含まない。
 */
console.log("\n=== 総当り（実際のナレーションの部分文字列すべて）===");
{
  const CORPUS = [
    "夜中にゴミ箱へ捨てに行くのが本当に面倒で罪悪感がヤバい毎日だった",
    "置くだけでゴミを勝手に吸い上げてくれるステーションが付いている",
    "ペットの毛が毎日散らばって掃除機をかける時間が週末に消えていく",
    "この機能でこの価格は安すぎんと思って二度見したので貼っておくよ",
    "正確な値段はプロフに載せといたから気になる人は見てみてほしいな",
  ];
  const MAX_CHARS = 16; // 依頼側は9文字刻み・本番の実測最長13文字。余裕を見て16
  let tested = 0, over = null, overflow = null, lost = null, minFont = Infinity;
  for (const c of CORPUS) {
    const ch = Array.from(c);
    for (let s = 0; s < ch.length; s++) {
      for (let n = 4; n <= MAX_CHARS && s + n <= ch.length; n++) {
        const txt = ch.slice(s, s + n).join("");
        // 強調語は「無し・2文字・4文字・6文字」、位置も端と中央で振る
        for (const [off, len] of [[-1, 0], [0, 2], [Math.max(0, n - 4), 4], [Math.floor(n / 2) - 1, 6]]) {
          const emp = off >= 0 && off + len <= n ? ch.slice(s + off, s + off + len).join("") : undefined;
          const r = layoutCaption(txt, emp, BOX, "ja");
          tested++;
          minFont = Math.min(minFont, r.fontSize);
          if (!lost && r.lines.join("") !== txt) lost = { txt, emp, r };
          if (!over && r.lines.length > MAX_LINES) over = { txt, emp, r };
          if (!overflow && realWidths(txt, emp, r.lines, r.fontSize).some((x) => x > BOX + 0.5)) {
            overflow = { txt, emp, r };
          }
        }
      }
    }
  }
  const show = (v) => `「${v.txt}」強調「${v.emp ?? "-"}」→ ${JSON.stringify(v.r.lines)} ${v.r.fontSize}px`;
  console.log(`    ${tested}通り（4〜${MAX_CHARS}文字 × 強調0/2/4/6文字）／最小の文字 ${minFont}px`);
  ok(!over, `全て${MAX_LINES}行以内`, over ? show(over) : "");
  ok(!overflow, "全て箱に収まる", overflow ? show(overflow) : "");
  ok(!lost, "文字が1つも欠けない", lost ? show(lost) : "");
}

/*
 * ★★**強調語が行をまたいでいないか**（決定#124）。
 *
 *   Captions の Line は `text.split(強調語)` で色と大きさを付ける。
 *   行の間に "\n" が入って語が割れると**当たらないので何も付かない**。
 *   絵で1枚だけ色が付いていないのに気付いて、総当りで数えたら
 *     強調2文字 10.8% / 3文字 24.1% / 4文字 39.4%
 *   が行をまたいでいた。「目立たせる」機能が4回に1回黙って消えていた。
 *
 *   ★依頼側の telop_emphasis は**4文字まで**（process-job の Zod と
 *     normalizeTelops で切り詰め済み）。守るべきはこの範囲。
 */
console.log("\n=== 強調語が行をまたがないか（決定#124）===");
{
  const CORPUS = [
    "夜中にゴミ箱へ捨てに行くのが本当に面倒で罪悪感がヤバい毎日だった",
    "置くだけでゴミを勝手に吸い上げてくれるステーションが付いている",
    "この機能でこの価格は安すぎんと思って二度見したので貼っておくよ",
    "正確な値段はプロフに載せといたから気になる人は見てみてほしいな",
  ];
  const LIMIT_PCT = 5; // 実測2.3%。語が1行に入らない回は諦めるので0にはならない
  for (const L of [2, 3, 4]) {
    let split = 0, tested = 0, ex = null;
    for (const c of CORPUS) {
      const ch = Array.from(c);
      for (let s = 0; s < ch.length; s++) {
        for (let n = 6; n <= 16 && s + n <= ch.length; n++) {
          const txt = ch.slice(s, s + n).join("");
          for (let off = 0; off + L <= n; off++) {
            const emp = Array.from(txt).slice(off, off + L).join("");
            if (txt.indexOf(emp) !== off) continue; // 同じ語が2回出る回は数えない
            const r = layoutCaption(txt, emp, BOX, "ja");
            tested++;
            if (!r.lines.some((l) => l.includes(emp))) {
              split++;
              if (!ex) ex = { txt, emp, r };
            }
          }
        }
      }
    }
    const pct = (split / tested) * 100;
    ok(
      pct <= LIMIT_PCT,
      `強調${L}文字が行をまたぐのは${LIMIT_PCT}%以下`,
      `${split}/${tested} = ${pct.toFixed(1)}%` +
        (ex ? `  例「${ex.txt}」/「${ex.emp}」→ ${JSON.stringify(ex.r.lines)}` : ""),
    );
  }
}

console.log("\n=== 強調語の拡大を幅に織り込んでいるか ===");
{
  // 同じ字幕を、強調ありと無しで測る。ありの方が必ず広い
  const t = "この機能でこの価格は安すぎん";
  const a = layoutCaption(t, undefined, BOX, "ja");
  const b = layoutCaption(t, "安すぎん", BOX, "ja");
  const wa = Math.max(...realWidths(t, undefined, a.lines, a.fontSize));
  const wb = Math.max(...realWidths(t, "安すぎん", b.lines, b.fontSize));
  console.log(`    強調なし ${a.lines.length}行 ${a.fontSize}px 最大${wa}px / 強調あり ${b.lines.length}行 ${b.fontSize}px 最大${wb}px`);
  ok(wb !== wa || b.lines.length !== a.lines.length, "強調の有無で結果が変わる（幅に効いている）");
}

console.log("\n=== 同じ言葉を2回見せない（決定#124）===");
ok(isDuplicateOfTelop("この機能でこの価格は安すぎん", ["安すぎん？"]), "テロップが字幕に含まれる → 出さない");
ok(isDuplicateOfTelop("安すぎん", ["この機能でこの価格は安すぎん？"]), "字幕がテロップに含まれる → 出さない");
ok(!isDuplicateOfTelop("正確な値段はプロフに", ["安すぎん？"]), "無関係なら出す");
ok(!isDuplicateOfTelop("", ["安すぎん？"]), "空文字を落とさない");
ok(!isDuplicateOfTelop("あ", []), "テロップ無しなら出す");

console.log("\n=== 強調語の選び方 ===");
ok(pickEmphasis("この価格は安すぎん", undefined, ["安すぎん"]) === "安すぎん", "含まれる語を選ぶ");
ok(pickEmphasis("この価格は安すぎん", undefined, ["爆速"]) === undefined, "含まれない語は選ばない");
ok(pickEmphasis("この価格は安すぎん", undefined, ["安", "安すぎん"]) === "安すぎん", "長い方を選ぶ");
ok(pickEmphasis("この価格は安すぎん", "価格", ["安すぎん"]) === "価格", "台本の指定が優先");

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
  // 下限まで縮めても入らない長さ。**切り捨てず**に出すのが正しい
  const long = "あ".repeat(60);
  const r = layoutCaption(long, undefined, BOX, "ja");
  ok(r.lines.join("") === long, "60文字でも欠けない", `${r.lines.length}行 ${r.fontSize}px`);
  ok(r.fontSize === MIN_FONT, "下限で止まる", `${r.fontSize}px`);
}
{
  const r = layoutCaption("Hello world", undefined, BOX, "en");
  ok(r.lines.length === 1 && r.lines[0] === "Hello world", "英語は折り返さない（ブラウザに任せる）");
}
{
  // 句読点だけ：禁則で切れないので1行のまま出るのが正しい
  const lines = wrapByWidth("。。。。。。。。。。", BOX, FONT, "ja");
  ok(lines.join("") === "。。。。。。。。。。", "句読点だけでも欠けない", JSON.stringify(lines));
}

console.log("\n=== 揺れないこと ===");
{
  const runs = new Set(
    Array.from({ length: 20 }, () =>
      JSON.stringify(layoutCaption(CASES[4], "ダラダラ", BOX, "ja"))),
  );
  ok(runs.size === 1, "20回とも同じ", [...runs][0]);
}

console.log(fail === 0 ? "\n合格" : `\n★不合格 ${fail}件`);
process.exit(fail === 0 ? 0 : 1);
