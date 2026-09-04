import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { InSituScene } from "../types";
import { handheld, layerTransform, useCameraValue } from "../lib/camera";

/*
 * ============================================================
 * 没入型デモ（In-Situ）— この方式の中核
 * ============================================================
 *
 * 「実環境の背景動画」の上に「透過した製品」を置き、**同じカメラで**
 * 両方を動かす。白い枠も下敷きも置かない。
 *
 * 【“貼り付けた感”は4つの手がかりで生まれる。全部潰す】
 *
 *  1. 視差が無い    … 背景と製品が同じ量だけ動くと、書き割りに見える。
 *                     → 1つのカメラ値から depth 違いで導く（camera.ts）
 *  2. 接地していない … 影が無いと宙に浮く。地面との接触影を敷く
 *  3. 光が合わない  … 背景は夕方なのに製品だけ白色光だと即座に分かる。
 *                     → 背景の色を薄く製品へ乗せる（ambient）
 *  4. 動きが硬い    … 完全静止か等速だと機械に見える。
 *                     → 手持ちの微振動 ＋ spring の立ち上がり
 *
 * 【なぜ枠を付けないか】
 * 枠を付けた瞬間「広告バナー」に見え、TikTokの画面で浮く。
 * 枠は権利上の都合を見た目に持ち込む行為で、視聴体験には何も足さない。
 */

export const InSitu: React.FC<{ scene: InSituScene; accent: string }> = ({
  scene,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  const cam = useCameraValue(frame, fps, durationInFrames, scene.camera ?? "orbit");

  /*
   * 奥行きの割り当て。
   *   背景 0.85 … カメラより奥。動きは控えめ
   *   製品 1.25 … カメラより手前。同じカメラでも大きく動く
   * 差（0.40）が視差の強さ。0.6を超えると「浮いて滑る」ので上げない。
   */
  const BG_DEPTH = 0.85;
  const FG_DEPTH = 1.25;

  const heightRatio = scene.heightRatio ?? 0.42;
  const yRatio = scene.yRatio ?? 0.58;
  const ambient = scene.ambient ?? 0.25;

  // 製品の登場。下からわずかに持ち上げて置く（置かれた感）
  const enter = spring({
    frame,
    fps,
    config: { damping: 26, mass: 0.9, stiffness: 90 },
    durationInFrames: Math.round(fps * 0.9),
  });
  const enterY = interpolate(enter, [0, 1], [26, 0]);
  const enterOpacity = interpolate(enter, [0, 0.35, 1], [0, 1, 1]);

  // 製品だけの微振動。背景の揺れと位相をずらすと「別の物体」に見える
  const micro = handheld(frame + 41, fps, 0.6);

  const productH = height * heightRatio;
  // 接地影は製品の真下。寄るほど濃く・小さくなる（距離が縮むと影が締まる）
  const shadowW = productH * 0.62 * (1 / cam.zoom);
  const shadowOpacity = interpolate(cam.zoom, [1, 1.15], [0.42, 0.55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      {/* ---------- 背景：実際の使用環境 ---------- */}
      <AbsoluteFill
        style={{
          transform: layerTransform(cam, BG_DEPTH),
          // scale で縁が出ないよう、最初から少し大きく描く
          willChange: "transform",
        }}
      >
        <OffthreadVideo
          src={scene.backgroundUrl}
          muted
          // ★背景の音は使わない。ナレーションとBGMだけで作る
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      {/*
        背景を少しだけ沈める。製品と字幕を浮かせるため。
        ★ぼかさない。#066の実測で、読みやすさに効いていたのは
          「暗くすること」で、ぼかしはほぼ効いていなかった。
          日本市場の映像は背景そのものが主役なので、ぼかすと台無しになる。
      */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.18) 38%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      {/* ---------- 接地影：製品が「床にある」ための手がかり ---------- */}
      <AbsoluteFill
        style={{
          transform: layerTransform(cam, FG_DEPTH),
          willChange: "transform",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: `${yRatio * 100}%`,
            transform: `translate(-50%, ${productH / 2 - 6}px) translateX(${
              micro.x * 100
            }%)`,
            width: shadowW,
            height: shadowW * 0.19,
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse at center, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0) 72%)",
            opacity: shadowOpacity * enterOpacity,
            filter: "blur(10px)",
          }}
        />
      </AbsoluteFill>

      {/* ---------- 製品：透過PNGをそのまま置く ---------- */}
      <AbsoluteFill
        style={{
          transform: layerTransform(cam, FG_DEPTH),
          willChange: "transform",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: `${yRatio * 100}%`,
            transform: `translate(-50%, -50%) translate(${micro.x * 120}%, ${
              micro.y * 120 + enterY / 10
            }%)`,
            height: productH,
            opacity: enterOpacity,
            // 落ち影。接地影とは別に、製品自身の輪郭から出る影
            filter: `drop-shadow(0 ${productH * 0.03}px ${
              productH * 0.05
            }px rgba(0,0,0,0.55))`,
          }}
        >
          <Img
            src={scene.productUrl}
            style={{ height: "100%", width: "auto", display: "block" }}
          />
          {/*
            環境光をなじませる層。
            製品の形（アルファ）に沿って背景の色を薄く乗せる。
            mix-blend-mode を使い、製品の外側へは絶対にはみ出さない。
            ★ここを省くと「照明の違う写真を貼った」ように見える。
          */}
          {ambient > 0 ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `linear-gradient(160deg, ${accent}00 0%, ${accent}FF 100%)`,
                opacity: ambient,
                mixBlendMode: "overlay",
                // 製品の形で切り抜く。CSSマスクにPNGのアルファを使う
                WebkitMaskImage: `url(${scene.productUrl})`,
                maskImage: `url(${scene.productUrl})`,
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
          ) : null}
        </div>
      </AbsoluteFill>

      {/* ---------- 文字：製品の上に重ねない ---------- */}
      {scene.headline ? (
        <div
          style={{
            position: "absolute",
            left: 60,
            right: 60,
            top: `${Math.max(0.08, yRatio - heightRatio / 2 - 0.16) * 100}%`,
            textAlign: "center",
            color: "#fff",
            fontFamily: "'Dela Gothic One', sans-serif",
            fontSize: 76,
            lineHeight: 1.15,
            textShadow: "0 4px 18px rgba(0,0,0,0.85)",
            opacity: interpolate(frame, [0, Math.round(fps * 0.4)], [0, 1], {
              extrapolateRight: "clamp",
            }),
          }}
        >
          {scene.headline}
        </div>
      ) : null}

      {scene.label ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${Math.min(0.9, yRatio + heightRatio / 2 + 0.06) * 100}%`,
            textAlign: "center",
            color: accent,
            fontFamily: "'Dela Gothic One', sans-serif",
            fontSize: 38,
            letterSpacing: 2,
            textShadow: "0 3px 12px rgba(0,0,0,0.9)",
          }}
        >
          {scene.label}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
