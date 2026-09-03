/**
 * ===========================================================================
 * 23_Redirect.gs  —  クリック計測用リダイレクタ（自前の /api/go 相当）
 * ===========================================================================
 *
 * ★なぜこれが最優先だったか
 *
 * 15_Metrics.gs の importLinkClicks() は、
 *   {"clicks": {"<X Post ID>": 12, ...}}
 * を返すエンドポイントを CLICK_STATS_URL から読む設計で既に完成していた。
 * ところが **その入口（リダイレクタ）自体がどこにも実装されていなかった。**
 *
 * 結果として Log の Link Clicks / Conversions / Revenue / EPC / CTR は
 * 永久に空のまま。役割別集計の clicks も常に0。
 * 「100投稿あたりのクリック・CVで判断する」という方針(§18-⑥)も、
 * 測る手段が無いので実行できない状態だった。
 *
 * アフィリエイトで最初に作るべきものは、記事でも投稿でもなく
 * 「どのリンクが何回踏まれたか」を自分の手元に残す仕組みで、
 * ここが無い限り、以降の最適化は全て勘になる。
 *
 * ★仕組み
 *
 *   投稿に載せるURL:  <WebApp>/exec?go=<token>
 *   踏まれたとき:      Clicks シートへ1行追記 → 本来の行き先へ転送
 *   集計:              <WebApp>/exec?clickstats=1&token=<ADMIN_TOKEN>
 *                      → {"clicks": {"<X Post ID>": n}}
 *
 * token と X Post ID の対応は、Logの既存列だけで解決している。
 * Log の Link URL 列(20)には投稿に載せたURL（= go=token を含む）が
 * 入っており、同じ行に X Post ID 列(8)がある。両者を突き合わせれば、
 * **Logのスキーマを一切変更せずに** token → Post ID を復元できる。
 *
 * ★オープンリダイレクタにしないこと
 *
 * ?go= に任意のURLを渡せる作りにすると、第三者がフィッシングの踏み台に
 * 使える（自分のドメインで他所へ飛ばせてしまう）。
 * ここでは ClickMap に登録済みのtokenしか受け付けず、
 * 行き先をURLパラメータから受け取らない。
 */

const CLICKMAP_SHEET_NAME = 'ClickMap';
const CLICKS_SHEET_NAME = 'Clicks';

const CLICKMAP_HEADERS = ['Token', 'Destination', 'Account', 'Created At'];
const CLICKS_HEADERS = ['Token', 'Clicked At', 'Referrer'];

/** ClickMap（token → 行き先）シートを用意する。 */
function getOrCreateClickMapSheet_(ss) {
  const book = ss || openLogSpreadsheet_();
  let sheet = book.getSheetByName(CLICKMAP_SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(CLICKMAP_SHEET_NAME);
    sheet.getRange(1, 1, 1, CLICKMAP_HEADERS.length).setValues([CLICKMAP_HEADERS]);
    sheet.getRange(1, 1, 1, CLICKMAP_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Clicks（生のクリックログ）シートを用意する。 */
function getOrCreateClicksSheet_(ss) {
  const book = ss || openLogSpreadsheet_();
  let sheet = book.getSheetByName(CLICKS_SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(CLICKS_SHEET_NAME);
    sheet.getRange(1, 1, 1, CLICKS_HEADERS.length).setValues([CLICKS_HEADERS]);
    sheet.getRange(1, 1, 1, CLICKS_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** WebアプリのURL。未取得なら空文字（＝計測を諦めて素のURLを使う）。 */
function webAppExecUrl_() {
  const fixed = String(getProp_('WEB_APP_URL', '') || '').trim();
  if (fixed) return fixed;
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/** 短くURLに載せやすいトークンを作る。 */
function newClickToken_() {
  return 'c' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

/**
 * 行き先URLを登録し、計測用URLを返す。
 *
 * ★計測できない事情がある場合は、必ず元のURLをそのまま返す。
 * 計測はあくまで付加価値であり、これが理由で投稿からリンクが
 * 消えたり投稿自体が失敗したりしてはいけない。
 *
 * @param {string} accountKey
 * @param {string} destUrl 本来の行き先（アフィリエイトURL）
 * @return {string} 計測用URL。無理なら destUrl をそのまま
 */
function buildTrackedUrl_(accountKey, destUrl) {
  const dest = String(destUrl || '').trim();
  if (!dest) return '';
  if (!/^https?:\/\//i.test(dest)) return dest;

  // 明示的に無効化されていれば素通し
  if (String(getProp_('CLICK_TRACKING', '1')) === '0') return dest;

  const base = webAppExecUrl_();
  if (!base) {
    console.warn('WebアプリURLを取得できないため、クリック計測なしで投稿します。');
    return dest;
  }

  try {
    const token = newClickToken_();
    const sheet = getOrCreateClickMapSheet_();
    sheet.appendRow([token, dest, String(accountKey || '').toUpperCase(), new Date()]);
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'go=' + encodeURIComponent(token);
  } catch (e) {
    // シートが開けない等。計測を諦めて本来のURLで投稿する。
    console.warn('クリック計測URLの発行に失敗、素のURLで続行: ' + e);
    return dest;
  }
}

/** token から行き先を引く。見つからなければ空文字。 */
function lookupClickDestination_(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  try {
    const sheet = getOrCreateClickMapSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return '';
    const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = values.length - 1; i >= 0; i--) {   // 新しいものから探す
      if (String(values[i][0]).trim() === t) return String(values[i][1] || '').trim();
    }
  } catch (e) {
    console.error('ClickMapを読めませんでした: ' + e);
  }
  return '';
}

/**
 * ?go=<token> の処理。クリックを記録して本来の行き先へ転送する。
 *
 * ★記録に失敗しても転送は必ず行う。
 * 計測のために読者を取りこぼすのは本末転倒で、
 * 「リンクを踏んだのにエラー画面」は収益を直接失う。
 */
function handleGoRequest_(params) {
  const token = String((params && params.go) || '').trim();
  const dest = lookupClickDestination_(token);

  if (!dest) {
    console.warn('未知のクリックトークン: ' + truncate_(token, 40));
    return renderPage_('リンクが見つかりません',
      'このリンクは無効か、期限が切れています。', false);
  }

  try {
    getOrCreateClicksSheet_().appendRow([
      token, new Date(), truncate_(String((params && params.ref) || ''), 200)
    ]);
  } catch (e) {
    console.error('クリック記録に失敗（転送は続行）: ' + e);
  }

  // GASはLocationヘッダを返せないため、既に本コードで実績のある
  // window.top.location による転送を使う（OAuth開始時と同じ方式）。
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><meta charset="utf-8">' +
    '<meta name="referrer" content="no-referrer">' +
    '<script>window.top.location.href=' + JSON.stringify(dest) + ';</script>' +
    '<p>移動しない場合は <a target="_top" rel="nofollow noopener" href="' +
    escapeHtml_(dest) + '">こちら</a></p>'
  );
}

/**
 * token 単位のクリック数を数える。
 * @return {!Object<string, number>}
 */
function countClicksByToken_() {
  const out = {};
  const sheet = getOrCreateClicksSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  values.forEach(function (r) {
    const t = String(r[0] || '').trim();
    if (!t) return;
    out[t] = (out[t] || 0) + 1;
  });
  return out;
}

/**
 * X Post ID ごとのクリック数を組み立てる。
 *
 * Logの Link URL 列に埋まっている go=<token> を取り出し、
 * 同じ行の X Post ID に紐付ける。Logのスキーマは変更しない。
 *
 * @return {!Object<string, number>}
 */
function buildClickStats_() {
  const byToken = countClicksByToken_();
  const out = {};
  if (!Object.keys(byToken).length) return out;

  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateLogSheet_(ss);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;

  const values = sheet.getRange(2, 1, lastRow - 1, LOG_TOTAL_COLUMNS).getValues();
  values.forEach(function (row) {
    const postId = String(row[LOG_COL_X_POST_ID - 1] || '').trim();
    if (!postId) return;
    const linkUrl = String(row[LOG_COL_LINK_URL - 1] || '');
    const m = linkUrl.match(/[?&]go=([^&\s]+)/);
    if (!m) return;
    const token = decodeURIComponent(m[1]);
    if (byToken[token]) out[postId] = (out[postId] || 0) + byToken[token];
  });
  return out;
}

/**
 * ?clickstats=1 の処理。importLinkClicks() が読む形で返す。
 *
 * ADMIN_TOKEN が設定されている場合は一致を要求する。
 * クリック数は営業上の情報なので、誰でも読める状態にはしない。
 */
function handleClickStatsRequest_(params) {
  // ★★2026-09-03、こちらも「未設定なら素通し」だった。
  //   クリック数は営業上の情報なので、未設定なら開けない側へ倒す。
  //   比較も timingSafeEquals_ を使う（1文字ずつの早期リターンで
  //   「何文字目まで合っていたか」を応答時間として渡さない）。
  const adminToken = getProp_('ADMIN_TOKEN', '');
  if (!adminToken || !timingSafeEquals_(String((params && params.token) || ''), adminToken)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'forbidden' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let clicks = {};
  try {
    clicks = buildClickStats_();
  } catch (e) {
    console.error('クリック集計に失敗: ' + e);
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(e), clicks: {} }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ clicks: clicks }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * CLICK_STATS_URL に入れるべきURLを組み立てて返す（設定支援用）。
 */
function buildClickStatsUrl_() {
  const base = webAppExecUrl_();
  if (!base) return '';
  const adminToken = getProp_('ADMIN_TOKEN', '');
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'clickstats=1' +
         (adminToken ? '&token=' + encodeURIComponent(adminToken) : '');
}

/**
 * CLICK_STATS_URL に入れる値をログへ出す（エディタから手動実行する用）。
 *
 * ★末尾に _ が付いた関数はGASエディタの実行メニューに出ない。
 * buildClickStatsUrl_ を「エディタで実行してください」と案内していたが、
 * 実際には選べなかった。公開名のラッパーを用意する。
 *
 * なお通常は設定不要（importLinkClicks が未設定時は内部で直接集計する）。
 * 外部のリダイレクタへ移す場合にだけ使う。
 */
function showClickStatsUrl() {
  const url = buildClickStatsUrl_();
  console.log(url || 'WebアプリのURLを取得できませんでした。');
  return url;
}
