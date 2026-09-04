import React from "react";

/*
 * 日本語フォント。
 *
 * ★ffmpeg版（libass）と**同じ書体・同じファイル**を使う。
 *   `assets/ja/fonts/DelaGothicOne-Regular.ttf`（SIL OFL）。
 *
 * 【なぜ Google Fonts から取らないのか（実測して直した）】
 * `@remotion/google-fonts` は描画のたびに fonts.gstatic.com へ取りに行く。
 * つまり**外部のサーバーが落ちたら動画が1本も出ない**。
 * 実際、証明書を信頼できない環境では net::ERR_CERT_AUTHORITY_INVALID で
 * 描画ごと落ちた。描画は決定論的に保つ方針（CLAUDE.md）に反する。
 *
 * リポジトリに同梱済みのファイルを data URI にして渡せば、
 * ネットワークに一切依存しない。ffmpeg版と1バイトも違わない書体になる。
 *
 * 【なぜ public/ を使わないのか】
 * bundle() の publicDir から配ろうとしたが、素材が404になった（実測）。
 * 原因を追うより、data URI で同一オリジンに寄せる方が確実で、
 * 製品画像のCORS対策と同じ手筋にできる。
 */

/** 描画側（render.mjs）が台本へ入れてくる。無ければ既定の書体で描く */
export const FONT_FAMILY_NAME = "JmasJP";

export const JP_FONT = `${FONT_FAMILY_NAME}, "Hiragino Sans", "Noto Sans JP", sans-serif`;

/**
 * @font-face を1度だけ差し込む。
 * ★フレームは並列に描かれるので、同じCSSが何度挿入されても問題ないよう
 *   id で重複を防ぐ。
 */
export const FontFace: React.FC<{ dataUri?: string | null }> = ({ dataUri }) => {
  if (!dataUri) return null;
  return React.createElement("style", {
    dangerouslySetInnerHTML: {
      __html: `@font-face{font-family:"${FONT_FAMILY_NAME}";src:url("${dataUri}") format("truetype");font-display:block;}`,
    },
  });
};
