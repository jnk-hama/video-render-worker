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
  /*
   * ★★2026-09-05、揺れを弱めた（オーナー指摘「企業PR感が強い」）。
   *   以前は 0.0016 / 0.0013。**速く細かい揺れほど「作り込んだ映像」に見える**。
   *   人がスマホで持っている揺れは、もっと遅くて振幅が小さい。
   *   周期も伸ばした（1.7→1.1 等）。数字を半分にするより、
   *   「遅くする」方がオーガニックに見える。
   */
  return {
    x: amount * (0.0009 * Math.sin(t * 1.1) + 0.0004 * Math.sin(t * 2.7 + 1.1)),
    y: amount * (0.0007 * Math.sin(t * 1.4 + 0.7) + 0.0003 * Math.sin(t * 3.1)),
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
  /*
   * 立ち上がり。カットの頭で「動き出す」ためだけに使う。
   * ★damping を上げて跳ね返りを消す。バウンドは広告の動きで、
   *   一般ユーザーの投稿には出てこない。
   */
  const ease = spring({
    frame,
    fps,
    config: { damping: 200, mass: 0.5, stiffness: 40 },
    durationInFrames: Math.min(durationInFrames, Math.round(fps * 1.6)),
  });

  // 尺全体の進み具合（0→1）
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const shake = handheld(frame, fps);
  const base: CameraState = { zoom: 1, x: shake.x, y: shake.y };

  switch (move) {
    /*
     * ★★2026-09-05、振れ幅を全体に落とした（オーナー指摘）。
     *   push_in を 12% → 7%、pan を ±5% → ±2.8%、orbit を 4.5% → 2.5%。
     *   **動きは「あるかないか分かる程度」で足りる。** 大きく動かすほど
     *   広告に見え、TikTokの画面で浮く。
     *   ゼロにはしない。1枚絵は静止画と判定されて伸びない。
     */
    case "push_in":
      return { ...base, zoom: 1 + 0.07 * (0.2 * ease + 0.8 * p) };
    case "pull_out":
      return { ...base, zoom: 1.07 - 0.07 * (0.2 * ease + 0.8 * p) };
    case "pan_right":
      return { ...base, zoom: 1.05, x: base.x + interpolate(p, [0, 1], [-0.028, 0.028]) };
    case "pan_left":
      return { ...base, zoom: 1.05, x: base.x + interpolate(p, [0, 1], [0.028, -0.028]) };
    case "orbit":
      // 横に振りながらわずかに寄る。視差が最も強く出る動き
      return {
        ...base,
        zoom: 1 + 0.035 * p,
        x: base.x + 0.025 * Math.sin(p * Math.PI),
        y: base.y - 0.007 * Math.sin(p * Math.PI),
      };
    case "hold":
    default:
      // 完全な静止にはしない。1枚絵に見えると離脱する
      return { ...base, zoom: 1 + 0.012 * p };
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
