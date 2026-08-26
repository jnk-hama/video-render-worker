/**
 * ===========================================================================
 * 17_BFunnel.gs  —  Bアカウントの収益ファネル
 * ===========================================================================
 * Bを「成人系ツイートを流すアカウント」から
 * 「海外ユーザーに日本のクリエイター文化を発見させ、購買まで繋げるアカウント」
 * へ変える。
 *
 * 【設計の芯】
 * 投稿＝広告 にしない。広告だけのアカウントは伸びず、伸びなければ売れない。
 * 販売系60% / 集客系40% で回す。
 *
 *   販売60%: PRODUCT_DISCOVERY 20 / CATEGORY_GUIDE 15 / PROBLEM_SOLUTION 10 /
 *            COMPARISON 10 / DIRECT_CTA 5
 *   集客40%: CULTURE 15 / DISCOVERY 10 / CREATOR_WORK_DISCOVERY 10 /
 *            COMMUNITY_QUESTION 5
 *
 * ★「販売60% ＝ 60%の投稿にURLを貼る」ではない。
 *   販売系のうち実際にリンクを貼るのは PRODUCT_DISCOVERY / PROBLEM_SOLUTION /
 *   COMPARISON / DIRECT_CTA の45%で、CATEGORY_GUIDE(15%)はリンクを持たない。
 *   さらにリンクは validateAffiliateLink_() を通ったものしか使わないため、
 *   確認済みリンクが無ければ実際のリンク付き投稿は0%になる。
 *
 * 【比率をランダムで実現しない】
 * 毎回ダイスを振ると、短期では比率が大きくブレる。
 * 直近の実績を数えて「目標との差が一番大きいタイプ」を選ぶ方式にしている。
 * これなら100本回した時点で必ず設計どおりの配分になる。
 *
 * 【収益先は3つだけ】
 * DLsite / Fantia / DiGiket。均等配分はしない。投稿内容に合う先を選ぶ。
 *
 * 【リンクを貼る条件（2026-08-15 オーナー判断で条件付き実装へ移行）】
 * Linksシートの1行が Status=ACTIVE かつ Verified=TRUE かつ
 * 5つのAllowed列と対象国の列がすべてTRUE、かつ確認日が
 * LINKS_VERIFICATION_MAX_AGE_DAYS 以内 の時だけリンクを使う。
 * この判定は validateAffiliateLink_() に集約してある。
 * 判定に必要な値は人間が一次情報を確認して手で入れる。AIは書き換えない。
 *
 * 【開示表記】
 * リンク付き投稿には REGION_DISCLOSURE_RULES に従って開示タグを機械的に付ける。
 * LLMの気分に任せない。詳細は同定数のコメントを参照。
 */

/* ------------------------------------------------------------------ */
/* 投稿タイプ                                                           */
/* ------------------------------------------------------------------ */

/**
 * 目標配分。100本あたりの本数として読む。
 * usesLink が true のタイプだけがアフィリエイトリンクを貼れる。
 */
/*
 * ★2026-08-16、販売系(60%)の内訳をオーナー指摘で調整した。
 * 60/40の総枠自体は「OKで正しい」と確認済みなので変えていない。
 *
 * 指摘：Bの一番大きな問題は規約ではなく「無料客→購入客」の接続。
 * CATEGORY_GUIDE（一覧を眺めるだけ）とDIRECT_CTA（クリックを求めるだけ）は
 * 閲覧・懇願であって購買意図の証拠が薄い。PRODUCT_DISCOVERY（具体的な商品に
 * 出会わせる）・PROBLEM_SOLUTION（悩みに解決策を当てる）・COMPARISON
 * （比較して選ばせる）は、読者が既に「欲しい/選びたい」状態にあることを
 * 前提にした型で、購買に近い。この3つを強め、CATEGORY_GUIDE/DIRECT_CTAを
 * 弱めた（ACCESS_GUIDEは「購入直前で詰まる壁を解く」型で既に高転換の
 * 説明が付いているため維持）。
 *
 * ★ただし今すぐ配分に反映されるわけではない。usesLink:true の型は
 * pickBPostType_ 内で「使えるリンクが無ければ選ばない」フィルタが
 * 掛かっている。Linksが0/0の間は、ここでどう重みを変えても
 * ACCESS_GUIDE/PRODUCT_DISCOVERY/PROBLEM_SOLUTION/COMPARISON/DIRECT_CTAは
 * 一切選ばれない（実測の直近6本がCATEGORY_GUIDEと非リンク5種のみ
 * だったのはこれが原因）。Amazon等の登録が済み、Linksに使える行が
 * 入って初めてこの重み調整が効いてくる。
 */
const B_POST_TYPES = [
  /* ---- 販売・収益導線系 60% ---- */
  // ★ACCESS_GUIDE が最大枠。海外から日本のストアで買おうとすると
  // 言語・地域制限・決済で必ず詰まる。ここを解く投稿は読んだ人が
  // そのまま購入直前まで進むので、雑学より桁違いに購買に近い。
  { key: 'ACCESS_GUIDE',      weight: 15, usesLink: true,  sales: true },
  { key: 'PRODUCT_DISCOVERY', weight: 17, usesLink: true,  sales: true },
  { key: 'CATEGORY_GUIDE',    weight: 5,  usesLink: false, sales: true },
  { key: 'PROBLEM_SOLUTION',  weight: 13, usesLink: true,  sales: true },
  { key: 'COMPARISON',        weight: 8,  usesLink: true,  sales: true },
  { key: 'DIRECT_CTA',        weight: 2,  usesLink: true,  sales: true },
  /* ---- 集客・価値提供系 40% ---- */
  { key: 'CULTURE',                weight: 10, usesLink: false, sales: false },
  { key: 'DISCOVERY',              weight: 10, usesLink: false, sales: false },
  { key: 'CREATOR_WORK_DISCOVERY', weight: 10, usesLink: false, sales: false },
  { key: 'TERMINOLOGY',            weight: 5,  usesLink: false, sales: false },
  { key: 'COMMUNITY_QUESTION',     weight: 5,  usesLink: false, sales: false }
];

/** リンクを貼る設計になっているタイプの合計比率（状態表示の目標値に使う）。 */
const B_LINK_TARGET_PCT = B_POST_TYPES
  .filter(function (t) { return t.usesLink; })
  .reduce(function (a, t) { return a + t.weight; }, 0);

/** 販売系の合計比率。 */
const B_SALES_TARGET_PCT = B_POST_TYPES
  .filter(function (t) { return t.sales; })
  .reduce(function (a, t) { return a + t.weight; }, 0);

/**
 * タイプごとの書き方。プロンプトへそのまま差し込む。
 *
 * ★販売系でも「広告文」を書かせない。
 * 指示書§13の順序（Need → Interest → Information → Fit → Recommendation → CTA）を
 * 各ブリーフに落としてある。毎回同じCTAで締める投稿にしないため、
 * CTAを許すのは DIRECT_CTA だけに限定している。
 */
const B_TYPE_BRIEF = {
  /* ---- 販売系 ---- */
  'ACCESS_GUIDE':
    'Solve one concrete obstacle that stops someone outside Japan from completing a ' +
    'purchase on a Japanese store. Payment methods, account creation, the interface ' +
    'being in Japanese, region restrictions, file formats, viewer apps, what the ' +
    'charge looks like on a foreign card. ' +
    'Pick ONE obstacle and actually resolve it — the reader should be able to act on ' +
    'it immediately. This is the most useful thing this account posts: do not pad it ' +
    'with culture commentary. ' +
    'State only what you were told or what is verifiable and general. ' +
    'If you do not know a specific fee, method, or restriction, describe the shape of ' +
    'the problem and what to check, rather than inventing a figure.',

  'PRODUCT_DISCOVERY':
    'Surface one specific kind of work that exists on the linked platform. ' +
    'Lead with what it actually is and what the experience of it is like, ' +
    'then who it suits. The link is the last line, not the hook. ' +
    'Describe only what the link information told you. ' +
    'Do not name a title, a creator, a price, or a rating.',

  'CATEGORY_GUIDE':
    'Explain one genre or category of Japanese creator work so a newcomer ' +
    'understands what it is, what to expect, and what the words mean. ' +
    'This is the post that makes someone able to shop at all. ' +
    'No link in this one. Teach the category, do not sell a product.',

  'PROBLEM_SOLUTION':
    'Start from what the reader is already looking for, in their words. ' +
    'Then say what kind of content answers that, then where that kind of thing lives. ' +
    'Order matters: need first, category second, platform last. Never the reverse.',

  'COMPARISON':
    'Explain which platform suits which kind of want. Only describe differences you ' +
    'were actually told about in the link information. Do not invent features, ' +
    'prices, catalogue sizes, or rankings. Do not say one is best.',

  'DIRECT_CTA':
    'This is the one post where a clear call to action is allowed. Keep it low-key. ' +
    '"Worth a browse if you are into X" is the register. ' +
    'Never write BUY NOW, CLICK HERE, or anything that reads like a banner ad.',

  /* ---- 集客系 ---- */
  'CULTURE':
    'Explain how some part of the Japanese doujin / indie creator scene actually works. ' +
    'How creators release, how fans support them, how the scene is structured. ' +
    'Write it for someone who knows nothing about it. No link.',

  'DISCOVERY':
    'Introduce something about Japanese creator culture that an English speaker ' +
    'would not know exists. The reaction you want is "wait, Japan has that?". ' +
    'No product, no link, no selling. Just the thing itself.',

  'CREATOR_WORK_DISCOVERY':
    'Talk about a type of creator or a way of working, not a named individual. ' +
    'What they make, who it is for, why the scene supports them. ' +
    'Never invent a real person, a handle, or a work title. No link.',

  'TERMINOLOGY':
    'Explain one Japanese term, tag, or product-code convention that an English speaker ' +
    'needs in order to search or filter on a Japanese store at all. ' +
    'Without the word, they cannot find the thing — that is why this matters. ' +
    'Give the term, what it actually means, and where they will see it. No link.',

  'COMMUNITY_QUESTION':
    'Ask the timeline one genuine question about what they are into or looking for, ' +
    'grounded in a specific corner of the Japanese scene. ' +
    'A real question you would want the answer to, not engagement bait. No link.'
};

/** どのタイプがリンクを使えるか。 */
function bTypeUsesLink_(typeKey) {
  const t = B_POST_TYPES.filter(function (x) { return x.key === typeKey; })[0];
  return !!(t && t.usesLink);
}

/* ------------------------------------------------------------------ */
/* 投稿履歴（比率とクールダウンの判定に使う）                            */
/* ------------------------------------------------------------------ */

const B_HISTORY_PROP = 'b_post_history';

/** 配分を評価する母数。指示書どおり100本を1単位とする。 */
const B_HISTORY_WINDOW = 100;

/** 履歴として保持する件数。9KB制限に収まる範囲で窓と同じだけ持つ。 */
const B_HISTORY_MAX = 100;

/** 同じURLを何投稿以内に再利用しないか。 */
const B_URL_COOLDOWN = 10;

/** リンク付き投稿が何連続したらDISCOVERYへ強制的に戻すか。 */
const B_MAX_CONSECUTIVE_LINKS = 2;

function readBHistory_() {
  try {
    const raw = getProp_(B_HISTORY_PROP, '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 投稿した内容を履歴へ記録する。
 * @param {{type:string, platform:string, category:string, url:string}} entry
 */
function rememberBPost_(entry) {
  try {
    const list = readBHistory_();
    list.unshift({
      t: entry.type || '',
      p: entry.platform || '',
      c: entry.category || '',
      u: entry.url || '',
      at: Date.now()
    });
    props_().setProperty(B_HISTORY_PROP, JSON.stringify(list.slice(0, B_HISTORY_MAX)));
  } catch (e) {
    console.warn('B投稿履歴の記録に失敗: ' + e);
  }
}

/* ------------------------------------------------------------------ */
/* 次に出す投稿タイプを決める                                           */
/* ------------------------------------------------------------------ */

/**
 * 目標配分に対して一番足りていないタイプを選ぶ。
 *
 * ★ランダム抽選にしない。
 * 重み付きランダムだと、短期では DIRECT_CTA(2%) が3連続することも
 * DISCOVERY(35%) が20本出ないこともあり得る。
 * 実績を数えて不足分から選べば、100本時点で必ず設計どおりになる。
 *
 * @param {boolean} linkAvailable 使えるリンクが1本でもあるか
 * @return {string} 投稿タイプ
 */
function pickBPostType_(linkAvailable) {
  const history = readBHistory_().slice(0, B_HISTORY_WINDOW);

  // --- 売り込み過ぎの強制ブレーキ（指示書 §10）------------------------
  // 直近がリンク付きで連続していたら、比率を無視してでも価値提供へ戻す。
  let consecutiveLinks = 0;
  for (let i = 0; i < history.length; i++) {
    if (bTypeUsesLink_(history[i].t)) consecutiveLinks++;
    else break;
  }
  const brakeOn = (consecutiveLinks >= B_MAX_CONSECUTIVE_LINKS);
  if (brakeOn) {
    console.log('リンク付き投稿が' + consecutiveLinks + '連続したため、リンク無しへ戻します。');
  }

  // --- 実績を数える ---------------------------------------------------
  const counts = {};
  B_POST_TYPES.forEach(function (t) { counts[t.key] = 0; });
  history.forEach(function (h) {
    if (counts[h.t] !== undefined) counts[h.t]++;
  });

  const total = history.length;

  // --- 目標との差が一番大きいものを選ぶ -------------------------------
  //
  // ★ブレーキ時に特定のタイプ（旧実装はDISCOVERY固定）へ倒さない。
  // 名指しで戻すと、そのタイプだけが目標比率を大きく超えて増える。
  // リンク付きが50%ある構成では実際に DISCOVERY が目標10%に対し18%まで膨らんだ。
  // ブレーキは「リンク無しの中から選ぶ」という制約にとどめ、
  // どれを選ぶかは通常どおり不足分で決める。
  let bestKey = '';
  let bestDeficit = -Infinity;

  B_POST_TYPES.forEach(function (t) {
    // リンクが1本も無い状態でリンク前提のタイプを選ぶと、投稿が作れない
    if (t.usesLink && !linkAvailable) return;
    // 売り込み過ぎのブレーキ中はリンク無しのタイプだけが対象
    if (brakeOn && t.usesLink) return;

    // 目標本数（窓の長さに比例させる。序盤でも比率が保たれる）
    const target = (t.weight / 100) * Math.max(total + 1, 1);
    const deficit = target - counts[t.key];

    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      bestKey = t.key;
    }
  });

  // 候補が1つも無い（理論上は起きない）場合の保険
  return bestKey || 'DISCOVERY';
}

/* ------------------------------------------------------------------ */
/* リンクの検証と選択                                                   */
/* ------------------------------------------------------------------ */

/**
 * Platform名 → 正規のホスト。
 * ここに無いPlatformは受け付けない（収益先を3つに固定するため）。
 */
/**
 * アカウントごとに使ってよいプラットフォーム。
 *
 * ★混ざらないようにするための仕切り。
 * Aの技術アカウントに成人向けリンクが出る、Bにガジェットが出る、
 * どちらも起きてはいけない。Linksシートの Target 列だけに頼らず、
 * Platform 名の側からも縛る。
 */
const ACCOUNT_PLATFORMS = {
  'A': ['AMAZON', 'RAKUTEN', 'ALIEXPRESS', 'GENERIC'],
  'B': ['DLSITE', 'FANTIA', 'DIGIKET', 'FANZA']
};

/**
 * ガジェット・一般商材のホスト（A用）。
 *
 * ★Aの収益化はBより圧倒的に障壁が低い。
 * ASP登録が当日でき、Xの成人向け収益化の論点も無く、
 * 出演者の同意という問題も存在しない。
 * Bの4サービスが全て未確認のまま止まっている間、
 * こちらは規約を確認すればすぐ動かせる。
 *
 * GENERIC は「メーカー公式・レビュー記事など、ASP経由でない普通のリンク」用。
 * ホストを縛らないので、Linksシートの検証列で人間が担保すること。
 */
const A_PLATFORM_HOSTS = {
  'AMAZON':     ['amazon.com', 'amazon.co.jp', 'amazon.co.uk', 'amazon.ca',
                 'amazon.com.au', 'amzn.to', 'amzn.asia'],
  'RAKUTEN':    ['rakuten.co.jp', 'a.r10.to'],
  'ALIEXPRESS': ['aliexpress.com', 's.click.aliexpress.com'],
  'GENERIC':    []          // 空＝ホスト照合をしない（検証列で担保する）
};

const B_PLATFORM_HOSTS = {
  'DLSITE':  ['dlsite.com'],
  'FANTIA':  ['fantia.jp'],
  // ★2026-08-15修正：以前 digiket.net としていたが誤り。正しくは digiket.com。
  //   （www.digiket.com / ssl.digiket.com。末尾一致で両方拾える）
  'DIGIKET': ['digiket.com'],
  // ★FANZA(DMM)。2026-08-15追加。
  // FANZAのアフィリエイトリンクは al.dmm.co.jp を経由する形があるが、
  // dmm.co.jp の末尾一致で拾えるためホストは1つで足りる。
  // ⚠️ ドメインもアフィリエイトのリンク形式も一次情報で未確認。
  //    Linksシートで Verified=TRUE / Status=ACTIVE にするまで実際には使われない。
  'FANZA':   ['dmm.co.jp']
};

/** 全プラットフォームのホスト表。A/B両方を1箇所で引く。 */
function platformHosts_(platform) {
  const key = normalizePlatform_(platform);
  if (Object.prototype.hasOwnProperty.call(B_PLATFORM_HOSTS, key)) return B_PLATFORM_HOSTS[key];
  if (Object.prototype.hasOwnProperty.call(A_PLATFORM_HOSTS, key)) return A_PLATFORM_HOSTS[key];
  return null;
}

/** 表示用の正式名称 */
const B_PLATFORM_LABEL = {
  'DLSITE': 'DLsite',
  'FANTIA': 'Fantia',
  'DIGIKET': 'DiGiket',
  'FANZA': 'FANZA',
  'AMAZON': 'Amazon',
  'RAKUTEN': '楽天',
  'ALIEXPRESS': 'AliExpress',
  'GENERIC': ''
};

/**
 * 海外からの購入に制限がかかりやすいプラットフォーム。
 *
 * ★FANZAは作品ごとに海外購入の可否が異なる、という前提で扱う。
 * 「ページは見えるが決済で弾かれる」状態のリンクを踏ませると、
 * クリックだけ発生して成果はゼロになる（費用だけかかって収益が出ない）。
 * 国別のAllowed列を人間が確認して埋めるまで使わせない。
 */
const B_GEO_SENSITIVE_PLATFORMS = { 'FANZA': true };

function normalizePlatform_(name) {
  return String(name || '').trim().toUpperCase();
}

/** URLからホスト名を取り出す。GASにURLパーサが無いので自前で切る。 */
function urlHost_(url) {
  const m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 実際に投稿へ載せるURL。AffiliateURLがあればそれを使う。
 *
 * ★検証も生成も投稿もこの1つの値を見る。
 * 「検証したURL」と「投稿したURL」がズレると、
 * ホスト一致チェックを通り抜けて別ドメインへ誘導できてしまう。
 */
/**
 * 投稿に載せるURLを返す。
 *
 * ★ここが全経路（通常投稿・Bファネル・引用・情報源反応）の合流点なので、
 * クリック計測用URLへの差し替えもここ1箇所で行う。
 * 計測が使えない場合は buildTrackedUrl_ が素のURLを返すため、
 * この関数の従来の振る舞いは変わらない。
 */
function linkPostUrl_(link) {
  if (!link) return '';
  const raw = String(link.affiliateUrl || link.url || '').trim();
  if (!raw) return '';
  return buildTrackedUrl_(link.target || link.account || '', raw);
}

/** ホストが許可リストのいずれか（サブドメイン含む）に一致するか。 */
function hostMatchesAny_(host, hosts) {
  return (hosts || []).some(function (h) {
    return host === h || host.slice(-(h.length + 1)) === '.' + h;
  });
}

/**
 * リンク1件の「形」を検証する。規約の可否はここでは見ない（→ validateAffiliateLink_）。
 *
 * ★ここを通らないリンクでは投稿を作らない（指示書 §5）。
 * URLとNoteの内容が食い違ったまま投稿すると、
 * 「説明と行き先が違う」投稿になり、規約以前に読者の信用を失う。
 *
 * @return {{ok:boolean, reason:string}}
 */
function validateBLink_(link) {
  if (!link || !link.url) return { ok: false, reason: 'URLが空です。' };

  if (!/^https:\/\//i.test(link.url)) {
    return { ok: false, reason: 'httpsではありません: ' + link.url };
  }

  const platform = normalizePlatform_(link.platform);
  if (!platform) {
    return { ok: false, reason: 'Platform列が空です（DLsite / Fantia / DiGiket のいずれかを入れてください）。' };
  }

  const hosts = platformHosts_(platform);
  if (!hosts) {
    return { ok: false, reason: '未対応のPlatformです: ' + link.platform +
                                '（対応: ' + Object.keys(B_PLATFORM_HOSTS)
                                  .concat(Object.keys(A_PLATFORM_HOSTS)).join(' / ') + '）' };
  }

  // GENERIC はホストを縛らない（メーカー公式等）。検証列で人間が担保する。
  if (!hosts.length) {
    if (!link.note) return { ok: false, reason: 'Note列が空です。' };
    if (!link.category) return { ok: false, reason: 'Category列が空です。' };
    return { ok: true, reason: '' };
  }

  // ★宣言されたPlatformとURLの実際の行き先が一致しているか
  const host = urlHost_(link.url);
  if (!hostMatchesAny_(host, hosts)) {
    return {
      ok: false,
      reason: 'LINK_MISMATCH: Platform=' + link.platform + ' に対して URL のホストが ' +
              (host || '(不明)') + ' です。'
    };
  }

  // ★実際に投稿に載るURL（AffiliateURL優先）も同じ検査にかける。
  // ここを見ないと、URL列だけ正しくしてAffiliateURL列に別ドメインを入れれば
  // ホスト一致チェックをすり抜けられてしまう。
  const postUrl = linkPostUrl_(link);
  if (!/^https:\/\//i.test(postUrl)) {
    return { ok: false, reason: 'AffiliateURLがhttpsではありません: ' + postUrl };
  }
  const postHost = urlHost_(postUrl);
  if (!hostMatchesAny_(postHost, hosts)) {
    return {
      ok: false,
      reason: 'LINK_MISMATCH: Platform=' + link.platform + ' に対して AffiliateURL のホストが ' +
              (postHost || '(不明)') + ' です。別ドメインの計測リンクを使う場合は ' +
              'B_PLATFORM_HOSTS に明示的に追加してください。'
    };
  }

  if (!link.note) {
    return { ok: false, reason: 'Note列が空です。何のリンクか分からないと投稿を書けません。' };
  }
  if (!link.category) {
    return { ok: false, reason: 'Category列が空です（doujin / voice / ASMR など）。' };
  }

  return { ok: true, reason: '' };
}

/* ------------------------------------------------------------------ */
/* 規約ゲート（指示書 §23）                                             */
/* ------------------------------------------------------------------ */

/** 日付らしき値をDateにする。読めなければ null。 */
function parseVerificationDate_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : v;
  }
  const s = String(v).trim();
  if (!s) return null;
  // YYYY-MM-DD / YYYY/MM/DD を想定。GASのロケール差を避けて自前で解釈する。
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

/** 確認から何日経ったか。読めない場合は null。 */
function verificationAgeDays_(link) {
  const d = parseVerificationDate_(link && link.verificationDate);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/**
 * このリンクを「今この地域向けの投稿」に貼ってよいかを判定する。
 *
 * ★投稿直前に必ず通す最後の関門（指示書 §23）。
 * ここが false を返したらリンクを貼らない。例外は作らない。
 *
 * 判定材料はすべてLinksシートの列であり、人間が一次情報を確認して
 * 手で入れた値だけを信用する。AIもこのコードもTRUEを書き込まない。
 * 未入力は全て false 側に倒れる（listLinkCandidates_ の boolCell）。
 *
 * @param {Object} link   listLinkCandidates_ が返す1行
 * @param {string} region 'US' | 'CA' | 'UK' | 'AU'
 * @return {{ok:boolean, reason:string, code:string}}
 */
function validateAffiliateLink_(link, region, accountKey) {
  const ng = function (code, reason) { return { ok: false, code: code, reason: reason }; };

  // 1. 形（URL・Platform一致・Note・Category）
  const shape = validateBLink_(link);
  if (!shape.ok) return ng('SHAPE', shape.reason);

  // 1-B. アカウントと商材の取り違えを塞ぐ。
  // Aの技術アカウントに成人向けリンクが出ることは絶対に許さない（逆も同じ）。
  const acct = String(accountKey || '').toUpperCase();
  if (acct && ACCOUNT_PLATFORMS[acct]) {
    if (ACCOUNT_PLATFORMS[acct].indexOf(normalizePlatform_(link.platform)) === -1) {
      return ng('WRONG_ACCOUNT',
        normalizePlatform_(link.platform) + ' は ' + acct + ' で使えるプラットフォームではありません。');
    }
  }

  // 2. ステータス。ACTIVE 以外は一切使わない
  const status = String(link.status || 'UNVERIFIED').toUpperCase();
  if (status !== 'ACTIVE') {
    return ng('STATUS', 'Status=' + status + ' です（ACTIVE以外は使いません）。');
  }

  // 3. 旧Active列でも無効にできる（緊急停止用の二重装置）
  if (link.active === false) return ng('INACTIVE', 'Active列がFALSEです。');

  // 4. 人間による一次情報の確認印
  if (!link.verified) {
    return ng('UNVERIFIED', 'Verified列がTRUEではありません（一次情報の確認が必要）。');
  }

  // 5. 確認の鮮度。規約は改定されるので、古い確認は無効扱いにする
  const age = verificationAgeDays_(link);
  if (age === null) {
    return ng('NO_DATE', 'VerificationDate列が空か日付として読めません。' +
                         'いつ確認したか分からない確認は使えません。');
  }
  if (age > LINKS_VERIFICATION_MAX_AGE_DAYS) {
    return ng('EXPIRED', '確認から' + age + '日経過しています（上限' +
                         LINKS_VERIFICATION_MAX_AGE_DAYS + '日）。規約を確認し直してください。');
  }

  // 6. 5つの許可フラグ。1つでも欠けたら貼らない
  const gates = [
    ['affiliateAllowed',  'AffiliateAllowed'],
    ['snsAllowed',        'SNSAllowed'],
    ['xAllowed',          'XAllowed'],
    ['automationAllowed', 'AutomationAllowed'],
    ['overseasAllowed',   'OverseasAllowed']
  ];
  for (let i = 0; i < gates.length; i++) {
    if (!link[gates[i][0]]) {
      return ng('NOT_ALLOWED', gates[i][1] + '列がTRUEではありません。');
    }
  }

  // 7. 対象国。その地域向けの投稿にその国の許可が無いリンクは貼らない
  const rg = String(region || '').toUpperCase();
  const platformKey = normalizePlatform_(link.platform);
  if (rg) {
    const allowed = link.countryAllowed || {};
    const has = Object.prototype.hasOwnProperty.call(allowed, rg);

    if (has && !allowed[rg]) {
      return ng('COUNTRY', rg + 'Allowed列がTRUEではありません（この地域向けの投稿には使えません）。');
    }
    // ★海外購入に制限があるプラットフォームは、列が空なら「不明」ではなく「不可」。
    // 買えない商品にクリックを送ると、費用だけ出て成果が出ない。
    if (!has && B_GEO_SENSITIVE_PLATFORMS[platformKey]) {
      return ng('COUNTRY', platformKey + ' は作品ごとに海外購入の可否が変わるため、' +
                           rg + 'Allowed列の確認が必須です。');
    }
  }

  // 8. 人間が手で止めたクールダウン
  const cd = parseVerificationDate_(link.cooldownUntil);
  if (cd && cd.getTime() > Date.now()) {
    return ng('COOLDOWN', 'CooldownUntil=' + link.cooldownUntil + ' のため休止中です。');
  }

  // 9. 開示が必要なのに文言が無い、は設定ミス。黙って無表記で出さない
  if (link.disclosureRequired && !requiredDisclosureFor_(rg, link)) {
    return ng('NO_DISCLOSURE', 'DisclosureRequired=TRUE ですが開示文言を決められません。' +
                               'DisclosureText列を埋めてください。');
  }

  return { ok: true, code: '', reason: '' };
}

/* ------------------------------------------------------------------ */
/* アフィリエイト開示（指示書 §19）                                      */
/* ------------------------------------------------------------------ */

/**
 * 地域ごとの開示要件。
 *
 * 【この値の根拠と限界】
 * 4地域とも「"affiliate" 単独では不十分」「投稿の冒頭・目立つ位置」で
 * 各当局のガイダンスが一致している、という調査結果に基づく。
 * ただし一次情報（FTC/ASA/Ad Standards/ACCC の原文）はこの環境から
 * 参照できていない。2026-08-15にオーナー判断で「#ad を付ける条件で実装」と決定。
 *
 * 全地域を #ad で統一しているのは、4つのうち最も厳しい要求
 * （UK ASA：冒頭・省略されない位置に #ad）に合わせておけば
 * 他の3地域も満たせるため。地域ごとに変えたくなった時のために
 * テーブルの形にしてある。
 *
 * position は 'start' のみ対応。末尾開示は「読む前にクリックされる」ため採らない。
 */
const REGION_DISCLOSURE_RULES = {
  'US': { tag: '#ad', position: 'start' },
  'CA': { tag: '#ad', position: 'start' },
  'UK': { tag: '#ad', position: 'start' },
  'AU': { tag: '#ad', position: 'start' }
};

/** どの地域にも当てはまらない場合の既定。安全側＝付ける。 */
const DISCLOSURE_DEFAULT_TAG = '#ad';

/**
 * この投稿に付ける開示文言を決める。付けない場合は空文字。
 *
 * 優先順位：Linksシートの DisclosureText → 地域ルール → 既定(#ad)
 * リンクが無い投稿には開示を付けない（開示すべき取引が無いため）。
 */
function requiredDisclosureFor_(region, link) {
  if (!link) return '';
  const custom = String((link && link.disclosureText) || '').trim();
  if (custom) return custom;
  const rule = REGION_DISCLOSURE_RULES[String(region || '').toUpperCase()];
  return (rule && rule.tag) || DISCLOSURE_DEFAULT_TAG;
}

/**
 * LLMが勝手に書いた開示っぽいタグを取り除く。
 *
 * ★開示はこちらで機械的に付ける。LLMに任せると、
 * 付いたり付かなかったり、末尾に埋もれたりして要件を満たせない。
 * 二重に付くのも避けたいので、いったん全部剥がしてから1つだけ足す。
 */
function stripDisclosureTags_(text) {
  return String(text || '')
    .replace(/(^|\s)#(ad|ads|advert|advertisement|sponsored|affiliate|pr)\b/gi, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '')
    .trim();
}

/**
 * 開示タグを本文の先頭に1つだけ付ける。
 * 既に先頭にあるならそのまま返す。
 */
function applyDisclosure_(text, tag) {
  const t = String(text || '').trim();
  if (!tag) return t;
  const cleaned = stripDisclosureTags_(t);
  if (!cleaned) return t;
  return tag + ' ' + cleaned;
}

/**
 * この投稿タイプに使うリンクを選ぶ。
 *
 * 均等配分しない（指示書 §7）。以下の順で絞り込む。
 *   1. 有効(Active)で、検証を通っているもの
 *   2. 直近10投稿で使っていないURL
 *   3. 直前と同じPlatformでないもの
 *   4. Priorityが高いもの
 *
 * 条件を満たすものが無い場合は段階的に緩める。
 * 完全に無ければ null を返し、呼び出し側はリンク無しのタイプへ切り替える。
 *
 * @return {?Object} Linksシートの1行
 */
function pickBLink_(candidates, region) {
  const usable = [];
  const rejected = [];

  (candidates || []).forEach(function (c) {
    // ★規約ゲートを通ったものだけが候補になる。
    // 「形は正しいが未確認」のリンクはここで落ちるため、
    // 確認済みリンクが1本も無い間はリンク付き投稿が発生しない。
    const v = validateAffiliateLink_(c, region, 'B');
    if (v.ok) usable.push(c);
    else rejected.push({ link: c, reason: v.reason });
  });

  // 検証に落ちたものは黙って捨てない。設定ミスに気づけなくなる。
  if (rejected.length) {
    rejected.forEach(function (r) {
      console.warn('リンクを除外: ' + r.reason + ' (' + truncate_(r.link.url || '', 60) + ')');
    });
  }

  if (!usable.length) return null;

  const history = readBHistory_();
  const recentUrls = history.slice(0, B_URL_COOLDOWN)
    .map(function (h) { return h.u; }).filter(String);

  // 直前に販売投稿で使ったPlatform
  let lastPlatform = '';
  for (let i = 0; i < history.length; i++) {
    if (history[i].p) { lastPlatform = normalizePlatform_(history[i].p); break; }
  }

  // 1: URLクールダウン
  let pool = usable.filter(function (c) { return recentUrls.indexOf(c.url) === -1; });
  if (!pool.length) pool = usable;   // 登録が1本しか無い等。指示書 §11 の例外

  // 2: 同一Platformの連続を避ける
  const diffPlatform = pool.filter(function (c) {
    return normalizePlatform_(c.platform) !== lastPlatform;
  });
  if (diffPlatform.length) pool = diffPlatform;

  // 3: Priority（大きいほど優先）。同点はランダム
  let top = 0;
  pool.forEach(function (c) { top = Math.max(top, Number(c.priority) || 0); });
  const best = pool.filter(function (c) { return (Number(c.priority) || 0) === top; });

  return best[Math.floor(Math.random() * best.length)];
}

/* ------------------------------------------------------------------ */
/* プロンプトへ渡す材料                                                 */
/* ------------------------------------------------------------------ */

/**
 * リンク情報をLLMへ渡す形に整える。
 *
 * ★URLだけ渡さない。何の商品・カテゴリなのかを必ず添える（指示書 §4）。
 * これが無いとLLMは行き先を知らないまま書くことになり、
 * 内容と行き先がずれた投稿か、当たり障りのない紹介文にしかならない。
 */
function buildBLinkFacts_(link) {
  if (!link) return '';

  const platform = B_PLATFORM_LABEL[normalizePlatform_(link.platform)] || link.platform;
  const lines = [
    'The link in this post goes to:',
    '- Platform: ' + platform,
    '- Category: ' + link.category,
    '- What it is: ' + link.note
  ];
  if (link.productType) lines.push('- Type: ' + link.productType);
  lines.push('- URL (use this exact string, never modify it): ' + (link.affiliateUrl || link.url));
  lines.push('');
  lines.push('Write only about what is stated above.');
  lines.push('Do not invent a title, a creator name, a price, a discount, a rating, ' +
             'a review, a ranking, or a sales figure. You do not have that information.');
  // 開示タグはコード側で先頭に付ける。ここで書かせると位置も有無も安定しない。
  lines.push('Do not write #ad, #sponsored, or any disclosure tag yourself. ' +
             'It is added automatically at the start of the post.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 状態表示                                                             */
/* ------------------------------------------------------------------ */

/** 実際の配分が目標にどれだけ寄っているかを見る。 */
function buildBFunnelStatusText_() {
  const history = readBHistory_().slice(0, B_HISTORY_WINDOW);
  if (!history.length) return '\n【Bファネル】まだ実績がありません';

  const counts = {};
  B_POST_TYPES.forEach(function (t) { counts[t.key] = 0; });
  history.forEach(function (h) { if (counts[h.t] !== undefined) counts[h.t]++; });

  const total = history.length;
  const lines = ['\n【Bファネル】直近' + total + '本の配分（目標との差）'];

  B_POST_TYPES.forEach(function (t) {
    const actual = counts[t.key];
    const pct = Math.round(actual / total * 100);
    const gap = pct - t.weight;
    lines.push('  ' + t.key + ': ' + actual + '本 ' + pct + '%' +
               '（目標' + t.weight + '% ' + (gap >= 0 ? '+' : '') + gap + '）');
  });

  const salesKeys = {};
  B_POST_TYPES.forEach(function (t) { if (t.sales) salesKeys[t.key] = true; });
  const salesPosts = history.filter(function (h) { return salesKeys[h.t]; }).length;
  lines.push('  販売系: ' + salesPosts + '本 ' + Math.round(salesPosts / total * 100) +
             '%（目標' + B_SALES_TARGET_PCT + '%）');

  // 実際にURLが載った本数。確認済みリンクが無ければ設計上の上限より下がる。
  const withUrl = history.filter(function (h) { return !!h.u; }).length;
  lines.push('  実リンク付き: ' + withUrl + '本 ' + Math.round(withUrl / total * 100) +
             '%（設計上の上限' + B_LINK_TARGET_PCT + '%）');

  return lines.join('\n');
}

/** エディタから配分を確認する。 */
function showBFunnelStatus() {
  console.log(buildBFunnelStatusText_());
}

/** 配分をやり直したいときに履歴を消す。投稿自体には影響しない。 */
function resetBFunnelHistory() {
  props_().deleteProperty(B_HISTORY_PROP);
  console.log('Bのファネル履歴をリセットしました。次回から配分を最初から数え直します。');
}

/* ------------------------------------------------------------------ */
/* B専用の生成                                                          */
/* ------------------------------------------------------------------ */

/**
 * Bの投稿を1本作る。
 *
 * 通常の generateTweet と分けている理由：
 * Aは「訴求角度 × 文章の型」をランダムに振って母数を稼ぐ設計だが、
 * Bは「ファネル上のどの段階の投稿か」で内容も、リンクの有無も、
 * 使う販売先も決まる。同じ抽選器に載せると比率が守れない。
 *
 * @param {Object} acc        アカウント定義
 * @param {string} accountKey 'B'
 * @param {?Object} linkObj   呼び出し側が選んだリンク（Bでは使わず選び直す）
 * @param {string} topicHint  Queueの{AUTO}に続けて書かれたお題（任意）
 * @param {string} region     対象地域
 */
function generateTweetForB_(acc, accountKey, linkObj, topicHint, region) {
  // --- 使えるリンクを集める -------------------------------------------
  // 呼び出し側が渡してくるリンクは「Nに1回」のカウンタで選ばれたもので、
  // ファネルの都合を知らない。Bでは自前で選び直す。
  let candidates = [];
  try {
    const sheet = getOrCreateLinksSheet_();
    candidates = listLinkCandidates_(sheet, 'B');
  } catch (e) {
    console.warn('Linksシートを読めませんでした（リンク無しで続行）: ' + e);
  }

  const chosenLink = pickBLink_(candidates, region);
  const linkAvailable = !!chosenLink;

  // --- 投稿タイプを決める ---------------------------------------------
  let postType = pickBPostType_(linkAvailable);
  let link = bTypeUsesLink_(postType) ? chosenLink : null;

  // リンクを使うタイプなのにリンクが無い＝設定不足。
  // 無理に売ろうとせず、価値提供側へ倒す。
  if (bTypeUsesLink_(postType) && !link) {
    console.warn('リンクが無いため ' + postType + ' → DISCOVERY へ切り替えます。');
    postType = 'DISCOVERY';
  }

  // --- 材料をそろえる --------------------------------------------------
  const facts = [];
  if (topicHint) facts.push(topicHint);
  if (link) facts.push(buildBLinkFacts_(link));

  // お題もリンクも無い回は、話題の在庫から1つ渡す（白紙で書かせない）
  const topics = getTopics_('B');
  const subject = facts.length ? '' : (topics.length ? pickRandom_(topics) : '');

  const format = pickRandom_(getFormats_('B'));
  const maxLen = getTweetMaxLen_('B');

  // --- 開示タグ（指示書 §19）------------------------------------------
  // リンクを貼る回だけ、本文の先頭に機械的に付ける。
  // ★先に文字数を確保しておく。後から足すと上限を超える。
  const disclosureTag = link ? requiredDisclosureFor_(region, link) : '';
  const disclosureCost = disclosureTag
    ? estimateWeightedLength_(disclosureTag + ' ')
    : 0;
  // 固定CTA（22_FixedCta.gs）の分も同じ理由で先に確保する。
  // リンク付きの回はCTAを付けない設計なので、その場合は確保しない。
  const ctaCost = link ? 0 : fixedCtaReserve_('B');
  const bodyMaxLen = maxLen - disclosureCost - ctaCost;

  // 投稿に載せるURLはこの1つに固定する（AffiliateURL優先）
  const postUrl = link ? linkPostUrl_(link) : '';

  // ★実際に測る長さ（開示タグとCTAを引いた後）で書かせる。A側と同じ理由。
  const systemPrompt = buildSystemPrompt_('B', region, postType, link, format, bodyMaxLen);

  const genStartedAt = Date.now();
  /*
   * ★次に直させる土台。
   *
   * 品質で落ちた時は「これまでで一番点が高かった案」を土台にする。
   * リンクの扱いや長さで落ちた時は、その場の案を直させる（そこを直せば済むため）。
   * 毎回まっさらに書き直させると、良い案を捨てて悪い案を引き直すことになる。
   */
  let draft = '';
  let critique = '';
  let best = null;
  /*
   * ★冒頭だけ差し替えた案。次の回は生成せずこれを評価する。
   * Aと同じ仕組み（07_AIGenerator.gs）。今まではBだけ入っていなかった。
   */
  let pendingDraft = '';
  /*
   * ★ループの外で組み立てる。
   * 冒頭差し替えの経路がループ先頭にあるので、ループ内で宣言すると
   * 初期化前アクセスになる（Aの buildResult で実際に踏んだ）。
   */
  const finishRef = function (t, score) {
    // 履歴は「実際に出した」ものだけを数える。ここで記録すると
    // 投稿に失敗した分まで配分に混ざるため、記録は呼び出し側で行う。
    return {
      text: applyDisclosure_(t, disclosureTag),
      region: region,
      angle: postType,
      format: format,
      model: getProp_('LLM_MODEL', LLM_DEFAULT_MODEL),
      genSeconds: Math.round((Date.now() - genStartedAt) / 100) / 10,
      role: postType,
      qualityScore: score,
      postType: postType,
      platform: link ? (B_PLATFORM_LABEL[normalizePlatform_(link.platform)] || link.platform) : '',
      category: link ? link.category : '',
      linkUrl: postUrl,
      linkRow: link ? link.row : '',
      disclosure: disclosureTag
    };
  };

  for (let attempt = 1; attempt <= llmMaxAttempts_(); attempt++) {
    // 冒頭だけ差し替えた案が控えているなら、生成せずそれを評価する
    if (pendingDraft) {
      const draftText = pendingDraft;
      pendingDraft = '';
      const dv = evaluatePost_('B', draftText, postType);
      if (dv.ok) {
        console.log('B: 冒頭の差し替えで通過 (' + dv.score + '点)');
        resetWeakPostStreak_('B');
        return finishRef(draftText, dv.score);
      }
      if (nextActionFor_(dv).keepAsCandidate && (!best || dv.score > best.score)) {
        best = { text: draftText, score: dv.score };
      }
      draft = draftText;
      critique = dv.critique;
      continue;
    }

    const userPrompt = buildUserPrompt_(acc, facts.join('\n\n'), link, region, postType,
                                        format, attempt, draft, subject, critique, bodyMaxLen);

    let raw;
    try {
      raw = callLLM_(systemPrompt, userPrompt);
    } catch (err) {
      // 安全フィルタは「その題材が通らなかった」だけ。
      // Bは題材の幅が広いので、別の話題へ振り直せばたいてい通る。
      if (isSafetyBlock_(err) && attempt < llmMaxAttempts_()) {
        console.warn('安全フィルタで拒否されたため題材を変更します。');
        draft = '';
        best = null;
        critique = 'The previous subject was rejected by the safety filter. ' +
                   'Choose a different, less explicit angle on Japanese creator culture.';
        continue;
      }
      throw err;
    }

    const rawText = sanitizeGeneratedText_(raw);
    if (!rawText) throw new Error('LLMが空の本文を返しました。');

    // --- 文字数 --------------------------------------------------------
    // ★開示タグの分を引いた長さで測る。最後に先頭へ足すため。
    // ★長さだけの理由で丸ごと捨てない。末尾を落として収まるなら収める（A側と同じ）。
    let text = rawText;
    const weighted = estimateWeightedLength_(text);
    if (weighted > bodyMaxLen) {
      const trimmed = trimToLimit_(text, bodyMaxLen);
      if (trimmed) {
        console.log('B: 末尾を削って収めた (' + weighted + ' → ' +
                    estimateWeightedLength_(trimmed) + '/' + bodyMaxLen + ')');
        text = trimmed;
      } else {
        draft = best ? best.text : text;
        critique = 'It was ' + weighted + ' characters against a hard limit of ' +
                   bodyMaxLen + '. Remove one whole idea, not a few words.';
        continue;
      }
    }

    // --- リンクの取り違え防止 -------------------------------------------
    // ★ここは「捏造URLを絶対に投稿しない」ことが最優先。
    // ただし却下し続けて例外にすると、その投稿枠が丸ごと失われる。
    // 機械的に直せるものは直し、直せないものだけ再生成に回す。
    let finalText = text;

    if (!link) {
      // リンクを渡していないのにURLを書いた場合。
      // 何を書いたにせよ、こちらが知らないURLなので必ず取り除く。
      if (/https?:\/\//i.test(finalText)) {
        const stripped = stripUrls_(finalText);
        if (stripped.length >= 40) {
          console.warn('リンク未指定の投稿からURLを除去しました。');
          finalText = stripped;
        } else {
          // 取り除くと文章として成立しない＝URL前提で書かれている。作り直す。
          draft = text;
          critique = 'You included a URL, but no link was given for this post. ' +
                     'Never invent a URL. Write the post with no link at all.';
          console.warn('リンク未指定なのにURL前提の文章だったため再生成');
          continue;
        }
      }
    } else {
      const usage = checkBLinkUsage_(finalText, postUrl);
      if (!usage.ok) {
        // まだ試行が残っていれば、理由を返して書き直させる（文脈に馴染む形が望ましい）
        if (attempt < llmMaxAttempts_()) {
          draft = text;
          critique = usage.reason;
          console.warn('リンクの扱いが不正なため再生成: ' + usage.reason);
          continue;
        }
        // 最終試行でも直らない場合だけ、機械的に貼り直す。
        // 体裁は落ちるが、間違ったURLを出すことも投稿を失うことも避けられる。
        const repaired = (stripUrls_(finalText) + '\n\n' + postUrl).trim();
        if (estimateWeightedLength_(repaired) <= bodyMaxLen) {
          console.warn('最終試行のためURLを機械的に貼り直しました。');
          finalText = repaired;
        } else {
          draft = text;
          critique = usage.reason;
          continue;
        }
      }
    }

    // --- 品質 ----------------------------------------------------------
    // ★開示タグを付ける前に採点する。Bはハッシュタグ禁止なので、
    // 先に付けると自分で付けた #ad で不合格になる。
    const verdict = evaluatePost_('B', finalText, postType);
    if (verdict.ok) {
      console.log('B品質OK (' + verdict.score + '点) ' + postType + ' attempt=' + attempt);
      resetWeakPostStreak_('B');
      return finishRef(finalText, verdict.score);
    }

    // 保険として控えるのは、URLの整合が取れている finalText の方。
    // ★採否のルールはA/B共通（16_Quality.gs nextActionFor_）。
    const next = nextActionFor_(verdict);
    if (next.keepAsCandidate && (!best || verdict.score > best.score)) {
      best = { text: finalText, score: verdict.score };
    }
    // 点が上がった案だけを土台に持ち越す（下がった案を直すと悪化していく）
    draft = best ? best.text : finalText;
    critique = verdict.critique;
    console.warn('B品質不足 (' + verdict.score + '点) attempt=' + attempt);

    // 冒頭だけが原因なら、そこだけ差し替える（Aと同じ）
    if (next.tryHookRepair) {
      const repaired = repairHook_('B', finalText, verdict.fix || verdict.critique,
                                   bodyMaxLen);
      if (repaired && estimateWeightedLength_(repaired) <= bodyMaxLen) {
        pendingDraft = repaired;
      }
    }
  }

  /*
   * ★2026-08-18、A側と同じくオーナー判断で相対評価へ変更。
   * 絶対評価(70点で合否)ではなく、候補の中で一番点が高いものを出す。
   * ここまで来た案はローカル判定を通っている（捏造・禁止表現・
   * 実在個人への言及・URLの取り違えは既に落ちている）。
   */
  // 採否のルールはA/B共通（16_Quality.gs acceptBestCandidate_）
  return acceptBestCandidate_('B', best, [], finishRef);
}

/**
 * 本文からURLを全て取り除き、余った空白を整える。
 * 「知らないURLは絶対に出さない」を機械的に保証するために使う。
 */
function stripUrls_(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * 生成文が、渡したURLを正しく1つだけ使っているかを見る。
 *
 * AIに勝手なURLを作らせないための最後の関門（指示書 §5）。
 * 「それらしい別のURL」を書かれると、読者を無関係な場所へ送ることになる。
 *
 * @return {{ok:boolean, reason:string}}
 */
function checkBLinkUsage_(text, expectedUrl) {
  const found = String(text || '').match(/https?:\/\/\S+/g) || [];

  if (!found.length) {
    return { ok: false, reason: 'The given URL is missing. Include it exactly once, at the end.' };
  }
  if (found.length > 1) {
    return { ok: false, reason: 'You included ' + found.length + ' URLs. Include only the one given.' };
  }

  // 末尾の句読点は本文側の都合なので落としてから比べる
  const actual = found[0].replace(/[.,)\]】。、]+$/, '');
  if (actual !== expectedUrl) {
    return {
      ok: false,
      reason: 'You changed the URL. Given: ' + expectedUrl + ' / You wrote: ' + actual +
              '. Use the given URL character for character.'
    };
  }
  return { ok: true, reason: '' };
}
