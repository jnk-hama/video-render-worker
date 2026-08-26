/**
 * ===========================================================================
 * 19_Sources.gs  —  X以外から話題を見つけて、コメント付きで紹介する
 * ===========================================================================
 * Xの検索は使えるかどうかがアクセス階層に依存し、
 * 第三者投稿の引用は権限で禁止されている（403で実測済み）。
 * そこで話題の入口をX以外へ広げる。
 *
 * 【なぜこれはXの引用の件と別なのか】
 * Xは「自分が言及された投稿か自分が書いた投稿しか引用できない」と
 * 明示的に制限している。そこをURLで迂回するのは制御を潰す行為になる。
 *
 * 一方、YouTubeの動画やニュース記事にリンクすることには
 * そういう制限が存在しない。ただのリンクであり、誰もが日常的にやっている。
 * 迂回すべき制限が無いのだから、迂回にはならない。
 *
 * 【対応する情報源】
 *   YouTube … Data API v3。公開データ取得のために用意された正規のAPI
 *   RSS     … 読まれるために公開されているフィード。APIキーもクォータも不要
 *
 * Instagramは対応しない。Graph APIは自分が管理するアカウントしか扱えず、
 * 他人の公開投稿を検索する手段が提供されていない
 * （Basic Display APIは2024年12月に廃止）。
 * スクレイピングは規約違反なので行わない。
 *
 * 【画像を自前で添付しない理由】
 * サムネイルや商品画像は他人の著作物。ダウンロードして再アップロードすると
 * 複製になる。URLを貼れば各プラットフォームがカードを展開してくれるので、
 * 見た目の目的は達成でき、複製もしない。そちらを使う。
 */

/* ------------------------------------------------------------------ */
/* 設定                                                                 */
/* ------------------------------------------------------------------ */

/**
 * YouTubeの検索条件。アカウントごとに複数持ち、実行のたびに切り替える。
 * minViews は取得後にコード側で判定する。
 */
const YOUTUBE_QUERIES = {
  'A': [
    // ★日本発の商材を先頭に置く。このアカウントの強みなので優先して回す。
    { key: 'JPRODUCT', minViews: 30000, q: 'made in japan products worth buying' },
    { key: 'JCRAFT',   minViews: 20000, q: 'japanese kitchen knife stationery review' },
    // --- A: 引用の28ジャンルに合わせて広げた（2026-08-18）---
    { key: 'GADGET',   minViews: 50000, q: 'desk setup gadget review' },
    { key: 'TECH',     minViews: 50000, q: 'usb-c dock hub review' },
    { key: 'WORKFLOW', minViews: 30000, q: 'automation workflow tools' },
    { key: 'CRAFT',    minViews: 30000, q: 'workshop craftsmanship how it is made' },
    { key: 'FORGE',    minViews: 30000, q: 'knife making forging process' },
    { key: 'WOOD',     minViews: 30000, q: 'woodworking joinery hand tools' },
    { key: 'RESTORE',  minViews: 30000, q: 'restoration before and after repair' },
    { key: 'DENIM',    minViews: 20000, q: 'raw denim selvedge fades review' },
    { key: 'LEATHER',  minViews: 20000, q: 'leather boots goodyear welt review' },
    { key: 'EDC',      minViews: 30000, q: 'everyday carry pocket dump' },
    { key: 'WATCH',    minViews: 30000, q: 'mechanical watch movement review' },
    { key: 'KITCHEN',  minViews: 30000, q: 'kitchen knife sharpening whetstone' },
    { key: 'COFFEE',   minViews: 30000, q: 'espresso grinder coffee gear review' },
    { key: 'CAMERA',   minViews: 30000, q: 'film camera vintage lens review' },
    { key: 'AUDIO',    minViews: 30000, q: 'turntable hifi speaker review' },
    { key: 'DESIGN',   minViews: 20000, q: 'industrial design product teardown' },
    { key: 'JAPAN',    minViews: 20000, q: 'made in japan craftsmanship workshop' }
  ],

  /*
   * ★Bは成人・同人の錨を必ず付ける（2026-08-18、オーナー指摘）。
   *
   * 'buying from japanese online store guide' のような一般の通販動画を
   * 拾うクエリを置いていたため、フィギュア転送サービスの解説など
   * ジャンル外の動画に反応する余地があった。
   * YouTube側に成人向けそのものは無いので、狙うのは
   * 同人・エロゲ・DLsite/FANZAの「文化と買い方」の側。
   */
  /*
   * ★2026-08-18、自動投稿を引用・反応のみに切り替えたので本数を増やした。
   *
   * 引用だけで回すなら、材料の数がそのまま投稿できる回数になる。
   * 4本では1日4本のペースに足りない（同じ動画は二度使わないため）。
   *
   * 錨は外さない。全て同人・エロゲ・成人向け商流のいずれかに紐づける。
   * 一般のアニメ・日本紹介系に広げると、買う気のない読者しか集まらない
   * （2026-08-17にRSSで実際にそうなり、翌日フィードごと外した）。
   *
   * minViews は低めにしてある。この分野の解説動画は本数自体が少なく、
   * 3万再生を求めると候補がゼロになる。
   */
  'B': [
    { key: 'DOUJIN',    minViews: 10000, q: 'doujin circle comiket culture explained' },
    { key: 'EROGE',     minViews: 10000, q: 'eroge visual novel review japanese' },
    { key: 'DLSITE',    minViews: 5000,  q: 'DLsite how to buy doujin guide' },
    { key: 'SCENE',     minViews: 10000, q: 'japanese adult game industry explained' },
    { key: 'VN',        minViews: 5000,  q: 'japanese visual novel recommendations adult' },
    { key: 'FANBOX',    minViews: 5000,  q: 'pixiv fanbox fantia support japanese artist' },
    { key: 'ASMR',      minViews: 5000,  q: 'japanese voice work asmr doujin explained' },
    { key: 'IMPORT',    minViews: 5000,  q: 'buying japanese doujin games from overseas' },
    { key: 'CENSOR',    minViews: 5000,  q: 'japan censorship adult games explained' },
    { key: 'TRANSLATE', minViews: 5000,  q: 'untranslated japanese games fan translation' },
    { key: 'MARKET',    minViews: 5000,  q: 'comiket doujinshi market how it works' },
    { key: 'ARTIST',    minViews: 5000,  q: 'japanese doujin artist interview process' }
  ]
};

/**
 * RSSフィード。
 *
 * ★Aには既定を入れてある。理由は「設定しないと何も動かない」を避けるため。
 * YouTubeはAPIキーの発行が要るが、RSSは何も要らない。
 * ここに既定があれば、キーが無い状態でも情報源として機能する。
 *
 * ⚠️ これらのURLはこの環境から疎通確認できていない（ネットワーク制限）。
 * 死んでいるフィードは自動でスキップされ、投稿は止まらない。
 * どれが生きているかは「情報源診断」で確認できる。
 *
 * 差し替えはスクリプトプロパティ RSS_FEEDS_A / RSS_FEEDS_B に
 * カンマ区切りで入れる（再デプロイ不要。既定は使われなくなる）。
 *
 * Bは空のまま。日本の同人・成人向けを英語で扱う手頃なフィードに
 * 心当たりが無く、当てずっぽうで選ぶと変な情報源を掴む。
 * Bは自前の話題在庫（DEFAULT_TOPICS_B）で回す。
 */
/*
 * ★2026-08-16、hnrss.org/frontpage を一度外し、同日中に条件を変えて戻した。
 *
 * 【外した理由】200pt以上のしきい値だけでは、技術論・論評・資金調達の記事が
 * 中心になり、商品レビューはほとんど流れてこなかった。実際にAI安全保障の
 * 論評（The Verge のコラム）が選ばれて感想を書いていた。読んだ人が何かを
 * 買うことは無い。
 *
 * 【戻した理由】「バズっている記事に反応したい」という要望に対し、
 * 支持数（points）は他のニュースサイトのRSSには無い「実際に読者が
 * 反応した」という数値の裏付けであり、他のフィードには無い強みになる。
 * 外した本当の原因はしきい値ではなく話題の質だった。その質のほうは
 * 今日 productRelevance_（買い物に繋がるかの判定）で選別する仕組みが
 * 追加済みなので、しきい値を上げた上でHNも戻し、二重で絞る。
 *
 * しきい値は 200 → 300 に引き上げた。より狭く、より確実にバズっている
 * ものだけを対象にする。
 *
 * 残した4つも総合ニュースを含むため、フィードの選択だけでは足りない。
 * 取得後に productRelevance_ で選別している。
 *
 * ⚠️ 差し替え候補のURLをこちらで検証できていない（ネットワーク制限）。
 * 存在しないURLを推測で入れると黙ってフィードが1本死ぬので、
 * 疎通を確認できないURLは追加していない。
 * ガジェット専門フィードに替えたい場合は RSS_FEEDS_A に入れてください
 * （再デプロイ不要。既定は使われなくなります）。
 */
/*
 * ★2026-08-17、「疎通を確認できないURLは足さない」という運用ルールをやめた。
 *
 * あのルールは「死んだフィードに気づけない」ことへの予防だったが、
 * 予防としては効いていなかった。追加時に1回確かめても、
 * 配信終了やURL変更で後から死ぬ場合は素通りするうえ、
 * 失敗は console.warn だけでGASのコンソールは誰も見ない。
 * 実際に既存の4フィードも同じ穴の上に乗っていた。
 *
 * 代わりに死活監視を入れた（recordRssResult_ / notifyDeadFeeds_）。
 * 3回連続で失敗したフィードはLINEに名指しで出る。
 * 壊れたら分かるので、未確認のURLでも入れてよくなった。
 * 生きているフィードは他が死んでも通常どおり動く。
 *
 * ★視野を広げた（オーナー指摘）。
 * 変更前のAは Ars/Engadget/Verge/HN の米テックニュースだけで、
 * 「物・作り・道具」を扱う媒体が1つも無かった。
 * ニュースは論評しか流れず、読んでも誰も何も買わない。
 * Bに至ってはフィードが空で、Web側の情報源が存在しなかった。
 *
 * 差し替えは RSS_FEEDS_A / RSS_FEEDS_B（再デプロイ不要）。
 */
const DEFAULT_RSS_FEEDS = {
  'A': [
    // --- 作る・直す・道具 ---
    'https://hackaday.com/feed/',
    'https://makezine.com/feed/',
    /* core77 は HTTP 404（2026-08-18、死活監視が検出）。外した */
    'https://www.thisiscolossal.com/feed/',

    // --- デザイン・建築・物 ---
    /* dezeen はXMLとして解釈できない応答（SAXParseException）。外した */
    'https://design-milk.com/feed/',
    'https://www.designboom.com/feed/',

    // --- 買う物・ギア ---
    /* uncrate は HTTP 404。外した */
    'https://www.gearpatrol.com/feed/',
    'https://carryology.com/feed/',
    'https://hodinkee.com/articles/rss',

    // --- 従来のテック系（受け皿）---
    'https://feeds.arstechnica.com/arstechnica/gadgets',
    'https://www.engadget.com/rss.xml',
    'https://www.theverge.com/rss/index.xml',
    'https://hnrss.org/frontpage?points=300'
  ],

  // ★日本の作り手・作品文化。成人向けそのものではなく
  // 「シーンの構造」を語る材料として使う（SFWな媒体で揃える）。
  /*
   * ★Bのフィードは空にした（2026-08-17に入れて翌日外した）。
   *
   * Anime News Network / SoraNews24 / Otaku Mode / Crunchyroll を入れたが、
   * どれも一般のアニメ・日本ニュースで、Bのジャンル（成人・同人の案内）と
   * 噛み合わなかった。配信情報や日本の小ネタに反応するアカウントは、
   * 買う気のある読者を集めない。
   *
   * 成人・同人シーンを扱うRSSで、安定して読めるものが見つかっていない。
   * 見つかるまでBはX検索（引用）だけで回す。
   * 的外れな投稿を出すより、その回を見送る方がよい。
   *
   * 追加する場合は RSS_FEEDS_B に入れれば再デプロイ不要で有効になる。
   * 死んでいれば死活監視が3サイクル以内に知らせる。
   */
  /*
   * ★2026-08-18、Bにフィードを戻した。
   *
   * 【外した経緯】2026-08-17にAnime News Network / SoraNews24 等を入れたが、
   * 一般のアニメ・日本ニュースでBのジャンルと噛み合わず、翌日外した。
   * 配信情報や日本の小ネタに反応しても、買う気のある読者は集まらない。
   *
   * 【戻す理由】自動投稿を引用・反応のみに切り替えた（POST_MODE=quote）。
   * 材料が無いと1本も出せない。実際、Bは引用0本のまま止まっていた。
   *
   * 【今回の選び方】一般ニュースではなく、同人・エロゲ・成人向け商流を
   * 扱う媒体だけにした。ジャンルの錨を外さないことを最優先にしている。
   *
   * ⚠️ これらのURLはこの環境から疎通確認できていない（ネットワーク制限）。
   * 死んでいれば recordRssResult_ の死活監視が3サイクル以内に名指しで
   * 知らせる。そこで外すか差し替える。
   * 疎通しないフィードがあっても投稿は止まらない（スキップされるだけ）。
   *
   * 差し替えは RSS_FEEDS_B（再デプロイ不要）。
   */
  'B': [
    // 同人・インディーゲームの流通を扱う媒体
    'https://www.gamedeveloper.com/rss.xml',
    // 日本のゲーム・オタク商流（英語）
    'https://automaton-media.com/en/feed/',
    // ビジュアルノベル／アドベンチャー中心
    'https://vndb.org/feeds/announcements.atom'
  ]
};

function rssFeeds_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  /*
   * ★YouTubeのチャンネルRSSも同じ経路で読む（2026-08-18）。
   * 認証もクォータも要らないので、Data APIが403でも材料が途切れない。
   * YT_CHANNELS_A / YT_CHANNELS_B にチャンネルIDを入れるだけで増える。
   */
  return getListProp_('RSS_FEEDS_' + key, DEFAULT_RSS_FEEDS[key] || [])
    .concat(youtubeRssFeeds_(key));
}

/** 発見した話題を記録するシート。二度同じものを紹介しないため。 */
const SOURCES_SHEET_NAME = 'Sources';
const SOURCES_HEADERS = ['Timestamp', 'Account', 'Source', 'Item URL', 'Title',
                         'Posted Text', 'Post ID'];

/** 同じ発見元を何件分さかのぼって重複判定するか。 */
const SOURCES_HISTORY_KEEP = 500;

/** 何日以内に公開されたものを対象にするか。古い話題は伸びない。 */
const SOURCE_MAX_AGE_DAYS = 14;

/* ------------------------------------------------------------------ */
/* 記録                                                                 */
/* ------------------------------------------------------------------ */

function getOrCreateSourcesSheet_(ss) {
  const spreadsheet = ss || openLogSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(SOURCES_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SOURCES_SHEET_NAME);
    sheet.getRange(1, 1, 1, SOURCES_HEADERS.length).setValues([SOURCES_HEADERS]);
    sheet.getRange(1, 1, 1, SOURCES_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  ensureTrailingHeaders_(sheet, SOURCES_HEADERS);
  return sheet;
}

/** 既に紹介したURLの集合を返す。 */
function readUsedSourceUrls_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const from = Math.max(2, lastRow - SOURCES_HISTORY_KEEP + 1);
  const values = sheet.getRange(from, 1, lastRow - from + 1, 4).getValues();

  const used = {};
  values.forEach(function (r) {
    const u = String(r[3] || '').trim();
    if (u) used[u] = true;
  });
  return used;
}

function rememberSource_(sheet, entry) {
  sheet.appendRow([
    new Date(), entry.account, entry.source, entry.url,
    truncate_(entry.title || '', 200),
    truncate_(entry.postedText || '', 300), entry.postId || ''
  ]);
}

/* ------------------------------------------------------------------ */
/* YouTube                                                              */
/* ------------------------------------------------------------------ */

/**
 * YouTubeのAPIキー。
 *
 * ★★2026-08-24、実機ログで確定した不具合を修正した。
 *
 * 【何が起きていたか】
 * 診断に毎回 `YouTube: HTTP401` が出ていた。Google側の障害でも
 * 制限でもなく、こちらが **Geminiのキーを YouTube Data API へ
 * 送っていた**。以前の実装は
 *   YOUTUBE_API_KEY || GEMINI_API_KEY || LLM_API_KEY
 * と代用していた。「同じGoogle Cloudプロジェクトなら通ることが多い」
 * という想定で書かれていたが、実機では通らなかった。
 *
 * 【なぜ代用してはいけないか】
 * 未設定なら「未設定」と出るべきである。別のキーを送ると、
 * 画面には 401 と出る。401は「キーが拒否された」という意味なので、
 * 読んだ人は Google 側を疑い、本当の原因（キーを作っていない）へ
 * 辿り着けない。実際、Redditの403と並んで表示され、
 * 「材料源が両方死んでいる」ことの原因究明を丸一日遅らせた。
 *
 * 親切のつもりの代用は、原因を隠すという形で必ず高くつく。
 */
function youtubeApiKey_() {
  return getProp_('YOUTUBE_API_KEY', '');
}

/** 次に使うYouTubeの検索条件。順番に回す。 */
function nextYoutubeQuery_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const list = YOUTUBE_QUERIES[key];
  if (!list || !list.length) return null;
  if (list.length === 1) return list[0];

  const prop = 'yt_query_' + key;
  const n = Number(getProp_(prop, '0')) || 0;
  try { props_().setProperty(prop, String((n + 1) % list.length)); } catch (e) {}
  return list[n % list.length];
}

/**
 * YouTubeから最近伸びている動画を探す。
 *
 * search.list は 100 ユニット、videos.list は 1 ユニット。
 * 無料枠は 10,000 ユニット/日なので、1日100回まで検索できる。
 * 2時間ごとでも12回なので十分に収まる。
 *
 * @return {Array<Object>}
 */
function fetchYouTubeCandidates_(accountKey, report) {
  /*
   * ★report は診断用の受け皿（省略可）。
   *
   * 「0件」とだけ出しても、キーが無いのか・403なのか・検索が空なのか・
   * 再生数で全部落ちたのかが分からない。実際にAで 0件 のまま
   * 原因を特定できない時間が続いた。
   * 通常の呼び出しでは何も渡さないので、動作は変わらない。
   */
  const rep = report || {};
  const key = String(accountKey || '').toUpperCase();
  const apiKey = youtubeApiKey_();
  if (!apiKey) {
    rep.reason = 'APIキーが未設定';
    console.warn('YOUTUBE_API_KEY が未設定のため、YouTube検索はスキップします。');
    return [];
  }
  /*
   * ★流用の印は消した（2026-08-24）。
   *   youtubeApiKey_() が他サービスのキーを代用しなくなったので、
   *   ここへ来た時点でキーは YOUTUBE_API_KEY 由来しかありえない。
   *   使われない旗を残すと、参照側(下の診断)が永久に嘘を出す。
   */

  const pat = nextYoutubeQuery_(key);
  if (!pat) {
    rep.reason = '検索条件が1件も定義されていない';
    return [];
  }
  rep.query = pat.q;
  rep.minViews = pat.minViews;

  const publishedAfter = new Date(Date.now() - SOURCE_MAX_AGE_DAYS * 86400000).toISOString();

  const searchUrl = 'https://www.googleapis.com/youtube/v3/search?' + [
    'part=snippet',
    'type=video',
    'order=viewCount',
    'relevanceLanguage=en',
    'maxResults=10',
    'publishedAfter=' + encodeURIComponent(publishedAfter),
    'q=' + encodeURIComponent(pat.q),
    'key=' + encodeURIComponent(apiKey)
  ].join('&');

  let res;
  try {
    res = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true });
  } catch (e) {
    console.error('YouTube検索で通信エラー: ' + e);
    return [];
  }

  const code = res.getResponseCode();
  const body = res.getContentText();

  rep.httpCode = code;
  if (code !== 200) {
    rep.reason = 'HTTP ' + code + ': ' + truncate_(body.replace(/\s+/g, ' '), 120);
    console.error('YouTube検索エラー ' + code + ': ' + truncate_(body, 300));
    if (code === 403) {
      notifyAdmin_('⚠️ YouTube Data API が403です。\n' +
                   'APIキーの権限、または YouTube Data API v3 が\n' +
                   'Google Cloud で有効になっているか確認してください。\n' +
                   truncate_(body, 200));
    }
    return [];
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return []; }

  const items = (parsed.items || []).filter(function (it) {
    return it && it.id && it.id.videoId;
  });
  rep.rawCount = items.length;
  if (!items.length) {
    rep.reason = '検索結果が0件（期間 ' + SOURCE_MAX_AGE_DAYS + '日以内で該当なし）';
    return [];
  }

  // 再生数はsearch.listに含まれないので、videos.listで取り直す（1ユニット）
  const ids = items.map(function (it) { return it.id.videoId; }).join(',');
  const stats = {};
  try {
    const sres = UrlFetchApp.fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=' +
      encodeURIComponent(ids) + '&key=' + encodeURIComponent(apiKey),
      { muteHttpExceptions: true });
    if (sres.getResponseCode() === 200) {
      const sp = JSON.parse(sres.getContentText());
      (sp.items || []).forEach(function (v) {
        stats[v.id] = Number((v.statistics || {}).viewCount || 0);
      });
    }
  } catch (e) {
    console.warn('YouTube統計の取得に失敗（再生数の絞り込みをスキップ）: ' + e);
  }

  const mapped = items.map(function (it) {
    const sn = it.snippet || {};
    return {
      source: 'youtube',
      id: it.id.videoId,
      url: 'https://www.youtube.com/watch?v=' + it.id.videoId,
      title: String(sn.title || ''),
      description: String(sn.description || ''),
      author: String(sn.channelTitle || ''),
      publishedAt: String(sn.publishedAt || ''),
      views: stats[it.id.videoId] || 0,
      pattern: pat.key
    };
  });

  const kept = mapped.filter(function (v) {
    // 統計が取れなかった場合は0になる。その時は絞り込まない
    return !v.views || v.views >= pat.minViews;
  }).sort(function (a, b) { return b.views - a.views; });

  if (!kept.length && mapped.length) {
    // 検索は当たっているのに再生数で全部落ちた、が判別できるようにする
    const top = Math.max.apply(null, mapped.map(function (v) { return v.views; }));
    rep.reason = mapped.length + '件見つかったが再生数が足りない' +
                 '（最高 ' + top + ' / 必要 ' + pat.minViews + '）';
  }
  rep.keptCount = kept.length;
  return kept;
}

/* ------------------------------------------------------------------ */
/* RSS                                                                  */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* フィードの死活監視                                                   */
/* ------------------------------------------------------------------ */

/**
 * ★「疎通を確認できないURLは足さない」という運用ルールをやめるための仕組み。
 *
 * 元のルールは「存在しないURLを入れるとフィードが黙って死ぬ」ことへの対処
 * だったが、対処として弱い。今日疎通したフィードが来月死ぬ場合を全く防げず、
 * 既存フィードも同じ穴の上にあった（失敗は console.warn だけで、
 * GASのコンソールは誰も見ない）。
 *
 * 追加する前に人間が確かめるのではなく、壊れたら気づけるようにする。
 * そうすれば未確認のURLを入れても、1〜2サイクルで結果が分かる。
 */
const RSS_HEALTH_PROP = 'rss_feed_health';

/**
 * ★これだけ連続で失敗したフィードは、以後叩かない（自動隔離）。
 *
 * 【なぜ要るか】
 * これまでは「死んでいる」と通知するだけで、外すのは人の手作業だった。
 * 実際 core77 / dezeen / uncrate は4回連続で失敗しながら叩かれ続け、
 * 同じ通知が何日も出ていた。人が動くまで、毎サイクル無駄な往復が発生する。
 *
 * 通知の役割は「気づかせること」であって、「毎回言い続けること」ではない。
 * 気づかせたら、システム側で止める。
 *
 * ★復活の余地は残す。RSS_QUARANTINE_HOURS ごとに1回だけ再挑戦し、
 * 通れば隔離を解く。恒久的に切ると、一時的な障害でフィードを失う。
 */
const RSS_QUARANTINE_STREAK = 6;
const RSS_QUARANTINE_HOURS = 24;

/**
 * 隔離中で、まだ再挑戦の時間が来ていないフィードか。
 * @return {boolean} true なら今回は叩かない
 */
function rssQuarantined_(health, url) {
  const h = health[url];
  if (!h) return false;
  if ((Number(h.streak) || 0) < RSS_QUARANTINE_STREAK) return false;

  const lastTry = Number(h.lastRetryAt || h.at || 0);
  return (Date.now() - lastTry) < RSS_QUARANTINE_HOURS * 60 * 60 * 1000;
}
const RSS_DEAD_STREAK = 3;          // 何回連続で失敗したら知らせるか
const RSS_DEAD_NOTIFY_PROP = 'rss_dead_notified_at';

function readRssHealth_() {
  try {
    const raw = getProp_(RSS_HEALTH_PROP, '');
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeRssHealth_(health) {
  try {
    props_().setProperty(RSS_HEALTH_PROP, JSON.stringify(health));
  } catch (e) {
    console.warn('フィードの死活記録を保存できませんでした: ' + e);
  }
}

/**
 * 1フィードの取得結果を記録する。
 * @param {string} url
 * @param {boolean} ok 取得と解析に成功したか（0件でも成功は成功）
 * @param {string} note HTTPコードやエラー文
 */
function recordRssResult_(health, url, ok, note) {
  const cur = health[url] || { streak: 0, note: '', at: 0 };
  const wasQuarantined = (Number(cur.streak) || 0) >= RSS_QUARANTINE_STREAK;

  cur.streak = ok ? 0 : (Number(cur.streak) || 0) + 1;
  cur.note = ok ? '' : String(note || '').slice(0, 120);
  cur.at = Date.now();

  /*
   * ★隔離中に叩いた回は、成否によらず「再挑戦した時刻」を残す。
   * これが無いと、失敗するたびに at が更新されて24時間が延び続け、
   * 実質「二度と試さない」になる。
   */
  if (wasQuarantined) cur.lastRetryAt = Date.now();
  if (ok) delete cur.lastRetryAt;      // 復活したら隔離の記録を消す

  health[url] = cur;
  if (ok && wasQuarantined) {
    console.log('フィードが復活したため隔離を解きました: ' + truncate_(url, 70));
  }
}

/** 連続失敗しているフィードを知らせる。24時間に1回まで。 */
function notifyDeadFeeds_(health) {
  const dead = Object.keys(health).filter(function (u) {
    return (Number(health[u].streak) || 0) >= RSS_DEAD_STREAK;
  });
  if (!dead.length) return;

  const last = Number(getProp_(RSS_DEAD_NOTIFY_PROP, '0')) || 0;
  if (last && (Date.now() - last) < 24 * 60 * 60 * 1000) return;
  try { props_().setProperty(RSS_DEAD_NOTIFY_PROP, String(Date.now())); } catch (e) {}

  notifyAdmin_([
    '⚠️ 反応が取れないRSSフィードがあります',
    '',
    dead.map(function (u) {
      return '・' + truncate_(u, 70) + '\n   ' + (health[u].note || '理由不明') +
             '（' + health[u].streak + '回連続）';
    }).join('\n'),
    '',
    'URLが変わったか、配信が終わった可能性があります。',
    '',
    RSS_QUARANTINE_STREAK + '回連続で失敗したものは自動で叩かなくなります',
    '（' + RSS_QUARANTINE_HOURS + '時間に1回だけ再挑戦し、復活すれば自動で戻ります）。',
    '恒久的に外すなら RSS_FEEDS_A / RSS_FEEDS_B から削除してください。',
    '※他のフィードは通常どおり動いています。'
  ].join('\n'));
}

/**
 * RSS / Atom を読む。
 *
 * ★フィードは「読まれるために」公開されている。
 * スクレイピングと違い、提供側が配信を意図している経路なので、
 * ここを使うことに規約上の問題は無い。
 * APIキーもクォータも要らないのが利点。
 */
/**
 * フィードをまとめて取得する。
 *
 * ★fetchAll は1本でも要求の形が壊れていると全体が例外になる。
 * その場合は1本ずつに落として、生きているぶんだけ拾う。
 * 「速いが全滅しうる」より「遅いが取れる」を優先する。
 *
 * @return {Array} feeds と同じ並びの応答。取れなかった位置は null
 */
function fetchFeedsInParallel_(feeds) {
  const reqs = feeds.map(function (u) {
    return { url: u, muteHttpExceptions: true };
  });

  if (typeof UrlFetchApp.fetchAll === 'function') {
    try {
      return UrlFetchApp.fetchAll(reqs);
    } catch (e) {
      console.warn('まとめて取得できなかったため1本ずつ取ります: ' + e);
    }
  }

  return feeds.map(function (u) {
    try { return UrlFetchApp.fetch(u, { muteHttpExceptions: true }); }
    catch (e) {
      console.warn('RSS取得で通信エラー: ' + truncate_(u, 60) + ' / ' + e);
      return null;
    }
  });
}

function fetchRssCandidates_(accountKey) {
  const all = rssFeeds_(accountKey);
  if (!all.length) return [];

  const cutoff = Date.now() - SOURCE_MAX_AGE_DAYS * 86400000;
  const out = [];
  const health = readRssHealth_();

  /*
   * ★死んでいるフィードは叩かない（自動隔離）。
   * 通知しても人が外すまで毎サイクル往復が発生していた。
   * 24時間に1回だけ再挑戦するので、復活すれば自動で戻る。
   */
  const feeds = all.filter(function (u) { return !rssQuarantined_(health, u); });
  const skipped = all.length - feeds.length;
  if (skipped) {
    console.log('死活監視により ' + skipped + ' 本のフィードを今回は飛ばしました。');
  }
  if (!feeds.length) return [];

  /*
   * ★12本を1本ずつ取ると、その待ち時間だけでサイクルの大半を使う。
   *
   * 1サイクルで一番重い処理がここだった。RSSは12本あり、
   * それぞれ往復1回分の待ちが直列に積み上がる。
   * GASの fetchAll は同じ要求をまとめて並列に投げるので、
   * 待ち時間が「全部の合計」から「一番遅い1本」に変わる。
   *
   * ★fetchAll が使えない環境（テストのスタブ等）では従来どおり
   * 1本ずつ取る。速度のために動かなくなる方が損。
   */
  const responses = fetchFeedsInParallel_(feeds);

  feeds.forEach(function (feedUrl, idx) {
    let xml;
    const res = responses[idx];
    try {
      if (!res) {
        recordRssResult_(health, feedUrl, false, '応答なし');
        return;
      }
      if (res.getResponseCode() !== 200) {
        console.warn('RSS取得に失敗 ' + res.getResponseCode() + ': ' + truncate_(feedUrl, 80));
        recordRssResult_(health, feedUrl, false, 'HTTP ' + res.getResponseCode());
        return;
      }
      xml = XmlService.parse(res.getContentText());
    } catch (e) {
      console.warn('RSSの解析に失敗: ' + truncate_(feedUrl, 80) + ' / ' + e);
      recordRssResult_(health, feedUrl, false, truncate_(String(e), 100));
      return;
    }
    recordRssResult_(health, feedUrl, true, '');

    try {
      const root = xml.getRootElement();
      const name = root.getName();

      if (name === 'rss') {
        // RSS 2.0: rss > channel > item
        const channel = root.getChild('channel');
        if (!channel) return;
        channel.getChildren('item').forEach(function (item) {
          const link = childText_(item, 'link');
          if (!link) return;
          const pub = Date.parse(childText_(item, 'pubDate') || '');
          if (pub && pub < cutoff) return;
          out.push({
            source: 'rss',
            id: link,
            url: link,
            title: childText_(item, 'title'),
            description: stripHtml_(childText_(item, 'description')),
            author: channelTitle_(channel),
            publishedAt: childText_(item, 'pubDate'),
            views: 0,
            pattern: 'RSS'
          });
        });
      } else {
        // Atom: feed > entry
        const ns = root.getNamespace();
        root.getChildren('entry', ns).forEach(function (entry) {
          const linkEl = entry.getChild('link', ns);
          const link = linkEl ? linkEl.getAttribute('href').getValue() : '';
          if (!link) return;
          const upd = Date.parse(childText_(entry, 'updated', ns) || '');
          if (upd && upd < cutoff) return;
          out.push({
            source: 'rss',
            id: link,
            url: link,
            title: childText_(entry, 'title', ns),
            description: stripHtml_(childText_(entry, 'summary', ns)),
            author: childText_(root, 'title', ns),
            publishedAt: childText_(entry, 'updated', ns),
            views: 0,
            pattern: 'RSS'
          });
        });
      }
    } catch (e) {
      console.warn('RSSの構造を読めませんでした: ' + truncate_(feedUrl, 80) + ' / ' + e);
    }
  });

  // ★死んでいるフィードを黙って見逃さない。これがあるので、
  // 疎通未確認のURLでも安心して追加できる（壊れていれば知らせが来る）。
  writeRssHealth_(health);
  try { notifyDeadFeeds_(health); } catch (e) {
    console.warn('死活通知に失敗（本処理は続行）: ' + e);
  }

  return out;
}

function childText_(el, name, ns) {
  try {
    const c = ns ? el.getChild(name, ns) : el.getChild(name);
    return c ? String(c.getText() || '').trim() : '';
  } catch (e) { return ''; }
}

function channelTitle_(channel) {
  try { return childText_(channel, 'title'); } catch (e) { return ''; }
}

/** RSSのdescriptionにはHTMLが入る。タグを落として本文だけにする。 */
function stripHtml_(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 本文の取得（読んだ上で感想を書くため）                                */
/* ------------------------------------------------------------------ */
/*
 * ★これが「見ていないものを評価できない」制約を解く鍵。
 *
 * これまでは見出しと説明文しか持っていなかったので、
 * 本編への感想はすべて捏造になり、書かせられなかった。
 * 記事は2時間の実行間隔のうち数秒で読める。読めば感想は本物になる。
 *
 * ただし「読めたつもり」が最も危険なので、読めたかどうかは
 * LLMの申告ではなく、取得できた本文の実測文字数だけで判定する。
 * 足りなければ従来どおり「主張への意見」に限定する。
 *
 * 動画は対象外。UrlFetchAppで取れるのはHTMLであって映像ではない。
 * YouTubeは今までどおり、タイトルと説明文からの判断に留める。
 */

/** これ未満なら「読めた」とみなさない。抜粋・同意画面・404本文を弾く。 */
const ARTICLE_MIN_CHARS = 600;

/** プロンプトへ載せる上限。長文記事で入力を膨らませない。 */
const ARTICLE_MAX_CHARS = 5000;

/**
 * 記事本文を取得する。取れなければ空文字を返す（失敗は正常な結果）。
 *
 * @return {string}
 */
function fetchArticleText_(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return '';

  let html;
  try {
    const res = UrlFetchApp.fetch(u, {
      muteHttpExceptions: true,
      followRedirects: true,
      // 名乗らないと弾くサイトがある。素性は正直に書く。
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jmas-lab-bot/1.0)' }
    });
    if (res.getResponseCode() !== 200) {
      console.log('本文を取得できませんでした（HTTP ' + res.getResponseCode() + '）: ' +
                  truncate_(u, 80));
      return '';
    }
    html = res.getContentText();
  } catch (e) {
    console.log('本文の取得で例外: ' + truncate_(u, 80) + ' / ' + e);
    return '';
  }

  return extractArticleText_(html);
}

/**
 * HTMLから読める本文だけを取り出す。
 *
 * 完璧な本文抽出は狙わない。ナビゲーションや広告が多少混ざっても、
 * 記事の主旨を掴むには足りる。狙うのは「script と style を確実に落とす」こと。
 * これを残すとJSのソースが本文として渡り、感想が意味不明になる。
 */
/**
 * 本文ではないのに長さがある定型文。
 *
 * ★これを落とさないと、上限5000字がナビと定型文で埋まり、
 * 肝心の記事が押し出される。実際に The Verge で
 * 「Rogue AI ... | The Verge Skip to main content」が本文の先頭に入っていた。
 */
const BOILERPLATE_LINE = [
  /^skip to (main |primary )?content/i,
  /^(sign|log) ?(up|in)\b/i,
  /^subscribe\b/i,
  /^newsletter\b/i,
  /^share this/i,
  /^follow us/i,
  /^advertisement$/i,
  /^cookie/i,
  /we use cookies/i,
  /^by (continuing|clicking|using)/i,
  /^(all rights reserved|copyright)/i,
  /^comments?\s*\(\d+\)/i,
  /^most popular/i,
  /^related( stories| articles)?$/i,
  /^read more/i
];

function looksLikeBoilerplate_(line) {
  for (let i = 0; i < BOILERPLATE_LINE.length; i++) {
    if (BOILERPLATE_LINE[i].test(line)) return true;
  }
  return false;
}

function extractArticleText_(html) {
  let s = String(html || '');

  /*
   * ★<article> か <main> があれば、その中だけを見る。
   *
   * これを入れる前は、ページ全体から拾った結果、
   * ヘッダー・ナビ・関連記事リストで上限を食い潰し、
   * 本文が途中で切れて渡っていた（実測5001字＝上限ちょうど）。
   * 最も長いブロックを採るのは、複数ある場合に本文が最長だから。
   */
  // ★<head> は本文ではない。<title> がそのまま本文の先頭に入り、
  // 「Rogue AI ... | The Verge」という見出しが記事本文として渡っていた。
  // タイトルは item.title で別に持っているので、ここでは要らない。
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');

  const scoped = longestBlock_(s, 'article') || longestBlock_(s, 'main');
  if (scoped && scoped.length > 300) s = scoped;

  // 本文ではないブロックごと落とす
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
       .replace(/<header[\s\S]*?<\/header>/gi, ' ')
       .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
       .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
       .replace(/<form[\s\S]*?<\/form>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');

  // 段落の切れ目は残す。全部を1行に潰すと文の境界が消える。
  s = s.replace(/<\/(p|div|h[1-6]|li|section|article|br)\s*>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n');

  s = stripHtml_(s.replace(/\n/g, ''))
        .replace(/+/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

  // 記事本文らしい行だけ残す。メニュー項目・1語のリンク・定型文を落とす。
  const body = s.split('\n')
    .map(function (ln) { return ln.trim(); })
    .filter(function (ln) {
      return ln.length >= 40 && !looksLikeBoilerplate_(ln);
    })
    .join('\n');

  return truncate_(body || s, ARTICLE_MAX_CHARS);
}

/**
 * 指定タグの中身のうち最も長いものを返す。無ければ空文字。
 *
 * 正規表現でHTMLを解析するのは本来やらないが、ここで必要なのは
 * 「本文らしい塊を大づかみに切り出す」ことだけで、正確な構文解析ではない。
 * 入れ子は追わず、最初の開始タグから最後の終了タグまでを丸ごと取る。
 */
function longestBlock_(html, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
  let best = '';
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[1].length > best.length) best = m[1];
  }
  return best;
}

/**
 * この話題を「読んだ上で」語れるか。
 *
 * ★読めたかどうかは取得できた本文だけで決める。
 * ここを緩めると、読んでいないものへの感想が通ってしまう。
 *
 * @return {string} 読めた本文（読めなければ空文字）
 */
function readSourceBody_(item) {
  if (!item || item.source !== 'rss') return '';   // 動画は読めない

  // フィードが本文を丸ごと配っていることがある。その場合は取りに行かない。
  const fromFeed = String(item.description || '');
  if (fromFeed.length >= ARTICLE_MIN_CHARS) {
    return truncate_(fromFeed, ARTICLE_MAX_CHARS);
  }

  const fetched = fetchArticleText_(item.url);
  return fetched.length >= ARTICLE_MIN_CHARS ? fetched : '';
}

/* ------------------------------------------------------------------ */
/* 選定                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 紹介する話題を1つ選ぶ。
 * 既に紹介したURLは二度と選ばない。
 */
/* ------------------------------------------------------------------ */
/* 商材に繋がる話題かどうか                                              */
/* ------------------------------------------------------------------ */
/*
 * ★このアカウントは最終的にアフィリエイトで稼ぐ。
 * 読者が「これ欲しい」と思える話題でなければ、いくら伸びても1円にならない。
 *
 * 実例（2026-08-16）：The Verge の「Rogue AI aren't science fiction anymore」
 * というAI安全保障の論評に感想を書いていた。文章は成立していたが、
 * 読んだ人が何かを買うことは絶対に無い。
 * 既定フィードに総合ニュースとHacker Newsを入れた私の設計ミス。
 *
 * フィードを差し替えるだけでは足りない。ガジェット系フィードでも
 * 資金調達や訴訟の記事は流れてくる。中身で選別する。
 */

/*
 * ★ガジェットに絞らない（2026-08-16、オーナー判断）。
 *
 * 「人気トピックやバズってる商品も広く見る」方針。
 * 買う理由が生まれる話題は、PC周辺機器だけではない。
 * 家電・キッチン・健康・旅行・車・ゲーム・生活用品まで含める。
 *
 * 除外するのは「読んでも誰も何も買わない話題」だけに絞る。
 * 訴訟・規制・資金調達・決算・人事は、どれだけ話題でも購買に繋がらない。
 */

/** 買う理由が生まれる話題を示す語。 */
const PRODUCT_SIGNALS = [
  // 記事の型（これが最も強い手掛かり）
  'review', 'hands-on', 'hands on', 'tested', 'testing', 'we tried', 'benchmark',
  'best ', 'top ', ' vs ', 'comparison', 'buying guide', 'guide to', 'how much',
  'worth it', 'should you', 'alternative', 'upgrade', 'setup', 'tips',
  'deal', 'deals', 'discount', 'sale', 'price', 'cheap', 'budget', 'save',
  'launch', 'launches', 'released', 'announced', 'specs', 'teardown',
  'restock', 'preorder', 'sold out', 'viral', 'trending', 'everyone is',
  // PC・スマホ周辺
  'gadget', 'laptop', 'keyboard', 'keycap', 'mouse', 'monitor', 'display',
  'headphone', 'earbud', 'speaker', 'microphone', 'webcam', 'camera', 'lens',
  'charger', 'battery', 'power bank', 'dock', 'hub', 'adapter', 'cable',
  'ssd', 'nvme', 'drive', 'router', 'mesh', 'nas', 'gpu', 'cpu',
  'tablet', 'e-reader', 'smartwatch', 'phone', 'handheld', 'console',
  'printer', 'projector', 'drone',
  // 家・生活
  'desk', 'chair', 'lamp', 'stand', 'mount', 'tripod', 'shelf', 'storage',
  'mattress', 'pillow', 'blanket', 'air purifier', 'humidifier', 'thermostat',
  'vacuum', 'robot vac', 'kettle', 'coffee', 'espresso', 'blender', 'air fryer',
  'cookware', 'knife', 'grill', 'fridge', 'washer', 'smart home', 'doorbell',
  // 身につけるもの・健康
  'backpack', 'wallet', 'watch', 'sneaker', 'jacket', 'glasses',
  'fitness', 'workout', 'treadmill', 'dumbbell', 'sleep', 'skincare',
  // 移動・旅行
  'ev ', 'electric car', 'bike', 'e-bike', 'scooter', 'luggage', 'travel',
  // ソフト・サービス
  'workflow', 'automation', 'app', 'tool', 'extension', 'plugin', 'shortcut',
  'self-hosted', 'open source', 'subscription', 'free tier',
  /*
   * 日本発の商材（2026-08-16追加）。
   * このアカウントの唯一の構造的な強みなので、拾えたら優先して扱う。
   * 加点は productRelevance_ 側で別途上乗せしている。
   */
  'japan', 'japanese', 'made in japan', 'tokyo', 'kyoto', 'osaka',
  'santoku', 'gyuto', 'nakiri', 'damascus steel', 'donabe', 'washi',
  'seiko', 'citizen', 'muji', 'uniqlo', 'zojirushi', 'shun', 'pilot pen',
  'sakura', 'tombow', 'kokuyo', 'hario', 'kinto', 'snow peak', 'shimano',
  'import from japan', 'japan exclusive', 'domestic model'
];

/**
 * 買い物に繋がらない話題。1語ごとに強く減点する。
 *
 * ★ここは狭く保つ。広げるほど、買える話題まで巻き添えで落ちる。
 * 落とすのは「話題性はあっても購買に一切繋がらない」ものだけ。
 */
const NON_PRODUCT_SIGNALS = [
  'lawsuit', 'sues', 'sued', 'court', 'judge', 'settlement', 'antitrust',
  'regulation', 'regulator', 'senate', 'congress', 'parliament', 'election',
  'investigation', 'subpoena', 'indicted',
  'funding round', 'raises $', 'valuation', 'ipo', 'acquisition', 'acquires',
  'earnings', 'quarterly results', 'layoff', 'layoffs', 'resigns', 'steps down',
  'existential risk', 'alignment', 'sentient', 'doom',
  'op-ed', 'editorial'
];

/**
 * 商材に繋がる度合い。0以下なら見送る。
 *
 * @return {number}
 */
function productRelevance_(item) {
  const hay = (String(item.title || '') + ' ' +
               String(item.description || '') + ' ' +
               String(item.url || '')).toLowerCase();

  let score = 0;
  PRODUCT_SIGNALS.forEach(function (w) { if (hay.indexOf(w) !== -1) score += 1; });
  // 買わない話題は1つでも重い。ニュース記事は関連語を複数抱えがちなので強めに引く。
  NON_PRODUCT_SIGNALS.forEach(function (w) { if (hay.indexOf(w) !== -1) score -= 2; });

  // URLの区画は本文より正直な手掛かり
  const u = String(item.url || '').toLowerCase();
  if (/\/(review|reviews|deals|buying-guide|best)\//.test(u)) score += 3;
  if (/\/(column|opinion|policy|politics|editorial)\//.test(u)) score -= 4;

  /*
   * ★日本が絡む商材は上乗せする。
   * 同じ点数なら日本の話題を選ばせたい。ここでしか差がつけられない。
   */
  if (/\b(japan|japanese|made in japan)\b/.test(hay)) score += 2;

  /*
   * ★実際にバズっているかの数値的な裏付け。
   *
   * ここまでの加点は語彙による推測。views は fetchYouTubeCandidates_ が
   * YouTube Data API から実測で取得した再生数で、唯一「本当に読者が
   * 反応したか」を示す数値。RSSの記事にはこの値が無い（views: 0 固定）
   * ので、そちらは語彙の判定だけで選ばれる。
   */
  const views = Number(item.views) || 0;
  if (views >= 500000) score += 3;
  else if (views >= 200000) score += 2;
  else if (views >= 100000) score += 1;

  return score;
}

/** 商材に繋がる話題か。 */
function looksProductRelated_(item) {
  return productRelevance_(item) > 0;
}

/**
 * 商材に繋がる候補を、点数の高い順に並べて返す。
 *
 * ★単一候補ではなく配列で返す。
 * 上位1件が品質ゲートで落ちた時に「その回は諦める」のではなく、
 * 次点候補を試せるようにするため（runSourceCycle_ 参照）。
 *
 * @return {Array<Object>} 商材に繋がる話題が無ければ空配列
 */
function rankSourceCandidates_(candidates, usedUrls) {
  const usable = (candidates || []).filter(function (c) {
    if (!c.url || usedUrls[c.url]) return false;
    // タイトルが短すぎると何の話か判断できない
    if (String(c.title || '').trim().length < 10) return false;
    return true;
  });
  if (!usable.length) return [];

  /*
   * ★商材に繋がる話題を優先する。
   * 全滅した場合は投稿しない。買い物に繋がらない話題を無理に出すより、
   * その回を飛ばして次のフィード更新を待つ方がよい。
   */
  const relevant = usable.filter(looksProductRelated_);
  if (!relevant.length) {
    console.log('商材に繋がる話題がありませんでした（候補 ' + usable.length + '件）。' +
                'この回は見送ります。');
    return [];
  }

  // 点数の高い順。同点なら元の並び（＝新しい順）を保つ。
  relevant.sort(function (a, b) { return productRelevance_(b) - productRelevance_(a); });
  return relevant;
}

/** 単一候補が要る場所（試作の既定表示など）向けの薄いラッパー。 */
function pickSourceItem_(candidates, usedUrls) {
  const ranked = rankSourceCandidates_(candidates, usedUrls);
  return ranked.length ? ranked[0] : null;
}

/**
 * 情報源の候補を、上位から何件まで試すか。
 *
 * ★2026-08-16、オーナー指示で追加。
 * 「アフィリエイト登録が済むまでは、外部記事へのURL付き反応投稿を
 * 優先しておいてほしい」という方針。
 *
 * 上位1件だけを試して落ちたら単独投稿（URL無し）へ落ちる、という
 * 従来の動きだと、候補が41件あっても1件の失敗で反応投稿を諦めていた。
 * 次点候補を試すことで、単独投稿へ落ちる頻度を下げる。
 */
function sourceCandidatesToTry_() {
  const n = Number(getProp_('SOURCE_CANDIDATES_TRY', '3')) || 3;
  return Math.max(1, Math.min(10, n));
}

/* ------------------------------------------------------------------ */
/* 生成                                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 反応の型                                                             */
/* ------------------------------------------------------------------ */
/*
 * ★同じ調子の感想が並ぶとタイムラインが単調になり、読み飛ばされる。
 * 型を回して、賛成・反論・採点・実用性を混ぜる。
 *
 * どの型も「主張に対する意見」であって「見ていない本編の批評」ではない。
 * ここを混同すると、確認しようのないことを断定して信用を落とす。
 */
const SOURCE_TAKES = [
  {
    key: 'RATING',
    brief: 'Give it a star rating and defend it in one line. ' +
           'Rate the idea or the approach, and say what the rating is for. ' +
           'A split rating is strong: high for the idea, low for the framing.'
  },
  {
    key: 'PUSHBACK',
    brief: 'Disagree with the headline. Say what it gets wrong or oversells, ' +
           'and what the honest version of the claim would be. ' +
           'Do not be rude about it — be specific.'
  },
  {
    key: 'ENDORSE',
    brief: 'You think this is right, so say so and then go further than the ' +
           'headline does. Add the part an expert knows that the title left out. ' +
           'Agreement is only interesting when it adds something.'
  },
  {
    key: 'SO_WHAT',
    brief: 'Answer the question the headline does not: who does this actually ' +
           'change anything for, and who can ignore it. Be concrete about both.'
  }
];

/** 話題ごとに型を選ぶ。URLで決めるので、同じ記事なら常に同じ型になる。 */
function pickSourceTake_(accountKey, item) {
  const seed = String((item && item.url) || '') + String(accountKey || '');
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
  return SOURCE_TAKES[n % SOURCE_TAKES.length];
}

/**
 * 見つけた話題にコメントを付ける。
 *
 * ★動画そのものは見ていない。タイトルと説明文しか読んでいない。
 * だから引用エンジンと同じ制約をかける（checkQuoteClaims_ を流用）。
 * 「この動画のこの商品」と書かせない。
 */
function buildSourceSystemPrompt_(accountKey, item, link, disclosureTag, articleText) {
  const key = String(accountKey || '').toUpperCase();
  const take = pickSourceTake_(key, item);
  const hasRead = !!articleText;

  const lines = [
    'You are reacting to something you found and sharing it with your followers.',
    '',
    '# THE FIRST LINE IS THE WHOLE JOB',
    'Your post appears directly above a preview card that already shows the',
    'headline and the image. So the headline is taken. If your first line just',
    'names the topic or repeats the title, the reader has no reason to read you',
    'at all — they will look at the card and scroll.',
    '',
    'The first line has to be YOUR VERDICT, before any context:',
    '  "The caching argument here does not survive contact with auth."',
    '  "Right diagnosis. The fix is the part they got wrong."',
    '  "☆☆ for the argument. I wanted to agree with this."',
    'Never open with the subject ("Rogue AI is in the news again"). That is the',
    'card. Open with where you land on it.',
    '',
    'Then, and only then, the context and the reasoning.',
    ''
  ];

  if (hasRead) {
    /*
     * ★本文を渡してある回。読んだのだから、読者としての感想を書ける。
     * ここで遠慮させると、せっかく読んだ意味が無くなる。
     */
    lines.push(
      'You have READ the full article. The text is given to you below.',
      'So react as a reader who just finished it:',
      '  - what actually landed, and what fell flat',
      '  - what it claims that you do not buy',
      '  - what it left out that a reader would want',
      'Quote or point at what it really says. You have the text, so be specific.',
      '',
      'Still off limits, because the text does not tell you these:',
      '  - never claim you personally use or bought anything in it',
      '  - never invent a number the article does not state',
      '  - never describe images, video or anything you did not receive as text');
  } else {
    lines.push(
      'CRITICAL — what you actually know, and what that means for your opinion:',
      'You have the TITLE and DESCRIPTION. You could NOT read the full text.',
      '',
      'So judge the CLAIM, never the production:',
      '  YES — the idea, the approach, the spec, the premise, the tradeoff.',
      '         "the approach is right and the headline undersells it"',
      '  NO  — the video, the article, the writing, the editing.',
      '         never "great video", "worth a watch", "solid read", "just watched this".',
      '         you did not read it. saying you did is a lie your followers can catch.',
      '',
      'This is not a restriction on how strong your opinion can be.',
      'You can be blunt, you can disagree hard, you can call a popular idea wrong.',
      'You just have to argue with the CLAIM, not review something you did not see.',
      '',
      '- Never describe what happens in it.',
      '- Never claim a specific product appears in it.');
  }

  lines.push('',
    '# Your angle for this one',
    take.brief);

  /*
   * ★採点はAだけ。
   * Bが☆を出すと、案内先カタログの作品評価と読み違えられる。
   * Miaは自分の意見を言う人格であって、評価点を配る立場ではない。
   */
  if (key === 'B') {
    lines.push('',
      '# No star ratings',
      'Never use ☆ or ★ or an "x/5" score. On this account a rating reads as the',
      'store rating of a work, which you are not reporting. Say what you think in words.');
  } else if (hasRead) {
    lines.push('',
      '# Star ratings',
      'A rating is good here — it stops the scroll and it commits you.',
      'Use ☆ characters, one to five, and name what the rating is for on the same line.',
      '  GOOD : ☆☆ for the argument — the diagnosis is right, the fix is not.',
      '  GOOD : the reporting: ☆☆☆☆. the headline they put on it: ☆.',
      '  BAD  : ☆☆☆ (rating nothing in particular)');
  } else {
    lines.push('',
      '# Star ratings',
      'A rating is good here — it stops the scroll and it commits you.',
      'Use ☆ characters, one to five. The rating MUST name what it is rating on the',
      'same line, and that has to be the claim or the approach — never the article',
      'itself, which you did not read.',
      '  GOOD : ☆☆ for the premise — right diagnosis, wrong fix.',
      '  GOOD : the approach itself: ☆☆☆☆. the framing around it: ☆.',
      '  BAD  : ☆☆☆☆ great article',
      '  BAD  : ☆☆☆ (rating nothing in particular)');
  }

  lines.push('',
    'The item URL goes at the end. It will expand into a preview card on its own,',
    'so do not describe the thumbnail or tell people to "watch this".');

  if (key === 'B') {
    lines.push('',
      "You are 'Secret Mia', gatekeeper of Japan's premium adult and doujin catalogue.",
      'all lowercase. teasing, confident, insider.',
      'Never write about a specific individual. Never promise uncensored material.',
      'Never describe a sexual act.');
  } else {
    lines.push('',
      'You are an expert on tech, gadgets and workflow. Add the thing an expert',
      'would know: the tradeoff nobody mentions, the reason the popular approach breaks.',
      'Never claim you personally own or tested something. Never invent a metric.',
      'No hashtags.');
  }

  if (link) {
    lines.push('',
      'You also have an affiliate link. Include it exactly once, exactly as given.',
      'It relates to the topic, not to the specific item you found.');
    if (disclosureTag) {
      lines.push('Do not write ' + disclosureTag + ' yourself; it is added automatically.');
    }
  }

  // ★形の指示。ここを書かないと局所判定で落ちて再生成を空回りさせる。
  lines.push('',
    'Shape on the screen:',
    '- TWO TO FIVE lines. Not one, not six. Blank lines between them are fine.',
    '- Line 1 is the verdict, alone, under 70 characters, then a break.',
    '- The rest is why. One idea per line. Never one solid block.',
    '',
    'Like this:',
    '  The caching argument does not survive contact with auth.',
    '',
    '  They treat invalidation as a footnote.',
    '  It is the entire problem.');

  /*
   * ★引用エンジンと同じ理由で、採点基準を生成側にも渡す。
   * 反応投稿は SOURCE/QUOTE として同じ採点ルールで判定される。
   */
  lines.push('',
    'The bar this is scored against before it can be published:',
    'A judge scores it 0-100 and nothing under 70 is posted. THE FIRST LINE',
    'DECIDES THAT SCORE — it is read alone, competing with the preview card',
    'directly below it.',
    '',
    'Naming the topic, restating the headline, or easing in scores under 45.',
    'Earn the first line by taking a side, naming the stake, contradicting an',
    'assumption, or giving a verdict.',
    '',
    'A neutral summary of what the card already shows scores under 40.',
    'A hedged both-sides take scores under 50. Go past the headline: a',
    'consequence, a limit, a reason it breaks, who it does not apply to.',
    'Claiming to have used or bought it scores under 30, and inventing a number',
    'the source never gave scores under 30.',
    '',
    'You are NOT penalised for lacking a tool name or a personal story.',
    'Never mention scoring or judging in the post itself.');

  lines.push('', 'Output only the post text. Maximum ' + getTweetMaxLen_(key) + ' characters.');
  return lines.join('\n');
}

function buildSourceUserPrompt_(item, link, attempt, lastText, critique, articleText) {
  const lines = [
    'You found this ' + (item.source === 'youtube' ? 'video' : 'article') + ':',
    '',
    'Title: ' + truncate_(item.title, 200)
  ];
  if (item.author) lines.push('By: ' + item.author);
  if (item.description) lines.push('Description: ' + truncate_(item.description, 400));
  lines.push('URL (include this exactly, at the end): ' + item.url);

  if (articleText) {
    // ★本文を渡した回だけ、本編そのものへの感想を書ける。
    lines.push('',
      'Here is the article itself. You have now read it:',
      '"""', articleText, '"""',
      '',
      'React as a reader who just finished it. What landed, what did not, ' +
      'what it left out. Refer to what it actually says — you have the text.');
  } else {
    lines.push('', 'That is everything you know about it. You have NOT read the full text.');
  }

  if (link) lines.push('', buildBLinkFacts_(link));

  if (attempt > 1 && lastText) {
    lines.push('', 'Your previous attempt was rejected:', truncate_(lastText, 400),
               '', 'Reason: ' + critique, '', 'Write a different post that fixes this.');
  }
  return lines.join('\n');
}

/**
 * 見つけた話題について1本作る。
 * @return {?Object} 生成できなければ null
 */
function generateFromSource_(accountKey, item) {
  const key = String(accountKey || '').toUpperCase();
  const region = pickRegionByJstHour_();

  /*
   * ★先に記事を読む。2時間の実行間隔のうち数秒で済む。
   *
   * 読めれば「読者としての感想」を書ける。読めなければ従来どおり
   * 見出しへの意見に限定する。この差は下流の検査にもそのまま渡す。
   */
  const articleText = readSourceBody_(item);
  if (articleText) {
    console.log('本文を読みました（' + articleText.length + '字）: ' + truncate_(item.title, 60));
  }

  // アフィリエイトリンクは通常投稿と同じゲートを通す
  let link = null;
  try {
    const candidates = listLinkCandidates_(getOrCreateLinksSheet_(), key);
    const usable = candidates.filter(function (c) {
      return validateAffiliateLink_(c, region, key).ok;
    });
    if (usable.length && shouldIncludeLink_(key)) {
      link = usable[Math.floor(Math.random() * usable.length)];
    }
  } catch (e) {
    console.warn('Linksを読めないためリンク無しで続行: ' + e);
  }

  const disclosureTag = link ? requiredDisclosureFor_(region, link) : '';
  const disclosureCost = disclosureTag ? estimateWeightedLength_(disclosureTag + ' ') : 0;
  // 見つけた話題のURL + アフィリエイトURL の分を先に引いておく
  const urlCost = TWEET_URL_WEIGHT + 2 + (link ? TWEET_URL_WEIGHT + 2 : 0);
  const bodyMaxLen = getTweetMaxLen_(key) - disclosureCost - urlCost;

  const postUrl = link ? linkPostUrl_(link) : '';
  const systemPrompt = buildSourceSystemPrompt_(key, item, link, disclosureTag, articleText);

  let lastText = '';
  let critique = '';

  for (let attempt = 1; attempt <= llmMaxAttempts_(); attempt++) {
    const userPrompt = buildSourceUserPrompt_(item, link, attempt, lastText, critique, articleText);

    let raw;
    try {
      raw = callLLM_(systemPrompt, userPrompt);
    } catch (err) {
      if (isSafetyBlock_(err)) {
        console.warn('安全フィルタのため、この話題は見送ります。');
        return null;
      }
      throw err;
    }

    let text = sanitizeGeneratedText_(raw);
    if (!text) continue;

    // 見ていないものを断定していないか（引用エンジンと同じ検査）。
    // 本文を読めている時だけ、本編そのものへの感想を許可する。
    const claims = checkQuoteClaims_(text, key, { hasRead: !!articleText });
    if (!claims.ok) {
      lastText = text; critique = claims.reason;
      continue;
    }

    // 本文からURLを一旦すべて落とし、こちらで組み立て直す。
    // LLMにURLの位置と正確さを任せない。
    const body = stripUrls_(text).trim();
    if (!body) { lastText = text; critique = 'You wrote only a URL. Write a real comment.'; continue; }

    if (estimateWeightedLength_(body) > bodyMaxLen) {
      lastText = body;
      critique = 'Too long. Limit is ' + bodyMaxLen + ' characters before the links.';
      continue;
    }

    // 完成度・品質
    // 本文を渡す。記事に書いてある数字は捏造ではないと判定させるため。
    const verdict = evaluatePost_(key, body, 'SOURCE', articleText);
    if (!verdict.ok) {
      lastText = body; critique = verdict.critique;
      continue;
    }

    const parts = [body];
    if (postUrl) parts.push(postUrl);
    parts.push(item.url);
    const finalText = applyDisclosure_(parts.join('\n\n'), disclosureTag);

    return {
      text: finalText,
      region: region,
      angle: 'SOURCE_' + item.source.toUpperCase(),
      format: 'source',
      model: getProp_('LLM_MODEL', LLM_DEFAULT_MODEL),
      role: 'SOURCE',
      qualityScore: verdict.score,
      postType: 'SOURCE_' + item.source.toUpperCase(),
      linkUrl: postUrl,
      sourceUrl: item.url,
      sourceTitle: item.title
    };
  }

  /*
   * ★なぜ落ちたのかを残す。
   *
   * ここが黙って null を返していたため、「基準を満たす文が作れませんでした」
   * としか表示されず、原因の特定に何往復もかかった。
   * 実際の原因は、価格記事の感想が金額の記述で弾かれ続けていたことだった。
   */
  const why = critique || '(理由の記録なし)';
  console.warn('この話題では基準を満たす投稿を作れませんでした: ' +
               truncate_(item.title, 60) + ' / 最後の却下理由: ' + why);
  try { props_().setProperty(SOURCE_LAST_REJECT_PROP + key, truncate_(why, 400)); } catch (e) {}
  return null;
}

/** 直近の却下理由。試作の表示に使う。 */
const SOURCE_LAST_REJECT_PROP = 'source_last_reject_';

function lastSourceReject_(accountKey) {
  return getProp_(SOURCE_LAST_REJECT_PROP + String(accountKey || '').toUpperCase(), '');
}

/* ------------------------------------------------------------------ */
/* 実行                                                                 */
/* ------------------------------------------------------------------ */

/**
 * X以外の情報源から1本投稿する。
 *
 * @return {boolean} 投稿できたか
 */
/** 情報源サイクル専用の順番待ち。引用サイクルとは別に持つ。 */
const SOURCE_TURN_PROP = 'source_turn';

/**
 * この回の情報源投稿を1本試す。
 *
 * ★引用サイクルと同じく、片方が空振りでも、もう片方が出せるなら出す。
 * 1アカウントだけ見て諦めていたため、フィードを持たないBに当たった回は
 * Aに候補があっても何も投稿されなかった。
 *
 * @return {boolean} 投稿できたか
 */
function runSourceCycleAll_() {
  const first = nextAccountInTurn_(SOURCE_TURN_PROP);
  const order = [first].concat(Object.keys(ACCOUNTS).filter(function (k) {
    return k !== first;
  }));

  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    try {
      if (runSourceCycle_(key)) return true;
    } catch (err) {
      console.error('情報源投稿に失敗 (' + key + '): ' +
                    (err && err.stack ? err.stack : err));
    }
  }
  return false;
}

function runSourceCycle_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  if (isAccountStopped_(key)) return false;

  /*
   * ★投稿できない回は、何も取りに行かない。
   *
   * 上限の判定は postTweet_ でも行われるが、そこまで進むと
   * 記事の取得（数秒）とGeminiの生成（最大5回）を丸ごと捨てることになる。
   * 出せないと分かっている回は最初に降りる。
   */
  if (isOverMonthlyCap_(key)) {
    console.log('今月の上限に達しているため情報源投稿を見送ります (' + key + ')。');
    return false;
  }
  if (isOverDailyPace_(key)) {
    console.log('今日のぶん（' + dailyPostAllowance_(key) + '件）を使い切りました (' + key +
                ')。月末まで均すため、この回は見送ります。');
    return false;
  }

  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateSourcesSheet_(ss);
  const used = readUsedSourceUrls_(sheet);

  /*
   * ★優先順に情報源を試し、十分集まったら残りは叩かない。
   * 以前は毎回3系統すべて（Reddit1 + YouTube2 + RSS12本以上）を
   * 必ず取りに行っていた。詳細は SOURCE_CHAIN のコメント参照。
   */
  const chainRep = {};
  const candidates = collectSourceCandidates_(key, chainRep);
  console.log('情報源の連鎖 (' + key + '): ' +
              chainRep.tried.map(function (t) { return t.source + '=' + t.count; }).join(' / ') +
              (chainRep.stoppedAfter ? ' → ' + chainRep.stoppedAfter + 'で打ち切り' : ''));

  if (!candidates.length) {
    console.log('情報源から候補が得られませんでした (' + key + ')。');
    return false;
  }

  const ranked = rankSourceCandidates_(candidates, used);
  if (!ranked.length) {
    console.log('未紹介の候補がありません (' + key + ')。');
    return false;
  }

  /*
   * ★上位1件で諦めない。次点候補を順に試す。
   *
   * 以前は最上位候補が品質ゲートで落ちると、その回はそのまま
   * 単独投稿（URL無し）へフォールバックしていた。候補が41件あっても
   * 1件の失敗で反応投稿（URL付き）を諦めていたことになる。
   * アフィリエイト登録が済むまではURL付き反応を優先したいので、
   * 上位数件を順に試してから諦める。
   */
  const tryCount = Math.min(ranked.length, sourceCandidatesToTry_());
  for (let i = 0; i < tryCount; i++) {
    const item = ranked[i];
    const generated = generateFromSource_(key, item);
    if (!generated) continue;   // この候補は基準未達。次点へ

    /*
     * ★画像があれば添付する（2026-08-18）。
     *
     * オーナー指摘:「文だけでピンセットを紹介しても意味無い。
     * 人間は目があるんだから、画像が見えたらそれにひかれて目がいく」。
     * 引用リポストが権限で使えない以上、写真を伴わせる手段は
     * 「自分で画像を付ける」しかない。
     *
     * Redditの投稿はプレビュー画像を持っている。
     * 失敗しても null が返るだけで投稿は止まらない（25_Media.gs）。
     */
    let mediaIds = [];
    if (item.imageUrl) {
      try {
        const mid = uploadMediaToX_(key, item.imageUrl);
        if (mid) mediaIds = [mid];
      } catch (e) {
        console.warn('画像の添付に失敗（本文だけ投稿します）: ' + e);
      }
    }

    const result = postTweet_(key, generated.text, { mediaIds: mediaIds });

    rememberSource_(sheet, {
      account: key, source: item.source, url: item.url, title: item.title,
      postedText: generated.text, postId: result.id
    });

    appendLogRow_(ss, buildLogRow_({
      account: key, status: QUEUE_STATUS_POSTED, text: generated.text,
      region: generated.region, angle: generated.angle, format: generated.format,
      postId: result.id, hash: result.contentHash,
      hasLink: result.hasLink, cost: result.costEstimate,
      model: generated.model, role: generated.role,
      qualityScore: generated.qualityScore,
      postType: generated.postType, linkUrl: generated.linkUrl
    }));

    resetPoorQualityStreak_(key);
    console.log('情報源から投稿しました (' + item.source + '): ' + (result.url || result.id) +
                '（' + (i + 1) + '番目の候補）');
    return true;
  }

  console.log('上位' + tryCount + '件とも基準を満たせませんでした (' + key + ')。');
  return false;
}

/** 検索だけ試す（投稿しない）。何が拾えるかを目で見るため。 */
/**
 * 記事への反応を1本作って見せる。投稿はしないし、履歴にも残さない。
 *
 * ★これが無かったせいで、反応投稿を目で見る手段が存在しなかった。
 * 「試作A」は単独投稿の経路で、こことは別のコードを通る。
 *
 * @return {string} LINEへそのまま出せる文面
 */
function previewSourcePost_(accountKey) {
  const key = String(accountKey || 'A').toUpperCase();

  // ★本番と同じ連鎖を通す。試作だけ別の集め方をすると、
  //   見えているものと実際に出るものがずれる。
  const candidates = collectSourceCandidates_(key, {});
  if (!candidates.length) {
    return '【' + key + ' 反応試作】話題が取れませんでした\n' +
           'RSSもYouTubeも候補ゼロです。情報源診断を確認してください。';
  }

  /*
   * ★本番と同じ選び方をする（rankSourceCandidates_ を通す）。
   * ここで candidates[0] を直接使っていたため、商材に繋がらない記事を
   * 弾く仕組みを入れた後も、試作だけは弾く前の記事を見せていた。
   * 試作が本番と違う挙動をすると、確認そのものが無意味になる。
   * 本番が次点候補まで試すようになったので、試作も同じだけ試す。
   *
   * 既出かどうかは見ない（試作なので）。履歴も汚さない。
   */
  const ranked = rankSourceCandidates_(candidates, {});
  if (!ranked.length) {
    return '【' + key + ' 反応試作】商材に繋がる話題がありませんでした\n' +
           '候補' + candidates.length + '件はすべてニュース・論評でした。\n' +
           'RSS_FEEDS_' + key + ' をガジェット系フィードへ替えてください。';
  }

  const tryCount = Math.min(ranked.length, sourceCandidatesToTry_());
  for (let i = 0; i < tryCount; i++) {
    const item = ranked[i];
    const generated = generateFromSource_(key, item);
    if (!generated) continue;   // 次点候補へ（本番と同じ動き）

    return '【' + key + ' 反応試作】投稿はしていません\n' +
           '対象: ' + truncate_(item.title, 60) +
           (i > 0 ? '（' + (i + 1) + '番目の候補。上位' + i + '件は基準未達）' : '') + '\n' +
           '型: ' + generated.postType + '\n\n' +
           generated.text;
  }

  // ★全滅した時だけ、最後に試した候補の却下理由を出す。
  return '【' + key + ' 反応試作】上位' + tryCount + '件とも基準を満たせませんでした\n' +
         '最後に試した対象: ' + truncate_(ranked[tryCount - 1].title, 60) + '\n\n' +
         '却下理由:\n' + truncate_(lastSourceReject_(key), 300);
}

function dryRunSources(accountKey) {
  const key = String(accountKey || 'A').toUpperCase();
  const yt = fetchYouTubeCandidates_(key);
  const rss = fetchRssCandidates_(key);
  console.log('YouTube: ' + yt.length + '件');
  yt.slice(0, 5).forEach(function (v) {
    console.log('  ' + v.views + '回 ' + truncate_(v.title, 80));
  });
  console.log('RSS: ' + rss.length + '件');
  rss.slice(0, 5).forEach(function (v) {
    console.log('  ' + truncate_(v.title, 80));
  });
  return { youtube: yt, rss: rss };
}

/**
 * 情報源が使えるかを実際に叩いて確かめる。
 * LINEの「情報源診断」から呼ぶ。
 */
function diagnoseSources_(accountKey) {
  const key = String(accountKey || 'A').toUpperCase();
  const lines = ['【' + key + ' 情報源診断】'];

  // --- YouTube ---
  const apiKey = youtubeApiKey_();
  if (!apiKey) {
    lines.push('❌ YouTube: APIキー未設定');
    lines.push('   YOUTUBE_API_KEY を設定してください。');
  } else {
    let yt = [];
    const rep = {};
    try { yt = fetchYouTubeCandidates_(key, rep); } catch (e) {
      lines.push('❌ YouTube: ' + truncate_(String(e), 100));
    }
    lines.push((yt.length ? '✅' : '⚠️') + ' YouTube: ' + yt.length + '件');
    if (yt.length) {
      lines.push('   例: ' + truncate_(yt[0].title, 60));
    } else {
      // ★0件の理由を必ず出す。件数だけでは打つ手が決まらない
      if (rep.query) lines.push('   検索語: ' + truncate_(rep.query, 46));
      lines.push('   理由: ' + (rep.reason || '不明'));
      if (rep.reason === 'APIKeyが未設定' || rep.reason === 'APIキーが未設定') {
        lines.push('   ※YouTube Data API v3 のキーが要ります。');
        lines.push('     LINEで「初期設定 <キー>」と送ると登録できます。');
      }
    }
  }

  /*
   * --- 情報源の優先順 ---
   * ★どの順で試して、どこで打ち切るかを最初に見せる。
   * 「Redditが先頭なのにRSSの投稿ばかり出る」のような食い違いに
   * 気づけるようにするため。
   */
  lines.push('【優先順】' + sourceChainFor_(key).join(' → ') +
             '（' + SOURCE_CHAIN_ENOUGH + '件集まったら以降は叩かない）');

  // --- Reddit（APIキー不要）---
  {
    let rd = [];
    const rrep = {};
    try { rd = fetchRedditCandidates_(key, rrep); } catch (e) {
      lines.push('❌ Reddit: ' + truncate_(String(e), 80));
    }
    lines.push((rd.length ? '✅' : '⚠️') + ' Reddit: ' + rd.length + '件' +
               (rrep.targets && rrep.targets.length
                 ? '（今回 ' + rrep.targets.length + '本）' : ''));
    // ★どこから何件取れたかを1行ずつ。合計だけだと死んだ板に気づけない
    (rrep.targets || []).forEach(function (t) {
      const mark = t.reason ? '  ❌' : '  ・';
      lines.push(mark + ' ' + (t.mode === 'search' ? '検索: ' : '') + t.term +
                 ' → ' + (t.reason ? t.reason : t.kept + '件'));
    });
    if (rd.length) {
      lines.push('   例: ' + truncate_(rd[0].title, 60));
      const withImg = rd.filter(function (v) { return v.imageUrl; }).length;
      lines.push('   画像つき: ' + withImg + '件');
    } else if (rrep.reason) {
      lines.push('   理由: ' + rrep.reason);
    }
  }

  // --- RSS ---
  const feeds = rssFeeds_(key);
  if (!feeds.length) {
    lines.push('⚠️ RSS: フィード未登録');
    lines.push('   RSS_FEEDS_' + key + ' にカンマ区切りでURLを入れてください。');
  } else {
    let rss = [];
    try { rss = fetchRssCandidates_(key); } catch (e) {
      lines.push('❌ RSS: ' + truncate_(String(e), 100));
    }
    lines.push((rss.length ? '✅' : '⚠️') + ' RSS: ' + rss.length + '件 / ' +
               feeds.length + 'フィード');

    // ★フィード単位で出す。合計だけだと、4本中1本が死んでいても分からない。
    const health = readRssHealth_();
    feeds.forEach(function (u) {
      const h = health[u];
      const streak = h ? (Number(h.streak) || 0) : 0;
      const quarantined = rssQuarantined_(health, u);
      const mark = !h ? '・' : (streak === 0 ? '  ✅' : (quarantined ? '  ⏸' : '  ❌'));
      const detail = streak > 0
        ? '（' + h.note + ' / ' + streak + '回連続' +
          (quarantined ? '・隔離中' : '') + '）'
        : '';
      lines.push(mark + ' ' + truncate_(u.replace(/^https?:\/\//, ''), 46) + detail);
    });

    // ★商材に繋がる話題が何件あるか。
    // ここが0だと、記事は取れているのに投稿は出ない。
    // 件数だけ見て「取れている」と誤解しないよう、選別後の数も出す。
    const buyable = rss.filter(looksProductRelated_);
    lines.push((buyable.length ? '✅' : '❌') + ' 商材に繋がる話題: ' +
               buyable.length + '件 / ' + rss.length + '件');
    if (buyable.length) {
      lines.push('   例: ' + truncate_(buyable[0].title, 60));
    } else if (rss.length) {
      lines.push('   例(除外): ' + truncate_(rss[0].title, 55));
      lines.push('   ニュース・論評しか流れていません。');
      lines.push('   RSS_FEEDS_A をガジェット系フィードへ替えてください。');
    }

    // ★本文を実際に読めるかを確かめる。
    // 読めるかどうかで投稿の書き方が変わるので、目で見えるようにしておく。
    // 実際に投稿へ回るのは選別後の記事なので、本文取得もそちらで試す
    const sample = buyable.length ? buyable[0] : rss[0];
    if (sample) {
      let body = '';
      try { body = readSourceBody_(sample); } catch (e) {
        lines.push('❌ 本文取得: ' + truncate_(String(e), 80));
      }
      if (body) {
        lines.push('✅ 本文取得: ' + body.length + '字 → 読者としての感想を書きます');
        lines.push('   冒頭: ' + truncate_(body.replace(/\n/g, ' '), 70));
      } else {
        lines.push('⚠️ 本文取得: 取れず（' + ARTICLE_MIN_CHARS + '字未満）');
        lines.push('   見出しへの意見に切り替えて投稿します（止まりません）。');
      }
    }
  }

  lines.push('');
  lines.push('※Instagramは対応していません。Graph APIは自分が管理する');
  lines.push('  アカウントしか扱えず、他人の投稿を検索する手段がありません。');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* YouTube（APIキー不要のRSS）                                          */
/* ------------------------------------------------------------------ */

/**
 * ★YouTube Data API を使わずにチャンネルの新着を取る。
 *
 * 【なぜ作ったか】
 * 実機の情報源診断で「YouTube: 0件」が続いていた。
 * youtubeApiKey_() は YOUTUBE_API_KEY が無いと GEMINI_API_KEY を流用するため
 * 「キーはある」と判定されるが、そのプロジェクトで YouTube Data API v3 が
 * 有効でなければ403になる。オーナーがGoogle Cloudの設定をしない限り直らない。
 *
 * YouTubeはチャンネルごとに認証不要のRSSを公開している。
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx
 * これならキーもクォータも要らず、RSSと同じ経路で読める。
 *
 * ★再生数は取れない。RSSに含まれないため。
 * 検索APIの minViews による絞り込みはここでは効かないが、
 * 「伸びている動画」より「材料が途切れないこと」を優先する。
 * 引用専用モードでは材料の数がそのまま投稿できる回数になる。
 *
 * チャンネルIDは YT_CHANNELS_A / YT_CHANNELS_B で足せる（再デプロイ不要）。
 */
function youtubeRssFeeds_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const ids = getListProp_('YT_CHANNELS_' + key, []);
  return ids.map(function (id) {
    const t = String(id).trim();
    if (!t) return '';
    // URLをそのまま入れられてもよいようにする
    if (/^https?:\/\//i.test(t)) return t;
    return 'https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(t);
  }).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Reddit（APIキー不要のJSON）                                          */
/* ------------------------------------------------------------------ */

/**
 * ★RedditはJSONを認証なしで返す。
 *
 * 【なぜ作ったか】
 * 引用リポストがAPIの階層制限で恒久的に使えない以上、
 * 「他人の投稿に乗る」代わりの材料をWebから取ってくるしかない。
 * RSSは媒体側が用意している必要があるが、Redditは
 * 板ごとに人気投稿がそのまま取れる。しかも本文より重要なのは
 * 「今その界隈で話題になっていること」で、Redditはそこが強い。
 *
 * https://www.reddit.com/r/<sub>/top.json?t=week&limit=25
 *
 * ★Bにとって特に大きい。Bは成人・同人を扱うRSS媒体が
 * ほとんど存在せず、材料が枯れていた（実際に引用0本）。
 * Redditには該当する板がある。
 *
 * 注意:
 *   ・User-Agent を付けないと429を返されやすい
 *   ・self post（本文だけ）は外部URLが無いので外す
 *   ・NSFWフラグは残す（Bはそこが本題、Aでは板自体が該当しない）
 */
/*
 * ★板を増やした（2026-08-19、オーナー指示「無料をメインに」）。
 *
 * 板は1サイクルに数本しか叩かず、順番に回る。数を増やしても
 * 1回あたりの負荷は変わらず、一周する周期が延びるだけ。
 * 同じ板を短い間隔で引くと同じ投稿ばかり当たるので、
 * むしろ数が多い方が材料の重複が減る。
 *
 * ⚠️ 板が存在しない場合はHTTP 404が返る。投稿は止まらず、
 * 「情報源診断」のReddit欄にその板の失敗として出る。そこで外す。
 * この環境からRedditへ疎通できないため、板名は未検証。
 */
const REDDIT_SUBS = {
  'A': [
    // モノ・道具（元からあった軸）
    'BuyItForLife', 'EDC', 'mechanicalkeyboards', 'coffee',
    'Watches', 'woodworking', 'Tools', 'gadgets',
    // 作る・直す
    'DIY', 'metalworking', 'functionalprint', 'somethingimade',
    // 買う物の周辺
    'espresso', 'headphones', 'knifeclub', 'fountainpens'
  ],
  'B': [
    'visualnovels', 'vns', 'manga', 'doujinshi', 'JapaneseGameDeals',
    'eroge', 'visualnovelsuggest'
  ]
};

function redditSubs_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return getListProp_('REDDIT_SUBS_' + key, REDDIT_SUBS[key] || []);
}

/** 次に見る板。順番に回す（1サイクルで全部は叩かない）。 */
function nextRedditSub_(accountKey) {
  const list = redditSubs_(accountKey);
  if (!list.length) return '';
  const prop = 'reddit_sub_' + String(accountKey).toUpperCase();
  const n = Number(getProp_(prop, '0')) || 0;
  try { props_().setProperty(prop, String((n + 1) % list.length)); } catch (e) {}
  return String(list[n % list.length]).trim();
}

/**
 * ★Redditの検索でジャンルを引く（2026-08-19）。
 *
 * 【なぜ要るか】
 * Bの売れ筋ジャンル18軸は QUOTE_PATTERNS に入れたが、あれはX検索専用。
 * Xの検索は課金対象で、実際にクレジットが尽きて402になっている
 * （2026-08-19 09:31 の引用診断）。買っても数日で尽きる規模なので、
 * ジャンルで材料を引く手段がX検索しか無い状態は続けられない。
 *
 * Redditの検索は認証もキーも要らず、無料で回数制限も緩い。
 * 同じジャンル語をこちらへ持ってくる。
 *
 * https://www.reddit.com/search.json?q=...&sort=top&t=week
 *
 * ★板を巡回するのとは別枠。板だけだと「その板で今週伸びたもの」しか
 * 取れず、ジャンルを狙って引けない。両方を交互に使う。
 */
const REDDIT_GENRE_QUERIES = {
  /*
   * ★軸を増やした（2026-08-19）。検索は板と違って
   * 「その板に人がいるか」に左右されない。Reddit全体から引くので、
   * ニッチな軸ほど検索の方が当たる。無料なので本数を絞る理由が無い。
   */
  'A': [
    'handmade craftsmanship', 'everyday carry', 'restoration before after',
    'woodworking joinery', 'mechanical watch', 'kitchen knife',
    'leather boots', 'raw denim fades',
    'tool restoration', 'blacksmithing forge', 'workshop build',
    'espresso machine upgrade', 'headphones review', 'fountain pen review',
    '3d printed tool', 'vintage camera repair', 'cast iron seasoning',
    'titanium edc'
  ],
  /*
   * ★Bは QUOTE_PATTERNS.B の GENRE_* と同じ軸。
   * 出典はオーナー共有の売れ筋リスト（DLsite/FANZAの実在カテゴリと一致）。
   * 「制服・学園もの」「女教師」「妹・近親」を入れないのはX側と同じ理由。
   * 錨（doujin/hentai/eroge）も同じく必須。
   */
  'B': [
    'netorare doujin', 'milf hentai doujin', 'gyaru doujin',
    'office lady hentai', 'hypnosis doujin', 'mind control hentai',
    'exhibitionism doujin', 'breeding hentai',
    'eroge recommendations', 'doujin circle release', 'DLsite recommendations',
    /*
     * ★2026-08-19 追加分。すべて成人の登場人物を前提とする語で揃えた。
     * 学園・制服・妹・女教師を入れないのはX側と同じ理由（下の線）。
     * 「uncensored」「leaked」も入れない（3本の線の2本目）。
     */
    'doujinshi english translation', 'hentai manga recommendations',
    'nukige eroge recommendations', 'adult visual novel eroge release',
    'futanari doujin', 'monster girl hentai', 'succubus hentai',
    'cheating wife doujin', 'tentacle doujin', 'yandere doujin',
    'ntr eroge visual novel', 'hentai game steam release'
  ]
};

function redditGenreQueries_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return getListProp_('REDDIT_QUERIES_' + key, REDDIT_GENRE_QUERIES[key] || []);
}

/**
 * 今回Redditをどう引くか決める。板の巡回と検索を交互に使う。
 * @return {{mode:string, term:string, url:string}|null}
 */
function nextRedditTarget_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const subs = redditSubs_(key);
  const queries = redditGenreQueries_(key);

  // 片方しか無ければそちらを使う
  const useSearch = queries.length && (!subs.length || redditTurnIsSearch_(key));

  if (useSearch) {
    const prop = 'reddit_q_' + key;
    const n = Number(getProp_(prop, '0')) || 0;
    try { props_().setProperty(prop, String((n + 1) % queries.length)); } catch (e) {}
    const term = String(queries[n % queries.length]).trim();
    return {
      mode: 'search',
      term: term,
      /*
       * ★t=month にした。1000票の足切りを入れると、週だけでは
       * 候補が枯れる検索語が出るため。上位を取る方針は変わらない。
       */
      url: 'https://www.reddit.com/search.json?q=' + encodeURIComponent(term) +
           '&sort=top&t=month&limit=50'
    };
  }

  const sub = nextRedditSub_(key);
  if (!sub) return null;
  return {
    mode: 'sub',
    term: 'r/' + sub,
    // ★同上。t=month で母数を増やし、スコアで絞る
    url: 'https://www.reddit.com/r/' + encodeURIComponent(sub) + '/top.json?t=month&limit=50'
  };
}

/** 板と検索を交互に使うための切り替え。 */
function redditTurnIsSearch_(accountKey) {
  const prop = 'reddit_turn_' + String(accountKey).toUpperCase();
  const n = Number(getProp_(prop, '0')) || 0;
  try { props_().setProperty(prop, String((n + 1) % 2)); } catch (e) {}
  return n % 2 === 0;
}

/**
 * ★1サイクルで何本のRedditを引くか（2026-08-19 オーナー指示で複数化）。
 *
 * 【なぜ増やすか】
 * 無料の情報源をメインに据えると決めた。にもかかわらず、Redditは
 * 1サイクルにつき1本しか引いていなかった（板の巡回か、ジャンル検索の
 * どちらか一方）。材料が足りなければ課金されるX検索へ落ちる構造なので、
 * 「無料側を細く引いて、足りないぶんを有料で埋める」形になっていた。
 *
 * Redditの取得はキーもクォータも要らない。本数を増やしても費用は0。
 * 増えるのは待ち時間だけで、それは fetchAll の並列化で吸収できる。
 *
 * 3本にすると、板2本＋検索1本のような組み合わせが1サイクルで揃う。
 * 上限6本は、GASの6分枠に対する安全側の頭打ち。
 */
const REDDIT_TARGETS_PER_CYCLE_DEFAULT = 3;

/**
 * ★上位1%だけを通す足切り（2026-08-22、オーナー指示）。
 *
 * これまでは top=week で取ったものを、スコアを見ずに全部候補にしていた。
 * 週の上位でも下の方は数十票しか無く、そこを材料にすると
 * 「有象無象への感想」を投稿することになる。
 *
 * 1000票は「その板で今週明確に当たった投稿」の目安。
 * 満たない行は即座に捨てる。材料が減る方が、質が落ちるより安い。
 *
 * REDDIT_MIN_SCORE で調整できる。0にすると足切りしない。
 */
const REDDIT_MIN_SCORE_DEFAULT = 1000;

function redditMinScore_() {
  const n = Number(getProp_('REDDIT_MIN_SCORE', String(REDDIT_MIN_SCORE_DEFAULT)));
  return isFinite(n) && n >= 0 ? n : REDDIT_MIN_SCORE_DEFAULT;
}

function redditTargetsPerCycle_() {
  const n = Number(getProp_('REDDIT_TARGETS', String(REDDIT_TARGETS_PER_CYCLE_DEFAULT)));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(6, Math.floor(n));
}

/**
 * 今回引くRedditの取得先をまとめて決める。
 *
 * ★同じ回に同じ板を2回引かない。nextRedditTarget_ は呼ぶたびに
 * 回転位置を進めるが、板より検索語が少ない（または逆の）場合に
 * 一周して同じものへ戻ることがある。URLで重複を落とす。
 *
 * @return {Array<{mode:string, term:string, url:string}>}
 */
function nextRedditTargets_(accountKey, count) {
  const key = String(accountKey || '').toUpperCase();
  const want = Math.max(1, Number(count) || 1);
  const out = [];
  const seen = {};

  // ★空回りしても止まるように、試行回数に上限を置く
  for (let i = 0; i < want * 3 && out.length < want; i++) {
    const t = nextRedditTarget_(key);
    if (!t) break;
    if (seen[t.url]) continue;
    seen[t.url] = true;
    out.push(t);
  }
  return out;
}

/**
 * Redditをまとめて取得する。fetchAll が無い環境では1本ずつに落とす。
 *
 * ★UAを付けないとRedditは429を返しやすい。並列にすると尚更なので、
 * ここでは必ず付ける。
 *
 * @return {Array} targets と同じ並びの応答。取れなかった位置は null
 */
/**
 * RedditへのUser-Agent。
 *
 * ★★形式が決まっている。守らないと 403 が返る（2026-08-22に実証）。
 *   <platform>:<app ID>:<version> (by /u/<username>)
 *
 * 33_BuzzSource.gs に 'jmas-bot/1.0' という独自形式を書いたところ、
 * 全17板が一律403になった。板名の誤りに見えるが原因は違う。
 *
 * ★この値を複製しないこと。Redditを叩く箇所は必ずこの関数を呼ぶ。
 * 同じ知識を2箇所に置いたことが、まさにこの事故の原因だった。
 */
function redditUserAgent_() {
  return 'web:jmas-x-bot:v1 (by /u/jmas)';
}

function fetchRedditInParallel_(targets) {
  const headers = { 'User-Agent': redditUserAgent_() };
  const reqs = targets.map(function (t) {
    return { url: t.url, muteHttpExceptions: true, headers: headers };
  });

  if (targets.length > 1 && typeof UrlFetchApp.fetchAll === 'function') {
    try {
      return UrlFetchApp.fetchAll(reqs);
    } catch (e) {
      console.warn('Redditをまとめて取得できなかったため1本ずつ取ります: ' + e);
    }
  }

  return targets.map(function (t) {
    try { return UrlFetchApp.fetch(t.url, { muteHttpExceptions: true, headers: headers }); }
    catch (e) {
      console.warn('Reddit取得で通信エラー: ' + t.term + ' / ' + e);
      return null;
    }
  });
}

/** Redditの応答1本ぶんを共通の形へ直す。 */
function parseRedditChildren_(children, target, cutoff) {
  const out = [];
  const minScore = redditMinScore_();

  (children || []).forEach(function (c) {
    const d = c && c.data;
    if (!d) return;

    /*
     * ★上位1%の足切り。ここで落とすのが一番安い。
     * 下流（本文生成・メディア取得・投稿）へ持ち込んでから
     * 「実は伸びていない話題だった」と気づいても手遅れになる。
     */
    const score = Number(d.score || d.ups || 0);
    if (minScore > 0 && score < minScore) return;

    // 本文だけの投稿は紹介先が無いので外す
    if (d.is_self) return;
    const link = String(d.url_overridden_by_dest || d.url || '');
    if (!/^https?:\/\//i.test(link)) return;
    if (d.created_utc && (d.created_utc * 1000) < cutoff) return;

    out.push({
      source: 'reddit',
      id: String(d.id || ''),
      url: link,
      title: String(d.title || ''),
      description: String(d.selftext || '').slice(0, 400),
      author: target.mode === 'sub' ? target.term : ('r/' + String(d.subreddit || '')),
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
      // 賛成票を views と同じ枠に入れておく。並べ替えに使える
      views: Number(d.ups || 0),
      // ★画像があれば投稿に添付できる（人は目で止まる）
      imageUrl: redditImageOf_(d),
      pattern: 'REDDIT_' + String(target.term).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    });
  });
  return out;
}

/**
 * Redditから今週の人気投稿を取る。板の巡回とジャンル検索を交互に使い、
 * 1サイクルで複数本をまとめて引く（無料なので本数を絞る理由が無い）。
 *
 * @param {string} accountKey
 * @param {Object} [report] 診断用。0件の理由を入れる
 * @return {Array<Object>} 他の情報源と同じ形
 */
function fetchRedditCandidates_(accountKey, report) {
  const rep = report || {};
  const key = String(accountKey || '').toUpperCase();
  const targets = nextRedditTargets_(key, redditTargetsPerCycle_());
  if (!targets.length) {
    rep.reason = '板も検索語も設定されていない';
    return [];
  }

  // ★1本だった頃の診断表示を壊さないため、先頭の情報は従来のキーに残す
  rep.mode = targets[0].mode;
  rep.sub = targets[0].term;
  rep.terms = targets.map(function (t) { return t.term; });
  rep.targets = [];

  const responses = fetchRedditInParallel_(targets);
  const cutoff = Date.now() - SOURCE_MAX_AGE_DAYS * 86400000;

  let raw = 0;
  const seenId = {};
  const out = [];
  const failures = [];

  targets.forEach(function (target, idx) {
    const detail = { term: target.term, mode: target.mode, kept: 0 };
    rep.targets.push(detail);

    const res = responses[idx];
    if (!res) {
      detail.reason = '応答なし';
      failures.push(detail);
      return;
    }

    const code = res.getResponseCode();
    detail.httpCode = code;
    if (code !== 200) {
      detail.reason = 'HTTP ' + code;
      failures.push(detail);
      console.warn('Reddit取得エラー ' + code + ' (' + target.term + ')');
      return;
    }

    let parsed;
    try { parsed = JSON.parse(res.getContentText()); } catch (e) {
      detail.reason = 'JSONを解釈できない';
      failures.push(detail);
      return;
    }

    const children = (parsed && parsed.data && parsed.data.children) || [];
    raw += children.length;

    parseRedditChildren_(children, target, cutoff).forEach(function (item) {
      // ★複数の板・検索語をまたぐと同じ投稿が重複して出る
      const dedupeKey = item.id || item.url;
      if (seenId[dedupeKey]) return;
      seenId[dedupeKey] = true;
      out.push(item);
      detail.kept++;
    });
  });

  // ★1本だけ引いていた頃と同じキーも埋めておく（既存の診断・テスト用）
  rep.httpCode = rep.targets.length ? rep.targets[0].httpCode : undefined;
  rep.rawCount = raw;
  rep.keptCount = out.length;
  // ★足切り値は診断に出す。0件だった時に「厳しすぎるのか」を判断できるように
  rep.minScore = redditMinScore_();

  if (!out.length) {
    if (failures.length === targets.length && failures.length) {
      /*
       * ★全部が同じ理由で落ちた時は、理由を1つだけ書く。
       * 「r/EDC: HTTP 429 / r/gadgets: HTTP 429 / ...」と並べても
       * 読む側に増える情報が無い。原因は1つ（レート制限）だと分かればよい。
       */
      const uniq = [];
      failures.forEach(function (f) {
        if (uniq.indexOf(f.reason) < 0) uniq.push(f.reason);
      });
      rep.reason = uniq.length === 1 ? uniq[0]
        : failures.map(function (f) { return f.term + ': ' + f.reason; }).join(' / ');
    } else if (raw) {
      rep.reason = raw + '件あったが、外部リンク付きが無い';
    }
  }
  return out.sort(function (a, b) { return b.views - a.views; });
}

/** Redditの投稿から画像URLを取り出す。無ければ空文字。 */
function redditImageOf_(d) {
  try {
    const pv = d.preview && d.preview.images && d.preview.images[0];
    if (pv && pv.source && pv.source.url) {
      // RedditのJSONはHTMLエンティティで返ってくる
      return String(pv.source.url).split('&amp;').join('&');
    }
  } catch (e) {}
  const t = String(d.thumbnail || '');
  return /^https?:\/\//i.test(t) ? t : '';
}

/* ------------------------------------------------------------------ */
/* 情報源の優先順連鎖                                                   */
/* ------------------------------------------------------------------ */

/**
 * ★どの情報源から順に試すか。アカウントごとに違う。
 *
 * 【なぜ順序を付けるか】
 * これまでは毎サイクル3系統すべてを必ず叩いていた。
 *   Reddit 1回 + YouTube Data API 2回 + RSS 12本以上
 * 材料が最初の1系統で足りている回でも、残りを全部取りに行っていた。
 *
 * Agent Reach（他リポジトリ）の考え方を借りた。あれは
 * 「プラットフォームごとに優先順のバックエンド一覧を持ち、
 *   1つが失敗したら次へ自動で切り替える」構造をしている。
 * ここでも同じ形にする。優先順に試し、十分集まった時点で止める。
 *
 * 【順序の根拠（実測）】
 *   A … RSSが12本生きていて191件取れている（2026-08-18の情報源診断）。
 *       ここが最も厚いので先頭に置く。
 *   B … RSS媒体がこのジャンルにほとんど存在せず、実際に材料ゼロで
 *       止まった。Redditには該当する板があるので先頭に置く。
 *
 * YouTubeは両方とも最後。Data APIがキーの都合で403になりやすく、
 * チャンネルRSS側は rssFeeds_ に合流済みで既にRSS段で拾えるため。
 */
const SOURCE_CHAIN = {
  'A': ['rss', 'reddit', 'youtube'],
  'B': ['reddit', 'rss', 'youtube']
};

/**
 * これだけ集まったら後続の情報源は叩かない。
 *
 * ★選び方の質を落とさない範囲で止める。rankSourceCandidates_ は
 * 集めた中から選ぶので、母数が小さすぎると選択の余地が無くなる。
 * 未紹介フィルタで大半が落ちることもあるため、余裕を持たせてある。
 */
const SOURCE_CHAIN_ENOUGH = 12;

function sourceChainFor_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return getListProp_('SOURCE_CHAIN_' + key, SOURCE_CHAIN[key] || ['rss', 'reddit', 'youtube']);
}

/** 情報源1つぶんの取得。名前で振り分ける。 */
function fetchOneSource_(name, accountKey, report) {
  switch (String(name).toLowerCase()) {
    case 'reddit':  return fetchRedditCandidates_(accountKey, report);
    case 'youtube': return fetchYouTubeCandidates_(accountKey, report);
    case 'rss':     return fetchRssCandidates_(accountKey);
    default:
      console.warn('未知の情報源です: ' + name);
      return [];
  }
}

/**
 * 優先順に情報源を試し、十分集まったら止める。
 *
 * ★1つが例外を投げても連鎖は続く。材料が無くなる方が損。
 *
 * @param {string} accountKey
 * @param {Object} [report] 診断用。どの情報源が何件返したかを入れる
 * @return {Array<Object>} 候補
 */
function collectSourceCandidates_(accountKey, report) {
  const key = String(accountKey || '').toUpperCase();
  const rep = report || {};
  rep.tried = [];

  const chain = sourceChainFor_(key);
  let candidates = [];

  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    let got = [];
    let err = '';
    try {
      got = fetchOneSource_(name, key, {}) || [];
    } catch (e) {
      err = truncate_(String(e), 80);
      console.error('情報源 ' + name + ' で例外: ' + e);
    }
    rep.tried.push({ source: name, count: got.length, error: err });
    candidates = candidates.concat(got);

    if (candidates.length >= SOURCE_CHAIN_ENOUGH) {
      // 後続は叩かない。何を省いたかは診断で見えるようにしておく
      rep.stoppedAfter = name;
      rep.skipped = chain.slice(i + 1);
      break;
    }
  }

  rep.total = candidates.length;
  return candidates;
}
