import React from "react";
import { AbsoluteFill, Audio, Sequence, useVideoConfig } from "remotion";
import type { VideoScript } from "./types";
import {
  HookTelop,
  PALETTE_FOR_TELOP,
  TELOP_STYLES,
  seedOf,
  shuffledBySeed,
} from "./components/HookTelop";
import { InSitu } from "./scenes/InSitu";
import { Talk } from "./scenes/Talk";
import { Shot } from "./scenes/Shot";
import { Captions } from "./components/Captions";
import { Disclosure } from "./components/Disclosure";
import { FontFace, JP_FONT } from "./lib/fonts";
import { CameraMotionBlur } from "@remotion/motion-blur";

/*
 * シーンの振り分け（ルーティング）。
 *
 * ★LLMは「どの種類のシーンか」だけを決める。演出の中身は決めない。
 *   決めさせると出力が毎回揺れて、同じ台本から違う品質の動画が出る。
 *   確率で揺れる処理を構成に持ち込まない（CLAUDE.md の方針）。
 */
/**
 * 効果音の基本音量。
 *
 * ★2026-09-05: 0.35 → 0.5（オーナー「気づかなかった」）
 * ★2026-09-06: 0.5 → 0.7（オーナー「効果音だけ強めて」）
 *   音源はピーク -6dB なので、実効ピークは約 -9dB。ナレーション(1.0)の
 *   1/3弱。**ここが上限に近い。** これ以上上げると、シーン頭に置いている
 *   都合でナレーションの語頭と competing になる（BGMを0.2に絞っているのと
 *   同じ理由）。次に上げたくなったら、音量ではなく
 *   「効果音の瞬間だけBGMを下げる（ダッキング）」を先に試すこと。
 */
const SFX_VOLUME = 0.7;

/**
 * タグごとの補正。**ピークを揃えても鋭い音ほどうるさく聞こえる。**
 * 実測（mean/peak）: shock -20.3/-5.6dB、fire -12.8/-6.0dB、
 * pop -12.4/-6.0dB、neon -14.1/-5.9dB、clean -13.3/-6.0dB。
 * 平均とピークの差が大きいものほど耳に刺さるので、そこだけ下げる。
 */
const SFX_TAG_GAIN: Record<string, number> = {
  shock: 0.7, // ノイズヒット。平均とピークの差が14.7dBで一番耳に刺さる
  fire: 0.9, // 低い衝撃音。ブーミーになりやすい
  chord: 1.1, // ★フックを立てる音。ここは前に出す
  boom: 1.1, // ★同上
};

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
  /*
   * 巨大テロップの演出・色を、**job_id から決める**（2026-09-05）。
   *
   * ★乱数は使わない。同じjobを描き直すと前と違う動画が出てしまい、
   *   検証ができなくなる（描き直しは設計された経路。E-017）。
   *   CLAUDE.md の「確率で出力が揺れる処理を構成に持ち込まない」に従う。
   * ★並べ替えなので、5シーンなら5種類が1回ずつ出る。
   *   同じ演出・同じ色が隣り合わない。
   */
  const seed = seedOf(script.jobId ?? "");
  const telopStyles = shuffledBySeed(TELOP_STYLES, seed);
  const telopColors = shuffledBySeed(PALETTE_FOR_TELOP, seed ^ 0x9e3779b9);

  const blur = script.quality?.blurSamples ?? 0;
  const shutter = script.quality?.shutterAngle ?? 180;

  let cursor = 0;
  const sequences = script.scenes.map((scene, i) => {
    const from = cursor;
    const durationInFrames = Math.max(1, Math.round(scene.seconds * fps));
    cursor += durationInFrames;
    const body = renderScene(scene, accent);
    const telop = (script.hookTelops ?? [])[i];
    return (
      <Sequence key={i} from={from} durationInFrames={durationInFrames}>
        {blur > 0 ? (
          <CameraMotionBlur shutterAngle={shutter} samples={blur}>
            {body}
          </CameraMotionBlur>
        ) : (
          body
        )}
        {/*
          ★巨大テロップは**ブラーの外**に置く。
            文字がぶれると読めない。ミュート再生で読めない文字は
            無いのと同じ（字幕と同じ理由。ここは譲らない）。
        */}
        {telop ? (
          <HookTelop
            text={telop}
            durationInFrames={durationInFrames}
            style={telopStyles[i % telopStyles.length]}
            color={telopColors[i % telopColors.length]}
            market={script.market ?? "ja"}
          />
        ) : null}
      </Sequence>
    );
  });

  return (
    /*
     * ★★2026-09-05、**一番外側に書体を置いた。**
     *   巨大テロップが1本目で何も描かれなかった原因は、その要素に
     *   fontFamily を書き忘れたことだった。描画コンテナには
     *   fonts-dejavu-core しか入っておらず、日本語のグリフが1つも無い。
     *   ここに置いておけば、以後どこにテキストを足しても既定で日本語が出る。
     *   （各コンポーネント側の指定は残す。これは保険）
     */
    <AbsoluteFill style={{ backgroundColor: "#000", fontFamily: JP_FONT }}>
      {/* ★最初に置く。フォントが当たる前に文字が描かれないように */}
      <FontFace dataUri={script.fontDataUri} />

      {sequences}

      {/* 字幕は全シーンを貫いて出す。シーンの切れ目で消さない */}
      <Captions captions={script.captions} accent={accent} />

      {/* 広告表記は全編。景表法のステマ規制（決定#065） */}
      <Disclosure text={script.disclosure} />

      {script.narrationUrl ? <Audio src={script.narrationUrl} /> : null}
      {script.bgmUrl ? <Audio src={script.bgmUrl} volume={0.2} /> : null}

      {/*
        効果音（2026-09-05）。
        ★★音量を 0.35 → 0.5 へ上げた（オーナー確認「気づかなかった」）。
          実測すると埋もれて当然だった:
            ・音源はピーク -6dB に揃えてある（=フルスケールの半分）
            ・そこへ0.35を掛けるので、実効ピークは約 -15dB
            ・1つ 0.13〜0.63秒しかなく、その上にナレーション(1.0)と
              BGM(0.2)が乗る
          0.5にすると実効ピークは約 -12dB。ナレーションの1/4程度で、
          「聞こえるが主張しない」範囲。**これ以上は上げない。**
        ★タグごとに補正を掛ける。ピークを揃えても**鋭い音ほどうるさく
          聞こえる**ため（shock はノイズヒットで平均 -20.3dB なのに
          ピークは -5.6dB。差が大きいほど耳に刺さる）。
        ★Sequence で置く。at は「全体の尺に対する割合」で渡ってくるので、
          総フレーム数を掛けてフレームへ直す。**秒を依頼側に推定させない**
          という設計（依頼側はTTSの尺を知らない）をそのまま守る。
      */}
      {(script.sfx ?? []).map((cue, i) => (
        <Sequence
          key={`sfx-${i}`}
          from={Math.round(cue.atRatio * totalFrames(script))}
          name={`sfx:${cue.tag}`}
        >
          <Audio src={cue.src} volume={SFX_VOLUME * (SFX_TAG_GAIN[cue.tag] ?? 1)} />
        </Sequence>
      ))}
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
