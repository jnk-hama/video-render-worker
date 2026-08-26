/**
 * ===========================================================================
 * 02_XApi.gs  —  X API v2 呼び出し
 * ===========================================================================
 */

/**
 * 直前の投稿と同一内容だったことを示すエラー。
 * Xは重複投稿を403で拒否するが、その時点で既にAPI呼び出しは消費されている。
 * 呼び出し前に自前で弾いてクレジットを節約するために使う。
 */
class DuplicatePostError extends Error {
  constructor(accountKey) {
    super('直前の投稿と同じ本文のため、送信せずに中止しました。');
    this.name = 'DuplicatePostError';
    this.accountKey = accountKey;
  }
}

/**
 * 過去に投稿済みの内容だったことを示すエラー（コンテンツハッシュ一致）。
 * 直前1件だけを見る DuplicatePostError より広い範囲を守る。
 */
class DuplicateContentError extends Error {
  constructor(accountKey, hash) {
    super('過去' + HASH_HISTORY_DAYS + '日以内に同じ内容を投稿済みのため、送信せずに中止しました。');
    this.name = 'DuplicateContentError';
    this.accountKey = accountKey;
    this.contentHash = hash;
  }
}

/**
 * Xへ送ったが、投稿されたかどうか確定できない状態を示すエラー。
 *
 * 通信断・タイムアウト・5xx がこれにあたる。
 * 「失敗した」と決めつけて再送すると、実は成功していた場合に二重投稿になる。
 * この場合は必ず人間が確認する。自動で再送してはいけない。
 */
class IndeterminatePostError extends Error {
  constructor(accountKey, reason) {
    super('Xへ送信しましたが、結果を確認できませんでした（' + reason + '）。' +
          '自動再投稿は行いません。Xのタイムラインを確認してください。');
    this.name = 'IndeterminatePostError';
    this.accountKey = accountKey;
  }
}

/** 最後に投稿に成功した本文を保持するプロパティ名 */
function lastPostTextKey_(accountKey) {
  return 'last_post_text_' + String(accountKey).toUpperCase();
}

/**
 * 引用がAPIアクセス階層の制限で拒否されたことを示すエラー。
 *
 * ★名前付きにしている理由。
 * 呼び出し側（runQuoteEngine）は「この403だから素のリツイートへ
 * フォールバックする」という判断をしたい。フラグ（isQuoteBlocked_）だけを
 * 見て判定すると、別の理由（レート制限・重複投稿）で失敗した回にも
 * 過去のフラグが立ったままフォールバックしてしまう。エラーの型そのもので
 * 判定すれば、「今回まさにこの理由で失敗したか」を取り違えない。
 */
class QuotePermissionError extends Error {
  constructor(accountKey) {
    super('引用は現在のAPIアクセスでは許可されていません（引用のみ見送り。' +
          '情報源投稿・単独投稿は通常どおり続きます）。');
    this.name = 'QuotePermissionError';
    this.accountKey = accountKey;
  }
}

/* ------------------------------------------------------------------ */
/* 引用のみを諦める（POST_MODE全体は変更しない）                          */
/* ------------------------------------------------------------------ */
/*
 * ★quote専用のフラグ。POST_MODEとは完全に独立させる。
 *
 * 「引用が権限で使えない」と「情報源投稿・単独投稿が使えない」は無関係。
 * 昔はPOST_MODEを書き換えて両方まとめて止めていたが、情報源投稿
 * （RSS/YouTubeへの反応）が主力になった今、それは実害が大きすぎる。
 */
function quoteBlockedProp_(accountKey) {
  return 'quote_blocked_' + String(accountKey).toUpperCase();
}

/** 引用が権限で使えないと分かっているか。 */
function isQuoteBlocked_(accountKey) {
  return getProp_(quoteBlockedProp_(accountKey), '') === 'true';
}

/** 通知は1回だけ。原因は恒久的（APIアクセス階層の制限）なので毎回言う必要はない。 */
function notifyQuoteBlockedOnce_(accountKey) {
  const key = 'quote_blocked_notified_' + String(accountKey).toUpperCase();
  if (getProp_(key, '')) return;
  try { props_().setProperty(key, String(Date.now())); } catch (e) {}
  notifyAdmin_([
    'ℹ️ ' + accountKey + ': 引用リポストのみ無効にしました（この通知は最初の1回だけ）',
    '',
    'Xからの回答:',
    '「自分が言及された投稿、または自分が書いた投稿しか引用できません」',
    '',
    'これはAPIアクセス階層の制限で、コードでは解決できません。',
    '',
    '引用だけを見送ります。情報源投稿（RSS/YouTubeへの反応）・単独投稿は',
    '通常どおり続きます。「状態」または「点検」で今の投稿モードを確認できます。'
  ].join('\n'));
}

/**
 * ツイートを投稿する。
 * @return {{id:string, url:string, monthlyCount:number}}
 * @throws {NeedsAuthError} 未連携の場合
 * @throws {DuplicatePostError} 直前の投稿と同一内容の場合（API呼び出し前に中止）
 * @throws {Error} その他のAPIエラー（メッセージはLINEにそのまま返せる文面にしてある）
 */
function postTweet_(accountKey, text, opts) {
  const acc = getAccount_(accountKey);
  const options = opts || {};

  if (!text || !text.trim()) {
    throw new Error('投稿本文が空です。');
  }

  // 異常検知で停止中なら、何もせずここで止める。
  // 止まっているのに投稿を試みると、同じエラーで通知が溢れる。
  if (isAccountStopped_(accountKey)) {
    // ★理由はこのアカウント自身のものを出す。
    // 共有枠を読んでいた頃は、Aの停止画面にBの理由が出ていた。
    throw new Error(
      acc.label + ' は現在停止中です。\n理由: ' + stopReasonFor_(accountKey) +
      '\nLINEで「再開」と送ると解除できます。');
  }

  // 402で止まっている最中に、時間を置いた自動再試行として通ってきた回。
  // ここで1回ぶんを消費する（判定側では記録しない。何度も呼ばれるため）。
  noteCreditRetryAttempt_(accountKey);

  // トークンの持ち主が想定どおりか確認する（取り違え投稿の防止）
  assertAccountBinding_(accountKey);

  // 直前と同一本文ならAPIを叩かずに中止する。
  // Xは重複を403で返すが、その時点で課金対象の呼び出しは消費済みになる。
  // ここで止めればクレジットを無駄にしない。
  if (getProp_(lastPostTextKey_(accountKey)) === text) {
    console.warn('重複のため送信を中止 [' + accountKey + ']: ' + truncate_(text, 80));
    throw new DuplicatePostError(accountKey);
  }

  // 直前1件だけでなく、過去30日ぶんと突き合わせる。
  // Geminiの再生成・手動実行・トリガー重複・復旧処理など、
  // 「直前とは違うが以前と同じ」経路をここで塞ぐ。
  const hash = contentHash_(accountKey, text, options.url || '');
  if (isDuplicateContentHash_(accountKey, hash)) {
    console.warn('コンテンツハッシュ一致のため送信を中止 [' + accountKey + '] ' + hash);
    throw new DuplicateContentError(accountKey, hash);
  }

  // 完全一致でなくても「実質同じ」なら止める（1単語だけ変えた投稿など）。
  // 明示的に許可された場合のみ飛ばす。
  if (!options.allowSimilar) {
    assertNotTooSimilar_(accountKey, text);
  }

  /*
   * ★固定CTA（VPN等）はここで足す。位置に意味がある。
   *
   * 重複・ハッシュ・類似の各検査は「本文だけ」を見るべきで、
   * 毎回同じCTAを含めた状態で比べると類似度が底上げされ、
   * 本来通るはずの投稿がブロックされる（実測: 0.31〜0.58 → 0.73〜0.87、
   * しきい値0.72超）。だから検査を全て通した後に足す。
   * 長さ検査より前なのは、CTA込みで上限を超えないか見るため。
   */
  const postedBody = text;

  /*
   * ★バズ投稿にはCTAを足さない（28_Buzz.gs）。
   *
   * ここが穴だった。固定CTAは「本文にリンクが無ければ足す」という条件で
   * 動くため、リンクを載せずに作った投稿ほど確実にURLが付いていた。
   * BUZZモードを名乗るだけでは成立せず、この分岐が要る。
   */
  const noLink = !!options.noLink;
  const cta = noLink
    ? { text: postedBody, attached: false, reason: 'バズ投稿のためCTAを付けない' }
    : attachFixedCta_(accountKey, postedBody, getTweetMaxLen_(accountKey));
  text = cta.text;

  /*
   * ★安全装置。送信直前・CTA適用後に検査する。
   *
   * 生成側のプロンプトにも「リンクを書くな」と指示してあるが、指示は破られる。
   * 実際に送る文字列そのものを最後に見なければ保証にならない。
   * ここで例外にすると、その回は投稿されず次のトリガーで作り直される。
   */
  if (noLink) {
    assertNoLinksForBuzz_(text);
  }

  const weighted = estimateWeightedLength_(text);
  const maxLen = getTweetMaxLen_(accountKey);
  if (weighted > maxLen) {
    throw new Error(
      '本文が長すぎます（約 ' + weighted + ' / ' + maxLen + ' 文字相当）。' +
      Math.ceil(weighted - maxLen) + ' 文字ぶん削ってください。' +
      (maxLen <= TWEET_MAX_WEIGHTED_LENGTH
        ? '\n※280字超の長文投稿には X Premium が必要です。加入済みなら ' +
          'TWEET_MAX_LEN_' + String(accountKey).toUpperCase() + ' に上限値を設定してください。'
        : '')
    );
  }

  if (isOverMonthlyCap_(accountKey)) {
    throw new Error(
      acc.label + ' は今月のソフトキャップ（' + getProp_('MONTHLY_SOFT_CAP') + '件）に達しています。' +
      '上限を変えるにはスクリプトプロパティ MONTHLY_SOFT_CAP を調整してください。'
    );
  }

  const service = getXService_(accountKey);
  if (!service.hasAccess()) {
    throw new NeedsAuthError(accountKey);
  }

  let accessToken;
  try {
    accessToken = service.getAccessToken();   // 期限切れならここで自動リフレッシュされる
  } catch (err) {
    // リフレッシュトークンの失効・revoke など。再認証が必要。
    console.error('トークン取得失敗(' + accountKey + '): ' + err);
    throw new NeedsAuthError(accountKey);
  }

  // ★投稿APIだけは絶対にリトライしない。
  // fetchWithRetry_ は5xxを再送するが、投稿でそれをやると
  // 「1回目は実は成功していた」場合に二重投稿になる。
  // 結果が確定できない事象は、再送ではなく IndeterminatePostError にして人間へ回す。
  let response;
  try {
    response = UrlFetchApp.fetch(X_TWEETS_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + accessToken },
      payload: JSON.stringify(buildTweetPayload_(text, options)),
      muteHttpExceptions: true
    });
  } catch (err) {
    // 通信断・タイムアウト。Xに届いたかどうかは分からない。
    console.error('投稿の送信中に通信エラー [' + accountKey + ']: ' + err);
    throw new IndeterminatePostError(accountKey, '通信エラー: ' + truncate_(String(err), 120));
  }

  const code = response.getResponseCode();
  const bodyText = response.getContentText();

  if (code === 201 || code === 200) {
    let id = '';
    try { id = JSON.parse(bodyText).data.id; } catch (e) {}
    /*
     * ★記録するのは固定CTAを除いた本文（postedBody）。
     * CTA込みで覚えると、毎回同じ84字が履歴に混ざって以後の
     * 類似度が全体的に底上げされ、正常な投稿が徐々に通らなくなる。
     * 判定対象と記録対象は必ず揃える。
     */
    props_().setProperty(lastPostTextKey_(accountKey), postedBody);
    // ハッシュと本文は投稿成功後にだけ記録する。
    // 失敗分まで覚えると、書き直した投稿が永久に出せなくなる。
    rememberContentHash_(accountKey, hash);
    rememberRecentText_(accountKey, postedBody);
    recordPostSuccess_(accountKey);   // 連続エラー・429の計数をリセット
    // 402で止まっていたなら、通った時点で残高が戻ったと確認できる。
    clearAccountStopAfterSuccess_(accountKey);
    const count = incrementMonthlyCount_(accountKey);
    incrementDailyCount_(accountKey);   // 日割りペース配分の消化に使う
    const username = getStoredUsername_(accountKey);
    const url = id
      ? (username ? 'https://x.com/' + username + '/status/' + id
                  : 'https://x.com/i/web/status/' + id)
      : '';
    const hasLink = containsLink_(text);
    return {
      id: id,
      url: url,
      monthlyCount: count,
      contentHash: hash,
      hasLink: hasLink,
      costEstimate: estimateXPostCost_(hasLink)
    };
  }

  // 5xxも「送られていない」と断定できない。再送せず人間の確認へ回す。
  if (code >= 500) {
    console.error('投稿が5xx [' + accountKey + '] ' + code + ': ' + truncate_(bodyText, 200));
    throw new IndeterminatePostError(accountKey, 'HTTP ' + code);
  }

  /*
   * ★引用が権限で拒否されるのは「壊れている」のではなく「できない」。
   * Xはこのアクセス階層に対し、自分が言及された投稿か自分が書いた投稿しか
   * 引用させない。恒久的な制限なので、緊急停止で全投稿を止めるのは誤り
   * （実際にこれでBが停止した）。引用だけを諦める。
   *
   * 【2026-08-16に見つけた重大な副作用】
   * ここで POST_MODE を 'standalone' に書き換えていた。しかし
   * 06_Scheduler.gs の分岐は「mode !== 'standalone'」を条件に
   * 引用サイクルと情報源サイクル（RSS/YouTube反応投稿）の両方を
   * まとめて実行している。つまりこの403が一度でも実際に起きると、
   * 引用だけでなく情報源からの反応投稿まで丸ごと止まる。
   *
   * しかも POST_MODE はどの診断コマンドにも表示されていなかった
   * （diagnoseQuote_ にはあるが、日常的に打つ「点検」「状態」には無い）。
   * 気づく手段が無いまま、本命である情報源投稿だけが止まり続ける
   * 状態になり得た。
   *
   * 引用が使えないことと、情報源投稿が使えることは別の話なので、
   * ここでは quote 専用のフラグだけを立てる。POST_MODE には触らない。
   */
  if (code === 403 && options.quoteTweetId &&
      /only reply to or quote posts/i.test(String(bodyText))) {
    console.warn('引用が権限で拒否されました。引用だけを諦め、他は続けます。');
    try { props_().setProperty(quoteBlockedProp_(accountKey), 'true'); } catch (e) {}
    notifyQuoteBlockedOnce_(accountKey);
    throw new QuotePermissionError(accountKey);
  }

  const apiError = buildXApiError_(acc, code, bodyText, response.getAllHeaders());
  // 401/402/403/429 は再試行で直らない、または放置すると被害が広がる。
  // ここで種別を仕分けし、必要なら自動停止する（P1-11 キルスイッチ）。
  handlePostFailure_(accountKey, apiError);
  throw apiError;
}

/**
 * 素のリツイート（POST /2/users/:id/retweets）。
 *
 * ★postTweet_ とは意図的に例外の投げ方を変えている。
 * postTweet_ は「失敗したら例外」で、呼び出し側は個別にcatchする設計。
 * こちらは quote-403 を受けての自動フォールバックとして毎サイクル
 * 呼ばれ得るので、失敗も含めて構造化した戻り値にし、
 * 呼び出し側（runQuoteEngine・attemptRetweet_）が判断できるようにする。
 * 例外にすると「引用も失敗・リツイートも失敗」を1回のtry/catchで
 * 握りつぶすことになり、どちらが失敗したのか分からなくなる。
 *
 * @return {{ok:boolean, code:number, body:string}}
 */
function postRetweet_(accountKey, tweetId) {
  const service = getXService_(accountKey);
  if (!service.hasAccess()) throw new NeedsAuthError(accountKey);

  const userId = getXUserId_(accountKey);
  if (!userId) {
    return { ok: false, code: 0, body: '自分のユーザーIDを取得できませんでした（users/me 失敗）。' };
  }

  const url = 'https://api.x.com/2/users/' + encodeURIComponent(userId) + '/retweets';
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + service.getAccessToken() },
      payload: JSON.stringify({ tweet_id: String(tweetId) }),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, code: 0, body: '通信エラー: ' + truncate_(String(e), 200) };
  }

  const code = res.getResponseCode();
  const body = truncate_(res.getContentText(), 500);
  return { ok: (code === 200 || code === 201), code: code, body: body };
}

/**
 * 「投稿結果不明」を、実際にX側を見て確定させる。
 *
 * ★従来はUNKNOWNになったら「Xのタイムラインを人間が確認してください」
 * だけだった。これはこれで安全だが、確認できる情報がXに既にあるのに
 * 毎回人間の目視に頼っていた。自分の直近ツイートを取得し、
 * 送ろうとした本文と完全一致するものが無いかを見る。
 *
 * 【非対称に扱う理由】
 * 一致する投稿が「見つかった」ことは強い証拠になる（自分のアカウントの
 * 直近ツイートに、寸分違わぬ本文が実在する）。一方「見つからなかった」
 * ことは弱い証拠にしかならない（X側の反映遅延・ページングの範囲外・
 * 取得件数の上限などで、実際には投稿済みなのに見えないことがある）。
 * だから「見つかった→投稿済みと確定してよい」だけを自動化し、
 * 「見つからなかった→未投稿と断定」はしない。そこは従来どおり
 * 人間の判断に残す。
 *
 * @param {string} accountKey
 * @param {string} text 送ろうとしていた本文（完全一致で照合する）
 * @return {{checked:boolean, found:boolean, tweetId:string, url:string, note:string}}
 */
function checkRecentTweetsForText_(accountKey, text) {
  const empty = { checked: false, found: false, tweetId: '', url: '', note: '' };
  const target = String(text || '').trim();
  if (!target) return empty;

  let service;
  try {
    service = getXService_(accountKey);
    if (!service.hasAccess()) return Object.assign({}, empty, { note: '未連携のため確認できません。' });
  } catch (e) {
    return Object.assign({}, empty, { note: 'サービス取得に失敗: ' + truncate_(String(e), 150) });
  }

  const userId = getXUserId_(accountKey);
  if (!userId) return Object.assign({}, empty, { note: '自分のユーザーIDを取得できませんでした。' });

  // 直近10件で十分。この確認はUNKNOWNになった直後に呼ぶ想定で、
  // 該当するとしても最新のはず。
  const url = 'https://api.x.com/2/users/' + encodeURIComponent(userId) +
              '/tweets?max_results=10&tweet.fields=created_at';
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + service.getAccessToken() },
      muteHttpExceptions: true
    });
  } catch (e) {
    return Object.assign({}, empty, { note: '通信エラー: ' + truncate_(String(e), 150) });
  }

  const code = res.getResponseCode();
  if (code !== 200) {
    return Object.assign({}, empty,
      { note: '直近ツイートの取得に失敗（HTTP ' + code + '）。' + truncate_(res.getContentText(), 150) });
  }

  let parsed;
  try { parsed = JSON.parse(res.getContentText()); } catch (e) {
    return Object.assign({}, empty, { note: '応答をJSONとして解釈できませんでした。' });
  }

  const tweets = parsed.data || [];
  const hit = tweets.find(function (t) { return String(t.text || '').trim() === target; });

  if (hit) {
    const username = getStoredUsername_(accountKey);
    const link = username
      ? 'https://x.com/' + username + '/status/' + hit.id
      : 'https://x.com/i/web/status/' + hit.id;
    return { checked: true, found: true, tweetId: String(hit.id), url: link,
             note: '直近ツイートに完全一致する本文が見つかりました。' };
  }
  return { checked: true, found: false, tweetId: '', url: '',
           note: '直近' + tweets.length + '件に一致する本文は見つかりませんでした' +
                 '（反映遅延の可能性もあるため、これだけで未投稿と断定はしません）。' };
}

/** HTTPステータスごとに、原因が分かる日本語エラーへ変換する */
function buildXApiError_(acc, code, bodyText, headers) {
  const detail = truncate_(bodyText, 400);
  console.error('X API エラー [' + acc.key + '] ' + code + ': ' + detail);

  if (code === 401) {
    const e = new NeedsAuthError(acc.key);
    e.message = acc.label + ' のトークンが無効です（401）。再連携してください。';
    return e;
  }

  if (code === 403) {
    // 多い順に: 重複投稿 / アプリ権限が Read only / 利用上限到達
    let hint = '';
    if (/duplicate/i.test(bodyText)) {
      hint = '\n→ 直近と同じ本文は重複として拒否されます。文言を変えてください。';
    } else if (/cap|usage/i.test(bodyText)) {
      hint = '\n→ プランの利用上限に達している可能性があります。Developer Portal を確認してください。';
    } else {
      hint = '\n→ X アプリの権限が "Read and write" になっているか確認してください' +
             '（権限を変更した場合は再連携が必要です）。';
    }
    return new Error(acc.label + ' への投稿を拒否されました（403）。' + hint + '\n' + detail);
  }

  // 2026-02にXは従量課金(クレジット制)へ移行し、無料枠は新規向けに廃止された。
  // 残高が無いと投稿実績0でも402が返る。認証やコードの不備と紛らわしいので明示的に案内する。
  if (code === 402) {
    return new Error(
      acc.label + ' はXのクレジット残高が不足しています（402）。\n' +
      '→ Developer Portal でクレジットを購入してください。\n' +
      'https://developer.x.com/en/portal/dashboard\n' +
      '※ クレジットはXのアカウントではなく Developer Portal の開発者アカウントに紐づきます。\n' +
      '　同じ開発者アカウント配下に両アプリがあるなら残高は共有されますが、\n' +
      '　開発者アカウントを分けている場合は別々です。購入前にポータルで確認してください。\n' +
      detail);
  }

  if (code === 429) {
    let resetInfo = '';
    const reset = headers && (headers['x-rate-limit-reset'] || headers['X-Rate-Limit-Reset']);
    if (reset) {
      const d = new Date(Number(reset) * 1000);
      resetInfo = '\n解除見込み: ' + Utilities.formatDate(d, 'Asia/Tokyo', 'MM/dd HH:mm');
    }
    return new Error(acc.label + ' はレートリミット中です（429）。' + resetInfo + '\n' + detail);
  }

  return new Error(acc.label + ' への投稿に失敗しました（HTTP ' + code + '）。\n' + detail);
}

/** users/me からユーザー名を取得。取得できなくても致命傷にしない。 */
function fetchXUsername_(accountKey) {
  const info = fetchXUserInfo_(accountKey);
  return info ? info.username : '';
}

/**
 * users/me から {id, username} を取得する。
 * メンション取得には数値のユーザーIDが必要なため、取得できたら保存しておく
 * （毎回 users/me を叩くと、その分も従量課金の対象になる）。
 * @return {?{id:string, username:string}}
 */
function fetchXUserInfo_(accountKey) {
  const service = getXService_(accountKey);
  if (!service.hasAccess()) return null;

  const res = UrlFetchApp.fetch(X_ME_URL, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.warn('users/me が ' + res.getResponseCode() + ': ' + truncate_(res.getContentText(), 200));
    return null;
  }
  try {
    const d = JSON.parse(res.getContentText()).data || {};
    if (!d.id) return null;
    const info = { id: String(d.id), username: d.username || '' };
    const storage = service.getStorage();
    storage.setValue('user_id', info.id);
    if (info.username) storage.setValue('username', info.username);
    return info;
  } catch (e) {
    return null;
  }
}

/** 保存済みの数値ユーザーID。無ければ users/me を叩いて取得・保存する。 */
function getXUserId_(accountKey) {
  try {
    const stored = getXService_(accountKey).getStorage().getValue('user_id');
    if (stored) return String(stored);
  } catch (e) {}
  const info = fetchXUserInfo_(accountKey);
  return info ? info.id : '';
}

/**
 * 5xx / ネットワーク断のみリトライする。
 * 4xx（重複・レートリミット等）は再送しても同じ結果になるうえ、
 * 投稿系で闇雲に再送すると二重投稿の原因になるためリトライしない。
 */
/**
 * 投稿APIへ送るJSONを組み立てる。
 *
 * 引用リポストは quote_tweet_id を足すだけ。本文の作り方は通常投稿と同じで、
 * 重複判定・類似判定・月次上限もそのまま効く（引用だから緩める理由が無い）。
 */
/**
 * URLはt.coで短縮され、本文の文字数としては一律23文字として数えられる。
 */
const TWEET_URL_WEIGHT = 23;

function buildTweetPayload_(text, options) {
  const payload = { text: text };
  const q = options && options.quoteTweetId;

  if (q) {
    // 数字以外が混ざったIDを送ると400になる。事故を早い段階で止める。
    if (!/^\d+$/.test(String(q))) {
      throw new Error('quote_tweet_id が不正です: ' + q);
    }
    payload.quote_tweet_id = String(q);
  }

  /*
   * ★画像の添付（25_Media.gs）。
   * media_id は投稿前に取得済みのものだけを受け取る。
   * ここでアップロードはしない（失敗が投稿の失敗になってしまうため）。
   */
  const ids = (options && options.mediaIds) || [];
  if (ids.length) payload.media = { media_ids: ids.map(String) };

  return payload;
}

function fetchWithRetry_(url, params, maxAttempts) {
  const attempts = maxAttempts || 3;
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = UrlFetchApp.fetch(url, params);
      const code = res.getResponseCode();
      if (code < 500 || i === attempts) return res;
      console.warn('HTTP ' + code + ' のため再試行 (' + i + '/' + attempts + ')');
    } catch (err) {
      lastErr = err;
      console.warn('通信エラーのため再試行 (' + i + '/' + attempts + '): ' + err);
      if (i === attempts) throw err;
    }
    Utilities.sleep(1000 * Math.pow(2, i - 1));   // 1s, 2s
  }
  throw lastErr || new Error('リクエストに失敗しました。');
}
