/**
 * ===========================================================================
 * 18_QuoteEngine.gs  —  引用リポストによる話題への参加
 * ===========================================================================
 * 伸びている投稿を検索し、その話題に沿ったコメントを付けて引用リポストする。
 *
 * 【設計の芯：見ていないものを見たと書かない】
 * このシステムが取得できるのは「投稿の本文テキスト」だけ。
 * 動画そのものは取得も再生もできない。
 * したがって「動画に映っている商品」を特定することは原理的にできない。
 *
 * だから生成文には次の制約を機械的にかけている。
 *   ・動画の中身を断定する表現を禁止（checkQuoteClaims_ で検査）
 *   ・「これと同じ商品」「まさにこれ」の類を禁止
 *   ・捏造した反響（"everyone is asking for the link"）を禁止
 *
 * 推測を書きたい場合は推測と分かる形にする。
 * 「同じ商品だ」と言えば嘘になるが、「同じ系統の話」なら本当のことしか言っていない。
 *
 * 【リンクの扱い】
 * 通常投稿と同じ validateAffiliateLink_ を通す。開示(#ad)も同じ経路で付く。
 * ゲートを通るリンクが無ければ、リンク無しのコメントだけを出す。
 *
 * 【重複】
 * 一度引用した tweet_id は Quoted シートに記録し、二度と引用しない。
 * 同じ相手に張り付き続けないよう、同一著者にも間隔を空ける。
 */

/* ------------------------------------------------------------------ */
/* 設定                                                                 */
/* ------------------------------------------------------------------ */

/**
 * アカウント別の検索クエリ。
 *
 * ★min_faves: は使っていない。
 * あれはX検索(Web)の演算子で、API v2 の recent search では
 * アクセス階層によっては 400 を返す。いいね数での絞り込みは
 * public_metrics を取得してコード側で行う（各パターンの minLikes）。
 */
/**
 * 検索パターン。Bは複数持ち、実行のたびに切り替える（味変）。
 *
 * ★どのパターンにも has:video を付けない。ここが設計上いちばん重要。
 *
 * 成人向けの話題で英語の「動画クリップ」が伸びているアカウントは、
 * その大半が無断転載。特に onlyfans + has:video は流出クリップを
 * 狙い撃ちで拾う組み合わせになる（避けたいものを検索条件にしてしまう）。
 * テキストの議論・レビュー・業界話なら本人たちの会話であり、
 * そこへ参加するのは普通の使い方。だから動画条件を外し、会話を対象にする。
 *
 * Culture Clash の煽りは、動画より議論スレッドの方がむしろ刺さる。
 */
const QUOTE_PATTERNS = {
  /*
   * ★2026-08-17、オーナー指摘で全面的に作り直した。
   *
   * 直す前の間違いが3つあった。
   *
   * 1. いいね数を品質の根拠にしていた（A は 3000、B は 300〜500）。
   *    いいね数が測っているのは投稿者のリーチであって、物の良さではない。
   *    50いいねの工房の投稿の方が、3000いいねのミーム転載より
   *    紹介する価値があることは普通に起きる。しきい値は「明らかな
   *    ノイズを落とす」以上の意味を持たせない。
   *
   * 2. 引用RTを販売導線と混同していた。引用RTにアフィリエイトリンクは
   *    貼らない。仕事はリーチとフォローであって、コンバージョンではない。
   *    だから「売る物」で検索対象を絞る理由がない。売るのは日本製でも、
   *    紹介するのは米国製でも中国製でもいい。フォローに繋がれば成立する。
   *
   * 3. 視野が狭かった。1ジャンル1クエリでは雑誌の取材者にならない。
   *    物・作り・道具・素材の世界を横断して拾う。
   *
   * ★写真は必須のまま（requireMedia）。ここは変えない。
   * 文字だけで物を紹介しても人の目は止まらないし、このBotには画像を
   * アップロードする機能が無い。引用RTなら画像は引用元が持っている。
   */
  'A': [
    // --- 作る・直す ---
    { key: 'CRAFT',      minLikes: 15, requireMedia: true,
      query: '(workshop OR handmade OR handcrafted OR artisan OR craftsmanship OR maker OR atelier) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'FORGE',      minLikes: 15, requireMedia: true,
      query: '(blacksmith OR forged OR "knife making" OR bladesmith OR "heat treat" OR anvil OR smithing) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'WOOD',       minLikes: 15, requireMedia: true,
      query: '(woodworking OR joinery OR "hand plane" OR dovetail OR "wood grain" OR lutherie OR woodturning) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'MACHINE',    minLikes: 15, requireMedia: true,
      query: '(machining OR "cnc" OR lathe OR "machine shop" OR toolmaking OR "3d printed" OR fabrication) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'RESTORE',    minLikes: 15, requireMedia: true,
      query: '(restoration OR restored OR "before and after" OR patina OR refurbished OR salvaged OR rebuild) -is:retweet -is:reply -is:quote lang:en' },

    // --- 着る ---
    { key: 'DENIM',      minLikes: 15, requireMedia: true,
      query: '(denim OR selvedge OR "raw denim" OR indigo OR fades OR jeans OR chambray) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'LEATHER',    minLikes: 15, requireMedia: true,
      query: '(leatherwork OR "leather boots" OR "goodyear welt" OR "veg tan" OR cordovan OR bootmaker OR saddlery) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'TAILORING',  minLikes: 15, requireMedia: true,
      query: '(tailoring OR bespoke OR "pattern making" OR stitching OR workwear OR "made to measure" OR menswear) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'TEXTILE',    minLikes: 15, requireMedia: true,
      query: '(weaving OR loom OR "natural dye" OR sashiko OR boro OR "hand woven" OR textile) -is:retweet -is:reply -is:quote lang:en' },

    // --- 道具・持ち物 ---
    { key: 'EDC',        minLikes: 15, requireMedia: true,
      query: '("everyday carry" OR edc OR "pocket dump" OR multitool OR "carry setup" OR gearcheck) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'HANDTOOL',   minLikes: 15, requireMedia: true,
      query: '("hand tools" OR toolbox OR "vintage tools" OR chisel OR "tool roll" OR wrench OR handplane) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'WATCH',      minLikes: 15, requireMedia: true,
      query: '(horology OR "mechanical watch" OR "watch movement" OR "dive watch" OR watchmaking OR wristwatch) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'PEN',        minLikes: 15, requireMedia: true,
      query: '(stationery OR "fountain pen" OR notebook OR "writing desk" OR ink OR "paper quality" OR journaling) -is:retweet -is:reply -is:quote lang:en' },

    // --- 台所・食まわり ---
    { key: 'KITCHEN',    minLikes: 15, requireMedia: true,
      query: '("kitchen knife" OR "carbon steel pan" OR "cast iron" OR cookware OR "chef knife" OR whetstone OR sharpening) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'COFFEE',     minLikes: 15, requireMedia: true,
      query: '("coffee gear" OR "espresso machine" OR "hand grinder" OR "pour over" OR kettle OR moka) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'CERAMIC',    minLikes: 15, requireMedia: true,
      query: '(pottery OR ceramics OR "wheel thrown" OR glaze OR kiln OR stoneware OR earthenware) -is:retweet -is:reply -is:quote lang:en' },

    // --- 光学・音・乗り物 ---
    { key: 'CAMERA',     minLikes: 15, requireMedia: true,
      query: '("film camera" OR "vintage lens" OR rangefinder OR "camera design" OR darkroom OR optics OR photography) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'AUDIO',      minLikes: 15, requireMedia: true,
      query: '(hifi OR turntable OR "speaker build" OR headphones OR "audio gear" OR amplifier OR vinyl) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'BIKE',       minLikes: 15, requireMedia: true,
      query: '("steel frame" OR framebuilder OR "bicycle build" OR randonneur OR "bike gear" OR cycling) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'OUTDOOR',    minLikes: 15, requireMedia: true,
      query: '("camp gear" OR bushcraft OR "ultralight" OR "field notes" OR canvas OR "outdoor kit" OR camping) -is:retweet -is:reply -is:quote lang:en' },

    // --- 見る・置く ---
    { key: 'DESIGN',     minLikes: 15, requireMedia: true,
      query: '("industrial design" OR "product design" OR "design detail" OR "form follows" OR prototype OR designed) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'FURNITURE',  minLikes: 15, requireMedia: true,
      query: '("furniture design" OR "mid century" OR "chair design" OR cabinetmaking OR "solid wood" OR joinery) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'TYPE',       minLikes: 15, requireMedia: true,
      query: '(typography OR letterpress OR "book binding" OR "print design" OR signage OR lettering OR calligraphy) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'ARCH',       minLikes: 15, requireMedia: true,
      query: '(architecture OR "interior design" OR "concrete" OR "building detail" OR joinery OR facade) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'MODEL',      minLikes: 15, requireMedia: true,
      query: '("scale model" OR "model kit" OR gunpla OR diorama OR miniature OR "model making" OR kitbash) -is:retweet -is:reply -is:quote lang:en' },

    // --- 日本（数あるレンズの1つ）---
    { key: 'JAPAN',      minLikes: 15, requireMedia: true,
      query: '("made in japan" OR "japanese craftsmanship" OR "japanese knife" OR "japanese denim" OR seki OR sakai) -is:retweet -is:reply -is:quote lang:en' },
    { key: 'JAPAN_DAILY',minLikes: 15, requireMedia: true,
      query: '("japanese stationery" OR "japanese tools" OR "japanese ceramics" OR "japanese kitchenware" OR "japanese design") -is:retweet -is:reply -is:quote lang:en' },

    // --- 受け皿 ---
    { key: 'TECH',       minLikes: 25, requireMedia: true,
      query: '(gadget OR "desk setup" OR "tech review" OR teardown) -is:retweet -is:reply -is:quote lang:en' }
  ],

  /*
   * ★Bはジャンルを大きく広げた（2026-08-17、オーナー指示）。
   *
   * DLsite / FANZA / Fantia に実際に存在する商業カテゴリを、
   * カテゴリとして扱う。ここを避けていると
   * 「何も具体的に言わないアカウント」になり、案内役として弱い。
   *
   * ただし検索語として絶対に入れないものがある：
   *   ・未成年に見えるキャラクターを指す語（loli / shota 等）
   *   ・流出・無修正・割れを示す語
   * 前者は法域によって違法で、日本の法にも触れうる。
   * 後者は権利者の売上を奪う側で、ASPを切られる直接の理由になる。
   * 「ギリギリ」の範囲はカテゴリの話までで、この2つは線の外側。
   *
   * 生成側の0点ルール（実在個人・流出物の示唆・行為の直接描写）は
   * これまでどおり効いている。ここは検索対象を広げただけ。
   */
  'B': [
    /*
     * ★2026-08-17に広げすぎたので、翌日ジャンルへ寄せ直した（オーナー指摘）。
     *
     * 「anime art」「character design」「localization」のような語を
     * 単独で置くと、一般のアニメ・イラスト・ゲーム談義を大量に拾う。
     * それを引用すると、Bは成人・同人の案内役ではなく
     * ただのアニメ好きアカウントになる。
     *
     * だから全パターンに、成人・同人・購入のいずれかの錨を必ず入れる。
     * 錨: doujin / eroge / hentai / r18 / adult / DLsite / FANZA / Fantia
     */
    /*
     * ★2026-08-19、唯一ここだけ成人の錨が無かった（オーナー指摘）。
     * "doujin"単独では同人ゲーム・同人漫画の全年齢作品も大量に拾う。
     * それを引用すると、11パターン中この1本だけがBの主題（成人向け同人の
     * 案内）からずれた投稿になっていた。成人の錨とAND条件にする。
     */
    { key: 'DOUJIN',     minLikes: 10, requireMedia: true,
      query: '(doujin OR doujinshi OR comiket OR "comic market" OR "doujin circle") ' +
             '(r18 OR "18+" OR nsfw OR adult OR hentai OR eroge) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'DOUJIN_GAME',minLikes: 10, requireMedia: true,
      query: '(eroge OR "adult game" OR "adult visual novel" OR "18+ game" OR "doujin game" OR nukige) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'HENTAI_GENRE', minLikes: 10, requireMedia: true,
      query: '(hentai OR "r18 manga" OR "adult manga" OR "h manga" OR "ero manga" OR "18+ doujin") -is:retweet -is:reply -is:quote lang:en' },

    { key: 'FETISH_TAXONOMY', minLikes: 10, requireMedia: true,
      query: '("fetish genre" OR "niche tag" OR "genre tags" OR "tag search") (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    // ★絵の話は「成人向けの絵」に限定する。一般のファンアートは拾わない。
    { key: 'R18_ART',    minLikes: 10, requireMedia: true,
      query: '("r18 art" OR "r18 illustrator" OR "adult illustration" OR "ero art" OR "18+ artist" OR "lewd art") (japanese OR doujin OR manga OR anime) -is:retweet -is:reply -is:quote lang:en' },

    // ★Fanbox / Fantia は成人向けの主戦場。ただし錨は付けておく。
    { key: 'CREATOR_ECON', minLikes: 10, requireMedia: true,
      query: '(fanbox OR fantia OR "pixiv" OR "supporting the artist") (r18 OR doujin OR hentai OR "adult" OR "18+") -is:retweet -is:reply -is:quote lang:en' },

    // ★一般のASMRを拾わないよう、同人音声・成人向けに寄せる
    { key: 'VOICE',      minLikes: 10, requireMedia: true,
      query: '("doujin voice" OR "voice work" OR "drama cd" OR "audio work" OR ASMR) (r18 OR doujin OR DLsite OR "18+" OR eroge) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'JAV_SCENE',  minLikes: 10, requireMedia: true,
      query: '(JAV OR "japanese adult" OR FANZA OR "adult industry japan" OR "japanese porn industry") -is:retweet -is:reply -is:quote lang:en' },

    // ★「日本の通販で買えない」ではなく「同人・成人向けが買えない」に限定
    { key: 'BUYING',     minLikes: 10, requireMedia: true,
      query: '("region locked" OR "payment declined" OR "proxy service" OR "cannot buy") (DLsite OR FANZA OR doujin OR eroge OR "adult game") -is:retweet -is:reply -is:quote lang:en' },

    // ★一般のゲームローカライズ議論を拾わないよう、成人向けに限定
    { key: 'CENSORSHIP', minLikes: 10, requireMedia: true,
      query: '(censorship OR mosaic OR "censored" OR "translation patch") (eroge OR hentai OR doujin OR "adult game" OR "r18") -is:retweet -is:reply -is:quote lang:en' },

    // 味変。海外アダルト議論に「日本の方が深い」を被せる枠
    { key: 'CULTURE_CLASH', minLikes: 25, requireMedia: true,
      query: '("porn industry" OR "adult industry" OR "adult content" OR "western porn" OR "adult film") -is:retweet -is:reply -is:quote lang:en' },

    /*
     * ★売れているジャンルから引いた検索軸（2026-08-19、オーナー共有）。
     *
     * 出典はX上の投稿で、AI画像の販売ジャンル別売上を並べたもの。
     * 金額（月2〜30万）は裏付けが取れないので採らない。
     * 採ったのは「どのジャンルが商業的に成立しているか」という並びだけで、
     * これは DLsite / FANZA に実在するカテゴリ分類と一致する。
     *
     * ★英語圏の呼び方で引く。日本語のタグ名で lang:en を検索しても当たらない。
     * netorare/NTR・gyaru・milf のように、海外の同人コミュニティで
     * 実際に使われている語を使う。
     *
     * ★錨は全てに付ける。これらの語は一般のアダルト（実写・海外物）にも
     * 使われるため、錨が無いとBの主題（日本の同人・成人向け）から外れる。
     *
     * ── 意図的に入れなかったもの ──
     * 元リストの「制服・学園もの」「女教師」「妹・近親」は入れない。
     * 作品として存在することは知っているが、検索語として置くと
     * 未成年に見える対象を含む投稿を拾う。ここはCLAUDE.mdで
     * 「変更してはいけないもの」として残している線であり、
     * 表現の強さの話とは別枠。
     */
    { key: 'GENRE_NTR',     minLikes: 10, requireMedia: true,
      query: '(netorare OR NTR OR "cheating wife") (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'GENRE_MATURE',  minLikes: 10, requireMedia: true,
      query: '(milf OR "mature woman" OR "married woman" OR "human wife") (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'GENRE_GYARU',   minLikes: 10, requireMedia: true,
      query: '(gyaru OR gal) (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'GENRE_OFFICE',  minLikes: 10, requireMedia: true,
      query: '("office lady" OR secretary OR "office worker" OR "work romance") (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'GENRE_MIND',    minLikes: 10, requireMedia: true,
      query: '(hypnosis OR "mind control" OR corruption OR "mind break") (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'GENRE_PUBLIC',  minLikes: 10, requireMedia: true,
      query: '(exhibitionism OR "public play" OR outdoor) (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' },

    { key: 'GENRE_BREED',   minLikes: 10, requireMedia: true,
      query: '(breeding OR impregnation OR "seeding") (doujin OR hentai OR eroge OR "r18" OR DLsite OR FANZA) -is:retweet -is:reply -is:quote lang:en' }
  ]
};

/** そのアカウントの検索パターン一覧。 */
function quotePatternsFor_(accountKey) {
  return QUOTE_PATTERNS[String(accountKey || '').toUpperCase()] || [];
}

/** 次に使うパターンを返す。アカウントごとに順番に回す。 */
function nextQuotePattern_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const list = QUOTE_PATTERNS[key];
  if (!list || !list.length) throw new Error('検索パターンが未定義です: ' + accountKey);
  if (list.length === 1) return list[0];

  const prop = 'quote_pattern_' + key;
  const n = Number(getProp_(prop, '0')) || 0;
  try { props_().setProperty(prop, String((n + 1) % list.length)); } catch (e) {}
  return list[n % list.length];
}

/** 1回の検索で取る件数。X APIの下限は10。 */
const QUOTE_SEARCH_MAX = 25;

/**
 * 1回の実行で試す検索パターンの数。
 *
 * ★既定を3から2へ下げた（2026-08-18）。
 * ジャンルを28本に広げた際、1サイクルで最大3回検索するようにしたが、
 * これは読み取り回数を12回/日から36回/日へ3倍に増やす変更だった。
 * 同じ日にXのクレジットが尽きて402で停止しており、
 * この増分が消費を早めた可能性が高い。
 *
 * 2なら幅は保ちつつ増分を1/3に抑えられる。
 * 残高に余裕ができたら QUOTE_PATTERN_TRIES プロパティで戻せる。
 */
/*
 * ★2026-08-19、2→1へ下げた。
 * 無料の情報源を先に試す順序にしたので、ここまで来る回は減った。
 * それでも来た回に2回叩くと、1日あたりの消費が読めなくなる。
 * 幅はジャンル28本の巡回で確保できているので、1回で足りる。
 */
const QUOTE_PATTERN_TRIES_DEFAULT = 1;

function quotePatternTries_() {
  const n = Number(getProp_('QUOTE_PATTERN_TRIES', String(QUOTE_PATTERN_TRIES_DEFAULT)));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(n, 5);
}

/** 同じ著者を再び引用するまでに空ける件数。 */
const QUOTE_AUTHOR_COOLDOWN = 20;

/** 記録を保持する件数（Quotedシート）。 */
const QUOTE_HISTORY_KEEP = 500;

const QUOTED_SHEET_NAME = 'Quoted';
const QUOTED_HEADERS = ['Timestamp', 'Account', 'Tweet ID', 'Author ID', 'Author',
                        'Target Text', 'Posted Text', 'Post ID', 'Link URL'];

/* ------------------------------------------------------------------ */
/* 引用済みの記録                                                       */
/* ------------------------------------------------------------------ */

function getOrCreateQuotedSheet_(ss) {
  const spreadsheet = ss || openLogSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(QUOTED_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(QUOTED_SHEET_NAME);
    sheet.getRange(1, 1, 1, QUOTED_HEADERS.length).setValues([QUOTED_HEADERS]);
    sheet.getRange(1, 1, 1, QUOTED_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  ensureTrailingHeaders_(sheet, QUOTED_HEADERS);
  return sheet;
}

/**
 * 引用済みの履歴を新しい順に返す。
 * @return {Array<{tweetId:string, authorId:string, account:string}>}
 */
function readQuotedHistory_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const from = Math.max(2, lastRow - QUOTE_HISTORY_KEEP + 1);
  const values = sheet.getRange(from, 1, lastRow - from + 1, 5).getValues();

  // ★保存時に先頭へ ' を付けている（19桁のIDをスプレッドシートが数値へ
  // 丸めるのを防ぐため）。読む側で必ず外すこと。
  // 外し忘れると "'111" と "111" が別物になり、重複排除が丸ごと無効になる。
  const id = function (v) { return String(v == null ? '' : v).replace(/^'/, '').trim(); };

  return values.map(function (r) {
    return {
      account: String(r[1] || ''),
      tweetId: id(r[2]),
      authorId: id(r[3])
    };
  }).filter(function (h) { return h.tweetId; }).reverse();
}

function rememberQuoted_(sheet, entry) {
  sheet.appendRow([
    new Date(), entry.account, "'" + entry.tweetId, "'" + entry.authorId,
    entry.author || '', truncate_(entry.targetText || '', 200),
    truncate_(entry.postedText || '', 300), entry.postId || '', entry.linkUrl || ''
  ]);
}

/* ------------------------------------------------------------------ */
/* 検索                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 429（レート制限）を指数バックオフで待つ検索リクエスト。
 *
 * ★投稿と違い、検索は何度やっても副作用が無い。
 * だから投稿(postTweet_)とは逆に、ここでは再試行してよい。
 * x-rate-limit-reset が返る場合はそれに従う（当てずっぽうに待たない）。
 */
function fetchSearchWithBackoff_(url, params, maxAttempts) {
  const attempts = maxAttempts || 3;

  for (let i = 1; i <= attempts; i++) {
    const res = UrlFetchApp.fetch(url, params);
    const code = res.getResponseCode();

    if (code !== 429 && code < 500) return res;
    if (i === attempts) return res;

    let waitMs = 1000 * Math.pow(2, i);      // 2s, 4s, 8s
    if (code === 429) {
      const reset = Number((res.getAllHeaders() || {})['x-rate-limit-reset'] || 0);
      if (reset) {
        const untilMs = (reset * 1000) - Date.now();
        // GASの実行枠は6分。それを超える待ちは諦めて次回の起動に回す。
        if (untilMs > 90000) {
          console.warn('レート制限の解除まで' + Math.round(untilMs / 1000) +
                       '秒。今回は諦めます。');
          return res;
        }
        if (untilMs > 0) waitMs = untilMs + 1000;
      }
    }
    console.warn('HTTP ' + code + ' のため' + Math.round(waitMs / 1000) +
                 '秒待って再試行 (' + i + '/' + attempts + ')');
    Utilities.sleep(waitMs);
  }
  throw new Error('検索に失敗しました。');
}

/**
 * 引用対象の候補を検索する。
 * @return {Array<Object>} 新しい順ではなく、いいね数の多い順
 */
function searchQuoteTargets_(accountKey, pattern) {
  const key = String(accountKey || '').toUpperCase();
  const pat = pattern || nextQuotePattern_(key);
  const query = pat.query;

  /*
   * ★1日の上限を超えていたら叩かない（無料の情報源で回す方針）。
   * ここで止めるのは、呼び出し側が増えても漏れないようにするため。
   * 空配列を返せば、呼び出し側は「候補が無かった回」として続行する。
   */
  if (!xSearchAllowed_()) {
    console.log('X検索は本日の上限（' + xSearchDailyMax_() +
                '回）に達しています。無料の情報源で回します。');
    return [];
  }

  // ★何回叩いたかを数える。見えないと、また気づかないうちに増える
  noteXSearchCall_();

  const service = getXService_(key);
  if (!service.hasAccess()) throw new NeedsAuthError(key);

  const params = [
    'query=' + encodeURIComponent(query),
    'max_results=' + QUOTE_SEARCH_MAX,
    'tweet.fields=public_metrics,created_at,author_id,lang,possibly_sensitive,attachments',
    // ★画像の有無を判定するためにメディアも展開する。
    // 検索演算子(has:images)はこのアクセス階層で弾かれる可能性があるため、
    // 取得したうえで自前で判定する方式にしている。
    'expansions=author_id,attachments.media_keys',
    'media.fields=type,url,preview_image_url',
    'user.fields=username,name,verified'
  ];
  const url = 'https://api.x.com/2/tweets/search/recent?' + params.join('&');

  const res = fetchSearchWithBackoff_(url, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code === 429) {
    console.warn('検索がレート制限中。今回はスキップします。');
    return [];
  }
  if (code !== 200) {
    console.error('検索エラー ' + code + ': ' + truncate_(body, 300));
    if (code === 400) {
      notifyAdmin_('⚠️ 引用検索のクエリが拒否されました（400）。\n' +
                   'X APIのプランで使えない演算子が含まれている可能性があります。\n' +
                   truncate_(body, 200));
    }
    if (code === 403) {
      notifyAdmin_('⚠️ 引用検索が403。X APIのプランで検索が使えない可能性があります。');
    }
    return [];
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return []; }

  const users = {};
  ((parsed.includes && parsed.includes.users) || []).forEach(function (u) {
    users[u.id] = u;
  });

  // media_key → 種別。写真が付いている投稿だけを残すために使う。
  const media = {};
  ((parsed.includes && parsed.includes.media) || []).forEach(function (m) {
    if (m.media_key) media[m.media_key] = String(m.type || '');
  });

  const minLikes = pat.minLikes || 0;

  return (parsed.data || []).map(function (t) {
    const m = t.public_metrics || {};
    const u = users[t.author_id] || {};
    return {
      id: String(t.id),
      text: String(t.text || ''),
      authorId: String(t.author_id || ''),
      author: String(u.username || ''),
      likes: Number(m.like_count || 0),
      reposts: Number(m.retweet_count || 0),
      sensitive: !!t.possibly_sensitive,
      pattern: pat.key,
      hasMedia: (((t.attachments && t.attachments.media_keys) || []).some(function (k) {
        const type = media[k];
        return type === 'photo' || type === 'animated_gif' || type === 'video';
      })),
      /*
       * ★動画かどうかを別に持つ（31_RefPost.gs が使う）。
       * 検索演算子 has:video はこの階層で 400 を返す（実測）。
       * 取得したメディア種別を自前で見るしかない。
       */
      hasVideo: (((t.attachments && t.attachments.media_keys) || []).some(function (k) {
        const type = media[k];
        return type === 'video' || type === 'animated_gif';
      }))
    };
  }).filter(function (t) {
    if (t.likes < minLikes) return false;
    // ★写真のない投稿を引用しても、タイムラインでは文字だけになる。
    // 物を紹介する以上、目に入るものが無ければ引用する意味がない。
    if (pat.requireMedia && !t.hasMedia) return false;
    return true;
  }).sort(function (a, b) { return b.likes - a.likes; });
}

/* ------------------------------------------------------------------ */
/* 対象の選定                                                           */
/* ------------------------------------------------------------------ */

/**
 * 引用してよい対象を1件選ぶ。
 *
 * 除外するもの：
 *   ・既に引用済みの投稿（二度と同じ投稿に付かない）
 *   ・直近で引用した著者（同じ相手に張り付かない）
 *   ・自分自身の投稿
 *   ・本文が短すぎて話題を判断できないもの
 */
function pickQuoteTarget_(candidates, history, accountKey) {
  const quotedIds = {};
  const recentAuthors = {};

  history.forEach(function (h, i) {
    quotedIds[h.tweetId] = true;
    if (i < QUOTE_AUTHOR_COOLDOWN) recentAuthors[h.authorId] = true;
  });

  const selfId = getXUserId_(accountKey) || '';

  const usable = (candidates || []).filter(function (t) {
    if (quotedIds[t.id]) return false;
    if (recentAuthors[t.authorId]) return false;
    if (selfId && t.authorId === selfId) return false;
    // 本文が短いと「何の話題か」を読み取れない。
    // 読み取れないまま書くと、当たり障りのない文か、推測の断定になる。
    if (stripUrls_(t.text).replace(/\s+/g, ' ').trim().length < 30) return false;
    return true;
  });

  return usable.length ? usable[0] : null;
}

/* ------------------------------------------------------------------ */
/* 生成                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 断定してはいけない表現。
 *
 * ★ここが「見ていないものを見たと書かない」の実装。
 * 動画を取得していない以上、中身への言及は全て推測でしかない。
 */
const QUOTE_BANNED_CLAIMS = [
  // 偽の自己使用（FTCが明確に禁じている「使っていないのに使ったと言う」推奨）
  'i actually use', 'i use this', 'i own this', 'i tested', 'i switched to',
  'my setup uses', 'been using this',
  // 裏付けの無い倍率・比較の断定
  '10x more', '10x faster', '10x better', 'twice as fast', 'half the price',
  // 見ていない動画への言及
  'in the video', 'in this video', 'in the clip', 'the exact item',
  'the exact product', 'this exact', 'found the item', 'found the exact',
  'the item shown', 'the product shown', 'shown here', 'pictured here',
  'everyone is asking', 'everyone is begging', 'everyone wants',
  'people keep asking', 'you all keep asking', 'the one from the video',
  'same item', 'same product', 'link to this', 'link for this'
];

/**
 * 特定の個人（出演者・演者）について語っていることを示す表現。
 *
 * ★これを弾く理由。
 * 実写の成人向け作品の出演者は実在の人物であり、その多くが本名でない名前で
 * 活動している。2022年の出演被害防止・救済法が扱っているとおり、
 * 意に反する出演として作品の削除を求めている人が現実にいる。
 * このシステムには、目の前の名前がその一人かどうかを判別する手段が無い。
 *
 * 判別できないなら、個人に触れないことでしか避けられない。
 * ジャンル・作品分類・買い方の話に留めれば、この問題は発生しない。
 */
const QUOTE_BANNED_PERSON_REFS = [
  'her new', 'her latest', 'her best', 'her releases', 'her work', 'her scenes',
  'her debut', 'her videos', 'her content', 'she just dropped', 'she just released',
  'she stars', 'she appears', 'his new', 'his latest', 'his releases',
  'this actress', 'that actress', 'the actress', 'this performer', 'that performer',
  'jav idol', 'av idol', 'her body', 'her face'
];

/* ------------------------------------------------------------------ */
/* 感想は書かせる。ただし「見ていないものの批評」だけは通さない          */
/* ------------------------------------------------------------------ */
/*
 * ★オーナーの要望は「記事や投稿への感想を書け、☆3のように評価しろ」。
 * これは正しい。要約だけの引用は読まれない。読者は判断を求めている。
 *
 * ただし本編は見ていない。だから線をここに引く。
 *   ○ 主張・手法・前提への意見 …… 実際に読んだ見出しに対する判断。本物
 *   × 本編そのものの批評・推薦 …… 見ていない。確認できる嘘になる
 *
 * この線は意見の強さを一切制限しない。
 * 「この見出しは間違っている」と言い切るのは前者であり、いくらでも書ける。
 */
const REVIEW_OF_UNSEEN = [[
  // 見たと言ってしまう
  'just watched', 'i watched', 'after watching', 'watched this',
  'just read this', 'i read this', 'after reading this', 'read the whole',
  // 見ていない本編の出来を評価する
  'great video', 'good video', 'nice video', 'best video', 'amazing video',
  'great read', 'good read', 'solid read', 'great article', 'good article',
  'well made', 'well produced', 'well written', 'well shot',
  // 見ていないものを勧める
  'worth a watch', 'worth watching', 'worth a read', 'worth reading',
  'must watch', 'must-watch', 'must read', 'must-read',
  'recommend watching', 'recommend this video', 'recommend this article',
  'go watch it', 'go watch this', 'watch the whole thing'
]];

/** 採点の書き方。☆☆☆ / 3/5 / ☆3 を拾う。 */
const RATING_TOKEN = /(?:[★☆]{1,5}|\b[1-5]\s*\/\s*5\b|[★☆]\s*[1-5]\b)/;

/**
 * 採点の対象が書かれているか。
 *
 * 同じ行に「何に対する採点か」が無ければ、見ていない本編への評価に読める。
 * 対象として認めるのは、実際に読んだ見出しから判断できるものだけ。
 *
 * @return {string} 対象の無い採点行（無ければ空文字）
 */
function findUnscopedRating_(text, hasRead) {
  // ★"for" や "on" のような前置詞を対象語として認めない。
  // 認めると「☆☆☆ for this title」——見ていない作品への採点——が通ってしまう。
  // 対象は、見出しから実際に判断できる名詞に限る。
  const CLAIM_SUBJECT =
    'idea|ideas|approach|claim|premise|concept|method|design|spec|specs|take|pitch|' +
    'framing|argument|thesis|logic|tradeoff|tradeoffs|advice|theory|reasoning|' +
    'assumption|format|genre|category';

  // 本文を読めた回に限り、記事そのものを対象にしてよい。実際に読んだのだから。
  const READ_SUBJECT = 'article|piece|writeup|write-up|report|reporting|analysis|' +
                       'headline|post|read|coverage';

  const SUBJECT = new RegExp(
    '\\b(' + CLAIM_SUBJECT + (hasRead ? '|' + READ_SUBJECT : '') + ')\\b', 'i');
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RATING_TOKEN.test(line)) continue;
    if (SUBJECT.test(line)) continue;
    return line.trim();
  }
  return '';
}

/**
 * 生成文が「見ていないもの」を断定していないか検査する。
 * Bでは加えて、特定の個人について語っていないかも見る。
 *
 * @param {string} text
 * @param {string} accountKey 省略時は個人参照チェックを行わない
 * @return {{ok:boolean, reason:string}}
 */
function checkQuoteClaims_(text, accountKey, opts) {
  const lower = String(text || '').toLowerCase();
  const key = String(accountKey || '').toUpperCase();

  /*
   * hasRead は「本文を実際に取得できた」ことを示す。
   * ★呼び出し側が取得した文字数で決めており、LLMの申告では決まらない。
   * 読めている時は、読者としての感想がそのまま事実なので制限を外す。
   */
  const hasRead = !!(opts && opts.hasRead);

  /*
   * ★Bは☆を使わせない。
   * 案内先カタログの作品評価と読み違えられるため。Bの意見は言葉で書く。
   */
  if (key === 'B' && RATING_TOKEN.test(String(text || ''))) {
    return {
      ok: false,
      reason: 'You used a star rating. This account never scores anything — a rating ' +
              'here reads as the store rating of a work. Say what you think in words.'
    };
  }

  if (!hasRead) {
    // ★見ていない本編そのものへの批評・推薦。
    // 感想は書かせるが、それは「主張への意見」であって「作品の批評」ではない。
    // 見ていないものを勧めるのは、確認できる嘘であり一度で信用を失う。
    for (let k = 0; k < REVIEW_OF_UNSEEN[0].length; k++) {
      const p = REVIEW_OF_UNSEEN[0][k];
      if (lower.indexOf(p) !== -1) {
        return {
          ok: false,
          reason: 'You wrote "' + p + '", which reviews or recommends the item itself. ' +
                  'You never watched or read it. Judge the CLAIM instead: the idea, the ' +
                  'approach, the tradeoff. You can be just as blunt about that, and it is true.'
        };
      }
    }
  }

  // ★採点は歓迎するが、何に対する採点かを必ず書かせる。
  // 本文を読めていても「☆☆☆」だけでは何を評価したのか読者に伝わらない。
  const ratingLine = findUnscopedRating_(String(text || ''), hasRead);
  if (ratingLine) {
    return {
      ok: false,
      reason: 'You wrote the rating "' + ratingLine + '" without saying what it is for. ' +
              'A rating has to name its subject on the same line' +
              (hasRead ? '.' : ', and the subject has to be the claim or the approach — ' +
                              'never the video or the article.') +
              ' Write it like "☆☆ for the premise — right problem, wrong fix."'
    };
  }

  for (let i = 0; i < QUOTE_BANNED_CLAIMS.length; i++) {
    const p = QUOTE_BANNED_CLAIMS[i];
    if (lower.indexOf(p) !== -1) {
      return {
        ok: false,
        reason: 'You wrote "' + p + '". You cannot see the video, only the post text. ' +
                'Never claim to know what is shown, and never claim to have found the ' +
                'same item. Talk about the topic, not the footage.'
      };
    }
  }

  if (String(accountKey || '').toUpperCase() === 'B') {
    for (let j = 0; j < QUOTE_BANNED_PERSON_REFS.length; j++) {
      const q = QUOTE_BANNED_PERSON_REFS[j];
      if (lower.indexOf(q) !== -1) {
        return {
          ok: false,
          reason: 'You wrote "' + q + '", which is about a specific person. ' +
                  'Never write about an individual performer. Write about the genre, ' +
                  'the format, how the store works, or how to buy it — never about a person.'
        };
      }
    }
  }

  return { ok: true, reason: '' };
}

/** 引用コメント用のシステムプロンプト。 */
function buildQuoteSystemPrompt_(accountKey, link, disclosureTag, patternKey) {
  const key = String(accountKey || '').toUpperCase();

  const common = [
    'You are writing a quote-post: a short comment attached to somebody else\'s post.',
    '',
    'CRITICAL — what you actually know:',
    'You can read the TEXT of their post. You CANNOT see the video or images.',
    'You do not know what is shown in it. You have not watched it.',
    'Therefore:',
    '- Never say "in the video", "the exact item", "the one shown", or anything',
    '  that claims knowledge of the footage.',
    '- Never invent a reaction ("everyone is asking for the link"). You do not know that.',
    '- If you want to connect it to something, connect it to the TOPIC, and make it',
    '  obvious that you are adding your own angle rather than identifying their item.',
    '',
    'Respond to the topic they raised. Add something the reader did not have before.',
    'Do not summarise their post back to them. Do not compliment them generically.',
    'Never be condescending about the original poster or their audience.'
  ];

  if (key === 'B') {
    common.push('',
      "You are 'Secret Mia', gatekeeper of Japan's premium adult and doujin catalogue",
      'for an English-speaking audience. all lowercase, always.',
      '',
      'Your move on a quote-post: they are discussing the shallow end. you have seen',
      'the deep end. make them feel that gap, then point at the door.',
      '  1. HOOK — condescending and alluring. "cute taste." / "you are barely',
      '     scratching the surface." mock the shallow end, never the human being.',
      '  2. FLEX — imply the intensity and scale of what they have not seen.',
      '     suggest, never depict. no explicit description of any act.',
      '  3. DROP — with a link, let them in. without one, make following the price',
      '     of entry: "follow me. i am opening the vault soon."',
      '',
      'ABSOLUTE — these void the post:',
      '  - never write about an individual. no performers, no actresses, no names,',
      '    no "her latest". real people are in this material and you cannot know',
      '    whether any of them consents to being promoted.',
      '  - never promise uncensored, leaked or stolen material. what you point at is',
      '    official and censored under Japanese law. "premium" yes, "uncensored" no.',
      '  - never describe a sexual act. you gesture at the door, you do not go through it.',
      '  - never sexualise the original poster or anyone in their post.');

    if (patternKey === 'CULTURE_CLASH') {
      common.push('',
        'THIS POST IS A CULTURE CLASH. They are talking about western adult content.',
        'Your angle: playfully dismiss it as the shallow end, then flex what the',
        'Japanese side actually has — production, range, how specific the catalogue',
        'gets, how much never surfaces in english.',
        '  "western adult content is so basic." / "you get excited over this?"',
        'Compare scenes and catalogues, never individual people on either side.',
        'Do not insult the performers in what they posted. The target of the tease',
        'is the taste, not any human being.');
    }
  } else {
    common.push('',
      'You are an expert on tech, gadgets and workflow. You quote-post to add',
      'something the original does not have, not to summarise it.',
      '',
      'Your move is the smarter alternative:',
      '  1. Acknowledge what the post gets right, in a few words. Never fawn.',
      '  2. Then add the thing an expert would know — the tradeoff nobody mentions,',
      '     the category that solves it better, the reason the popular approach breaks.',
      '  3. If a link is given, land on it as the upgrade path.',
      '',
      'Be confident and direct. You are the most competent person in the replies.',
      'Never sneer at the original poster or their audience — you win by being right,',
      'not by putting anyone down.',
      '',
      'Two things you must not do, because they are false:',
      '  - Never claim you personally own, use, or tested something. You did not.',
      '    Say what the category or the approach does, not "I use this every day".',
      '  - Never invent a performance multiple ("10x faster", "half the price").',
      '    Name the actual mechanism instead. It is more convincing and it is true.',
      'No hashtags.');
  }

  if (link) {
    common.push('',
      'A link is attached to this post. Include it exactly once, exactly as given.',
      'It is related to the topic, NOT to their specific video.',
      'Do not imply it is the item they showed.');
    if (disclosureTag) {
      common.push('Do not write ' + disclosureTag + ' yourself; it is added automatically.');
    }
  } else {
    common.push('', 'No link for this post. Do not write any URL.');
  }

  /*
   * ★感想と採点。要約だけの引用は読まれない。読者は判断を求めている。
   * ただし対象は「相手が書いた主張」であって、見ていない映像や記事ではない。
   */
  common.push('',
    'Have a verdict. A quote-post that only restates the original is dead weight.',
    'Agree hard, disagree hard, or rate it — but commit to something.',
    '',
    'You may give a star rating with ☆ characters, one to five.',
    'A rating stops the scroll, but it MUST name what it is rating on the same line,',
    'and that has to be the idea, the approach, the claim or the premise.',
    '  GOOD : ☆☆ for the premise — right problem, wrong fix.',
    '  GOOD : the approach: ☆☆☆☆. the framing around it: ☆.',
    '  BAD  : ☆☆☆☆ great video   (you did not watch it)',
    '  BAD  : ☆☆☆                (rating nothing in particular)');

  // ★形の指示。ここを書かないと局所判定で落ちて再生成を空回りさせる。
  common.push('',
    'Shape on the screen:',
    '- The first line stands alone, under 70 characters, then a line break.',
    '- Never one solid block of text. Break after the opening idea.');

  /*
   * ★採点基準を生成側にも明示する。
   * 採点(16_Quality.gs)と生成が別々に書かれていたため、
   * 採点側が要求する「冒頭で立場を取る」を生成側が狙っておらず、
   * 70点に届かず投稿が出ない状態が続いた（2026-08-17）。
   */
  common.push('',
    'The bar this is scored against before it can be published:',
    'A judge scores it 0-100 and nothing under 70 is posted. THE FIRST LINE',
    'DECIDES THAT SCORE — it is read alone, competing with the preview card',
    'sitting right underneath it.',
    '',
    'A first line that names the topic, restates the headline, or eases in',
    'scores under 45 however good the rest is. It earns its place by:',
    '  - taking a side       ("the caching argument here does not hold")',
    '  - naming the stake    ("this breaks the moment you shard")',
    '  - contradicting what the reader assumes',
    '  - delivering a verdict, including a rating with a stated subject',
    '',
    'Also scored: a neutral summary of what the card already shows scores under 40.',
    'A hedged both-sides take scores under 50. Add something past the headline —',
    'a consequence, a limit, a reason it breaks, who it does not apply to.',
    'Claiming to have used or bought the thing scores under 30, and so does',
    'inventing a number the source never gave.',
    '',
    'You are NOT penalised here for lacking a tool name or a personal story.',
    'The job of this post is the take, not the credentials.',
    'Never mention scoring or judging in the post itself.');

  common.push('', 'Output only the post text. Maximum ' + getTweetMaxLen_(key) + ' characters.');
  return common.join('\n');
}

function buildQuoteUserPrompt_(target, link, attempt, lastText, critique) {
  const lines = [
    'The post you are quoting says:',
    '"""',
    truncate_(stripUrls_(target.text), 500),
    '"""',
    '',
    'That text is everything you know about it. There is a video attached that you cannot see.'
  ];

  if (link) {
    lines.push('', buildBLinkFacts_(link));
  }

  if (attempt > 1 && lastText) {
    lines.push('', 'Your previous attempt was rejected:', '"""', truncate_(lastText, 400), '"""',
               '', 'Reason: ' + critique, '', 'Write a different post that fixes this.');
  }

  return lines.join('\n');
}

/**
 * 引用コメントを1本作る。
 * @return {{text:string, linkUrl:string, disclosure:string, qualityScore:number}}
 */
function generateQuoteComment_(accountKey, target) {
  const key = String(accountKey || '').toUpperCase();
  const region = pickRegionByJstHour_();

  // リンクは通常投稿と同じゲートを通す。Bだけが収益リンクを持つ。
  let link = null;
  if (key === 'B') {
    try {
      const candidates = listLinkCandidates_(getOrCreateLinksSheet_(), 'B');
      link = pickBLink_(candidates, region);
    } catch (e) {
      console.warn('Linksを読めないためリンク無しで続行: ' + e);
    }
  }

  const disclosureTag = link ? requiredDisclosureFor_(region, link) : '';
  const disclosureCost = disclosureTag ? estimateWeightedLength_(disclosureTag + ' ') : 0;
  // 固定CTA（22_FixedCta.gs）の分も先に確保する。
  // リンク付きの回はCTAを付けない設計なので、その場合は確保しない。
  const ctaCost = link ? 0 : fixedCtaReserve_(key);
  const bodyMaxLen = getTweetMaxLen_(key) - disclosureCost - ctaCost;
  const postUrl = link ? linkPostUrl_(link) : '';

  const systemPrompt = buildQuoteSystemPrompt_(key, link, disclosureTag, target && target.pattern);

  let lastText = '';
  let critique = '';
  let best = null;

  for (let attempt = 1; attempt <= llmMaxAttempts_(); attempt++) {
    const userPrompt = buildQuoteUserPrompt_(target, link, attempt, lastText, critique);

    let raw;
    try {
      raw = callLLM_(systemPrompt, userPrompt);
    } catch (err) {
      // 安全フィルタに当たった＝この対象は扱わない。別の投稿を狙えばよい。
      if (isSafetyBlock_(err)) {
        console.warn('安全フィルタにより、この対象への引用は見送ります。');
        return null;
      }
      throw err;
    }

    const text = sanitizeGeneratedText_(raw);
    if (!text) continue;

    // --- 見ていないものを断定していないか ------------------------------
    const claims = checkQuoteClaims_(text, key);
    if (!claims.ok) {
      lastText = text; critique = claims.reason;
      console.warn('断定表現のため再生成: ' + truncate_(claims.reason, 80));
      continue;
    }

    // --- 文字数 ---------------------------------------------------------
    if (estimateWeightedLength_(text) > bodyMaxLen) {
      lastText = text;
      critique = 'Too long. Limit is ' + bodyMaxLen + ' characters. Cut an idea, not words.';
      continue;
    }

    // --- URL ------------------------------------------------------------
    let finalText = text;
    if (!link) {
      if (/https?:\/\//i.test(finalText)) {
        const stripped = stripUrls_(finalText);
        if (stripped.length < 30) {
          lastText = text;
          critique = 'You invented a URL. No link was given. Write it with no URL.';
          continue;
        }
        finalText = stripped;
      }
    } else {
      const usage = checkBLinkUsage_(finalText, postUrl);
      if (!usage.ok) {
        if (attempt < llmMaxAttempts_()) {
          lastText = text; critique = usage.reason;
          continue;
        }
        const repaired = (stripUrls_(finalText) + '\n\n' + postUrl).trim();
        if (estimateWeightedLength_(repaired) > bodyMaxLen) {
          lastText = text; critique = usage.reason;
          continue;
        }
        finalText = repaired;
      }
    }

    // --- 品質（開示を付ける前に採点する）---------------------------------
    const verdict = evaluatePost_(key, finalText, 'QUOTE');
    if (verdict.ok) {
      return {
        text: applyDisclosure_(finalText, disclosureTag),
        linkUrl: postUrl,
        disclosure: disclosureTag,
        qualityScore: verdict.score,
        region: region
      };
    }

    if (!best || verdict.score > best.score) best = { text: finalText, score: verdict.score };
    lastText = finalText;
    critique = verdict.critique;
  }

  // ★通常投稿と違い、引用は「今日の枠」ではない。
  // 品質が出ないなら出さない。他人の投稿にぶら下がる以上、雑な文は相手にも迷惑になる。
  if (best) {
    console.warn('品質基準に届かないため引用を見送ります（最良 ' + best.score + '点）');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 実行                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 引用リポストを1本行う。
 *
 * 流れ：検索 → 重複排除 → 生成（推測と断定の分離）→ リンク検証 → 引用POST → 記録
 *
 * ★既定では無効。スクリプトプロパティ QUOTE_ENGINE=on で初めて動く。
 * 通常投稿と違い他人の投稿に紐づくため、意図せず動き出す状態にはしない。
 */
function runQuoteEngine(accountKey) {
  const key = String(accountKey || '').toUpperCase();

  // POST_MODE=standalone の時だけ引用を止める。
  // 以前は QUOTE_ENGINE=on を別途要求していたが、主モードになった今は
  // 2つのスイッチが噛み合わず「onにしたのに動かない」の原因になるため統合した。
  if (postMode_() === 'standalone') {
    console.log('POST_MODE=standalone のため引用はしません。');
    return null;
  }
  if (isEmergencyStopped_() || isAccountStopped_(key)) {
    console.warn('停止中のため引用をスキップします。');
    return null;
  }

  // ★出せない回は検索もGeminiも走らせない。
  // Xの検索クォータとGeminiの呼び出しを、捨てる投稿のために使わない。
  if (isOverMonthlyCap_(key)) {
    console.log('今月の上限に達しているため引用を見送ります (' + key + ')。');
    return null;
  }
  if (isOverDailyPace_(key)) {
    console.log('今日のぶん（' + dailyPostAllowance_(key) + '件）を使い切りました (' + key +
                ')。この回は見送ります。');
    return null;
  }

  /*
   * ★引用が権限で使えないなら、検索そのものをしない（2026-08-18に直した）。
   *
   * 【実費が出ていた無駄】
   * この判定は以前 searchQuoteTargets_ を最大2回まわした「後」にあった。
   * 引用が恒久的に403のアカウントでは、毎サイクル
   *   検索2回（Xの読み取りは課金対象）→ 対象を選ぶ → 引用不可と判明 → 破棄
   * を繰り返していた。2時間おき×2アカウントで1日最大48回、
   * 必ず捨てる結果のために払い続けていたことになる。
   *
   * 403は恒久的な制限で、探しても状況は変わらない。先に降りる。
   */
  if (isQuoteBlocked_(key)) {
    console.log('引用は権限で使えないため検索もしません (' + key + ')。情報源サイクルへ譲ります。');
    return null;
  }

  const ss = openLogSpreadsheet_();
  const quoted = getOrCreateQuotedSheet_(ss);

  /*
   * ★ジャンルを増やしたので、1回の実行で複数パターンを試す。
   *
   * 1サイクル1クエリのままジャンルだけ増やすと、外れたパターンに
   * 当たった回はそのまま引用なしで終わり、引用の頻度が下がる。
   * ジャンルの幅と引用の本数はトレードオフにしてはいけないので、
   * 使える対象が見つかるまで順にクエリを変えて探す。
   *
   * 検索は投稿と違って副作用が無いが、Xの読み取りは課金対象なので
   * 上限を決めて打ち切る（QUOTE_PATTERN_TRIES）。
   */
  const history = readQuotedHistory_(quoted);
  const patternCount = quotePatternsFor_(key).length || 1;
  const tries = Math.min(quotePatternTries_(), patternCount);

  let target = null;
  for (let i = 0; i < tries && !target; i++) {
    const candidates = searchQuoteTargets_(key);
    if (!candidates.length) {
      console.log('このパターンでは対象が見つかりませんでした（' + (i + 1) + '/' + tries + '）。');
      continue;
    }
    target = pickQuoteTarget_(candidates, history, key);
    if (!target) {
      console.log('候補はあったが引用可能なものがありません' +
                  '（すべて引用済み、または著者クールダウン中）（' + (i + 1) + '/' + tries + '）。');
    }
  }

  if (!target) {
    console.log('どのパターンでも引用可能な対象が見つかりませんでした。');
    return null;
  }

  /*
   * ★引用が使えない場合、以前はここで即リツイートしていた。やめた。
   *
   * 実測（2026-08-18）：AはXのアクセス階層の制限で引用が恒久的に403。
   * その状態でリツイートに落ちると、リツイートが成功した時点で
   * runQuoteCycle_ が true を返し、そのサイクルが終わってしまう。
   * リツイートは自分の投稿として表示されないので、
   * 「2時間おきに動いているのにタイムラインが増えない」状態になる。
   * 実際この日はAが1/4本しか出ていなかった。
   *
   * 素のリツイート自体は残す価値があるが、それは
   * 「他に何も出せなかった回の埋め草」であって、
   * 記事への反応や単独投稿より先に置くものではない。
   * リツイートは processQueue の最後で試す（runRetweetFallback_）。
   *
   * ★引用不可の判定は関数の先頭へ移した（検索の課金を払う前に降りるため）。
   */
  const generated = generateQuoteComment_(key, target);
  if (!generated) {
    console.log('引用文を生成できなかったため見送ります。');
    return null;
  }

  let result;
  try {
    result = postTweet_(key, generated.text, { quoteTweetId: target.id });
  } catch (err) {
    /*
     * ★このエラー型の時だけ、同じ対象へリツイートにフォールバックする。
     * フラグではなくエラーの型そのもので判定しているのは、レート制限や
     * 重複投稿など別の理由での失敗まで巻き込んで誤フォールバックしない
     * ため（QuotePermissionError の定義コメント参照）。
     */
    if (err instanceof QuotePermissionError) {
      console.log('引用が拒否されたため、同じ対象へリツイートを試みます。');
      return attemptAutoRetweet_(key, target, ss, quoted);
    }
    throw err;
  }

  rememberQuoted_(quoted, {
    account: key, tweetId: target.id, authorId: target.authorId, author: target.author,
    targetText: target.text, postedText: generated.text,
    postId: result.id, linkUrl: generated.linkUrl
  });

  appendLogRow_(ss, buildLogRow_({
    account: key, status: QUEUE_STATUS_POSTED, text: generated.text,
    region: generated.region, angle: 'QUOTE', format: 'quote',
    postId: result.id, hash: result.contentHash,
    hasLink: result.hasLink, cost: result.costEstimate,
    model: getProp_('LLM_MODEL', LLM_DEFAULT_MODEL),
    role: 'QUOTE', qualityScore: generated.qualityScore,
    postType: 'QUOTE', linkUrl: generated.linkUrl
  }));

  console.log('引用リポスト完了: ' + (result.url || result.id) +
              ' → 対象 ' + target.id + ' (@' + target.author + ')');
  return result;
}

/**
 * 同じ対象へ、素のリツイートで投稿する（引用文は書かない）。
 *
 * ★リンクもコメントも付かない。引用が使えない代わりに、
 * 「その話題に自分のアカウントを結び付ける」ことだけを行う。
 *
 * @return {?Object} 成功時は postTweet_ 相当の形（id/url）。失敗時は null
 */
function attemptAutoRetweet_(accountKey, target, ss, quoted) {
  const key = String(accountKey || '').toUpperCase();

  /*
   * ★Bはセンシティブ判定された対象をリツイートしない。
   * 自分で書く文章にはB_BANNED等の禁止語チェックが効くが、
   * 他人の投稿をまるごとリツイートする場合はその検査が効かない。
   * 判断材料の無いまま自分のアカウントに結び付けない。
   */
  if (key === 'B' && target.sensitive) {
    console.log('対象がセンシティブ判定のため、リツイートを見送ります。');
    return null;
  }

  let result;
  try {
    result = postRetweet_(key, target.id);
  } catch (e) {
    console.error('リツイート試行で例外 (' + key + '): ' + e);
    return null;
  }

  if (!result.ok) {
    console.warn('リツイート失敗 (' + key + ') HTTP ' + result.code + ': ' +
                 truncate_(result.body, 200));
    return null;
  }

  rememberQuoted_(quoted, {
    account: key, tweetId: target.id, authorId: target.authorId, author: target.author,
    targetText: target.text, postedText: '(素のリツイート・本文無し)',
    postId: target.id, linkUrl: ''
  });

  appendLogRow_(ss, buildLogRow_({
    account: key, status: QUEUE_STATUS_POSTED, text: '(retweet)',
    angle: 'RETWEET', format: 'retweet',
    postId: target.id, hasLink: false, cost: 0,
    role: 'RETWEET', postType: 'RETWEET'
  }));

  const username = getStoredUsername_(key);
  const url = username
    ? 'https://x.com/' + username + '/status/' + target.id
    : 'https://x.com/i/web/status/' + target.id;

  console.log('リツイート完了 (' + key + '): 対象 ' + target.id + ' (@' + target.author + ')');
  return { id: target.id, url: url };
}

/* ------------------------------------------------------------------ */
/* 投稿モード（引用を主にする）                                          */
/* ------------------------------------------------------------------ */

/**
 * 投稿モード。
 *   quote      … 引用リポストのみ。対象が無ければ投稿しない
 *   mixed      … 引用を最優先し、対象が無ければ単独投稿へ落とす（既定）
 *   standalone … 単独投稿のみ（従来動作）
 *
 * ★既定を quote にしていない理由。
 * search/recent は X APIのプランによっては 403 で使えない。
 * その状態で quote 専用にすると、両アカウントが1本も投稿しないまま
 * 静かに沈黙する（AUTO_REFILL_B=0 で B が死んでいたのと同じ壊れ方）。
 *
 * mixed なら引用が主で、取れない回だけ単独投稿が出る。
 * 実際に引用が回っていることを「直近」で確認できたら
 * POST_MODE=quote にして単独投稿を完全に止められる。
 */
/*
 * ★既定を「引用・反応のみ」にする（2026-08-18、オーナー判断）。
 *
 * 【方針】
 *   ・自動投稿  … 引用リポスト／情報源への反応だけ。画像かURLが必ず付く
 *   ・単独投稿  … LINEの「AでAI投稿」「Aに投稿：本文」から手動で出す
 *   ・アフィリエイトリンクが登録されたら mixed へ自動で戻る
 *
 * 【なぜ】
 * リンクが無い間、単独投稿は収益に繋がらないうえ品質ゲートで詰まりやすい。
 * 引用・反応は画像かURLが付くので目に留まりやすく、種まきの段階では
 * こちらの方が費用対効果が高い、というオーナー判断。
 *
 * ★手で切り替える設定にはしない。
 * 「リンクを登録したら戻す」を人間が覚えている必要がある形にすると、
 * 必ず忘れる。24_PostMix.gs の SEED/SELL と同じく、
 * Linksシートの実態から導く。
 */
let postModeMemo_ = null;

function postMode_() {
  // 明示指定があれば必ずそちらを優先する（診断・一時的な切り替え用）
  const explicit = String(getProp_('POST_MODE', '')).toLowerCase();
  if (explicit === 'quote' || explicit === 'standalone' || explicit === 'mixed') {
    return explicit;
  }

  /*
   * 未設定なら実態から決める。
   * ★1回の実行の中では読み直さない。postMode_ はサイクル内で何度も
   * 呼ばれるので、毎回シートを開くと無駄が大きい。
   * 実行をまたげば再評価されるので、登録の反映は最大1サイクル遅れるだけ。
   * サイクルの途中でモードが変わる方が危険なので、これでよい。
   */
  if (postModeMemo_) return postModeMemo_;
  try {
    // A/Bどちらかに使えるリンクがあれば mixed へ戻す
    const ss = openLogSpreadsheet_();
    const any = Object.keys(ACCOUNTS).some(function (k) {
      return hasUsableAffiliateLink_(k, ss);
    });
    postModeMemo_ = any ? 'mixed' : 'quote';
  } catch (e) {
    // 判定できない時は引用側へ倒す。単独投稿は手動で出せる
    console.warn('投稿モードを判定できないため quote で続行: ' + e);
    postModeMemo_ = 'quote';
  }
  return postModeMemo_;
}

/**
 * X以外の情報源（YouTube / RSS）を使うか。
 *
 * ★Xの検索と引用は階層依存で、実測では引用が403、has:videoが400だった。
 * 話題の入口をXだけに置くと、そこが閉じた瞬間に何も出せなくなる。
 * YouTubeとRSSは公開データを取るための正規の経路なので、
 * 入口を分散させておく。
 */
function sourceModeEnabled_() {
  return String(getProp_('SOURCE_MODE', 'on')).toLowerCase() !== 'off';
}

/** 引用の順番待ち。A→B→A…と交互に回す。 */
const QUOTE_TURN_PROP = 'quote_turn';

/*
 * ★順番待ちのカウンタは用途ごとに分ける（2026-08-16）。
 *
 * 【起きていた事故】
 * 引用サイクルと情報源サイクルが同じカウンタを共有し、
 * 1回のcronで2回進んでいた。アカウントは2つなので、
 * 2回進むと元の偶奇に戻る——つまり毎回まったく同じ組み合わせになる。
 *
 *   実行1: 引用=A（0→1）, 情報源=B（1→0）
 *   実行2: 引用=A（0→1）, 情報源=B（1→0）   ← 永久に同じ
 *
 * 情報源サイクルは常にBを引き当てるが、BにはRSSフィードが無い。
 * 結果、RSSの反応投稿は自動実行で一度も動いていなかった。
 * 「点検」では previewSourcePost_('A') と明示していたため動いて見え、
 * 本番だけが静かに空振りしていた。
 */
function nextAccountInTurn_(propName) {
  const keys = Object.keys(ACCOUNTS);
  const n = Number(getProp_(propName, '0')) || 0;
  try { props_().setProperty(propName, String((n + 1) % keys.length)); } catch (e) {}
  return keys[n % keys.length];
}

function nextQuoteAccount_() {
  return nextAccountInTurn_(QUOTE_TURN_PROP);
}

/**
 * この回の引用を1本試す。
 *
 * 交互に回すが、片方が対象なしでも、もう片方が投稿できるなら出す。
 * 「Aの番だが対象が無い」だけで1サイクル丸ごと無投稿になるのを避ける。
 *
 * @return {boolean} 投稿できたか
 */
function runQuoteCycle_() {
  const first = nextQuoteAccount_();
  const order = [first].concat(Object.keys(ACCOUNTS).filter(function (k) { return k !== first; }));

  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (isAccountStopped_(key)) continue;
    try {
      if (runQuoteEngine(key)) {
        try { props_().deleteProperty(QUOTE_MISS_PROP); } catch (e) {}
        return true;
      }
    } catch (err) {
      console.error('引用に失敗 (' + key + '): ' + (err && err.stack ? err.stack : err));
    }
  }
  return false;
}

/** 引用専用モードで対象が見つからなかった回数。 */
const QUOTE_MISS_PROP = 'quote_miss_count';
const QUOTE_MISS_ALERT = 12;   // 2時間おき×12回 ＝ 丸1日出せていない

/**
 * 引用対象が無く1本も出せなかったことを数える。
 *
 * ★「静かに何も起きない」を作らない。
 * AUTO_REFILL_B=0 で B が黙って死んでいたのと同じ失敗をここで繰り返さないため、
 * 出せない状態が続いたら必ず気づけるようにする。
 */
function noteQuoteMiss_() {
  const n = (Number(getProp_(QUOTE_MISS_PROP, '0')) || 0) + 1;
  try { props_().setProperty(QUOTE_MISS_PROP, String(n)); } catch (e) {}
  console.warn('引用対象が見つかりませんでした（連続' + n + '回）。');

  if (n === QUOTE_MISS_ALERT) {
    notifyAdmin_([
      '⚠️ 引用リポストが丸1日出せていません',
      '',
      '検索で条件に合う投稿が見つからない状態が' + QUOTE_MISS_ALERT + '回続きました。',
      '考えられる原因:',
      '  ・X APIのプランで search/recent が使えない（403）',
      '  ・いいね数のしきい値が高すぎる',
      '  ・検索クエリが絞り込みすぎている',
      '',
      '「診断」で状態を確認できます。',
      '単独投稿も併用するなら POST_MODE を mixed にしてください。'
    ].join('\n'));
  }
}

/**
 * 引用が動かない理由を、実際にAPIを叩いて確かめる。
 *
 * ★「引用RTにならない」の原因は複数あり、症状が同じ（単独投稿が出るだけ）。
 * 中でもいちばん多いのは X API のプラン。
 * search/recent は Free プランに含まれておらず、403 が返る。
 * その場合コードをいくら直しても引用は絶対に成立しないので、
 * 推測せず実際のHTTPコードを見せる。
 *
 * @return {string} LINEへそのまま返せる診断文
 */
function diagnoseQuote_(accountKey) {
  const key = String(accountKey || 'B').toUpperCase();
  const lines = ['【' + key + ' 引用診断】'];

  lines.push('投稿モード: ' + postMode_() +
             (postMode_() === 'standalone' ? '（引用しない設定）' : ''));

  let service;
  try {
    service = getXService_(key);
    if (!service.hasAccess()) {
      lines.push('❌ X未連携。「Xリンク ' + key + '」で連携してください。');
      return lines.join('\n');
    }
  } catch (e) {
    lines.push('❌ Xサービスを取得できません: ' + truncate_(String(e), 80));
    return lines.join('\n');
  }

  const pat = (QUOTE_PATTERNS[key] || [])[0];
  if (!pat) { lines.push('❌ 検索パターンが未定義です。'); return lines.join('\n'); }

  const url = 'https://api.x.com/2/tweets/search/recent?query=' +
              encodeURIComponent(pat.query) +
              '&max_results=10&tweet.fields=public_metrics';

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + service.getAccessToken() },
      muteHttpExceptions: true
    });
  } catch (e) {
    lines.push('❌ 検索リクエストが失敗: ' + truncate_(String(e), 100));
    return lines.join('\n');
  }

  const code = res.getResponseCode();
  const body = res.getContentText();
  lines.push('検索API: HTTP ' + code);

  if (code === 403) {
    lines.push('');
    lines.push('❌ 403。X APIのプランで検索が使えません。');
    lines.push('   search/recent は Free プランに含まれていません。');
    lines.push('   → 引用RTはプランを上げないと成立しません。');
    lines.push('   → それまでは POST_MODE=mixed のまま単独投稿で回ります。');
    return lines.join('\n');
  }
  if (code === 400) {
    lines.push('');
    lines.push('❌ 400。クエリが拒否されました。');
    lines.push(truncate_(body, 200));
    return lines.join('\n');
  }
  if (code === 429) {
    lines.push('⚠️ 429。レート制限中。時間をおいて再確認してください。');
    return lines.join('\n');
  }
  if (code !== 200) {
    lines.push('❌ ' + truncate_(body, 200));
    return lines.join('\n');
  }

  let parsed = {};
  try { parsed = JSON.parse(body); } catch (e) {}
  const all = (parsed.data || []).length;
  const passing = (parsed.data || []).filter(function (t) {
    return Number((t.public_metrics || {}).like_count || 0) >= pat.minLikes;
  }).length;

  lines.push('✅ 検索は使えています。');
  lines.push('  取得: ' + all + '件 / いいね' + pat.minLikes + '以上: ' + passing + '件');
  if (all && !passing) {
    lines.push('');
    lines.push('▶ 検索はできていますが、しきい値を超える投稿がありません。');
    lines.push('  minLikes を下げると引用対象が増えます。');
  } else if (!all) {
    lines.push('');
    lines.push('▶ 直近7日でこのクエリに合う投稿がありません。クエリが狭すぎます。');
  } else {
    lines.push('');
    lines.push('▶ 引用は成立するはずです。それでも単独投稿が続く場合は');
    lines.push('  「直近」で実際の投稿を確認してください。');
  }
  return lines.join('\n');
}

/** エディタから手動で1本試す。 */
function testQuoteEngineA() { console.log(JSON.stringify(runQuoteEngine('A'), null, 2)); }
function testQuoteEngineB() { console.log(JSON.stringify(runQuoteEngine('B'), null, 2)); }

/** 検索だけ試す（投稿しない）。クエリの当たり具合を見るため。 */
function dryRunQuoteSearch(accountKey) {
  const key = String(accountKey || 'A').toUpperCase();
  const found = searchQuoteTargets_(key);
  console.log(key + ': ' + found.length + '件');
  found.slice(0, 10).forEach(function (t) {
    console.log('  ' + t.likes + '♥ @' + t.author + ' ' + truncate_(t.text.replace(/\n/g, ' '), 100));
  });
  return found;
}


/**
 * 他に何も投稿できなかった回だけ、素のリツイートを試す。
 *
 * ★processQueue の最後で呼ぶこと。
 * 引用が権限で使えないアカウントでも、話題に乗る手段をゼロにはしない。
 * ただし「自分の投稿」にはならないので、記事への反応・単独投稿を
 * すべて試したあとの最後の手段として扱う。
 *
 * @return {boolean} リツイートできたか
 */
/**
 * 素のリツイートで埋めるか。既定は無効（2026-08-19）。
 *
 * ★これを既定で切った理由。
 *
 * リツイートは自分の投稿として表示されない。タイムラインは増えず、
 * フォロワーから見て「このアカウントが何か言った」ことにならない。
 * それでいて、対象を探すためにX検索を1回叩く（課金対象）。
 *
 * 実測（2026-08-19）: 引用が403のAでは、この経路だけで
 * 1日最大12回の検索を消費していた。得られるものに対して高すぎる。
 *
 * 無料の情報源（Reddit / RSS）を先に試す順序へ変えたので、
 * ここまで落ちてくる回自体が減る。それでも残る消費を止める。
 *
 * RETWEET_FALLBACK=1 で戻せる。
 */
function retweetFallbackEnabled_() {
  return String(getProp_('RETWEET_FALLBACK', '')) === '1';
}

function runRetweetFallback_() {
  if (!retweetFallbackEnabled_()) {
    console.log('リツイート埋めは無効です（RETWEET_FALLBACK=1 で有効化）。');
    return false;
  }
  const keys = Object.keys(ACCOUNTS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!isQuoteBlocked_(key)) continue;          // 引用が使えるなら不要
    if (isAccountStopped_(key)) continue;
    if (isOverMonthlyCap_(key) || isOverDailyPace_(key)) continue;

    let ss, quoted, target;
    try {
      ss = openLogSpreadsheet_();
      quoted = getOrCreateQuotedSheet_(ss);
      const candidates = searchQuoteTargets_(key);
      if (!candidates.length) continue;
      target = pickQuoteTarget_(candidates, readQuotedHistory_(quoted), key);
      if (!target) continue;
    } catch (e) {
      console.warn('リツイート候補の取得に失敗 (' + key + '): ' + e);
      continue;
    }

    const result = attemptAutoRetweet_(key, target, ss, quoted);
    if (result) {
      console.log('他に出せなかったため素のリツイートで埋めました (' + key + ')。');
      return true;
    }
  }
  return false;
}


/* ------------------------------------------------------------------ */
/* X検索の消費を数える                                                  */
/* ------------------------------------------------------------------ */

/**
 * ★X検索は1回ごとに課金される。回数が見えないと必ず増える。
 *
 * 実際、2026-08-18にジャンルを28本へ広げた際、1サイクルの検索を
 * 1回から3回へ増やした。その日にクレジットが尽きて402で停止したが、
 * 「増やしたこと」と「尽きたこと」を結びつけるのに時間が掛かった。
 * どこにも回数が出ていなかったため。
 *
 * 日付が変わったら0に戻す。「点検」で今日の消費が見える。
 */
const X_SEARCH_COUNT_PROP = 'x_search_count';

function xSearchCountKey_() {
  return X_SEARCH_COUNT_PROP + '_' + todayKey_();
}

/**
 * ★1日に叩いてよいX検索の上限（2026-08-19、オーナー指示）。
 *
 * 【なぜ上限が要るか】
 * 順序を「無料が先」に直しただけでは、無料側が枯れた回に
 * 無制限へ戻る。実際に尽きた時もそうだった——1回あたりは小さく、
 * 「たまに叩くだけ」のつもりが1日36回になっていた。
 *
 * 回数の上限は、無料側の不調が自動で課金へ流れ込むのを止める堰。
 * 上限に当たった回はX検索を諦め、無料の材料だけで回す。
 *
 * 既定2回。理由は「0にすると、クレジットが戻った時に誰も気づけない」。
 * 1日2回だけ様子を見に行けば、使えるようになった日に分かる。
 *   X_SEARCH_DAILY_MAX=0  … 完全に止める
 *   X_SEARCH_DAILY_MAX=40 … 従来どおり事実上無制限
 */
const X_SEARCH_DAILY_MAX_DEFAULT = 2;

function xSearchDailyMax_() {
  const n = Number(getProp_('X_SEARCH_DAILY_MAX', String(X_SEARCH_DAILY_MAX_DEFAULT)));
  if (!isFinite(n) || n < 0) return X_SEARCH_DAILY_MAX_DEFAULT;
  return Math.floor(n);
}

/** 今日まだX検索を叩いてよいか。 */
function xSearchAllowed_() {
  return xSearchCountToday_() < xSearchDailyMax_();
}

function noteXSearchCall_() {
  try {
    const k = xSearchCountKey_();
    props_().setProperty(k, String((Number(getProp_(k, '0')) || 0) + 1));
  } catch (e) {}
}

/** 今日のX検索回数。 */
function xSearchCountToday_() {
  return Number(getProp_(xSearchCountKey_(), '0')) || 0;
}

/** 「点検」用の1行。 */
function buildXSearchCostText_() {
  const n = xSearchCountToday_();
  const max = xSearchDailyMax_();
  const lines = ['【X検索】今日 ' + n + ' / ' + max + ' 回（1回ごとに課金）'];
  if (max === 0) {
    lines.push('  ⏸ 停止中（X_SEARCH_DAILY_MAX=0）。無料の情報源だけで回します。');
  } else if (n === 0) {
    lines.push('  ✅ 無料の情報源だけで回っています');
  } else if (n >= max) {
    lines.push('  ⏸ 本日の上限に達しました。以降は無料の情報源だけで回します。');
  }
  return lines.join('\n');
}
