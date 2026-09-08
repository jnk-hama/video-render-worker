import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "../types";
import { JP_FONT } from "../lib/fonts";

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
}> = ({ captions, accent, hideWindows }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;

  // ★ここが「被らせない」の実体。巨大テロップの区間なら字幕を描かない
  if ((hideWindows ?? []).some((w) => t >= w.start && t < w.end)) return null;

  const current = captions.find((c) => t >= c.start && t < c.end);
  if (!current) return null;

  // 出入りを一瞬だけ柔らかくする。パッと切り替わると読み落とす
  const inP = interpolate(t, [current.start, current.start + 0.12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const box: React.CSSProperties = {
    position: "absolute",
    // TikTokの安全域。右200pxはアイコン列、下は投稿文が重なる
    left: 60,
    right: 200,
    top: height * 0.6,
    textAlign: "center",
    fontFamily: JP_FONT,
    fontSize: 108,
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
          <Line text={current.text} highlight={current.highlight} accent={accent} outline />
        </div>
      ))}

      {/* 本体 */}
      <div style={{ ...box, color: "#f4f4f5" }}>
        <Line
          text={current.text}
          highlight={current.highlight}
          accent={accent}
          outline={false}
        />
      </div>
    </div>
  );
};
