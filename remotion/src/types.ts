/*
 * 依頼（script JSON）の形。
 *
 * ★ffmpeg版の payload と**同じ語彙**を使う。job_id / narration / captions /
 *   disclosure / target_market は既存のまま。増やしたのは scenes だけ。
 *   依頼側（Supabase / GAS）が2つの描画方式を出し分けられるようにするため、
 *   語彙を分岐させない。
 */

export type Market = "ja" | "en";

/** シーンの種類。LLMがこの3つのどれかへ振り分ける */
export type SceneKind =
  /** 口播。人が語っているように見せる解説シーン（talkcraft 相当） */
  | "talk"
  /** 製品デモ。UIやスクリーンショットを運鏡で見せる（shotcraft 相当） */
  | "shot"
  /** 没入型デモ。実環境の背景動画へ透過した製品を置く（本件の中核） */
  | "insitu";

export type CameraMove =
  | "push_in" // ゆっくり寄る
  | "pull_out" // ゆっくり引く
  | "pan_right"
  | "pan_left"
  | "orbit" // わずかに回り込む（視差で立体に見せる）
  | "hold"; // 動かさない。連続する運鏡の合間に置く

export type Caption = {
  text: string;
  /** 秒。ナレーションの実測時刻。推定値を入れない */
  start: number;
  end: number;
  /** 色を変える語。1枚につき1語まで */
  highlight?: string;
};

export type SceneBase = {
  kind: SceneKind;
  /** 秒。合計が動画の尺になる */
  seconds: number;
  camera?: CameraMove;
  /** 効果音のタグ。ffmpeg版の fx と同じ語彙 */
  fx?: "fire" | "neon" | "pop" | "shock" | "clean";
};

export type TalkScene = SceneBase & {
  kind: "talk";
  /** 語り手の立ち絵（透過PNG）。無ければ文字だけで成立させる */
  speakerUrl?: string;
  /** 背景。動画URLでも単色でもよい */
  backgroundUrl?: string;
  headline: string;
  sub?: string;
};

export type ShotScene = SceneBase & {
  kind: "shot";
  /** 製品のUI・スクリーンショット。枠は付けない */
  shotUrl: string;
  headline?: string;
  label?: string;
};

export type InSituScene = SceneBase & {
  kind: "insitu";
  /** 実環境の背景動画（Pexels等）。ここが「その場にある」感の土台 */
  backgroundUrl: string;
  /** 透過済みの製品画像（PNG） */
  productUrl: string;
  /** 画面高に対する製品の高さ。0.42前後が自然 */
  heightRatio?: number;
  /** 製品を置く位置（0=上, 1=下）。地面に接地させるなら 0.55〜0.62 */
  yRatio?: number;
  /** 背景の明るさに製品を寄せる度合い。0で無効、0.25前後が自然 */
  ambient?: number;
  headline?: string;
  label?: string;
};

export type Scene = TalkScene | ShotScene | InSituScene;

export type VideoScript = {
  jobId: string;
  width: number;
  height: number;
  fps: number;
  market: Market;
  /** ナレーション音声のURL。TTSは既存の scripts/tts.py が作る */
  narrationUrl?: string;
  /** BGMのURL。音量は BGM_GAIN で絞る */
  bgmUrl?: string;
  captions: Caption[];
  /** 全編に出す広告表記。景表法のステマ規制対応（決定#065） */
  disclosure: string;
  scenes: Scene[];
  /** アクセント色。製品の色に合わせる */
  accent?: string;
  /**
   * 日本語フォントのdata URI。描画側（render.mjs）がリポジトリ同梱の
   * TTFから作って入れる。依頼側は指定しない。
   * ★ネットワークからフォントを取りに行かないための仕組み。
   */
  fontDataUri?: string | null;
  /**
   * 高品質設定（決定#090）。描画側が決めて入れる。
   * ★依頼側は指定しない。品質の判断を台本生成側に散らさない。
   */
  quality?: {
    /** モーションブラーのサンプル数。0で無効 */
    blurSamples: number;
    /** シャッター角。180度が実写のフィルムに近い */
    shutterAngle: number;
  };
};
