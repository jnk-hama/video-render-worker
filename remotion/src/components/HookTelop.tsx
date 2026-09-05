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
 * ★同じ穴を二度掘らないため、Video.tsx の一番外側にも JP_FONT を置いた。
 *   以後どこにテキストを足しても既定で日本語が出る。ここは保険。
 *
 * 【参考にした構造】
 * 実際に伸びているTikTok動画3本に共通していたのは次の3点。
 *   ・1文字が画面幅の20〜40%。**とにかく大きい**
 *   ・極太＋太い縁取り。動きではなく**大きさで注意を奪う**
 *   ・右下のUI列（いいね・コメント・シェア）を必ず避けている
 *
 * 【設計】
 * ・行数は1〜3から**一番大きくなる割り方を選ぶ**。文字数で固定しない。
 *   「短文でも伝わるなら短い方が強い」を、そのまま数式にしてある
 * ・縁取りは8方向へずらした黒の複製。`-webkit-text-stroke` は線が字の
 *   内側へ食い込んで細く見える（Captions.tsx で実測済みの結論を踏襲）
 * ・塗りは上が白・下が色のグラデーション、その下に同色の発光を敷く
 * ・色はシーンごとに回す。5シーン全部が同じ色だと画面が単調になる
 * ・明滅はゆっくり（約0.9Hz）。速い点滅にはしない。読みにくいうえ、
 *   TikTokの公式クリエイティブ指針も激しい明滅を勧めていない
 */

/** 文字が占める横幅の割合。ここを上げるほど「殴る」感じになる */
const FILL_RATIO = 0.94;

/** 1文字の上限（画面幅比）。これ以上は1文字で画面が埋まる */
const MAX_FONT_RATIO = 0.4;

/** 4行にすると1文字が小さくなり、殴る力が消える */
const MAX_LINES = 3;

const LINE_HEIGHT = 1.0;

/** 置き始めの高さ（画面高さ比） */
const TOP_RATIO = 0.07;

/** ここより下へは出さない。走る字幕は 0.6 にある */
const BOTTOM_LIMIT_RATIO = 0.56;

/** 縁の太さ（文字サイズ比） */
const OUTLINE_RATIO = 0.075;

/**
 * シーンごとに回す色。
 * ★暗い色は入れない。背景（ストック映像を暗く落としてある）に沈む。
 */
const PALETTE = ["#ffe500", "#00e5ff", "#ff2d95", "#b6ff00", "#ff7a00"];

const OUTLINE_DIRS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/**
 * 指定した行数へ、なるべく均等に割る。
 * ★単語境界を見ない。日本語は分かち書きしないので、文字数だけで割る方が
 *   結果が安定する（形態素解析を持ち込むと確率的な処理が増える）。
 */
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
 * 行を増やすと1行の文字数が減って字は大きくなるが、全体の高さが伸びる。
 * 高さは字幕の手前で頭打ちにするので、そこで自然に止まる。
 * ★純粋関数にしてある。描画せずに数値だけ検証できるようにするため。
 */
export const layoutTelop = (
  text: string,
  width: number,
  maxHeight: number,
): { lines: string[]; fontSize: number } => {
  let best = { lines: [text.trim()], fontSize: 0 };
  for (let n = 1; n <= MAX_LINES; n++) {
    const lines = splitIntoLines(text, n);
    const perLine = Math.max(1, ...lines.map((l) => l.length));
    const fontSize = Math.min(
      (width * FILL_RATIO) / perLine,
      width * MAX_FONT_RATIO,
      maxHeight / (lines.length * LINE_HEIGHT),
    );
    if (fontSize > best.fontSize) best = { lines, fontSize };
  }
  return best;
};

export const HookTelop: React.FC<{
  text: string;
  /** このシーンの長さ（フレーム）。出し終わりを決めるのに使う */
  durationInFrames: number;
  /** シーン番号。色を回すのに使う */
  index: number;
}> = ({ text, durationInFrames, index }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const top = height * TOP_RATIO;
  const { lines, fontSize } = layoutTelop(
    text,
    width,
    height * BOTTOM_LIMIT_RATIO - top,
  );
  const outline = Math.max(2, fontSize * OUTLINE_RATIO);
  const color = PALETTE[index % PALETTE.length];

  /*
   * 出方：バンと出て、わずかに落ち着く。
   * ★跳ね返しすぎない。オーバーシュートが大きいと「テンプレのアニメ」に
   *   見える。大きさで殴るのが主で、動きは補助。
   */
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.5 }, durationInFrames: 10 });
  const scale = interpolate(pop, [0, 1], [1.22, 1]);

  /*
   * ★1本目は前半55%で消していたが、それだと**見ていない時間の方が長い**。
   *   フックは見えていないと意味がないので、シーンのほぼ全部で出す。
   *   最後だけ抜いて、次のシーンの文字と重ならないようにする。
   */
  const holdUntil = Math.round(durationInFrames * 0.86);
  const opacity = interpolate(
    frame,
    [0, 3, holdUntil, holdUntil + 5],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // 発光の強さをゆっくり脈打たせる。速い点滅にはしない
  const pulse = 0.7 + 0.3 * Math.sin((frame / fps) * Math.PI * 2 * 0.9);

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
        top,
        height: lines.length * fontSize * LINE_HEIGHT,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "center top",
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

            {/* 発光：同じ字を色で敷き、外へにじませる */}
            <div
              aria-hidden
              style={{
                ...base,
                color,
                opacity: pulse,
                textShadow:
                  `0 0 ${fontSize * 0.1}px ${color},` +
                  `0 0 ${fontSize * 0.22}px ${color},` +
                  `0 0 ${fontSize * 0.4}px ${color}`,
              }}
            >
              {line}
            </div>

            {/* 塗り：上が白・下が色。白だけより立体に見える */}
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
