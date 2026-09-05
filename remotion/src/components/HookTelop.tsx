import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { JP_FONT } from "../lib/fonts";

/*
 * 巨大テロップ（2026-09-05）。
 *
 * 【1本目が「一切大きくなっていない」と言われた原因（確認済）】
 * **書体を指定していなかった。**
 * 実行#62のログには「巨大テロップ 5枚」が出ており、データは描画側まで
 * 届いていた。にもかかわらず画面には何も出なかった。
 *
 *   Captions.tsx   … fontFamily: JP_FONT を指定 → 出ていた
 *   Disclosure.tsx … fontFamily: JP_FONT を指定 → 出ていた
 *   HookTelop.tsx  … **指定なし** → 出なかった
 *
 * 描画コンテナに入れているフォントは `fonts-dejavu-core` だけで、
 * これはラテン文字しか持たない。同梱の Dela Gothic One は data URI で
 * `JmasJP` として差し込んでいるので、**その名前を書いた要素にしか当たらない**。
 * 書き忘れた要素は日本語のグリフを1つも持たない書体へ落ちる。
 *
 * 【演出をシーンごとに変える（2026-09-05・オーナー指示）】
 * 「全部が全部同じにしなくてもいい。ナナメ＋ゆっくり光る、点滅＋強め縁取り、
 *   みたいに散らすと面白い」
 *
 * ★**乱数は使わない。** job_id から決める。
 *   CLAUDE.md の「確率で出力が揺れる処理を構成に持ち込まない」に従う。
 *   乱数にすると、同じjobを描き直した時に前と違う動画が出て検証できない
 *   （描き直しは設計された経路。E-017 を参照）。
 *   job_id を種にして**5つの演出を並べ替える**方式にした。結果:
 *     ・動画ごとに並びが変わる
 *     ・同じ動画は何度描いても1フレームも変わらない
 *     ・5シーンなら5種類が必ず1回ずつ出る（同じ演出が隣り合わない）
 *
 * 【傾けた時に画面からはみ出さないこと】
 * 傾けると外接する箱が横にも縦にも広がる。文字サイズを決める式に
 * 回転を織り込んであるので、**傾ける演出だけ自動的に少し小さくなる**。
 * 目分量で「たぶん入る」にしない。
 */

/** 文字の外側に残す余白（画面幅比）。回転後の箱がここに収まる */
const WIDTH_MARGIN = 0.96;

/** 1文字の上限（画面幅比）。これ以上は1文字で画面が埋まる */
const MAX_FONT_RATIO = 0.4;

/*
 * ★行数は1〜3。4行にすると1文字が小さくなり、殴る力が消える。
 *   下の候補の作り方（1行・2行・3行のみ列挙）がこの上限そのもの。
 */
const LINE_HEIGHT = 1.0;

/** 置ける帯（画面高さ比）。走る字幕は 0.6 にある */
const BAND_TOP_RATIO = 0.07;
const BAND_BOTTOM_RATIO = 0.56;

/**
 * 1文字の横幅の見積り（em）。
 * ★和文は全角なのでほぼ 1.0。ASCIIは半分弱。letterSpacing -0.03em を引く。
 *   実測ではなく見積りなので、上の WIDTH_MARGIN で余白を持たせてある。
 */
const advanceEm = (ch: string): number =>
  (ch.charCodeAt(0) < 0x100 ? 0.58 : 1.0) - 0.03;

/**
 * シーンごとに回す色。
 * ★暗い色は入れない。背景（ストック映像を暗く落としてある）に沈む。
 */
export const PALETTE_FOR_TELOP = ["#ffe500", "#00e5ff", "#ff2d95", "#b6ff00", "#ff7a00"];

/** 演出。5つを job_id で並べ替えて割り当てる */
export type TelopStyle = {
  name: string;
  /** 傾き（度）。0で水平 */
  tiltDeg: number;
  /** 光り方 */
  glow: "slow" | "steady" | "blink";
  /** 縁の太さ（文字サイズ比） */
  outlineRatio: number;
  /** 出だしの拡大率。1.0で拡大なし */
  popFrom: number;
  /** 出だしに上から落とす量（文字サイズ比）。0で落とさない */
  dropRatio: number;
};

export const TELOP_STYLES: TelopStyle[] = [
  { name: "ナナメ・ゆっくり光る", tiltDeg: -7, glow: "slow", outlineRatio: 0.075, popFrom: 1.18, dropRatio: 0 },
  { name: "点滅・極太縁", tiltDeg: 0, glow: "blink", outlineRatio: 0.11, popFrom: 1.25, dropRatio: 0 },
  { name: "逆ナナメ・常時発光", tiltDeg: 6, glow: "steady", outlineRatio: 0.075, popFrom: 1.12, dropRatio: 0 },
  { name: "落下・中発光", tiltDeg: -3, glow: "slow", outlineRatio: 0.09, popFrom: 1.0, dropRatio: 0.5 },
  { name: "直立・強発光・太縁", tiltDeg: 0, glow: "steady", outlineRatio: 0.105, popFrom: 1.3, dropRatio: 0 },
];

const OUTLINE_DIRS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** 文字列から32bitの数を作る（FNV-1a）。乱数の代わりの種 */
export const seedOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * 種から決まる並べ替え。**同じ種なら必ず同じ並び**。
 * ★Math.random() を使わない。描き直しで動画が変わってはいけない。
 */
export const shuffledBySeed = <T,>(arr: T[], seed: number): T[] => {
  const a = arr.slice();
  let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
};

/*
 * 【改行位置（2026-09-05・オーナー指示「キリの良い改行もしてな」）】
 *
 * 前の版は**文字数で機械的に割っていた**ので
 *   神ツール → 「神ツ／ール」   熱意ある人材 → 「熱意あ／る人材」
 * のように語の途中で切れていた。
 *
 * ★形態素解析は入れない。CLAUDE.md の「確率で出力が揺れる処理を構成に
 *   持ち込まない」に反するうえ、辞書を抱えると描画が重くなる。
 *   代わりに、**印刷物の禁則処理と同じ決定論的な規則**だけで判定する。
 *     1. 禁則（行頭・行末に置いてはいけない文字）は必ず弾く
 *     2. 助詞の直後は語の切れ目 → 良い改行
 *     3. 文字種の境界（漢字↔ひらがな↔カタカナ↔英数）も語の切れ目 → 良い改行
 *     4. 行頭が助詞になる切り方は避ける
 *   同じ文字種の途中で切るのは「悪い改行」として点を下げるだけで、
 *   禁止はしない。**大きさの利得が十分あれば許す**（1.67倍以上）。
 */

/** この文字で行を**始めない**（行頭禁則）。小書き仮名・長音・閉じ括弧・句読点 */
const NO_LINE_START =
  "、。，．,.・:：;；?？!！ー―‐〜～)）]］}｝」』】〉》>'’\"”%‰℃" +
  "ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞヽヾ";

/** この文字で行を**終えない**（行末禁則）。開き括弧 */
const NO_LINE_END = "(（[［{｛「『【〈《<“‘";

/**
 * 1文字の助詞。この直後は切れ目、この直前は切れ目でない。
 * ★か・ね・よ・や（終助詞）は**入れない**。語の中に頻繁に出るため
 *   誤判定する（「静か」の「か」を助詞と読んで「静か｜すぎる」が
 *   正解に見えていた。**たまたま当たっていただけ**なので外した）。
 */
const PARTICLES = "がのをにへとでもは";

/**
 * この文字列で始まるなら、その手前は語の切れ目。
 * ★辞書ではなく**閉じた短い一覧**。形態素解析は入れない方針のまま、
 *   助詞でも文字種の境界でもない切れ目（接尾語・助動詞）だけを拾う。
 *   増やす時は「語の途中に現れないか」を確かめてから足すこと。
 */
const SUFFIX_STARTS = ["すぎる", "すぎ", "そう", "ない", "たい", "ます", "れる"];

/** 悪い改行の減点。1.0/この値 = 1.67倍。これ未満の利得なら悪い改行はしない */
const POOR_BREAK = 0.6;

type CharClass = "kanji" | "kana" | "kata" | "ascii" | "other";

const classOf = (ch: string): CharClass => {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x100) return "ascii";
  if (c >= 0x3040 && c <= 0x309f) return "kana";
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9f)) return "kata";
  if ((c >= 0x4e00 && c <= 0x9fff) || c === 0x3005) return "kanji";
  return "other";
};

/**
 * 位置 i（i文字目の前）で改行した時の良さ。0なら禁則で切れない。
 * ★純粋関数。描画せずに数値だけで検証できるようにするため。
 */
export const breakQuality = (chars: string[], i: number): number => {
  const a = chars[i - 1];
  const b = chars[i];
  if (NO_LINE_START.includes(b)) return 0; // 行頭禁則
  if (NO_LINE_END.includes(a)) return 0; // 行末禁則
  if (PARTICLES.includes(b)) return 0.5; // 行頭が助詞になる切り方は避ける
  if (PARTICLES.includes(a)) return 1; // 助詞の直後は語の切れ目
  const rest = chars.slice(i).join("");
  if (SUFFIX_STARTS.some((w) => rest.startsWith(w))) return 1; // 接尾語の手前
  const ca = classOf(a);
  const cb = classOf(b);
  if (ca !== cb) {
    /*
     * ★漢字→ひらがな は**送り仮名の可能性がある**ので下げる。
     *   「戻れない」を「戻｜れない」、「死んだ」を「死｜んだ」と切ると
     *   語が割れる。逆向き（ひらがな→漢字）は新しい語の始まりなので満点。
     */
    return cb === "kana" ? 0.75 : 1;
  }
  return POOR_BREAK; // 同じ文字種の途中
};

/** 改行位置の配列から行へ切り出す */
const sliceAt = (chars: string[], breaks: number[]): string[] => {
  const out: string[] = [];
  let prev = 0;
  for (const b of [...breaks, chars.length]) {
    out.push(chars.slice(prev, b).join(""));
    prev = b;
  }
  return out;
};

/**
 * この行割りで入る最大の文字サイズ。傾きを織り込む。
 *
 *   横: (幅em·cosθ + 行数·行高·sinθ) · fontSize ≤ 画面幅 · 余白
 *   縦: (幅em·sinθ + 行数·行高·cosθ) · fontSize ≤ 置ける帯の高さ
 *   上限: fontSize ≤ 画面幅 · MAX_FONT_RATIO
 */
const fitFontSize = (
  lines: string[],
  width: number,
  bandHeight: number,
  cos: number,
  sin: number,
): number => {
  const em = Math.max(
    0.5,
    ...lines.map((l) => Array.from(l).reduce((s, c) => s + advanceEm(c), 0)),
  );
  const tall = lines.length * LINE_HEIGHT;
  return Math.min(
    (width * WIDTH_MARGIN) / (em * cos + tall * sin),
    bandHeight / (em * sin + tall * cos),
    width * MAX_FONT_RATIO,
  );
};

/**
 * 改行位置を**総当たりで**決める。
 *
 * 1〜3行のすべての切り方（15文字でも200通り未満）について
 *   点数 = 入る文字サイズ × 改行の良さの積
 * を出し、一番高いものを採る。同点なら行数の少ない方（先に試す方）。
 *
 * ★総当たりにしたのは、貪欲法だと「1つ目の改行を良い位置に取ったせいで
 *   2つ目が語の途中になる」が起きるため。候補が少ないので全部見てよい。
 * ★純粋関数にしてある。描画せずに数値だけで検証できるようにするため。
 */
export const layoutTelop = (
  text: string,
  width: number,
  bandHeight: number,
  tiltDeg: number,
): { lines: string[]; fontSize: number } => {
  const chars = Array.from(text.trim());
  const n = chars.length;
  if (!n) return { lines: [""], fontSize: 0 };

  const rad = (Math.abs(tiltDeg) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // 1行、2行、3行の順に候補を並べる（同点なら行数の少ない方が残る）
  const candidates: number[][] = [[]];
  for (let i = 1; i < n; i++) candidates.push([i]);
  for (let i = 1; i < n; i++) {
    for (let j = i + 1; j < n; j++) candidates.push([i, j]);
  }

  let best = { lines: [chars.join("")], fontSize: 0, score: -1 };
  for (const breaks of candidates) {
    let quality = 1;
    for (const b of breaks) quality *= breakQuality(chars, b);
    if (quality === 0) continue; // 禁則

    const lines = sliceAt(chars, breaks);
    /*
     * ★1文字だけの行は、**漢字・カタカナ・英数のときだけ許す。**
     *
     *   「神／ツール」の「神」は1文字でも語なので良い。
     *   「も／う戻れ／ない」の「も」は語ではない。
     *
     *   単独のひらがな1文字は、ほぼ助詞か送り仮名の断片である。
     *   助詞の誤判定（「もう」の「も」を助詞と読む等）が作る切り方は、
     *   この1行で全部落ちる。全体が1文字の時は1行の候補が残る。
     */
    if (
      lines.length > 1 &&
      lines.some((l) => {
        const cs = Array.from(l);
        return cs.length === 1 && (classOf(cs[0]) === "kana" || classOf(cs[0]) === "other");
      })
    ) {
      continue;
    }

    const fontSize = fitFontSize(lines, width, bandHeight, cos, sin);
    const score = fontSize * quality;
    if (score > best.score) best = { lines, fontSize, score };
  }
  return { lines: best.lines, fontSize: best.fontSize };
};

export const HookTelop: React.FC<{
  text: string;
  /** このシーンの長さ（フレーム）。出し終わりを決めるのに使う */
  durationInFrames: number;
  /** この回の演出。Video.tsx が job_id から決めて渡す */
  style: TelopStyle;
  /** この回の色。Video.tsx が job_id から決めて渡す */
  color: string;
}> = ({ text, durationInFrames, style, color }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const bandTop = height * BAND_TOP_RATIO;
  const bandHeight = height * BAND_BOTTOM_RATIO - bandTop;
  const { lines, fontSize } = layoutTelop(text, width, bandHeight, style.tiltDeg);
  const blockHeight = lines.length * fontSize * LINE_HEIGHT;
  const outline = Math.max(2, fontSize * style.outlineRatio);

  /*
   * 出方：バンと出て、わずかに落ち着く。
   * ★跳ね返しすぎない。オーバーシュートが大きいと「テンプレのアニメ」に
   *   見える。大きさで殴るのが主で、動きは補助。
   */
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.5 }, durationInFrames: 10 });
  const scale = interpolate(pop, [0, 1], [style.popFrom, 1]);
  const dropY = interpolate(pop, [0, 1], [-style.dropRatio * fontSize, 0]);

  /*
   * ★1本目は前半55%で消していたが、それだと**見ていない時間の方が長い**。
   *   フックは見えていないと意味がないので、シーンのほぼ全部で出す。
   */
  const holdUntil = Math.round(durationInFrames * 0.86);
  const opacity = interpolate(
    frame,
    [0, 3, holdUntil, holdUntil + 5],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  /*
   * 光り方。
   * ★**点滅させるのは発光の層だけで、文字の塗りは常に出したまま。**
   *   字そのものを消すと、その瞬間は読めない。ミュート再生で読めない
   *   文字は無いのと同じ（字幕と同じ理由。ここは譲らない）。
   *   激しい明滅を避けるのはTikTokの公式クリエイティブ指針にも沿う。
   */
  const t = frame / fps;
  const halo =
    style.glow === "steady"
      ? 1
      : style.glow === "blink"
        ? Math.sin(t * Math.PI * 2 * 2.2) > 0 ? 1 : 0.35
        : 0.7 + 0.3 * Math.sin(t * Math.PI * 2 * 0.6);

  /*
   * ★各行を「絶対位置」で置く。通常の流し込みに任せない。
   *   縁取りの複製を8枚重ねる都合上、流し込みだと高さが崩れる。
   *   位置を全部こちらで決めれば、どのフレームでも同じ場所に出る。
   */
  const common: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    margin: 0,
    fontFamily: JP_FONT, // ★ここを書き忘れて1本目は何も出なかった
    fontSize,
    lineHeight: LINE_HEIGHT,
    fontWeight: 400, // Dela Gothic One は単一ウェイト。上げても太くならない
    letterSpacing: "-0.03em",
    whiteSpace: "pre",
    textAlign: "center",
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // ★帯の中央に置く。回転は中心まわりなので、これで上下とも帯に収まる
        top: bandTop + (bandHeight - blockHeight) / 2,
        height: blockHeight,
        opacity,
        transform: `translateY(${dropY}px) rotate(${style.tiltDeg}deg) scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      {lines.map((line, i) => {
        const base = { ...common, top: i * fontSize * LINE_HEIGHT };
        return (
          <React.Fragment key={i}>
            {/* 縁：8方向へずらした黒の複製（Captions.tsx と同じ方式） */}
            {OUTLINE_DIRS.map(([dx, dy], k) => (
              <div
                key={k}
                aria-hidden
                style={{
                  ...base,
                  color: "#000",
                  transform: `translate(${dx * outline}px, ${dy * outline}px)`,
                }}
              >
                {line}
              </div>
            ))}

            {/* 発光：同じ字を色で敷き、外へにじませる。ここだけ点滅する */}
            <div
              aria-hidden
              style={{
                ...base,
                color,
                opacity: halo,
                textShadow:
                  `0 0 ${fontSize * 0.1}px ${color},` +
                  `0 0 ${fontSize * 0.22}px ${color},` +
                  `0 0 ${fontSize * 0.4}px ${color}`,
              }}
            >
              {line}
            </div>

            {/* 塗り：上が白・下が色。常に出したまま（点滅させない） */}
            <div
              style={{
                ...base,
                backgroundImage: `linear-gradient(180deg, #fff 0%, #fff 38%, ${color} 100%)`,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              {line}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
