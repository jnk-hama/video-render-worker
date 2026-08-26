/**
 * ===========================================================================
 * 33_BuzzSource.gs  —  バズ専用の材料取り（神動画だけを拾う）
 * ===========================================================================
 *
 * ★2026-08-22、オーナー指示による全面見直し。
 *
 * 【何が問題だったか】
 * バズ投稿の材料を、通常の情報源（19_Sources.gs）と共有していた。
 * あちらは「紹介できる商材の話題」を集める設計で、板も
 * BuyItForLife / coffee / visualnovels のように"読み物"寄り。
 * その結果、
 *   ・本文は雑学やレビューの話になり
 *   ・映像は無関係なストック（回転する検索語で引いた汎用クリップ）
 * という、文章と映像が噛み合わない投稿になっていた。
 *
 * 【この実装の方針】
 * 1. 板をペルソナ別に固定する。視覚的に派手で、スクロールが止まる板だけ。
 * 2. スコア2000以上・月間/週間トップからのみ拾う。
 * 3. 拾った投稿のタイトルを本文生成と映像検索の両方へ流す。
 *    「何が起きている映像か」が本文と映像で一致する。
 *
 * 【やらないこと（重要）】
 * ★Redditの動画そのものをダウンロードしてXへ再アップロードしない。
 * オーナー自身が2026-08-22に「著作権侵害およびDMCA凍結リスクが高いため
 * 完全禁止」と決定しており、その判断は妥当。ここでは元投稿を
 * 「何を撮るべきかの指示書」として使い、映像はライセンス済みの
 * ストックから引く。
 */

/* ------------------------------------------------------------------ */
/* 1. ペルソナ別の板（オーナー指定・ハードコード）                       */
/* ------------------------------------------------------------------ */
/*
 * ★ここに雑学・ASMR・スライム等のノイズ板を足さないこと。
 * 「視覚的に派手で、物理的な動きがある」ものだけを残す。
 */
/*
 * ★先頭3つはオーナー指定。以降は同ジャンルの補充枠。
 *
 * ★★2026-08-22、指定3板だけでは実機で0件になった。
 * EngineeringPorn / specializedtools / gadgets は画像とリンクが中心で、
 * 「スコア2000以上 かつ 動画」を月間で満たす投稿がほとんど無い。
 * PixelArt に至ってはほぼ全部が静止画。
 *
 * ジャンル（メカの稼働／作画・アニメーション）は変えずに、
 * 動画比率の高い板を足して供給を作る。指定板は先頭のまま優先される。
 */
/*
 * ★★2026-08-24、オーナー指示で両アカウントの土俵を入れ替えた。
 *
 * A: ニッチな作業映像(CNC/工具/機械)をやめ、言語の壁を越える
 *    大衆向けエンタメへ。「何回見ても笑える」「展開が気になる」側。
 * B: 制作過程(sakuga/pixelart/gamedev)から、実際に人を止める
 *    アニメ・J-カルチャーの見せ場へ。
 *
 * ★板は「動画が主役の板」だけを選ぶ。文章が主役の板を混ぜると、
 * スコアは高いのに映像が無い候補ばかりが並び、0件と同じになる。
 */
const BUZZ_SUBS = {
  A: ['nextfuckinglevel', 'Damnthatsinteresting', 'BeAmazed',
      'WinStupidPrizes', 'Unexpected', 'holdmybeer',
      'toptalent', 'interestingasfuck', 'ContagiousLaughter'],
  B: ['Animemes', 'awwnime', 'anime_irl',
      'AnimeSakuga', 'animegifs', 'cosplay', 'Kanojo', 'streetwear']
};

function buzzSubs_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return getListProp_('BUZZ_SUBS_' + key, BUZZ_SUBS[key] || []);
}

/* ------------------------------------------------------------------ */
/* 2. トップ0.1%の閾値                                                  */
/* ------------------------------------------------------------------ */
/*
 * ★通常の情報源は1000（19_Sources.gs）。バズはさらに絞る。
 * 伸びていない投稿を材料にすると、どれだけ文章を磨いても伸びない。
 */
const BUZZ_MIN_SCORE_DEFAULT = 2000;

function buzzMinScore_() {
  const n = Number(getProp_('BUZZ_MIN_SCORE', String(BUZZ_MIN_SCORE_DEFAULT)));
  return (isNaN(n) || n < 0) ? BUZZ_MIN_SCORE_DEFAULT : n;
}

/** 月間トップ → 週間トップ の順に見る。それ以外の並びは使わない。 */
const BUZZ_TIME_WINDOWS = ['month', 'week'];

/* ------------------------------------------------------------------ */
/* 3. 取得                                                              */
/* ------------------------------------------------------------------ */

/**
 * その投稿が「動く映像」を持っているか。
 *
 * ★静止画のミームを拾うと、動画前提のフックが嘘になる。
 * Redditのv.redd.it、gfycat、redgifs、および直リンクのmp4/gifvを見る。
 */
function redditHasMotion_(d) {
  if (!d) return false;
  if (d.is_video === true) return true;

  const sm = d.secure_media || d.media;
  if (sm && sm.reddit_video && sm.reddit_video.fallback_url) return true;
  if (sm && sm.type && /gfycat|redgifs|streamable/i.test(String(sm.type))) return true;

  const url = String(d.url_overridden_by_dest || d.url || '');
  if (/\.(mp4|gifv|webm)(\?|$)/i.test(url)) return true;
  if (/(v\.redd\.it|gfycat\.com|redgifs\.com|streamable\.com)/i.test(url)) return true;

  return false;
}

/**
 * 1つの板から、閾値を超えた「動く投稿」だけを取る。
 *
 * @return {Array<Object>} 候補の配列（失敗時は空）
 */
/*
 * ★直前の取得の内訳。「0件」の理由を推測しないために残す。
 *
 * ★★2026-08-22、実機で A も B も「神動画が0件」になった。
 * 原因の候補は3つあり、どれかは数字を見ないと分からない：
 *   ・板が存在しない／到達できない（HTTPエラー）
 *   ・投稿はあるがスコアが閾値に届かない
 *   ・スコアは足りているが動画が無い（画像中心の板）
 * 推測で閾値をいじると、別の原因だった場合に一往復無駄になる。
 */
let lastBuzzFetchStats_ = [];

function buzzFetchStats_() { return lastBuzzFetchStats_.slice(); }
function resetBuzzFetchStats_() { lastBuzzFetchStats_ = []; }

function fetchBuzzFromSub_(sub, window, minScoreOverride) {
  const name = String(sub || '').trim();
  if (!name) return [];

  const stat = { sub: name, window: window, http: 0, total: 0, scored: 0, motion: 0, kept: 0 };
  lastBuzzFetchStats_.push(stat);

  const url = 'https://www.reddit.com/r/' + encodeURIComponent(name) +
              '/top.json?t=' + encodeURIComponent(window) + '&limit=50';

  let res;
  try {
    /*
     * ★★User-Agent は redditUserAgent_() を使う（19_Sources.gs）。
     * ここに独自の文字列を書いたら全板が403になった（2026-08-22）。
     * Redditは形式を検査する: <platform>:<app ID>:<version> (by /u/<name>)
     */
    res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': redditUserAgent_() }
    });
  } catch (e) {
    stat.http = -1;
    console.warn('r/' + name + ' へ到達できません: ' + truncate_(String(e), 100));
    return [];
  }
  stat.http = res.getResponseCode();
  if (stat.http !== 200) {
    console.warn('r/' + name + ' HTTP ' + stat.http);
    return [];
  }

  let children;
  try {
    children = ((JSON.parse(res.getContentText()) || {}).data || {}).children || [];
  } catch (e) {
    stat.http = -2;
    console.warn('r/' + name + ' の応答を解釈できません');
    return [];
  }
  stat.total = children.length;

  const min = (minScoreOverride === undefined) ? buzzMinScore_() : Number(minScoreOverride);
  const out = [];
  children.forEach(function (c) {
    const d = c && c.data;
    if (!d) return;

    const score = Number(d.score || d.ups || 0);
    if (score < min) return;                 // トップ0.1%だけ
    stat.scored++;

    if (!redditHasMotion_(d)) return;        // 静止画は動画前提のフックに合わない
    stat.motion++;

    if (d.over_18) return;                   // A/Bとも素材としては扱わない
    if (d.stickied) return;                  // 告知の固定投稿

    const title = String(d.title || '').trim();
    if (!title) return;
    stat.kept++;

    out.push({
      source: 'reddit-buzz',
      id: String(d.id || ''),
      // ★元投稿のURL。投稿本文には出さない（バズはリンク厳禁）が、
      //   ログに残しておくと「どの神動画を見て書いたか」を後から追える
      url: 'https://www.reddit.com' + String(d.permalink || ''),
      title: title,
      description: String(d.selftext || '').slice(0, 400),
      author: 'r/' + String(d.subreddit || name),
      subreddit: String(d.subreddit || name),
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
      views: score,
      imageUrl: (typeof redditImageOf_ === 'function') ? redditImageOf_(d) : '',
      pattern: 'BUZZ_' + String(d.subreddit || name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
    });
  });

  return out;
}

/**
 * バズ用の材料を集める。板を順に回し、月間→週間の順に見る。
 *
 * ★通常の情報源(collectSourceCandidates_)は使わない。
 * あちらは商材の話題を集める設計で、視覚的な派手さで選んでいない。
 *
 * @return {Array<Object>} スコア降順
 */
function collectBuzzCandidates_(accountKey) {
  resetBuzzFetchStats_();
  const key = String(accountKey || '').toUpperCase();
  const subs = buzzSubs_(key);
  if (!subs.length) return [];

  // 板は毎回同じ順で叩かない。偏ると同じ投稿ばかりになる
  const startProp = 'buzz_sub_' + key;
  const start = Number(getProp_(startProp, '0')) || 0;
  try { props_().setProperty(startProp, String((start + 1) % subs.length)); } catch (e) {}

  const seen = {};
  const out = [];

  const gather = function (minScore) {
    for (let w = 0; w < BUZZ_TIME_WINDOWS.length && out.length < 10; w++) {
      for (let i = 0; i < subs.length && out.length < 10; i++) {
        const sub = subs[(start + i) % subs.length];
        const got = fetchBuzzFromSub_(sub, BUZZ_TIME_WINDOWS[w], minScore);
        got.forEach(function (c) {
          if (!c.id || seen[c.id]) return;
          seen[c.id] = true;
          out.push(c);
        });
      }
      // 月間で足りていれば週間は見ない（無駄な往復を減らす）
      if (out.length >= 5) break;
    }
  };

  /*
   * ★★YouTubeを先に見る（2026-08-22）。
   *
   * Redditの匿名 .json は2026-05-28に廃止され403を返す。UAの形式を
   * 直しても通らない。Redditを主軸にしたままだと、アプリ登録が済むまで
   * 1本も出せない。YouTubeのキーは既にあり、実際に動いている。
   * Redditは認証を入れた時に自動で効き始める（下の gather）。
   */
  try {
    fetchBuzzFromYouTube_(key).forEach(function (c) {
      if (!c.id || seen[c.id]) return;
      seen[c.id] = true;
      out.push(c);
    });
  } catch (e) {
    console.warn('YouTubeから拾えません: ' + truncate_(String(e), 120));
  }

  if (out.length < 3) gather(buzzMinScore_());

  /*
   * ★★どの板にも該当が無い時だけ、最後の手段として閾値を下げる。
   *
   * 「スコア2000以上」はオーナー指定で、伸びていない投稿を材料に
   * しないための線。だが0件では1本も出せず、指示「絶対に1本は出せ」と
   * 両立しない。まず指定の閾値で探し、本当に無い時だけ半分まで緩める。
   *
   * ★黙って緩めない。緩めたことは診断に出す（下の buzzRelaxed_）。
   * 気づかないまま基準が下がっているのが一番まずい。
   */
  buzzRelaxedTo_ = 0;
  if (!out.length) {
    const relaxed = Math.max(500, Math.floor(buzzMinScore_() / 2));
    console.log('スコア' + buzzMinScore_() + '以上が0件のため ' + relaxed +
                ' まで下げて再取得します (' + key + ')。');
    gather(relaxed);
    if (out.length) buzzRelaxedTo_ = relaxed;
  }

  return out.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
}

/** 直前の取得で閾値を下げたか（0なら下げていない）。診断に出す。 */
let buzzRelaxedTo_ = 0;
function buzzRelaxedScore_() { return buzzRelaxedTo_; }

/* ------------------------------------------------------------------ */
/* 3-B. YouTube（主軸）                                                 */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-22、Redditの匿名 .json は使えないと判明した。
 *
 * Redditは2026-05-28に未認証の .json エンドポイントを廃止し、403を返す
 * ようになった。UAの形式を直しても通らない（それとは別の理由）。
 * 複数の独立した情報源で裏を取っている。
 *
 * ここをRedditに依存させたままだと、オーナーがRedditのアプリ登録を
 * するまで1本も出せない。一方 YouTube Data API のキーは既に設定済みで、
 * 19_Sources.gs で実際に動いている。
 *
 *   ・title      … 何が起きている映像か（本文と映像検索語の元）
 *   ・viewCount  … 伸びているかの判定（スコアの代わり）
 *   ・そもそも動画しか返らない（静止画を弾く処理が不要）
 *
 * 「各ジャンルのトップ動画を拾う」という要件に、Redditより素直に合う。
 */

/** 再生数の足切り。Redditのスコア2000に相当する「トップだけ」の線。 */
const BUZZ_MIN_VIEWS_DEFAULT = 500000;

function buzzMinViews_() {
  const n = Number(getProp_('BUZZ_MIN_VIEWS', String(BUZZ_MIN_VIEWS_DEFAULT)));
  return (isNaN(n) || n < 0) ? BUZZ_MIN_VIEWS_DEFAULT : n;
}

/*
 * ★ペルソナ別の検索語。板の指定と同じジャンルを、YouTube側の語彙で表す。
 * 「視覚的に派手で、物理的な動きがある」ものだけ。雑学・ASMRは入れない。
 */
const BUZZ_YT_QUERIES = {
  A: [
    'insane challenge reaction shorts',
    'unbelievable moment caught on camera',
    'world record attempt crazy',
    'funniest fails compilation shorts',
    'giant experiment gone wrong',
    'crowd reacts unbelievable stunt'
  ],
  B: [
    'anime best moments edit',
    'anime opening dance scene',
    'cosplay transformation shorts',
    'japan summer festival yukata',
    'anime figure collection showcase',
    'tokyo fashion street style'
  ]
};

function buzzYtQueries_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return getListProp_('BUZZ_YT_QUERIES_' + key, BUZZ_YT_QUERIES[key] || []);
}

/**
 * YouTubeから「伸びている動画」を拾う。
 *
 * ★19_Sources.gs の fetchYoutubeCandidates_ とは別に持つ。
 * あちらは商材の話題を探す用で、検索語も足切りも目的が違う。
 * APIの叩き方（search.list → videos.list で再生数）は同じ形にしてある。
 *
 * @return {Array<Object>} 再生数の降順
 */
function fetchBuzzFromYouTube_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const stat = { sub: 'YouTube', window: '-', http: 0, total: 0, scored: 0, motion: 0, kept: 0 };
  lastBuzzFetchStats_.push(stat);

  const apiKey = youtubeApiKey_();
  if (!apiKey) {
    stat.http = -3;
    return [];
  }

  const queries = buzzYtQueries_(key);
  if (!queries.length) return [];

  // 検索語は順番に回す。毎回同じ語だと同じ動画ばかりになる
  const prop = 'buzz_yt_' + key;
  const n = Number(getProp_(prop, '0')) || 0;
  const q = String(queries[n % queries.length]);
  try { props_().setProperty(prop, String((n + 1) % queries.length)); } catch (e) {}
  stat.query = q;

  const url = 'https://www.googleapis.com/youtube/v3/search?' + [
    'part=snippet', 'type=video', 'order=viewCount',
    'relevanceLanguage=en', 'maxResults=15',
    // ★期間を切らない。「今月の新作」より「伸び切った名作」の方が確実に強い
    'q=' + encodeURIComponent(q),
    'key=' + encodeURIComponent(apiKey)
  ].join('&');

  let res;
  try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); }
  catch (e) {
    stat.http = -1;
    console.warn('YouTube検索へ到達できません: ' + truncate_(String(e), 100));
    return [];
  }
  stat.http = res.getResponseCode();
  if (stat.http !== 200) {
    console.warn('YouTube検索 HTTP ' + stat.http + ': ' +
                 truncate_(res.getContentText(), 160));
    return [];
  }

  let items;
  try {
    items = (JSON.parse(res.getContentText()).items || []).filter(function (it) {
      return it && it.id && it.id.videoId;
    });
  } catch (e) {
    stat.http = -2;
    return [];
  }
  stat.total = items.length;
  if (!items.length) return [];

  // 再生数は search.list に含まれない。videos.list で取り直す
  const stats = {};
  try {
    const ids = items.map(function (it) { return it.id.videoId; }).join(',');
    const sres = UrlFetchApp.fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=' +
      encodeURIComponent(ids) + '&key=' + encodeURIComponent(apiKey),
      { muteHttpExceptions: true });
    if (sres.getResponseCode() === 200) {
      (JSON.parse(sres.getContentText()).items || []).forEach(function (v) {
        stats[v.id] = Number((v.statistics || {}).viewCount || 0);
      });
    }
  } catch (e) {
    console.warn('YouTube統計を取れません（再生数で絞れません）: ' + truncate_(String(e), 80));
  }

  const min = buzzMinViews_();
  const out = [];
  items.forEach(function (it) {
    const sn = it.snippet || {};
    const views = stats[it.id.videoId] || 0;
    // ★統計が取れなかった時は落とさない。落とすと全滅しうる
    if (views && views < min) return;
    stat.scored++;
    stat.motion++;            // YouTubeは常に動画
    const title = String(sn.title || '').trim();
    if (!title) return;
    stat.kept++;

    out.push({
      source: 'youtube-buzz',
      id: String(it.id.videoId),
      url: 'https://www.youtube.com/watch?v=' + it.id.videoId,
      title: title,
      description: truncate_(String(sn.description || ''), 400),
      author: String(sn.channelTitle || ''),
      subreddit: String(sn.channelTitle || 'YouTube'),
      publishedAt: String(sn.publishedAt || ''),
      views: views,
      imageUrl: ((sn.thumbnails || {}).high || {}).url || '',
      pattern: 'BUZZ_YT'
    });
  });

  return out.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
}

/* ------------------------------------------------------------------ */
/* 4. 映像キーワードの抽出（本文と映像を一致させる）                     */
/* ------------------------------------------------------------------ */
/*
 * ★ここが「無関係な動画」を消す本体。
 *
 * 以前は accountKey だけで決め打ちした固定語（'technology gadget desk'）で
 * ストックを引いていた。本文がレーザー加工の話でも、映像はコーヒーだった。
 * 元投稿のタイトルから名詞を拾い、それを検索語にする。
 */

/** 検索語として役に立たない語。落とす。 */
const BUZZ_STOPWORDS = (
  'the a an and or but of to in on at for with from by this that these those ' +
  'is are was were be been being it its my your our their his her ' +
  'i you he she we they me him them us ' +
  'how what why when where who which just really very so much more most ' +
  'like got get make made makes making use used using ' +
  'oc reddit today first time new old best ever finally after before ' +
  'my_first look looks looking guys please help thanks thank ' +
  'video clip gif post found saw seen check out'
).split(/\s+/);

function isBuzzStopword_(w) {
  return BUZZ_STOPWORDS.indexOf(String(w || '').toLowerCase()) !== -1;
}

/**
 * 元投稿のタイトルから映像検索語を作る。
 *
 * @param {string} accountKey
 * @param {Object} topic collectBuzzCandidates_ の1件
 * @return {string} ストック検索に渡す英語キーワード
 */
function buzzVideoQueryFromTopic_(accountKey, topic) {
  const key = String(accountKey || '').toUpperCase();
  const title = String((topic && topic.title) || '');

  const words = title
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(function (w) {
      return w.length >= 4 && w.length <= 18 && !isBuzzStopword_(w) && !/^\d+$/.test(w);
    })
    .slice(0, 3);

  /*
   * ★語尾に撮り方を足す。
   * 名詞だけだと引きの説明的な映像が返る。近接・動き・スローを
   * 付けると、実際に止まる映像の側が返ってくる（決定#045の知見）。
   */
  /*
   * ★★Bの語尾を替えた（2026-08-24、オーナー評価「0点」）。
   *
   * 'animation close up' で引くと、UIのモーショングラフィックスや
   * 抽象CGが返ってくる。Bが紹介しているのは紙とインクの作品なので、
   * 画面に出るべきは「描いている手元」「ページ」である。
   * ストック側に実在し、かつ本文の対象と同じものが映る語へ寄せた。
   */
  const lens = (key === 'B')
    ? 'illustration drawing hands close up'
    : 'macro slow motion';

  const fallback = (key === 'B')
    ? 'woman summer portrait slow motion'
    : 'crowd reaction celebration slow motion';

  if (!words.length) return fallback;

  const built = words.join(' ').toLowerCase() + ' ' + lens;

  /*
   * ★★元投稿のタイトルは外部の文字列である（2026-08-24）。
   *
   * Reddit / YouTube のタイトルに何が入るかはこちらでは決められない。
   * それをそのまま素材検索へ渡すと、狙っていない語でも検索が飛ぶ。
   * B を「セクシー寄り」へ動かした以上、ここは必ず塞いでおく。
   * 引っかかったら、その回はアカウント既定の語で撮る。
   */
  /*
   * ★typeof で守らない（2026-08-24）。
   *
   * このコードベースには「未読込でも落ちないよう typeof で守る」書き方が
   * あるが、安全弁にそれを使ってはいけない。読み込み順が変わった時に、
   * エラーも出さずに検査を素通りする状態になる。
   * GASは全 .gs を1つのスコープへ読むので、これは常に存在する。
   */
  if (!stockQueryIsSafe_(built)) return fallback;
  return built;
}

/* ------------------------------------------------------------------ */
/* 診断                                                                 */
/* ------------------------------------------------------------------ */

/** 「バズ材料」コマンド。どの板から何件拾えているかを見る。 */
function buildBuzzSourceText_() {
  const lines = ['🎯 バズ材料（神動画）', ''];
  lines.push('閾値: スコア ' + buzzMinScore_() + ' 以上 / ' +
             BUZZ_TIME_WINDOWS.join('・') + ' のトップのみ');
  lines.push('');

  Object.keys(ACCOUNTS).forEach(function (k) {
    lines.push('[' + k + '] r/' + buzzSubs_(k).join(', r/'));
    let list = [];
    try { list = collectBuzzCandidates_(k); }
    catch (e) {
      lines.push('  ❌ ' + truncate_(String(e), 80));
      return;
    }
    lines.push('  該当: ' + list.length + '件');
    list.slice(0, 3).forEach(function (c) {
      lines.push('  ・' + c.views + '↑ ' + truncate_(c.title, 44));
      lines.push('    映像検索語: ' + buzzVideoQueryFromTopic_(k, c));
    });
    if (!list.length) {
      lines.push('  ⚠️ 0件。閾値が高すぎるか、板名が違う可能性があります');
    }
    lines.push('');
  });

  return truncate_(lines.join('\n'), 4900);
}

/** GASエディタ用の公開ラッパー。 */
function showBuzzSources() {
  const t = buildBuzzSourceText_();
  console.log(t);
  return t;
}
