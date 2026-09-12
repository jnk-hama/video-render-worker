#!/usr/bin/env node
/*
 * 台本(JSON)を1本のMP4にする。GitHub Actions から呼ばれる入口。
 *
 *   node scripts/render.mjs --payload payload.json --out out.mp4
 *
 * ★ffmpeg版の render_video.py と**同じ引数**にしてある。
 *   ワークフローが2つの描画方式を出し分けても、呼び方が変わらない。
 *
 * ★描画にかかった秒数を必ず出す。無料枠2,000分/月に対して
 *   1本あたり何分かかるかが、そのまま1日に出せる本数を決める。
 *   測らずに本数を決めて3倍外した過去がある（#079）。
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const payloadPath = arg("payload");
const outPath = arg("out", "out.mp4");
if (!payloadPath) {
  console.error("--payload が必要です");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
// 依頼は {job:{...}} で包まれてくる（GitHub の client_payload 制限のため）
const script = raw.job ?? raw;

/*
 * ★既存の依頼（ffmpeg版の payload）をそのまま受ける（決定#088）。
 *
 * 依頼側（process-job / GAS）の台本生成は変えない、というのが方針。
 * AI社員の出力契約（キー名の追加・変更の禁止）に触れないためでもある。
 * なので**変換はここで行う**。依頼側に足すのは renderer の1項目だけ。
 *
 *   clips[i]        → シーンi の背景
 *   foreground.url  → 製品（あれば insitu、無ければ背景だけのシーン）
 *   captions        → そのまま
 *   design_tokens   → accent
 */
const adaptLegacyPayload = (s) => {
  /*
   * 巨大テロップ。依頼側の snake_case を Remotion側の名前へ寄せるだけ。
   * ★空文字は null にして「出さない」を明示する。空文字のまま渡すと
   *   高さゼロの要素が積まれて、字幕の位置が微妙にずれる。
   *
   * ★★**この変換だけは、下の早期returnより前に置く。**
   *   下には「既にRemotion形式なら何もしない」「clipsが無ければ何もしない」
   *   の2つの出口がある。前の版はこの変換をその後ろに書いていたため、
   *   scenes形式で依頼が来た回は巨大テロップが**黙って消える**状態だった。
   *   （今の依頼側は clips 形式なので表には出ていなかったが、埋まっていた）
   */
  /*
   * 巨大テロップの演出・色は job_id から決める（乱数を使わない）。
   * 依頼側は snake_case で送ってくるので、ここで寄せる。
   * ★空でも構わない。その場合は全動画で同じ並びになるだけで、壊れない。
   */
  s.jobId = s.jobId || s.job_id || "";

  /*
   * ★強調語（決定#124）。依頼側は telop_emphasis を highlight_words として
   *   送ってきているのに、**Remotion側へ一度も渡していなかった**。
   *   Caption.highlight という型だけが存在して、誰も値を入れていない状態。
   *   そのため字幕はずっと「全部同じ大きさ・同じ色」で出ていた。
   */
  if (Array.isArray(s.highlight_words)) {
    s.highlightWords = s.highlight_words
      .map((w) => (typeof w === "string" ? w.trim() : ""))
      .filter(Boolean);
    console.log(`強調語 ${s.highlightWords.length}語`);
  }

  if (Array.isArray(s.hook_telops)) {
    s.hookTelops = s.hook_telops.map((t) => (typeof t === "string" && t.trim() ? t.trim() : null));
    const n = s.hookTelops.filter(Boolean).length;
    console.log(n ? `巨大テロップ ${n}枚` : "巨大テロップなし");
  }

  if (Array.isArray(s.scenes) && s.scenes.length) return s; // 既にRemotion形式

  const clips = Array.isArray(s.clips) ? s.clips : [];
  if (!clips.length) return s;

  const each = Number(s.clip_seconds) || 3.0;
  const product = s.foreground && s.foreground.url ? s.foreground.url : null;
  // 運鏡は順に変える。同じ動きが続くと単調になる
  const moves = ["orbit", "push_in", "pan_right", "pull_out"];

  s.scenes = clips.map((c, i) => {
    const seconds = Number(c.duration) || each;
    const camera = moves[i % moves.length];
    /*
     * ★製品は**3シーン目以降**に置く（決定#093、PASONA5段）。
     *
     *   1 Problem / 2 Agitation … 商品を出さない
     *   3 Solution 以降        … 商品を出す
     *
     *   早く出すほど「広告だ」と判断されてスワイプされる。台本側でも
     *   「3より前で商品名を出してはならない」と指示しており、
     *   **画と言葉の両方で同じ約束を守る**。
     *
     *   ★シーンが3未満（移行中の3シーン台本など）の回は、
     *     最初と最後に出す従来の形へ落とす。
     */
    const showProduct = clips.length >= 5 ? i >= 2 : (i === 0 || i === clips.length - 1);
    /*
     * 機能紹介のチップ（2026-09-12）。clip ごとに `features` で来る。
     * ★**商品が出ているシーンにしか出さない。** 商品の見えない画面で
     *   スペックだけ出しても、何の数字か分からない。
     */
    const features = showProduct && Array.isArray(c.features)
      ? c.features.filter((f) => typeof f === "string" && f.trim()).slice(0, 3)
      : [];
    if (product && showProduct) {
      return {
        kind: "insitu",
        seconds,
        camera,
        features,
        backgroundUrl: c.url,
        productUrl: product,
        heightRatio: Number(s.foreground.height_ratio) || 0.42,
        yRatio: Number(s.foreground.y_ratio) || 0.58,
        ambient: s.foreground.ambient === undefined ? 0.25 : Number(s.foreground.ambient),
      };
    }
    return { kind: "talk", seconds, camera, backgroundUrl: c.url, headline: "" };
  });

  /*
   * ★★効果音（2026-09-05）。ffmpeg版の設計を**そのまま持ち込まない。**
   *
   * 【なぜ5つ全部を鳴らさないか】
   * 依頼側は5シーンぶんの効果音を送ってくる（決定#072）。だが5つ全部を
   * 毎回同じ位置で鳴らすと、**どの動画も同じリズムになる**。
   * 台本で「揃っているとAI臭が出る」と戦っているのに、音で同じことを
   * やっては意味がない。効果音は**句読点**であって、BGMではない。
   *
   * 【1シーン目を必ず落とす理由】2つある
   *   1. TikTokの公式クリエイティブ指針が「最初の3秒に破裂音・アラーム等の
   *      不快な音を避けろ」と明示している。1シーン目は0〜3秒。
   *      SFXタグには shock（警告音）と fire が含まれる
   *   2. キューは at_ratio+0.03（≒0.8秒）に置かれる。ナレーションの語頭と
   *      ほぼ同時で、語頭を食う（BGMを0.2に絞っているのと同じ理由）
   *
   * 【2〜4シーン目に絞る理由】
   * 効果音が効くのは**話が転換する点**。3番目は商品が初めて出る場所で、
   * 中盤の離脱を引き戻せる。5番目は寸止めなので、音で押すと押し売りに
   * 見える。**鳴らさない方が強い。**
   *
   * ★★2026-09-05、2〜3 → **2〜4** へ広げた（最大2つ → 最大3つ）。
   *   オーナーが動画を見て「効果音に気づかなかった」と言ったため。
   *   28秒に2つでは間が空きすぎる。5番目を鳴らさない方針は変えない。
   *
   * ★完走率の実データが取れたら、この配置は見直す価値がある。
   *   現状は「公式の指針」と「語頭を食わない」だけが根拠で、
   *   うちのアカウントで効くかは未確認。
   */
  const cues = Array.isArray(s.sfx) ? s.sfx : [];
  s.sfx = cues
    .slice(1, 4)                                   // 1シーン目を落とし、2〜4のみ
    .filter((c) => c && typeof c.tag === "string")
    .map((c) => ({ tag: c.tag, atRatio: Number(c.at_ratio ?? c.atRatio ?? 0) }))
    .filter((c) => c.atRatio > 0 && c.atRatio < 1);

  s.market = s.target_market || s.market || "ja";
  s.accent = (s.design_tokens && s.design_tokens.accent_color_hex) || s.accent || "#8b5cf6";
  s.width = Number(s.width) || 1080;
  s.height = Number(s.height) || 1920;
  s.fps = Number(s.fps) || 30;
  console.log(`既存形式の依頼を ${s.scenes.length} シーンへ変換しました`);
  return s;
};

adaptLegacyPayload(script);

// ★最低限の検査。壊れた台本で長時間まわしてから落ちるのを防ぐ
for (const key of ["width", "height", "fps", "scenes"]) {
  if (script[key] === undefined) {
    console.error(`台本に ${key} がありません`);
    process.exit(1);
  }
}
if (!Array.isArray(script.scenes) || script.scenes.length === 0) {
  console.error("scenes が空です");
  process.exit(1);
}
const totalSeconds = script.scenes.reduce((s, x) => s + Number(x.seconds || 0), 0);
if (!(totalSeconds > 0)) {
  console.error("尺が0秒です");
  process.exit(1);
}

/*
 * ★★部門の取り違えを止める（決定#082）。**ffmpeg版から移した。**
 *
 * 【なぜ移す必要があったか】
 * assets/NOTES.md には「`ja` の依頼が assets/en/… を指したら描かずに停止」と
 * 書いてあるが、その検査は scripts/render_video.py の download() の中にしか
 * 無く、**ffmpeg版の経路だけ**で効いていた。描画方式を Remotion へ移した時に
 * 一緒に移っておらず、Remotion版は「リポジトリの外を読ませない」しか
 * 見ていなかった。
 *
 * ★実際に素通りした。`target_market: "ja"` の依頼が assets/en/clips/ を
 *   指したまま最後まで描き上がった（2026-09-10）。決定#082が掲げた
 *   「注意ではなく構造で分ける」が、**片方の経路にしか無い状態**だった。
 *
 * ★使わずに次の素材へ進めるのではなく**止める**。黙って別の映像に
 *   差し替わる方が危険で、出来上がった動画を見るまで誰も気づかない。
 */
const MARKETS = ["ja", "en"];
{
  const market = String(script.market || "").trim().toLowerCase();
  if (!MARKETS.includes(market)) {
    console.error(
      `target_market が不正です: ${JSON.stringify(script.market)}（${MARKETS.join(" / ")} のいずれか）`,
    );
    process.exit(1);
  }
  const other = MARKETS.filter((m) => m !== market);
  /** 同梱素材（スキームの無いパス）だけが対象。外部URLは部門を持たない */
  const bundled = (u) => typeof u === "string" && u && !/^(https?:|data:)/i.test(u);
  const wrongDir = (u) =>
    bundled(u) && other.some((m) => u.replace(/^\/+/, "").startsWith(`assets/${m}/`));

  const offenders = [];
  for (const [i, s] of script.scenes.entries()) {
    for (const key of ["backgroundUrl", "productUrl"]) {
      if (wrongDir(s[key])) offenders.push(`scenes[${i}].${key} = ${s[key]}`);
    }
  }
  for (const key of ["narrationUrl", "bgmUrl", "fontUrl"]) {
    if (wrongDir(script[key])) offenders.push(`${key} = ${script[key]}`);
  }
  if (offenders.length) {
    console.error(
      `部門の取り違えです。依頼は ${market} ラインですが、` +
        `${other.join("/")} 専用の素材を指しています:\n  ${offenders.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`部門: ${market} ライン（同梱素材の置き場所を確認しました）`);
}

/*
 * ★製品画像だけ data URI にして埋め込む（実測して直した）。
 *
 * 【何が起きたか】
 * 環境光（ambient）は、製品の形＝アルファでCSSマスクを切る。ところが
 * 別オリジンの画像をマスクに使うと Chrome が取得を拒否し（ERR_FAILED）、
 * 1本目の描画では**環境光が丸ごと効いていなかった**。
 * `<Img>` は表示できるのにマスクだけ失敗するので、絵を見ても気づきにくい。
 *
 * 【なぜ data URI か】
 * 同一オリジン扱いになるので、CORSの設定に依存しない。素材の置き場所が
 * Supabase Storage でもASPのCDNでも、こちら側だけで完結する。
 * 背景動画は大きいのでURLのまま（OffthreadVideo は別オリジンでも読める）。
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const toDataUri = async (url) => {
  if (!url || url.startsWith("data:")) return url;

  /*
   * ★スキームの無いパスは「リポジトリ同梱の素材」として扱う。
   *   ffmpeg版の download() が assets/... を受けるのと同じ約束にする。
   *   依頼側が2つの描画方式で違う書き方をしなくて済む。
   */
  let buf;
  let type = "image/png";
  if (!/^https?:\/\//i.test(url)) {
    /*
     * ★実在するパスはそのまま読む。
     *   前段（prepare_foreground_cli.py）が作った透過PNGは作業ディレクトリに
     *   置かれ、リポジトリの外を指すこともある。ここで弾くと、せっかく
     *   抜いた画像が使われず404になる（実測してこの順に直した）。
     *   リポジトリ相対の書き方も引き続き受ける。
     */
    const local = fs.existsSync(url) ? path.resolve(url) : path.resolve("..", url);
    if (!fs.existsSync(local)) {
      throw new Error(`前景の画像が見つかりません: ${url}`);
    }
    buf = fs.readFileSync(local);
    if (/\.jpe?g$/i.test(url)) type = "image/jpeg";
    if (/\.webp$/i.test(url)) type = "image/webp";
    return `data:${type};base64,${buf.toString("base64")}`;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`製品画像を取得できません: HTTP ${res.status} ${url}`);
  buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_INLINE_BYTES) {
    throw new Error(`製品画像が大きすぎます（${buf.byteLength}バイト）`);
  }
  type = res.headers.get("content-type") || "image/png";
  return `data:${type};base64,${buf.toString("base64")}`;
};

/*
 * ★音声もローカルのファイルなら data URI にする。
 *   <Audio> は file:// を読めず、public/ 経由も404になった（実測）ので、
 *   フォント・製品画像と同じ手筋に揃える。13秒のmp3で約100KB。
 */
const fileToDataUri = (p, mime) => {
  if (!p || /^(https?:|data:)/i.test(p)) return p;
  /*
   * ★★2026-09-05、実データで踏んだ不具合を直した。
   *   ワークフローは `cd remotion` してから描画するので、cwd はリポジトリの
   *   remotion/ になる。ところが narration.mp3 を作るのは1つ上の階層で、
   *   台本には相対パスのまま入っている。結果、
   *     音声が見つかりません（無音で続行）: narration.mp3
   *   となり、**音の無い動画が「成功」として出ていた**（実行#41）。
   *   落ちないので気づきにくい。製品画像（toDataUri）は既に1つ上も見て
   *   いたので、音声だけ取り残されていた。同じ探し方に揃える。
   */
  const local = fs.existsSync(p) ? p : path.resolve("..", p);
  if (!fs.existsSync(local)) {
    console.warn(`  音声が見つかりません（無音で続行）: ${p}`);
    return null;
  }
  const buf = fs.readFileSync(local);
  return `data:${mime};base64,${buf.toString("base64")}`;
};

/*
 * ★★BGMを選ぶ（決定#082の bgm:"random"）。**ffmpeg版から移した。**
 *
 * 【なぜ移す必要があったか】
 * 依頼側（process-job）は前から `bgm: "random"` を送っているが、
 * それを音源へ解決する処理は scripts/render_video.py にしか無かった。
 * Remotion版は `bgmUrl` しか見ないので、**`bgm` は黙って捨てられ、
 * 出来上がる動画にBGMが1曲も入っていなかった**（2026-09-10、実物で確認）。
 * 部門の検査と同じで、描画方式を移した時に一緒に移らなかったもの。
 *
 * ★★選び方は**種で固定する**（E-017）。同じジョブを描き直したら
 *   同じ曲でなければならない。乱数のまま選ぶと、再描画のたびに曲が
 *   変わり「前と違う動画」が出来てしまう。
 *   job_id から FNV-1a で種を作る（HookTelop の seedOf と同じ手筋）。
 */
const BGM_DIR = path.join("..", "assets", "shared", "bgm");
const seedOf = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

if (!script.bgmUrl && String(script.bgm || "").trim().toLowerCase() === "random") {
  let pool = [];
  try {
    pool = fs.readdirSync(BGM_DIR).filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f)).sort();
  } catch {
    pool = [];
  }
  if (pool.length) {
    /*
     * ★★2026-09-12、**ランダムをやめて「勢いのある曲」を選ぶ**（決定#132）。
     *
     *   オーナー指摘「BGMももっとテンション上がる曲に変更してください」。
     *   原因はランダム選択だった。5曲を実測（20秒の平均RMS）すると
     *     duru-rondo        9506  ← 一番勢いがある
     *     duru-arcade-vibe  7703
     *     duru-roomscene-lofi 5768
     *     hyak-ep4-blackhole  5735
     *     duru-ai-ep2-music   2691  ← 一番静か
     *   で **3.5倍の開き**があるのに、job_idの種次第で一番静かな曲が当たる。
     *   実際に前回の動画は 2691 の曲が鳴っていた。
     *
     *   ★アフィリエイトの尺の短い動画は**常に勢いが要る**。曲は「運」で
     *     決めるものではない。順位を固定で持ち、上から使う。
     *   ★それでも毎回同じ1曲だと飽きるので、**上位2曲**の中から job_id で
     *     選ぶ（決定性は保つ = E-017）。
     */
    const ENERGY_ORDER = [
      "duru-rondo.mp3",          // RMS 9506
      "duru-arcade-vibe.mp3",    // RMS 7703
      "duru-roomscene-lofi.mp3", // RMS 5768
      "hyak-ep4-blackhole.mp3",  // RMS 5735
      "duru-ai-ep2-music.mp3",   // RMS 2691
    ];
    const ranked = ENERGY_ORDER.filter((f) => pool.includes(f));
    // 順位表に載っていない曲（後から足した曲）は末尾へ。取りこぼさない
    const rest = pool.filter((f) => !ENERGY_ORDER.includes(f));
    const ordered = [...ranked, ...rest];
    const top = ordered.slice(0, Math.min(2, ordered.length));
    const pick = top[seedOf(String(script.jobId || script.job_id || "job")) % top.length];
    script.bgmUrl = path.join(BGM_DIR, pick);
    console.log(`BGMを選びました: ${pick}（勢いの上位${top.length}曲から・job_idで固定）`);
  } else {
    console.warn("assets/shared/bgm/ に音源がありません。BGM無しで続行します。");
  }
} else if (script.bgm && !script.bgmUrl) {
  // 曲名・パスを直接指定された回。同梱素材として扱う（ffmpeg版と同じ約束）
  script.bgmUrl = /^(https?:|data:|\/)/i.test(script.bgm)
    ? script.bgm
    : path.join("..", script.bgm);
}

for (const key of ["narrationUrl", "bgmUrl"]) {
  if (script[key]) {
    script[key] = fileToDataUri(script[key], "audio/mpeg");
  }
}
console.log(script.bgmUrl ? "BGM: あり" : "BGM: なし");

/*
 * ★効果音を「タグ」から「音源そのもの」へ直す（2026-09-05）。
 *   タグ名とファイル名は ffmpeg版（SFX_TAGS）と同じ約束にしてある。
 *   知らないタグ・見つからない音は**黙って落とす**。音が1つ無くても
 *   動画は成立するので、ここで描画を止める理由がない。
 */
/*
 * ★chord は2026-09-06に追加（オーナー指示「不協和音以外のジャーン！的な
 *   耳に入ってくる音」）。Cメジャーの和音なので**構造的に不協和音にならない**。
 * ★boom は2026-09-06に追加（オーナー指示「小さな爆発音」）。
 * ★neon は残してあるが、B（日本市場）の台本からは外した。Aが今も送って
 *   いる可能性があり、ここから消すと「効果音を渡したのに1つも読めない」
 *   検査に引っかかって描画ごと落ちるため。
 */
const SFX_TAGS = ["fire", "neon", "pop", "shock", "clean", "chord", "boom"];
if (Array.isArray(script.sfx) && script.sfx.length) {
  const before = script.sfx.length;
  script.sfx = script.sfx
    .filter((c) => SFX_TAGS.includes(c.tag))
    .map((c) => {
      const src = fileToDataUri(path.join("..", "assets", "shared", "sfx", `${c.tag}.mp3`), "audio/mpeg");
      return src ? { ...c, src } : null;
    })
    .filter(Boolean);
  console.log(
    script.sfx.length
      ? `効果音 ${script.sfx.length}個（${script.sfx.map((c) => c.tag).join(", ")}）`
      : "効果音なし",
  );
  /*
   * ★★鳴らすつもりだったのに1つも解決できなかったら**落とす**。
   *
   *   今日、無音の動画が「成功」として出た（E-010）。原因は
   *   **工程の成功で判定し、成果物で判定していなかった**こと。
   *   ここも同じ形をしている：音源が全部見つからなくても描画は完走し、
   *   ログを最後まで読まない限り誰も気づかない。
   *   1つでも残れば通す（音が1つ欠けても動画は成立する）。ゼロは設定ミス。
   */
  if (before > 0 && script.sfx.length === 0) {
    console.error(`効果音を${before}個受け取ったのに、1つも読み込めませんでした`);
    process.exit(1);
  }
}

for (const scene of script.scenes) {
  if (scene.kind !== "insitu" || !scene.productUrl) continue;
  try {
    scene.productUrl = await toDataUri(scene.productUrl);
    console.log("  製品画像を埋め込みました（CSSマスクのため）");
  } catch (e) {
    /*
     * ★埋め込めなかったら**製品ごと外す**。
     *   URLを残したまま描くと、Chromeが読めずに404になり、
     *   「製品が出ない」ではなく「フレームを取り出せない」で描画ごと落ちる。
     *   絵としては物足りなくなるが、動画は必ず出る方を選ぶ。
     */
    console.warn(`  製品画像を使えません（製品なしで続行）: ${e.message}`);
    scene.kind = "talk";
    scene.headline = scene.headline ?? "";
    delete scene.productUrl;
  }
}

/*
 * ★日本語フォントをリポジトリ同梱のTTFから埋め込む。
 *   ffmpeg版（libass）と同じファイルを使うので、書体が1バイトも違わない。
 *   ネットワークへ取りに行かないので、外部の障害で描画が落ちない。
 */
const FONT_BY_MARKET = {
  ja: "assets/ja/fonts/DelaGothicOne-Regular.ttf",
  en: "assets/en/fonts/Anton-Regular.ttf",
};

try {
  const rel = FONT_BY_MARKET[script.market] ?? FONT_BY_MARKET.ja;
  // remotion/ の1つ上がリポジトリの根
  const fontPath = path.resolve("..", rel);
  const buf = fs.readFileSync(fontPath);
  script.fontDataUri = `data:font/ttf;base64,${buf.toString("base64")}`;
  console.log(`フォント: ${rel}（${(buf.byteLength / 1024).toFixed(0)}KB）を埋め込みました`);
} catch (e) {
  // ★読めなくても描画は続ける。ただし書体が変わる事実は必ず残す
  console.warn(`フォントを読めませんでした（既定の書体で続行）: ${e.message}`);
  script.fontDataUri = null;
}

/*
 * ★リポジトリ同梱の素材（背景動画・BGM）を配る小さな口を立てる。
 *
 * 【なぜ必要か】
 * ffmpeg版は `assets/shared/neutral-gradient.mp4` のようなスキームの無い
 * パスをそのまま読める。Remotion（Chrome）はURLしか読めない。
 * 依頼側に2つの書き方をさせないため、こちら側で吸収する。
 *
 * 【なぜ data URI にしないのか】
 * 動画は数MBある。base64 は33%増えるうえ、inputProps に載せると
 * ブラウザへ丸ごと渡ることになる。ファイルはURLで渡す方が軽い。
 *
 * ★配るのはリポジトリの中だけ。`..` を含むパスは弾く。
 */
const repoRoot = path.resolve("..");
let assetServer = null;
let assetBase = "";

const localAssets = script.scenes.some(
  (s) => s.backgroundUrl && !/^(https?:|data:)/i.test(s.backgroundUrl),
);

if (localAssets) {
  const http = await import("node:http");
  assetServer = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "").replace(/^\/+/, "").split("?")[0]);
    const full = path.resolve(repoRoot, rel);
    if (!full.startsWith(repoRoot + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const mime = { ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".png": "image/png",
                   ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webm": "video/webm",
                   ".ttf": "font/ttf" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => assetServer.listen(0, "127.0.0.1", r));
  assetBase = `http://127.0.0.1:${assetServer.address().port}/`;
  for (const s of script.scenes) {
    if (s.backgroundUrl && !/^(https?:|data:)/i.test(s.backgroundUrl)) {
      s.backgroundUrl = assetBase + s.backgroundUrl.replace(/^\/+/, "");
    }
  }
  console.log(`同梱素材の配信口: ${assetBase}`);
}

/*
 * ★★品質の設定（決定#090）。
 *
 * 【なぜ描画側で決めるか】
 * 品質は「無料枠の残り」と「1本あたりの時間」で決まる話で、台本の内容
 * とは関係がない。依頼側（LLMの出力）に持たせると、台本の都合で画質が
 * 変わってしまう。**ここで一元的に決める。**
 *
 * RENDER_QUALITY=high  60fps / CRF 18 / モーションブラー有効
 *                low   30fps / CRF 23 / ブラー無し（従来）
 * 既定は low。**重い設定を既定にしない**（気づかないうちに枠を食う）。
 */
const quality = (process.env.RENDER_QUALITY || "low").toLowerCase();

/*
 * ★3段階にした。**実測で「blurだけが桁違いに重い」と分かったため。**
 *   4コア環境の実測（9秒の動画）:
 *     low  30fps ブラー無し   64秒（動画1秒あたり  7.11秒）
 *     high 60fps ブラー4      313秒（動画1秒あたり 34.83秒）← 4.9倍
 *   1フレームを4回描いて重ねるので当然だが、**60fpsとブラーを
 *   一緒くたにすると、どちらが重いのか分からなくなる**。分けた。
 */
const PRESETS = {
  low:  { fps: 30, crf: 23, jpeg: 90,  blur: 0, shutter: 180 },
  /*
   * ★std が本番の既定（決定#093）。30秒×30fps×12本 で月1,440分、
   *   無料枠2,000分に収まる。CRFだけ18へ上げる（符号化の負荷は軽く、
   *   フレーム描画の回数は増えないため、時間はほとんど変わらない）。
   *   60fpsは30秒構成だと月2,520分で枠を超えるので既定にしない。
   */
  std:  { fps: 30, crf: 18, jpeg: 100, blur: 0, shutter: 180 },
  mid:  { fps: 60, crf: 18, jpeg: 100, blur: 0, shutter: 180 },
  soft: { fps: 60, crf: 18, jpeg: 100, blur: 2, shutter: 150 },
  high: { fps: 60, crf: 18, jpeg: 100, blur: 4, shutter: 160 },
};
const preset = PRESETS[quality] ?? PRESETS.low;

script.fps = preset.fps;
script.quality = { blurSamples: preset.blur, shutterAngle: preset.shutter };
console.log(
  `品質: ${quality}（${preset.fps}fps / CRF${preset.crf} / ` +
    `ブラー${preset.blur === 0 ? "なし" : preset.blur + "サンプル"}）`,
);

const started = Date.now();
console.log(
  `台本: ${script.scenes.length}シーン / ${totalSeconds.toFixed(1)}秒 / ` +
    `${script.width}x${script.height}@${script.fps}`,
);

/*
 * ★publicDir を明示する。省くと public/ が配信されず、素材が
 *   すべて 404 になる（実測。エラーは「フレームを取り出せない」としか
 *   出ないので、原因にたどり着くのに時間がかかる）。
 *   同梱素材（BGM・効果音・フォント）をここから配る。
 */
const serveUrl = await bundle({
  entryPoint: path.resolve("src/index.ts"),
  publicDir: path.resolve("public"),
  onProgress: (p) => {
    if (p % 25 === 0) console.log(`  束ね中 ${p}%`);
  },
});

const composition = await selectComposition({
  serveUrl,
  id: "Main",
  inputProps: { script },
});

let lastLogged = -1;
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: outPath,
  inputProps: { script },
  /*
   * ★CRFは「小さいほど高画質・大きいファイル」。
   *   18 は視覚的にほぼ無劣化と言われる領域。23 は従来値（ffmpeg版と同じ）。
   *   ★ファイルが大きくなると TikTok へのアップロードも遅くなる。
   *     画質だけ見て決めない。
   */
  crf: preset.crf,
  jpegQuality: preset.jpeg,
  // ★並列数はランナーのコア数に任せる。固定すると2コアの無料ランナーで
  //   詰まるか、逆に使い切れない
  concurrency: null,
  onProgress: ({ progress }) => {
    const pct = Math.floor(progress * 100);
    if (pct >= lastLogged + 10) {
      lastLogged = pct;
      console.log(`  描画中 ${pct}%`);
    }
  },
});

if (assetServer) assetServer.close();

const elapsed = (Date.now() - started) / 1000;
const size = fs.statSync(outPath).size;
if (size < 10 * 1024) {
  console.error(`出力が小さすぎます（${size}B）。壊れています。`);
  process.exit(1);
}

console.log(
  `完成: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB / ` +
    `${totalSeconds.toFixed(1)}秒の動画 / 描画に ${elapsed.toFixed(1)}秒)`,
);
console.log(`実測: 動画1秒あたり ${(elapsed / totalSeconds).toFixed(2)} 秒かかった`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `render_seconds=${elapsed.toFixed(1)}\nbytes=${size}\n`,
  );
}
