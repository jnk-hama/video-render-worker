import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "../types";
import { JP_FONT } from "../lib/fonts";
import { advanceEm, breakScore, hasJapanese, TRACKING_EM, wrapByWidth } from "./HookTelop";

/*
 * 字幕。
 *
 * ★ffmpeg版（libass）と同じ設計思想を保つ。
 *   ・強調語だけ色を変える（1枚に1語まで）
 *   ・TikTokのUIを避けた位置に置く（右のアイコン列・下部テロップ）
 *   ・太い黒縁を付ける。背景がどんな色でも読めるようにするため
 *
 * ★時刻は台本の実測値をそのまま使う。ここで推定しない。
 */

/*
 * 【黒縁の作り方（実測して直した）】
 * `-webkit-text-stroke` は libass の縁取りほど太くならず、
 * 1本目の描画では細くて背景に負けた。
 *
 * そこで**同じ文字を8方向へずらして黒で敷き、その上に本体を置く**。
 * libassの縁取り（輪郭を膨らませる）と同じ結果になる。
 * text-shadow を8つ重ねる手もあるが、影は太らせると滲む。
 * 複製の方が輪郭が締まる。
 *
 * ★ミュート再生で読めない字幕は、無いのと同じ。ここは太くする。
 */
const OUTLINE_PX = 9;

/*
 * 字幕の置き場所と大きさ。**折り返しの計算と描画で同じ値を使うため定数にする。**
 * ★ここをバラバラに持つと、計算した幅と実際に描く幅がずれて、
 *   「収まるはずの行がブラウザ側でもう一度折り返される」ことが起きる。
 */
const INSET_LEFT = 60;
/** TikTokの右側アイコン列を避ける */
const INSET_RIGHT = 200;
const FONT_SIZE = 108;

/**
 * 字幕は**最大2行**（決定#124・オーナー指示「多くて二列にしてください。読みにくいです」）。
 *
 * ★3行以上になると視線が2回折り返す。1枚あたり1〜2秒しか出ないので、
 *   折り返すほど読み切れない。本番では「解放され／たい人／は」のように
 *   3行＋1文字の行が出ていた。
 * ★2行に入らない時は**文字を縮めて入れる**（下の fitFontSize）。
 *   切り捨てない。字幕は消えたら情報が丸ごと失われる。
 */
const MAX_LINES = 2;

/** 縮めてよい下限。これ以下はミュート再生で読めないので、そこで止める */
const MIN_FONT_SIZE = 74;

/**
 * 強調語の大きさ（決定#124）。
 *
 * ★オーナー指示：
 *   「この機能でこの価格は(小テロップ)安すぎん(中テロップ&色変更)などにした
 *     ほうが目につきます」
 *   → 同じ行の中で**その語だけ中くらいの大きさにして色を変える**。
 * ★1.34倍で止める理由：これ以上大きいと行の高さが跳ね上がり、
 *   2行に収める前提が崩れる。**強調は「隣より大きい」だけで成立する。**
 */
export const EMPHASIS_SCALE = 1.34;

/*
 * ★★以下3つは**描画から切り離した純関数**にしてある（決定#124）。
 *   scripts/check-caption-wrap.mjs がこれを**そのまま**読み込んで検査する。
 *   ★検査側に同じ計算を書き写さない。写した定数が実装とずれて
 *     検査が意味を失った前例がある（決定#112）。
 */

/**
 * 巨大テロップと中身がかぶる字幕か。かぶるなら**その字幕は出さない**。
 *
 * ★オーナー指摘：ナレーション「この機能でこの価格は安すぎん？」に対し、
 *   巨大テロップ「安すぎん？」と字幕「この機能でこの価格は安すぎん」の
 *   **両方**が出ていた。同じ言葉を2回見せている。
 * ★句読点と記号を落としてから比べる。テロップは「？」を付け、字幕は付けない、
 *   といった差で「別物」と判定されるのを防ぐため。
 */
export const isDuplicateOfTelop = (text: string, telops: string[]): boolean => {
  const norm = (v: string) => v.replace(/[\s。、！？!?]/g, "");
  const cur = norm(text);
  if (!cur) return false;
  return telops.some((sup) => {
    const t = norm(sup);
    return t.length > 0 && (t.includes(cur) || cur.includes(t));
  });
};

/**
 * その字幕で強調する語を1つ選ぶ。
 *
 * ★**中身で当てる**。TTSの刻み方でシーンと枚の対応がずれるので、
 *   「n枚目だからn番目の強調語」とは決められない。
 *   実際に含まれている語だけを、長いものから1つ。
 */
export const pickEmphasis = (
  text: string,
  own: string | undefined,
  words: string[],
): string | undefined =>
  own ||
  words.filter((w) => w && text.includes(w)).sort((a, b) => b.length - a.length)[0];

/**
 * 字幕を**2行以内**に割り、入らなければ文字を縮める（決定#124）。
 *
 * 返す fontSize は**実際に描く大きさ**。呼び出し側はこれをそのまま使う。
 * ★1文字の実寸は巨大テロップと条件が違う：
 *     ・letterSpacing を掛けていない → advanceEm に TRACKING_EM を戻す
 *     ・強調語だけ EMPHASIS_SCALE 倍で描く
 *   **その語がどの行に載るか**まで折り返しに効くので、幅を全体から
 *   引くのではなく1文字ずつ測る。
 */
export const layoutCaption = (
  text: string,
  emphasis: string | undefined,
  boxWidth: number,
  market: string,
): { lines: string[]; fontSize: number } => {
  const charEm = captionCharEm(text, emphasis, market);
  if (!hasJapanese(text)) return { lines: [text], fontSize: FONT_SIZE };

  /*
   * ★★**強調語を行またぎさせない**（決定#124）。
   *
   *   Line は `text.split(強調語)` で色と大きさを付ける。行の間に "\n" が
   *   入って語が割れると、**当たらないので何も付かないまま**出る。
   *   実測：3文字の語の24%、4文字の語の39%が行をまたいでいた。
   *   「目立たせる」ための機能が4回に1回黙って消えるのでは意味が無い。
   *
   * ★ただし**守れない時は守らない**。語が長すぎて1行に入らない回まで
   *   固執すると、行が箱をはみ出してブラウザに折り返される（もっと悪い）。
   *   だから禁止つきで一度組み、駄目なら禁止なしで組み直す。
   */
  const at = emphasis ? Array.from(text.slice(0, text.indexOf(emphasis))).length : -1;
  const end = at >= 0 ? at + Array.from(emphasis as string).length : -1;
  const keepWhole = at > 0 ? (i: number) => i > at && i < end : undefined;

  const tight = fitTwoLines(text, charEm, boxWidth, market, keepWhole);
  /*
   * ★駄目だったかの判定に**幅も入れる**。行数だけでは足りない。
   *   実際に「夜中に／ゴミ箱へ捨て」（強調6文字）で、2行のまま
   *   2行目が894pxになり箱(820px)を超えた。行数は合っているのに、
   *   ブラウザが再び折り返すので結局3行になる。
   */
  if (keepWhole && !fits(text, charEm, tight, boxWidth)) {
    // 語をまたがせない縛りのせいで入らなかった。途中で切ることを許して組み直す
    return fitTwoLines(text, charEm, boxWidth, market, undefined);
  }
  return tight;
};

/** 2行以内で、どの行も箱に収まっているか */
const fits = (
  text: string,
  charEm: (ch: string, index: number) => number,
  laid: { lines: string[]; fontSize: number },
  boxWidth: number,
): boolean => {
  if (laid.lines.length > MAX_LINES) return false;
  let i = 0;
  for (const line of laid.lines) {
    let w = 0;
    for (const ch of Array.from(line)) w += charEm(ch, i++) * laid.fontSize;
    if (w > boxWidth) return false;
  }
  return true;
};

/** 縮めて2行に入れる。入らなければ割り方を変える。それでも駄目ならそのまま返す */
const fitTwoLines = (
  text: string,
  charEm: (ch: string, index: number) => number,
  boxWidth: number,
  market: string,
  avoidBreakAt: ((index: number) => boolean) | undefined,
): { lines: string[]; fontSize: number } => {
  /*
   * ① まず**縮めて**2行に入れる。切れ目の質は wrapByWidth が一番よく守る。
   */
  let fontSize = FONT_SIZE;
  let lines = wrapByWidth(text, boxWidth, fontSize, market, charEm, avoidBreakAt);
  while (lines.length > MAX_LINES && fontSize > MIN_FONT_SIZE) {
    fontSize = Math.max(MIN_FONT_SIZE, Math.round(fontSize * 0.92));
    lines = wrapByWidth(text, boxWidth, fontSize, market, charEm, avoidBreakAt);
  }
  if (lines.length <= MAX_LINES) return { lines, fontSize };

  /*
   * ② 下限まで縮めても3行以上のときだけ、**割り方を変えて**2行にする（決定#124）。
   *
   *   wrapByWidth は行を1本ずつ順に決める（貪欲法）。1行目で少し戻って
   *   良い切れ目を取ると、その行が短いまま確定して**残りが次行に入らず**、
   *   3行になることがある。実際に14文字で起きた：
   *     「手に吸い／上げてくれる／ステーシ」＝ 313/470/313px（箱は820px）
   *   3行に散らばっているが、合計はどう見ても2行に収まる幅である。
   *
   * ★★**縮める前にこれを試してはいけない。** 一度そう書いて絵で失敗した。
   *   大きい文字だと「両方の行が箱に入る」切れ目がほとんど無く、
   *   残った数少ない位置が語の途中でも選ばれてしまう：
   *     「この機能でこの価／格は安すぎん」「正確な値段はプロ／フに載せといたよ」
   *   縮めた方は同じ文を「この機能でこの／価格は安すぎん」と正しく割っていた。
   *   **少し小さくて正しく割れている方が読める。**
   */
  const balanced = splitTwoLines(text, charEm, fontSize, boxWidth, avoidBreakAt);
  return { lines: balanced ?? lines, fontSize };
};

/**
 * 全体を見て**2行へ割る**。割れないなら null（呼び出し側が文字を縮める）。
 *
 * ★行を順に決める貪欲法と違い、**切れ目を1つだけ選ぶ**問題なので全部試せる。
 *   字幕は長くて十数文字なので、総当りで足りる。
 * ★選び方は「切れ目の良さ」が第一。同じ良さなら**均等**な方を採る。
 *   片方だけ極端に長い2行は、読む速さが行ごとに変わって読みにくい。
 */
const splitTwoLines = (
  text: string,
  charEm: (ch: string, index: number) => number,
  fontSize: number,
  boxWidth: number,
  avoidBreakAt: ((index: number) => boolean) | undefined,
): string[] | null => {
  const chars = Array.from(text);
  const w = chars.map((c, i) => charEm(c, i) * fontSize);
  const total = w.reduce((a, b) => a + b, 0);
  // どちらの行も箱に入らない長さなら、割り方をいくら変えても入らない
  if (total > boxWidth * 2) return null;

  let best: { at: number; score: number } | null = null;
  let head = 0;
  for (let i = 1; i < chars.length; i++) {
    head += w[i - 1];
    const tail = total - head;
    if (head > boxWidth || tail > boxWidth) continue;
    if (avoidBreakAt?.(i)) continue;
    const q = breakScore(chars, i);
    if (q === 0) continue; // 禁則で切れない位置
    // 良さが第一、均等さは同点のときの決め手。差は必ず1未満に収める
    const score = q + (1 - Math.abs(head - tail) / boxWidth) / 1000;
    if (!best || score > best.score) best = { at: i, score };
  }
  if (!best) return null;
  return [chars.slice(0, best.at).join(""), chars.slice(best.at).join("")];
};

/** 1文字の実寸（em）。折り返しの計算と描画で同じ値を使うため、ここに1本化する */
export const captionCharEm =
  (text: string, emphasis: string | undefined, market: string) => {
    /*
     * ★★2026-09-12、**強調語が2回出る回で測り違えていた**（決定#138）。
     *
     *   ここは `text.indexOf(emphasis)` で **最初の1つだけ**を大きい文字として
     *   数えていた。ところが描く側（下の Line）は `text.split(highlight)` で
     *   **出てくる全部**を大きくする。つまり測りと描きが食い違っていた。
     *
     *   実害（job gen136 の描画で確認）:
     *     「勝手に出てって勝手に」→ 2行に収めたつもりが、2行目の実幅が
     *     866px（枠820px）になり、**CSSが折り返して3行になった**。
     *     オーナー指示「テロップは多くて二列」（決定#124）を破っていた。
     *
     *   ★measure と render は**同じ規則で**動かす。片方だけ直すとまたずれる。
     */
    const chars = Array.from(text);
    const big = new Set<number>();
    if (emphasis) {
      const em = Array.from(emphasis);
      for (let i = 0; i + em.length <= chars.length; i++) {
        let hit = true;
        for (let k = 0; k < em.length; k++) {
          if (chars[i + k] !== em[k]) { hit = false; break; }
        }
        if (hit) {
          for (let k = 0; k < em.length; k++) big.add(i + k);
          i += em.length - 1;   // 重なりを数えない
        }
      }
    }
    return (ch: string, index: number): number =>
      (advanceEm(ch, market) + TRACKING_EM) * (big.has(index) ? EMPHASIS_SCALE : 1);
  };

const OUTLINE_DIRS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

const Line: React.FC<{
  text: string;
  highlight?: string;
  accent: string;
  outline: boolean;
}> = ({ text, highlight, accent, outline }) => {
  const parts = highlight ? text.split(highlight) : [text];
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 ? (
            /*
             * ★強調語だけ**大きく・色を変える**（決定#124）。
             *   ★縁の層では色を変えない。輪郭は一様な黒でないと締まらない。
             *     **大きさは縁の層でも同じにする。** 揃えないと縁と本体が
             *     ずれて、二重の輪郭になる。
             */
            <span
              style={{
                display: "inline-block",
                fontSize: `${EMPHASIS_SCALE}em`,
                lineHeight: 1,
                verticalAlign: "middle",
                color: outline ? "#000" : accent,
              }}
            >
              {highlight}
            </span>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
};

export const Captions: React.FC<{
  captions: Caption[];
  accent: string;
  /**
   * 字幕を出してはいけない区間（秒）。巨大テロップが出ている間がこれ。
   *
   * ★★2026-09-09 追加。オーナー指摘「テロップが2個被る事は避けて」。
   *   以前は字幕が全編を貫いて出るため、巨大テロップと**構造上必ず**
   *   重なっていた（そのぶん合成した商品も隠れていた）。
   * ★省略された場合は従来どおり全編で出す。既存の呼び出しを壊さない。
   */
  hideWindows?: { start: number; end: number }[];
  /** "ja" か "en"。書体の実寸表と改行規則の切り替えに使う */
  market?: string;
  /**
   * 強調語（決定#124）。字幕の中にこの語があれば**大きく・色を変えて**出す。
   * ★台本の telop_emphasis がここへ来る。どの枚に当たるかは中身で決める
   *   （TTSの刻み方でシーンと枚の対応がずれるため、位置では決められない）。
   */
  highlightWords?: string[];
  /**
   * この語と中身がかぶる字幕は**出さない**（決定#124）。
   *
   * ★オーナー指摘：ナレーション「この機能でこの価格は安すぎん？」に対し、
   *   巨大テロップ「安すぎん？」と字幕「この機能でこの価格は安すぎん」の
   *   **両方**が出ていた。同じ言葉を2回見せている。
   */
  suppressTexts?: string[];
}> = ({
  captions, accent, hideWindows, market = "ja",
  highlightWords = [], suppressTexts = [],
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  // ★ここが「被らせない」の実体。巨大テロップの区間なら字幕を描かない
  if ((hideWindows ?? []).some((w) => t >= w.start && t < w.end)) return null;

  const current = captions.find((c) => t >= c.start && t < c.end);
  if (!current) return null;

  /*
   * ★★2026-09-09、**改行を自分で決めるようにした**（決定#115）。
   *
   *   前はブラウザの折り返しに任せていた。**日本語はどこでも折れる**ので、
   *   本番の動画で「罪悪感ヤバいゴ／ミ箱」「スタンド付きな／ら」と
   *   語の途中で切れていた（job 18ccc0cd のフレームで確認）。
   *
   *   ★巨大テロップ側は最初からこれを解いてある（禁則・助詞・文字種の境界）。
   *     **同じ規則を書き直さない。** wrapByWidth をそのまま使う。
   *   ★英語には掛けない。英語はブラウザが空白で折るのが正しく、
   *     和文の規則を当てると単語が割れる。
   */
  // ★同じ言葉を2回見せない（決定#124）
  if (isDuplicateOfTelop(current.text, suppressTexts)) return null;

  const emphasis = pickEmphasis(current.text, current.highlight, highlightWords);
  const boxWidth = width - INSET_LEFT - INSET_RIGHT;
  const { lines, fontSize } = layoutCaption(current.text, emphasis, boxWidth, market);
  const text = lines.join("\n");

  // 出入りを一瞬だけ柔らかくする。パッと切り替わると読み落とす
  const inP = interpolate(t, [current.start, current.start + 0.12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const box: React.CSSProperties = {
    position: "absolute",
    // TikTokの安全域。右200pxはアイコン列、下は投稿文が重なる
    left: INSET_LEFT,
    right: INSET_RIGHT,
    /*
     * ★★2026-09-09、0.60 → 0.64 へ下げた（オーナー指摘
     *   「小テロップを少し下に下げて欲しい」）。
     *
     *   ★下げ幅を4%に留めた理由。実測すると字幕は**2行になる回が多い**
     *     （「夜中にゴミ箱／へ」など）。2行 ＝ 108px × 1.2 × 2 ＝ 259px なので、
     *       0.64 … 上端1229px → 下端1488px＝画面の77.5%
     *       0.68 … 上端1306px → 下端1565px＝画面の81.5%
     *     TikTokは下部にユーザー名と投稿文を重ねる。0.68まで下げると
     *     **2行目がそこへ入る**。「少し下」の指示に対して、読めなくなる所まで
     *     動かすのは目的に反する。
     *
     *   ★TikTokは安全域の具体的な%を公開していないため、77.5%が安全だと
     *     断定はできない。実機に投稿できたら実測して詰め直すこと。
     */
    top: height * 0.64,
    textAlign: "center",
    fontFamily: JP_FONT,
    fontSize,
    lineHeight: 1.2,
    whiteSpace: "pre-wrap",
  };

  return (
    <div
      style={{
        opacity: inP,
        transform: `translateY(${interpolate(inP, [0, 1], [10, 0])}px)`,
      }}
    >
      {/* 縁：8方向へずらした黒の複製 */}
      {OUTLINE_DIRS.map(([dx, dy], i) => (
        <div
          key={i}
          style={{
            ...box,
            color: "#000",
            transform: `translate(${dx * OUTLINE_PX}px, ${dy * OUTLINE_PX}px)`,
          }}
          aria-hidden
        >
          <Line text={text} highlight={emphasis} accent={accent} outline />
        </div>
      ))}

      {/* 本体 */}
      <div style={{ ...box, color: "#f4f4f5" }}>
        <Line
          text={text}
          highlight={emphasis}
          accent={accent}
          outline={false}
        />
      </div>
    </div>
  );
};
