import { interpolate, spring } from "remotion";
import type { CameraMove } from "../types";

/*
 * 運鏡（カメラワーク）。
 *
 * 【この層が存在する理由】
 * 「背景を動かす」「製品を動かす」を別々に書くと、必ずズレて
 * “合成しました”という絵になる。**1つのカメラ値から両方を導く**のが肝心。
 * 実空間では、カメラが動けば近い物ほど大きく動く（視差）。この関係を
 * 壊さない限り、脳は「同じ空間にある」と受け取る。
 */

export type CameraState = {
  /** 基準の拡大率。1.0 で等倍 */
  zoom: number;
  /** 画面幅に対する横移動（-1〜1） */
  x: number;
  /** 画面高に対する縦移動（-1〜1） */
  y: number;
};

/**
 * 決定論的な微振動（手持ちカメラの揺れ）。
 *
 * ★Math.random は使わない。Remotion はフレームを並列に描くので、
 *   同じフレームが常に同じ値にならないと**チラつく**。
 *   周期の違う正弦波を足して、繰り返しに見えない揺れを作る。
 */
export const handheld = (frame: number, fps: number, amount = 1): { x: number; y: number } => {
  const t = frame / fps;
  return {
    x: amount * (0.0016 * Math.sin(t * 1.7) + 0.0009 * Math.sin(t * 4.3 + 1.1)),
    y: amount * (0.0013 * Math.sin(t * 2.1 + 0.7) + 0.0007 * Math.sin(t * 5.1)),
  };
};

/**
 * シーンの尺全体をかけて動くカメラ。
 *
 * ★spring で入って interpolate で流す。spring だけだと最初に加速して
 *   すぐ止まり、残りが静止画になる。逆に linear だけだと機械的に見える。
 */
export const useCameraValue = (
  frame: number,
  fps: number,
  durationInFrames: number,
  move: CameraMove = "push_in",
): CameraState => {
  // 立ち上がり。カットの頭で「動き出す」ためだけに使う
  const ease = spring({
    frame,
    fps,
    config: { damping: 200, mass: 0.6, stiffness: 60 },
    durationInFrames: Math.min(durationInFrames, Math.round(fps * 1.2)),
  });

  // 尺全体の進み具合（0→1）
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const shake = handheld(frame, fps);
  const base: CameraState = { zoom: 1, x: shake.x, y: shake.y };

  switch (move) {
    case "push_in":
      // 1.00 → 1.12。10%強が「寄っている」と分かる下限（実測で決めた）
      return { ...base, zoom: 1 + 0.12 * (0.25 * ease + 0.75 * p) };
    case "pull_out":
      return { ...base, zoom: 1.12 - 0.12 * (0.25 * ease + 0.75 * p) };
    case "pan_right":
      return { ...base, zoom: 1.08, x: base.x + interpolate(p, [0, 1], [-0.05, 0.05]) };
    case "pan_left":
      return { ...base, zoom: 1.08, x: base.x + interpolate(p, [0, 1], [0.05, -0.05]) };
    case "orbit":
      // 横に振りながらわずかに寄る。視差が最も強く出る動き
      return {
        ...base,
        zoom: 1 + 0.06 * p,
        x: base.x + 0.045 * Math.sin(p * Math.PI),
        y: base.y - 0.012 * Math.sin(p * Math.PI),
      };
    case "hold":
    default:
      // 完全な静止にはしない。1枚絵に見えると離脱する
      return { ...base, zoom: 1 + 0.015 * p };
  }
};

/**
 * カメラ値を、ある「奥行き」のレイヤーの CSS transform へ変換する。
 *
 * depth: 0 = 無限遠（動かない） / 1 = カメラ基準面 / 1.5 = 手前
 * 手前のものほど大きく動く。これが視差（パララックス）。
 */
export const layerTransform = (cam: CameraState, depth: number): string => {
  const zoom = 1 + (cam.zoom - 1) * depth;
  const tx = cam.x * depth * 100;
  const ty = cam.y * depth * 100;
  return `translate3d(${tx.toFixed(3)}%, ${ty.toFixed(3)}%, 0) scale(${zoom.toFixed(4)})`;
};
