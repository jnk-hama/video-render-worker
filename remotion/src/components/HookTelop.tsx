import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { JP_FONT } from "../lib/fonts";

/*
 * 巨大テロップ（2026-09-05）。
 *
 * 【1本目が「一切大きくなっていない」と言われた原因（確認済）】
 * **書体を指定していなかった。**
 * 実行#62のログには「巨大テロップ 5枚」が出ており、データは描画側まで
 * 届いていた。にもかかわらず画面には何も出なかった。
 *
 *   Captions.tsx   … fontFamily: JP_FONT を指定 → 出ていた
 *   Disclosure.tsx … fontFamily: JP_FONT を指定 → 出ていた
 *   HookTelop.tsx  … **指定なし** → 出なかった
 *
 * 描画コンテナに入れているフォントは `fonts-dejavu-core` だけで、
 * これはラテン文字しか持たない。同梱の Dela Gothic One は data URI で
 * `JmasJP` として差し込んでいるので、**その名前を書いた要素にしか当たらない**。
 * 書き忘れた要素は日本語のグリフを1つも持たない書体へ落ちる。
 *
 * 【演出をシーンごとに変える（2026-09-05・オーナー指示）】
 * 「全部が全部同じにしなくてもいい。ナナメ＋ゆっくり光る、点滅＋強め縁取り、
 *   みたいに散らすと面白い」
 *
 * ★**乱数は使わない。** job_id から決める。
 *   CLAUDE.md の「確率で出力が揺れる処理を構成に持ち込まない」に従う。
 *   乱数にすると、同じjobを描き直した時に前と違う動画が出て検証できない
 *   （描き直しは設計された経路。E-017 を参照）。
 *   job_id を種にして**5つの演出を並べ替える**方式にした。結果:
 *     ・動画ごとに並びが変わる
 *     ・同じ動画は何度描いても1フレームも変わらない
 *     ・5シーンなら5種類が必ず1回ずつ出る（同じ演出が隣り合わない）
 *
 * 【傾けた時に画面からはみ出さないこと】
 * 傾けると外接する箱が横にも縦にも広がる。文字サイズを決める式に
 * 回転を織り込んであるので、**傾ける演出だけ自動的に少し小さくなる**。
 * 目分量で「たぶん入る」にしない。
 */

/** 文字の外側に残す余白（画面幅比）。回転後の箱がここに収まる */
const WIDTH_MARGIN = 0.98;

/*
 * 1文字の上限（画面幅比）。**書体で字面の高さが違うので市場ごとに持つ。**
 *
 * ★実測（fontToolsで同梱TTFから）:
 *     Dela Gothic One の和字 … 字面の高さ 0.77em
 *     Anton の英大文字       … 字面の高さ 0.859em（sCapHeight）
 *   **同じ fontSize なら英語の方が12%背が高い。** オーナーの
 *   「英語はもう少し小さく」は、この差が見えていたということ。
 * ★英語は上限をさらに下げて 0.26 にした。字面を揃えるだけなら 0.358
 *   だが、それだと1行に入る語数が増えず「キリのいいところまで入れて」に
 *   ならない。小さくするほど1行に詰められる。
 */
/*
 * ★★2026-09-09、**小さくした**（オーナー指摘「文字サイズも小さく」）。
 *     日本語 0.46 → 0.38（−17%）
 *     英語   0.26 → 0.22（−15%）
 *
 *   ★これは「1文字が画面幅の何割まで許すか」の上限であって、
 *     実際の大きさは帯の高さと行数からも制限される。上限を下げると
 *     **1行の短いフックほど効く**（長いフックは元々帯の高さで頭打ち）。
 *     「バン」と出る回だけが落ち着き、詰まった回は変わらない。
 *
 *   ★下げすぎない。ミュート再生で読めない文字は無いのと同じ。
 *     読める下限は保つ。
 */
const MAX_FONT_RATIO_JA = 0.38;
const MAX_FONT_RATIO_EN = 0.22;
const maxFontRatio = (market: string): number =>
  market === "en" ? MAX_FONT_RATIO_EN : MAX_FONT_RATIO_JA;

/*
 * ★行数は1〜3。4行にすると1文字が小さくなり、殴る力が消える。
 *   下の候補の作り方（1行・2行・3行のみ列挙）がこの上限そのもの。
 */
const LINE_HEIGHT = 1.0;

/** 英語も3行まで。4行にすると1文字が小さくなり、殴る力が消える */
const MAX_LINES_EN = 3;

/**
 * 和文を一列で出すと決めるための下限（画面幅比）。
 *
 * ★走る字幕は 108px（画面幅の10.0%）。巨大テロップがそれを下回ったら
 *   もう「巨大」ではないので、一列を諦めて改行へ戻す。
 * ★英語には掛けない（英語は語で折る latinLayout が別にある）。
 */
const ONE_LINE_MIN_RATIO = 0.105;

/*
 * 置ける帯（画面高さ比）。走る字幕は 0.6 にある。
 *
 * ★★2026-09-06、上端を 0.07 → 0.12 へ下げた。
 *   実測すると3行になる長いフックで**上端が画面の7.0%まで達していた**。
 *   TikTokは上部に「おすすめ／フォロー中」のタブが重なるため、
 *   ここまで上げると隠れる危険がある。
 *
 *   ★TikTok公式のヘルプ記事はセーフゾーンの具体的な%を公開しておらず、
 *     「キャプションの長さやアドオンで変わる」「テンプレートを
 *     ダウンロードして確認せよ」としている。つまり**確定値は無い**。
 *     ここでは確認できない数字を採用せず、「上端を下げる」という
 *     方向だけを採った。実機に投稿できたら実測して詰め直すこと。
 */
/*
 * ★★2026-09-09、オーナー指摘「テロップももう少し下に配置」で下げた。
 *   0.12〜0.58 → 0.20〜0.66。
 *
 *   ★**帯の高さは 0.46 のまま変えていない。** 文字サイズは帯の高さから
 *     逆算しているので、高さを変えると全行の大きさが変わり、収まり検査
 *     （check-telop.mjs の232通り）の前提が崩れる。**位置だけ動かす**なら
 *     計算結果は1ピクセルも変わらない。
 *
 *   ★下げすぎない。TikTokの広告仕様は「ボタン・ユーザー名・キャプションが
 *     出る領域に文字・ロゴ・要点を置くな」としており、下端はUIに食われる。
 *     **具体的な%は公表されていない**（テンプレートを配って各自で確認せよ、
 *     という形）ので、ここでも数字を断定せず、UI帯の手前で止めている。
 */
/*
 * ★★2026-09-09（2回目）、0.20〜0.66 → 0.16〜0.62 へ**少し戻した**。
 *
 *   下げた版で実際に描いたところ、**人物素材のシーンでテロップが顔に
 *   完全にかぶった**（3シーン目）。以前(0.12)は顔より上に来ていたが、
 *   0.20 まで下げると顔の高さに入る。
 *
 *   ★下げ幅を「0.12→0.20」から「0.12→0.16」へ半分に留めた。
 *     人物なしのシーン（1・2枚目）は下げた位置でよく見えていたので、
 *     **下げる方向は正しく、行き過ぎていただけ**と判断した。
 *   ★帯の高さは 0.46 のまま。位置だけ動かしているので文字サイズは不変。
 */
// ★検査スクリプト（check-telop.mjs）が同じ値を読めるように export する。
//   以前は検査側が 0.12 / 0.58 を**コピーで持っており**、実装を動かしても
//   検査は古い帯を測り続けていた（実際にそれで見逃した）。定数は1箇所に置く。
export const BAND_TOP_RATIO = 0.16;
export const BAND_BOTTOM_RATIO = 0.62;

/*
 * 【1文字の横幅（2026-09-05・実測に置き換えた）】
 *
 * ★前の版は「ASCIIは0.58em」と**見積りで書いていた。間違っていた。**
 *   実際にTTFの hmtx を読むと、
 *     Dela Gothic One（日本語）の英大文字 … 平均 0.911em（W は 1.096em）
 *     Anton（英語）の英大文字            … 平均 0.474em
 *   つまり日本語書体では**35%以上小さく見積もっており**、「AI」「SNS」
 *   「3秒」のようにASCIIを含むフックは計算より広くなって**画面から
 *   はみ出す**。英語書体では逆に大きく見積もって無駄に小さく描いていた。
 *
 * ★下の表は fontTools で同梱TTFから実測した値（1/1000em、コード32〜126）。
 *   作り直す時:
 *     python3 -c "from fontTools.ttLib import TTFont; f=TTFont(PATH); \
 *       u=f['head'].unitsPerEm; h=f['hmtx']; c=f.getBestCmap(); \
 *       print([round(h[c[i]][0]/u*1000) for i in range(32,127)])"
 * ★和文（全角）は Dela Gothic One で全て 1.000em ちょうどだった（16字で確認）。
 */
const ASCII_ADV_JA = [
  200, 309, 501, 924, 887, 889, 771, 294, 358, 358, 479, 572, 272, 490, 272, 499, 917, 588, 835,
  881, 924, 884, 856, 777, 876, 856, 272, 272, 547, 617, 547, 764, 862, 943, 894, 943, 893, 867,
  860, 919, 918, 661, 884, 916, 804, 1093, 919, 971, 889, 971, 883, 924, 939, 920, 903, 1096, 880,
  943, 865, 360, 499, 360, 615, 530, 600, 741, 744, 707, 734, 725, 470, 744, 695, 348, 323, 746,
  316, 1098, 695, 736, 734, 734, 577, 709, 513, 695, 698, 880, 683, 698, 671, 352, 250, 352, 800,
];
const ASCII_ADV_EN = [
  234, 229, 429, 546, 462, 1057, 520, 214, 291, 291, 452, 355, 236, 311, 229, 405, 494, 331, 494,
  494, 494, 494, 494, 494, 494, 494, 242, 245, 321, 311, 321, 492, 864, 485, 479, 474, 493, 412,
  399, 485, 499, 227, 466, 472, 397, 746, 498, 486, 472, 494, 477, 461, 396, 474, 469, 712, 484,
  446, 410, 318, 405, 318, 474, 365, 317, 483, 501, 491, 498, 488, 280, 504, 505, 243, 263, 491,
  248, 758, 499, 497, 501, 498, 347, 475, 305, 499, 461, 696, 459, 461, 386, 340, 216, 340, 493,
];

/** letterSpacing: -0.03em ぶん。1文字ごとに詰まる */
const TRACKING_EM = 0.03;

/** 1文字の横幅（em）。書体で違うので market で表を選ぶ */
export const advanceEm = (ch: string, market: string): number => {
  const c = ch.codePointAt(0) ?? 0;
  const table = market === "en" ? ASCII_ADV_EN : ASCII_ADV_JA;
  const raw = c >= 32 && c <= 126 ? table[c - 32] / 1000 : 1.0;
  return Math.max(0.05, raw - TRACKING_EM);
};

/**
 * シーンごとに回す色。
 * ★暗い色は入れない。背景（ストック映像を暗く落としてある）に沈む。
 */
export const PALETTE_FOR_TELOP = ["#ffe500", "#00e5ff", "#ff2d95", "#b6ff00", "#ff7a00"];

/**
 * 演出。job_id で並べ替えて割り当てる。
 *
 * ★★2026-09-06、5種類 → 8種類へ増やし、**全体的に強くした**
 *   （オーナー「もっとインパクト強めで。まだまだたりない」）。
 *   足したのは次の3つの仕掛け。
 *     ・slideRatio … 横から入る
 *     ・shake      … 出た瞬間に細かく揺れる（着地の衝撃）
 *     ・ringOutline… 黒縁の外側にもう1枚、色の縁を重ねる
 *   傾きも最大12°まで広げた。
 *
 * ★★2026-09-06、**動きだけ抑えた**（オーナー「1〜4枚目はやりすぎ。
 *   テロップはもう大丈夫」）。大きさ・縁の太さ・色・傾きは評価された
 *   部分なので**一切変えていない**。落としたのは動きだけ:
 *     出だしの拡大率 最大1.85 → 1.32倍
 *     落下・突き上げ 最大0.9  → 0.45（文字サイズ比）
 *     横入り         0.35    → 0.18（画面幅比）
 *     着地の揺れ     最大0.07 → 0.025
 *   「大きさで殴るのが主で、動きは補助」という元の方針へ戻した。
 */
export type TelopStyle = {
  name: string;
  /** 傾き（度）。0で水平 */
  tiltDeg: number;
  /** 光り方 */
  glow: "slow" | "steady" | "blink";
  /** 縁の太さ（文字サイズ比） */
  outlineRatio: number;
  /** 出だしの拡大率。1.0で拡大なし */
  popFrom: number;
  /** 出だしの縦の入り（文字サイズ比）。正=上から落ちる / 負=下から突き上げる */
  dropRatio: number;
  /** 出だしの横の入り（画面幅比）。正=右から / 負=左から / 0=なし */
  slideRatio: number;
  /** 着地の揺れ（文字サイズ比の振幅）。0でなし */
  shake: number;
  /** 黒縁の外にもう1枚、色の縁を重ねるか */
  ringOutline: boolean;
};

/*
 * ★★2026-09-09、**動きと点滅を全て止めた**（オーナー指摘
 *   「大テロップも派手すぎるから点滅とか動きはいらない」）。
 *
 *   popFrom / dropRatio / slideRatio / shake を全て 0（＝拡大も落下も
 *   横入りも揺れもなし）、glow は全て "steady"（点滅も脈動もなし）。
 *
 *   ★**型と描画側のコードは残す。** 値を中立にすれば動きは出ない。
 *     コード側を削ると check-telop.mjs と telop-catalog.mjs も直す必要が
 *     あり、変更が依頼の範囲を超える（CLAUDE.md「変更は外科的に」）。
 *     後で「やっぱり少し動かしたい」となった時も、数値1つで戻せる。
 *
 *   ★残した違いは**傾き・縁の太さ・二重縁の有無**だけ。いずれも静止した
 *     見た目の差で、動かない。色は別に並べ替えて割り当てている。
 *
 *   ★点滅を止めるのは見た目の話だけではない。激しい明滅は光過敏性発作の
 *     誘因になり得るし、TikTokの公式クリエイティブ指針も避けるよう促している。
 */
export const TELOP_STYLES: TelopStyle[] = [
  { name: "ナナメ左・太縁", tiltDeg: -9, glow: "steady", outlineRatio: 0.12, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: false },
  { name: "直立・極太縁", tiltDeg: 0, glow: "steady", outlineRatio: 0.13, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: false },
  { name: "ナナメ右・細縁", tiltDeg: 8, glow: "steady", outlineRatio: 0.095, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: false },
  { name: "ナナメ左・二重縁", tiltDeg: -4, glow: "steady", outlineRatio: 0.1, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: true },
  { name: "直立・二重縁", tiltDeg: 0, glow: "steady", outlineRatio: 0.115, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: true },
  { name: "急ナナメ左", tiltDeg: -12, glow: "steady", outlineRatio: 0.105, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: false },
  { name: "ナナメ右・二重縁", tiltDeg: 5, glow: "steady", outlineRatio: 0.1, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: true },
  { name: "直立・太縁", tiltDeg: 0, glow: "steady", outlineRatio: 0.12, popFrom: 1, dropRatio: 0, slideRatio: 0, shake: 0, ringOutline: false },
];

const OUTLINE_DIRS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** 文字列から32bitの数を作る（FNV-1a）。乱数の代わりの種 */
export const seedOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * 種から決まる並べ替え。**同じ種なら必ず同じ並び**。
 * ★Math.random() を使わない。描き直しで動画が変わってはいけない。
 */
export const shuffledBySeed = <T,>(arr: T[], seed: number): T[] => {
  const a = arr.slice();
  let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
};

/*
 * 【1文字ごとに傾き・大きさを変える（2026-09-09・オーナー指示）】
 *
 *   > 文字をナナメにしたりサイズを変えて一列にしましょう
 *
 * ★これは装飾ではなく**一列にするための手当て**である。
 *   一列に固定すると1文字は必ず小さくなる（下の ONE_LINE 節）。
 *   全部を同じ大きさで並べると「小さくなっただけ」に見えるので、
 *   強い文字を大きく・弱い文字を小さくして、**行全体の情報量ではなく
 *   1文字あたりの強弱で殴る**形にする。手書きテロップと同じ理屈。
 *
 * ★乱数は使わない。文面から種を作る（seedOf）。同じテロップは何度
 *   描いても1ピクセルも変わらない（CLAUDE.md「確率で揺れる処理を
 *   構成に持ち込まない」／描き直しは設計された経路・E-017）。
 *
 * ★大きさは**文字送りに正確に効く**。span ごとに fontSize を変えるので
 *   1文字の幅は advanceEm × scale になる。だから収まりの計算
 *   （fitFontSize）にも同じ scale を渡している。**見た目だけ変えて
 *   計算に入れないと画面からはみ出す。**
 */
export type CharAccent = { scale: number; tilt: number };

/** 大きさの並び。平均が1前後になるように組む（行全体の幅を暴れさせない） */
const CHAR_SCALE_PATTERNS: number[][] = [
  [1.0, 1.18, 0.88],
  [1.14, 0.9, 1.0, 1.08],
  [0.9, 1.16, 1.02],
  [1.16, 0.94, 1.06, 0.9],
];

/**
 * 傾きの並び（度）。
 * ★±10°まで。これ以上倒すと、縁を8方向に敷いている都合で
 *   隣の文字と食い合って読みにくくなる（実物を見て決めた上限）。
 */
const CHAR_TILT_PATTERNS: number[][] = [
  [-7, 3, 8, -4],
  [6, -8, 2, -3, 7],
  [-5, 7, -2, 4],
  [4, -6, 9, -3],
];

/** 傾けも大きさも変えない（英語はこれを使う。下の理由を参照） */
const FLAT: CharAccent = { scale: 1, tilt: 0 };

/**
 * 文面から決まる、1文字ごとの傾きと大きさ。**同じ文面なら必ず同じ並び**。
 *
 * ★英語には掛けない。和文は1文字が1つの意味の単位なので大小を付けても
 *   語として壊れないが、英語は**1語の中の文字がバラつくと単語に見えなくなる**。
 *   Aアカウント（英語圏）をこの経路に載せた時に事故らないよう、ここで分ける。
 */
export const charAccents = (n: number, seed: number, market: string): CharAccent[] => {
  if (market === "en") return Array.from({ length: n }, () => FLAT);
  const scales = CHAR_SCALE_PATTERNS[seed % CHAR_SCALE_PATTERNS.length];
  const tilts = CHAR_TILT_PATTERNS[(seed >>> 8) % CHAR_TILT_PATTERNS.length];
  const off = (seed >>> 16) % 5;
  return Array.from({ length: n }, (_, i) => ({
    scale: scales[(i + off) % scales.length],
    tilt: tilts[(i + off) % tilts.length],
  }));
};

/*
 * 【改行位置（2026-09-05・オーナー指示「キリの良い改行もしてな」）】
 *
 * 前の版は**文字数で機械的に割っていた**ので
 *   神ツール → 「神ツ／ール」   熱意ある人材 → 「熱意あ／る人材」
 * のように語の途中で切れていた。
 *
 * ★形態素解析は入れない。CLAUDE.md の「確率で出力が揺れる処理を構成に
 *   持ち込まない」に反するうえ、辞書を抱えると描画が重くなる。
 *   代わりに、**印刷物の禁則処理と同じ決定論的な規則**だけで判定する。
 *     1. 禁則（行頭・行末に置いてはいけない文字）は必ず弾く
 *     2. 助詞の直後は語の切れ目 → 良い改行
 *     3. 文字種の境界（漢字↔ひらがな↔カタカナ↔英数）も語の切れ目 → 良い改行
 *     4. 行頭が助詞になる切り方は避ける
 *   同じ文字種の途中で切るのは「悪い改行」として点を下げるだけで、
 *   禁止はしない。**大きさの利得が十分あれば許す**（1.67倍以上）。
 *
 * ★★ただし**4文字以下は改行しない**（NO_BREAK_MAX_CHARS）。
 *   短い語は横一列の方が速く読める、という実物を見た上での判断。
 *   下の総当たりは5文字以上でしか働かない。
 */

/** この文字で行を**始めない**（行頭禁則）。小書き仮名・長音・閉じ括弧・句読点 */
const NO_LINE_START =
  "、。，．,.・:：;；?？!！ー―‐〜～)）]］}｝」』】〉》>'’\"”%‰℃" +
  "ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞヽヾ";

/** この文字で行を**終えない**（行末禁則）。開き括弧 */
const NO_LINE_END = "(（[［{｛「『【〈《<“‘";

/**
 * 1文字の助詞。この直後は切れ目、この直前は切れ目でない。
 * ★か・ね・よ・や（終助詞）は**入れない**。語の中に頻繁に出るため
 *   誤判定する（「静か」の「か」を助詞と読んで「静か｜すぎる」が
 *   正解に見えていた。**たまたま当たっていただけ**なので外した）。
 */
const PARTICLES = "がのをにへとでもは";

/**
 * この文字列で始まるなら、その手前は語の切れ目。
 * ★辞書ではなく**閉じた短い一覧**。形態素解析は入れない方針のまま、
 *   助詞でも文字種の境界でもない切れ目（接尾語・助動詞）だけを拾う。
 *   増やす時は「語の途中に現れないか」を確かめてから足すこと。
 */
const SUFFIX_STARTS = ["すぎる", "すぎ", "そう", "ない", "たい", "ます", "れる"];

/** 悪い改行の減点。1.0/この値 = 1.67倍。これ未満の利得なら悪い改行はしない */
const POOR_BREAK = 0.6;

/**
 * この文字数までは**改行しない**（オーナー判断 2026-09-05）。
 *
 * 「こんな派手にできるなら1列でババーンと出した方が見易い」→「四文字くらいだな」
 *
 * ★点数だけで決めると、短い語ほど積み上げた方が1文字は大きくなるので
 *   必ず2〜3行になる（神ツール → 神／ツール で 356px、1行なら 267px）。
 *   ところが**横一列の方が視認は速い**、というのが実物を見た上での判断。
 *   数式が出す「1文字の大きさ」と、人が感じる「読みやすさ」は別物なので、
 *   ここは点数に任せず上限で切る。
 * ★境界を4にした理由（実測値）。1行にすると1文字は必ず小さくなる:
 *     4文字 1行 = 267px(25%)  ← ここまでは横一列で読める
 *     5文字 1行 = 214px(20%)  ← ここから急に弱くなるので改行を許す
 *   5文字以上は総当たりに任せる（語の切れ目で切る）。
 */
const NO_BREAK_MAX_CHARS = 4;

type CharClass = "kanji" | "kana" | "kata" | "ascii" | "other";

const classOf = (ch: string): CharClass => {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x100) return "ascii";
  if (c >= 0x3040 && c <= 0x309f) return "kana";
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9f)) return "kata";
  if ((c >= 0x4e00 && c <= 0x9fff) || c === 0x3005) return "kanji";
  return "other";
};

/**
 * 位置 i（i文字目の前）で改行した時の良さ。0なら禁則で切れない。
 * ★純粋関数。描画せずに数値だけで検証できるようにするため。
 */
export const breakQuality = (chars: string[], i: number): number => {
  const a = chars[i - 1];
  const b = chars[i];
  if (NO_LINE_START.includes(b)) return 0; // 行頭禁則
  if (NO_LINE_END.includes(a)) return 0; // 行末禁則
  if (PARTICLES.includes(b)) return 0.5; // 行頭が助詞になる切り方は避ける
  if (PARTICLES.includes(a)) return 1; // 助詞の直後は語の切れ目
  const rest = chars.slice(i).join("");
  if (SUFFIX_STARTS.some((w) => rest.startsWith(w))) return 1; // 接尾語の手前
  const ca = classOf(a);
  const cb = classOf(b);
  if (ca !== cb) {
    /*
     * ★漢字→ひらがな は**送り仮名の可能性がある**ので下げる。
     *   「戻れない」を「戻｜れない」、「死んだ」を「死｜んだ」と切ると
     *   語が割れる。逆向き（ひらがな→漢字）は新しい語の始まりなので満点。
     */
    return cb === "kana" ? 0.75 : 1;
  }
  return POOR_BREAK; // 同じ文字種の途中
};

/** 改行位置の配列から行へ切り出す */
const sliceAt = (chars: string[], breaks: number[]): string[] => {
  const out: string[] = [];
  let prev = 0;
  for (const b of [...breaks, chars.length]) {
    out.push(chars.slice(prev, b).join(""));
    prev = b;
  }
  return out;
};

/**
 * この行割りで入る最大の文字サイズ。傾きを織り込む。
 *
 *   横: (幅em·cosθ + 行数·行高·sinθ) · fontSize ≤ 画面幅 · 余白
 *   縦: (幅em·sinθ + 行数·行高·cosθ) · fontSize ≤ 置ける帯の高さ
 *   上限: fontSize ≤ 画面幅 · MAX_FONT_RATIO
 */
const fitFontSize = (
  lines: string[],
  width: number,
  bandHeight: number,
  cos: number,
  sin: number,
  market: string,
  /*
   * ★縁の張り出し（em）。**字面だけで計算すると縁が画面から切れる。**
   *   8方向へ ±outline ずらした複製を敷いており、色の縁を足す回は
   *   さらに外側 1.9倍まで出る。左右・上下の両側に出るので2倍して足す。
   */
  padEm = 0,
  /*
   * ★1文字ごとの大きさ（行ごと）。span 側で fontSize を変えるので
   *   文字送りも背の高さも実際にこの倍率で伸びる。**見た目だけ変えて
   *   ここへ渡さないと画面からはみ出す。** 省略時は全て等倍。
   */
  accentLines?: CharAccent[][],
): number => {
  const scaleAt = (li: number, ci: number) => accentLines?.[li]?.[ci]?.scale ?? 1;
  const em =
    Math.max(
      0.5,
      ...lines.map((l, li) =>
        Array.from(l).reduce((s, c, ci) => s + advanceEm(c, market) * scaleAt(li, ci), 0),
      ),
    ) + padEm * 2;
  // ★背の高い文字がある行はその分だけ縦に張り出す。最大倍率で見ておく
  const maxScale = Math.max(
    1,
    ...lines.flatMap((l, li) => Array.from(l).map((_, ci) => scaleAt(li, ci))),
  );
  const tall = lines.length * LINE_HEIGHT * maxScale + padEm * 2;
  return Math.min(
    (width * WIDTH_MARGIN) / (em * cos + tall * sin),
    bandHeight / (em * sin + tall * cos),
    /*
     * ★上限は**一番大きい1文字**に掛ける。fontSize は基準値であって
     *   実際に出る最大の字は fontSize × maxScale なので、割っておかないと
     *   強弱を付けた分だけ上限を素通りして大きくなる
     *   （オーナー指示「文字サイズも小さく」に反する）。
     */
    (width * maxFontRatio(market)) / maxScale,
  );
};

/** 和文（ひらがな・カタカナ・漢字）を含むか。含まなければ英語として扱う */
const hasJapanese = (s: string): boolean =>
  /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);

type Candidate = { lines: string[]; quality: number };

/**
 * 日本語の候補。1〜3行のすべての切り方を、禁則と語の切れ目で採点する。
 * ★4文字以下は改行しない（NO_BREAK_MAX_CHARS）。
 */
const japaneseCandidates = (chars: string[]): Candidate[] => {
  const n = chars.length;
  const out: Candidate[] = [{ lines: [chars.join("")], quality: 1 }];
  if (n <= NO_BREAK_MAX_CHARS) return out;

  const breaksList: number[][] = [];
  for (let i = 1; i < n; i++) breaksList.push([i]);
  for (let i = 1; i < n; i++) {
    for (let j = i + 1; j < n; j++) breaksList.push([i, j]);
  }

  for (const breaks of breaksList) {
    let quality = 1;
    for (const b of breaks) quality *= breakQuality(chars, b);
    if (quality === 0) continue; // 禁則

    const lines = sliceAt(chars, breaks);
    /*
     * ★1文字だけの行は、**漢字・カタカナ・英数のときだけ許す。**
     *   「神／ツール」の「神」は1文字でも語なので良い。
     *   「も／う戻れ／ない」の「も」は語ではない。
     *   単独のひらがな1文字は、ほぼ助詞か送り仮名の断片である。
     */
    const badSingle = lines.some((l) => {
      const cs = Array.from(l);
      return cs.length === 1 && (classOf(cs[0]) === "kana" || classOf(cs[0]) === "other");
    });
    if (badSingle) continue;

    out.push({ lines, quality });
  }
  return out;
};

/**
 * 行数を減らすために許すサイズの落ち込み。
 * 1行にまとめた方がこの割合まで保てるなら、行数の少ない方を採る。
 * 「キリのいいところまで入れて」＝**行数を増やさず詰める**、の数値表現。
 */
const EN_PREFER_FEWER = 0.85;

/**
 * 英語の行割り（2026-09-05・オーナー指示
 * 「英語の場合はもう少しサイズ小さくして、キリのいいところまで入れて」）。
 *
 * ★**スペースでしか切らない。単語は絶対に割らない。**
 *   日本語の規則（禁則・助詞・文字種の境界）は英語に1つも当てはまらない。
 *   そのまま流すと ASCII は全部同じ文字種なので「INSANE」が「INS／ANE」に
 *   なり得た。**Aアカウントをこの経路に載せる前に必ず要る。**
 *
 * ★1〜3行の**全ての割り方を総当たり**する。日本語側と同じ手筋。
 *   前の版は「貪欲に詰めてから、入らなければ縮める」だったが、
 *   **縮めた後に割り直していなかった**ので
 *     IT COST ME EVERYTHING → 「IT COST／ME／EVERYTHING」（3行）
 *   になっていた。EVERYTHING が1行に入らずサイズだけ下がり、
 *   その小さいサイズなら2行で足りるのに3行のままだった。
 *   総当たりなら、行数とサイズが必ず噛み合う。
 *
 * ★選び方は2段。
 *   1. 各行数で「一番大きく描ける割り方」を出す。同点なら**行の余りが
 *      均等な方**（IT COST／ME のように1語だけ残る割り方を避ける）
 *   2. その中から、**サイズが最大の85%以上を保てる一番少ない行数**を採る。
 *      「入るなら1行に詰める」を数値で表したのがこれ。
 */
const latinLayout = (
  text: string,
  width: number,
  bandHeight: number,
  cos: number,
  sin: number,
  market: string,
  padEm = 0,
): { lines: string[]; fontSize: number } => {
  const words = text.split(/\s+/).filter(Boolean);
  const w = words.length;
  if (!w) return { lines: [""], fontSize: 0 };

  const emOf = (t: string) =>
    Array.from(t).reduce((a, c) => a + advanceEm(c, market), 0);

  const groupsOf = (cuts: number[]): string[] => {
    const out: string[] = [];
    let prev = 0;
    for (const c of [...cuts, w]) {
      out.push(words.slice(prev, c).join(" "));
      prev = c;
    }
    return out;
  };

  /** 行数ごとの最善。index は 行数-1 */
  const best: ({ lines: string[]; fontSize: number; ragged: number } | null)[] = [];

  for (let count = 1; count <= MAX_LINES_EN; count++) {
    if (count > w) break;
    const cutsList: number[][] = [];
    if (count === 1) cutsList.push([]);
    else if (count === 2) {
      for (let i = 1; i < w; i++) cutsList.push([i]);
    } else {
      for (let i = 1; i < w; i++) {
        for (let j = i + 1; j < w; j++) cutsList.push([i, j]);
      }
    }

    let cur: { lines: string[]; fontSize: number; ragged: number } | null = null;
    for (const cuts of cutsList) {
      const lines = groupsOf(cuts);
      const fontSize = fitFontSize(lines, width, bandHeight, cos, sin, market, padEm);
      // 行の余りの二乗和。小さいほど行の長さが揃っている
      const room = Math.max(...lines.map(emOf));
      const ragged = lines.reduce((a, l) => a + (room - emOf(l)) ** 2, 0);
      if (
        !cur ||
        fontSize > cur.fontSize + 1e-9 ||
        (Math.abs(fontSize - cur.fontSize) <= 1e-9 && ragged < cur.ragged)
      ) {
        cur = { lines, fontSize, ragged };
      }
    }
    best.push(cur);
  }

  const top = Math.max(...best.map((b) => (b ? b.fontSize : 0)));
  for (const b of best) {
    if (b && b.fontSize >= top * EN_PREFER_FEWER) return { lines: b.lines, fontSize: b.fontSize };
  }
  return { lines: [words.join(" ")], fontSize: 0 };
};

/**
 * 改行位置を**総当たりで**決める。
 *
 * すべての候補について
 *   点数 = 入る文字サイズ × 改行の良さの積
 * を出し、一番高いものを採る。同点なら行数の少ない方（先に試す方）。
 *
 * ★総当たりにしたのは、貪欲法だと「1つ目の改行を良い位置に取ったせいで
 *   2つ目が語の途中になる」が起きるため。候補が少ないので全部見てよい。
 * ★純粋関数にしてある。描画せずに数値だけで検証できるようにするため。
 */
export const layoutTelop = (
  text: string,
  width: number,
  bandHeight: number,
  tiltDeg: number,
  market: string = "ja",
  /** 縁の張り出し（em）。演出ごとに違うので呼び出し側が渡す */
  padEm = 0,
): { lines: string[]; fontSize: number; accents: CharAccent[][] } => {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (!chars.length) return { lines: [""], fontSize: 0, accents: [[]] };

  const rad = (Math.abs(tiltDeg) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // ★書き分けは**中身の文字**で決める。market の指定漏れで日本語が
  //   英語の規則に落ちると単語どころか文が壊れるため、両方を見る。
  if (market === "en" && !hasJapanese(trimmed)) {
    const r = latinLayout(trimmed, width, bandHeight, cos, sin, market, padEm);
    return { ...r, accents: r.lines.map((l) => Array.from(l).map(() => FLAT)) };
  }

  /*
   * ★1文字ごとの傾き・大きさは**文面から**決める。行割りより先に決めて
   *   おかないと、収まりの計算に倍率を織り込めない。
   */
  const accents = charAccents(chars.length, seedOf(trimmed), market);
  /** 行ごとに切り出す。文字の位置と倍率がずれないように同じ切り方で割る */
  const accentsFor = (lines: string[]): CharAccent[][] => {
    let at = 0;
    return lines.map((l) => {
      const n = Array.from(l).length;
      const slice = accents.slice(at, at + n);
      at += n;
      return slice;
    });
  };

  const candidates = japaneseCandidates(chars);

  let best = { lines: [trimmed], fontSize: 0, score: -1 };
  for (const c of candidates) {
    const fontSize = fitFontSize(
      c.lines, width, bandHeight, cos, sin, market, padEm, accentsFor(c.lines),
    );
    const score = fontSize * c.quality;
    if (score > best.score) best = { lines: c.lines, fontSize, score };
  }

  /*
   * ★★2026-09-09、**和文は一列を既定にした**（オーナー指示
   *   「文字をナナメにしたりサイズを変えて一列にしましょう」）。
   *
   *   【何が起きていたか】上の総当たりは「1文字が一番大きくなる割り方」を
   *     選ぶので、短いフックほど必ず2〜3行になっていた
   *     （実物: 「ホコリ／舞う」「ゴミ／捨て／0秒」「価格が／バグ」）。
   *     積むと1文字は大きくなるが、**視線が縦へ折り返す**ぶん読むのに
   *     時間がかかる。1.4秒しか出さない一撃としては横一列の方が速い。
   *
   *   【どう決めたか】まず一列で測り、**それが読める大きさなら一列を採る**。
   *     読めない大きさまで落ちる時（＝想定より長い文面が来た時）だけ、
   *     上の総当たりの結果へ戻す。一列を強制して字が潰れる方が害が大きい。
   *
   *   ★下限 ONE_LINE_MIN_RATIO の根拠：走る字幕が 108px（画面幅の10.0%）。
   *     巨大テロップがそれを下回ると「巨大」ではなくなる。10.5%＝113px を
   *     下限に置いた。台本側の契約（telop_main2 は4〜9文字）なら
   *     9文字でも 118px 出るので、契約を守った文面は必ず一列になる。
   */
  const oneLine = [trimmed];
  const oneLineSize = fitFontSize(
    oneLine, width, bandHeight, cos, sin, market, padEm, accentsFor(oneLine),
  );
  if (oneLineSize >= width * ONE_LINE_MIN_RATIO) {
    return { lines: oneLine, fontSize: oneLineSize, accents: accentsFor(oneLine) };
  }

  return { lines: best.lines, fontSize: best.fontSize, accents: accentsFor(best.lines) };
};

/**
 * 1行を、1文字ずつの span で組む。傾きと大きさを文字ごとに変えるため。
 *
 * ★縁・発光・塗りの各層が**全く同じもの**を描く必要がある（8方向の複製を
 *   重ねて輪郭を作っているので、1層でも文字送りが違うと輪郭が二重にぶれる）。
 *   だから組み立てはここ1箇所に置き、各層はこれを呼ぶだけにする。
 *
 * ★letterSpacing を span 側にも書く。**継承だと親の文字サイズで
 *   px に確定した値が降りてくる**ので、大きい文字ほど詰まって見え、
 *   収まりの計算（advanceEm × scale）ともずれる。自分の em で解かせる。
 *
 * ★rotate はレイアウトに影響しない（CSSのtransformは配置後に掛かる）。
 *   だから傾きは文字送りを1pxも動かさない。大きさだけが幅に効く。
 */
const Row: React.FC<{ line: string; accents: CharAccent[]; fontSize: number }> = ({
  line,
  accents,
  fontSize,
}) => (
  <>
    {Array.from(line).map((ch, i) => {
      const a = accents[i] ?? FLAT;
      return (
        <span
          key={i}
          style={{
            display: "inline-block",
            fontSize: fontSize * a.scale,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            // ★大小の文字を同じ横軸で揃える。ベースライン揃えだと
            //   大きい文字だけが沈んで、行がガタつく
            verticalAlign: "middle",
            transform: `rotate(${a.tilt}deg)`,
          }}
        >
          {ch}
        </span>
      );
    })}
  </>
);

export const HookTelop: React.FC<{
  text: string;
  /** このシーンの長さ（フレーム）。出し終わりを決めるのに使う */
  durationInFrames: number;
  /** この回の演出。Video.tsx が job_id から決めて渡す */
  style: TelopStyle;
  /** この回の色。Video.tsx が job_id から決めて渡す */
  color: string;
  /** "ja" か "en"。書体の実寸表と改行規則の切り替えに使う */
  market: string;
}> = ({ text, durationInFrames, style, color, market }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const bandTop = height * BAND_TOP_RATIO;
  const bandHeight = height * BAND_BOTTOM_RATIO - bandTop;
  /*
   * 縁の張り出し（em）。**黒縁までを「必ず画面に入れる」対象とする。**
   *
   * ★色の二重縁は外側1.9倍まで出るが、そこまで入れて計算すると
   *   文字が14%小さくなる。**読めるかどうかを決めているのは字と黒縁**で、
   *   外側の色の縁は装飾なので、画面端でわずかに切れても害がない。
   *   小ささの方が実害が大きいので、黒縁までを保証対象にした。
   */
  const padEm = style.outlineRatio;
  const { lines, fontSize, accents } = layoutTelop(
    text, width, bandHeight, style.tiltDeg, market, padEm,
  );
  const blockHeight = lines.length * fontSize * LINE_HEIGHT;
  const outline = Math.max(2, fontSize * style.outlineRatio);

  /*
   * 出方：バンと出て、わずかに落ち着く。
   * ★跳ね返しすぎない。オーバーシュートが大きいと「テンプレのアニメ」に
   *   見える。大きさで殴るのが主で、動きは補助。
   */
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.5 }, durationInFrames: 10 });
  const scale = interpolate(pop, [0, 1], [style.popFrom, 1]);
  const dropY = interpolate(pop, [0, 1], [-style.dropRatio * fontSize, 0]);
  const slideX = interpolate(pop, [0, 1], [style.slideRatio * width, 0]);

  /*
   * 着地の揺れ。**出た瞬間だけ**、8フレームで収束させる。
   * ★止まってからも揺らさない。読めなくなるうえ、ずっと動いていると
   *   かえって安っぽく見える。衝撃の余韻としてだけ使う。
   */
  const shakeX = style.shake
    ? Math.sin(frame * 2.1) * style.shake * fontSize *
      Math.max(0, 1 - frame / 8)
    : 0;

  /*
   * ★★2026-09-09、意味が変わった。
   *   以前は「シーンのほぼ全部（86%）で出す」だった。だが**それだと
   *   走る字幕と必ず重なり、商品も隠れる**（オーナー指摘：
   *   「出しすぎると商品見えないし、ただうざいだけ」）。
   *
   *   今は Video.tsx 側が **1.4秒だけ**の Sequence に入れて呼ぶ。
   *   `durationInFrames` はその短い尺で渡ってくるので、ここは
   *   「渡された尺のほぼ全部で出す」という同じ式のままでよい。
   *   ★式を変えていないのは、短い尺でも 86% の位置で消え始めるのが
   *     ちょうど良いため（1.4秒なら約1.2秒で消え始める）。
   */
  const holdUntil = Math.round(durationInFrames * 0.86);
  const opacity = interpolate(
    frame,
    [0, 3, holdUntil, holdUntil + 5],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  /*
   * 光り方。
   * ★**点滅させるのは発光の層だけで、文字の塗りは常に出したまま。**
   *   字そのものを消すと、その瞬間は読めない。ミュート再生で読めない
   *   文字は無いのと同じ（字幕と同じ理由。ここは譲らない）。
   *   激しい明滅を避けるのはTikTokの公式クリエイティブ指針にも沿う。
   */
  const t = frame / fps;
  const halo =
    style.glow === "steady"
      ? 1
      : style.glow === "blink"
        ? Math.sin(t * Math.PI * 2 * 2.2) > 0 ? 1 : 0.35
        : 0.7 + 0.3 * Math.sin(t * Math.PI * 2 * 0.6);

  /*
   * ★各行を「絶対位置」で置く。通常の流し込みに任せない。
   *   縁取りの複製を8枚重ねる都合上、流し込みだと高さが崩れる。
   *   位置を全部こちらで決めれば、どのフレームでも同じ場所に出る。
   */
  const common: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    margin: 0,
    fontFamily: JP_FONT, // ★ここを書き忘れて1本目は何も出なかった
    fontSize,
    lineHeight: LINE_HEIGHT,
    fontWeight: 400, // Dela Gothic One は単一ウェイト。上げても太くならない
    letterSpacing: "-0.03em",
    whiteSpace: "pre",
    textAlign: "center",
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // ★帯の中央に置く。回転は中心まわりなので、これで上下とも帯に収まる
        top: bandTop + (bandHeight - blockHeight) / 2,
        height: blockHeight,
        opacity,
        transform:
          `translate(${slideX + shakeX}px, ${dropY}px) ` +
          `rotate(${style.tiltDeg}deg) scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      {lines.map((line, i) => {
        const base = { ...common, top: i * fontSize * LINE_HEIGHT };
        return (
          <React.Fragment key={i}>
            {/*
              ★色の縁は**黒縁より外側**に敷く（先に描く＝下に来る）。
                黒→色の二重の輪郭になり、実際に伸びている動画でよく見る
                「縁が2枚ある文字」になる。内側から 塗り→黒→色 の順。
            */}
            {style.ringOutline
              ? OUTLINE_DIRS.map(([dx, dy], k) => (
                  <div
                    key={`ring-${k}`}
                    aria-hidden
                    style={{
                      ...base,
                      color,
                      transform: `translate(${dx * outline * 1.9}px, ${dy * outline * 1.9}px)`,
                    }}
                  >
                    <Row line={line} accents={accents[i] ?? []} fontSize={fontSize} />
                  </div>
                ))
              : null}

            {/* 縁：8方向へずらした黒の複製（Captions.tsx と同じ方式） */}
            {OUTLINE_DIRS.map(([dx, dy], k) => (
              <div
                key={k}
                aria-hidden
                style={{
                  ...base,
                  color: "#000",
                  transform: `translate(${dx * outline}px, ${dy * outline}px)`,
                }}
              >
                <Row line={line} accents={accents[i] ?? []} fontSize={fontSize} />
              </div>
            ))}

            {/* 発光：同じ字を色で敷き、外へにじませる。ここだけ点滅する */}
            <div
              aria-hidden
              style={{
                ...base,
                color,
                opacity: halo,
                textShadow:
                  `0 0 ${fontSize * 0.1}px ${color},` +
                  `0 0 ${fontSize * 0.22}px ${color},` +
                  `0 0 ${fontSize * 0.4}px ${color}`,
              }}
            >
              <Row line={line} accents={accents[i] ?? []} fontSize={fontSize} />
            </div>

            {/* 塗り：上が白・下が色。常に出したまま（点滅させない） */}
            <div
              style={{
                ...base,
                backgroundImage: `linear-gradient(180deg, #fff 0%, #fff 38%, ${color} 100%)`,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              <Row line={line} accents={accents[i] ?? []} fontSize={fontSize} />
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
