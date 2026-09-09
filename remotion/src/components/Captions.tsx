import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "../types";
import { JP_FONT } from "../lib/fonts";
import { hasJapanese, wrapByWidth } from "./HookTelop";

/*
 * 字幕。
 *
 * ★ffmpeg版（libass）と同じ設計思想を保つ。
 *   ・強調語だけ色を変える（1枚に1語まで）
 *   ・TikTokのUIを避けた位置に置く（右のアイコン列・下部テロップ）
 *   ・太い黒縁を付ける。背景がどんな色でも読めるようにするため
 *
 * ★時刻は台本の実測値をそのまま使う。ここで推定しない。
 */

/*
 * 【黒縁の作り方（実測して直した）】
 * `-webkit-text-stroke` は libass の縁取りほど太くならず、
 * 1本目の描画では細くて背景に負けた。
 *
 * そこで**同じ文字を8方向へずらして黒で敷き、その上に本体を置く**。
 * libassの縁取り（輪郭を膨らませる）と同じ結果になる。
 * text-shadow を8つ重ねる手もあるが、影は太らせると滲む。
 * 複製の方が輪郭が締まる。
 *
 * ★ミュート再生で読めない字幕は、無いのと同じ。ここは太くする。
 */
const OUTLINE_PX = 9;

/*
 * 字幕の置き場所と大きさ。**折り返しの計算と描画で同じ値を使うため定数にする。**
 * ★ここをバラバラに持つと、計算した幅と実際に描く幅がずれて、
 *   「収まるはずの行がブラウザ側でもう一度折り返される」ことが起きる。
 */
const INSET_LEFT = 60;
/** TikTokの右側アイコン列を避ける */
const INSET_RIGHT = 200;
const FONT_SIZE = 108;
const OUTLINE_DIRS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

const Line: React.FC<{
  text: string;
  highlight?: string;
  accent: string;
  outline: boolean;
}> = ({ text, highlight, accent, outline }) => {
  const parts = highlight ? text.split(highlight) : [text];
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 ? (
            // ★縁の層では強調色を使わない。輪郭は一様な黒でないと締まらない
            <span style={{ color: outline ? "#000" : accent }}>{highlight}</span>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
};

export const Captions: React.FC<{
  captions: Caption[];
  accent: string;
  /**
   * 字幕を出してはいけない区間（秒）。巨大テロップが出ている間がこれ。
   *
   * ★★2026-09-09 追加。オーナー指摘「テロップが2個被る事は避けて」。
   *   以前は字幕が全編を貫いて出るため、巨大テロップと**構造上必ず**
   *   重なっていた（そのぶん合成した商品も隠れていた）。
   * ★省略された場合は従来どおり全編で出す。既存の呼び出しを壊さない。
   */
  hideWindows?: { start: number; end: number }[];
  /** "ja" か "en"。書体の実寸表と改行規則の切り替えに使う */
  market?: string;
}> = ({ captions, accent, hideWindows, market = "ja" }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  // ★ここが「被らせない」の実体。巨大テロップの区間なら字幕を描かない
  if ((hideWindows ?? []).some((w) => t >= w.start && t < w.end)) return null;

  const current = captions.find((c) => t >= c.start && t < c.end);
  if (!current) return null;

  /*
   * ★★2026-09-09、**改行を自分で決めるようにした**（決定#115）。
   *
   *   前はブラウザの折り返しに任せていた。**日本語はどこでも折れる**ので、
   *   本番の動画で「罪悪感ヤバいゴ／ミ箱」「スタンド付きな／ら」と
   *   語の途中で切れていた（job 18ccc0cd のフレームで確認）。
   *
   *   ★巨大テロップ側は最初からこれを解いてある（禁則・助詞・文字種の境界）。
   *     **同じ規則を書き直さない。** wrapByWidth をそのまま使う。
   *   ★英語には掛けない。英語はブラウザが空白で折るのが正しく、
   *     和文の規則を当てると単語が割れる。
   */
  const boxWidth = width - INSET_LEFT - INSET_RIGHT;
  const text = hasJapanese(current.text)
    ? wrapByWidth(current.text, boxWidth, FONT_SIZE, market).join("\n")
    : current.text;

  // 出入りを一瞬だけ柔らかくする。パッと切り替わると読み落とす
  const inP = interpolate(t, [current.start, current.start + 0.12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const box: React.CSSProperties = {
    position: "absolute",
    // TikTokの安全域。右200pxはアイコン列、下は投稿文が重なる
    left: INSET_LEFT,
    right: INSET_RIGHT,
    /*
     * ★★2026-09-09、0.60 → 0.64 へ下げた（オーナー指摘
     *   「小テロップを少し下に下げて欲しい」）。
     *
     *   ★下げ幅を4%に留めた理由。実測すると字幕は**2行になる回が多い**
     *     （「夜中にゴミ箱／へ」など）。2行 ＝ 108px × 1.2 × 2 ＝ 259px なので、
     *       0.64 … 上端1229px → 下端1488px＝画面の77.5%
     *       0.68 … 上端1306px → 下端1565px＝画面の81.5%
     *     TikTokは下部にユーザー名と投稿文を重ねる。0.68まで下げると
     *     **2行目がそこへ入る**。「少し下」の指示に対して、読めなくなる所まで
     *     動かすのは目的に反する。
     *
     *   ★TikTokは安全域の具体的な%を公開していないため、77.5%が安全だと
     *     断定はできない。実機に投稿できたら実測して詰め直すこと。
     */
    top: height * 0.64,
    textAlign: "center",
    fontFamily: JP_FONT,
    fontSize: FONT_SIZE,
    lineHeight: 1.2,
    whiteSpace: "pre-wrap",
  };

  return (
    <div
      style={{
        opacity: inP,
        transform: `translateY(${interpolate(inP, [0, 1], [10, 0])}px)`,
      }}
    >
      {/* 縁：8方向へずらした黒の複製 */}
      {OUTLINE_DIRS.map(([dx, dy], i) => (
        <div
          key={i}
          style={{
            ...box,
            color: "#000",
            transform: `translate(${dx * OUTLINE_PX}px, ${dy * OUTLINE_PX}px)`,
          }}
          aria-hidden
        >
          <Line text={text} highlight={current.highlight} accent={accent} outline />
        </div>
      ))}

      {/* 本体 */}
      <div style={{ ...box, color: "#f4f4f5" }}>
        <Line
          text={text}
          highlight={current.highlight}
          accent={accent}
          outline={false}
        />
      </div>
    </div>
  );
};
