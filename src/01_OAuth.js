/**
 * ===========================================================================
 * 01_OAuth.gs  —  A/B 完全分離の OAuth2 サービス
 * ===========================================================================
 * ライブラリ: OAuth2 (googleworkspace/apps-script-oauth2)
 *   スクリプトID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 *   識別子(ID)  : OAuth2
 *
 * 【コールバックの経路（自前ルーティングに変更済み）】
 * ライブラリ既定の /usercallback（Googleが state を復号して
 * authCallbackA/B へ自動ディスパッチする方式）は使用していない。
 *
 * 理由：/usercallback は「複数Googleアカウントがログインした端末」や
 * 「アプリ内蔵ブラウザ(Gmail/Yahoo!等のCustom Tabs)」で
 * "現在、ファイルを開くことができません" のエラーになる、ライブラリ側の
 * 未解決の既知不具合を持つ（apps-script-oauth2 issue #137, #205, #92 等）。
 * Googleのアカウント選択処理そのものが壊れるため、ブラウザを変えても
 * 端末のGoogleアカウント状態次第で再現し続ける。
 *
 * 対策として、Callback URI を Google の /usercallback ではなく
 * 自前の Webアプリ /exec（WEBAPP_EXEC_URL）に直接向けている。
 * /exec は ANYONE_ANONYMOUS 公開のため、Googleアカウントのログイン状態に
 * 一切依存しない。PKCE の code_verifier は ScriptApp の state トークンに
 * 頼らず、nonce をキーに CacheService へ自前で保存している
 * （state トークンは /usercallback 経由でしかGoogleが復号してくれないため）。
 *
 * ★このため X Developer Portal の Callback URI は
 *   WEBAPP_EXEC_URL（00_Config.gs で定義、/exec そのもの）
 * を登録する。旧来の /usercallback は登録しない。
 */

/** 認証が必要なことを示す専用エラー。呼び出し側でLINE返信を出し分けるために使う。 */
class NeedsAuthError extends Error {
  constructor(accountKey) {
    super('アカウント ' + accountKey + ' が未連携です。');
    this.name = 'NeedsAuthError';
    this.accountKey = accountKey;
  }
}

/**
 * アカウント別の OAuth2 サービスを生成する。
 *
 * A と B で serviceName が異なるため、トークンは
 *   oauth2.x_acct_a / oauth2.x_acct_b
 * という別々のキーで保存され、互いに干渉しない（要件2：トークンの完全分離）。
 */
function getXService_(accountKey) {
  const acc = getAccount_(accountKey);
  const clientId = getRequiredProp_(acc.clientIdProp);
  const clientSecret = getRequiredProp_(acc.clientSecretProp);

  return OAuth2.createService(acc.serviceName)
    .setAuthorizationBaseUrl(X_AUTHORIZE_URL)
    .setTokenUrl(X_TOKEN_URL)
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .setCallbackFunction(acc.callbackFunctionName)   // 現在は未使用の予備経路（下記コメント参照）
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache())
    .setLock(LockService.getScriptLock())   // リフレッシュの同時実行によるトークン破損を防ぐ
    .setScope(X_SCOPES)

    // X は「認可リクエスト時と同じ redirect_uri」をトークン交換時にも要求する。
    // 認可URL生成側（buildAuthorizationUrl_）と必ず同じ値を使うため、
    // 両者とも getOAuthRedirectUri_() を参照する。
    // usercallbackモードのときはライブラリ既定に任せる（上書きしない）。
    .setRedirectUri(getAuthMode_() === 'usercallback' ? OAuth2.getRedirectUri() : WEBAPP_EXEC_URL)

    // X の confidential client はトークンエンドポイントで Basic 認証を要求する。
    .setTokenHeaders({
      'Authorization': 'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded'
    })

    // ライブラリ既定では client_secret が body にも入る。X はヘッダ側の認証を見るため、
    // body から取り除いて invalid_request 系で弾かれるのを回避する。
    // このハンドラは初回交換・リフレッシュの両方で適用される。
    .setTokenPayloadHandler(function (payload) {
      delete payload.client_secret;
      return payload;
    });
}

/* ------------------------------------------------------------------ */
/* 認可URLの生成（自前PKCE。ScriptAppのstateトークンは使わない）         */
/* ------------------------------------------------------------------ */

/**
 * PKCE用の code_verifier を生成する（base64url・パディング無し・43文字）。
 *
 * ★Math.random() は使わない。
 * Math.random() は暗号学的に安全な乱数ではなく、実装によっては内部状態から
 * 後続の出力を推測できる。code_verifier を推測されるとPKCEの意味が無くなる。
 *
 * GASで安全に取れる乱数源は Utilities.getUuid()（RFC4122 v4）。
 * これを複数連結し、SHA-256で潰してから使う。
 * UUIDは1本あたり122ビットの乱数なので、3本で十分な強度がある。
 */
function generateCodeVerifier_() {
  const seed = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed,
                                         Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

/** PKCE の code_challenge（S256）を計算する。 */
function computeCodeChallenge_(codeVerifier) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, codeVerifier);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

/**
 * X の認可URLを自前で組み立てる。
 * code_verifier は state に載せず、nonce をキーに CacheService へ保存する
 * （state トークンは /usercallback 経由でしかGoogleが復号できないため）。
 */
function buildAuthorizationUrl_(accountKey) {
  const acc = getAccount_(accountKey);
  const clientId = getRequiredProp_(acc.clientIdProp);
  const codeVerifier = generateCodeVerifier_();
  const nonce = Utilities.getUuid();

  // ★nonceに対してアカウントも一緒に保存する。
  // これが無いと、Aで発行したnonceを state="B:<nonce>" として送り込まれた場合に
  // A用のverifierがB用サービスへ渡ってしまう。
  // （client_idが違うので実際には交換に失敗するが、そもそも突き合わせて弾く）
  CacheService.getScriptCache().put(
    'pkce_' + nonce,
    JSON.stringify({ v: codeVerifier, a: String(accountKey).toUpperCase() }),
    600);   // 10分で失効

  const params = buildAuthorizationParams_(accountKey, clientId, codeVerifier, nonce);
  const qs = Object.keys(params)
    .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
    .join('&');
  return X_AUTHORIZE_URL + '?' + qs;
}

/**
 * 認可URLのクエリパラメータを組み立てる。
 * 診断表示(showAuthDiagnostics)からも同じ関数を使い、
 * 「表示した内容」と「実際に送る内容」が絶対にずれないようにしている。
 */
function buildAuthorizationParams_(accountKey, clientId, codeVerifier, nonce) {
  return {
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getOAuthRedirectUri_(),
    state: accountKey + ':' + nonce,
    scope: X_SCOPES,
    code_challenge: computeCodeChallenge_(codeVerifier),
    code_challenge_method: 'S256'
  };
}

/* ------------------------------------------------------------------ */
/* コールバック（自前の /exec で受ける。doGet から呼ばれる）            */
/* ------------------------------------------------------------------ */

/**
 * doGet(e) から呼ばれる。e.parameter.state は "A:nonce" 形式の自前state。
 * nonce をキーに CacheService から code_verifier を取り出し、
 * ライブラリの handleCallback() へ「Googleが復号した体で」渡す。
 */
function handleOAuthCallbackViaExec_(e) {
  const state = String((e && e.parameter && e.parameter.state) || '');
  const code = e && e.parameter && e.parameter.code;
  const error = e && e.parameter && e.parameter.error;

  const sep = state.indexOf(':');
  const accountKey = sep === -1 ? '' : state.slice(0, sep).toUpperCase();
  const nonce = sep === -1 ? '' : state.slice(sep + 1);

  if (!ACCOUNTS[accountKey]) {
    return renderPage_('連携に失敗しました', '不正な state です。もう一度「Xリンク A」からやり直してください。', false);
  }
  const acc = ACCOUNTS[accountKey];

  if (error) {
    return renderPage_('連携をキャンセルしました', acc.label + ' の連携は行われませんでした。', false);
  }

  if (!code) {
    return renderPage_('連携に失敗しました',
      '認可コードが返ってきませんでした。もう一度「Xリンク ' + accountKey + '」からやり直してください。', false);
  }

  const cache = CacheService.getScriptCache();
  const stored = cache.get('pkce_' + nonce);
  if (!stored) {
    // キャッシュに無い＝期限切れ、または既に使用済み。
    // ★ここで推測値や別のverifierで代用してはいけない。必ずやり直させる。
    return renderPage_(
      '連携に失敗しました',
      '認証セッションの有効期限が切れました（10分）。もう一度「Xリンク ' + accountKey + '」からやり直してください。',
      false
    );
  }
  cache.remove('pkce_' + nonce); // 使い捨て（リプレイ防止）

  let codeVerifier = '';
  let issuedFor = '';
  try {
    const parsed = JSON.parse(stored);
    codeVerifier = parsed.v || '';
    issuedFor = String(parsed.a || '').toUpperCase();
  } catch (e) {
    // 旧形式（verifierをそのまま入れていた頃）のキャッシュが残っている場合の互換
    codeVerifier = stored;
    issuedFor = accountKey;
  }

  // 発行時のアカウントと、返ってきたstateのアカウントが違えば拒否する。
  if (!codeVerifier || issuedFor !== accountKey) {
    console.error('stateのアカウント不一致: 発行=' + issuedFor + ' / 受信=' + accountKey);
    return renderPage_('連携に失敗しました',
      'アカウントの指定が一致しません。もう一度「Xリンク ' + accountKey + '」からやり直してください。', false);
  }

  try {
    const service = getXService_(accountKey);
    const authorized = service.handleCallback({ parameter: { code: code, codeVerifier_: codeVerifier } });

    if (!authorized) {
      return renderPage_('連携をキャンセルしました', acc.label + ' の連携は行われませんでした。', false);
    }

    // 誰のアカウントに紐づいたかを記録し、以降その相手にしか投稿しないよう固定する。
    // ここで固定しておかないと、Xに別アカウントでログインしたまま連携した場合に
    // A用の投稿がBのタイムラインへ流れ続ける（P1-8）。
    let username = '';
    let pinResult = { ok: true, message: '' };
    try {
      const info = fetchXUserInfo_(accountKey);
      if (info) {
        username = info.username || '';
        service.getStorage().setValue('username', username);
        pinResult = pinExpectedXUser_(accountKey, info.id, username);
      }
    } catch (e2) {
      console.warn('users/me の取得に失敗（連携自体は成功）: ' + e2);
    }

    if (!pinResult.ok) {
      // 取り違えを検知した。連携自体は成立しているが、そのまま使わせない。
      return renderPage_('連携先が重複しています', pinResult.message, false);
    }

    notifyAdmin_(
      '✅ ' + acc.label + ' の X 連携が完了しました。' +
      (username ? '\n連携先: @' + username : '')
    );

    return renderPage_(
      '連携完了',
      acc.label + ' の X アカウント連携が完了しました。' +
      (username ? '（@' + username + '）' : '') +
      '\nこのタブは閉じてかまいません。',
      true
    );

  } catch (err) {
    console.error('OAuthコールバック(' + accountKey + ') 失敗: ' + (err && err.stack ? err.stack : err));
    return renderPage_('連携に失敗しました', String(err), false);
  }
}

/* ------------------------------------------------------------------ */
/* 旧経路（/usercallback）— 現在は到達しない予備コード                  */
/* ------------------------------------------------------------------ */
/* X Developer Portal の Callback URI を WEBAPP_EXEC_URL に変更したため、
 * この関数がGoogleから自動ディスパッチされることは無い。削除はせず、
 * 何らかの理由で /usercallback 側に古い登録が残っていた場合の保険として残す。 */

function authCallbackA(request) { return handleAuthCallback_('A', request); }
function authCallbackB(request) { return handleAuthCallback_('B', request); }

function handleAuthCallback_(accountKey, request) {
  const acc = getAccount_(accountKey);
  try {
    const service = getXService_(accountKey);
    const authorized = service.handleCallback(request);

    if (!authorized) {
      return renderPage_('連携をキャンセルしました', acc.label + ' の連携は行われませんでした。', false);
    }

    let username = '';
    try {
      username = fetchXUsername_(accountKey) || '';
      service.getStorage().setValue('username', username);
    } catch (e) {
      console.warn('users/me の取得に失敗（連携自体は成功）: ' + e);
    }

    notifyAdmin_(
      '✅ ' + acc.label + ' の X 連携が完了しました。' +
      (username ? '\n連携先: @' + username : '')
    );

    return renderPage_(
      '連携完了',
      acc.label + ' の X アカウント連携が完了しました。' +
      (username ? '（@' + username + '）' : '') +
      '\nこのタブは閉じてかまいません。',
      true
    );

  } catch (err) {
    console.error('authCallback(' + accountKey + ') 失敗: ' + (err && err.stack ? err.stack : err));
    return renderPage_('連携に失敗しました', String(err), false);
  }
}

/* ------------------------------------------------------------------ */
/* 診断                                                                */
/* ------------------------------------------------------------------ */

/**
 * Xへ実際に送っている認可パラメータを、そのまま可視化する。
 * 「Portalの登録値」と「送信値」の不一致を、推測ではなく突き合わせで特定するための機能。
 * client_id / client_secret は先頭数文字と長さのみ表示し、全体は出さない。
 */
function buildAuthDiagnosticsText_() {
  const mask = function (v) {
    if (!v) return '(未設定)';
    return v.slice(0, 6) + '…' + v.slice(-4) + ' (' + v.length + '文字)';
  };

  const lines = [
    '🔍 認証設定の診断',
    '',
    '【方式】AUTH_MODE = ' + getAuthMode_() +
      (getProp_('AUTH_MODE') ? '' : '（既定値。プロパティ未設定）'),
    '',
    '【★X Developer Portal に登録すべき Callback URI】',
    getOAuthRedirectUri_(),
    '',
    '↑ この文字列と、Portalの Callback URI が',
    '  1文字でも違うと「アプリにアクセスを許可できません」になります。',
    ''
  ];

  Object.keys(ACCOUNTS).forEach(function (key) {
    const acc = ACCOUNTS[key];
    const id = getProp_(acc.clientIdProp);
    const secret = getProp_(acc.clientSecretProp);
    lines.push('【' + key + '】' + acc.label);
    lines.push('  client_id     : ' + mask(id));
    lines.push('  client_secret : ' + mask(secret));

    if (id) {
      try {
        const p = buildAuthorizationParams_(key, id, 'dummy_verifier_for_display', 'dummy');
        lines.push('  redirect_uri  : ' + p.redirect_uri);
        lines.push('  scope         : ' + p.scope);
      } catch (e) {
        lines.push('  (パラメータ生成に失敗: ' + e + ')');
      }
    }
    lines.push('');
  });

  // A と B が同じアプリを指しているかどうかは、統合済みかの判断に必要
  const idA = getProp_(ACCOUNTS.A.clientIdProp);
  const idB = getProp_(ACCOUNTS.B.clientIdProp);
  if (idA && idB) {
    lines.push(idA === idB
      ? '【アプリ】A と B は同一のXアプリを使用（統合済み）。Portalの更新は1アプリだけでよい。'
      : '【アプリ】A と B は別々のXアプリ。Portalの Callback URI は両方のアプリで更新が必要。');
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 認証状態                                                            */
/* ------------------------------------------------------------------ */

function isAuthorized_(accountKey) {
  try {
    return getXService_(accountKey).hasAccess();
  } catch (e) {
    // クライアントIDが未設定など、設定不備で落ちるケース
    console.warn('isAuthorized_(' + accountKey + '): ' + e);
    return false;
  }
}

/**
 * 認可URLを返す。AUTH_MODE により生成方式が変わる。
 *   'exec'         … 自前生成（state="A:nonce"、code_verifierはCacheService）
 *   'usercallback' … ライブラリ生成（stateはGoogleのStateToken）
 * 方式を変えたら X Portal の Callback URI も必ず合わせること。
 */
function getAuthorizationUrl_(accountKey) {
  if (getAuthMode_() === 'usercallback') {
    return getXService_(accountKey).generateCodeVerifier().getAuthorizationUrl();
  }
  return buildAuthorizationUrl_(accountKey);
}

function getStoredUsername_(accountKey) {
  try {
    return getXService_(accountKey).getStorage().getValue('username') || '';
  } catch (e) {
    return '';
  }
}

/**
 * いま持っているトークンに実際に付与されたスコープ。
 *
 * ★OAuth2ライブラリはトークン応答をそのまま保存しており、
 * 応答には scope が入っている。X_SCOPES（こちらの要求）と、
 * 実際に付与されたスコープは別物であることに注意する。
 * スコープを増やしても、再連携するまで古いトークンのままになる。
 */
function grantedScopes_(accountKey) {
  try {
    const raw = getXService_(accountKey).getStorage().getValue(null);
    if (!raw) return '';
    const tok = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    return String((tok && tok.scope) || '');
  } catch (e) {
    return '';
  }
}

/**
 * メディアを上げられるトークンか。
 *
 * ★★2026-08-22、これが false のまま走り続けていた。
 * X API v2 のメディアアップロードは media.write を別に要求する。
 * 無いと本文の投稿だけが通り、画像も動画も403で落ちる。
 * 「テキストは出るのにメディアだけ付かない」症状は全部これ。
 *
 * @return {?boolean} 判定できない場合（未連携など）は null
 */
function hasMediaScope_(accountKey) {
  const granted = grantedScopes_(accountKey);
  if (!granted) return null;
  return granted.indexOf('media.write') !== -1;
}

/** 再連携が必要なアカウント（メディア権限を持たないもの）。 */
function accountsNeedingRelink_() {
  return Object.keys(ACCOUNTS).filter(function (k) {
    return hasMediaScope_(k) === false;
  });
}

/**
 * メディア権限の状態を1語で返す。診断の表示はこれを使う。
 *
 * ★★hasMediaScope_ の null を「未連携」と決めつけてはいけない。
 * null になるのは2通りある：
 *   ・トークンが無い（本当に未連携）
 *   ・トークンはあるが保存された応答に scope が入っていない
 * 後者はトークンを更新(refresh)した後に起こりうる。X の refresh 応答は
 * scope を省略することがあり、その時に「未連携」と表示すると、
 * 再連携を済ませた直後の人にもう一度やり直させることになる。
 *
 * @return {string} 'ok' | 'missing' | 'unlinked' | 'unknown'
 */
function mediaScopeState_(accountKey) {
  const has = hasMediaScope_(accountKey);
  if (has === true) return 'ok';
  if (has === false) return 'missing';

  // 判定できなかった。連携そのものが有るかどうかで意味が変わる
  try {
    if (getXService_(accountKey).hasAccess()) return 'unknown';
  } catch (e) {}
  return 'unlinked';
}

/** 連携解除。トークンを破棄するので、再投稿には再認証が必要になる。 */
function resetService_(accountKey) {
  getXService_(accountKey).reset();
}

/** 認証完了ページ・エラーページの簡易レンダラ */
function renderPage_(title, body, ok) {
  const color = ok ? '#1d9bf0' : '#d93025';
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title></head>' +
    '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;line-height:1.7">' +
    '<h2 style="color:' + color + ';margin:0 0 16px">' + escapeHtml_(title) + '</h2>' +
    '<pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;margin:0">' +
    escapeHtml_(body) + '</pre></body></html>';
  return HtmlService.createHtmlOutput(html);
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
