import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "../types";

/*
 * 字幕。
 *
 * ★ffmpeg版（libass）と同じ設計思想を保つ。
 *   ・強調語だけ色を変える（1枚に1語まで）
 *   ・TikTokのUIを避けた位置に置く（右のアイコン列・下部テロップ）
 *   ・黒縁を付ける。背景がどんな色でも読めるようにするため
 *
 * ★時刻は台本の実測値をそのまま使う。ここで推定しない。
 */
export const Captions: React.FC<{ captions: Caption[]; accent: string }> = ({
  captions,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;

  const current = captions.find((c) => t >= c.start && t < c.end);
  if (!current) return null;

  // 出入りを一瞬だけ柔らかくする。パッと切り替わると読み落とす
  const inP = interpolate(t, [current.start, current.start + 0.12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const parts = current.highlight
    ? current.text.split(current.highlight)
    : [current.text];

  return (
    <div
      style={{
        position: "absolute",
        // TikTokの安全域。右200pxはアイコン列、下は投稿文が重なる
        left: 60,
        right: 200,
        top: height * 0.6,
        textAlign: "center",
        fontFamily: "'Dela Gothic One', sans-serif",
        fontSize: 108,
        lineHeight: 1.2,
        color: "#f4f4f5",
        WebkitTextStroke: "10px #000",
        paintOrder: "stroke fill",
        opacity: inP,
        transform: `translateY(${interpolate(inP, [0, 1], [10, 0])}px)`,
      }}
    >
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 ? (
            <span style={{ color: accent }}>{current.highlight}</span>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
};
