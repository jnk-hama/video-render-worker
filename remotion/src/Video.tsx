import React from "react";
import { AbsoluteFill, Audio, Sequence, useVideoConfig } from "remotion";
import type { VideoScript } from "./types";
import { InSitu } from "./scenes/InSitu";
import { Talk } from "./scenes/Talk";
import { Shot } from "./scenes/Shot";
import { Captions } from "./components/Captions";
import { Disclosure } from "./components/Disclosure";
import { FontFace } from "./lib/fonts";
import { CameraMotionBlur } from "@remotion/motion-blur";

/*
 * シーンの振り分け（ルーティング）。
 *
 * ★LLMは「どの種類のシーンか」だけを決める。演出の中身は決めない。
 *   決めさせると出力が毎回揺れて、同じ台本から違う品質の動画が出る。
 *   確率で揺れる処理を構成に持ち込まない（CLAUDE.md の方針）。
 */
const renderScene = (scene: VideoScript["scenes"][number], accent: string) => {
  switch (scene.kind) {
    case "insitu":
      return <InSitu scene={scene} accent={accent} />;
    case "talk":
      return <Talk scene={scene} accent={accent} />;
    case "shot":
      return <Shot scene={scene} accent={accent} />;
    default:
      return null;
  }
};

export const Video: React.FC<{ script: VideoScript }> = ({ script }) => {
  const { fps } = useVideoConfig();
  const accent = script.accent ?? "#8b5cf6";

  /*
   * モーションブラー（決定#090）。
   *
   * ★**映像だけに掛ける。文字には掛けない。**
   *   字幕がぶれると読めなくなる。ミュート再生で読めない字幕は
   *   無いのと同じなので、ここは絶対に譲らない。
   *
   * ★1フレームを samples 回描いて重ねるので、**描画時間が素直に
   *   samples 倍近くまで増える**。数字は実測して決めること。
   */
  const blur = script.quality?.blurSamples ?? 0;
  const shutter = script.quality?.shutterAngle ?? 180;

  let cursor = 0;
  const sequences = script.scenes.map((scene, i) => {
    const from = cursor;
    const durationInFrames = Math.max(1, Math.round(scene.seconds * fps));
    cursor += durationInFrames;
    const body = renderScene(scene, accent);
    return (
      <Sequence key={i} from={from} durationInFrames={durationInFrames}>
        {blur > 0 ? (
          <CameraMotionBlur shutterAngle={shutter} samples={blur}>
            {body}
          </CameraMotionBlur>
        ) : (
          body
        )}
      </Sequence>
    );
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* ★最初に置く。フォントが当たる前に文字が描かれないように */}
      <FontFace dataUri={script.fontDataUri} />

      {sequences}

      {/* 字幕は全シーンを貫いて出す。シーンの切れ目で消さない */}
      <Captions captions={script.captions} accent={accent} />

      {/* 広告表記は全編。景表法のステマ規制（決定#065） */}
      <Disclosure text={script.disclosure} />

      {script.narrationUrl ? <Audio src={script.narrationUrl} /> : null}
      {script.bgmUrl ? <Audio src={script.bgmUrl} volume={0.2} /> : null}
    </AbsoluteFill>
  );
};

/** 台本から総フレーム数を出す。Composition の calculateMetadata で使う */
export const totalFrames = (script: VideoScript): number =>
  Math.max(
    1,
    script.scenes.reduce(
      (sum, s) => sum + Math.round(s.seconds * script.fps),
      0,
    ),
  );
