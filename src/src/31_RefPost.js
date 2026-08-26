/**
 * ===========================================================================
 * 31_RefPost.gs  —  参照投稿（他人の動画投稿へURLで乗る）
 * ===========================================================================
 *
 * ★何をするか（オーナー指示 2026-08-21）
 *
 * 他人の動画をダウンロードして再アップロードしない。代わりに、
 * バズっている動画付き投稿のURLを本文の末尾に付けて投稿する。
 * 複製が発生しないので、著作権上の問題もDMCAの凍結リスクも無い。
 *
 * ★実装前に確認した3点（推測ではなく調べた結果）
 *
 * 1. **タイムラインでの見え方は「引用カード」**。
 *    URLを貼った投稿は、元投稿の著者名・本文・メディアを含む
 *    カードとして描画される。自分の投稿にネイティブ動画が付くのとは違う。
 *    再生はできるが、動画は元の著者の名前と共に表示される。
 *    ⚠️ 実機で確認していない。この環境から x.com へ到達できないため。
 *
 * 2. **`has:video` はこの階層で 400 を返す**（リポジトリ内の実測記録）。
 *    検索演算子では動画付き投稿を絞り込めない。
 *    → 通常検索で取得し、`includes.media` の種別を自前で見る。
 *      18_QuoteEngine.gs の hasVideo がそれ。
 *
 * 3. **これはリンク付き投稿**。バズモード(28_Buzz.gs)は
 *    「Xがリンク付き投稿の到達を落とす」という理由でURLを禁じている。
 *    同じ枠に入れると、その前提と正面から衝突する。
 *    → 別の種類(POST_KIND_HIJACK)として分け、
 *      バズモードの安全装置(assertNoLinksForBuzz_)には掛けない。
 *      どちらが伸びるかは、出してから数字で比べる。
 *
 * ★見ていないものを断定させない
 * 動画の中身はこちらからは見えない。本文しか読めない。
 * 「この動画の◯◯が」と書けば嘘になる。
 * 既存の checkQuoteClaims_ をそのまま使って弾く。
 */

/** 投稿の種類。24_PostMix.gs の POST_KIND_* と同じ空間。 */
const POST_KIND_HIJACK = 'HIJACK';

/** 参照投稿を使うか。既定は無効（伸びるか未検証のため）。 */
function refPostEnabled_() {
  return String(getProp_('REF_POST', '0')) === '1';
}

/** 参照URLの形式。x.com / twitter.com を切り替えられるようにしておく。 */
function buildRefUrl_(tweetId) {
  const id = String(tweetId || '').replace(/[^0-9]/g, '');
  if (!id) return '';
  const host = String(getProp_('REF_POST_HOST', 'x.com')).trim() || 'x.com';
  return 'https://' + host + '/i/status/' + id;
}

/** 同じ投稿に二度乗らないための記録。 */
const REF_USED_PROP = 'ref_used_ids';

function refAlreadyUsed_(tweetId) {
  const id = String(tweetId || '');
  return String(getProp_(REF_USED_PROP, '')).split(',').indexOf(id) >= 0;
}

function noteRefUsed_(tweetId) {
  try {
    const list = String(getProp_(REF_USED_PROP, '')).split(',').filter(Boolean);
    list.push(String(tweetId));
    // 直近100件だけ覚える。プロパティの上限に当たらない範囲
    props_().setProperty(REF_USED_PROP, list.slice(-100).join(','));
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* 対象を探す                                                           */
/* ------------------------------------------------------------------ */

/**
 * 動画付きでバズっている投稿を1件選ぶ。
 *
 * ★X検索は課金対象で、1日の上限がある（既定2回）。
 * この機能は検索を必ず1回使うため、上限に当たれば何もしない。
 * 無料の情報源では代替できない（Xの投稿IDが要るため）。
 *
 * @return {?{id:string, text:string, author:string, likes:number}}
 */
function findRefTarget_(accountKey) {
  const key = String(accountKey || '').toUpperCase();

  if (!xSearchAllowed_()) {
    console.log('X検索が本日の上限に達しているため、参照投稿は見送ります。');
    return null;
  }

  let found = [];
  try {
    // ★has:video は使えない（400）。通常検索し、メディア種別で自前で絞る
    found = searchQuoteTargets_(key) || [];
  } catch (e) {
    console.warn('参照対象の検索に失敗: ' + truncate_(String(e), 120));
    return null;
  }

  const usable = found.filter(function (t) {
    if (!t.hasVideo) return false;              // 動画が無ければ乗る意味がない
    if (t.sensitive) return false;              // 判定できないものには乗らない
    if (refAlreadyUsed_(t.id)) return false;    // 同じ投稿に二度乗らない
    if (String(t.text || '').length < 20) return false;  // 話題が読み取れない
    return true;
  });

  if (!usable.length) {
    console.log('動画付きの対象が見つかりませんでした（' + found.length + '件中）。');
    return null;
  }
  return usable[0];   // searchQuoteTargets_ はいいね順に並べて返す
}

/* ------------------------------------------------------------------ */
/* 本文                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 参照投稿のフックを作る。
 *
 * ★動画は見えない。本文しか読めない。
 * 「この動画の〜」と書けば嘘になるので、既存の checkQuoteClaims_ で弾く。
 * 引用エンジンが同じ問題を既に解いているので、判定はそちらへ委ねる。
 */
function buildRefPrompt_(accountKey, target) {
  const key = String(accountKey || '').toUpperCase();

  const voice = (key === 'B')
    ? 'You run an account that points English speakers at Japanese doujin work. ' +
      'You are a fan, not a store.'
    : 'You run an account about tools, gadgets, and things that are made well.';

  return [
    '# Your job',
    'Someone posted this on X and it is getting attention.',
    'Write ONE short reaction that makes people want to reply to YOU.',
    '',
    '# ' + voice,
    '',
    '# What you can and cannot see',
    'You can read the TEXT of their post. You CANNOT see the video or images.',
    '- Never write "in the video", "the clip shows", "watch how", or anything',
    '  that claims you watched it. You did not.',
    '- React to the CLAIM or the TOPIC in their text, not to footage.',
    '',
    '# Hard rules',
    '- Do NOT write any URL. The link is added by the system afterwards.',
    '- Do NOT say "check this out", "must watch", "link below". Weak and obvious.',
    '- Take a position. Agreement with no angle earns nothing.',
    '- Under 200 characters. The link takes space.',
    '- Do not invent numbers or facts.',
    '',
    '# Their post',
    truncate_(String(target.text || ''), 600),
    '',
    '# Output',
    'Return ONLY your reaction text. No quotes, no explanation.'
  ].join('\n');
}

/**
 * 本文を生成する。
 * @return {?{text:string, qualityScore:number}}
 */
function generateRefText_(accountKey, target) {
  const key = String(accountKey || '').toUpperCase();
  const systemPrompt = buildRefPrompt_(key, target);

  let lastText = '';
  let critique = '';

  for (let attempt = 1; attempt <= llmMaxAttempts_(); attempt++) {
    const userPrompt = attempt === 1
      ? 'Write your reaction.'
      : ('Your previous attempt:\n' + lastText +
         '\n\nProblem: ' + critique + '\n\nFix ONLY that.');

    let raw;
    try {
      raw = callLLM_(systemPrompt, userPrompt);
    } catch (err) {
      if (isSafetyBlock_(err)) {
        console.warn('安全フィルタのため、この対象は見送ります。');
        return null;
      }
      throw err;
    }

    let text = sanitizeGeneratedText_(raw);
    if (!text) continue;

    // ★URLは必ずこちらで付ける。本文に書かせない
    text = stripUrls_(text).trim();
    if (!text) {
      lastText = raw; critique = 'You wrote only a link. Write a real reaction.';
      continue;
    }

    // 見ていないものを断定していないか（引用エンジンと同じ検査）
    const claims = checkQuoteClaims_(text, key, { hasRead: false });
    if (!claims.ok) {
      lastText = text; critique = claims.reason;
      continue;
    }

    const verdict = evaluatePost_(key, text, 'QUOTE', String(target.text || ''));
    if (!verdict.ok) {
      lastText = text; critique = verdict.critique;
      continue;
    }

    return { text: text, qualityScore: verdict.score };
  }

  console.log('参照投稿の本文が基準に届きませんでした (' + key + ')。');
  return null;
}

/* ------------------------------------------------------------------ */
/* 実行                                                                 */
/* ------------------------------------------------------------------ */

/** A/Bを順番に試す。1本出せたら true。 */
function runRefCycleAll_() {
  if (!refPostEnabled_()) return false;

  const first = nextAccountInTurn_('ref_turn');
  const order = [first].concat(Object.keys(ACCOUNTS).filter(function (k) {
    return k !== first;
  }));

  for (let i = 0; i < order.length; i++) {
    try {
      if (runRefCycle_(order[i])) return true;
    } catch (err) {
      console.error('参照投稿に失敗 (' + order[i] + '): ' +
                    (err && err.stack ? err.stack : err));
    }
  }
  return false;
}

/**
 * 1アカウントぶんの参照投稿。
 * @return {boolean} 投稿できたら true
 */
function runRefCycle_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  if (!refPostEnabled_()) return false;
  if (isAccountStopped_(key)) return false;

  // 出せない回は検索もLLMも使わない（X検索は課金対象）
  if (isOverMonthlyCap_(key) || isOverDailyPace_(key)) {
    console.log('上限に達しているため参照投稿を見送ります (' + key + ')。');
    return false;
  }

  const target = findRefTarget_(key);
  if (!target) return false;

  const refUrl = buildRefUrl_(target.id);
  if (!refUrl) {
    console.warn('参照URLを組み立てられませんでした: ' + target.id);
    return false;
  }

  const generated = generateRefText_(key, target);
  if (!generated) return false;

  /*
   * ★本文とURLを改行2つで繋ぐ。
   * 1つだと本文の続きに見え、カードとの境目が分からなくなる。
   */
  const finalText = generated.text + '\n\n' + refUrl;

  /*
   * ★noLink は渡さない。リンクを載せるのがこの機能の目的で、
   * バズモードの安全装置(assertNoLinksForBuzz_)を掛けてはいけない。
   * 掛けると必ず例外になり、1本も出せなくなる。
   */
  const result = postTweet_(key, finalText, {});

  noteRefUsed_(target.id);

  const ss = openLogSpreadsheet_();
  appendLogRow_(ss, buildLogRow_({
    account: key,
    status: QUEUE_STATUS_POSTED,
    text: finalText,
    region: pickRegionByJstHour_(),
    // ★classifyPostKind_ がこの文字列で種類を判別する
    angle: 'HIJACK_REF',
    format: 'ref',
    postId: result.id,
    hash: result.contentHash,
    hasLink: true,
    cost: result.costEstimate,
    model: getProp_('LLM_MODEL', LLM_DEFAULT_MODEL),
    role: 'HIJACK',
    qualityScore: generated.qualityScore
  }));

  resetPoorQualityStreak_(key);
  console.log('参照投稿しました (' + key + ' / 元: @' + target.author +
              ' ' + target.likes + 'いいね): ' + (result.url || result.id));
  return true;
}

/* ------------------------------------------------------------------ */
/* LINE / エディタからの操作                                             */
/* ------------------------------------------------------------------ */

/** 「参照投稿」コマンド。今すぐ1本出す。 */
function runRefNowForLine_(accountKey) {
  if (!refPostEnabled_()) {
    return [
      '⏸ 参照投稿は無効です（既定）。',
      '',
      'REF_POST を 1 にすると有効になります。',
      '',
      '⚠️ 有効にする前に知っておくこと:',
      '  ・タイムラインでは「引用カード」として出ます。',
      '    自分の投稿に動画が付くのではなく、元の著者名と一緒に出ます',
      '  ・リンク付き投稿になります。バズモードがURLを禁じているのは',
      '    Xがリンク付き投稿の到達を落とすためで、前提が逆になります',
      '  ・1本ごとにX検索を1回使います（課金対象・1日の上限あり）'
    ].join('\n');
  }

  const key = accountKey ? String(accountKey).toUpperCase() : '';
  try {
    const ok = key ? runRefCycle_(key) : runRefCycleAll_();
    if (ok) return '✅ 参照投稿を出しました' + (key ? '（' + key + '）' : '') + '。';
    return [
      '⚠️ 参照投稿を作れませんでした' + (key ? '（' + key + '）' : '') + '。',
      '',
      'よくある原因:',
      '  ・X検索が本日の上限（' + xSearchDailyMax_() + '回）に達している',
      '  ・動画付きの対象が見つからなかった',
      '  ・今日のぶんを使い切っている',
      '  ・品質基準に届かなかった'
    ].join('\n');
  } catch (err) {
    return '❌ 参照投稿でエラー\n' +
           truncate_(String(err && err.message ? err.message : err), 300);
  }
}

/** GASエディタ用の公開ラッパー。 */
function runRefPostNow() {
  console.log(runRefNowForLine_(''));
}
