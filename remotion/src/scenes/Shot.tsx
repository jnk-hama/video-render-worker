import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { ShotScene } from "../types";
import { layerTransform, useCameraValue } from "../lib/camera";

/*
 * 製品デモ（shotcraft 相当）。UI・スクリーンショットを運鏡で見せる。
 *
 * ★2.5Dにする。平面をわずかに傾け、カメラで回り込むと、
 *   同じ1枚の画像でも「物」として見える。真正面のまま拡大すると
 *   スライドショーになり、最後まで見られない。
 */
export const Shot: React.FC<{ scene: ShotScene; accent: string }> = ({ scene, accent }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height } = useVideoConfig();
  const cam = useCameraValue(frame, fps, durationInFrames, scene.camera ?? "push_in");

  const enter = spring({
    frame, fps,
    config: { damping: 30, mass: 1, stiffness: 80 },
    durationInFrames: Math.round(fps * 0.8),
  });
  // 傾きを浅く戻しながら入る。0度に着地させない（真正面は平面に見える）
  const rotY = interpolate(enter, [0, 1], [16, 6]);
  const rotX = interpolate(enter, [0, 1], [8, 3]);

  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 35%, #1a1a24 0%, #08080c 70%)` }}>
      <AbsoluteFill style={{ perspective: 1400, transform: layerTransform(cam, 1.1) }}>
        <div
          style={{
            position: "absolute", left: "50%", top: "46%",
            transform: `translate(-50%,-50%) rotateY(${rotY}deg) rotateX(${rotX}deg)`,
            transformStyle: "preserve-3d",
            height: height * 0.5,
            filter: `drop-shadow(0 40px 60px rgba(0,0,0,0.7)) drop-shadow(0 0 90px ${accent}55)`,
            opacity: interpolate(enter, [0, 0.4, 1], [0, 1, 1]),
          }}
        >
          <Img src={scene.shotUrl} style={{ height: "100%", width: "auto", display: "block", borderRadius: 18 }} />
        </div>
      </AbsoluteFill>

      {scene.headline ? (
        <div style={{
          position: "absolute", left: 60, right: 60, top: height * 0.14,
          textAlign: "center", color: "#fff",
          fontFamily: "'Dela Gothic One', sans-serif", fontSize: 82, lineHeight: 1.12,
          textShadow: "0 4px 18px rgba(0,0,0,0.8)",
        }}>{scene.headline}</div>
      ) : null}
    </AbsoluteFill>
  );
};
