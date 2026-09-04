import React from "react";
import { Composition } from "remotion";
import { Video, totalFrames } from "./Video";
import type { VideoScript } from "./types";
import defaultScript from "./sample-script.json";

/*
 * ★寸法・fps・尺は**台本から決める**。ここに固定値を書かない。
 *   固定すると、依頼側が尺を変えても反映されず、音声とズレる。
 */
export const RemotionRoot: React.FC = () => (
  <Composition
    id="Main"
    component={Video as never}
    defaultProps={{ script: defaultScript as unknown as VideoScript }}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={300}
    calculateMetadata={({ props }) => {
      const s = (props as { script: VideoScript }).script;
      return {
        width: s.width,
        height: s.height,
        fps: s.fps,
        durationInFrames: totalFrames(s),
      };
    }}
  />
);
