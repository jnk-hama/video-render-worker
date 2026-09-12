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
import { FeatureChips } from "./components/FeatureChips";
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

  /*
   * ★★2026-09-09、巨大テロップの出し方を変えた（オーナー指摘）。
   *
   *   > 大テロップはもっとも強いフックであって、下のテロップで喋ってる時は
   *   > 出さなくていい。出しすぎると商品見えないし、ただうざいだけ。
   *   > テロップが2個被る事は避けて。
   *
   *   【何が問題だったか】
   *   巨大テロップはシーンの尺いっぱい（`durationInFrames`）出していた。
   *   走る字幕は全編を貫いて出る。つまり**構造上、必ず両方が同時に出る**。
   *   実際の動画では、合成した商品が上下のテロップに挟まれて見えなかった。
   *
   *   【どう変えたか】
   *   巨大テロップは**シーン頭の1.4秒だけ**の一撃にする。その間は
   *   走る字幕を出さない（下の hideCaptionWindows）。
   *   これで「1.4秒 テロップだけ → 残り 字幕だけ＋商品が見える」になり、
   *   2つが画面上で重なる瞬間が無くなる。
   */
  /*
   * ★★2026-09-10、1.4秒 → 2.2秒（オーナー指示
   *   「強調したいならもう少し長めにテロップは置いておいた方が良さそう」）。
   *
   *   ★1.4秒では**読み終える前に消える**。出入りのアニメーション（spring）に
   *     前後 0.3秒ずつ使うので、静止して読める時間は実質 0.8秒しかなかった。
   *   ★2.2秒で止める理由。この区間は**字幕を出さない**（決定#108）ので、
   *     伸ばすほどナレーションに字幕が付かない時間が増える。シーンは実測で
   *     3秒前後なので 2.2秒だと残り 0.8秒。これ以上伸ばすと
   *     「テロップのあるシーンには字幕が1枚も出ない」ことになり、
   *     ミュート再生で内容が追えなくなる。
   */
  const TELOP_BURST_SEC = 2.2;

  /**
   * テロップがシーンを覆い尽くさないよう、**字幕のために必ず残す秒数**（決定#128）。
   *
   * ★0.9秒 の根拠：字幕は1枚あたり最短でこのくらい出ないと読めない
   *   （依頼側は9文字で刻む）。これ未満しか残らないなら、
   *   そもそも字幕を出す価値が無いので、テロップを削ってでもここを空ける。
   */
  const TELOP_MIN_CAPTION_SEC = 0.9;

  /** 巨大テロップが出ている区間（秒・動画全体の絶対時刻）。字幕はここを避ける */
  const hideCaptionWindows: { start: number; end: number }[] = [];

  let cursor = 0;
  const sequences = script.scenes.map((scene, i) => {
    const from = cursor;
    const durationInFrames = Math.max(1, Math.round(scene.seconds * fps));
    cursor += durationInFrames;
    const body = renderScene(scene, accent);
    const telop = (script.hookTelops ?? [])[i];

    /*
     * ★シーンがバーストより短い回は、シーンの尺で頭打ちにする。
     *   そうしないと次のシーンへ食い込み、字幕を止める区間もずれる。
     *
     * ★★2026-09-10、**字幕のぶんを必ず残す**（決定#128）。
     *
     *   テロップを2.2秒へ伸ばした直後、ナレーションの無音を切って尺が
     *   縮んだ（16.6秒→10.9秒）。1シーンが 10.88/5 ＝ 2.18秒 になり、
     *   **2.2秒のテロップがシーンを丸ごと覆って、字幕が1枚も出なくなった。**
     *   実際に1シーン目と5シーン目が字幕ゼロで描き上がった。
     *   ★とくに5シーン目は「値段はプロフに」＝行動を促す一文である。
     *     ミュートで見ている人にそれが読めないのは、動画の目的を失う。
     *
     *   テロップは「殴る一撃」だが、**字幕を消してよいという意味ではない**。
     *   シーンが短い回はテロップの方を削る。
     */
    const tailFrames = Math.round(TELOP_MIN_CAPTION_SEC * fps);
    const burstFrames = Math.max(
      1,
      Math.min(
        Math.round(TELOP_BURST_SEC * fps),
        Math.max(1, durationInFrames - tailFrames),
      ),
    );

    if (telop) {
      /*
       * ★秒ではなくフレームから戻して計算する。
       *   秒のまま足すと丸め誤差で1フレームだけ字幕と重なることがある。
       *   実際に出る絵はフレーム単位なので、フレームを正とする。
       */
      hideCaptionWindows.push({ start: from / fps, end: (from + burstFrames) / fps });
    }

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
          // ★入れ子の Sequence で**本当に消す**。opacity を0にするだけだと
          //   要素は残り、将来の変更で再び被る余地を残してしまう。
          <Sequence from={0} durationInFrames={burstFrames}>
            <HookTelop
              text={telop}
              durationInFrames={burstFrames}
              style={telopStyles[i % telopStyles.length]}
              color={telopColors[i % telopColors.length]}
              market={script.market ?? "ja"}
            />
          </Sequence>
        ) : null}
        {/*
          機能紹介（2026-09-12）。**巨大テロップの後ろから**出す。
          ★テロップと同時に出さない。オーナーの「テロップが2個被る事は
            避けて」（決定#108）は、文字の層が増えても同じく守る。
            telop が無いシーンは burstFrames を待たずに頭から出す。
        */}
        {(scene.features ?? []).length > 0 ? (
          <Sequence from={telop ? burstFrames : 0}>
            <FeatureChips
              features={scene.features ?? []}
              accent={accent}
              market={script.market ?? "ja"}
            />
          </Sequence>
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

      {/*
        字幕は全シーンを貫いて出す。シーンの切れ目で消さない。
        ★ただし巨大テロップが出ている区間だけは出さない（決定#108）。
          2つのテロップを同時に出さない、という約束はここで守る。
      */}
      <Captions
        captions={script.captions}
        accent={accent}
        hideWindows={hideCaptionWindows}
        market={script.market ?? "ja"}
        highlightWords={script.highlightWords ?? []}
        /*
          ★巨大テロップで出した文言は、字幕で**もう一度出さない**（決定#124）。
            オーナー指摘：ナレーション「この機能でこの価格は安すぎん？」に対し、
            テロップ「安すぎん？」と字幕「この機能でこの価格は安すぎん」の
            両方が出ていた。同じ言葉を2回見せている。
        */
        suppressTexts={(script.hookTelops ?? []).filter(Boolean) as string[]}
      />

      {/* 広告表記は全編。景表法のステマ規制（決定#065） */}
      <Disclosure text={script.disclosure} />

      {script.narrationUrl ? <Audio src={script.narrationUrl} /> : null}
      {/*
        ★★2026-09-12、0.2 → 0.30（決定#132・オーナー指摘「テンション上がる曲に」）。
          曲を勢いのある方へ変えても、0.2 では**ほとんど聞こえない**。
          ナレーションが主役なので上げすぎないが、0.2は「鳴っているのが
          分かる」水準にも届いていなかった。
        ★0.30で止める理由：これ以上はナレーションの子音を食い始める。
          効果音（0.5前後）とナレーションの間に収める。
      */}
      {script.bgmUrl ? <Audio src={script.bgmUrl} volume={0.30} /> : null}

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
