/**
 * ===========================================================================
 * 28_Buzz.gs  —  バズ特化モード（リンクなし・メディア主体）
 * ===========================================================================
 *
 * ★何のためか（オーナー指示 2026-08-20：「XのViewが少ない」）
 *
 * Xは外部リンクを含む投稿の到達を落とす。これは公開されている挙動で、
 * 「検知を欺く」話ではない。リンクを貼らないという編集判断であって、
 * BAN検知の回避機構ではない（CLAUDE.md「変更してはいけないもの」を参照）。
 * 回避機構は実装しない。ここでやるのは「リンクを貼らない投稿を作る」だけ。
 *
 * ★既存の POST_KIND_HUMAN との違い
 *
 *   HUMAN … 「人が書いたように読める投稿」。話し方の話
 *   BUZZ  … 「返信したくなる投稿」。反応を取りに行く話
 *
 * 別物なので種類を分けた。HUMANのプロンプトを流用すると、
 * 落ち着いた良い文章が出てきて、誰も返信しない。
 *
 * ★見つかっていた穴（この実装の主目的）
 *
 * 固定CTA(22_FixedCta.gs)は postTweet_ の中で全投稿に足される。
 * つまり「リンクの無い投稿」として作った本文にも、送信直前にURLが付く。
 * BUZZモードを名乗るだけでは意味がなく、ここを塞がないと成立しない。
 *   → assertNoLinksForBuzz_() を送信の直前に置く。
 */

/** 投稿の種類。24_PostMix.gs の POST_KIND_* と同じ空間。 */
const POST_KIND_BUZZ = 'BUZZ';

/**
 * バズ投稿にハッシュタグを何個付けるか（オーナー指示：3〜5）。
 *
 * ★上限を5で止める理由：Xはタグを詰めた投稿をスパム的として扱う。
 * 本文が短いほどタグの比率が上がるので、こちらで頭打ちにしておく。
 */
/**
 * 候補のサムネイルを何枚まで試すか。
 *
 * ★8枚→3枚（2026-08-24）。
 * 粘るほど良いと思って増やしたが、1枚ごとにXへのアップロードが走る。
 * 投稿0本のままクレジットが尽きた。Xが拒否した場合は遮断器が
 * 1回目で打ち切るので、ここで粘る意味は「CDN側の欠損」の救済だけ。
 */
const BUZZ_IMAGE_TRIES = 3;

/**
 * 手動実行の時、いくつの話題を試すか。
 * ★候補は73〜188件あるのに1件しか試していなかった。
 * 話題との相性で採点が落ちることはあるので、順に試す（2026-08-22）。
 */
const BUZZ_TOPIC_TRIES = 3;

const BUZZ_HASHTAG_MIN = 3;
const BUZZ_HASHTAG_MAX = 5;

/**
 * バズモードを使うか。既定は有効。
 *
 * ★★アカウント別に切れるようにした（2026-08-27、オーナー指示
 *   「今のXのくそ動画はあかん」）。
 *
 *   BUZZ_MODE_A = 0  … Aだけ止める
 *   BUZZ_MODE   = 0  … 両方止める（従来どおり）
 *
 * Aは「実在するGitHubリポジトリの紹介」でリンククリック1/15（CTR 6.7%）を
 * 取れており、これは在庫映像を貼る投稿より確実に効いている。一方Bは
 * 見せる画のあるアカウントなので、片方だけ止められないと
 * 「両方止める」か「両方我慢する」の二択になる。
 *
 * @param {?string} accountKey 省略時は全体設定だけを見る
 */
function buzzModeEnabled_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  if (key) {
    const per = String(getProp_('BUZZ_MODE_' + key, '')).trim();
    if (per !== '') return per !== '0';
  }
  return String(getProp_('BUZZ_MODE', '1')) !== '0';
}

/** どれか1つでもバズモードが生きているアカウントがあるか。 */
function anyBuzzModeEnabled_() {
  return Object.keys(ACCOUNTS).some(function (k) { return buzzModeEnabled_(k); });
}

/* ------------------------------------------------------------------ */
/* 2. 外部URLの完全遮断（Kill Switch）                                  */
/* ------------------------------------------------------------------ */

/**
 * バズ投稿にURLが混ざっていないか検査する。混ざっていたら例外。
 *
 * ★なぜ「取り除く」のではなく「止める」のか
 *
 * 黙って削ると、本文が「詳しくはこちら →」で終わった不自然な投稿が出る。
 * URLが入っている時点で、その本文はリンク前提で書かれている。
 * 直すべきは本文であって、URLだけ抜いた残骸を出すことではない。
 * 止めれば次のトリガーで作り直される。1本落ちるコストの方が小さい。
 *
 * ★http/https だけでなく素のドメインも見る
 *
 * 指示は「http/https から始まるURL」だったが、Xは `example.com` のような
 * 素のドメインも自動でリンクにする。リンクを貼らないことが目的なので、
 * 見るべきは書き方ではなく「リンクになるかどうか」。
 *
 * 誤検知を避けるため、素のドメインは実在するTLDに限る。
 * `Node.js` `3.5秒` `v1.2` などを弾かないため。
 *
 * @param {string} text 送信直前の本文（CTA適用後）
 * @throws {Error} URLが含まれる場合
 */
function assertNoLinksForBuzz_(text) {
  const s = String(text || '');

  if (/https?:\/\/\S+/i.test(s)) {
    throw new Error(
      'バズ投稿にURLが含まれています。リンク無しが条件のため送信を中止しました。\n' +
      '本文: ' + truncate_(s, 120));
  }

  // 素のドメイン（www付き、または よく使われるTLD）。前後は語境界で区切る。
  const bare = /(^|[\s(（"'])((www\.[a-z0-9-]+\.[a-z]{2,})|([a-z0-9-]{2,}\.(com|net|org|io|jp|co|gg|tv|me|app|dev|link|shop|store|ai|xyz)))(\/|\b)/i;
  if (bare.test(s)) {
    throw new Error(
      'バズ投稿にリンクとして解釈されうるドメインが含まれています。送信を中止しました。\n' +
      '本文: ' + truncate_(s, 120));
  }
}

/** 例外を投げずに真偽だけ返す版（生成側の再試行判定に使う）。 */
function buzzTextIsClean_(text) {
  try { assertNoLinksForBuzz_(text); return true; }
  catch (e) { return false; }
}

/* ------------------------------------------------------------------ */
/* 4. プロンプトの動的切り替え                                          */
/* ------------------------------------------------------------------ */

/**
 * バズ投稿のプロンプト。セールスライティングは一切入れない。
 *
 * ★狙いは「返信」であって「いいね」ではない
 * いいねは一方通行で終わるが、返信は会話になり、会話は表示回数を伸ばす。
 * だから摩擦（ツッコミどころ・反論の余地・強い共感）を作りに行く。
 *
 * ★ただし「釣り」にはしない
 * 事実に反することを書けば、訂正の返信で伸びても信用が減る。
 * 短期の数字と引き換えにアカウントを削るのは、この設計の目的と逆。
 *
 * @param {string} accountKey
 * @param {string} topic 材料（RSS/Redditから来た話題）
 * @param {number} maxLen 本文の上限（重み付き）
 */
function buildBuzzPrompt_(accountKey, topic, maxLen, onScreen, mediaKind) {
  const key = String(accountKey || '').toUpperCase();
  const limit = Number(maxLen) || 240;
  const shows = String(onScreen || '').trim();

  /*
   * ★★静止画なのか動画なのかを必ず伝える（2026-08-27）。
   *
   * 以前は付くものが写真でも "the footage attached" と書いていた。
   * LLMは動画が付く前提で書くので、静止画1枚に
   *   "Slow motion ruins clips like this."
   * が付いて投稿された。読み手には、存在しない動画について
   * 語っているように見える。事実に反する投稿は伸びても信用を削る。
   */
  const isStill = String(mediaKind || '') === 'image';
  const mediaWord = isStill ? 'a single still photo' : 'a video clip';

  const common = [
    '# Your job',
    'Write ONE short post for X that makes people want to reply.',
    'Not like it. Not share it. REPLY to it.',
    '',
    '# What earns a reply',
    'A reply happens when the reader has something to say back. Give them that:',
    '- a claim they can argue with',
    '- a preference they will defend',
    '- something they thought only they did',
    '',
    '# Hard rules',
    '- NO links. No URLs, no domains, not even a bare one. This is absolute.',
    '- NO call to action. Do not say "let me know", "thoughts?", "comment below".',
    '  Asking for a reply is the weakest way to get one. Earn it with the take.',
    /*
     * ★上限そのものを渡すと毎回ぎりぎりを狙って超える（実機で3回連続）。
     * 本文の目標を6割に置き、上限は「絶対に超えない線」として別に示す。
     */
    '- Body text: aim for about ' + Math.round(limit * 0.6) + ' characters.',
    '  Hard ceiling is ' + limit + ' INCLUDING hashtags. Shorter always wins.',
    '- Do not invent numbers, studies, or prices. If you are not sure, do not say it.',
    '- Do not open with a definition ("X is a ...") or an empty question',
    '  ("Have you ever wondered...?"). Both read as filler and get scrolled past.',
    '',
    '# Sound like a person mid-thought, not a summary',
    'AI copy reads as tidy: intro, point, wrap-up, balanced on both sides.',
    'A real post reads as one thought caught mid-flight. So:',
    '- Do NOT structure it like a mini-essay (setup -> point -> neat conclusion).',
    '  Land the opinion first or mid-sentence, let the reasoning trail after it.',
    '- Take one side. No "some people think X, others think Y". Commit to a take.',
    '- Name the exact thing, not the category. Not "a keyboard" -- which keyboard.',
    '  Not "a snack" -- what you actually ate. Specifics read as lived, not written.',
    '- Uneven rhythm reads real. Do not make every sentence the same length.',
    '  A short punch next to a longer one that trails off is fine.',
    '- It is fine to end on the opinion itself, without wrapping it up neatly.',
    '  A tidy final sentence that restates the point is the most AI-sounding part.',
    '',
    '# Hashtags',
    '- Exactly ' + BUZZ_HASHTAG_MIN + ' to ' + BUZZ_HASHTAG_MAX + ' hashtags, on the last line.',
    '- Tags people actually browse, not invented ones.',
    '- No hashtag inside a sentence. They go at the end only.',
    ''
  ];

  const perAccount = (key === 'B')
    ? [
        /*
         * ★★2026-08-24、オーナー指示でBの土俵を「セクシー寄り」へ寄せた。
         *
         * 寄せたのは温度であって、下品さではない。露骨に書くと
         * Xのフィルターに触れて表示が絞られ、伸びる前に終わる。
         * 効くのは「言い切らない」方。それは規約対策であると同時に、
         * 実際にそちらの方が反応が多い。
         *
         * ★3本の絶対ラインは温度と無関係に維持する（下の Never）。
         */
        '# Voice',
        'You run an account for English speakers who are into Japanese',
        'anime, doujin and idol culture. You are a fan, not a store.',
        'Playful, a little shameless, never crude. Strong opinions about',
        'characters, art styles and taste land well.',
        '',
        '# Temperature',
        'Suggestive is fine. Explicit is not — and not for prudish reasons:',
        'explicit copy gets the post filtered and it dies before it spreads.',
        'Imply, do not describe. Understatement outperforms.',
        '',
        '# Never (these are absolute, no exceptions)',
        '- Never sexualize a real, named or identifiable person.',
        '- Never imply leaked, stolen, hacked or uncensored material.',
        '- Never write anything that could read as being about a minor.',
        '  No school settings, no ages, no "young". If a line is ambiguous,',
        '  it is wrong — rewrite it.'
      ]
    : [
        /*
         * ★★2026-08-24、オーナー指示「ニッチな作業映像やASMRは一切不要」。
         * 工具・ガジェット語りから、言語の壁を越える大衆向けエンタメへ。
         */
        '# Voice',
        'You run an account about moments that make people say "no way".',
        'Stunts, records, huge experiments, things going spectacularly wrong.',
        'You are the friend who sends the clip, not the narrator explaining it.',
        'Short. Loud. No setup.',
        '',
        '# Turning a fact into a friction hook',
        'FLAT : This stunt required a lot of preparation.',
        'HOOK : Somebody signed off on this and I want to meet them.',
        '',
        'FLAT : The crowd reacted strongly to the result.',
        'HOOK : The guy in row three lost his mind before it even landed.'
      ];

  const tail = [
    '',
    /*
     * ★動画が付く前提であることを明示する（2026-08-22）。
     * 「話題」としてだけ渡すと、映像と無関係な一般論を書いてくる。
     * 読み手は文章より先に映像を見るので、噛み合っていないと即離脱する。
     *
     * ★★2026-08-24、「画面に映っているもの」と「話題」を分けた。
     * 以前は話題の見出しを "the video attached" として渡していたが、
     * 実際に付く映像は別物だった。LLMへ嘘を教えれば、
     * 出てくる本文も映像と食い違う。分けた上で、どちらも本当にする。
     */
    '# What is on screen and what is the topic',
    String(topic || '').slice(0, 1200),
    '',
    '# The one rule that decides whether this works',
    'Media IS attached. The reader sees it before they read a single word.',
    'What is attached is ' + mediaWord + '.',
    shows
      ? ('What they see is: ' + shows.slice(0, 200) + '\n' +
         'Your post MUST make sense while that is on screen.\n' +
         'Anchor the opening to something visible in it. Then bring in\n' +
         'your take on the topic.\n' +
         'If your post would read exactly the same with a different image\n' +
         'behind it, it is wrong. Rewrite it so it could not.')
      : ('Write about the thing itself, concretely enough that an image of it\n' +
         'would match your words.'),
    /*
     * ★静止画の回に動きの話を禁じる。ここが今回の事故の直接の原因。
     *   検索語に含まれる撮り方(slow motion)を画面の説明だと誤解して
     *   「スローが台無し」と書いた。語の側は別途直したが、
     *   話題の見出しに動画由来の語が入ることは今後もある。
     */
    isStill
      ? ('It is a PHOTO. Nothing moves. Do NOT mention slow motion, speed,\n' +
         'frame rate, replays, "watch him", "at full speed", or anything that\n' +
         'only makes sense for a video. Writing about motion here is a lie\n' +
         'the reader can see. React to the still image and the topic instead.')
      : 'Do NOT narrate it ("this video shows...", "watch how...").',
    'React to it like someone who just saw it and had one strong thought.',
    '',
    '# Output',
    'Return ONLY the post text. No quotes, no explanation, no code fences.'
  ];

  return common.concat(perAccount).concat(tail).join('\n');
}

/* ------------------------------------------------------------------ */
/* ハッシュタグの検査・調整                                             */
/* ------------------------------------------------------------------ */

/** 本文中のハッシュタグを列挙する。 */
function extractHashtags_(text) {
  const m = String(text || '').match(/#[^\s#]+/g);
  return m || [];
}

/**
 * ハッシュタグの数を 3〜5 に収める。
 *
 * ★多すぎる場合は後ろから削る。少なすぎる場合は足さない。
 * こちらで勝手にタグを足すと、内容と関係ないタグが付いて質が落ちる。
 * 足りない回は生成をやり直す方が正しい（呼び出し側が判断する）。
 *
 * @return {{text:string, count:number, trimmed:number}}
 */
function normalizeBuzzHashtags_(text) {
  const tags = extractHashtags_(text);
  if (tags.length <= BUZZ_HASHTAG_MAX) {
    return { text: String(text || ''), count: tags.length, trimmed: 0 };
  }

  // 超過分を末尾から削る（先頭のタグほど本命であることが多い）
  let out = String(text);
  const excess = tags.slice(BUZZ_HASHTAG_MAX);
  excess.forEach(function (t) {
    // 最後の1個だけ消す。同じタグが複数あっても全部は消さない
    const at = out.lastIndexOf(t);
    if (at >= 0) out = out.slice(0, at) + out.slice(at + t.length);
  });
  out = out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: out, count: BUZZ_HASHTAG_MAX, trimmed: excess.length };
}

/** ハッシュタグ数が要件を満たすか。 */
function buzzHashtagCountOk_(text) {
  const n = extractHashtags_(text).length;
  return n >= BUZZ_HASHTAG_MIN && n <= BUZZ_HASHTAG_MAX;
}

/* ------------------------------------------------------------------ */
/* 決定的な整形（LLMに直させない）                                       */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-22、これが無かったせいで投稿が出せていなかった。
 *
 * 「280字を超えた」「タグが2個しかない」は、コードで確実に直せる。
 * それをLLMへ「短くして」と投げ返し、3回失敗したら投稿を捨てていた。
 * 実機で [A] が Too long のまま3回とも落ちて1本も出なかった。
 *
 * 機械的に直せるものを、確率的な相手に頼ってはいけない。
 * 直せないもの（リンク混入・B の3本の線・採点）だけをLLMへ返す。
 */

/** 数が足りない時に足すタグ。人が browse する実在のタグだけ。 */
const BUZZ_FALLBACK_TAGS = {
  A: ['#tech', '#gadgets', '#design'],
  B: ['#doujin', '#manga', '#anime']
};

function buzzFallbackTags_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return (BUZZ_FALLBACK_TAGS[key] || BUZZ_FALLBACK_TAGS.A).slice();
}

/**
 * 本文を上限内に収める。文の切れ目で切り、無ければ単語の切れ目で切る。
 * 途中の単語を割らない（割ると明らかに機械が切った跡になる）。
 */
function trimToWeighted_(text, budget) {
  let t = String(text || '').trim();
  if (estimateWeightedLength_(t) <= budget) return t;

  // 文の切れ目を優先して落としていく
  while (t && estimateWeightedLength_(t) > budget) {
    const cut = Math.max(
      t.lastIndexOf('. '), t.lastIndexOf('。'),
      t.lastIndexOf('! '), t.lastIndexOf('? '),
      t.lastIndexOf('\n')
    );
    if (cut > 20) { t = t.slice(0, cut + 1).trim(); continue; }
    break;
  }
  // それでも入らなければ単語の切れ目で
  while (t && estimateWeightedLength_(t) > budget) {
    const sp = t.lastIndexOf(' ');
    if (sp > 20) { t = t.slice(0, sp).trim(); continue; }
    t = t.slice(0, Math.max(0, t.length - 1)).trim();
  }
  return t.replace(/[,\-–—:;]$/, '').trim();
}

/**
 * 長さとハッシュタグ数を、コード側で確実に満たす形へ整える。
 *
 * @return {string} 整形後の本文。整形しても成立しない場合は空文字
 */
function repairBuzzText_(accountKey, text, maxLen) {
  const limit = Number(maxLen) || 240;
  let raw = String(text || '').trim();
  if (!raw) return '';

  // --- タグを本文から切り離す ---
  const found = extractHashtags_(raw);
  let body = raw;
  found.forEach(function (t) { body = body.split(t).join(' '); });
  body = body.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();

  // --- タグを決める（重複を除き、足りなければ補う）---
  const seen = {};
  const tags = [];
  found.forEach(function (t) {
    const k = t.toLowerCase();
    if (seen[k] || tags.length >= BUZZ_HASHTAG_MAX) return;
    seen[k] = true;
    tags.push(t);
  });
  buzzFallbackTags_(accountKey).forEach(function (t) {
    const k = t.toLowerCase();
    if (seen[k] || tags.length >= BUZZ_HASHTAG_MIN) return;
    seen[k] = true;
    tags.push(t);
  });
  if (tags.length < BUZZ_HASHTAG_MIN) return '';   // 補ってもなお足りない

  const tagLine = tags.join(' ');
  // 本文とタグ行の間の空行ぶん（2文字）も見込む
  const budget = limit - estimateWeightedLength_(tagLine) - 2;
  if (budget < 20) return '';                       // タグだけで埋まる異常値

  body = trimToWeighted_(body, budget);
  if (!body) return '';

  return body + '\n\n' + tagLine;
}

/* ------------------------------------------------------------------ */
/* 3. メディアの取得                                                    */
/* ------------------------------------------------------------------ */

/**
 * バズ投稿に付けるメディアを1つ選ぶ。
 *
 * ★リンクを捨てる以上、目を止める要素はメディアしか残らない。
 * 文字だけのバズ投稿は、フォロワーが少ない段階ではまず伸びない。
 *
 * ★出所は既に無料で取れている情報源（Reddit/RSS）の画像を使う。
 * 新しい課金APIを増やさない。
 *
 * @return {?{mediaId:string, sourceUrl:string, title:string}}
 */
function pickBuzzMedia_(accountKey, candidates) {
  if (!mediaUploadEnabled_()) return null;

  const list = (candidates || []).filter(function (c) {
    return c && c.imageUrl;
  });
  if (!list.length) return null;

  // 反応が多かったものから試す。1つ失敗しても次を試す
  const sorted = list.slice().sort(function (a, b) {
    return (Number(b.views) || 0) - (Number(a.views) || 0);
  });

  /*
   * ★3本で諦めていた（2026-08-22に8本へ）。
   * 候補は73〜188件あるのに上位3件が全部だめだと画像を諦めていた。
   * サムネイルは消えていることが珍しくないので、もっと粘る。
   */
  for (let i = 0; i < Math.min(BUZZ_IMAGE_TRIES, sorted.length); i++) {
    const c = sorted[i];
    let mediaId = null;
    try {
      mediaId = uploadMediaToX_(accountKey, c.imageUrl);
    } catch (e) {
      console.warn('バズ用メディアのアップロードに失敗（次を試します）: ' + e);
    }
    if (mediaId) {
      return { mediaId: String(mediaId), sourceUrl: c.url || '', title: c.title || '' };
    }
  }
  return null;
}

/*
 * ★メディアが用意できなかった時、どの段階で落ちたのかを残す。
 *
 * ★★2026-08-22、これが無かったせいで実機の [B] が
 * 「メディアを用意できなかった」としか出ず、素材が取れないのか
 * Xへのアップロードが失敗しているのか切り分けられなかった。
 * 素材取得の失敗理由(videoFetchFailure_)だけでは、
 * 「取得は成功したがアップロードで落ちた」場合に空になる。
 */
let lastMediaFailure_ = '';

/** 直前にメディアを用意・送信できなかった理由。LINEの返信に載せる。 */
function mediaFailureReason_() { return lastMediaFailure_; }

/*
 * ★★pickBuzzVideo_ / pickBuzzMediaOrVideo_ を削除した（2026-08-24）。
 *
 * 本番経路は prepareBuzzMedia_（用意）と uploadBuzzMedia_（送信）の
 * 2段へ移り、あの2つはどこからも呼ばれなくなっていた。
 *
 * 「参考に残す」をやらない理由：同じ仕事をする経路が2本あると、
 * 片方だけ直した状態が必ず生まれる。実際この日、遮断器を
 * アカウント単位へ直した時に両方へ入れ忘れかけた。
 * 消せば、次に読む人がどちらが本物か迷わない。
 */


/* ------------------------------------------------------------------ */
/* メディアは「用意する」と「Xへ上げる」を分ける                          */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-24、オーナー評価「Bの動画も0点」。
 *
 * 【何が0点だったか】
 * 順番が逆だった。話題を決める → Geminiに本文を書かせる →
 * その後で無関係な在庫映像を貼る、という流れになっていた。
 * 本文はレーザー加工の話、映像はコーヒーが注がれる映像。
 * 読み手は文章より先に映像を見るので、噛み合っていない時点で終わる。
 * オーナー自身の要件「テキストと映像の完全同期」も満たしていなかった。
 *
 * 【直し方】
 * 先に映像を決め、その映像に何が映っているかを本文生成へ渡す。
 * 本文は「実際に画面で起きていること」について書かれるので、
 * 定義上ずれようがない。
 *
 * 【ついでに直ること】
 * 用意(ダウンロード)と送信(Xへのアップロード)を分けたので、
 * 本文の生成に失敗した回はXを一度も叩かない。
 * 以前は先にアップロードしてから本文で落ちており、
 * 「投稿0本なのにクレジットだけ減る」の一因になっていた。
 */

/**
 * メディアを用意する。★この段ではXを一度も叩かない。
 *
 * 降り方は 動画 → 元投稿のサムネイル → ストック写真 の順。
 *
 * @param {string} accountKey
 * @param {Array} candidates 画像へ降りる場合の候補
 * @param {string} query 素材検索の手掛かり
 * @param {string} topicTitle 元投稿の見出し（サムネイルの中身の説明）
 * @param {string} subject 撮り方を含まない被写体（写真検索と本文説明に使う）
 * @return {?{kind:string, describes:string, source:string,
 *            videoAsset:?Object, imageUrls:!Array<string>}}
 */
function prepareBuzzMedia_(accountKey, candidates, query, topicTitle, subject) {
  lastMediaFailure_ = '';

  /*
   * ★★describes には query ではなく subject を使う（2026-08-27）。
   *
   * query は素材検索用に語尾へ撮り方が付いている（Aなら "macro slow motion"）。
   * それを「画面に何が映っているか」としてLLMへ渡すと、静止画しか付いて
   * いない回にも「スローモーションが台無し」と書く。実際に投稿された。
   * 撮り方は検索の都合であって、読み手が見るものではない。
   */
  const shows = String(subject || query || '').trim();

  /*
   * --- 0) 組み立て済みの動画（36_Render.gs、2026-08-24）---
   *
   * ★★オーナー指示の本命はここ。
   *   ・単語ごとにポップするダイナミック字幕
   *   ・1〜2秒のハイペースなカット割り
   * GitHub Actions で ffmpeg が組み立てたものを回収して使う。
   *
   * 前のサイクルで頼んだ分が出来ていれば、それを最優先で使う。
   * 出来ていなければ黙って下の1本もの経路へ降りる（投稿を止めない）。
   */
  if (renderEnabled_()) {
    let done = null;
    try { done = collectRender_(accountKey); }
    catch (e) { console.warn('描画の回収で例外: ' + truncate_(String(e), 120)); }

    if (done) {
      console.log('組み立て済みの動画を使います (' + accountKey + ' / ' +
                  Math.round(done.bytes / 1024) + 'KB)');
      return {
        kind: 'video',
        describes: shows,
        source: 'rendered',
        // ★本文は描画を頼んだ時のものを使う。字幕と食い違わせない
        renderedText: String(done.text || ''),
        videoAsset: { blob: done.blob, bytes: done.bytes, source: 'rendered' },
        imageUrls: []
      };
    }
  }

  // --- 1) 動画 ---
  if (videoUploadEnabled_()) {
    let asset = null;
    try {
      asset = pickBuzzVideoAsset_(accountKey, query);
    } catch (e) {
      lastMediaFailure_ = '素材取得で例外: ' + truncate_(String(e), 80);
      console.warn('動画素材の取得で例外: ' + truncate_(String(e), 120));
    }
    if (asset) {
      return {
        kind: 'video',
        // ★在庫のQuery列＝その映像の説明。無ければ被写体を使う
        describes: String(asset.describes || shows),
        source: String(asset.source || 'stock'),
        videoAsset: asset,
        imageUrls: []
      };
    }
    if (!lastMediaFailure_) {
      let why = '';
      try {
        const f = (typeof videoFetchFailure_ === 'function') ? videoFetchFailure_() : null;
        if (f && f.reason) why = '（' + f.reason + '）';
      } catch (e) {}
      lastMediaFailure_ = '使える素材が無い' + why;
    }
  } else {
    lastMediaFailure_ = '動画添付が無効(VIDEO_UPLOAD=0)';
  }
  const videoWhy = lastMediaFailure_;

  // --- 2) 元投稿のサムネイル ---
  /*
   * ★これは「バズった元投稿そのものの画像」なので、
   * 見出しを説明として渡せば本文と噛み合う。動画の代役ではない。
   */
  const imgs = (candidates || [])
    .filter(function (c) { return c && c.imageUrl; })
    .sort(function (a, b) { return (Number(b.views) || 0) - (Number(a.views) || 0); })
    .slice(0, BUZZ_IMAGE_TRIES)
    .map(function (c) { return String(c.imageUrl); });

  if (mediaUploadEnabled_() && imgs.length) {
    return {
      kind: 'image',
      describes: String(topicTitle || shows),
      source: 'source-image',
      videoAsset: null,
      imageUrls: imgs
    };
  }

  // --- 3) ストック写真（最後の砦）---
  /*
   * ★写真は被写体だけで引く（2026-08-27）。
   *   query をそのまま渡すと "macro" が効いてマクロ撮影の自然写真が返る。
   *   実際に、ライフガードの話題にカタツムリの接写が付いて投稿された。
   */
  let photos = [];
  try { photos = stockPhotoUrls_(shows, 2) || []; }
  catch (e) { lastPhotoFailure_ = '検索で例外: ' + truncate_(String(e), 60); }

  if (mediaUploadEnabled_() && photos.length) {
    return {
      kind: 'image',
      describes: shows,
      source: 'stock-photo',
      videoAsset: null,
      imageUrls: photos
    };
  }

  lastMediaFailure_ = '動画: ' + (videoWhy || '不明') +
    ' / 候補画像: ' + (imgs.length ? imgs.length + '件あるが添付無効' : '候補に画像が無い') +
    ' / ストック写真: ' + (lastPhotoFailure_ || '0件');
  return null;
}

/**
 * 用意したメディアをXへ上げる。★ここで初めてXを叩く。
 *
 * 動画の送信に失敗した時は、同じ検索語のストック写真へ降りる。
 * ★別の話題のサムネイルへは降りない。本文は既に「この映像」について
 * 書かれているので、無関係な画像に差し替えると元の0点へ戻る。
 *
 * @return {?{mediaId:string, kind:string, source:string}}
 */
function uploadBuzzMedia_(accountKey, prepared) {
  if (!prepared) return null;

  if (prepared.kind === 'video' && prepared.videoAsset) {
    let mediaId = null;
    try {
      mediaId = uploadVideoToX_(accountKey, prepared.videoAsset);
    } catch (e) {
      lastMediaFailure_ = 'Xへのアップロードで例外: ' + truncate_(String(e), 80);
      console.warn('動画のアップロードで例外: ' + truncate_(String(e), 120));
    }
    if (mediaId) {
      return { mediaId: String(mediaId), kind: 'video', source: prepared.source };
    }
    lastMediaFailure_ = 'Xへのアップロードが失敗（素材 ' +
      Math.round((prepared.videoAsset.bytes || 0) / 1024) + 'KB は取得済み）';

    /*
     * ★同じ被写体の写真へ降りる。本文と噛み合ったままにするため、
     * 検索語は本文へ渡したもの(describes)をそのまま使う。
     */
    const photo = pickStockPhotoMedia_(accountKey, prepared.describes);
    if (photo) {
      return { mediaId: photo.mediaId, kind: 'image', source: photo.source };
    }
    return null;
  }

  const urls = prepared.imageUrls || [];
  for (let i = 0; i < urls.length; i++) {
    let mediaId = null;
    try { mediaId = uploadMediaToX_(accountKey, urls[i]); }
    catch (e) {
      console.warn('メディアのアップロードで例外（次を試します）: ' + truncate_(String(e), 100));
    }
    if (mediaId) {
      return { mediaId: String(mediaId), kind: 'image', source: prepared.source };
    }
  }
  lastMediaFailure_ = urls.length + '枚試したがXへ上げられない';
  return null;
}


/* ------------------------------------------------------------------ */
/* 最後の砦：ストック写真                                                */
/* ------------------------------------------------------------------ */

let lastPhotoFailure_ = '';

/**
 * Pexels（無ければPixabay）から写真を1枚取り、Xへ上げる。
 *
 * ★動画が通らない環境でも、写真なら通る可能性が高い。
 * 画像は単発POST（または4段階）で済み、変換待ちが無いため
 * 失敗する箇所そのものが少ない。
 *
 * @return {?{mediaId:string, source:string}}
 */
function pickStockPhotoMedia_(accountKey, query) {
  lastPhotoFailure_ = '';
  if (!mediaUploadEnabled_()) {
    lastPhotoFailure_ = '画像添付が無効(MEDIA_UPLOAD=0)';
    return null;
  }

  let urls = [];
  try {
    urls = stockPhotoUrls_(query, 2);
  } catch (e) {
    lastPhotoFailure_ = '検索で例外: ' + truncate_(String(e), 60);
    return null;
  }
  if (!urls.length) {
    lastPhotoFailure_ = '写真が見つからない（キー未設定か検索結果0件）';
    return null;
  }

  for (let i = 0; i < urls.length; i++) {
    let mediaId = null;
    try { mediaId = uploadMediaToX_(accountKey, urls[i]); }
    catch (e) {
      console.warn('ストック写真のアップロードで例外（次を試します）: ' +
                   truncate_(String(e), 100));
    }
    if (mediaId) return { mediaId: String(mediaId), source: 'stock-photo' };
  }

  lastPhotoFailure_ = urls.length + '枚試したがXへ上げられない';
  return null;
}

/* ------------------------------------------------------------------ */
/* バズ投稿サイクル（実行本体）                                          */
/* ------------------------------------------------------------------ */

/**
 * ★ここが無いとBUZZは「配分で選ばれるが誰も実行しない種類」になる。
 *
 * 24_PostMix.gs が BUZZ を返しても、処理する側が居なければ
 * 通常の生成へ流れ、CTA付きの普通の投稿が出る。
 * 配分に足すことと、実行経路を作ることは別の仕事。
 */
const BUZZ_TURN_PROP = 'buzz_turn';

/*
 * ★出せなかった本当の理由を覚えておく（2026-08-22）。
 *
 * runBuzzCycle_ は true/false しか返さないため、LINEの返信は
 * 「よくある原因」を並べるしかなかった。実際には診断が
 * 「今日のぶんを使い切りました」と答えを持っていたのに、
 * 手で叩いた人には伝わっていなかった。
 *
 * 実行のたびに上書きし、直後の返信で読む。
 */
let lastBuzzSkipReasons_ = [];

function resetBuzzSkipReasons_() {
  lastBuzzSkipReasons_ = [];
}

/* ------------------------------------------------------------------ */
/* 自動実行の結果を残す                                                  */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-24。ここが無かったせいで、丸一日を推測に費やした。
 *
 * 【何が問題だったか】
 * 見送り理由はメモリにしか残らなかった。手で「バズ」と叩いた時は
 * 直後の返信で読めるが、**自動実行（2時間おき）の理由は消える。**
 * Apps Scriptの実行ログにしか残らず、あれは後から追いにくい。
 *
 * 結果、「Aだけ動画が出ない」の原因を、コードを読んで推測するしか
 * なかった。推測で3回直して3回とも実機は変わらなかった。
 * 直すべきだったのは推測の精度ではなく、事実が残らない構造の方。
 *
 * アカウントごとに「最後にいつ・どうなったか」を1行だけ持つ。
 * 履歴は要らない。最後の1回が分かれば原因は追える。
 */
function buzzLastProp_(accountKey) {
  return 'buzz_last_' + String(accountKey || '').toUpperCase();
}

/**
 * その回の結果を残す。
 * @param {string} accountKey
 * @param {string} outcome '投稿' か '見送り'
 * @param {string} detail 理由（見送りの時）
 */
function recordBuzzOutcome_(accountKey, outcome, detail) {
  try {
    const when = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm');
    props_().setProperty(buzzLastProp_(accountKey),
      truncate_(when + '｜' + outcome + (detail ? '｜' + detail : ''), 300));
  } catch (e) {}
}

/** 診断へ出す1行。まだ一度も動いていなければ空。 */
function buzzLastOutcome_(accountKey) {
  return getProp_(buzzLastProp_(accountKey), '');
}

/** 見送った理由を記録して false を返す。呼び出し側はそのまま return できる。 */
function noteBuzzSkip_(accountKey, reason) {
  lastBuzzSkipReasons_.push('[' + accountKey + '] ' + reason);
  console.log('バズ投稿を見送り (' + accountKey + '): ' + reason);
  recordBuzzOutcome_(accountKey, '見送り', reason);
  return false;
}

function buzzSkipSummary_() {
  return lastBuzzSkipReasons_.slice();
}

/**
 * A/Bを順番に試す。1本出せたら true。
 * @param {{requireMedia:boolean}} [opts]
 */
function runBuzzCycleAll_(opts) {
  // ★1つでも生きていれば回す。止まっている側は下の per-account 判定で飛ぶ
  if (!anyBuzzModeEnabled_()) return false;

  const first = nextAccountInTurn_(BUZZ_TURN_PROP);
  const order = [first].concat(Object.keys(ACCOUNTS).filter(function (k) {
    return k !== first;
  }));

  for (let i = 0; i < order.length; i++) {
    try {
      if (runBuzzCycle_(order[i], opts)) return true;
    } catch (err) {
      console.error('バズ投稿に失敗 (' + order[i] + '): ' +
                    (err && err.stack ? err.stack : err));
    }
  }
  return false;
}

/**
 * 1アカウントぶんのバズ投稿。
 *
 * ★材料は無料の情報源から取る。バズ投稿のために新しく課金APIを叩かない。
 * 話題そのものより「その話題について何を言うか」が主役なので、
 * 材料は見出し1本で足りる。
 *
 * @param {string} accountKey
 * @param {{requireMedia:boolean}} [opts] requireMedia=true なら
 *     メディアを付けられなかった回は投稿しない
 * @return {boolean} 投稿できたら true
 */
function runBuzzCycle_(accountKey, opts) {
  const key = String(accountKey || '').toUpperCase();
  const options = opts || {};
  if (!buzzModeEnabled_(key)) return noteBuzzSkip_(key, 'バズモードが停止中（BUZZ_MODE_' + key + ' または BUZZ_MODE = 0）');
  /*
   * ★★Xが拒否している間は、材料集めもLLMも走らせない（2026-08-24）。
   * どうせ投稿できない回に、Gemini代とX API呼び出しを払う理由が無い。
   */
  if (xCallsBlocked_(key)) {
    const remain = xBlockRemainMinutes_(key);
    return noteBuzzSkip_(key, 'Xが受け付けない状態（残高・権限・レート制限）。' +
      (remain ? 'あと約' + remain + '分' : '回復まで') + '試行を止めています');
  }
  if (isAccountStopped_(key)) {
    return noteBuzzSkip_(key, '停止中（' + truncate_(stopReasonFor_(key), 60) + '）');
  }

  /*
   * ★月間上限は手動でも越えない。これは予算の歯止めそのもの。
   * 「上限なし」にしたい時は明示的に外してもらう。
   */
  if (isOverMonthlyCap_(key)) {
    return noteBuzzSkip_(key, '今月の上限に達している（「上限なし」で解除できます）');
  }

  /*
   * ★★日割り上限は、手で叩いた時は越える（2026-08-22、オーナー指示）。
   *
   * 日割りは「自動投稿を1日に均す」ための配分であって、予算の歯止めでは
   * ない（歯止めは上の月間上限）。人がLINEで「バズ」と打ったのは
   * 明示的な指示であり、自動生成の1本とは意味が違う。
   * 在庫も材料も揃っているのに「今日のぶんを使い切りました」で
   * 何も出ないのは、手動コマンドとして機能していない。
   */
  if (!options.force && isOverDailyPace_(key)) {
    return noteBuzzSkip_(key, '今日のぶんを使い切った（手動の「バズ」なら出せます）');
  }

  /*
   * --- 材料 ---
   * ★★バズ専用の板から拾う（33_BuzzSource.gs、2026-08-22）。
   *
   * 以前は通常の情報源(collectSourceCandidates_)と共有していた。
   * あちらは「紹介できる商材の話題」を集める設計で、視覚的な派手さで
   * 選んでいない。その結果、本文はレビューの話、映像は無関係な
   * ストック、という噛み合わない投稿になっていた。
   *
   * 専用板が0件の時だけ通常の情報源へ降りる（完全に黙るよりはマシ）。
   */
  let candidates = [];
  let fromBuzzSubs = false;
  try {
    candidates = collectBuzzCandidates_(key) || [];
    fromBuzzSubs = candidates.length > 0;
  } catch (e) {
    console.warn('バズ専用の材料を集められません: ' + truncate_(String(e), 120));
  }

  if (!candidates.length) {
    console.log('バズ専用板が0件のため通常の情報源へ降ります (' + key + ')。');
    try {
      candidates = collectSourceCandidates_(key, {}) || [];
    } catch (e) {
      console.warn('バズ用の材料を集められません: ' + truncate_(String(e), 120));
    }
  }
  /*
   * ★★材料が0件でも投稿する（2026-08-24、実機ログで方針を変えた）。
   *
   * 【ログが示した事実】
   * 診断に出ていたのはこれだった。
   *   r/YouTube: HTTP401        … こちらがGeminiのキーを送っていた（修正済み）
   *   全17板: 403               … Redditは未認証APIを廃止済み。OAuthが要る
   * つまり **材料源が2つとも死んでいた。** その状態で
   * 「材料0件なら見送り」と書いてあったので、バズ投稿は
   * 何をどう直しても1本も出ない。動画の同期も品質ゲートも、
   * ここより下流にあるので動く余地が無かった。
   *
   * 【なぜ材料無しで成立するか】
   * 順序を逆にした時点で、この依存は本質ではなくなっている。
   * 先に映像を決め、その映像について本文を書く形にしたので、
   * 投稿の中身は「映像」＋「それへの一言」で完結する。
   * 元投稿は切り口を借りるための材料であって、無ければ
   * 映像そのものを題材にすればよい。
   *
   * 外部サービスの都合で毎日ゼロ本になる設計の方が間違っていた。
   * 材料が取れた回はそれを使い、取れない回も出す。
   */
  if (!candidates.length) {
    console.log('材料が0件のため、映像そのものを題材にします (' + key + ')。');
  }

  const ranked = candidates.slice().sort(function (a, b) {
    return (Number(b.views) || 0) - (Number(a.views) || 0);
  });
  /*
   * ★1つの話題で駄目でも諦めない（2026-08-22、オーナー指示）。
   *
   * 以前は ranked[0] の1件だけで生成し、失敗したらサイクルごと終了して
   * いた。話題との相性で採点が落ちることはあるのに、188件の候補を
   * 持ちながら1件しか試していなかった。
   * 手動実行(force)の時は、複数の話題を順に試す。
   */
  // ★材料0件でも1回は回す。その回の題材は映像そのものになる
  const topicTries = options.force
    ? Math.max(1, Math.min(BUZZ_TOPIC_TRIES, ranked.length))
    : 1;
  const topic = ranked[0] || null;

  /*
   * --- メディアを先に用意する（2026-08-24、順序を逆にした）---
   *
   * ★ここではまだXを叩かない。ダウンロードするだけ。
   *
   * 先に映像を決める理由は2つ。
   *   1) 本文を「実際に映っているもの」について書ける。
   *      逆順だと、本文と映像が噛み合わない投稿が普通に出る（0点の原因）
   *   2) 本文が作れなかった回にXを1度も叩かずに済む
   */
  let prepared = null;
  try {
    prepared = prepareBuzzMedia_(key, ranked,
                                 buzzMediaQuery_(key, topic),
                                 String((topic && topic.title) || ''),
                                 buzzMediaSubject_(key, topic));
  } catch (e) {
    console.warn('バズ用メディアの用意で例外: ' + truncate_(String(e), 120));
  }

  /*
   * ★★ メディアが無ければ絶対に投稿しない（2026-08-22、実害が出て追加）★★
   *
   * 実際に「テキストだけ・ハッシュタグ5個」の投稿がタイムラインへ出た。
   * バズ投稿はリンクを持たないので、メディアが無ければ
   * 「ハッシュタグを並べた独り言」にしかならない。それはスパムに見える。
   *
   * ★判定を本文生成より前へ移した（2026-08-24）。
   * どうせ投稿しない回に Gemini 代を払う理由が無い。
   */
  if (!prepared) {
    console.warn('Media Upload Failed - Post Aborted (' + key + ')');
    notifyMediaAbortOnce_(key, 'none');
    const detail = mediaFailureReason_();
    return noteBuzzSkip_(key, 'メディアを用意できなかった' +
      (detail ? '｜' + detail : ''));
  }

  /*
   * --- 組み立て済みの動画が返ってきた回 ---
   *
   * ★本文は「描画を頼んだ時のもの」をそのまま使う。作り直さない。
   *   字幕はその本文から焼いてあるので、ここで別の文を書くと
   *   画面の字幕と投稿本文が食い違う。せっかく同期させた意味が消える。
   */
  if (prepared.renderedText) {
    return postPreparedBuzz_(key, prepared, {
      text: prepared.renderedText,
      region: pickRegionByJstHour_(),
      model: 'rendered',
      qualityScore: 0
    }, options);
  }

  /*
   * ★1つの話題で駄目でも諦めない（2026-08-22、オーナー指示）。
   *
   * 以前は ranked[0] の1件だけで生成し、失敗したらサイクルごと終了して
   * いた。話題との相性で採点が落ちることはあるのに、188件の候補を
   * 持ちながら1件しか試していなかった。
   * 手動実行(force)の時は、複数の話題を順に試す。
   *
   * ★映像は1本に固定したまま話題だけ替える。映像に何が映っているかは
   * 毎回 prepared.describes として渡すので、どの話題を選んでも
   * 本文は画面の中身について書かれる。
   */
  let generated = null;
  for (let t = 0; t < topicTries; t++) {
    lastBuzzGenFailure_ = '';
    generated = generateBuzzText_(key, ranked[t], prepared.describes, prepared.kind);
    if (generated) break;
    console.log('話題 ' + (t + 1) + '/' + topicTries + ' では作れませんでした (' + key + ')。');
  }

  if (!generated) {
    // ★推測ではなく、最後に実際に引っかかった理由を出す
    return noteBuzzSkip_(key, '本文を生成できなかった（話題' + topicTries + '件試行）: ' +
      (lastBuzzGenFailure_ || '理由不明'));
  }

  // ★1本ものの経路も、組み立て済みの経路と同じ投稿処理を通す
  return postPreparedBuzz_(key, prepared, generated, options);
}

/**
 * 用意したメディアと本文で、実際に投稿するところ。
 *
 * ★★2つの経路（組み立て済み動画 / 1本もの）で共通にする（2026-08-24）。
 *
 * 分けて書くと、空撃ち禁止・ログ・angle接頭辞といった決まりごとを
 * 片方だけ直した状態が必ず生まれる。実際この日、遮断器を直した時に
 * 両方へ入れ忘れかけた。仕様そのものなので1箇所に閉じ込める。
 *
 * @return {boolean} 投稿できたら true
 */
function postPreparedBuzz_(accountKey, prepared, generated, opts) {
  const key = String(accountKey || '').toUpperCase();
  const options = opts || {};

  let mediaIds = [];
  let mediaKind = 'none';
  try {
    const media = uploadBuzzMedia_(key, prepared);
    if (media) { mediaIds = [media.mediaId]; mediaKind = media.kind; }
  } catch (e) {
    console.warn('バズ用メディアの送信に失敗: ' + truncate_(String(e), 120));
  }

  /*
   * ★★ メディアが無ければ絶対に投稿しない（2026-08-22、実害が出て追加）★★
   *
   * 実際に「テキストだけ・ハッシュタグ5個」の投稿がタイムラインへ出た。
   * バズ投稿はリンクを持たないので、メディアが無ければ
   * 「ハッシュタグを並べた独り言」にしかならない。それはスパムに見える。
   *
   * 以前は options.requireMedia が真の時だけ止めていたが、
   * LINEの「バズ」から手で叩く経路が {} を渡していたため素通りしていた。
   * 条件付きにしたこと自体が誤りだった。無条件で止める。
   */
  if (!mediaIds.length) {
    console.warn('Media Upload Failed - Post Aborted (' + key + ')');
    notifyMediaAbortOnce_(key, mediaKind);
    const detail = mediaFailureReason_();
    return noteBuzzSkip_(key, 'メディアを用意できなかった' +
      (detail ? '｜' + detail : ''));
  }

  /*
   * ★noLink を必ず渡す。これが固定CTAの付与を止め、
   * 送信直前の安全装置(assertNoLinksForBuzz_)を有効にする。
   * ここを落とすと、リンク無しで書いた本文にURLが付いて出る。
   */
  const result = postTweet_(key, generated.text, {
    mediaIds: mediaIds,
    noLink: true
  });

  const ss = openLogSpreadsheet_();
  appendLogRow_(ss, buildLogRow_({
    account: key,
    status: QUEUE_STATUS_POSTED,
    text: generated.text,
    region: generated.region,
    /*
     * ★angle は必ず BUZZ で始める。
     * classifyPostKind_ はこの文字列でBUZZを判別する。
     * ここが違うとリンク無しゆえHUMANとして数えられ、
     * BUZZが永久に「不足」と判定されて配分が壊れる。
     */
    angle: 'BUZZ_' + String(mediaKind).toUpperCase(),
    format: 'buzz',
    postId: result.id,
    hash: result.contentHash,
    hasLink: false,
    cost: result.costEstimate,
    model: generated.model,
    role: 'BUZZ',
    qualityScore: generated.qualityScore
  }));

  resetPoorQualityStreak_(key);
  console.log('バズ投稿しました (' + key + ' / メディア: ' + mediaKind +
              ' / ' + String(prepared.source || '') + '): ' +
              (result.url || result.id));
  // ★成功も残す。「最後に出せたのはいつか」が分からないと、
  //   止まっているのか単に順番が回っていないのかを区別できない
  recordBuzzOutcome_(key, '投稿', mediaKind + '／' +
    truncate_(String(prepared.describes || ''), 60));

  /*
   * ★次の1本の組み立てをここで頼む（2026-08-24）。
   *
   * 描画は1〜3分かかるのでGASでは待てない。投稿できた直後に頼んでおけば、
   * 次のサイクル（2時間後）には必ず出来上がっている。
   * 頼み損ねても投稿自体は成立しているので、失敗しても true を返す。
   */
  try { queueNextRender_(key, generated.text); } catch (e) {
    console.warn('次の描画を頼めませんでした: ' + truncate_(String(e), 100));
  }
  return true;
}

/**
 * 次に使う動画の組み立てを頼んでおく。
 *
 * ★本文を先に決めてから頼む。字幕はこの本文から焼かれるので、
 * 「投稿本文＝画面の字幕」が最初から一致する。
 */
function queueNextRender_(accountKey, text) {
  /*
   * ★typeof で守らない（2026-08-24）。
   *   GASは全 .gs を1スコープへ読むので、これは常に存在する。
   *   typeof で囲むと、読み込み順が変わった時に「何も起きないのに
   *   エラーも出ない」状態になり、原因を追えなくなる。
   */
  if (!renderEnabled_()) return false;
  const key = String(accountKey || '').toUpperCase();

  // 既に頼んであるなら重ねない
  if (pendingRender_(key)) return false;

  /*
   * ★★モードTは素材を使わない（2026-08-26、36_Render.gs 参照）。
   *   ここを塞いだままだと、自動投稿の経路だけが「素材が足りません」で
   *   止まり、手動の「試作」では動くのに本番では一度も出ない、という
   *   気づきにくい状態になる。
   */
  const isTypography = renderModeFor_(key) === 'T';
  const clips = isTypography ? [] : pickRenderClips_(key, rotatingStockQuery_(key));
  if (!isTypography && clips.length < 2) {
    console.log('組み立てに足りる素材がありません (' + key + ': ' + clips.length + '本)');
    return false;
  }
  return !!requestRender_(key, clips, text);
}

/**
 * 素材検索の手掛かり。Pexels用。
 *
 * ★話題の見出しをそのまま渡さない。固有名詞だらけだと在庫が無く、
 * 毎回0件になる。アカウントの土俵を表す一般語へ寄せる。
 */
function buzzMediaQuery_(accountKey, topic) {
  /*
   * ★★元投稿のタイトルから検索語を作る（33_BuzzSource.gs、2026-08-22）。
   *
   * 以前はここに固定の対応表を置いていた。keyboard / coffee / watch など
   * 数語しか拾えず、外れると 'technology gadget desk' という汎用語に
   * 落ちていた。本文がレーザー加工の話でも映像はコーヒーになる、
   * 「無関係な動画」の直接の原因がこれ。
   *
   * 対応表を増やす方向では追いつかない。タイトルの名詞をそのまま
   * 検索語にすれば、板が増えても対応表を書き足さずに済む。
   */
  /*
   * ★★話題が無い回は、そのアカウントの検索語を順に回す（2026-08-24）。
   *
   * 材料源が落ちている間、話題は毎回 null になる。その時に
   * 固定の1語へ落ちると、毎回ほぼ同じ映像になり「同じ動画」に見える。
   * 在庫を集めている語をそのまま使えば、在庫とも噛み合うし変化も出る。
   */
  if (!topic || !String(topic.title || '').trim()) {
    return rotatingStockQuery_(accountKey);
  }

  if (typeof buzzVideoQueryFromTopic_ === 'function') {
    return buzzVideoQueryFromTopic_(accountKey, topic);
  }
  // 33_BuzzSource.gs が未読込でも投稿は止めない
  return rotatingStockQuery_(accountKey);
}

/**
 * 撮り方を含まない被写体を返す。写真検索と、本文へ渡す画面説明に使う。
 *
 * ★buzzMediaQuery_ と対で使う。あちらは動画在庫を引くための語
 * （語尾に macro / slow motion 等が付く）、こちらは読み手が実際に
 * 見るものの説明。混ぜると、静止画に「スローモーション」と書く。
 */
function buzzMediaSubject_(accountKey, topic) {
  if (topic && String(topic.title || '').trim() &&
      typeof buzzSubjectFromTopic_ === 'function') {
    return buzzSubjectFromTopic_(accountKey, topic);
  }
  // 話題が無い回は在庫の語をそのまま使う。在庫と噛み合っている語なので
  // 撮り方が混ざっていても「実際にその映像が在庫にある」点は保たれる。
  return rotatingStockQuery_(accountKey);
}

/**
 * そのアカウントの検索語を1つ、順番に返す。
 *
 * ★ランダムにしない。ランダムだと短期間で同じ語が続くことがあり、
 * 「同じ映像ばかり」の原因になる。順番に回せば必ず一巡する。
 */
function rotatingStockQuery_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  let list = [];
  try { list = stockQueries_(key) || []; } catch (e) {}
  if (!list.length) {
    return key === 'B'
      ? 'woman summer portrait slow motion'
      : 'crowd reaction celebration slow motion';
  }
  const prop = 'buzz_q_' + key;
  const n = Number(getProp_(prop, '0')) || 0;
  try { props_().setProperty(prop, String((n + 1) % list.length)); } catch (e) {}
  return String(list[n % list.length]);
}

/**
 * バズ本文を生成する。
 *
 * ★通常の生成と違い、リンクの検査を「落ちたら作り直す」材料にする。
 * URLを含んだ案は捨てるのではなく、指摘して書き直させる。
 * 白紙から作り直すと点が下がるのは既に学んでいる（CLAUDE.md §3）。
 *
 * @return {?{text:string, region:string, model:string, qualityScore:number}}
 */
function generateBuzzText_(accountKey, topic, shows, mediaKind) {
  const key = String(accountKey || '').toUpperCase();
  const region = pickRegionByJstHour_();
  const maxLen = getTweetMaxLen_(key);

  /*
   * ★★2026-08-24。ここが「動画も0点」の中心だった。
   *
   * 以前はこの関数が、元投稿の見出しを
   *   "WHAT THE VIDEO SHOWS"
   * という見出しを付けてLLMへ渡していた。だが実際に添付される映像は
   * 別途あとから選ばれる無関係な在庫映像で、見出しの内容とは何の
   * 関係も無かった。つまりLLMに嘘を教えていた。
   * 結果、本文は「元投稿で起きたこと」を語り、映像は全く別のものを
   * 映す。読み手には文章と映像が食い違って見える。
   *
   * 今は shows（実際に添付する映像の説明）を先に決めて受け取る。
   * 元投稿は「話題・切り口」として、映像とは別枠で渡す。
   * どちらも本当のことなので、食い違いようがない。
   */
  const sub = String((topic && topic.subreddit) || '');
  const score = Number((topic && topic.views) || 0);

  const onScreen = String(shows || '').trim();
  const title = String((topic && topic.title) || '').trim();

  /*
   * ★★話題が無い回もある（2026-08-24）。
   *
   * 実機では材料源（Reddit / YouTube）が両方落ちており、
   * 材料0件が常態だった。そこで「材料が無ければ映像そのものを
   * 題材にする」へ変えたので、この関数は topic=null で呼ばれる。
   *
   * その時に空の "THE TOPIC:" という見出しだけを残してはいけない。
   * 見出しがあって中身が無いと、LLMは埋めようとして話題を捏造する。
   * 節ごと出さない。
   */
  const topicText = title
    ? [
        onScreen ? 'ON SCREEN (this is the footage attached to your post):' : '',
        onScreen,
        '',
        'THE TOPIC (what people are talking about — this is NOT the footage):',
        title,
        truncate_(String((topic && topic.description) || ''), 400),
        sub ? ('Community: r/' + sub + (score ? ' — ' + score + ' upvotes' : '')) : ''
      ].filter(Boolean).join('\n')
    : [
        'ON SCREEN (this is the footage attached to your post):',
        onScreen,
        '',
        'There is no outside topic this time. The footage IS the subject.',
        'Write about what is happening on screen and what you think about it.'
      ].filter(Boolean).join('\n');

  const systemPrompt = buildBuzzPrompt_(key, topicText, maxLen, onScreen, mediaKind);

  let lastText = '';
  let critique = '';
  // 整形は通ったが採点で落ちた案。全試行が尽きた時の判断材料にする
  let bestRepaired = '';
  let bestScore = 0;

  for (let attempt = 1; attempt <= llmMaxAttempts_(); attempt++) {
    const userPrompt = attempt === 1
      ? 'Write the post.'
      : ('Your previous attempt:\n' + lastText +
         '\n\nProblem: ' + critique +
         '\n\nFix ONLY that. Keep everything that worked.');

    let raw;
    try {
      raw = callLLM_(systemPrompt, userPrompt);
    } catch (err) {
      if (isSafetyBlock_(err)) {
        console.warn('安全フィルタのため、この話題でのバズ投稿は見送ります。');
        return null;
      }
      throw err;
    }

    let text = sanitizeGeneratedText_(raw);
    if (!text) continue;

    // ★URLは削らず、書き直させる。削ると不自然な残骸が出る
    if (!buzzTextIsClean_(text)) {
      lastText = text;
      critique = 'You included a link or a domain name. This post must contain NO URL ' +
                 'and no domain at all. Rewrite the same idea without it.';
      continue;
    }

    /*
     * ★長さとタグ数はコード側で確実に直す（2026-08-22）。
     *
     * 以前はどちらもLLMへ「直して」と投げ返し、3回失敗したら投稿を
     * 捨てていた。実機で [A] が Too long のまま3回落ちて1本も出なかった。
     * 機械的に直せるものを確率的な相手に頼るのが誤りだった。
     * ここで直せなかった時だけ書き直させる。
     */
    const repaired = repairBuzzText_(key, text, maxLen);
    if (!repaired) {
      lastText = text;
      critique = 'Too long or too few hashtags, and it could not be trimmed. ' +
                 'Write a much shorter post: aim for ' + Math.round(maxLen * 0.6) +
                 ' characters of body text, plus ' + BUZZ_HASHTAG_MIN + '-' +
                 BUZZ_HASHTAG_MAX + ' hashtags on the last line.';
      continue;
    }
    text = repaired;

    /*
     * ★整形でリンクが復活することはないが、念のため再確認する。
     * リンク無しはバズ投稿の絶対条件で、ここを破ると送信直前の
     * 安全装置(assertNoLinksForBuzz_)が例外を投げて投稿ごと落ちる。
     */
    if (!buzzTextIsClean_(text)) {
      lastText = text;
      critique = 'You included a link or a domain name. Rewrite without it.';
      continue;
    }

    const verdict = evaluatePost_(key, text, 'BUZZ', topicText);
    if (!verdict.ok) {
      /*
       * ★整形済みで採点だけ落ちた案を覚えておく。
       * 全部の試行が尽きた時、これを最後の砦にする。
       * 採点そのものは緩めない（60点の足切りは変更に承認が要る）。
       */
      bestRepaired = text;
      bestScore = Number(verdict.score) || 0;
      lastText = text; critique = verdict.critique;
      continue;
    }

    return {
      text: text,
      region: region,
      model: getProp_('LLM_MODEL', LLM_DEFAULT_MODEL),
      qualityScore: verdict.score
    };
  }

  /*
   * ★最後に何が引っかかったのかを残す（2026-08-22）。
   *
   * 以前は「品質基準に届きませんでした」とだけログに書いて null を返して
   * いた。LINEの返信は考えられる原因を両論併記で並べるしかなく、
   * 実際にどれだったのか分からなかった。
   * critique には最後の却下理由がそのまま入っているので、それを出す。
   */
  lastBuzzGenFailure_ = critique
    ? truncate_(critique, 140)
    : (lastText ? '応答はあったが採点を通らなかった' : 'Geminiが空を返した');

  // 採点だけが理由なら、何点だったのかまで出す（閾値と比べられるように）
  if (bestRepaired) {
    lastBuzzGenFailure_ = '採点' + bestScore + '点で足切り（' +
      truncate_(critique, 100) + '）';
  }

  console.log('バズ投稿を作れませんでした (' + key + '): ' + lastBuzzGenFailure_);
  return null;
}

/** 直前の本文生成の失敗理由。runBuzzCycle_ が返信に載せる。 */
let lastBuzzGenFailure_ = '';

/* ------------------------------------------------------------------ */
/* LINEからの手動実行・診断                                              */
/* ------------------------------------------------------------------ */

/**
 * 「バズ」コマンド。今すぐ1本出す。
 *
 * ★配分の順番を待たずに試せる経路が要る。
 * 実装した機能を確かめる手段が「次のトリガーまで待つ」しか無いと、
 * 動かなかった時にどこが悪いのか切り分けられない。
 *
 * ★手で叩いた回はメディア必須にしない。
 * メディアが無くても本文が出るか見たい場面があるため。
 * 自動サイクル側（引用専用モード）の制約とは目的が違う。
 *
 * @param {?string} accountKey 未指定なら順番どおり
 */
function runBuzzNowForLine_(accountKey) {
  const askedKey = String(accountKey || '').toUpperCase();
  if (askedKey ? !buzzModeEnabled_(askedKey) : !anyBuzzModeEnabled_()) {
    return '⏸ バズモードは停止中です' +
           (askedKey ? '（' + askedKey + '）' : '') + '。\n' +
           '→ 「設定 BUZZ_MODE' + (askedKey ? '_' + askedKey : '') + ' 1」で有効になります。';
  }

  const key = accountKey ? String(accountKey).toUpperCase() : '';

  try {
    /*
     * ★force を渡す（2026-08-22、オーナー指示）。
     *
     * 手で「バズ」と打つのは明示的な指示であって、自動投稿の1本とは
     * 意味が違う。日割り上限（1日の配分）はここでは越える。
     * 越えないのは月間上限と緊急停止だけ。
     */
    resetBuzzSkipReasons_();
    const opts = { force: true };
    const ok = key ? runBuzzCycle_(key, opts) : runBuzzCycleAll_(opts);
    if (ok) {
      return '✅ バズ投稿を出しました' + (key ? '（' + key + '）' : '') + '。\n' +
             'タイムラインを確認してください。';
    }

    /*
     * ★「よくある原因」を並べるのをやめた。
     * 実際の理由はコード側が知っている。それを見せる。
     */
    const reasons = buzzSkipSummary_();
    return [
      '⚠️ バズ投稿を作れませんでした' + (key ? '（' + key + '）' : '') + '。',
      '',
      '理由:',
      reasons.length ? reasons.map(function (r) { return '  ' + r; }).join('\n')
                     : '  不明（ログを確認してください）',
      '',
      '「バズ診断」で設定と材料を確認できます。'
    ].join('\n');
  } catch (err) {
    return '❌ バズ投稿でエラー\n' + truncate_(String(err && err.message ? err.message : err), 300);
  }
}

/**
 * 「バズ診断」コマンド。設定と素材の在庫を見る。
 *
 * ★「動かない」と言われた時に見る場所を1つにまとめる。
 * 設定・素材・配分が別々の画面に散っていると切り分けに時間がかかる。
 */
function buildBuzzDiagText_() {
  /*
   * ★問題がある箇所だけを出す（2026-08-22、オーナー指示「シンプルに」）。
   *
   * 以前は設定・素材・在庫・材料・投稿可否を全部並べ、緑のチェックが
   * 十数行続く壁になっていた。全部書くと、本当に見るべき1行が埋もれる。
   * 正常なら1行で終わり、異常だけ理由と手順を添えて出す。
   */
  const problems = [];
  const notes = [];

  // --- 1. メディア権限。ここが赤ければ他を見ても意味がない ---
  const relink = [];
  Object.keys(ACCOUNTS).forEach(function (k) {
    /*
     * ★'unknown'（連携済みだが scope が読めない）は問題にしない。
     * トークン更新後は応答に scope が入らないことがあり、
     * これを「未連携」と出すと、再連携を済ませた人にもう一度
     * やり直させることになる。実際に403が出た時に分かればよい。
     */
    const st = mediaScopeState_(k);
    if (st === 'missing') relink.push(k);
    else if (st === 'unlinked') {
      problems.push('❌ ' + k + ': 未連携 →「Xリンク ' + k + '」');
    }
  });
  if (relink.length) {
    problems.push('❌ media.write 権限が無い（' + relink.join('・') + '）');
    problems.push('   → ' + relink.map(function (k) {
      return '「Xリンク ' + k + '」';
    }).join(' と ') + ' で再認証');
    problems.push('   これが原因ならメディアは必ず403で落ちます');
  }

  // --- 2. スイッチ ---
  /*
   * ★アカウント別の停止状態は、問題の有無に関わらず必ず出す（2026-08-27）。
   *
   * 最初 notes へ入れたが、notes は problems が0件の時しか描画されない。
   * VIDEO_UPLOAD=0 が1件残っているだけで「A: 停止中」が消え、
   * 設定が効いているのか配備できていないのかを区別できなくなった
   * （実際にオーナーがこの画面で判断できなくなった）。
   *
   * これは「問題」ではなく「状態」であり、他の行の読み方を変える情報。
   * 隠してはいけない。
   */
  const stopped = Object.keys(ACCOUNTS).filter(function (k) {
    return !buzzModeEnabled_(k);
  });
  if (!anyBuzzModeEnabled_()) problems.push('❌ 両アカウントともバズモードが停止（BUZZ_MODE=0）');
  if (!videoUploadEnabled_()) problems.push('❌ 動画添付が無効（VIDEO_UPLOAD=0）');
  if (!mediaUploadEnabled_()) problems.push('❌ 画像添付が無効（MEDIA_UPLOAD=0）');

  // --- 3. 素材のキー ---
  if (!getProp_('PEXELS_API_KEY', '') && !getProp_('PIXABAY_API_KEY', '')) {
    problems.push('❌ 素材APIのキーが未設定 →「初期設定 <キー>」');
  }

  // --- 4. 在庫（使える本数で見る）---
  let stockTotal = 0;
  Object.keys(ACCOUNTS).forEach(function (k) {
    let n = 0;
    try { n = freshStock_(k).length; } catch (e) {}
    stockTotal += n;
    if (n < STOCK_LOW_WATER) {
      notes.push('在庫 ' + k + ': ' + n + '本（自動補充されます）');
    }
  });

  // --- 5. 材料（神動画）---
  let matTotal = 0;
  Object.keys(ACCOUNTS).forEach(function (k) {
    let n = 0;
    try { n = (collectBuzzCandidates_(k) || []).length; }
    catch (e) {
      problems.push('❌ ' + k + ': 材料を取れません（' + truncate_(String(e), 50) + '）');
      return;
    }
    matTotal += n;
    if (!n) {
      /*
       * ★★材料0件はもう「問題」ではない（2026-08-24、実機ログを見て変更）。
       *
       * 実機の診断は、同じ403を17行並べて「問題21件」と表示していた。
       * 読む方は21個の問題を抱えているように見えるが、実体は
       *   ・Redditが未認証APIを廃止した（1件）
       *   ・YouTubeのキーが未設定（1件）
       * の2つだけである。同じ原因を板の数だけ繰り返すのは、
       * 本当に見るべき行を埋める。
       *
       * さらに、材料が0件でも映像そのものを題材にして投稿するよう
       * 変えたので、これは投稿を止める理由ではなくなった。
       * 問題ではなく注記として、原因ごとに1行だけ出す。
       */
      let stats = [];
      try { stats = buzzFetchStats_(); } catch (e) {}

      /*
       * ★同じ原因は件数でまとめ、板ごとの内訳は「応答があった板」だけ出す。
       *
       * 403が17行並ぶのは原因1つの繰り返しなので畳む。
       * 逆に、200を返したのに0件だった板は畳んではいけない。
       * そこは「閾値が高すぎるのか、動画が無い板なのか」を
       * 数字で判断すべき場所で、畳むと推測に戻る。
       */
      let reddit403 = 0, redditOther = 0, ytNoKey = false, ytHttp = 0;
      const detail = [];
      const shown = {};
      stats.forEach(function (s) {
        if (String(s.sub) === 'YouTube') {
          if (s.http === -3) ytNoKey = true;
          else if (s.http !== 200) ytHttp = s.http;
          return;
        }
        if (s.http === 403) { reddit403++; return; }
        if (s.http === 200) {
          if (shown[s.sub]) return;
          shown[s.sub] = true;
          // ★どこで落ちたかを数字で出す（取得→スコア→動画の順に絞られる）
          detail.push('   r/' + s.sub + ': 取得' + s.total +
                      ' → スコア通過' + s.scored + ' → 動画' + s.motion);
          return;
        }
        if (shown[s.sub]) return;
        shown[s.sub] = true;
        redditOther++;
        if (s.http === 404) { detail.push('   r/' + s.sub + ': HTTP404（板が存在しない）'); return; }
        if (s.http === 429) { detail.push('   r/' + s.sub + ': HTTP429（叩きすぎ。時間を置く）'); return; }
        if (s.http === -1) { detail.push('   r/' + s.sub + ': 到達不可'); return; }
        if (s.http === -2) { detail.push('   r/' + s.sub + ': 応答が壊れている'); return; }
        detail.push('   r/' + s.sub + ': HTTP' + s.http);
      });

      const causes = [];
      if (reddit403) {
        // ★403は原因が判明している（Redditは2026-05-28に未認証APIを廃止）。
        //   板ごとに繰り返さない
        causes.push('Reddit ' + reddit403 + '板: 認証が必要（未認証APIは廃止済み）');
      }
      if (ytNoKey) causes.push('YouTube: APIキー未設定 →「初期設定 <YouTubeのキー>」');
      else if (ytHttp) causes.push('YouTube: HTTP' + ytHttp);

      notes.push('ℹ️ ' + k + ': 話題の材料は0件（' +
                 (causes.length ? causes.join(' / ') : '理由不明') +
                 '）。映像そのものを題材にして投稿します');
      detail.forEach(function (d) { notes.push(d); });
    } else if (buzzRelaxedScore_()) {
      // 黙って基準を下げない
      notes.push('⚠️ ' + k + ': スコア' + buzzMinScore_() + '以上が無く、' +
                 buzzRelaxedScore_() + '以上まで下げて取得しました');
    }
  });

  // --- 6. 投稿できる状態か ---
  Object.keys(ACCOUNTS).forEach(function (k) {
    if (isAccountStopped_(k)) {
      problems.push('❌ ' + k + ': 停止中 →「再開」');
    } else if (isOverMonthlyCap_(k)) {
      problems.push('❌ ' + k + ': 今月の上限に到達 →「上限なし」で解除');
    }
    /*
     * ★遮断器の状態を出す（2026-08-24）。
     *
     * 401/403/429での遮断は停止フラグを立てないので、ここに出さないと
     * 「診断は全部緑なのに片方だけ何も出ない」になる。実際
     * 「Bは動画が出るのにAが出ない」を追う時、これが見えず遠回りした。
     */
    const blockedMin = xBlockRemainMinutes_(k);
    if (blockedMin) {
      problems.push('❌ ' + k + ': Xが拒否したため約' + blockedMin +
                    '分Xを叩きません →「再開」で即解除');
    }
    // 日割り上限は手動の「バズ」で越えるので、問題として出さない
  });

  /* ---------------------------------------------------------------- */

  // Veoは有効な時だけ1行出す（無効なら黙っている）
  let veoLine = '';
  try {
    if (typeof veoEnabled_ === 'function' && veoEnabled_()) veoLine = veoStatusLine_();
  } catch (e) {}

  let vaultLine = '';
  try {
    if (typeof vaultStatusLine_ === 'function') vaultLine = vaultStatusLine_();
  } catch (e) {}

  /*
   * ★★自動実行の最後の結果を必ず出す（2026-08-24）。
   *
   * 「何も変わらない」と言われた時、まず知りたいのは
   * 「そもそも動いたのか」「動いて何が起きたのか」の2つ。
   * 診断が設定の話しかしないので、そこが分からず推測に頼っていた。
   */
  const lastLines = ['— 自動実行の最後の結果 —'];
  Object.keys(ACCOUNTS).forEach(function (k) {
    const l = buzzLastOutcome_(k);
    lastLines.push('  ' + k + ': ' + (l || '記録なし（まだ一度も動いていません）'));
  });
  if (stopped.length) {
    lastLines.push('  ⏸ バズ停止中: ' + stopped.join('・') + '（意図的なら問題ありません）');
  }
  lastLines.push('  版 ' + BUILD_STAMP);
  const lastBlock = lastLines.join('\n');

  if (!problems.length) {
    return [
      '✅ バズモードは正常です',
      '',
      '素材 ' + stockTotal + '本 / 神動画 ' + matTotal + '件',
      vaultLine,
      veoLine,
      notes.length ? notes.join('\n') : '',
      '',
      lastBlock,
      '',
      '「バズ」と送ると今すぐ1本出します。'
    ].filter(String).join('\n');
  }

  return [
    '🔥 バズモードの問題（' + problems.length + '件）',
    '',
    problems.join('\n'),
    '',
    notes.length ? notes.join('\n') + '\n' : '',
    lastBlock,
    '',
    '直したら「バズ」で試せます。'
  ].filter(String).join('\n');
}

/**
 * GASエディタから手で実行するための公開ラッパー。
 * ★末尾がアンダースコアの関数は実行メニューに出ない。
 */
function runBuzzNow() {
  console.log(runBuzzNowForLine_(''));
}

function diagnoseBuzz() {
  console.log(buildBuzzDiagText_());
}


/**
 * メディアが用意できず投稿を中断したことを知らせる。
 *
 * ★毎回通知すると本当に見るべき通知が埋もれる。6時間に1回まで。
 * ただし「黙って止まる」のが一番危ないので、完全に無音にはしない。
 */
const BUZZ_ABORT_NOTIFIED_PROP = 'buzz_abort_notified_at';

function notifyMediaAbortOnce_(accountKey, mediaKind) {
  /*
   * ★同じ文面が続く限り間隔を倍にする（notifyAdminOnce_）。
   * 原因が変わらないのに6時間おきに同じ通知が来ると、
   * 本当に見るべき通知が埋もれる（2026-08-22、オーナー指摘）。
   *
   * 原因（在庫0なのか、キー未設定なのか）を文面に含めるので、
   * 状況が変われば文面も変わり、その時はすぐ届く。
   */
  let cause = '原因不明';
  try {
    // ★まずメディア権限を疑う。無ければ何をやっても403で落ちる
    if (hasMediaScope_(accountKey) === false) {
      cause = 'media.write 権限が無い →「Xリンク ' + accountKey + '」で再連携が必要';
    } else if (!getProp_('PEXELS_API_KEY', '') && !getProp_('PIXABAY_API_KEY', '')) {
      cause = '素材APIのキーが未設定';
    } else if (!videoUploadEnabled_()) {
      cause = 'VIDEO_UPLOAD が無効';
    } else {
      let n = 0;
      Object.keys(ACCOUNTS).forEach(function (k) {
        try { n += freshStock_(k).length; } catch (e) {}
      });
      cause = n > 0 ? ('在庫は' + n + '本あるが取得に失敗') : '使える在庫が0本';
    }
  } catch (e) {}

  try {
    /*
     * ★短くする（2026-08-22、オーナー指示「シンプルに」）。
     * 毎回「なぜメディアが必要か」を10行説明していた。理由は既に
     * 分かっているので、原因と次の一手だけでいい。
     */
    notifyAdminOnce_('buzz_media_abort',
      '⚠️ ' + accountKey + ': メディアが無いため中断\n' +
      cause + '\n→「バズ診断」');
  } catch (e) {}
}
