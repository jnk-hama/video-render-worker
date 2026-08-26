/**
 * ===========================================================================
 * 29_Video.gs  —  動画（MP4）の取得とXへのチャンクアップロード
 * ===========================================================================
 *
 * ★なぜ動画か（オーナー指示 2026-08-20）
 *
 * バズ投稿はリンクを捨てる。残る武器はメディアだけで、
 * 画像より動画の方が滞在時間が伸びる。Xの表示回数は滞在に効く。
 *
 * ★画像と手順が違う
 *
 * 画像は1回のPOSTで終わるが、動画は4段階ある。
 *   INIT     … 総バイト数と形式を申告して media_id を取る
 *   APPEND   … 5MB以下ずつに切って順番に送る
 *   FINALIZE … 完了を伝える
 *   STATUS   … サーバ側の変換が終わるまで待つ（ここを飛ばすと投稿が失敗する）
 *
 * ★素材の出所（課金APIを増やさない）
 *
 *   1. Google Drive のフォルダ … オーナーがMP4を置く。最優先。費用0・完全に制御できる
 *   2. Pexels API              … 無料。キーがある時だけ使う
 *
 * MoneyPrinterTurbo で無料生成できることは実測済みだが（docs/A-TIKTOK-PLAN.md）、
 * GASからは実行できない。生成物をDriveへ置けば 1 の経路に乗る。
 *
 * ★仕様の根拠（2026-08-22に確認）
 *
 * docs.x.com 自体はこの環境から遮断されているが、公式の
 * Chunked Media Upload クイックスタートの内容を確認できた。正は：
 *   POST https://api.x.com/2/media/upload （multipart/form-data）
 *   command=INIT / media_type=video/mp4 / total_bytes / media_category
 * APPENDは5MB以下ずつ、FINALIZE後 processing_info があれば STATUS を待つ。
 *
 * ★★メディアには media.write スコープが要る（00_Config.gs）。
 * tweet.write だけだと本文は通るのにメディアだけ403で落ちる。
 * 数日これで詰まった。症状が「メディアだけ全滅」ならまずスコープを疑う。
 *
 * 専用エンドポイント形式（/initialize 等）も存在するが、
 * 公式が示すのは command= 形式なのでそちらを先に試す。
 *
 * ★失敗しても投稿は止めない
 * 動画が付かないことより、投稿が消える方が損失が大きい。
 * 全ての失敗経路は null を返し、呼び出し側は画像→文字だけ、と降りていく。
 */

/**
 * 動画添付を使うか。
 *
 * ★既定を「無効」に変えた（2026-08-21、オーナー指示）。
 * 自前でMP4をアップロードする経路は一切動かさない方針になったため。
 *
 * コードは消していない。参照投稿(31_RefPost.gs)が実際に伸びるかは
 * まだ分かっておらず、駄目だった時に戻せる状態を残しておく方が安い。
 * VIDEO_UPLOAD=1 にすれば従来どおり動く。
 */
function videoUploadEnabled_() {
  return String(getProp_('VIDEO_UPLOAD', '0')) === '1';
}

/**
 * 在庫から何本まで試すか。
 *
 * ★1本目のURLが死んでいただけで動画を諦めていた（2026-08-22）。
 * 素材CDNは個別ファイルが404や一時エラーになる。数本試せば通る。
 * 増やしすぎると1サイクルの実行時間を食うので3本まで。
 */
/*
 * ★3本→2本（2026-08-24）。
 * 「必ず1本出す」ために試行を増やしたが、1回の失敗ごとに
 * INIT/APPEND/FINALIZE ぶんのX API呼び出しが発生する。
 * 投稿0本のままクレジットが尽きた。取得失敗（CDN側）の救済には
 * 2本で足り、Xが拒否した場合は遮断器が即座に打ち切る。
 */
const VIDEO_STOCK_TRIES = 2;

/**
 * 1チャンクの大きさ。Xの上限は5MBなので手前で止める。
 *
 * ★GASの制約も効く。multipart で送る際にメモリ上へ展開されるため、
 * 大きくすると実行時間とメモリの両方を圧迫する。4MBは安全側。
 */
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * 扱う動画の上限。
 *
 * ★Xの上限（標準アカウントで512MB/140秒）よりずっと手前で切る。
 * GASの実行枠は6分で、その中で「取得→分割→複数回POST→変換待ち」を
 * 終える必要がある。大きいファイルは時間切れで中途半端に終わる。
 * バズ用の縦型ショートは通常2〜8MBなので、これで足りる。
 *
 * ★2026-08-22に15MB→32MBへ引き上げた。
 * 在庫60本すべてが「取得に失敗」していた回があり、上限が原因の
 * 却下を疑ったため。4MBずつ分割して送るので、32MBでも8回のPOSTで済む。
 * それでも超えるものは素材選択の段階で落とす（30_Stock.gs）。
 */
const VIDEO_MAX_BYTES = 32 * 1024 * 1024;

/** 変換待ちの上限。これを超えたら諦めて動画なしで出す。 */
const VIDEO_PROCESS_MAX_WAIT_MS = 60 * 1000;

/* ------------------------------------------------------------------ */
/* 素材の取得                                                           */
/* ------------------------------------------------------------------ */

/**
 * Driveのフォルダから未使用のMP4を1本選ぶ。
 *
 * ★同じ動画を続けて出さない。使ったファイルIDを記録して避ける。
 * 全部使い切ったら記録を消して先頭から回す（在庫切れで止めない）。
 *
 * @return {?{blob:!Object, name:string, bytes:number, source:string}}
 */
function pickDriveVideo_(accountKey) {
  const folderId = getProp_('VIDEO_FOLDER_' + String(accountKey).toUpperCase(), '') ||
                   getProp_('VIDEO_FOLDER', '');
  if (!folderId) return null;

  let files;
  try {
    files = DriveApp.getFolderById(folderId).getFilesByType('video/mp4');
  } catch (e) {
    console.warn('動画フォルダを開けません（動画なしで続行）: ' + truncate_(String(e), 120));
    return null;
  }

  const usedKey = 'video_used_' + String(accountKey).toUpperCase();
  let used = String(getProp_(usedKey, '')).split(',').filter(Boolean);

  const all = [];
  try {
    while (files.hasNext()) {
      const f = files.next();
      all.push({ id: f.getId(), file: f, size: f.getSize() });
    }
  } catch (e) {
    console.warn('動画一覧の取得で例外: ' + truncate_(String(e), 120));
  }
  if (!all.length) return null;

  let fresh = all.filter(function (x) { return used.indexOf(x.id) === -1; });
  if (!fresh.length) {
    // 一周した。記録を消して最初から回す
    fresh = all;
    used = [];
  }

  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  if (pick.size > VIDEO_MAX_BYTES) {
    console.warn('動画が大きすぎるため見送ります: ' +
                 Math.round(pick.size / 1024 / 1024) + 'MB');
    return null;
  }

  try {
    // 直近30件だけ覚える。無限に伸ばすとプロパティの上限に当たる
    used.push(pick.id);
    props_().setProperty(usedKey, used.slice(-30).join(','));
  } catch (e) {}

  try {
    return {
      blob: pick.file.getBlob(),
      name: pick.file.getName(),
      bytes: pick.size,
      source: 'drive'
    };
  } catch (e) {
    console.warn('動画を読めません: ' + truncate_(String(e), 120));
    return null;
  }
}

/**
 * Pexelsから縦型の短い動画を1本取る。キーが無ければ何もしない。
 *
 * ★Pexelsは無料でAPIキーの発行のみ。ライセンスは商用利用可・帰属不要。
 * 直接のMP4 URLを返すので、GASからそのまま取得できる。
 *
 * @return {?{blob:!Object, name:string, bytes:number, source:string}}
 */
function pexelsVideoUrl_(query) {
  const key = getProp_('PEXELS_API_KEY', '');
  if (!key) return null;
  // ★禁止語は投げる前に落とす（30_Stock.gs）。typeofで守らない理由も同上
  if (!stockQueryIsSafe_(query)) return null;

  const q = String(query || '').trim() || 'cinematic slow motion';
  const url = 'https://api.pexels.com/videos/search' +
              '?query=' + encodeURIComponent(q) +
              '&orientation=portrait&size=small&per_page=15';

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      headers: { Authorization: key },
      muteHttpExceptions: true
    });
  } catch (e) {
    console.warn('Pexelsへ到達できません: ' + truncate_(String(e), 100));
    return null;
  }
  if (res.getResponseCode() !== 200) {
    console.warn('Pexels HTTP ' + res.getResponseCode());
    return null;
  }

  let videos;
  try { videos = (JSON.parse(res.getContentText()) || {}).videos || []; }
  catch (e) { return null; }
  if (!videos.length) return null;

  // 短いものを優先する。長いとファイルが重く、GASの枠を食う
  const shortFirst = videos.filter(function (v) {
    return Number(v.duration || 0) > 0 && Number(v.duration) <= 30;
  });
  const pool = shortFirst.length ? shortFirst : videos;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  // 小さい順に見て、最初のMP4を使う
  const files = ((chosen && chosen.video_files) || [])
    .filter(function (f) { return /mp4/i.test(String(f.file_type || '')); })
    .sort(function (a, b) { return (a.width || 0) - (b.width || 0); });

  return files.length ? String(files[0].link) : null;
}

/** Pexelsの実写映像をそのまま取る（字幕を載せない場合の経路）。 */
function pickPexelsVideo_(query) {
  const url = pexelsVideoUrl_(query);
  if (!url) return null;
  const got = fetchVideoBlob_(url);
  if (got) got.source = 'pexels';
  return got;
}

/** URLからMP4を取ってくる。大きすぎ・形式違いは null。 */
/*
 * ★直前の取得失敗の理由。呼び出し側が「在庫をNGにしてよいか」を判断する。
 *
 * ★★2026-08-22、これが無かったせいで在庫を壊しかけた。
 * 取得失敗を全部「死んだURL」とみなしてNGにしていたが、実際には
 * 「こちらの上限を超えていた」「Content-Typeが octet-stream だった」
 * という自分側の都合による却下が混ざっていた。
 * 60本の在庫が systemic な理由で全部NGになる寸前だった。
 *
 * permanent:false のものは在庫から消してはいけない。
 */
let lastVideoFetchFailure_ = null;

function videoFetchFailure_() { return lastVideoFetchFailure_; }

function noteVideoFetchFail_(reason, permanent) {
  lastVideoFetchFailure_ = { reason: reason, permanent: !!permanent };
  console.warn('動画の取得に失敗（' + reason + ' / ' +
               (permanent ? '恒久的' : '一時的または設定都合') + '）');
  return null;
}

function fetchVideoBlob_(url) {
  lastVideoFetchFailure_ = null;

  const u = String(url || '').trim();

  /*
   * ★自前の貯蔵庫（35_Vault.gs）にあるものは、外部へ行かずDriveから読む。
   * 一度落としたものは無料で使い回せる。相手が消しても404にならない。
   */
  if (/^drive:/.test(u)) {
    const got = (typeof vaultBlob_ === 'function') ? vaultBlob_(u) : null;
    if (got) return got;
    // 貯蔵庫から消えていた。行ごと使えないので恒久的な失敗として扱う
    return noteVideoFetchFail_('貯蔵庫に見つかりません', true);
  }

  if (!/^https?:\/\/\S+$/i.test(u)) return noteVideoFetchFail_('URLの形式が不正', true);

  /*
   * ★Veoが返すURLはAPIキーが要る（2026-08-24）。
   * 素材CDNと同じ扱いで叩くと401になり、生成した動画が全部無駄になる。
   */
  const opts = { muteHttpExceptions: true, followRedirects: true };
  if (/generativelanguage\.googleapis\.com/.test(u)) {
    const k = (typeof youtubeApiKey_ === 'function') ? youtubeApiKey_() : '';
    if (k) opts.headers = { 'x-goog-api-key': k };
  }

  let res;
  try {
    res = UrlFetchApp.fetch(u, opts);
  } catch (e) {
    // 通信自体の失敗。相手が落ちているだけかもしれないので消さない
    return noteVideoFetchFail_('通信エラー: ' + truncate_(String(e), 80), false);
  }

  const code = res.getResponseCode();
  if (code !== 200) {
    // 404/410 はファイルが無い＝恒久的。5xx や 429 は相手の一時的な事情
    const permanent = (code === 404 || code === 410);
    return noteVideoFetchFail_('HTTP ' + code, permanent);
  }

  const blob = res.getBlob();
  const type = String(blob.getContentType() || '').toLowerCase();

  /*
   * ★Content-Type だけで弾かない。
   * 素材CDNは mp4 を application/octet-stream や binary/octet-stream で
   * 返すことがある。拡張子が .mp4 ならそちらを信じる。
   */
  const looksMp4 = /\.mp4(\?|$)/i.test(u);
  const typeOk = type.indexOf('mp4') !== -1 || type.indexOf('video') !== -1;
  const genericType = !type || type.indexOf('octet-stream') !== -1 ||
                      type.indexOf('binary') !== -1;
  if (!typeOk && !(genericType && looksMp4)) {
    return noteVideoFetchFail_('動画ではない (' + (type || '種別不明') + ')', true);
  }

  const bytes = blob.getBytes().length;
  if (bytes > VIDEO_MAX_BYTES) {
    /*
     * ★これは「こちらの上限」であって、ファイルが壊れているわけではない。
     * permanent:false にして在庫から消さない。上限を上げれば使える。
     */
    return noteVideoFetchFail_(
      '大きすぎる ' + Math.round(bytes / 1024 / 1024) + 'MB（上限 ' +
      Math.round(VIDEO_MAX_BYTES / 1024 / 1024) + 'MB）', false);
  }

  return { blob: blob, name: 'video.mp4', bytes: bytes, source: 'pexels' };
}

/**
 * ★URLで指定された動画から1本選ぶ。これが本命の経路。
 *
 * 【なぜDriveではなくURLか（2026-08-21に判明）】
 * appsscript.json の Drive権限は `drive.file` で、これは
 * 「このアプリが作った／開いたファイル」しか読めない。
 * オーナーが自分で作ったフォルダを getFolderById で開くことはできず、
 * pickDriveVideo_ は本番で必ず失敗する。
 *
 * 権限を広げれば直るが、oauthScopes を変えると再認証が必要になり、
 * 認証が済むまでトリガーが止まる。動画を1本足すために
 * 投稿全体を止めるのは割に合わない。
 *
 * UrlFetchApp は既に script.external_request を持っているので、
 * 公開URLから取るなら新しい権限は要らない。
 *
 *   VIDEO_URLS_A = https://.../a.mp4, https://.../b.mp4
 *
 * Googleドライブのファイルなら、共有を「リンクを知っている全員」にして
 *   https://drive.google.com/uc?export=download&id=<ファイルID>
 * の形にすれば直接取得できる（数MBのファイルなら確認画面を挟まない）。
 *
 * @return {?{blob:!Object, name:string, bytes:number, source:string}}
 */
function pickUrlVideo_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const urls = getListProp_('VIDEO_URLS_' + key, [])
    .concat(getListProp_('VIDEO_URLS', []))
    .filter(function (u) { return /^https?:\/\//i.test(String(u).trim()); });
  if (!urls.length) return null;

  // ★同じ動画を続けて出さない。使った順に記憶して避ける
  const usedKey = 'video_url_used_' + key;
  let used = String(getProp_(usedKey, '')).split('\n').filter(Boolean);

  let fresh = urls.filter(function (u) { return used.indexOf(u) === -1; });
  if (!fresh.length) { fresh = urls; used = []; }

  // 取得に失敗するURLがあっても、次の候補で回復する
  for (let i = 0; i < Math.min(3, fresh.length); i++) {
    const pickUrl = fresh[Math.floor(Math.random() * fresh.length)];
    const got = fetchVideoBlob_(pickUrl);
    if (got) {
      try {
        used.push(pickUrl);
        props_().setProperty(usedKey, used.slice(-30).join('\n'));
      } catch (e) {}
      got.source = 'url';
      return got;
    }
  }
  return null;
}

/**
 * バズ投稿用の動画を1本用意する。
 *
 * 順番は「人が止まる順」。
 *   1) 実写＋字幕 … 本命。実物が動いている映像に太い字幕
 *   2) 実写のみ   … Cloudinary未設定でも実写は出せる
 *   3) URL指定    … オーナーが用意した動画
 *   4) Drive      … 権限の都合で失敗しうる
 *
 * ★生成した抽象背景は候補から外した。作って見た結果、
 * 「文字カード」にしかならず、止まる理由にならなかったため。
 *
 * @return {?{blob:!Object, name:string, bytes:number, source:string}}
 */
function pickBuzzVideoAsset_(accountKey, query) {
  if (!videoUploadEnabled_()) return null;
  // ★上げられないと分かっているなら、素材のダウンロードもしない
  if (xCallsBlocked_(accountKey)) return null;

  /*
   * ★合成は一切しない（2026-08-22、オーナー指示）。
   *
   * 以前はCloudinaryで背景に文字を焼き込んでいた。あれはスパム動画で、
   * 実際に見て0点だった。生成・合成の経路は跡形なく消した。
   * 使うのは「外部の完成したMP4」か「URL参照」だけ。
   *
   * 順番は「人が選んだ順」。
   *   1) 在庫(VideoStock) … 人が見てNGを付けられる。最も確実
   *   2) URL指定          … オーナーが直接指定した動画
   *   3) Drive            … 権限の都合で失敗しうる
   */
  /*
   * ★1本目が取れなかっただけで在庫全体を諦めない（2026-08-22に改めた）。
   *
   * 以前は在庫から1本選び、その取得に失敗したら即座にURL指定へ落ちていた。
   * 素材CDNは個別のファイルが404や一時エラーになることがあり、
   * 「在庫は30本あるのに動画が付かない」がこれでも起きる。
   * 数本ぶん試し、駄目だった行はNGにして次から選ばれないようにする。
   */
  try { ensureStockLevel_(accountKey); }
  catch (e) { console.warn('在庫の補充に失敗: ' + truncate_(String(e), 120)); }

  /*
   * ★★在庫に噛み合う映像が1本も無いなら、その場で話題に合う映像を取る
   *   （2026-08-24）。
   *
   * 在庫は15個の固定検索語で先に貯めてある。話題は毎回違うので、
   * 「在庫のどれとも噛み合わない話題」が普通に来る。そこで
   * 使用回数だけで選ぶと、無関係な映像が付いて0点になる。
   *
   * Pexels/Pixabay は無料・商用可・帰属不要で、検索語をそのまま渡せる。
   * 1往復増えるだけなので、噛み合わない1本を出すより安い。
   * 取れなければ従来どおり在庫へ降りるので、「必ず1本出す」は壊さない。
   */
  if (query && !stockHasRelevant_(accountKey, query)) {
    const live = pickTopicVideo_(query);
    if (live) return live;
    console.log('話題に合う映像をその場で取れませんでした。在庫へ降ります: ' +
                truncate_(String(query), 60));
  }

  const tried = {};
  for (let attempt = 0; attempt < VIDEO_STOCK_TRIES; attempt++) {
    let picked = null;
    /*
     * ★★query を渡す（2026-08-24）。
     *
     * ここが「動画も0点」の正体だった。pickFromStock_ は引数を1つしか
     * 取らず、話題を一切見ずに使用回数だけで選んでいた。本文は
     * Geminiが話題について書き、映像は無関係な在庫。噛み合わない。
     * 引数として受け取っていた query は、この関数の中で使われず
     * 捨てられていた。
     */
    try { picked = pickFromStock_(accountKey, null, query); }
    catch (e) {
      console.warn('在庫から選べません: ' + truncate_(String(e), 120));
      break;
    }
    if (!picked) break;
    if (tried[picked.url]) break;          // 同じ行しか残っていない
    tried[picked.url] = true;

    const got = fetchVideoBlob_(picked.url);
    if (got) {
      /*
       * ★取得できた時だけ使用回数を増やす。
       * 失敗した行まで数えると、壊れた行が勝手に「使用済み」になり、
       * まだ使える行より新しく見えてしまう。
       */
      if (picked.row) { try { noteStockUsed_(picked.row); } catch (e) {} }
      got.source = 'stock';
      /*
       * ★★何が映っているかを一緒に返す（2026-08-24）。
       *
       * 在庫のQuery列は、その映像の文字どおりの説明である。
       * これを本文生成へ渡すと、Geminiは「実際に画面で起きていること」を
       * 前提に書ける。渡さないと、映像とは無関係な話題について書く。
       */
      got.describes = picked.query || '';
      got.width = picked.width || 0;
      return got;
    }

    /*
     * ★★NGにしてよいのは「ファイルが本当に無い」時だけ（2026-08-22）。
     *
     * 以前は失敗を全部NGにしていた。上限超過やContent-Type違いのような
     * 自分側の都合による却下まで消してしまうと、systemicな理由で
     * 在庫60本が全滅する。実際にその寸前だった。
     */
    const fail = videoFetchFailure_();
    const why = (fail && fail.reason) || '理由不明';
    if (fail && fail.permanent && picked.row) {
      console.warn('在庫の動画が存在しません（NGにします）: ' + truncate_(picked.url, 80));
      try { markStockNg_(picked.row, why); } catch (e) {}
    } else {
      console.warn('在庫の動画を今回は使えません（在庫は残します / ' + why + '）: ' +
                   truncate_(picked.url, 80));
    }
  }

  return pickUrlVideo_(accountKey) || pickDriveVideo_(accountKey);
}

/**
 * 在庫の中に、その話題と語が重なる映像があるか。
 *
 * ★無ければ在庫を漁っても無関係な映像しか出てこない。
 * その事実を先に知って、生の検索へ回す判断に使う。
 */
function stockHasRelevant_(accountKey, query) {
  const words = (typeof stockQueryWords_ === 'function') ? stockQueryWords_(query) : [];
  if (!words.length) return true;      // 手掛かりが無いなら在庫で構わない
  let list = [];
  try { list = freshStock_(accountKey) || []; } catch (e) { return true; }
  for (let i = 0; i < list.length; i++) {
    if (stockRelevance_(list[i].query, words) > 0) return true;
  }
  return false;
}

/**
 * 話題そのものを検索語にして、その場で1本取る。
 *
 * ★在庫を経由しない。在庫は「先に貯めた汎用素材」なので、
 * 今日の話題に噛み合う保証がそもそも無い。
 *
 * @return {?{blob:!Object, name:string, bytes:number, source:string,
 *            describes:string}}
 */
function pickTopicVideo_(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  const url = stockFootageUrl_(q);
  if (!url) return null;

  const got = fetchVideoBlob_(url);
  if (!got) {
    const f = videoFetchFailure_();
    console.warn('話題に合う映像を取得できませんでした（' +
                 ((f && f.reason) || '理由不明') + '）: ' + truncate_(url, 80));
    return null;
  }
  got.source = 'topic-live';
  got.describes = q;      // ★この語で引いたのだから、これが映っている
  return got;
}

/**
 * Pixabayから縦型の短い動画を取る。キーが無ければ何もしない。
 *
 * ★Pexelsと別に持つ理由：どちらも無料だが在庫が違う。
 * 片方が0件の検索語でももう片方に有ることがある。
 * ライセンスはどちらも商用利用可・帰属不要。
 *
 * @return {?{blob:!Object, name:string, bytes:number, source:string}}
 */
function pixabayVideoUrl_(query) {
  const key = getProp_('PIXABAY_API_KEY', '');
  if (!key) return null;
  if (typeof stockQueryIsSafe_ === 'function' && !stockQueryIsSafe_(query)) return null;

  const q = String(query || '').trim() || 'cinematic slow motion';
  const url = 'https://pixabay.com/api/videos/' +
              '?key=' + encodeURIComponent(key) +
              '&q=' + encodeURIComponent(q) +
              '&per_page=20&safesearch=true';

  let res;
  try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); }
  catch (e) {
    console.warn('Pixabayへ到達できません: ' + truncate_(String(e), 100));
    return null;
  }
  if (res.getResponseCode() !== 200) {
    console.warn('Pixabay HTTP ' + res.getResponseCode());
    return null;
  }

  let hits;
  try { hits = (JSON.parse(res.getContentText()) || {}).hits || []; }
  catch (e) { return null; }
  if (!hits.length) return null;

  const chosen = hits[Math.floor(Math.random() * hits.length)];
  const vids = (chosen && chosen.videos) || {};

  // 小さい順に見る。GASの実行枠を守るため大きいものは避ける
  const order = ['tiny', 'small', 'medium', 'large'];
  for (let i = 0; i < order.length; i++) {
    const v = vids[order[i]];
    if (v && v.url) return String(v.url);
  }
  return null;
}

/** Pixabayの実写映像をそのまま取る（字幕を載せない場合の経路）。 */
function pickPixabayVideo_(query) {
  const url = pixabayVideoUrl_(query);
  if (!url) return null;
  const got = fetchVideoBlob_(url);
  if (got) got.source = 'pixabay';
  return got;
}

/**
 * 実写のストック映像URLを1本取る。Pexels → Pixabay の順。
 *
 * ★ここが「バズ動画」の中身。
 * 手元のクローズアップ、使用中、変化の瞬間——止まる理由はここにある。
 * 生成した抽象パターンでは代替できないことを、実際に作って確認した。
 */
function stockFootageUrl_(query) {
  return pexelsVideoUrl_(query) || pixabayVideoUrl_(query);
}

/* ------------------------------------------------------------------ */
/* Xへのチャンクアップロード                                             */
/* ------------------------------------------------------------------ */

/**
 * INIT/APPEND/FINALIZE/STATUS を叩いて media_id を返す。
 *
 * ★どの段で失敗しても null を返す。例外は投げない。
 * 動画が付かないことは投稿を止める理由にならない。
 *
 * @return {?string} media_id
 */
function uploadVideoToX_(accountKey, asset) {
  if (!videoUploadEnabled_() || !asset || !asset.blob) return null;

  // ★Xが既に拒否しているなら、分割送信を始める前にやめる（2026-08-24）
  if (xCallsBlocked_(accountKey)) {
    console.warn('[' + accountKey + '] Xが受け付けない状態のため、動画のアップロードを行いません。');
    return null;
  }

  let token;
  try {
    const service = getXService_(accountKey);
    if (!service.hasAccess()) return null;
    token = service.getAccessToken();
  } catch (e) {
    console.warn('未連携のため動画を添付しません: ' + truncate_(String(e), 100));
    return null;
  }

  const auth = { Authorization: 'Bearer ' + token };
  const bytes = asset.blob.getBytes();

  /*
   * --- INIT ---
   * ★media_category は tweet_video を先に使う（通常の投稿に付ける動画）。
   * 公式のv2サンプルは amplify_video を載せており、どちらが通るか
   * 一次情報で確定できなかった。1往復増えるだけなので両方試す。
   */
  let mediaId = videoInit_(auth, bytes.length, 'video/mp4', 'tweet_video', accountKey);
  if (!mediaId && !xCallsBlocked_(accountKey)) {
    /*
     * ★遮断されていない時だけ2種類目を試す（2026-08-24）。
     * 402で断られた後に media_category を変えても当然通らない。
     * ここを見ずに再試行して、1回ぶん余計に課金されていた。
     */
    console.warn('tweet_video で INIT できなかったため amplify_video を試します。');
    mediaId = videoInit_(auth, bytes.length, 'video/mp4', 'amplify_video', accountKey);
  }
  if (!mediaId) return null;

  // --- APPEND ---
  let segment = 0;
  for (let offset = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES) {
    const slice = bytes.slice(offset, Math.min(offset + VIDEO_CHUNK_BYTES, bytes.length));
    const chunk = Utilities.newBlob(slice, 'application/octet-stream', 'chunk');
    if (!videoAppend_(auth, mediaId, segment, chunk)) {
      console.warn('動画のAPPENDに失敗（segment ' + segment + '）。動画なしで続行します。');
      return null;
    }
    segment++;
  }

  // --- FINALIZE ---
  const fin = videoFinalize_(auth, mediaId);
  if (!fin.ok) return null;

  // --- STATUS（変換待ち）---
  // ★processing_info がある間は投稿に使えない。ここを飛ばすと投稿側が失敗する
  if (fin.processing && !waitForVideoProcessing_(auth, mediaId)) return null;

  return mediaId;
}

/**
 * v2の2つの呼び方を順に試す。
 *
 * ★仕様を一次情報で確認できていないため（ファイル冒頭参照）、
 * `command=` 形式と専用エンドポイント形式の両方を用意した。
 * 最初に通った方を覚えて、以降はそちらだけを使う。
 */
const VIDEO_API_STYLE_PROP = 'video_api_style';

function videoApiStyle_() {
  return getProp_(VIDEO_API_STYLE_PROP, '');
}

function rememberVideoApiStyle_(style) {
  try { props_().setProperty(VIDEO_API_STYLE_PROP, style); } catch (e) {}
}

/**
 * INIT。成功したら media_id。
 *
 * ★media_type / media_category を引数に取る。
 * 参照実装では video→tweet_video、image→tweet_image、gif→tweet_gif と
 * 種別ごとに category を変えている。固定値にすると画像で使えない。
 */
function videoInit_(auth, totalBytes, mediaType, mediaCategory, accountKey) {
  const attempts = [];
  const style = videoApiStyle_();

  /*
   * ★★command= 形式を先に試す（2026-08-22、公式ドキュメントで再訂正）。
   *
   * 公式の Chunked Media Upload クイックスタートが示す形は
   *   POST https://api.x.com/2/media/upload
   *   multipart/form-data で command=INIT / media_type / total_bytes /
   *   media_category
   * であり、これが正。
   *
   * 2026-08-21に「専用エンドポイントが正」と判断して順序を逆にしたが、
   * その根拠は node のライブラリ実装を読んだだけで、公式仕様を
   * 確認していなかった。開発者フォーラムには専用エンドポイント側の
   * 不具合報告もある。ライブラリではなく一次情報に合わせる。
   *
   * 専用エンドポイントは保険として後ろに残す（将来こちらへ寄る可能性）。
   */
  if (style !== 'endpoint') {
    attempts.push({
      style: 'command',
      url: X_MEDIA_UPLOAD_URL,
      options: {
        method: 'post',
        headers: auth,
        payload: {
          command: 'INIT',
          media_type: mediaType,
          media_category: mediaCategory,
          total_bytes: String(totalBytes)
        },
        muteHttpExceptions: true
      }
    });
  }
  if (style !== 'command') {
    attempts.push({
      style: 'endpoint',
      url: X_MEDIA_UPLOAD_URL + '/initialize',
      options: {
        method: 'post',
        contentType: 'application/json',
        headers: auth,
        payload: JSON.stringify({
          media_type: mediaType,
          media_category: mediaCategory,
          total_bytes: totalBytes
        }),
        muteHttpExceptions: true
      }
    });
  }

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    let res;
    try { res = UrlFetchApp.fetch(a.url, a.options); }
    catch (e) { continue; }

    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code !== 200 && code !== 201 && code !== 202) {
      console.warn('動画INIT ' + a.style + ' が HTTP ' + code + ': ' + truncate_(body, 160));
      /*
       * ★★401/402/403/429 なら形式を変えても通らない（2026-08-24）。
       * ここで打ち切らないと、もう一方の形式・次の素材・次の候補…と
       * 叩き続けて残高だけ溶ける。実際に402で尽きた。
       */
      if (noteXRefusal_(accountKey, code, 'メディアINIT')) return null;
      continue;
    }
    const id = parseMediaId_(body);
    if (id) {
      rememberVideoApiStyle_(a.style);
      return id;
    }
  }
  return null;
}

/** APPEND。1チャンク送る。 */
function videoAppend_(auth, mediaId, segmentIndex, chunkBlob) {
  const style = videoApiStyle_();
  const url = style === 'endpoint'
    ? X_MEDIA_UPLOAD_URL + '/' + encodeURIComponent(mediaId) + '/append'
    : X_MEDIA_UPLOAD_URL;

  const payload = style === 'endpoint'
    ? { segment_index: String(segmentIndex), media: chunkBlob }
    : {
        command: 'APPEND',
        media_id: String(mediaId),
        segment_index: String(segmentIndex),
        media: chunkBlob
      };

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: auth,
      payload: payload,           // multipart/form-data はGASが組み立てる
      muteHttpExceptions: true
    });
  } catch (e) {
    console.warn('動画APPENDで通信エラー: ' + truncate_(String(e), 120));
    return false;
  }

  const code = res.getResponseCode();
  // APPEND は本文なしの 204 を返すことがある
  if (code === 200 || code === 201 || code === 204) return true;
  console.warn('動画APPENDが HTTP ' + code + ': ' + truncate_(res.getContentText(), 160));
  return false;
}

/** FINALIZE。変換が要るかどうかも返す。 */
function videoFinalize_(auth, mediaId) {
  const style = videoApiStyle_();
  const url = style === 'endpoint'
    ? X_MEDIA_UPLOAD_URL + '/' + encodeURIComponent(mediaId) + '/finalize'
    : X_MEDIA_UPLOAD_URL;

  const options = style === 'endpoint'
    ? { method: 'post', headers: auth, muteHttpExceptions: true }
    : {
        method: 'post',
        headers: auth,
        payload: { command: 'FINALIZE', media_id: String(mediaId) },
        muteHttpExceptions: true
      };

  let res;
  try { res = UrlFetchApp.fetch(url, options); }
  catch (e) {
    console.warn('動画FINALIZEで通信エラー: ' + truncate_(String(e), 120));
    return { ok: false, processing: false };
  }

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200 && code !== 201 && code !== 202) {
    console.warn('動画FINALIZEが HTTP ' + code + ': ' + truncate_(body, 160));
    return { ok: false, processing: false };
  }

  let parsed = {};
  try { parsed = JSON.parse(body) || {}; } catch (e) {}
  const info = parsed.processing_info || (parsed.data && parsed.data.processing_info);
  return { ok: true, processing: !!info };
}

/**
 * 変換の完了を待つ。
 *
 * ★check_after_secs を守る。短い間隔で叩くとレート制限に当たる。
 * GASの実行枠(6分)を食い潰さないよう、上限も別に設ける。
 *
 * @return {boolean} 使える状態になったか
 */
function waitForVideoProcessing_(auth, mediaId) {
  const style = videoApiStyle_();
  const deadline = Date.now() + VIDEO_PROCESS_MAX_WAIT_MS;
  let waitMs = 3000;

  while (Date.now() < deadline) {
    Utilities.sleep(waitMs);

    /*
     * ★STATUS だけは専用エンドポイントが無い（2026-08-21 訂正）。
     * 参照実装でも GET media/upload?command=STATUS&media_id=... の1形式のみ。
     * 以前は endpoint 形式の時に /{id}?command=STATUS を叩いており、
     * 変換待ちが必ず失敗していた（＝動画が1本も付かない）。
     */
    const url = X_MEDIA_UPLOAD_URL +
                '?command=STATUS&media_id=' + encodeURIComponent(mediaId);

    let res;
    try { res = UrlFetchApp.fetch(url, { headers: auth, muteHttpExceptions: true }); }
    catch (e) { return false; }

    if (res.getResponseCode() !== 200) {
      console.warn('動画STATUSが HTTP ' + res.getResponseCode());
      return false;
    }

    let parsed = {};
    try { parsed = JSON.parse(res.getContentText()) || {}; } catch (e) { return false; }

    const info = parsed.processing_info || (parsed.data && parsed.data.processing_info);
    if (!info) return true;                       // 変換情報が消えた＝完了

    const state = String(info.state || '');
    if (state === 'succeeded') return true;
    // pending / in_progress は待つ。参照実装も同じ2状態を待機扱いにしている
    if (state === 'failed') {
      console.warn('動画の変換に失敗: ' + truncate_(JSON.stringify(info.error || {}), 160));
      return false;
    }
    waitMs = Math.max(2000, (Number(info.check_after_secs) || 3) * 1000);
  }

  console.warn('動画の変換が時間内に終わりませんでした。動画なしで続行します。');
  return false;
}

/** 応答から media_id を取り出す。v2/v1.1のどちらの形でも拾う。 */
function parseMediaId_(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return null; }
  if (!parsed) return null;
  const id = (parsed.data && (parsed.data.id || parsed.data.media_id_string)) ||
             parsed.media_id_string || parsed.id || parsed.media_key;
  return id ? String(id) : null;
}
