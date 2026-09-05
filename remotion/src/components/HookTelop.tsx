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

/** 4行にすると1文字が小さくなり、殴る力が消える */
const MAX_LINES = 3;

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

/** 指定した行数へ、なるべく均等に割る（日本語は分かち書きしないので文字数で割る） */
export const splitIntoLines = (text: string, lines: number): string[] => {
  const t = text.trim();
  const per = Math.max(1, Math.ceil(t.length / lines));
  const out: string[] = [];
  for (let i = 0; i < t.length; i += per) out.push(t.slice(i, i + per));
  return out.length ? out : [t];
};

/**
 * 1〜3行のうち、**一番文字が大きくなる割り方**を選ぶ。
 *
 * 行を増やすと1行の文字数が減って字は大きくなるが、全体が縦に伸びる。
 * さらに傾けると外接する箱が縦横に広がる。3つの制約を同時に満たす
 * 最大値を、行数ごとに解いて一番大きいものを採る。
 *
 *   横: (幅em·cosθ + 行数·行高·sinθ) · fontSize ≤ 画面幅 · 余白
 *   縦: (幅em·sinθ + 行数·行高·cosθ) · fontSize ≤ 置ける帯の高さ
 *   上限: fontSize ≤ 画面幅 · MAX_FONT_RATIO
 *
 * ★純粋関数にしてある。描画せずに数値だけで検証できるようにするため。
 */
export const layoutTelop = (
  text: string,
  width: number,
  bandHeight: number,
  tiltDeg: number,
): { lines: string[]; fontSize: number } => {
  const rad = (Math.abs(tiltDeg) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  let best = { lines: [text.trim()], fontSize: 0 };
  for (let n = 1; n <= MAX_LINES; n++) {
    const lines = splitIntoLines(text, n);
    const em = Math.max(
      0.5,
      ...lines.map((l) => Array.from(l).reduce((s, c) => s + advanceEm(c), 0)),
    );
    const tall = lines.length * LINE_HEIGHT;
    const fontSize = Math.min(
      (width * WIDTH_MARGIN) / (em * cos + tall * sin),
      bandHeight / (em * sin + tall * cos),
      width * MAX_FONT_RATIO,
    );
    if (fontSize > best.fontSize) best = { lines, fontSize };
  }
  return best;
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
