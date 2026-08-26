/**
 * ===========================================================================
 * 05_Admin.gs  —  セットアップ・動作確認用（GASエディタから手動実行する）
 * ===========================================================================
 */

/** ★最初にこれを実行する。X Developer Portal に登録すべきURLが出る。 */
function showSetupInfo() {
  // Google の /usercallback は複数アカウント環境で既知の不具合があるため使わず、
  // 自前の /exec（WEBAPP_EXEC_URL）に直接コールバックさせている（01_OAuth.gs 参照）。
  // Callback URI と LINE Webhook URL は同じ /exec になる。
  const required = [
    'APP_A_CLIENT_ID', 'APP_A_CLIENT_SECRET',
    'APP_B_CLIENT_ID', 'APP_B_CLIENT_SECRET',
    'LINE_CHANNEL_ACCESS_TOKEN'
  ];
  const optional = ['WEBHOOK_SECRET', 'ALLOWED_LINE_USER_IDS', 'ADMIN_LINE_USER_ID',
                    'ADMIN_TOKEN', 'MONTHLY_SOFT_CAP', 'AUTH_MODE', 'LOG_SPREADSHEET_ID',
                    'GEMINI_API_KEY', 'LLM_API_KEY', 'LLM_MODEL',
                    'LLM_PROMPT_A', 'LLM_PROMPT_B',
                    'LLM_ANGLES_A', 'LLM_ANGLES_B', 'LLM_REGIONS',
                    'AUTO_REFILL_A', 'AUTO_REFILL_B', 'MENTION_CHECK_HOURS',
                    'LLM_FORMATS_A', 'LLM_FORMATS_B',
                    'LINK_EVERY_A', 'LINK_EVERY_B',
                    'FIXED_CTA_URL_A', 'FIXED_CTA_URL_B',
                    'FIXED_CTA_TEXT_A', 'FIXED_CTA_TEXT_B',
                    'FIXED_CTA_EVERY_A', 'FIXED_CTA_EVERY_B',
                    'TWEET_MAX_LEN_A', 'TWEET_MAX_LEN_B', 'LLM_LANG_A', 'LLM_LANG_B', 'GITHUB_QUERY', 'LLM_OFFER_ANGLES_A', 'LLM_OFFER_ANGLES_B'];

  const check = function (name) {
    const v = getProp_(name);
    return '  ' + (v ? '✅' : '❌') + ' ' + name + (v ? ' (' + v.length + '文字)' : '');
  };

  console.log([
    '===== X Developer Portal に登録する Callback URI（使用中の全アプリに同じものを登録）=====',
    getOAuthRedirectUri_() + '   [AUTH_MODE=' + getAuthMode_() + ']',
    '',
    '===== LINE Webhook URL（bot_tokenパラメータを付けること）=====',
    WEBAPP_EXEC_URL + '?bot_token=<WEBHOOK_SECRETの値>',
    '',
    '===== 必須プロパティ =====',
    required.map(check).join('\n'),
    '',
    '===== 任意プロパティ =====',
    optional.map(check).join('\n')
  ].join('\n'));
}

/** Xへ実際に送っている認可パラメータを表示する。Portalの登録値との突き合わせ用。 */
function showAuthDiagnostics() {
  console.log(buildAuthDiagnosticsText_());
}

/** 認証方式を切り替える。切り替えたらPortalのCallback URIも必ず合わせること。 */
function useExecCallback() {
  props_().setProperty('AUTH_MODE', 'exec');
  console.log('AUTH_MODE=exec に設定しました。\nPortalのCallback URIをこれにしてください:\n' + WEBAPP_EXEC_URL);
}
function useUserCallback() {
  props_().setProperty('AUTH_MODE', 'usercallback');
  console.log('AUTH_MODE=usercallback に設定しました。\nPortalのCallback URIをこれにしてください:\n' + OAuth2.getRedirectUri());
}

/** ブラウザで手動連携したいとき用。出力されたURLを開く。 */
function authorizeA() { console.log(getAuthorizationUrl_('A')); }
function authorizeB() { console.log(getAuthorizationUrl_('B')); }

function resetA() { resetService_('A'); console.log('A の連携を解除しました。'); }
function resetB() { resetService_('B'); console.log('B の連携を解除しました。'); }

function showStatus() { console.log(buildStatusText_()); }

/** 実際に1件投稿するテスト。X の投稿枠を1件消費する点に注意。 */
function testPostA() { console.log(JSON.stringify(postTweet_('A', 'テスト投稿 ' + new Date().toISOString()))); }
function testPostB() { console.log(JSON.stringify(postTweet_('B', 'テスト投稿 ' + new Date().toISOString()))); }

/** 月間カウンタを手動リセット（Portal 側の実数とずれた場合に使う） */
function resetMonthlyCounters() {
  ['A', 'B'].forEach(function (k) { props_().deleteProperty(monthlyCountKey_(k)); });
  console.log('今月のカウンタをリセットしました。');
}

/**
 * スクリプトプロパティを一括登録するヘルパー。
 * 値を直接書いて実行し、実行後は必ず値を消してから保存し直すこと
 * （コードに秘密情報が残るとリポジトリに混入する）。
 */
function bulkSetProperties() {
  const values = {
    // APP_A_CLIENT_ID: '',
    // APP_A_CLIENT_SECRET: '',
    // APP_B_CLIENT_ID: '',
    // APP_B_CLIENT_SECRET: '',
    // LINE_CHANNEL_ACCESS_TOKEN: '',
    // ALLOWED_LINE_USER_IDS: '',
    // ADMIN_LINE_USER_ID: '',
    // ADMIN_TOKEN: '',
    // MONTHLY_SOFT_CAP: ''
  };
  const filtered = {};
  Object.keys(values).forEach(function (k) { if (values[k]) filtered[k] = values[k]; });
  if (!Object.keys(filtered).length) {
    console.log('登録する値がありません。bulkSetProperties() 内のコメントを外して値を入れてください。');
    return;
  }
  props_().setProperties(filtered, false);
  console.log('登録しました: ' + Object.keys(filtered).join(', '));
}
