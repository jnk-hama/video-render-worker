/**
 * ===========================================================================
 * 21_RetweetTest.gs  —  素のリツイート（Native Retweet）の実地検証
 * ===========================================================================
 * 【なぜこのファイルが要るか】
 * 引用RTは実機で403が確認済み（"You can only reply to or quote posts where
 * you are mentioned or are the author"）。同じ制限が素のリツイート
 * （POST /2/users/:id/retweets）にも掛かるのかは、一次情報に到達できず
 * 確認できていない。検索で拾える範囲は情報源同士で主張が割れている。
 *
 * この種のAPIにはサンドボックス（試し打ち）が無い。確かめる唯一の方法は
 * 実際に1回リツイートすることで、それはフォロワーに見える外部可視の
 * アクションになる。だから2段階に分ける。
 *
 *   1. RT候補A / RT候補B … 検索するだけ。何も投稿しない
 *   2. RT実行A <id>       … 1で見せたIDを人間が確認して入力した時だけ、
 *                            実際に1回リツイートを試みて結果をそのまま返す
 *
 * 自動投稿サイクルには組み込まない。あくまで手動の一回限りの検証用。
 */

/**
 * 対象候補を検索するだけ。投稿は一切しない。
 *
 * 検索条件は引用エンジンと同じ QUOTE_PATTERNS を流用する。
 * 「Aはガジェット系・これから売りたいもの」「Bは自分のコンテンツに似た
 * ツイート」という指定は、既にこのパターンがそのまま体現している。
 *
 * @return {string} LINEへそのまま返す文面
 */
function previewRetweetTarget_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  if (!ACCOUNTS[key]) return '不明なアカウントです: ' + key;

  let candidates;
  try {
    candidates = searchQuoteTargets_(key);
  } catch (e) {
    return '【' + key + ' RT候補】検索に失敗\n' +
           truncate_(String(e && e.message ? e.message : e), 300);
  }

  if (!candidates.length) {
    return '【' + key + ' RT候補】条件に合う投稿が見つかりませんでした\n' +
           '（いいね数のしきい値に届かない、または検索自体が0件）';
  }

  const ss = openLogSpreadsheet_();
  const history = readQuotedHistory_(getOrCreateQuotedSheet_(ss));

  /*
   * ★Bはセンシティブ扱いの投稿を候補から外す。
   * 自分で書く文章には个人名や性描写を禁止できるが、他人の投稿を
   * まるごとリツイートする場合は文章の検査が効かない。X自身が
   * possibly_sensitive を立てている投稿は、判断材料が無いまま
   * 自分のアカウントに結び付けないほうが安全。
   */
  const safe = candidates.filter(function (t) { return !t.sensitive; });
  const pick = pickQuoteTarget_(safe.length ? safe : candidates, history, key);

  if (!pick) {
    return '【' + key + ' RT候補】候補はありましたが、既に引用済み/直近の著者/' +
           '自分自身のいずれかで除外されました。';
  }

  const url = pick.author
    ? 'https://x.com/' + pick.author + '/status/' + pick.id
    : 'https://x.com/i/web/status/' + pick.id;

  return [
    '【' + key + ' RT候補】まだ何も投稿していません',
    '',
    'ID: ' + pick.id,
    '著者: @' + (pick.author || '(不明)'),
    'いいね: ' + pick.likes,
    (pick.sensitive ? '⚠️ Xがセンシティブと判定した投稿です' : ''),
    '',
    truncate_(pick.text, 200),
    '',
    url,
    '',
    '実際にリツイートを試すには次を送信:',
    'RT実行' + key + ' ' + pick.id
  ].filter(function (s) { return s !== ''; }).join('\n');
}

/**
 * 指定した1件だけ、実際にリツイートを試みる。
 *
 * ★これが実地検証の本体。成功・失敗を問わず、Xが返した生のHTTPコードと
 * 本文をそのまま返す。ここで初めて「素のリツイートも同じ制限に
 * 掛かるのか」が実測で分かる。
 *
 * @return {string} LINEへそのまま返す文面
 */
function attemptRetweet_(accountKey, tweetId) {
  const key = String(accountKey || '').toUpperCase();
  const id = String(tweetId || '').trim();

  if (!ACCOUNTS[key]) return '不明なアカウントです: ' + key;
  if (!/^\d{5,25}$/.test(id)) {
    return '不正なツイートIDです: "' + id + '"\n' +
           '「RT候補' + key + '」で表示されたIDをそのまま貼ってください。';
  }

  const service = getXService_(key);
  if (!service.hasAccess()) {
    return ACCOUNTS[key].label + ' は未連携です。先に連携を済ませてください。';
  }

  // ★実際のAPI呼び出しは postRetweet_（02_XApi.gs）に共通化してある。
  // 自動フォールバック側（runQuoteEngine）と同じ経路を通すことで、
  // 「手動で試した時だけ成功する」というズレが起きないようにする。
  let result;
  try {
    result = postRetweet_(key, id);
  } catch (e) {
    return '【' + key + ' RT実行】失敗\n' + truncate_(String(e && e.message ? e.message : e), 300);
  }

  console.log('RTテスト結果 (' + key + ' / ' + id + '): HTTP ' + result.code + ' ' + result.body);

  return [
    '【' + key + ' RT実行】結果',
    '',
    'HTTP ' + result.code,
    result.body,
    '',
    result.ok
      ? '✅ 成功しました。素のリツイートはこの制限に掛からないようです。'
      : (result.code === 403
          ? '❌ 403。引用RTと同じ制限か、認証設定の問題かは本文を確認してください。'
          : '❌ 失敗（HTTP ' + result.code + '）。')
  ].join('\n');
}
