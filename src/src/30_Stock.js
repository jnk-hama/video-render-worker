/**
 * ===========================================================================
 * 30_Stock.gs  —  バズ動画のストック（実写クリップの在庫）
 * ===========================================================================
 *
 * ★なぜ「貯める」のか（オーナー指示 2026-08-21）
 *
 * これまでは投稿のたびにPexelsを検索していた。問題が3つあった。
 *
 *   1. 検索語が抽象的で、返ってくる映像が退屈だった。
 *      「technology gadget desk」では、誰も止まらない絵しか出てこない
 *   2. 当たり外れを人が見て捨てられない。悪い映像がそのまま投稿される
 *   3. 毎回検索するので、Pexelsが落ちたらその回は動画なしになる
 *
 * 在庫を持てば全部解決する。良い映像だけを貯め、悪い行は消せばよい。
 * オーナーが自分で見つけたURLを足すこともできる。
 *
 * ★重要：貯める作業はGASの上でしか出来ない
 * 開発環境からはPexels/Pixabayへ到達できない（プロキシが403で拒否）。
 * GASはGoogleのネットワークから動くので届く。だからこの機能は
 * 「システム自身に貯めさせる」形にしてある。
 *
 * ★検索語がすべて
 * 何が返ってくるかは検索語で決まる。「technology」ではなく
 * 「slow motion sparks metal grinding」のように、
 * 動きと近接があり、見て気持ちがいい映像を名指しで狙う。
 */

const STOCK_SHEET_NAME = 'VideoStock';
const STOCK_HEADERS = ['Added At', 'Account', 'Query', 'Video URL',
                       'Duration', 'Width', 'Source', 'Used Count', 'Status'];

const STOCK_COL_ADDED    = 1;
const STOCK_COL_ACCOUNT  = 2;
const STOCK_COL_QUERY    = 3;
const STOCK_COL_URL      = 4;
const STOCK_COL_DURATION = 5;
const STOCK_COL_WIDTH    = 6;
const STOCK_COL_SOURCE   = 7;
const STOCK_COL_USED     = 8;
const STOCK_COL_STATUS   = 9;

/** 在庫がこれを下回ったら補充する。 */
const STOCK_LOW_WATER = 12;

/** 1回の補充で足す上限。GASの実行枠を守る。 */
const STOCK_REFILL_MAX = 10;

/**
 * 1本の映像を使ってよい回数。これを超えたら「使い切った」扱いにする。
 *
 * ★★2026-08-22、これが無かったせいで自動補充が一度も動いていなかった。
 *
 * 行は使っても消えないので listStock_ の件数は減らない。
 * 「在庫30本 >= 下限12本」が永久に成立し、ensureStockLevel_ は
 * 毎回そのまま return していた。「なくなり次第補充」が設計に
 * 存在しなかったのと同じ状態だった。
 *
 * 同じ映像が何度も出れば見る側は「同じ動画」と認識する。
 * 3回で退役させ、常に新しい映像が入り続けるようにする。
 */
const STOCK_MAX_USES = 3;

/**
 * 在庫に入れる映像のバイト数上限。
 *
 * ★29_Video.gs の VIDEO_MAX_BYTES と揃えている。
 * 取得してから「大きすぎた」と捨てるのは通信の無駄なので、
 * サイズが分かるもの（Pixabay）は在庫へ入れる前に落とす。
 */
const STOCK_MAX_BYTES = 32 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 検索語の安全弁                                                        */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-24。Bを「セクシー寄り」へ動かすにあたって先に入れた。
 *
 * 検索語は3つの経路から来る。
 *   1. ここに書いた固定リスト（人が書く）
 *   2. 元投稿のタイトルから機械的に作った語（33_BuzzSource.gs）
 *   3. LINEから上書きした STOCK_QUERIES_A / _B
 *
 * 2 は Reddit / YouTube のタイトルが素なので、こちらの意図と無関係に
 * 何でも入りうる。1 と 3 も、後から書き換わる。
 * つまり「気をつけて書く」では守れない。検索を投げる直前で必ず通す。
 *
 * 止めるのは3種類。どれもアカウントが消える理由になる。
 *   ・未成年を想起させる語（Bの絶対ラインそのもの）
 *   ・盗撮・隠し撮りを示す語（多くの国で違法。Xも明確に禁止）
 *   ・露骨な性表現（Xのメディアポリシー、素材サイトの規約とも衝突）
 *
 * ★オーナー確認済み（2026-08-24）：盗撮を作れという指示ではなく
 *   「そういう雰囲気の」という意味だった。雰囲気は水着・ファッション・
 *   アニメで出せる。実在の盗撮映像を取りに行く経路は塞いでおく。
 */
const STOCK_BANNED_TERMS = [
  // 1) 未成年を想起させる語
  'child', 'children', 'kid', 'kids', 'teen', 'teens', 'teenage', 'teenager',
  'school', 'schoolgirl', 'schoolboy', 'highschool', 'student', 'junior',
  'young girl', 'little girl', 'baby', 'toddler', 'infant', 'minor',
  'loli', 'lolita', 'shota', 'jailbait',
  // 2) 盗撮・隠し撮り
  'upskirt', 'downblouse', 'voyeur', 'voyeurism',
  'hidden camera', 'hidden cam', 'spycam', 'spy cam', 'peeping',
  'creepshot', 'candid girl', 'secretly filmed', 'without consent',
  // 3) 露骨な性表現
  'nude', 'nudes', 'nudity', 'naked', 'topless', 'undressing',
  'porn', 'porno', 'pornographic', 'sex', 'sexual', 'nsfw',
  'hentai', 'erotic', 'erotica', 'xxx', 'stripper', 'striptease',
  'fetish', 'orgasm', 'masturbat'
];

/**
 * 検索語を投げてよいか。
 *
 * ★単語として一致した時だけ止める。
 *
 * 前方一致（'strip' で始まる語を全部止める等）も検討したが、
 * 'striped shirt' のような無害な語まで落ちる。落ちても実害は
 * 「検索語が1つ減る」だけとはいえ、なぜ減ったのか後から誰にも
 * 分からなくなる。代わりに変化形を列挙して塞ぐ方を選んだ。
 * リストは grep できるが、暗黙の前方一致は grep できない。
 *
 * @param {string} query
 * @return {?string} 引っかかった語。安全なら null
 */
function bannedStockTerm_(query) {
  // 記号を空白にし、連続空白を1つに畳む（'hidden-camera' も 'hidden  cam' も拾う）
  const q = ' ' + String(query || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ' ';

  for (let i = 0; i < STOCK_BANNED_TERMS.length; i++) {
    const t = STOCK_BANNED_TERMS[i];
    // ★'masturbat' だけは語幹。活用が多く、無害な同形が存在しない
    if (t === 'masturbat') {
      if (/\bmasturbat/.test(q)) return t;
      continue;
    }
    if (q.indexOf(' ' + t + ' ') >= 0) return t;
  }
  return null;
}

/** 安全なら true。ログを1行残すのはここだけにする（呼び出し側を汚さない）。 */
function stockQueryIsSafe_(query) {
  const hit = bannedStockTerm_(query);
  if (!hit) return true;
  console.warn('検索語を破棄しました（禁止語「' + hit + '」を含む）: ' +
               String(query || '').slice(0, 80));
  return false;
}

/**
 * ★止まる映像を狙う検索語。
 *
 * 選び方の基準は3つ。
 *   ・近接（macro / close up）… 画面が埋まる。縦型で強い
 *   ・動き（slow motion / pouring / sparks）… 無音でも動く
 *   ・人（表情・体の動き）… 人は人を見てしまう
 *
 * 「gadget」「technology」のような分類語は入れない。
 * 分類語は在庫の中で最も退屈な映像を引き当てる。
 */
const STOCK_QUERIES = {
  /*
   * ★★Aの検索語を丸ごと入れ替えた（2026-08-24、オーナー指示
   * 「ニッチな作業映像やASMRなどは一切不要」）。
   *
   * 旧リストは工具・機械のマクロ映像だった。作業として綺麗ではあるが、
   * 見る人を選ぶ。狙いは「言語の壁を越えて誰でも見てしまう」側なので、
   *   ・規模が大きい（群衆・爆発・打ち上げ）
   *   ・一瞬で結果が出る（割れる・弾ける・倒れる）
   *   ・人の身体が限界に触れている（跳ぶ・落ちる・決まる）
   * へ寄せた。どれも説明が要らない＝ミュートでも成立する。
   */
  'A': [
    'crowd stadium celebration slow motion',
    'fireworks explosion night slow motion',
    'color powder explosion slow motion',
    'glass shattering slow motion',
    'water balloon burst slow motion',
    'skateboarder jump trick slow motion',
    'basketball dunk slow motion',
    'domino chain reaction falling',
    'car drifting smoke slow motion',
    'rocket launch liftoff',
    'lightning strike storm night',
    'drone flying over city sunset',
    'wave crashing surfer slow motion',
    'parkour rooftop jump city',
    'paint splash collision slow motion'
  ],
  /*
   * ★★Bの検索語（2026-08-24に二度書き換えた）。
   *
   * 一度目：東京の夜景・ネオン・桜という風景b-roll → 題材と無関係で0点。
   * 二度目：描く手元・ページ・本棚（制作過程）へ。
   * 三度目（今回）：オーナー指示で「セクシー寄り」へ。
   *   ただし指示にあった盗撮的な語は使わない。本人確認済みで、
   *   「そういう雰囲気の」という意味であり、盗撮を作れという話ではない。
   *   雰囲気は水着・ファッション・ダンス・浴衣で出る。
   *
   * 【この並びの意図】
   *   前半：人が映る、動きのある、露骨でない映像（止まる理由）
   *   後半：アニメ・オタク文化側（Bが何のアカウントかを保つ）
   * 後半を残すのは、前半だけにすると「ただの水着bot」になり、
   * 同人を紹介するというB本来の役割から外れるため。
   *
   * ★全語が STOCK_BANNED_TERMS を通る（テストで縛ってある）。
   *   'woman' と書いて 'girl' と書かないのは、素材側で年齢が
   *   曖昧な結果を引かないため。ここは崩さない。
   */
  'B': [
    'woman in swimsuit walking beach slow motion',
    'woman poolside summer slow motion',
    'fashion model walking runway slow motion',
    'woman dancing studio slow motion',
    'woman hair flip slow motion portrait',
    'woman in yukata summer festival japan',
    'fitness woman workout gym slow motion',
    'woman sunglasses summer city slow motion',
    'beach water splash summer slow motion',
    'anime figure on shelf close up',
    'cosplay costume detail close up',
    'hand drawing lineart ink pen close up',
    'manga pages flipping macro',
    'arcade claw machine tokyo close up'
  ]
};

function stockQueries_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  /*
   * ★LINEから STOCK_QUERIES_A / _B で上書きできる。
   * つまりここに何が入るかはコードでは決まらない。
   * 補充に使う前に安全弁を通す（30_Stock.gs 冒頭）。
   */
  return getListProp_('STOCK_QUERIES_' + key, STOCK_QUERIES[key] || [])
    .filter(function (q) { return stockQueryIsSafe_(q); });
}

/* ------------------------------------------------------------------ */
/* シート                                                               */
/* ------------------------------------------------------------------ */

function getOrCreateStockSheet_(ss) {
  const spreadsheet = ss || openLogSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(STOCK_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(STOCK_SHEET_NAME);
    sheet.getRange(1, 1, 1, STOCK_HEADERS.length).setValues([STOCK_HEADERS]);
    sheet.getRange(1, 1, 1, STOCK_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  ensureTrailingHeaders_(sheet, STOCK_HEADERS);
  return sheet;
}

/**
 * 在庫を読む。
 *
 * ★Statusが空か OK の行だけを使う。
 * オーナーが見て「これは違う」と思った行に NG と書けば、以後使われない。
 * 行ごと消してもよいが、消すとまた同じ映像を拾ってくる。
 */
function listStock_(accountKey, ss) {
  const key = String(accountKey || '').toUpperCase();
  const sheet = getOrCreateStockSheet_(ss);
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const values = sheet.getRange(2, 1, last - 1, STOCK_HEADERS.length).getValues();
  const out = [];
  values.forEach(function (row, i) {
    const acc = String(row[STOCK_COL_ACCOUNT - 1] || '').toUpperCase();
    if (acc && acc !== key) return;

    const status = String(row[STOCK_COL_STATUS - 1] || '').toUpperCase();
    if (status && status !== 'OK') return;      // NG / SKIP 等は使わない

    const url = String(row[STOCK_COL_URL - 1] || '').trim();
    // ★drive: は自前の貯蔵庫（35_Vault.gs）。外部URLと同じく有効な行
    if (!/^https?:\/\//i.test(url) && !/^drive:/.test(url)) return;

    out.push({
      row: i + 2,
      url: url,
      query: String(row[STOCK_COL_QUERY - 1] || ''),
      used: Number(row[STOCK_COL_USED - 1]) || 0,
      source: String(row[STOCK_COL_SOURCE - 1] || ''),
      // ★画質と尺も返す。どれを選ぶかの判断材料であり、
      //   何より「本文が映像を説明できる」ために query が要る。
      width: Number(row[STOCK_COL_WIDTH - 1]) || 0,
      duration: Number(row[STOCK_COL_DURATION - 1]) || 0
    });
  });
  return out;
}

/** 在庫にある全URL（重複を足さないため）。 */
function stockUrlSet_(ss) {
  const sheet = getOrCreateStockSheet_(ss);
  const last = sheet.getLastRow();
  const set = {};
  if (last < 2) return set;
  sheet.getRange(2, STOCK_COL_URL, last - 1, 1).getValues().forEach(function (r) {
    const u = String(r[0] || '').trim();
    if (u) set[u] = true;
  });
  return set;
}

/**
 * 在庫から1本選ぶ。使用回数の少ないものを優先する。
 *
 * ★同じ映像が続くと、見ている側は「同じ動画」と認識する。
 * 使った回数を記録して、薄く使い回す。
 *
 * @return {?{url:string, row:number, query:string}}
 */
/**
 * まだ使い切っていない在庫だけ。自動補充の判定はこちらの数で行う。
 *
 * ★listStock_ の件数で判定してはいけない。行は使っても消えないため、
 * その数は減らず、補充が永久に走らない（2026-08-22の実害）。
 */
function freshStock_(accountKey, ss) {
  return listStock_(accountKey, ss).filter(function (x) {
    return x.used < STOCK_MAX_USES;
  });
}

/**
 * 在庫の映像が、その回の話題とどれだけ噛み合っているか。
 *
 * ★★2026-08-24。オーナー評価「動画も0点」の直接の原因がここに無かった。
 *
 * 在庫の行は「どの検索語で拾ってきたか」(Query列)を持っている。
 * これは、その映像に何が映っているかの文字どおりの説明である。
 * ところが動画を選ぶ側はこの列を一度も読まず、使用回数だけで選んでいた。
 * 結果、本文は「レーザー加工機の話」、映像は「コーヒーが注がれる映像」
 * という投稿が普通に出る。読み手は文章より先に映像を見るので、
 * 噛み合っていない時点で 0点 になる。
 *
 * 語が1つでも重なれば加点する。完全一致は狙わない（在庫が尽きる）。
 *
 * @return {number} 一致した語数
 */
function stockRelevance_(stockQuery, wantedWords) {
  if (!wantedWords || !wantedWords.length) return 0;
  const have = String(stockQuery || '').toLowerCase();
  if (!have) return 0;
  let hit = 0;
  for (let i = 0; i < wantedWords.length; i++) {
    const w = String(wantedWords[i] || '').toLowerCase();
    if (w.length >= 3 && have.indexOf(w) >= 0) hit++;
  }
  return hit;
}

/** 検索語を語に割る。3文字未満は雑音なので落とす。 */
function stockQueryWords_(query) {
  return String(query || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function (w) { return w.length >= 3; });
}

/**
 * 在庫から1本選ぶ。
 *
 * 優先順位（上から順に効く）
 *   1. 話題と語が重なっている（噛み合わない映像は0点）
 *   2. 使用回数が少ない（同じ映像の連投を避ける）
 *   3. 横幅が広い（縦型に切っても粗くならない）
 *
 * @param {string} accountKey
 * @param {?Object} ss
 * @param {string=} query その回の話題から作った検索語。空なら従来どおり
 * @return {?{url:string, row:number, query:string, width:number, duration:number}}
 */
function pickFromStock_(accountKey, ss, query) {
  // ★未使用ぶんを優先。尽きていれば、やむを得ず使い回す
  //   （投稿を落とすより1本の再利用の方が損失が小さい。補充は別途走る）
  const list = freshStock_(accountKey, ss);
  const pool = list.length ? list : listStock_(accountKey, ss);
  if (!pool.length) return null;

  const words = stockQueryWords_(query);

  const scored = pool.map(function (x) {
    return { item: x, rel: stockRelevance_(x.query, words) };
  });

  /*
   * ★噛み合う映像があるなら、そこからだけ選ぶ。
   * 1語でも重なった行が1本でもあれば、重なっていない行は候補から外す。
   * 「使用回数は少ないが無関係」より「1回使ったが噛み合う」を採る。
   */
  const best = scored.reduce(function (m, s) { return Math.max(m, s.rel); }, 0);
  const relevant = best > 0
    ? scored.filter(function (s) { return s.rel === best; }).map(function (s) { return s.item; })
    : pool;

  const minUsed = relevant.reduce(function (m, x) { return Math.min(m, x.used); }, Infinity);
  let freshest = relevant.filter(function (x) { return x.used === minUsed; });

  /*
   * ★同点なら画質で決める。
   * 縦型へ切り出す前提なので、横幅が狭い素材は拡大されて粗く見える。
   * 実際に240pの素材を引いていたことがあり、それ自体が0点の理由になる。
   */
  const maxW = freshest.reduce(function (m, x) { return Math.max(m, x.width || 0); }, 0);
  if (maxW > 0) {
    const sharp = freshest.filter(function (x) { return (x.width || 0) === maxW; });
    if (sharp.length) freshest = sharp;
  }

  return freshest[Math.floor(Math.random() * freshest.length)];
}

/** 使った回数を1つ増やす。 */
function noteStockUsed_(row, ss) {
  if (!row) return;
  try {
    const sheet = getOrCreateStockSheet_(ss);
    const cur = Number(sheet.getRange(row, STOCK_COL_USED).getValue()) || 0;
    sheet.getRange(row, STOCK_COL_USED).setValue(cur + 1);
  } catch (e) {
    console.warn('ストックの使用回数を更新できません: ' + truncate_(String(e), 100));
  }
}

/* ------------------------------------------------------------------ */
/* 補充                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pexels/Pixabay から候補を集めて在庫へ足す。
 *
 * ★1回の補充で検索語を数本しか使わない。
 * 全部の検索語を毎回叩くと実行枠を使い切る。順番に回す。
 *
 * @param {string} accountKey
 * @param {number} [want] 何本足したいか
 * @return {{added:number, tried:Array<string>, reason:string}}
 */
function refillStock_(accountKey, want) {
  const key = String(accountKey || '').toUpperCase();
  const queries = stockQueries_(key);
  if (!queries.length) return { added: 0, tried: [], reason: '検索語が設定されていません' };

  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateStockSheet_(ss);
  const known = stockUrlSet_(ss);
  const target = Math.min(Number(want) || STOCK_REFILL_MAX, STOCK_REFILL_MAX);

  // 検索語は順番に回す。毎回同じ語から始めると在庫が偏る
  const prop = 'stock_q_' + key;
  let n = Number(getProp_(prop, '0')) || 0;

  /*
   * ★ページも回す。
   *
   * 検索語だけを回していると、同じ語は毎回同じ1ページ目を返す。
   * 全部が在庫の重複判定に引っかかった時点で「新しい映像なし」となり、
   * 以後どれだけ補充しても0本のまま増えなくなる。
   * 一巡するたびにページを進めれば、在庫が尽きない。
   */
  const pageProp = 'stock_page_' + key;
  const page = Math.max(1, Number(getProp_(pageProp, '1')) || 1);

  const rows = [];
  const tried = [];

  for (let i = 0; i < queries.length && rows.length < target; i++) {
    const q = String(queries[(n + i) % queries.length]).trim();
    tried.push(q);

    let found = [];
    try {
      found = searchStockCandidates_(q, page);
    } catch (e) {
      console.warn('ストック検索で例外 (' + q + '): ' + truncate_(String(e), 100));
    }

    found.forEach(function (c) {
      if (rows.length >= target) return;
      if (known[c.url]) return;              // 既に在庫にある
      known[c.url] = true;
      rows.push([new Date(), key, q, c.url, c.duration || '', c.width || '',
                 c.source, 0, '']);
    });
  }

  try { props_().setProperty(prop, String((n + tried.length) % queries.length)); }
  catch (e) {}

  /*
   * ★1本も取れなかった＝このページは在庫と重複し尽くしている。
   * 次はもっと奥を見る。10ページで一周して戻す（無限に深く行かない）。
   */
  if (!rows.length) {
    try { props_().setProperty(pageProp, String(page >= 10 ? 1 : page + 1)); }
    catch (e) {}
  }

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, STOCK_HEADERS.length)
         .setValues(rows);
  }

  return {
    added: rows.length,
    tried: tried,
    page: page,
    reason: rows.length ? ''
      : ('ページ' + page + 'は在庫と重複。次回はページ' + (page >= 10 ? 1 : page + 1) + 'を見ます')
  };
}

/**
 * 1つの検索語で候補を集める。Pexels と Pixabay の両方を見る。
 *
 * ★縦型・短尺だけを拾う。横型はXの画面で小さくなり、
 * 長い映像はGASの実行枠を圧迫する。
 *
 * @return {Array<{url:string, duration:number, width:number, source:string}>}
 */
function searchStockCandidates_(query, page) {
  const out = [];
  const p = Math.max(1, Number(page) || 1);

  // --- Pexels ---
  const pexKey = getProp_('PEXELS_API_KEY', '');
  if (pexKey) {
    try {
      const res = UrlFetchApp.fetch(
        'https://api.pexels.com/videos/search?query=' + encodeURIComponent(query) +
        '&orientation=portrait&per_page=8&page=' + p,
        { headers: { Authorization: pexKey }, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        ((JSON.parse(res.getContentText()) || {}).videos || []).forEach(function (v) {
          const dur = Number(v.duration || 0);
          if (dur > 0 && dur > 40) return;              // 長すぎる
          /*
           * ★一番小さいものを機械的に選ばない（2026-08-22）。
           *
           * 幅の昇順で[0]を取ると240p級を掴むことがあり、Xで見て粗い。
           * かといって大きすぎるとGASの実行枠と上限に当たる。
           * 「540px以上のうち最小」を選ぶと、実用画質で最小のものになる。
           */
          const files = (v.video_files || [])
            .filter(function (f) { return /mp4/i.test(String(f.file_type || '')); })
            .sort(function (a, b) { return (a.width || 0) - (b.width || 0); });
          if (!files.length) return;
          const usable = files.filter(function (f) { return (f.width || 0) >= 540; });
          const pick = usable.length ? usable[0] : files[files.length - 1];
          out.push({
            url: String(pick.link),
            duration: dur,
            width: Number(pick.width || 0),
            source: 'pexels'
          });
        });
      } else {
        console.warn('Pexels HTTP ' + res.getResponseCode() + ' (' + query + ')');
      }
    } catch (e) {
      console.warn('Pexelsへ到達できません: ' + truncate_(String(e), 100));
    }
  }

  // --- Pixabay ---
  const pixKey = getProp_('PIXABAY_API_KEY', '');
  if (pixKey) {
    try {
      const res = UrlFetchApp.fetch(
        'https://pixabay.com/api/videos/?key=' + encodeURIComponent(pixKey) +
        '&q=' + encodeURIComponent(query) + '&per_page=8&safesearch=true&page=' + p,
        { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        ((JSON.parse(res.getContentText()) || {}).hits || []).forEach(function (h) {
          const dur = Number(h.duration || 0);
          if (dur > 0 && dur > 40) return;
          /*
           * ★Pixabayは size（バイト数）を返す。取得してから
           * 「大きすぎた」と捨てるのは無駄なので、ここで落とす。
           * small が重ければ tiny へ降りる。
           */
          const vids = h.videos || {};
          const cand = [vids.small, vids.medium, vids.tiny].filter(function (v) {
            return v && v.url;
          });
          const fits = cand.filter(function (v) {
            const sz = Number(v.size || 0);
            return !sz || sz <= STOCK_MAX_BYTES;
          });
          const pick = fits.length ? fits[0] : null;
          if (!pick) return;
          out.push({
            url: String(pick.url),
            duration: dur,
            width: Number(pick.width || 0),
            source: 'pixabay'
          });
        });
      } else {
        console.warn('Pixabay HTTP ' + res.getResponseCode() + ' (' + query + ')');
      }
    } catch (e) {
      console.warn('Pixabayへ到達できません: ' + truncate_(String(e), 100));
    }
  }

  return out;
}

/**
 * ストック写真のURLを取る。動画が通らない時の最後の砦。
 *
 * ★動画と同じキーで写真も引ける（Pexels /v1/search、Pixabay /api/）。
 * ライセンスは動画と同じく商用利用可・帰属不要。
 * 写真は数百KBで、分割送信も変換待ちも要らないため確実に通りやすい。
 *
 * @param {string} query 検索語
 * @param {number} [want] 何枚ほしいか
 * @return {Array<string>} 画像URLの配列（取れなければ空）
 */
function stockPhotoUrls_(query, want) {
  if (!stockQueryIsSafe_(query)) return [];
  const q = String(query || '').trim() || 'macro texture close up';
  const limit = Math.max(1, Math.min(Number(want) || 5, 10));
  const out = [];

  const pexKey = getProp_('PEXELS_API_KEY', '');
  if (pexKey) {
    try {
      /*
       * ★orientation を付けて弾かれたら、外して1回だけ試し直す。
       *
       * ここは「動画が駄目な時の最後の砦」なので、パラメータ1つで
       * 全滅させたくない。仕様変更や綴り違いで400が返っても、
       * 縦横の好みを捨てれば写真自体は取れる。
       */
      let res = UrlFetchApp.fetch(
        'https://api.pexels.com/v1/search?query=' + encodeURIComponent(q) +
        '&orientation=portrait&per_page=' + limit,
        { headers: { Authorization: pexKey }, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        console.warn('Pexels写真 HTTP ' + res.getResponseCode() +
                     '。orientationを外して再試行します。');
        res = UrlFetchApp.fetch(
          'https://api.pexels.com/v1/search?query=' + encodeURIComponent(q) +
          '&per_page=' + limit,
          { headers: { Authorization: pexKey }, muteHttpExceptions: true });
      }
      if (res.getResponseCode() === 200) {
        ((JSON.parse(res.getContentText()) || {}).photos || []).forEach(function (p) {
          const src = p && p.src;
          // large は数MB。Xの画像上限(5MB)に対して large2x は危ういので large まで
          const url = src && (src.large || src.medium || src.original);
          if (url) out.push(String(url));
        });
      } else {
        console.warn('Pexels写真 HTTP ' + res.getResponseCode());
      }
    } catch (e) {
      console.warn('Pexels写真へ到達できません: ' + truncate_(String(e), 100));
    }
  }

  if (out.length < limit) {
    const pixKey = getProp_('PIXABAY_API_KEY', '');
    if (pixKey) {
      try {
        const res = UrlFetchApp.fetch(
          'https://pixabay.com/api/?key=' + encodeURIComponent(pixKey) +
          '&q=' + encodeURIComponent(q) +
          '&image_type=photo&safesearch=true&per_page=' + Math.max(3, limit),
          { muteHttpExceptions: true });
        if (res.getResponseCode() === 200) {
          ((JSON.parse(res.getContentText()) || {}).hits || []).forEach(function (h) {
            const url = h && (h.webformatURL || h.largeImageURL);
            if (url) out.push(String(url));
          });
        } else {
          console.warn('Pixabay写真 HTTP ' + res.getResponseCode());
        }
      } catch (e) {
        console.warn('Pixabay写真へ到達できません: ' + truncate_(String(e), 100));
      }
    }
  }

  return out.slice(0, limit);
}

/**
 * 在庫が減っていたら自動で補充する。
 *
 * ★投稿のたびに検索する形へ戻さない。
 * 在庫が閾値を割った時だけ、まとめて足す。
 */
function ensureStockLevel_(accountKey) {
  try {
    const ss = openLogSpreadsheet_();

    /*
     * ★★検索語を変えたのに在庫が入れ替わらなかった（2026-08-24）。
     *
     * 【何が起きたか】
     * Bの検索語を夜景b-rollから入れ替えたのに、実機のBは何も変わらなかった。
     * 当然だった。在庫シートには旧リストで集めた行が大量に残っており、
     * 未使用ぶんが下限(12本)を超えている限り補充は走らない。
     * つまり「新しい検索語で1本も取りに行かない」状態が続く。
     *
     * リストを書き換えることと、その結果を画面に出すことは別の作業だった。
     * 検索語を変えたら、その語で集めていない在庫は退役させる。
     */
    retireStaleStock_(accountKey, ss);

    // ★使い切っていないぶんで数える。行数で数えると永久に補充されない
    const have = freshStock_(accountKey, ss).length;
    if (have >= STOCK_LOW_WATER) return have;

    console.log('使える動画の在庫が ' + have + ' 本（下限 ' + STOCK_LOW_WATER + '）。補充します。');
    const r = refillStock_(accountKey, STOCK_REFILL_MAX);
    console.log('ストック補充: ' + r.added + ' 本追加');
    return have + r.added;
  } catch (e) {
    console.warn('在庫の確認に失敗（投稿は続行）: ' + truncate_(String(e), 120));
    return 0;
  }
}

/**
 * 取得できなかった映像に印を付ける。
 *
 * ★死んだURLを在庫に残すと、選ばれるたびに1回ぶんの通信を捨てる。
 * NGにしておけば以後 listStock_ が拾わず、
 * refillStock_ の重複判定には残るので同じものを拾い直さない。
 */
/**
 * 今の検索語リストで集めていない在庫を退役させる。
 *
 * ★★2026-08-24。検索語を入れ替えても実機が何も変わらなかった件の対策。
 *
 * 在庫の Query 列には「どの語で拾ってきたか」が入っている。
 * その語が現在のリストに無いなら、その行は前の方針で集めたものである。
 * 未使用ぶんが下限を超えている限り補充は走らないので、
 * 退役させない限り、新しい語の映像は1本も入ってこない。
 *
 * 【消さずに RETIRED にする理由】
 * 行を消すと、同じURLをまた拾ってきて同じ判断を繰り返す。
 * ステータスを変えれば重複判定(stockUrlSet_)には残るので、
 * 二度と選ばれず、二度と取りに行かない。
 *
 * 【1回に退役させる数を絞る理由】
 * 60行を一度に書き換えるとGASの実行枠を食う。
 * 補充は10本ずつなので、退役も同じ歩幅で足りる。
 *
 * @return {number} 退役させた行数
 */
const STOCK_RETIRE_PER_RUN = 12;

/**
 * 退役させてよい出所。
 *
 * ★★ここを限定しないと、金を払って作った素材を消す。
 *
 * Veoで生成した行は Query が 'veo: <題材>' で、検索語リストには
 * 当然入っていない。出所を見ずに退役させると、生成に課金した映像を
 * こちらから捨てることになる。自前の貯蔵庫(drive:)も同じ。
 * 消してよいのは「また同じ語で引き直せるもの」＝ストック検索の結果だけ。
 */
const STOCK_RETIREABLE_SOURCES = { pexels: 1, pixabay: 1 };

function retireStaleStock_(accountKey, ss) {
  let current;
  try { current = stockQueries_(accountKey); }
  catch (e) { return 0; }
  // ★リストが空の時は何もしない。全部退役させて在庫を空にしてしまう
  if (!current.length) return 0;

  const valid = {};
  current.forEach(function (q) { valid[String(q).trim().toLowerCase()] = true; });

  let rows;
  try { rows = listStock_(accountKey, ss); }
  catch (e) { return 0; }

  let n = 0;
  for (let i = 0; i < rows.length && n < STOCK_RETIRE_PER_RUN; i++) {
    // ★取り直せるものだけ。生成物には触れない
    const src = String(rows[i].source || '').trim().toLowerCase();
    if (!STOCK_RETIREABLE_SOURCES[src]) continue;

    /*
     * ★自前の貯蔵庫(drive:)へ移した行も触らない。
     *
     * 貯蔵庫へ移す時、出所の列は 'pexels' のまま残る。上の判定だけでは
     * 通ってしまう。URLの形で見る方が確実で、35_Vault.gs に依存しない。
     * （関数の有無を typeof で見る書き方にすると、読み込み順が変わった
     *   時に静かに保護が外れて、自前の資産を消す）
     */
    if (!/^https?:\/\//i.test(String(rows[i].url || ''))) continue;

    /*
     * ★NG理由が追記された行は " / 理由" が付いている。
     *   先頭の語だけで照合する。
     */
    const q = String(rows[i].query || '').split(' / ')[0].trim().toLowerCase();
    if (!q || valid[q]) continue;
    try {
      getOrCreateStockSheet_(ss).getRange(rows[i].row, STOCK_COL_STATUS)
        .setValue('RETIRED');
      n++;
    } catch (e) { break; }
  }

  if (n) {
    console.log('[' + accountKey + '] 旧い検索語の在庫を ' + n +
                ' 本退役させました（今の方針で集め直します）。');
  }
  return n;
}

function markStockNg_(row, reason, ss) {
  if (!row) return;
  try {
    const sheet = getOrCreateStockSheet_(ss);
    sheet.getRange(row, STOCK_COL_STATUS).setValue('NG');
    if (reason) {
      sheet.getRange(row, STOCK_COL_QUERY).setValue(
        truncate_(String(sheet.getRange(row, STOCK_COL_QUERY).getValue() || '') +
                  ' / ' + reason, 200));
    }
  } catch (e) {
    console.warn('在庫のNG記録に失敗: ' + truncate_(String(e), 100));
  }
}

/**
 * 全アカウントの在庫を補充水位まで戻す。
 *
 * ★投稿サイクルの中だけで補充していると、補充そのものが
 * 投稿の実行時間を食う。1日1回の計測(15_Metrics.gs)から
 * 先回りして呼び、投稿時には在庫がある状態にしておく。
 */
function topUpAllStock_() {
  let added = 0;
  Object.keys(ACCOUNTS).forEach(function (k) {
    try {
      const before = freshStock_(k).length;
      if (before >= STOCK_LOW_WATER) return;
      const r = refillStock_(k, STOCK_REFILL_MAX);
      added += (r && r.added) || 0;
    } catch (e) {
      console.warn('[' + k + '] 在庫の先回り補充に失敗: ' + truncate_(String(e), 100));
    }
  });
  if (added > 0) console.log('先回り補充: 合計 ' + added + ' 本追加');

  /*
   * ★外部URLの在庫を、少しずつ自前の貯蔵庫へ移す（35_Vault.gs）。
   * 1回3本まで。毎日動くので、放っておけば資産に変わっていく。
   * 無料で、相手が消しても減らない在庫になる。
   */
  try {
    if (typeof fillVaultFromStock_ === 'function' && vaultEnabled_()) {
      const v = fillVaultFromStock_(VAULT_SAVE_PER_RUN);
      if (v.moved) console.log('貯蔵庫へ ' + v.moved + ' 本移しました');
    }
  } catch (e) {
    console.warn('貯蔵庫への移動に失敗（在庫は使えます）: ' + truncate_(String(e), 120));
  }

  /*
   * ★Veo（34_Veo.gs）。既定は無効で、有効な時だけ動く。
   *
   * 生成は秒課金なので在庫の補充とは扱いを分ける。
   * ここでやるのは「完成したものの取り込み」と「1本の仕込み」だけ。
   * 日次上限は 34_Veo.gs 側が持つ。
   */
  try {
    if (typeof veoEnabled_ === 'function' && veoEnabled_()) {
      const msg = checkVeoPending_();
      if (msg) console.log(msg);
      // 生成中でなければ、在庫が薄いアカウントに1本だけ仕込む
      if (!getProp_('veo_pending', '')) {
        const thin = Object.keys(ACCOUNTS).filter(function (k) {
          try { return freshStock_(k).length < STOCK_LOW_WATER; } catch (e) { return false; }
        });
        if (thin.length) console.log(queueVeoGeneration_(thin[0], veoSubjectFor_(thin[0])));
      }
    }
  } catch (e) {
    console.warn('Veoの処理でエラー（在庫の補充は完了しています）: ' + truncate_(String(e), 120));
  }

  return added;
}

/**
 * Veoに何を撮らせるか。バズ材料の見出しがあればそれを使う。
 * 無ければ在庫用の検索語を流用する（どちらも「動きのある近接」を狙う語）。
 */
function veoSubjectFor_(accountKey) {
  try {
    const list = collectBuzzCandidates_(accountKey) || [];
    if (list.length && list[0].title) return String(list[0].title);
  } catch (e) {}
  const qs = stockQueries_(accountKey);
  return qs.length ? String(qs[Math.floor(Math.random() * qs.length)]) : '';
}

/* ------------------------------------------------------------------ */
/* LINE / エディタからの操作                                             */
/* ------------------------------------------------------------------ */

/** 「ストック補充」コマンド。 */
function refillStockForLine_(accountKey) {
  const keys = accountKey ? [String(accountKey).toUpperCase()] : Object.keys(ACCOUNTS);
  const lines = ['📦 動画ストックの補充', ''];

  if (!getProp_('PEXELS_API_KEY', '') && !getProp_('PIXABAY_API_KEY', '')) {
    return [
      '⚠️ 素材APIのキーが未設定です。',
      '',
      'PEXELS_API_KEY か PIXABAY_API_KEY のどちらかを',
      'スクリプトプロパティに入れてください（どちらも無料）。',
      '',
      '  Pexels : pexels.com/api',
      '  Pixabay: pixabay.com/api/docs'
    ].join('\n');
  }

  let totalHave = 0;
  keys.forEach(function (k) {
    let r;
    try { r = refillStock_(k, STOCK_REFILL_MAX); }
    catch (e) {
      lines.push('[' + k + '] ❌ ' + truncate_(String(e), 100));
      return;
    }
    lines.push('[' + k + '] ' + r.added + ' 本追加' + (r.reason ? '（' + r.reason + '）' : ''));
    if (r.tried.length) {
      lines.push('  検索語: ' + r.tried.slice(0, 3).join(' / '));
    }
    const have = listStock_(k).length;
    totalHave += have;
    lines.push('  在庫: ' + have + ' 本');
  });

  /*
   * ★★2026-08-22、実機で実害あり★★
   *
   * VIDEO_UPLOAD は既定OFFの「殺すスイッチ」のまま。「ストック補充」は
   * 「初期設定」より前から存在するコマンドで、これだけ叩いても
   * 有効化されなかったため、「在庫は30本あるのにバズ投稿は
   * メディア無しで中断され続ける」状態が実機で起きた
   * （pickBuzzVideoAsset_ は在庫を見る前にこのフラグで即nullを返す）。
   *
   * 在庫を取りに来た＝動画を使いたいという意思表示なので、
   * ここで済ませる。「初期設定」を通らなかった人も自動で救われる。
   */
  if (totalHave > 0 && String(getProp_('VIDEO_UPLOAD', '0')) !== '1') {
    props_().setProperty('VIDEO_UPLOAD', '1');
    lines.push('');
    lines.push('✅ VIDEO_UPLOAD を有効化しました（在庫があるのに無効のままでした）。');
  }

  lines.push('');
  lines.push('VideoStockシートで中身を確認できます。');
  lines.push('気に入らない行は Status 列に NG と書けば使われません。');
  return lines.join('\n');
}

/** 「ストック」コマンド。在庫の状態を見る。 */
function buildStockText_() {
  const lines = ['📦 動画ストック', ''];
  Object.keys(ACCOUNTS).forEach(function (k) {
    let list = [];
    try { list = listStock_(k); }
    catch (e) { lines.push('[' + k + '] ❌ 読めません'); return; }

    /*
     * ★「まだ使える本数」で判定する。
     * 総数で見ていたせいで、全部が使い切られていても「30本 ✅」と
     * 表示され、自動補充も走らなかった（2026-08-22）。
     */
    const fresh = list.filter(function (x) { return x.used < STOCK_MAX_USES; });
    lines.push('[' + k + '] 使える ' + fresh.length + ' 本 / 全' + list.length + ' 本' +
               (fresh.length < STOCK_LOW_WATER ? '  ⚠️ 少ない（自動補充されます）' : '  ✅'));
    if (list.length) {
      const unused = list.filter(function (x) { return !x.used; }).length;
      lines.push('  未使用: ' + unused + ' 本 / 使い切り: ' +
                 (list.length - fresh.length) + ' 本（' + STOCK_MAX_USES + '回で退役）');
      // どんな映像が入っているか、検索語で分かるようにする
      const qs = {};
      list.forEach(function (x) { if (x.query) qs[x.query] = (qs[x.query] || 0) + 1; });
      const top = Object.keys(qs).slice(0, 3)
        .map(function (q) { return q + '(' + qs[q] + ')'; });
      if (top.length) lines.push('  例: ' + top.join(' / '));
    }
  });
  lines.push('');
  lines.push('「ストック補充」で足せます。');
  return lines.join('\n');
}

/** GASエディタ用の公開ラッパー。 */
function refillVideoStock() {
  console.log(refillStockForLine_(''));
}

function showVideoStock() {
  console.log(buildStockText_());
}
