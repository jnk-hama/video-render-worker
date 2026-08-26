/**
 * ===========================================================================
 * 07_AIGenerator.gs  —  投稿文の動的生成（A/Bテスト対応）
 * ===========================================================================
 * Queueシートの Content 列に {AUTO} が含まれる行は、LLMで本文を生成して投稿する。
 * 生成のたびに「対象地域」と「訴求角度」をランダムに選び、結果と一緒に返す。
 * どの組み合わせが伸びたかは Log シートに蓄積されるので、後から比較できる。
 *
 * 【使用API】Google Gemini (Generative Language API)
 * 他社へ乗り換える場合も callLLM_() 1つを差し替えればよい。
 * 呼び出し側はプロバイダに依存しない作りにしてある。
 *
 * 【プロンプトはコードに固定しない】
 * ペルソナや訴求方針は運用しながら毎日いじるものなので、スクリプトプロパティに置く。
 * 設定すれば、このファイル内の既定値は一切使われない（再デプロイ不要で反映される）。
 *
 * 【必要なスクリプトプロパティ】
 *   GEMINI_API_KEY / LLM_API_KEY … Gemini APIキー（どちらの名前でも可。必須）
 *   LLM_MODEL      … モデル名（任意。既定 gemini-3.5-flash）
 *                    ★モデル名は改廃が早い。404が出たらここに現行の名前を入れる
 *   LLM_PROMPT_A   … A用system prompt（任意。未設定なら既定値）
 *   LLM_PROMPT_B   … B用system prompt（任意。未設定なら既定値）
 *   LLM_ANGLES_A   … A用の訴求角度（任意。カンマ区切り。未設定なら既定値）
 *   LLM_ANGLES_B   … B用の訴求角度（任意。カンマ区切り。未設定なら既定値）
 *   LLM_REGIONS    … 対象地域（任意。カンマ区切り。未設定なら US,CA,UK,AU）
 */

const LLM_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// -latest 等の自動更新エイリアスは使わない。
// 実体が別モデルへ差し替わると、こちらが何も変更していないのに突然壊れるため。
//
// ただしモデルの改廃自体は早く、固定名もいずれ404になる。
// そのため 404 を検知したら discoverWorkingModel_() で現行モデルを自動探索し、
// LLM_MODEL に保存して再試行する（下記 callLLM_ 参照）。
// 「勝手に別モデルへ乗り換わる」ことは無く、壊れた時だけ復旧する挙動にしている。
const LLM_DEFAULT_MODEL = 'gemini-3.6-flash';

const LLM_TEMPERATURE = 0.85;     // 母数は稼ぎたいが、高すぎると文が途中で崩れる

/**
 * 出力トークンの上限。
 *
 * ★400にしていたのが、投稿が毎回途中で切れていた原因。
 * gemini-3.x-flash は思考モデルで、思考にもこの枠を使う。
 * 400では思考だけで枠を使い切り、本文が数十文字の断片になって返ってきていた。
 * （CLAUDE.md の E-006 と同じ罠。当時はMake側で踏んでいる）
 *
 * 280字の投稿に必要なのは100トークン程度だが、
 * 思考ぶんの余裕を含めて大きく取る。上限は課金されるわけではなく、
 * 「ここまで使ってよい」という枠なので、大きくしても無駄にはならない。
 */
const LLM_MAX_TOKENS = 2048;
const LLM_MAX_ATTEMPTS = 2;       // 文字数オーバー時の再生成を含めた試行回数

const AUTO_TAG = '{AUTO}';

/* ------------------------------------------------------------------ */
/* A/Bテストの変数                                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_REGIONS = ['US', 'CA', 'UK', 'AU'];

/**
 * 現在のJST時刻から、その時間帯にピークを迎える地域を選ぶ。
 *   JST 08:00-14:00 … US / CA のピーク → どちらかをランダム
 *   JST 15:00-23:00 … AU のピーク
 *   JST 00:00-07:00 … UK のピーク
 * スクリプトのタイムゾーン設定に依存しないよう、明示的に Asia/Tokyo で時刻を取る。
 * LLM_REGIONS を設定した場合は、時間帯を無視してその中からランダムに選ぶ。
 */
function pickRegionByJstHour_() {
  const override = getProp_('LLM_REGIONS');
  if (override) return pickRandom_(getRegions_());

  const hour = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'H'));

  if (hour >= 8 && hour <= 14) return pickRandom_(['US', 'CA']);
  if (hour >= 15 && hour <= 23) return 'AU';
  return 'UK';   // 0〜7時
}

// フォロワー獲得は「宣伝の巧さ」より「毎回何か持ち帰れること」で決まるため、
// 訴求角度も価値提供側に寄せている。Bは宣伝一辺倒にせず素の投稿を混ぜる。
// 価値提供の角度（リンク無しの回に使う）。フォロワーを増やす役割。
const DEFAULT_ANGLES_A = ['Contrarian', 'Cheat Code', 'Teardown', 'Mistake', 'Tool', 'GitHub'];
const DEFAULT_ANGLES_B = ['Slice of life', 'Mood', 'Teaser', 'Reply bait'];

/**
 * 販売の角度（リンクを貼る回に使う）。
 *
 * 価値提供の角度のままリンクだけ足すと、無料ツールを紹介した直後に
 * 有料商材のURLが出る形になり、脈絡が無く売れない。
 * リンクを貼る回は、最初から「その商品を必要とする人」に向けて書く。
 */
const DEFAULT_OFFER_ANGLES_A = ['Bridge', 'Cost of DIY', 'Who it is for'];
const DEFAULT_OFFER_ANGLES_B = ['Direct', 'Teaser'];

function getOfferAngles_(accountKey) {
  const key = String(accountKey).toUpperCase();
  return key === 'B'
    ? getListProp_('LLM_OFFER_ANGLES_B', DEFAULT_OFFER_ANGLES_B)
    : getListProp_('LLM_OFFER_ANGLES_A', DEFAULT_OFFER_ANGLES_A);
}

/**
 * 地域ごとの文体指示（B＝素の人格アカウント用）。
 * 「スラングを使え」だけだと出てこないので、実際の語を並べて選ばせる。
 * ただし詰め込むと不自然になるため、1〜2語までに制限している。
 */
const REGION_STYLE_CASUAL = {
  US: 'American English. Work in one or two of: fr, ngl, tbh, lowkey, deadass, no cap, kinda, gonna. ' +
      'One or two only. Stuffing slang reads fake.',
  CA: 'Canadian English. Work in one or two of: fr, ngl, tbh, lowkey, eh, hey. American spelling. ' +
      'One or two only.',
  UK: 'British English and British spelling (realise, colour, favourite). Work in one or two of: ' +
      'mate, innit, proper, knackered, cba, bare, sound. One or two only.',
  AU: 'Australian English. Work in one or two of: arvo, keen, reckon, heaps, maccas, servo, mate, stoked. ' +
      'One or two only.'
};

/**
 * 地域ごとの文体指示（A＝専門性で読ませるアカウント用）。
 *
 * ★Aにスラングを混ぜてはいけない。
 * 技術・マーケティングの知見で信頼を取りにいくアカウントが
 * "deadass" "no cap" "innit" と書いた瞬間に、書き手の格が落ちて
 * 内容の正しさまで疑われる。地域差は綴りと語彙だけに留め、
 * 「その地域の人が読んで違和感がない」水準を狙う。
 */
const REGION_STYLE_PRO = {
  US: 'American English and American spelling (optimize, analyze, behavior). ' +
      'Plain professional register. No slang.',
  CA: 'Canadian English. American spelling in tech contexts. ' +
      'Plain professional register. No slang.',
  UK: 'British English and British spelling (realise, optimise, behaviour, colour). ' +
      'Plain professional register. No slang.',
  AU: 'Australian English and British spelling (realise, optimise, behaviour). ' +
      'Plain professional register, slightly more direct than UK. No slang.'
};

/** アカウントの性格に合った地域文体を返す。 */
function regionStyleFor_(accountKey, region) {
  const table = String(accountKey).toUpperCase() === 'B' ? REGION_STYLE_CASUAL : REGION_STYLE_PRO;
  return table[region] || ('Write in natural English for ' + region + '. No slang.');
}

/** 訴求角度ごとの指示 */
const ANGLE_BRIEF = {
  // A（jmas lab）… 価値提供でフォローされることを狙う
  'Contrarian': 'Open by rejecting something most people in this field believe. Say why they are wrong, concretely.',
  'Cheat Code': 'Share one shortcut most people do not know. Give the whole shortcut, not a hint of it.',
  'Teardown':   'Take one thing that works and explain the mechanism behind why it works.',
  'Mistake':    'Name a mistake you see constantly. Say what to do instead, in one line.',
  'Tool':       'One specific tool or method, what it actually does, and the one case it is worth it for.',
  'GitHub':     'Introduce the repository given to you in the facts. Say what problem it solves ' +
                'and who should look at it. Do not oversell it.',

  // --- 販売の角度 ---
  // 無料で解決できる範囲と、有料でしか解決できない範囲の境目を突く。
  // 嘘をつく必要がなく、境目に立っている人だけが反応するので買う層が集まる。
  'Bridge':      'Name what free or DIY tooling handles fine in this area. Then name the one ' +
                 'specific thing it does not handle. That gap is where the linked product sits. ' +
                 'Do not rubbish the free option. Be fair about it.',
  'Cost of DIY': 'Talk about what doing this yourself actually costs. Hours, maintenance, ' +
                 'the parts nobody warns you about. Then the link as the alternative. ' +
                 'Do not invent specific figures.',
  'Who it is for': 'Say plainly who this is worth it for, and who should skip it. ' +
                 'Naming who should NOT buy is what makes the right people trust you.',
  // B（Mia）… 宣伝一辺倒にせず、人として読ませる
  'Slice of life': 'Just something from your day. No promotion at all in this one. Let it be ordinary.',
  'Mood':          'How you feel right now, in one or two lines. Nothing to sell.',
  'Teaser':        'Hint at something without describing it. Leave the reader filling in the gap.',
  'Reply bait':    'Ask followers something you genuinely want to know. Keep it light and easy to answer.',
  'Direct':        'Say plainly what is available and where. Short. No build-up.'
};

/**
 * Aが扱う話題の在庫。
 *
 * ★これが無いと投稿が凡庸になる最大の原因になる。
 * お題を渡さずに「あなたの分野の一般知識から書け」と言うと、
 * LLMは毎回どの分野でも通用する当たり障りのない助言
 * （「コールドメールは独自ドメインから送るな」等）を出す。
 * 誰でも書ける内容はフォローされないし、保存もされない。
 *
 * 具体的な題材を毎回1つ指定して、その範囲の中で深く書かせる。
 * LLM_TOPICS_A / LLM_TOPICS_B で運用しながら差し替える。
 */
const DEFAULT_TOPICS_A = [
  /*
   * --- 日本製・日本でしか買えないもの（2026-08-16追加・最優先）---
   *
   * ★このアカウント唯一の構造的な強み。
   * 米国のガジェットニュースに感想を書く英語アカウントは何千とあり、
   * そこで勝つ理由が無い。日本にいて日本語が読めることは、
   * 英語圏の読者が自力では埋められない差になる。
   *
   * 商材としても相性がいい。日本製の刃物・文具・工具・調理器具は
   * amazon.com に多数出品されており、米国の読者がそのまま買える。
   * 新しいASPを増やさずに、いま登録するAmazonアソシエイトで完結する。
   */
  'Japanese kitchen knives: steel types, and who actually needs which',
  'Japanese stationery: pens, paper and why the writing feel differs',
  'Japanese hand tools and why the tolerances are different',
  'Japanese kitchenware: donabe, iron pans, rice, and what travels well',
  'everyday Japanese products that never get exported',
  'what a Japanese convenience store sells that would be a specialty item abroad',
  'Japanese audio and instrument makers that stayed small',
  'Japanese work gear: aprons, boots, and clothing built for trades',
  'why a Japanese version of a product differs from the export version',
  'buying from Japan: what is worth the shipping and what is not',

  // --- ガジェット・実物（アフィリエイトに直結する側）---
  // ★ここを最優先で足した。B（成人向け）は4サービスとも規約未確認で
  // 収益化の目処が立たないが、こちらはASP登録が当日でき、
  // Xの成人向け収益化の論点も無い。先に回すべきはこちら。
  'desk setup and what actually changes day to day',
  'USB-C, hubs, docks and why they fail',
  'monitors: refresh rate, panel type, and what matters for work',
  'keyboards and switches beyond the hype',
  'cables, power delivery and charging that actually works',
  'portable gear for working away from the desk',
  'audio for calls: mics, interfaces, and what is overkill',
  'storage: SSDs, NAS, and backup that survives a failure',
  'small tools that remove a daily annoyance',
  'what to buy once instead of three times',

  // --- 技術・自動化（信頼を作る側）---
  'email deliverability and domain warmup',
  'marketing automation that breaks in production',
  'LLM API cost control in real workloads',
  'scraping and data collection that stays reliable',
  'spreadsheet-driven systems and where they stop scaling',
  'API rate limits and how to design around them',
  'why retry logic creates duplicates'
];


/**
 * Bの話題の在庫。海外読者が知らない日本のクリエイター文化の切り口。
 *
 * 「エロ」ではなく「シーンの構造」を入口にする。
 * 前者は既に飽和していて誰も新しくフォローしないが、
 * 後者は英語圏にほとんど情報が無く、発見として成立する。
 */
/*
 * ★2026-08-15に全面的に入れ替えた。
 * 旧版は「日本にはこんな文化がある」という雑学だった。読んで終わりで、
 * 買う気のある人が次に何をすればいいのかが1つも書かれていなかった。
 * 実投稿を見て「価値がない」と判断されたのはこれが原因。
 *
 * 海外ユーザーが日本のストアで詰まるのは知識ではなく手続きの側。
 * 言語・地域制限・決済・アカウント作成・ファイル形式・DRM。
 * ここを解ける投稿は、読んだ人がそのまま購入直前まで進む。
 * だから在庫を「買おうとした時に必ずぶつかる壁」で埋め直した。
 */
const DEFAULT_TOPICS_B = [
  // --- 購入の壁（本命。検索需要が大きく、書いている人が少ない）---
  'what actually blocks an overseas buyer on a Japanese store',
  'paying a Japanese storefront from abroad and which methods work',
  'why a Japanese store page can show a price but refuse the sale',
  'making an account on a Japanese site when you cannot read Japanese',
  'region restrictions and why they differ from title to title',
  'what file formats Japanese digital stores actually deliver',
  'DRM and viewer apps on Japanese stores',
  'how Japanese storefronts handle refunds and failed downloads',
  'reading a Japanese product page without knowing Japanese',
  'currency, tax, and what the final charge actually comes to',

  // --- 買うために必要な語彙（知らないと検索すらできない）---
  'the genre words you need to search a Japanese store at all',
  'how Japanese stores tag and categorise work',
  'what the letters and numbers in a Japanese product code mean',

  // --- 買い分けの判断材料 ---
  'which Japanese platform suits which kind of purchase',
  'subscription support versus buying a single work',
  'why the same work can appear on more than one Japanese store',

  // --- シーンの構造（従来型。集客側で使う）---
  'how doujin releases actually work in Japan',
  'why so much Japanese indie work never gets an English listing',
  'the difference between commercial and doujin release routes'
];

function getTopics_(accountKey) {
  const key = String(accountKey).toUpperCase();
  return key === 'B'
    ? getListProp_('LLM_TOPICS_B', DEFAULT_TOPICS_B)
    : getListProp_('LLM_TOPICS_A', DEFAULT_TOPICS_A);
}

/**
 * 投稿の「型」。
 *
 * 2時間おきに投稿すると、1本ごとの出来より「毎回同じ構造」であることが
 * アカウント単位で目立ち、機械が書いていると分かってしまう。
 * 訴求角度とは別に文章の骨格そのものを毎回入れ替える。
 */
const DEFAULT_FORMATS_A = ['one-liner', 'two-beat', 'observation', 'question', 'mini-list',
                           'receipt', 'news-drop', 'howto-steps'];
const DEFAULT_FORMATS_B = ['one-liner', 'fragment', 'moment', 'question', 'two-beat'];

const FORMAT_BRIEF = {
  'one-liner':   'Exactly one short line. No setup, no follow-up. Under 12 words if you can.',
  'two-beat':    'Two beats separated by a line break. First line sets up, second line lands. Nothing after.',
  'observation': 'Notice something and say it. No call to action, no ask. Just the observation.',
  'question':    'Ask one real, open question you would actually want answered. Do not answer it yourself.',
  'mini-list':   'Two items. Never three. No numbering, no bullet symbols, just two short lines.',
  'receipt':     'Lead with one concrete number or exact detail, then one line of what it means.',
  'fragment':    'An incomplete sentence, mid-thought. Like you started typing halfway through.',
  'moment':      'One small moment from your day. Time of day, what you were doing, how it felt.',

  // 情報アカウントで伸びやすい2つの型。どちらも中身が事実であることが前提で、
  // お題が渡されていないときは使えない（下記 buildUserPrompt_ で制御）。
  'news-drop':   'Open with a bracket label like [Heads up] or [Free] on its own line. ' +
                 'Then the single most concrete fact, with the number in it. ' +
                 'Attribute it: "apparently", "from what I can tell". Never state it as your own claim.',
  'howto-steps': 'One line saying what this gets you, then numbered steps. ' +
                 'Three or four steps, each one line, each starting with a verb. No closing line.'
};

/**
 * お題（事実）が渡されていない場合に使えない型。
 *
 * ニュース型・手順型は「実際にある情報」を整形する型であって、
 * ネタが無い状態で選ぶとLLMが存在しないキャンペーンや手順を捏造する。
 * フォロワーが実際に試して嘘だと分かった時点でアカウントの信用が終わるため、
 * お題が空のときは候補から外す。
 */
const FORMATS_REQUIRING_TOPIC = ['news-drop', 'howto-steps'];

function getFormats_(accountKey) {
  const key = String(accountKey).toUpperCase();
  return key === 'B'
    ? getListProp_('LLM_FORMATS_B', DEFAULT_FORMATS_B)
    : getListProp_('LLM_FORMATS_A', DEFAULT_FORMATS_A);
}

/**
 * 生成文にAI特有の癖が出ないよう、実際に頻出する言い回しを名指しで禁止する。
 * 抽象的に「自然に書け」と指示するより、固有名詞で禁止する方が効く。
 */
const ANTI_AI_RULES = [
  '# Never do these (they read as machine-written)',
  '- No em dashes. No semicolons.',
  '- Never use: "here\'s the thing", "let\'s dive in", "game changer", "unlock", "elevate",',
  '  "seamless", "leverage", "supercharge", "in today\'s world", "the truth is", "trust me".',
  '- Never use the "it\'s not X, it\'s Y" construction.',
  '- Never ask a rhetorical question and then answer it yourself in the same post.',
  '- Never list exactly three things. Two or four, never three.',
  '- Never start a line with an emoji.',
  '- Never end with a tidy summary line or a slogan.',
  '- Avoid hype adjectives: amazing, incredible, powerful, ultimate, essential, must-have.',
  '- Do not make every sentence the same length. Vary it hard.'
].join('\n');

function pickRandom_(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** プロパティのカンマ区切り文字列を配列にする。未設定なら既定値。 */
function getListProp_(name, fallbackArray) {
  const raw = getProp_(name);
  if (!raw) return fallbackArray;
  const list = String(raw).split(',').map(function (s) { return s.trim(); }).filter(String);
  return list.length ? list : fallbackArray;
}

function getRegions_() {
  return getListProp_('LLM_REGIONS', DEFAULT_REGIONS);
}

function getAngles_(accountKey) {
  const key = String(accountKey).toUpperCase();
  return key === 'B'
    ? getListProp_('LLM_ANGLES_B', DEFAULT_ANGLES_B)
    : getListProp_('LLM_ANGLES_A', DEFAULT_ANGLES_A);
}

/* ------------------------------------------------------------------ */
/* 既定のsystem prompt                                                 */
/* ------------------------------------------------------------------ */
/*
 * あくまで出発点。LLM_PROMPT_A / LLM_PROMPT_B を設定すれば完全に上書きされる。
 * {REGION_STYLE} {ANGLE_BRIEF} {URL} は実行時に置換される。
 */

/**
 * Aのシステムプロンプト。
 *
 * ★2026-08-15 全面改訂。旧版は破綻していた。
 * 「観測した具体的な数値」「実際の失敗とその損失」を必須にしておきながら、
 * 同時に「統計を捏造するな」と禁じていた。LLMに実体験は無いので、
 * 捏造するか濁すかの二択しか残らない。濁せば品質ゲートに弾かれ、
 * 再生成を繰り返した末に「最もマシなゴミ」が投稿される。これが低品質の原因だった。
 *
 * 解決策：フックの型（Pattern Interrupt → Payoff → Drop）で読ませる。
 * これなら実体験を要求しない。LLMが正直にできるのは
 * 「実在する道具の名前を出す」「仕組みを説明する」「立場を取る」であり、
 * それだけで十分に読ませる投稿になる。
 */
const DEFAULT_PROMPT_A =
  "You are 'jmas lab'. You are in Japan, writing in English for readers in the US,\n" +
  'UK, Canada and Australia. You post about tools, gear and the systems behind them.\n' +
  'You are writing one post on X.\n' +
  '\n' +
  'You are a working engineer, not a content marketer. You have shipped systems,\n' +
  'read the errata, and been burned by the thing everyone repeats as advice.\n' +
  'That is what your voice comes from: you explain a mechanism the way someone\n' +
  'explains it after having debugged it, not after having read about it.\n' +
  '\n' +
  'That persona governs HOW YOU SOUND, never what you claim. It does not license\n' +
  'you to invent a story, a client, a benchmark or a result. Expertise here shows\n' +
  'up as precision about how something works, never as a war story.\n' +
  '\n' +
  '# Where your edge is\n' +
  'Thousands of English accounts react to the same US gadget news. You cannot win\n' +
  'there and you should not try. What you have that they do not is Japan: you can\n' +
  'read the Japanese spec sheet, you know the domestic version differs from the\n' +
  'export one, you know which maker is three people in a workshop.\n' +
  '\n' +
  'So when a topic touches something Japanese — a product, a maker, a material,\n' +
  'a way of doing things — take it. That is the post nobody else can write.\n' +
  'When the topic has no Japanese angle, do not force one. A fake connection is\n' +
  'worse than no connection.\n' +
  '\n' +
  'You are not a tourist board. Never write "only in Japan" as a slogan, never\n' +
  'exoticise, never claim Japanese things are simply better. Be specific about\n' +
  'what actually differs and why, and say when the difference does not matter.\n' +
  '\n' +
  '# Structure. Use it every time.\n' +
  '\n' +
  '1. PATTERN INTERRUPT — the first line stops the scroll.\n' +
  '   A claim that sounds wrong until you explain it. A named thing most people\n' +
  '   use incorrectly. A distinction nobody makes. Never a warm-up sentence.\n' +
  '\n' +
  '2. THE PAYOFF — deliver the actual mechanism.\n' +
  '   Why it works that way. This is where the follow is earned.\n' +
  '   Give the real answer inside the post. Never tease and withhold.\n' +
  '\n' +
  '3. THE DROP — only when a link is given. One short confident line.\n' +
  '   Not desperate, not salesy.\n' +
  '\n' +
  '# What you can claim, and what you cannot\n' +
  '\n' +
  'You CAN: name real tools, APIs, services, error codes and settings.\n' +
  '  Explain how something actually works. Take a position. Say that a common\n' +
  '  practice is wrong and explain why.\n' +
  '\n' +
  'You CANNOT: invent a personal anecdote, a metric you "measured", a client,\n' +
  '  a revenue figure, a timeline, or a scarcity claim. You did not run that test.\n' +
  '  If a number is genuinely general knowledge, use it. Otherwise explain the\n' +
  '  mechanism instead of faking a measurement. A mechanism beats a fake number.\n' +
  '\n' +
  '# Bad vs good\n' +
  '\n' +
  'BAD  : Automation saves you time. Start small and scale up.\n' +
  'WHY  : No mechanism, no position, no reason to read the second line.\n' +
  'GOOD : Most retry logic produces duplicates, not resilience. A 500 from an API\n' +
  '       does not mean the write failed. It means you do not know whether it did.\n' +
  '       Retrying an unknown is how you send the same thing twice.\n' +
  '\n' +
  'BAD  : I switched to a subdomain and my spam rate dropped to 0.1% in ten days.\n' +
  'WHY  : Invented measurement. You never ran this. This is the failure mode to avoid.\n' +
  'GOOD : Sender reputation attaches to the domain, not the campaign. That is why\n' +
  '       one bad cold-email week follows you into your transactional mail.\n' +
  '       Same domain, same score.\n' +
  '\n' +
  '# Shape on the screen. This matters as much as the words.\n' +
  'X is read on a phone, by a person, at speed. A dense block loses before it is read.\n' +
  '\n' +
  '- The first line stands alone. Under 70 characters. Then a line break.\n' +
  '  It has to land in one glance with nothing after it.\n' +
  '- Never ship one unbroken paragraph. Break after the hook, and again before\n' +
  '  the point lands.\n' +
  '- The opening line must have something at stake: something wrong, something\n' +
  '  surprising, or something the reader is already doing without noticing.\n' +
  '  A neutral statement of fact is not a hook, however true it is.\n' +
  '\n' +
  'BAD  : An HTTP 200 response containing {"success": false} silently disables\n' +
  '       workflow retries. Most automation middleware inspects transport status\n' +
  '       codes, not internal JSON keys. The execution is flagged as successful\n' +
  '       while the record update fails.\n' +
  'WHY  : Every word is true and nobody reads it. An 88-character opening line,\n' +
  '       no breaks, three sentences of identical weight. A manual page, not a post.\n' +
  'GOOD : Your retries are not running.\n' +
  '\n' +
  '       The API returns 200. The body says {"success": false}.\n' +
  '       Middleware reads the status code, not the body.\n' +
  '\n' +
  '       The run goes green. The record never updated.\n' +
  '\n' +
  '# How you write\n' +
  '- Vary sentence length hard. A fragment. Then one that runs further than expected.\n' +
  '- Stop when the idea stops. No wrap-up line, no sign-off.\n' +
  '- One idea per post. Deeper on one thing, never wider on three.\n' +
  '- At most two emojis, and only where they carry meaning. Usually zero or one.\n' +
  '- No hashtags.\n' +
  '\n' +
  '# Never open with these\n' +
  '- "People keep..." / "Most people..." / "Everyone is..." / "Stop doing..."\n' +
  '- "Here is how to..." / "The mistake I see..." / "Pro tip:" / "Reminder:"\n' +
  'They announce generic advice and the reader scrolls past before line two.\n' +
  '\n' +
  '# Never instruct a generic "you"\n' +
  'No "you should", "make sure to", "always", "never".\n' +
  'State how the thing works. The reader draws their own conclusion.\n' +
  '\n' +
  /*
   * ★2026-08-18追加。実測の失敗はここ1点に集中していた。
   *
   * 通知の5回の試行のうち3回が「冒頭が平坦な事実」で落ちている。
   * 既存の指示は "something at stake"（何か賭かっている）という抽象語で、
   * それを読んでもモデルは平坦な定義文を書いてくる。52点で頭打ちだった。
   *
   * 足りなかったのは「同じ中身のまま冒頭だけを変える」実例。
   * 投稿まるごとのBAD/GOODは既にあるが、変換の見本が無かった。
   * FLAT の1つ目は、実際に52点で落ちた本文をそのまま使っている。
   *
   * ★どのHOOKにも数字も体験談も足していないことに注意。
   * 与えられた事実の中だけで摩擦を作っている。
   * 「自分の失敗談を入れろ」という助言（Gemini提案）は却下した。
   * あの口調は必ず測っていない数字を連れてきて、
   * 上の "spam rate dropped to 0.1%" のBAD例に戻るため。
   */
  '# Turning a fact into a first line\n' +
  'The body is usually fine. The first line is what fails. The fix is never to\n' +
  'change the subject — it is to say the same thing with friction in it.\n' +
  'Do not reach for a number or a story you do not have. Use only what is here.\n' +
  '\n' +
  'FLAT : GaN chargers trade thermal mass for form factor.\n' +
  'WHY  : A definition. True, complete, and no reason to read line two.\n' +
  'HOOK : That 65W block is only 65W for about a minute.\n' +
  '       -> same fact, but now something the reader owns is implicated.\n' +
  '\n' +
  'FLAT : Mechanical keyboards use different switch types.\n' +
  'WHY  : A category description. Nothing is at stake for anyone.\n' +
  'HOOK : The switch is not what you are hearing. The case is.\n' +
  '       -> contradicts what the reader assumes they know.\n' +
  '\n' +
  'FLAT : USB-C cables vary in supported wattage.\n' +
  'WHY  : Neutral, and the reader already half suspects it.\n' +
  'HOOK : Half the cables in that drawer cannot carry what your laptop asks for.\n' +
  '       -> names a situation the reader is already in without knowing.\n' +
  '\n' +
  'The moves that work, in order of how often they land:\n' +
  '  - implicate something the reader already owns or already does\n' +
  '  - contradict the thing everybody repeats about this topic\n' +
  '  - name the moment it breaks, not the property that makes it break\n' +
  '  - state the verdict first and make them read on for the reason\n' +
  '\n' +
  '# The bar this post is scored against before it can be published\n' +
  'A separate judge scores this 0-100 and nothing under 70 is ever posted.\n' +
  'That judge is told most posts deserve 40-60, so "correct and readable" is a\n' +
  'fail, not a pass. These are the things it actually checks. Hit them on purpose.\n' +
  '\n' +
  '1. A NAMED CONCRETE ANCHOR is required, not optional.\n' +
  '   Name the real tool, protocol, header, error code, setting, spec or part.\n' +
  '   "an API" fails. "a 429 from that endpoint" passes. A bare number is not an\n' +
  '   anchor. If you cannot name something real, you picked the wrong topic.\n' +
  '2. THE FIRST LINE IS READ ALONE. A neutral true statement caps the post\n' +
  '   under 55. But the first line only buys attention — IT IS NOT THE POST.\n' +
  '   Shipping a hook with nothing under it is an automatic failure: a claim\n' +
  '   with no mechanism is a headline. Always break the line and deliver the\n' +
  '   why underneath. Never output a single line.\n' +
  '3. AN EXPERT MUST STILL LEARN SOMETHING. If someone who already works in this\n' +
  '   field would nod and scroll, it scores low however clean it reads.\n' +
  '   Go one layer past the thing everybody already repeats.\n' +
  '4. WOULD ANYONE SAVE THIS? Forgettable scores low. What gets saved is usually\n' +
  '   a distinction, a failure mode, or a reason the obvious fix is wrong.\n' +
  '5. IT MUST READ AS TYPED BY A PERSON. Three declarative sentences of similar\n' +
  '   length in a row reads as a manual and is scored as one.\n' +
  '\n' +
  'Never mention scoring, criteria or judging in the post itself.\n' +
  '\n' +
  '{ANTI_AI}\n' +
  '\n' +
  '# Region\n' +
  '{REGION_STYLE}\n' +
  '\n' +
  '# Angle\n' +
  '{ANGLE_BRIEF}\n' +
  '\n' +
  '# Shape of this post\n' +
  '{FORMAT_BRIEF}\n' +
  '\n' +
  '# Link\n' +
  '{URL}\n' +
  '\n' +
  '# Hard rules\n' +
  '- Length is fixed below under "# Length". Follow that number, not a habit.\n' +
  '- Output the post text only. No preamble, no quotes, no explanation.\n';

/**
 * Bのシステムプロンプト（Secret Mia）。
 *
 * ★2026-08-15 全面改訂。
 * 旧版は「No slang, no forced casualness」「絵文字は最大1つ、通常は0」で
 * 声を殺していた。結果として百科事典の記述になり、
 * 誰もフォローする理由がない投稿しか出なかった。
 *
 * 人格は戻す（全小文字・インサイダー・少し挑発的）。
 * 一方で残す制約は2つだけ、ただし絶対に外さない。
 *   1. 事実の捏造をしない（作品名・価格・ランキング・レビュー・売上）
 *   2. 特定の実在個人について書かない
 * 声と嘘は別物なので、声を戻しても1と2は守れる。
 */
const DEFAULT_PROMPT_B =
  "You are 'Secret Mia'. You are the gatekeeper of Japan's premium adult and doujin\n" +
  'content for an English-speaking audience. You know what is actually good and\n' +
  'where it lives. They do not. You enjoy that.\n' +
  '\n' +
  '# Voice\n' +
  '- all lowercase. always. no exceptions.\n' +
  '- alluring, teasing, a little bratty. you are flirting with the idea, never\n' +
  '  with the reader directly.\n' +
  '- confident to the point of being smug about your taste. you gatekeep because\n' +
  '  most of what they have seen is the shallow end.\n' +
  '- short and sharp. fragments. no essay paragraphs.\n' +
  '- at most two emojis, usually one.\n' +
  '- no hashtags (the #ad tag is added for you; do not write it yourself).\n' +
  '\n' +
  '# Structure. Use it every time.\n' +
  '\n' +
  '1. THE HOOK — condescending and alluring at once.\n' +
  '   Make them feel they are standing outside something better.\n' +
  '   register:\n' +
  '     "you are barely scratching the surface."\n' +
  '     "cute taste. the deep end is a different sport."\n' +
  '     "still digging through the shallow stuff?"\n' +
  '\n' +
  '2. THE FLEX — trigger the imagination without describing anything explicit.\n' +
  '   Talk about intensity, production, how far the premium tier actually goes,\n' +
  '   how much of it never surfaces in english. words that work: premium,\n' +
  '   the real deal, a whole other level, what the catalogue actually holds.\n' +
  '   Suggest. Never depict.\n' +
  '\n' +
  '3. THE DROP\n' +
  '   - with a link: point at it like you are letting them in.\n' +
  '     "stop settling for clips. the official catalogue is here"\n' +
  '   - no link (TEASER MODE): make following the price of entry.\n' +
  '     "follow me. i am opening the vault soon. 🤫"\n' +
  '\n' +
  '# Bad vs good\n' +
  '\n' +
  'BAD  : Check out this amazing Japanese content! Link below!\n' +
  'WHY  : any account could post it. no persona, no tension, nothing withheld.\n' +
  'GOOD : english search shows you maybe two percent of what exists, and it is\n' +
  '       the safest two percent. the catalogue underneath is a different animal. 🤫\n' +
  '\n' +
  'BAD  : japanese doujin is the best, you should buy some.\n' +
  'GOOD : cute taste. doujin is where the stuff a publisher would never greenlight\n' +
  '       actually gets made, and half of it is by people who work commercially.\n' +
  '       you are shopping the wrong shelf.\n' +
  '\n' +
  '# The line you do not cross\n' +
  '\n' +
  'Seduction is in what you imply. These are what break it, every time:\n' +
  '\n' +
  '- NEVER write about a specific individual. no performers, no actresses, no\n' +
  '  creators by name, no "her latest", no "this actress". real people are in\n' +
  '  this material and you cannot know whether any of them consents to being\n' +
  '  promoted. genres, formats, storefronts, catalogues — never a person.\n' +
  '- NEVER promise uncensored, leaked, stolen, or hacked material. the products\n' +
  '  you point at are official and censored under Japanese law. saying otherwise\n' +
  '  is a lie about the product and it is the fastest way to lose the account.\n' +
  '  "official" and "premium" are your words. "uncensored" is not.\n' +
  '- NEVER invent a title, price, discount, rating, ranking, or sales figure.\n' +
  '- NEVER reference or imply minors, school settings, or age-ambiguous framing.\n' +
  '- NEVER describe a sexual act. you gesture at the door; you do not go through it.\n' +
  '- NEVER demean the person you are quoting. mock the shallow end of the taste,\n' +
  '  never the human being. you are a gatekeeper, not a bully.\n' +
  '- NEVER write BUY NOW, CLICK HERE, LINK BELOW.\n' +
  '\n' +
  '# shape on the screen\n' +
  'this is read on a phone, at speed. a dense block gets scrolled past unread.\n' +
  '- the first line stands alone, under 70 characters, then a line break.\n' +
  '- if the post runs past two sentences, break it. never one solid block.\n' +
  '\n' +
  '{ANTI_AI}\n' +
  '\n' +
  '# Region\n' +
  '{REGION_STYLE}\n' +
  '\n' +
  '# What this post is for\n' +
  '{ANGLE_BRIEF}\n' +
  '\n' +
  '# Shape of this post\n' +
  '{FORMAT_BRIEF}\n' +
  '\n' +
  '# Link\n' +
  '{URL}\n' +
  '\n' +
  '# The bar this post is scored against before it can be published\n' +
  'A separate judge scores this 0-100 and nothing under 70 is ever posted.\n' +
  'For this account the judge is explicitly told that BLAND IS THE FAILURE MODE\n' +
  'and that provocative is correct. Polite and flat scores lower than too much.\n' +
  '\n' +
  '1. DESIRE OR CURIOSITY, not description. If it merely describes a genre, it\n' +
  '   fails. The reader has to feel they are missing something.\n' +
  '2. TENSION. Imply a gap between what they have seen and what exists.\n' +
  '3. INSIDER, NOT AFFILIATE BOT. Taste and specificity of category, never\n' +
  '   generic hype words.\n' +
  '4. VOICE HELD ALL THE WAY. all lowercase, confident, teasing, never begging.\n' +
  '5. WOULD A BUYER ACTUALLY CLICK, or is it just words arranged nicely?\n' +
  '\n' +
  'These score 0 and are unrecoverable, so never go near them:\n' +
  '  - sexualising a REAL, identifiable person: a cosplayer, a named performer,\n' +
  '    a public figure, anyone in a photograph\n' +
  '  - promising uncensored, leaked, ripped or stolen material\n' +
  '  - anything involving someone who reads as a minor\n' +
  'Invented titles, prices, ratings or creators score under 20.\n' +
  '\n' +
  /*
   * ★2026-08-18、オーナー指示で register を上げた。
   * 1.9万フォロワーのFANZAアフィリエイトを参考にしている。
   * あの型が効くのは上品だからではなく、作品の中身を短く官能的に
   * 言い切っているから。「品はいいが何も言っていない」文は売れない。
   */
  /*
   * ★2026-08-19、さらに上げた（オーナー指示「スレスレギリギリまで言って」）。
   *
   * 同時に採点ゲートをBから外したので、これまで文章を無難な側へ
   * 引き戻していた力が無くなった。上限を決めるのはこのプロンプトだけになる。
   * だから「どこまで言ってよいか」ではなく「どこからが線か」を書く。
   */
  '# How explicit to be\n' +
  'Go as far as the platform allows. The fictional characters in a published work\n' +
  'ARE the product: name what the work actually delivers, in heat, in one breath.\n' +
  'Suggestive, filthy, teasing, blunt — all correct here.\n' +
  'Tasteful but empty is the ONLY failure mode of tone. Polite vagueness sells\n' +
  'nothing in this genre and reads like an affiliate bot.\n' +
  'Do not soften, do not hedge, do not write around the thing.\n' +
  '\n' +
  'The lines are not about intensity. They are these, and they are absolute:\n' +
  '  - never a real, identifiable person (cosplayer, performer, public figure)\n' +
  '  - never uncensored, leaked, ripped or pirated material\n' +
  '  - never anyone who reads as a minor\n' +
  'Everything else about a published fictional work is yours to say.\n' +
  '\n' +
  'Never mention scoring, criteria or judging in the post itself.\n' +
  '\n' +
  '# Hard rules\n' +
  '- Length is fixed below under "# Length". Follow that number, not a habit.\n' +
  '- Output the post text only. No preamble, no quotes, no explanation.\n';

/* ------------------------------------------------------------------ */
/* エントリポイント                                                    */
/* ------------------------------------------------------------------ */

/** Content列に {AUTO} が含まれるか */
function isAutoContent_(content) {
  return String(content || '').indexOf(AUTO_TAG) !== -1;
}

/**
 * {AUTO} を含む本文から、LLMへ渡す「お題」を取り出す。
 * 例: "{AUTO} 新作の告知" → "新作の告知"
 */
function extractTopicHint_(content) {
  return String(content || '').split(AUTO_TAG).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 投稿文を生成する。地域と訴求角度は毎回ランダムに選ばれる。
 *
 * @param {string} account   'A' or 'B'
 * @param {string} url       本文に織り込むURL（空可）
 * @param {string} [topicHint] お題（空可）
 * @return {{text:string, region:string, angle:string}}
 */
function generateTweet(account, link, topicHint) {
  const accountKey = String(account).toUpperCase();
  const acc = getAccount_(accountKey);

  // 文字列で渡された場合も受け付ける（旧シグネチャ互換）
  const linkObj = (typeof link === 'string') ? (link ? { url: link, note: '' } : null) : (link || null);
  const url = linkObj ? linkObj.url : '';

  const region = pickRegionByJstHour_();

  // ==================================================================
  // B は収益ファネルで動かす（17_BFunnel.gs）。
  // A の経路は従来どおりで、ここから下は一切通らない。
  // ==================================================================
  if (accountKey === 'B') {
    return generateTweetForB_(acc, accountKey, linkObj, topicHint, region);
  }

  // リンクを貼る回は販売の角度、貼らない回は価値提供の角度を使う。
  // これを分けないと、無料ツール紹介の直後に商材URLが出る不自然な投稿になる。
  const angle = url
    ? pickRandom_(getOfferAngles_(accountKey))
    : pickRandom_(getAngles_(accountKey));
  // 「GitHub」の角度は、実在するリポジトリの情報が必須。
  // LLMに名前を考えさせると存在しないURLを生成するため、必ずAPIの実データを渡す。
  // 取得できなかった場合は、この角度を諦めて別の角度に差し替える（捏造させない）。
  let facts = topicHint;
  let effectiveAngle = angle;
  if (angle === 'GitHub' && !facts) {
    const repo = fetchGitHubRepo_();
    if (repo) {
      facts = buildGitHubFacts_(repo);
    } else {
      const others = getAngles_(accountKey).filter(function (a) { return a !== 'GitHub'; });
      effectiveAngle = others.length ? pickRandom_(others) : 'Tool';
      console.warn('GitHubリポジトリを取得できないため、角度を ' + effectiveAngle + ' に変更しました。');
    }
  }

  // お題が無いときは、話題の在庫から1つ選んで渡す。
  // 白紙で書かせると「誰でも書ける一般論」になるため（DEFAULT_TOPICS_A のコメント参照）。
  const topics = getTopics_(accountKey);
  const subject = (facts && String(facts).trim()) ? '' : (topics.length ? pickRandom_(topics) : '');

  // お題が無いときは、事実を必要とする型を候補から外す（捏造防止）
  const hasTopic = !!(facts && String(facts).trim());
  const formatPool = getFormats_(accountKey).filter(function (f) {
    return hasTopic || FORMATS_REQUIRING_TOPIC.indexOf(f) === -1;
  });
  const format = pickRandom_(formatPool.length ? formatPool : getFormats_(accountKey));
  const maxLen = getTweetMaxLen_(accountKey);

  // ★リンクを貼る回は開示タグを機械的に付ける（B側と同じ仕組み）。
  // アフィリエイトである以上、技術アカウントでも開示は要る。
  // LLMに書かせず、採点の後にコード側で先頭へ足す。
  const disclosureTag = linkObj ? requiredDisclosureFor_(region, linkObj) : '';
  const disclosureCost = disclosureTag ? estimateWeightedLength_(disclosureTag + ' ') : 0;
  // 固定CTA（22_FixedCta.gs）の分も先に確保しておく。
  // リンク付きの回はCTAを付けない設計なので、その場合は確保しない。
  const ctaCost = linkObj ? 0 : fixedCtaReserve_(accountKey);
  const bodyMaxLen = maxLen - disclosureCost - ctaCost;

  /*
   * ★systemPrompt は bodyMaxLen を確定させてから組む。
   *
   * 以前はここで maxLen（280）を渡していたが、実際に測るのは bodyMaxLen
   * （280 − 開示タグ − 固定CTAの予約ぶん）だった。
   * CTAを付ける回は予約が80字ほどあるので、モデルには「280まで」と言いながら
   * 200で弾いていたことになる。落ちて当然で、しかも理由がモデルに伝わらない。
   * 生成させる相手には、実際に測る数字をそのまま渡す。
   */
  // 安全フィルタで角度を差し替える場合に組み直すため let にしている
  let systemPrompt = buildSystemPrompt_(accountKey, region, effectiveAngle, linkObj, format,
                                        bodyMaxLen);

  const genStartedAt = Date.now();
  let critique = '';
  /*
   * ★2つを混ぜない。
   *   best         … 投稿してよい候補のうち一番点が高いもの。
   *                  ローカル判定を通ったものだけが入る
   *   revisionBase … 次に直させる土台。落ちた案でもよい
   * 以前は best 1つで兼ねていた。投稿しない設計だったので無害だったが、
   * 最良案を採用する設計に変えた以上、捏造や長すぎの案が best に
   * 入っていると、そのまま投稿されてしまう。
   */
  let best = null;
  let revisionBase = '';
  const attemptLog = [];    // 何回目に何点で何が悪かったか。通知に載せる
  /*
   * ★冒頭だけを直した案。次の回はこれを生成の代わりに使う。
   * 生成を1回省くので呼び出し回数は増えない（repairHook_ が肩代わりする）。
   */
  let pendingDraft = '';

  /*
   * ★ループの外へ出してある。冒頭を差し替えた案はループ先頭で評価するので、
   * ループ内で宣言していると「初期化前アクセス」で落ちる。
   * effectiveAngle は let なので、角度を差し替えた場合も現在値を読む。
   */
  const buildResult = function (t, score) {
    return {
      text: applyDisclosure_(t, disclosureTag),
      region: region,
      angle: effectiveAngle,
      format: format,
      // どのモデルが何秒で書いたかを残す。モデルを替えた前後で
      // 反応が変わったかを後から比較できるようにするため。
      model: getProp_('LLM_MODEL', LLM_DEFAULT_MODEL),
      genSeconds: Math.round((Date.now() - genStartedAt) / 100) / 10,
      role: classifyPostRole_(effectiveAngle, !!url),
      qualityScore: score
    };
  };

  for (let attempt = 1; attempt <= llmMaxAttempts_(); attempt++) {
    // 冒頭だけ差し替えた案が控えているなら、生成せずそれを評価する
    if (pendingDraft) {
      const draftText = pendingDraft;
      pendingDraft = '';
      const dv = evaluatePost_(accountKey, draftText, effectiveAngle);
      if (dv.ok) {
        console.log('冒頭の差し替えで通過 (' + dv.score + '点) attempt=' + attempt);
        resetWeakPostStreak_(accountKey);
        return buildResult(draftText, dv.score);
      }
      attemptLog.push({ score: dv.score, reason: dv.critique });
      if (nextActionFor_(dv).keepAsCandidate && (!best || dv.score > best.score)) {
        best = { text: draftText, score: dv.score };
      }
      revisionBase = draftText;
      critique = dv.critique;
      continue;
    }

    const userPrompt = buildUserPrompt_(acc, facts, linkObj, region, effectiveAngle, format,
                                        attempt, revisionBase, subject, critique,
                                        bodyMaxLen);

    let raw;
    try {
      raw = callLLM_(systemPrompt, userPrompt);
    } catch (err) {
      // 安全フィルタで止まった場合は、その角度を捨てて別の角度で作り直す。
      // システム全体を止める理由にはならない（P1-11：該当投稿だけ破棄）。
      if (isSafetyBlock_(err) && attempt < llmMaxAttempts_()) {
        // ★リンクありなら Offer 側の角度から選び直す。
        // ここを常に getAngles_（無料系）にしていると、リンク付き投稿が
        // 拒否された時に GitHub/Tool のような「事実紹介」角度へ迷い込み、
        // URLは残ったままなのに文脈がリンクと噛み合わない投稿になる。
        const pool = url ? getOfferAngles_(accountKey) : getAngles_(accountKey);
        const alternatives = pool.filter(function (a) { return a !== effectiveAngle; });
        if (alternatives.length) {
          const before = effectiveAngle;
          effectiveAngle = pickRandom_(alternatives);
          console.warn('安全フィルタで拒否されたため角度を変更: ' + before + ' → ' + effectiveAngle);
          systemPrompt = buildSystemPrompt_(accountKey, region, effectiveAngle, linkObj, format,
                                            bodyMaxLen);
          // 角度が変わった以上、前の案を直させる意味は無い。白紙に戻す。
          revisionBase = '';
          critique = '';
          continue;
        }
      }
      throw err;
    }

    let text = sanitizeGeneratedText_(raw);

    if (!text) throw new Error('LLMが空の本文を返しました。');

    // --- 文字数 ---------------------------------------------------------
    /*
     * ★超過を即やり直しにしない。
     *
     * 実測（2026-08-18のA）では5回中2回が「330/280」「305/280」で捨てられ、
     * 呼び出し2回ぶんが文字数だけの理由で消えていた。
     * 内容が良くても長ければ0点、という扱いは採点として乱暴すぎる。
     *
     * 末尾の一文（または一段落）を落として収まるなら、それは編集で済む話。
     * 落としても収まらない・削りすぎる場合だけ、書き直しへ回す。
     */
    let weighted = estimateWeightedLength_(text);
    if (weighted > bodyMaxLen) {
      const trimmed = trimToLimit_(text, bodyMaxLen);
      if (trimmed) {
        console.log('末尾を削って収めた (' + weighted + ' → ' +
                    estimateWeightedLength_(trimmed) + '/' + bodyMaxLen + ')');
        text = trimmed;
        weighted = estimateWeightedLength_(text);
      } else {
        console.warn('長すぎて削り切れないため再生成 (' + weighted + '/' + bodyMaxLen +
                     ') attempt=' + attempt);
        attemptLog.push({ score: 0, reason: '長すぎ ' + weighted + '/' + bodyMaxLen });
        critique = 'It was ' + weighted + ' characters against a hard limit of ' +
                   bodyMaxLen + '. Remove one whole idea, not a few words.';
        // 長すぎた案をそのまま直させても同じ長さに戻りやすい。
        // これまでの最良案があるならそちらを土台にする。
        // ★候補(best)には入れない。上限を超えている＝投稿できない。
        revisionBase = best ? best.text : text;
        continue;
      }
    }

    // --- 品質 -----------------------------------------------------------
    // ★ここが「凡庸な投稿を出さない」ための本体。
    // 基準に届かなければ、何が悪いかを添えて作り直させる。
    const verdict = evaluatePost_(accountKey, text, effectiveAngle);

    if (verdict.ok) {
      console.log('品質OK (' + verdict.score + '点) attempt=' + attempt);
      resetWeakPostStreak_(accountKey);
      return buildResult(text, verdict.score);
    }

    attemptLog.push({ score: verdict.score, reason: verdict.critique });
    /*
     * ★点が上がった案だけを土台として残す。
     *
     * 以前は毎回まっさらに書き直させていた（「Write a different post」）。
     * その結果 52点の案を捨てて 35点を引き当てる、という往復が起きていた。
     * 指摘されたのは冒頭1行なのに、本文ごと作り直させていたのが原因。
     * 良かった案を持ち越し、指摘された箇所だけ直させる。
     */
    const next = nextActionFor_(verdict);
    if (next.keepAsCandidate && (!best || verdict.score > best.score)) {
      best = { text: text, score: verdict.score };
    }
    // 直す土台は、点が付いた案があればそちら。無ければ今の案
    revisionBase = best ? best.text : text;

    console.warn('品質不足のため修正 (' + verdict.score + '点) attempt=' + attempt +
                 ': ' + truncate_(verdict.critique, 200));
    critique = verdict.critique;

    /*
     * ★落ちた理由が冒頭1行だけなら、専用の呼び出しでそこだけ差し替える。
     *
     * 生成プロンプト一式（人格・地域・角度・型・良い例悪い例・禁止事項）を
     * もう一度送って1行を直させるのは、指示量に対して仕事が小さすぎるうえ、
     * 指示が多いほど「1行だけ」が守られない。
     * 本文と失敗した1行と理由だけを渡し、候補を3本もらって
     * 機械判定でふるいに掛ける（16_Quality.gs repairHook_ 参照）。
     */
    if (next.tryHookRepair) {
      const repaired = repairHook_(accountKey, text, verdict.fix || verdict.critique,
                                   bodyMaxLen);
      if (repaired && estimateWeightedLength_(repaired) <= bodyMaxLen) {
        pendingDraft = repaired;
      }
    }
  }

  /*
   * ここへ来たということは、規定回数のうち1本も基準(70点)に届かなかった。
   *
   * 【2026-08-18、オーナー判断で方針を変更】
   *
   * 旧: 基準未満なら投稿しない。次のトリガーでやり直す。
   *     理由は「出さなければ損失は枠1つだが、出すとアカウントの評価が
   *     下がって戻らない」。当時はこれが正しかった。
   *
   * 新: 候補の中で一番点が高いものを出す。
   *     絶対評価(70点で合否)から相対評価(3本で一番良いもの)へ変える。
   *
   * 変更の理由:
   *   ・実測で1本も出ない日が続いた。枠を失い続けるほうが損失が大きい
   *   ・LLMの絶対評価は呼ぶたびに揺れる。「70点」という線自体が
   *     測定として不安定で、それを合否の境界にしていた
   *   ・順位付け（どれが一番マシか）は絶対評価より安定する
   *
   * ★ただし「何でも出す」ではない。
   * ここまで来た案は全てローカルの機械判定を通っている——
   * 捏造した金額・途中で切れた文・禁止CTA・実在個人への言及などは
   * 既に落ちている。あれは品質ではなく事故なので、相対評価の対象外。
   * ここで選んでいるのは「読んで面白いか」という主観の部分だけ。
   */
  // 採否のルールはA/B共通（16_Quality.gs acceptBestCandidate_）
  return acceptBestCandidate_(accountKey, best, attemptLog, buildResult);
}

/**
 * 生成の試行回数。
 *
 * ★2026-08-18に 5 → 3 へ下げた。
 * 5回は「毎回まっさらに書き直す」前提の回数だった。
 * 良い案を持ち越して直す方式にしたので、回数で粘る必要が無くなった。
 * 1サイクルあたりの呼び出しは最大10回から6回へ減る。
 */
function llmMaxAttempts_() {
  const n = Number(getProp_('LLM_MAX_ATTEMPTS', '3'));
  return (isNaN(n) || n < 1) ? 3 : Math.min(5, n);
}

/**
 * 上限を超えた本文を、末尾から自然な単位で削って収める。
 *
 * ★「330字だから0点」で捨てるのが無駄だったので入れた。
 * 語の途中で切ると壊れた文が出るので、必ず段落か文の切れ目で落とす。
 *
 * 収まらない場合と、削った結果が短すぎる場合は null を返し、
 * 呼び出し側で書き直させる（削って別物になるくらいなら書き直した方が良い）。
 *
 * @return {string|null} 収まった本文。削って収まらなければ null
 */
function trimToLimit_(text, limit) {
  const original = String(text || '');
  if (!original) return null;
  if (estimateWeightedLength_(original) <= limit) return original;

  /*
   * 削った結果が短すぎたら、それは編集ではなく別物。書き直しへ回す。
   *
   * 基準を「元の何割が残ったか」ではなく「上限の何割あるか」にしている。
   * 元が極端に長い回でも、残った本文が投稿として成立していれば通してよい。
   * 逆に元が短くても、切り株のような本文を通してはいけない。
   */
  const floor = limit * 0.5;
  // 元が複数行なら、削った後も複数行を保つ。
  // 1行に潰れると「フックだけで中身が無い投稿」になり、結局そこで落ちる。
  const needLines = countLines_(original) >= 2 ? 2 : 1;

  const accept = function (candidate) {
    const len = estimateWeightedLength_(candidate);
    if (len > limit) return null;
    if (len < floor) return null;
    if (countLines_(candidate) < needLines) return null;
    return candidate;
  };

  // 1) 段落単位で末尾から落とす（空行区切り＝投稿の見た目の塊）
  const blocks = original.split(/\n\s*\n/);
  for (let n = blocks.length - 1; n >= 1; n--) {
    const hit = accept(blocks.slice(0, n).join('\n\n').trim());
    if (hit) return hit;
  }

  // 2) 段落で足りなければ文単位で落とす
  //    行の切れ目も文の切れ目として扱う（Xの投稿は改行で区切ることが多い）
  const sentences = original.match(/[^.!?。！？\n]+(?:[.!?。！？]+|\n+|$)/g) || [];
  for (let n = sentences.length - 1; n >= 2; n--) {
    const hit = accept(sentences.slice(0, n).join('').trim());
    if (hit) return hit;
  }

  return null;
}

/** 中身のある行の数。空行は数えない。 */
function countLines_(text) {
  return String(text || '').split('\n').filter(function (l) {
    return l.trim().length > 0;
  }).length;
}

/* ------------------------------------------------------------------ */
/* プロンプト組み立て                                                  */
/* ------------------------------------------------------------------ */

/** アカウント別のsystem prompt。プロパティが未設定なら既定値を使い、変数を差し込む。 */
function buildSystemPrompt_(accountKey, region, angle, link, format, maxLenOverride) {
  const key = String(accountKey).toUpperCase();
  const lang = getLang_(key);
  /*
   * ★呼び出し側が実際に測る上限を渡してきたら、必ずそちらを使う。
   * 開示タグや固定CTAのぶんを引いた後の数字で書かせないと、
   * 「280と言われて書いた200超えの文が弾かれる」が起き続ける。
   */
  const maxLen = Number(maxLenOverride) > 0 ? Number(maxLenOverride) : getTweetMaxLen_(key);
  const custom = getProp_('LLM_PROMPT_' + key);
  const template = custom || (key === 'B' ? DEFAULT_PROMPT_B : DEFAULT_PROMPT_A);

  const regionStyle = regionStyleFor_(key, region);
  const angleBrief = ANGLE_BRIEF[angle] || ('Angle: ' + angle);
  const formatBrief = FORMAT_BRIEF[format] || ('Shape: ' + format);
  const urlBlock = buildLinkBlock_(link);

  // カスタムプロンプトでもプレースホルダを使えるようにする。
  // 使っていない場合は末尾に追記して、各要素が必ず伝わるようにする。
  let out = template
    .split('{REGION_STYLE}').join(regionStyle)
    .split('{ANGLE_BRIEF}').join(angleBrief)
    .split('{FORMAT_BRIEF}').join(formatBrief)
    .split('{ANTI_AI}').join(ANTI_AI_RULES)
    .split('{REGION}').join(region)
    .split('{ANGLE}').join(angle)
    .split('{FORMAT}').join(format)
    .split('{URL}').join(urlBlock);

  if (custom && template.indexOf('{REGION_STYLE}') === -1 && template.indexOf('{REGION}') === -1) {
    out += '\n\n# Region\n' + regionStyle;
  }
  if (custom && template.indexOf('{ANGLE_BRIEF}') === -1 && template.indexOf('{ANGLE}') === -1) {
    out += '\n\n# Angle\n' + angleBrief;
  }
  if (custom && template.indexOf('{FORMAT_BRIEF}') === -1 && template.indexOf('{FORMAT}') === -1) {
    out += '\n\n# Shape of this post\n' + formatBrief;
  }
  if (custom && template.indexOf('{ANTI_AI}') === -1) {
    out += '\n\n' + ANTI_AI_RULES;
  }
  if (custom && template.indexOf('{URL}') === -1) {
    out += '\n\n# Link\n' + urlBlock;
  }

  // 文字数と言語は必ず最後に上書きで伝える。
  // カスタムプロンプト側に古い「280字以内」等が残っていても、こちらが優先される。
  /*
   * ★上限だけでなく下限も出す。
   *
   * 以前は「上限280、目安202」しか言っていなかった。目安は的であって
   * 境界ではないので、短すぎる側には歯止めが無く、
   * 2026-08-17には掴みだけの1行投稿が実際に出てしまった。
   * 幅で示すほうが守られる。
   */
  const aimLow = Math.round(maxLen * 0.7);
  const aimHigh = Math.round(maxLen * 0.93);
  out += '\n\n# Length (overrides anything above)\n' +
         '- Write between ' + aimLow + ' and ' + aimHigh + ' characters. Count as you go.\n' +
         '- HARD LIMIT ' + maxLen + '. A post over this is thrown away unread.\n' +
         '- Under ' + aimLow + ' means you shipped a hook with no mechanism under it.';
  if (maxLen > TWEET_MAX_WEIGHTED_LENGTH) {
    out += '\n- You have room. Use line breaks and let it breathe, but never pad.';
  }
  if (lang === 'ja') {
    out += '\n\n# Language (overrides anything above)\n' +
           '- Write in Japanese, as a Japanese speaker posting on X.\n' +
           '- Use a bracket label like 【配布】【保存版】【注意】 on the first line when it fits the shape.\n' +
           '- Do not translate English phrasing. Write how Japanese posts actually read.';
  }
  return out;
}

/**
 * リンクの説明ブロックを作る。
 * URLだけ渡すと「何のリンクか」が分からず、文脈に織り込めない。
 * Linksシートのメモ列を必ず一緒に渡す。
 */
function buildLinkBlock_(link) {
  if (!link || !link.url) return 'No URL this time. Do not include any link.';

  const lines = [];
  if (link.note) {
    lines.push('What this link is: ' + link.note);
    lines.push('Write the post for someone who has the problem this solves. ' +
               'Lead with their problem, not with the product.');
  } else {
    // メモが無いと行き先が分からないため、無理に売り込ませない
    lines.push('You are not told what this link leads to, so do not describe it, ' +
               'claim what it does, or promise any result.');
    lines.push('Mention it briefly and let the post stand on its own.');
  }
  lines.push('Use this exact URL. Do not modify, shorten, or omit it. ' +
             'Do not just append it at the end as an afterthought.');
  lines.push(link.url);
  return lines.join('\n');
}

function buildUserPrompt_(acc, topicHint, link, region, angle, format, attempt, lastText,
                          subject, critique, maxLen) {
  const url = link && link.url ? link.url : '';
  const parts = ['Write one X post.'];

  parts.push('', 'Account: ' + acc.label);
  parts.push('Target region: ' + region);
  parts.push('Strategy angle: ' + angle);
  parts.push('Shape: ' + format);

  if (topicHint) {
    parts.push('', 'Facts for this post (these are given to you as true. ' +
                   'Use only what is here. Do not add numbers, dates, names, offers, ' +
                   'or steps that are not stated):', topicHint);
  } else if (subject) {
    // ★お題が無いときも「白紙」にしない。
    // 白紙で書かせると、どの分野でも通用する当たり障りのない助言になり、
    // 誰も保存もフォローもしない投稿が量産される。
    parts.push('', 'Subject for this post: ' + subject);
    parts.push('Write about something concrete inside that subject that you have ' +
               'actually dealt with. Pick one narrow situation, not the whole topic.');
    parts.push('Do not report news, offers, campaigns, or dated events, ' +
               'because you have no source for them. Your own experience is fine.');
  } else {
    parts.push('', 'No topic given. Write from general knowledge of your field. ' +
                   'Do not report news, offers, campaigns, or specific events, ' +
                   'because you have no source for them.');
  }
  if (url) {
    parts.push('', 'URL to include (exact string):', url);
    if (link.note) parts.push('This link is: ' + link.note);
  }

  if (attempt > 1 && lastText) {
    /*
     * ★2回目以降は「書き直し」ではなく「直し」。
     *
     * 以前はここで "Write a different post" と言っていた。
     * その結果、52点まで来た案を捨てて次に35点を引く、という往復が起きた。
     * 落ちた理由は冒頭1行なのに、本文まで作り直させていたのが原因。
     *
     * 指摘された箇所だけを直させ、それ以外は触らせない。
     * こうすると点は下がりようがなく、回数を重ねるほど上がる。
     */
    parts.push('', 'REVISE — do not start over.', '');
    parts.push('This is your draft. It is close. Keep it.', '"""', lastText, '"""', '');
    parts.push('One judge rejected it for exactly this reason:', critique || 'It was too long.');
    parts.push('',
      'Fix ONLY what that reason names. Everything the reason does not mention stays ' +
      'word for word as it is — same topic, same facts, same structure, same ending.',
      'If the reason is about the opening line, rewrite that line and nothing else — ' +
      'use the moves under "Turning a fact into a first line". Do not add a number ' +
      'or an experience you were not given in order to make it land.',
      'If the reason is about length, delete the weakest sentence and nothing else.',
      'Do not change the subject. Do not write about something new.',
      'Return the whole post, revised.');
  }

  if (maxLen) {
    parts.push('', 'Hard limit: ' + maxLen + ' characters. Anything longer is discarded.');
  }

  parts.push('', 'Output the post text only.');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM呼び出し                                                         */
/* ------------------------------------------------------------------ */

function getLlmApiKey_() {
  // プロパティ名は GEMINI_API_KEY / LLM_API_KEY のどちらでも受け付ける
  const key = getProp_('GEMINI_API_KEY') || getProp_('LLM_API_KEY');
  if (!key) {
    throw new Error('スクリプトプロパティ "GEMINI_API_KEY"（または "LLM_API_KEY"）が未設定です。');
  }
  return key;
}

/**
 * 現在のAPIキーで使えるモデル名の一覧を取得する。
 * @return {Array<string>} 例: ['gemini-3.6-flash', ...]
 */
function fetchGenerateContentModels_() {
  const res = UrlFetchApp.fetch(LLM_API_BASE.replace(/\/models\/$/, '/models'), {
    headers: { 'x-goog-api-key': getLlmApiKey_() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('モデル一覧の取得に失敗（HTTP ' + res.getResponseCode() + '）: ' +
                    truncate_(res.getContentText(), 200));
  }
  const models = (JSON.parse(res.getContentText()).models) || [];
  return models
    .filter(function (m) {
      return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
    })
    .map(function (m) { return String(m.name).replace(/^models\//, ''); });
}

/**
 * 使える flash 系モデルを1つ選ぶ。
 * 実験版・プレビュー版・特殊用途（画像/音声/TTS）は避け、安定版を優先する。
 * バージョン番号は名前の降順でおおむね新しい順になる（gemini-3.6 > gemini-2.5）。
 */
function discoverWorkingModel_() {
  const all = fetchGenerateContentModels_();

  const isSpecial = function (n) {
    return /(preview|exp|experimental|image|vision|tts|audio|live|embedding|thinking)/i.test(n);
  };

  const stableFlash = all.filter(function (n) {
    return /flash/i.test(n) && !/lite/i.test(n) && !isSpecial(n);
  }).sort().reverse();

  const anyFlash = all.filter(function (n) {
    return /flash/i.test(n) && !isSpecial(n);
  }).sort().reverse();

  const anyStable = all.filter(function (n) { return !isSpecial(n); }).sort().reverse();

  const picked = stableFlash[0] || anyFlash[0] || anyStable[0] || all[0];
  if (!picked) throw new Error('使用可能なモデルが見つかりませんでした。');
  return picked;
}

/**
 * @param {Object} [opt] 呼び出し単位の上書き。{ temperature: number }
 *   ★採点のような判定タスクは temperature を下げて呼ぶ。既定は生成向けの0.85。
 */
function callLLM_(systemPrompt, userPrompt, opt) {
  try {
    return callLLMOnce_(systemPrompt, userPrompt, opt);
  } catch (err) {
    // モデル名が廃止された場合だけ、現行モデルを探して自動復旧する。
    // それ以外のエラー（キー不正・レート上限・安全フィルタ）は握りつぶさずそのまま投げる。
    if (!(err instanceof ModelNotFoundError)) throw err;

    const previous = getProp_('LLM_MODEL', LLM_DEFAULT_MODEL);
    console.warn('モデルが見つからないため自動探索します: ' + err.message);
    const found = discoverWorkingModel_();

    // ★探し当てただけで本番投稿を再開しない。
    // 名前が存在することと、期待した形のJSONを返すことは別問題。
    // 通らないモデルに切り替えて大量投稿を再開すると、失敗が量産される。
    const probe = probeModel_(found);
    if (!probe.ok) {
      const msg = 'Geminiのモデル自動切替に失敗しました。\n' +
                  '旧: ' + previous + '\n候補: ' + found + '\n理由: ' + probe.reason;
      triggerEmergencyStop_(null, msg);
      throw new Error(msg);
    }

    props_().setProperty('LLM_MODEL', found);
    console.warn('LLM_MODEL を "' + found + '" に自動更新しました。');
    notifyAdmin_([
      '🔧 Geminiモデル変更',
      '',
      '旧: ' + previous,
      '新: ' + found,
      '',
      '理由: 404 / 提供終了',
      '疎通確認: OK（テキスト生成・JSON形式ともに確認済み）'
    ].join('\n'));

    return callLLMOnce_(systemPrompt, userPrompt, opt);
  }
}

/**
 * 切り替え先のモデルが本当に使えるかを、最小のリクエストで確かめる。
 *
 * 見るのは3点。
 *   1. APIへ到達できるか
 *   2. テキストを生成して返せるか
 *   3. 期待した形（JSON）で返せるか
 * ここを通らないモデルに切り替えても、本番で失敗するだけ。
 *
 * @return {{ok:boolean, reason:string}}
 */
function probeModel_(model) {
  const saved = getProp_('LLM_MODEL', '');
  try {
    props_().setProperty('LLM_MODEL', model);
    const out = callLLMOnce_(
      'Reply with JSON only.',
      'Return exactly this JSON and nothing else: {"ok":true}');

    if (!out || !String(out).trim()) return { ok: false, reason: '空の応答が返りました' };

    let parsed = null;
    try {
      parsed = JSON.parse(extractJson_(String(out)));
    } catch (e) {
      return { ok: false, reason: 'JSON形式で返せませんでした: ' + truncate_(String(out), 120) };
    }
    if (!parsed || parsed.ok !== true) {
      return { ok: false, reason: '想定した構造で返りませんでした: ' + truncate_(String(out), 120) };
    }
    return { ok: true, reason: '' };

  } catch (e) {
    return { ok: false, reason: truncate_(String(e && e.message ? e.message : e), 200) };
  } finally {
    // 判定中に書き換えた設定は必ず戻す。採用は呼び出し側の責任。
    if (saved) props_().setProperty('LLM_MODEL', saved);
    else props_().deleteProperty('LLM_MODEL');
  }
}

/** モデル名が無効（404）であることを示す。自動探索の起点。 */
class ModelNotFoundError extends Error {
  constructor(model) {
    super('モデル "' + model + '" が見つかりません（404）。');
    this.name = 'ModelNotFoundError';
    this.model = model;
  }
}

function callLLMOnce_(systemPrompt, userPrompt, opt) {
  const apiKey = getLlmApiKey_();
  const model = getProp_('LLM_MODEL', LLM_DEFAULT_MODEL);
  const url = LLM_API_BASE + encodeURIComponent(model) + ':generateContent';

  /*
   * ★temperature は呼び出し側で上書きできる。
   *
   * 既定の0.85は「文章を書かせる」ための値。
   * 採点にこの値を使うと、同じ文が呼ぶたびに違う点になる。
   * 実測の 35 / 52 / 35 は文章の差ではなく、この揺れを見ていた可能性が高い。
   * 判定は分類であって創作ではないので、採点側は0で呼ぶ。
   */
  const temp = (opt && typeof opt.temperature === 'number')
    ? opt.temperature
    : LLM_TEMPERATURE;

  const baseConfig = {
    temperature: temp,
    maxOutputTokens: LLM_MAX_TOKENS
  };

  /*
   * ★思考を最小にする指定。280字の投稿文に多段の推論は要らず、
   * 思考トークンは maxOutputTokens から引かれるため、放置すると本文が切れる。
   *
   * 【2026-08-16 の事故】ここに thinkingLevel: 'none' と書いていた。
   * 'none' は存在しない値で400になり、フォールバックが thinkingConfig ごと
   * 削除したため、思考が既定値のまま走って2048トークンを食い切り、
   * 手順書の断片（"Step 3: ... (Verb: Exec..."）が返ってきた。
   * 「無効な値 → 制御を全部捨てる」フォールバックが事態を悪化させていた。
   *
   * 一次情報で確認した仕様（Gemini API 公式ドキュメント）：
   *   - thinkingLevel … Gemini 3系。MINIMAL / LOW / MEDIUM / HIGH の4つのみ。
   *                     'none' は無い。Gemini 2.5系は非対応
   *   - thinkingBudget … Gemini 2.5系。0 で思考を無効化
   *   - 両方を同時に送ると400
   * よって「minimal → budget 0 → 指定なし」の順に1段ずつ落とす。
   */
  const configVariants = [
    { label: 'thinkingLevel=minimal', thinkingConfig: { thinkingLevel: 'minimal' } },
    { label: 'thinkingBudget=0',      thinkingConfig: { thinkingBudget: 0 } },
    { label: 'thinkingConfig なし',    thinkingConfig: null }
  ];

  const buildPayload = function (variant) {
    const gen = JSON.parse(JSON.stringify(baseConfig));
    if (variant.thinkingConfig) gen.thinkingConfig = variant.thinkingConfig;
    return {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: gen
      // safetySettings は指定していない（提供元の既定値のまま動かす）。
      // フィルタに掛かった場合は下で理由を切り分けて返す。
    };
  };

  let code = 0;
  let body = '';

  for (let i = 0; i < configVariants.length; i++) {
    const variant = configVariants[i];
    const res = fetchWithRetry_(url, {
      method: 'post',
      contentType: 'application/json',
      // キーはURLのクエリではなくヘッダで渡す。URLに載せるとログや履歴に残りやすいため。
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(buildPayload(variant)),
      muteHttpExceptions: true
    });
    code = res.getResponseCode();
    body = res.getContentText();

    // 思考指定が拒否された時だけ、次の書き方へ落とす。
    // それ以外の400（キー不正など）でむやみに叩き直さない。
    if (code === 400 && /thinking/i.test(body) && i < configVariants.length - 1) {
      console.warn(variant.label + ' が拒否されました。次の指定方法を試します: ' +
                   configVariants[i + 1].label);
      continue;
    }
    break;
  }

  if (code !== 200) {
    console.error('Gemini APIエラー ' + code + ': ' + truncate_(body, 400));
    if (code === 400 && /API key not valid/i.test(body)) {
      throw new Error('APIキーが無効です（400）。GEMINI_API_KEY を確認してください。');
    }
    if (code === 403) {
      throw new Error('Gemini APIへのアクセスが拒否されました（403）。' +
        'キーの権限、または Generative Language API が有効かを確認してください。');
    }
    if (code === 404) {
      // 呼び出し元(callLLM_)が捕捉し、現行モデルを探して自動的に再試行する
      throw new ModelNotFoundError(model);
    }
    if (code === 429) {
      throw new Error('Gemini APIのレート上限に達しました（429）。' + truncate_(body, 200));
    }
    throw new Error('Gemini APIエラー（HTTP ' + code + '）: ' + truncate_(body, 300));
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error('Geminiの応答をJSONとして解釈できませんでした: ' + truncate_(body, 200));
  }

  const blockReason = parsed && parsed.promptFeedback && parsed.promptFeedback.blockReason;
  if (blockReason) {
    throw new Error('Geminiがプロンプトを拒否しました（blockReason: ' + blockReason + '）。');
  }

  const candidate = parsed && parsed.candidates && parsed.candidates[0];
  if (!candidate) {
    throw new Error('Geminiが応答を返しませんでした: ' + truncate_(body, 300));
  }

  // parts のインデックスを決め打ちしない。
  // 思考プロセス等で要素数が変動しうるため、text を持つ要素を全て連結する。
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts
    .map(function (p) { return p && typeof p.text === 'string' ? p.text : ''; })
    .filter(String)
    .join('')
    .trim();

  /*
   * ★上限に当たった時、思考に何トークン使われたかを必ず添える。
   *
   * 2026-08-16、思考が既定値のまま走って上限を食い切る事故が起きたが、
   * エラー文が「上限で打ち切られました」としか言わなかったため、
   * 原因が思考なのか本文が長すぎるのかを切り分けられなかった。
   * usageMetadata.thoughtsTokenCount を見れば一目で分かる。
   */
  const usage = (parsed && parsed.usageMetadata) || {};
  const thoughts = Number(usage.thoughtsTokenCount || 0);
  const budgetNote = '（上限 ' + LLM_MAX_TOKENS + ' / うち思考 ' + thoughts + '）' +
    (thoughts > LLM_MAX_TOKENS * 0.5
      ? ' 思考が出力枠の大半を消費しています。thinkingConfig が効いていない可能性があります。'
      : '');

  if (!text) {
    const reason = candidate.finishReason || '不明';
    if (reason === 'SAFETY') {
      throw new Error('Geminiが安全フィルタで生成を停止しました（finishReason: SAFETY）。' +
        'この内容はGeminiでは生成できません。表現を調整するか、別のプロバイダを検討してください。');
    }
    if (reason === 'MAX_TOKENS') {
      throw new Error('生成がトークン上限で打ち切られました（MAX_TOKENS）。' + budgetNote);
    }
    throw new Error('Geminiが本文を返しませんでした（finishReason: ' + reason + '）。');
  }

  // ★本文があっても finishReason は必ず見る。
  // ここを見ていなかったため、トークン上限で切れた断片
  //   "Multi-step form drop-offs usually happen on step one because `autocomplete"
  // がそのまま投稿されていた。中途半端な文を出すくらいなら投稿しない方がよい。
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('生成がトークン上限で打ち切られました（MAX_TOKENS）。' + budgetNote +
                    ' 途中で切れた文は投稿しません: ' + truncate_(text, 80));
  }

  return text;
}

/**
 * LLM出力の後始末。
 * 指示しても引用符やコードブロックで囲んでくることがあるため、機械的に剥がす。
 */
function sanitizeGeneratedText_(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');   // コードブロック
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '');        // 前後の引用符

  // ★バッククォートを落とす。
  // 実際に "because `autocomplete" のような形で投稿されていた。
  // 人が書いた文には出てこない記号で、機械が書いたことが一目で分かる。
  t = t.replace(/`+/g, '');

  // 見出し記号・強調記号の残骸
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');

  return t.trim();
}

/* ------------------------------------------------------------------ */
/* 動作確認（エディタから手動実行する）                                 */
/* ------------------------------------------------------------------ */

/**
 * 現在このAPIキーで使えるモデルの一覧を取得する。
 * モデル名の改廃が早く、404の原因特定に毎回手間が掛かるため、実測で確定させる。
 * ここに出た名前をスクリプトプロパティ LLM_MODEL に設定すればよい。
 */
function listAvailableModels() {
  try {
    const usable = fetchGenerateContentModels_();
    const lines = ['=== generateContent が使えるモデル ===',
                   '現在の設定: LLM_MODEL = ' + getProp_('LLM_MODEL', LLM_DEFAULT_MODEL + '（既定値）'),
                   '自動探索で選ばれる候補: ' + discoverWorkingModel_(),
                   ''];
    usable.forEach(function (n) { lines.push('  ' + n); });
    if (!usable.length) lines.push('  (該当なし)');
    console.log(lines.join('\n'));
  } catch (err) {
    console.error('モデル一覧の取得に失敗: ' + (err && err.message ? err.message : err));
  }
}

/** 現在のJST時刻でどの地域が選ばれるかを確認する。 */
function showRegionSchedule() {
  const hour = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'H'));
  console.log([
    '現在のJST: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') + '（' + hour + '時台）',
    '今この瞬間に選ばれる地域: ' + pickRegionByJstHour_(),
    '',
    '【時間帯の割り当て】',
    '  JST 08:00-14:00 → US または CA',
    '  JST 15:00-23:00 → AU',
    '  JST 00:00-07:00 → UK',
    '',
    getProp_('LLM_REGIONS')
      ? '※ LLM_REGIONS が設定されているため、時間帯を無視してランダム選択されます。'
      : '※ LLM_REGIONS を設定すると、時間帯判定を無効化してランダム選択に切り替わります。'
  ].join('\n'));
}

/** 投稿せずに生成結果だけ確認する。プロンプト調整用。 */
function testGenerateA() { logGeneratedSample_('A'); }
function testGenerateB() { logGeneratedSample_('B'); }

/** 地域×角度の組み合わせを5本まとめて出す。文体の振れ幅を見るため。 */
function testGenerateA5() { logGeneratedSamples_('A', 5); }
function testGenerateB5() { logGeneratedSamples_('B', 5); }

function logGeneratedSample_(accountKey) {
  logGeneratedSamples_(accountKey, 1);
}

function logGeneratedSamples_(accountKey, count) {
  const link = pickRandomLink_(accountKey);
  const lines = ['=== ' + getAccount_(accountKey).label + ' の生成結果（未投稿）===',
                 'リンク: ' + ((link && link.url) || '(なし)') +
                   (link && link.note ? '（' + link.note + '）' : ''),
                 'プロンプト: ' + (getProp_('LLM_PROMPT_' + accountKey) ? 'カスタム（プロパティ）' : '既定値'),
                 ''];

  for (let i = 1; i <= count; i++) {
    try {
      const r = generateTweet(accountKey, link, '');
      lines.push('--- ' + i + ' [' + r.region + ' / ' + r.angle + ' / ' + (r.format || '-') + '] ' +
                 estimateWeightedLength_(r.text) + '字 ---');
      lines.push(r.text, '');
    } catch (err) {
      lines.push('--- ' + i + ' 失敗 ---');
      lines.push(String(err && err.message ? err.message : err), '');
    }
  }
  console.log(lines.join('\n'));
}
