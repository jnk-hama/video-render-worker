import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { TalkScene } from "../types";
import { handheld, layerTransform, useCameraValue } from "../lib/camera";
import { BACKGROUND_FILTER } from "../lib/look";

/*
 * 口播（talkcraft 相当）。語り手が説明しているシーン。
 *
 * ★立ち絵が無くても成立させる。素材が揃わない回に落ちないため。
 *   その場合は背景＋見出しだけで、カメラだけが動く構成になる。
 */
export const Talk: React.FC<{ scene: TalkScene; accent: string }> = ({ scene, accent }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height } = useVideoConfig();
  const cam = useCameraValue(frame, fps, durationInFrames, scene.camera ?? "push_in");
  const micro = handheld(frame + 17, fps, 0.8);

  const enter = spring({
    frame, fps,
    config: { damping: 28, mass: 0.9, stiffness: 85 },
    durationInFrames: Math.round(fps * 0.7),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#07070b" }}>
      {scene.backgroundUrl ? (
        <AbsoluteFill style={{ transform: layerTransform(cam, 0.8) }}>
          <OffthreadVideo src={scene.backgroundUrl} muted
            style={{
              width: "100%", height: "100%", objectFit: "cover",
              // ★色を戻してから暗くする（決定#114）。数値は lib/look.ts に1つだけ置く
              filter: BACKGROUND_FILTER,
            }} />
        </AbsoluteFill>
      ) : null}

      {/*
        ★★2026-09-09、**中央を明るくした**（決定#114・オーナー指示
          「動画もなるべく派手に購買意欲を高めること」）。
            0.55 → 0.25(40%) → 0.7   から
            0.38 → 0.10(38%) → 0.62  へ。

        ★ここは商品が映らないシーン（1〜2枚目）に使われる。**つまり
          スクロールを止める一番大事な2枚が、一番暗く沈んでいた。**
          実測すると画面下半分の平均輝度は 35/255 しかなく、
          「灰色の部屋」に見えていた。商品を出す InSitu 側は既に
          0.32 → 0.10 → 0.45 と軽く、Talk だけが取り残されていた。

        ★上下は暗いまま残す。上は広告表記、下は走る字幕が乗るので、
          そこが明るいと読めなくなる。**明るくするのは中央だけ。**
      */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.38), rgba(0,0,0,0.10) 38%, rgba(0,0,0,0.62))" }} />

      {scene.speakerUrl ? (
        <AbsoluteFill style={{ transform: layerTransform(cam, 1.2) }}>
          <div style={{
            position: "absolute", left: "50%", bottom: "-2%",
            transform: `translateX(-50%) translate(${micro.x * 90}%, ${micro.y * 90}%)`,
            height: height * 0.62,
            opacity: interpolate(enter, [0, 1], [0, 1]),
            filter: "drop-shadow(0 20px 40px rgba(0,0,0,0.6))",
          }}>
            <Img src={scene.speakerUrl} style={{ height: "100%", width: "auto", display: "block" }} />
          </div>
        </AbsoluteFill>
      ) : null}

      {/* ★文字は字幕（Captions）1本に統一する。上下の二重表示を避ける */}
    </AbsoluteFill>
  );
};
