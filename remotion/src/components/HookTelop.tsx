import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/*
 * 巨大テロップ（2026-09-05）。
 *
 * 【なぜ作ったか】
 * `telop_main2` は台本生成の時点で毎回書かれているのに、**描画側へ一度も
 * 渡っていなかった**。走る字幕しか出ておらず、実際に伸びている動画にある
 * 「画面を殴るような大きい文字」が、うちの動画には存在しなかった。
 *
 * 【参考にした構造】
 * 実際のTikTok動画3本を見て、共通しているのは次の3点だった。
 *   ・1文字が画面幅の20〜35%。**とにかく大きい**
 *   ・極太＋太い縁取り。動きではなく**大きさで注意を奪う**
 *   ・右下のUI列（いいね・コメント・シェア）を必ず避けている
 * 色は本質ではない。**派手さと大きさ**が効いている。
 *
 * 【設計】
 * ・文字数から逆算してサイズを決める。短いほど大きくなる
 *   （短文でも伝わるなら短い方が強い、という考え方をそのまま数式にする）
 * ・最大2行。3行にすると1文字が小さくなり、殴る力が消える
 * ・上寄せに置く。走る字幕は 0.6 にあるので重ならず、
 *   TikTokの右下UIとも当たらない
 * ・シーンの前半だけ出す。出しっぱなしにすると背景も商品も見えない
 */

/** 縁取りの太さ（画面幅に対する割合）。参考画像はどれもかなり太い */
const STROKE_RATIO = 0.016;

/** 文字が占める横幅。ここを上げるほど「殴る」感じになる */
const FILL_RATIO = 0.88;

/** 1文字が大きくなりすぎると1文字だけで画面が埋まるので上限を置く */
const MAX_FONT_RATIO = 0.30;
const MIN_FONT_RATIO = 0.085;

/**
 * 2行以内に、なるべく均等に割る。
 * ★単語境界を見ない。日本語は分かち書きしないので、文字数だけで割る方が
 *   結果が安定する（形態素解析を持ち込むと確率的な処理が増える）。
 */
export const splitIntoLines = (text: string): string[] => {
  const t = text.trim();
  if (t.length <= 4) return [t];
  const half = Math.ceil(t.length / 2);
  return [t.slice(0, half), t.slice(half)];
};

export const HookTelop: React.FC<{
  text: string;
  /** このシーンの長さ（フレーム）。前半だけ出すために使う */
  durationInFrames: number;
  accent: string;
}> = ({ text, durationInFrames, accent }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const lines = splitIntoLines(text);
  const maxChars = Math.max(1, ...lines.map((l) => l.length));

  // 文字数から逆算する。短いほど大きい
  const fontSize = Math.min(
    width * MAX_FONT_RATIO,
    Math.max(width * MIN_FONT_RATIO, (width * FILL_RATIO) / maxChars),
  );
  const stroke = width * STROKE_RATIO;

  /*
   * 出方：バンと出て、わずかに落ち着く。
   * ★跳ね返しすぎない。オーバーシュートが大きいと「テンプレのアニメ」に
   *   見える。大きさで殴るのが主で、動きは補助。
   */
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.5 }, durationInFrames: 12 });
  const scale = interpolate(pop, [0, 1], [1.18, 1]);

  // シーンの前半だけ出す。出しっぱなしにすると背景も商品も見えない
  const holdUntil = Math.round(durationInFrames * 0.55);
  const opacity = interpolate(
    frame,
    [0, 4, holdUntil, holdUntil + 8],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const common: React.CSSProperties = {
    margin: 0,
    fontSize,
    lineHeight: 1.02,
    fontWeight: 400, // Dela Gothic One は単一ウェイト。ここを上げても太くならない
    letterSpacing: "-0.02em",
    whiteSpace: "pre",
    textAlign: "center",
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // 上寄せ。走る字幕(0.6)とも、TikTokの右下UIとも当たらない
        top: height * 0.12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "center top",
      }}
    >
      {lines.map((line, i) => (
        <div key={i} style={{ position: "relative" }}>
          {/*
            縁取りは**下に敷く**。-webkit-text-stroke を本体に掛けると
            線が字の内側へ食い込んで細く見えるため、太い線を後ろに置いて
            その上に塗りを重ねる。参考画像の縁の太さはこの方式でないと出ない。
          */}
          <p
            style={{
              ...common,
              WebkitTextStroke: `${stroke}px #000`,
              color: "#000",
              // 発光。色そのものより「浮いて見えること」が効く
              filter: `drop-shadow(0 0 ${stroke * 1.6}px ${accent})`,
            }}
          >
            {line}
          </p>
          <p style={{ ...common, position: "absolute", inset: 0, color: "#fff" }}>
            {line}
          </p>
        </div>
      ))}
    </div>
  );
};
