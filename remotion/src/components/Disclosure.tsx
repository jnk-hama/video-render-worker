import React from "react";
import { useVideoConfig } from "remotion";
import { JP_FONT } from "../lib/fonts";

/*
 * 広告表記（決定#065）。
 * ★全編に出す。途中で消さない。消える表記は表記していないのと同じ。
 * ★TikTokの上部UIと重ならない高さに置く（実測で y=0.105 に決めた）。
 */
export const Disclosure: React.FC<{ text: string }> = ({ text }) => {
  const { height } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: height * 0.105,
        textAlign: "center",
        fontFamily: JP_FONT,
        fontSize: 30,
        color: "#ffffff",
        opacity: 0.92,
        textShadow: "0 2px 8px rgba(0,0,0,0.95)",
      }}
    >
      {text}
    </div>
  );
};
