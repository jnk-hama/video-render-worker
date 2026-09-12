import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { JP_FONT } from "../lib/fonts";
import { TRACKING_EM, advanceEm } from "./HookTelop";

/*
 * ============================================================
 * 機能紹介（スペックチップ）— 2026-09-12、オーナー指示
 * ============================================================
 *
 *   > 商品をただ出せばいいだけじゃない！（中略）機能の紹介もしたい！
 *   > 合成や機能情報の添付は、これはこちらでも問題ないと確認済みです。
 *
 * 【何を出すか — ナレーションと重ねない】
 * ★★ここに出すのは **数値と仕様だけ**。「吸引力 5000Pa」「静音 55dB」。
 *   ナレーションは体験（困りごと→楽になった）を語り、
 *   チップは数字を見せる。**役割を分ける。**
 *
 *   同じ言葉を2箇所に出すと、同じ尺で伝わる情報量が半分になる
 *   （決定#124でテロップと字幕の二重表示を潰したのと同じ理屈）。
 *   だからここに「毛がごっそり取れる」のような**言い換えを入れてはいけない**。
 *   ナレーションが喋らない情報だけを置く。
 *
 * 【どこに出すか】
 * 画面の上寄り（0.19〜）。下は字幕（0.64〜）、上は広告表記（0.105）。
 * 巨大テロップ（0.16〜0.62）とは**時間で**分ける。呼び出し側が
 * バーストの後ろから Sequence で入れるので、ここでは時刻を持たない。
 *
 * 【なぜ枠付きのピルにするか】
 * 実写の背景の上に白文字を置くと、明るい床で読めなくなる。
 * 縁取りだけだと数字（英数字）が潰れる。**下敷きを敷くのが確実**。
 * 字幕（縁取り）と見た目を変えることで、別の情報だと一目で分かる。
 */

/** 1画面に出す上限。4つ以上は読み切れないし、商品が隠れる */
export const MAX_FEATURES = 3;

/** 1枚あたりの出現をずらす秒数。同時に出すと「表」に見えて読み飛ばされる */
const STAGGER_SEC = 0.26;

export const FONT_SIZE = 46;

/**
 * これ以上は縮めない。26pxは1080幅の画面で読める下限
 * （字幕の下限74pxよりずっと小さいが、チップは補助情報なので許す）。
 */
export const MIN_FONT_SIZE = 26;

/** 左の余白。右にも同じだけ空ける */
const INSET = 56;

/** 文字以外に食う横幅（左の色帯9 + 内側の余白20/30 + チェックとの間18） */
const CHROME_PX = 9 + 20 + 30 + 18;

/** チェック記号の大きさ（フォントサイズに対する比） */
const CHECK_SCALE = 0.92;

const TOP_RATIO = 0.19;

/**
 * 文字列の幅（em）。
 * ★字面の実測表（advanceEm）を使う。見積りで書くと外れる
 *   ―― HookTelop で「ASCIIは0.58em」と見積って35%外した前例がある。
 * ★advanceEm は letterSpacing -0.03em を織り込んだ値を返す。
 *   チップは字間を詰めないので、その分を足し戻す。
 */
export const chipTextEm = (text: string, market: string): number =>
  Array.from(text).reduce((w, ch) => w + advanceEm(ch, market) + TRACKING_EM, 0);

/**
 * 画面からはみ出さない文字サイズを返す。
 *
 * ★★はみ出したら**縮める**。切り詰めない。
 *   途中で切ると「吸引力 5000P」のように数字が欠け、
 *   仕様の誤表示になる。読めれば小さくてよい。
 */
export const fitChipFontSize = (text: string, market: string, screenWidth: number): number => {
  const room = screenWidth - INSET * 2 - CHROME_PX;
  const em = chipTextEm(text, market) + CHECK_SCALE;
  if (em <= 0) return FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(FONT_SIZE, room / em));
};

export const FeatureChips: React.FC<{
  features: string[];
  accent: string;
  market?: string;
}> = ({ features, accent, market = "ja" }) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();
  const items = features.filter((f) => f && f.trim()).slice(0, MAX_FEATURES);
  if (items.length === 0) return null;

  /*
   * ★行の高さは**一番大きいチップ**で揃える。1枚ずつ縮めた高さで
   *   積むと、行間がばらついて雑に見える。
   */
  const sizes = items.map((t) => fitChipFontSize(t, market, width));
  const rowHeight = Math.max(...sizes) * 1.86;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {items.map((text, i) => {
        const fontSize = sizes[i];
        const delay = Math.round(i * STAGGER_SEC * fps);
        /*
         * ★damping を高くして跳ねさせない。跳ねる動きは「広告」に見える
         *   （InSitu の製品登場と同じ判断）。
         */
        const enter = spring({
          frame: frame - delay,
          fps,
          config: { damping: 200, mass: 0.6, stiffness: 90 },
          durationInFrames: Math.round(fps * 0.5),
        });
        const x = interpolate(enter, [0, 1], [-90, 0]);

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: INSET,
              top: height * TOP_RATIO + i * rowHeight,
              display: "flex",
              alignItems: "center",
              gap: 18,
              padding: "12px 30px 12px 20px",
              borderRadius: 16,
              // 左に太い色帯。これがあると背景が何色でも「情報」として立つ
              borderLeft: `9px solid ${accent}`,
              background: "rgba(8,8,12,0.76)",
              boxShadow: "0 10px 26px rgba(0,0,0,0.45)",
              transform: `translateX(${x}px)`,
              opacity: enter,
              fontFamily: JP_FONT,
              // ★字間は詰めない。fitChipFontSize の計算と揃える
              letterSpacing: 0,
              whiteSpace: "pre",
            }}
          >
            <span
              style={{
                color: accent,
                fontSize: fontSize * CHECK_SCALE,
                lineHeight: 1,
                fontWeight: 900,
              }}
            >
              ✓
            </span>
            <span
              style={{
                color: "#fff",
                fontSize,
                lineHeight: 1.12,
                fontWeight: 800,
              }}
            >
              {text}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
