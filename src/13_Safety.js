/**
 * ===========================================================================
 * 13_Safety.gs  —  緊急停止・アカウント取り違え防止（P1-8 / P1-11）
 * ===========================================================================
 * 「壊れたまま動き続ける」ことを防ぐための層。
 *
 * 自動投稿システムで最悪なのは、止まることではなく、
 * 壊れた状態で2時間おきに投稿し続けてクレジットとアカウントを溶かすこと。
 * 異常を検知したら投稿を止め、LINEへ通知して人間の判断を待つ。
 *
 * 【止め方はトリガー削除ではない】
 * トリガーを消すと、作った本人でないと復旧できない（幽霊トリガー問題と同根）。
 * 代わりに「緊急停止フラグ」を立て、processQueue が自分で早期リターンする。
 * LINEから解除でき、状態も見える。
 */

/* ------------------------------------------------------------------ */
/* 緊急停止フラグ                                                       */
/* ------------------------------------------------------------------ */

const EMERGENCY_STOP_PROP = 'EMERGENCY_STOP';         // 全体停止
const EMERGENCY_STOP_REASON_PROP = 'EMERGENCY_STOP_REASON';
const EMERGENCY_STOP_AT_PROP = 'EMERGENCY_STOP_AT';

/** アカウント単位の停止。片方だけ死んでいる時に、もう片方を巻き込まない。 */
function accountStopProp_(accountKey) {
  return 'STOP_' + String(accountKey).toUpperCase();
}

/**
 * 停止理由もアカウント単位で持つ。
 *
 * ★2026-08-18に発覚した不具合。
 * 停止フラグは STOP_A / STOP_B と分けてあったのに、
 * 理由だけが EMERGENCY_STOP_REASON という共有の1枠だった。
 * 後から止まった方の理由が上書きするので、
 * Aの停止画面にBの理由が出る。実際にこう表示された：
 *
 *   「プロジェクトA は現在停止中です。理由: [B] クレジット残高が不足…」
 *
 * Aを止めた原因を調べようとしてBの事情を読まされる。
 * 原因追跡が丸ごと狂うので、理由も分けて持つ。
 */
function accountStopReasonProp_(accountKey) {
  return 'STOP_REASON_' + String(accountKey).toUpperCase();
}

/** そのアカウントの停止理由。自分の理由が無ければ全体停止の理由を返す。 */
function stopReasonFor_(accountKey) {
  if (accountKey) {
    const own = getProp_(accountStopReasonProp_(accountKey), '');
    if (own) return own;
  }
  return getProp_(EMERGENCY_STOP_REASON_PROP, '(不明)');
}

function isEmergencyStopped_() {
  return getProp_(EMERGENCY_STOP_PROP, '') === '1';
}

function isAccountStopped_(accountKey) {
  if (isEmergencyStopped_()) return true;
  if (getProp_(accountStopProp_(accountKey), '') !== '1') return false;

  /*
   * ★クレジット切れ(402)だけは自動で復帰させる。
   *
   * 他の停止理由（トークン失効・凍結・モデル消失）は人が直すまで直らない。
   * だが402は「残高を足せば直る」種類で、しかも足したかどうかは
   * こちらからは分からない。
   *
   * 実際に2026-08-18、残高$4.97を入れた後も止まったままで、
   * 14時間投稿できなかった。システムは「停止中」とだけ言い続け、
   * オーナーが気づいて手で「再開」を送るまで動かなかった。
   *
   * 一定時間ごとに1回だけ試す。通れば停止を解除し、
   * また402なら止まったまま（通知は重ねない）。
   * 最悪でも6時間に1回の呼び出しなので、残高を溶かすことはない。
   */
  return !creditRetryDue_(accountKey);
}

/**
 * 投稿を止める。既に止まっている場合は通知を重ねない
 * （2時間おきに同じ通知が届くと、本当に見るべき通知が埋もれる）。
 *
 * @param {?string} accountKey null なら全体停止
 * @param {string} reason 人間が読んで判断できる理由
 * @return {boolean} 今回新たに止めたなら true
 */
/* ------------------------------------------------------------------ */
/* Xが受け付けない時、それ以上叩かないための遮断器                       */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-24、オーナー指摘「投稿もされていないのにクレジットばかり
 * 消費している」。実際に402で残高が尽きた。
 *
 * 【何が起きていたか】
 * メディアのアップロード(25_Media.gs / 29_Video.gs)は 401/402/403/429 を
 * 一切見ておらず、失敗したら次の候補を試すだけだった。そこへ
 * 「絶対に1本出す」ための多段リトライ（動画3本→画像8枚→写真5枚）を
 * 重ねたため、最初の402で打ち切るべき場面で最大16回ぶん叩いていた。
 * A/B 2アカウント × 1日12サイクルで、投稿0本のままクレジットが溶けた。
 *
 * 【対策】
 * 一度でもXが 401/402/403/429 を返したら、この実行中は以降のX呼び出しを
 * 全部やめる。さらにプロパティへ期限を書き、次のサイクルでも一定時間は
 * 叩かない。残高不足は「次を試せば通る」種類の失敗ではない。
 */
/*
 * ★★遮断器はアカウント単位で持つ（2026-08-24 修正）。
 *
 * 最初に入れた版は共有の1枠 'x_blocked_until' だった。これは誤り。
 * クレジットも停止フラグ(STOP_A / STOP_B)もアカウントごとに分かれているのに、
 * 遮断器だけ共有だと、Aが402を返した瞬間にBのX呼び出しまで6時間止まる。
 * 実際「Bは動画が出ているのにAが出ない」を追う中でこれを見つけた。
 * 逆向き（Aの402でBが沈黙する）も同じ理屈で起きる。
 *
 * 停止理由を STOP_REASON_A / _B に分けた時（上の #accountStopReasonProp_）と
 * 全く同じ失敗を繰り返している。分けるなら最後まで分ける。
 */
const X_BLOCKED_UNTIL_PROP = 'x_blocked_until';   // ★旧・共有キー。掃除用に残す

function xBlockedUntilProp_(accountKey) {
  return X_BLOCKED_UNTIL_PROP + '_' + String(accountKey || 'UNKNOWN').toUpperCase();
}

/** この実行中に既にXから拒否されたアカウント。実行をまたがない即時の遮断。 */
let xRefusedThisRun_ = {};

/** 拒否コードごとの停止時間。残高不足は長め、レート制限は短め。 */
function xBlockMinutesFor_(code) {
  if (code === 402) return 6 * 60;    // 残高。買うまで直らない
  if (code === 401) return 60;        // 認証切れ。再連携が要る
  if (code === 403) return 60;        // 権限
  return 15;                          // 429 など
}

/**
 * 今そのアカウントでXを叩いてよいか。
 *
 * ★accountKey は必須。呼び出し側が渡し忘れると 'UNKNOWN' という
 * 別枠になり、A/Bどちらの遮断にも引っかからない。渡し忘れを
 * 見つけやすくするため、あえて共有枠へは落とさない。
 *
 * @param {string} accountKey
 */
function xCallsBlocked_(accountKey) {
  const k = String(accountKey || 'UNKNOWN').toUpperCase();
  if (xRefusedThisRun_[k]) return true;
  const until = Number(getProp_(xBlockedUntilProp_(k), '0')) || 0;
  return until > Date.now();
}

/** 遮断が解けるまでの残り分数。0なら遮断していない。診断表示用。 */
function xBlockRemainMinutes_(accountKey) {
  const until = Number(getProp_(xBlockedUntilProp_(accountKey), '0')) || 0;
  const ms = until - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/**
 * Xから拒否された。そのアカウントの以降の呼び出しを止める。
 *
 * @param {?string} accountKey
 * @param {number} code HTTPステータス
 * @param {string} where どこで起きたか（ログ用）
 * @return {boolean} 遮断したなら true
 */
function noteXRefusal_(accountKey, code, where) {
  const c = Number(code) || 0;
  if ([401, 402, 403, 429].indexOf(c) === -1) return false;

  const k = String(accountKey || 'UNKNOWN').toUpperCase();
  xRefusedThisRun_[k] = true;
  const mins = xBlockMinutesFor_(c);
  try {
    props_().setProperty(xBlockedUntilProp_(k), String(Date.now() + mins * 60 * 1000));
  } catch (e) {}

  console.error('[' + k + '] Xが ' + c + ' を返しました（' + where + '）。' +
                mins + '分はこのアカウントでXを叩きません。');

  // 402は残高そのもの。投稿も止める（既存の停止機構へ渡す）
  if (c === 402 && accountKey) {
    try {
      triggerEmergencyStop_(accountKey,
        'Xのクレジット残高が不足しています（402 / ' + where + '）。');
    } catch (e) {}
  }
  return true;
}

/**
 * 残高を足した等で復帰した時に遮断を解く。
 *
 * @param {?string} accountKey 省略時は全アカウント分を解く
 */
function clearXBlock_(accountKey) {
  if (accountKey) {
    const k = String(accountKey).toUpperCase();
    delete xRefusedThisRun_[k];
    try { props_().deleteProperty(xBlockedUntilProp_(k)); } catch (e) {}
    return;
  }
  xRefusedThisRun_ = {};
  try {
    Object.keys(ACCOUNTS).forEach(function (k) {
      props_().deleteProperty(xBlockedUntilProp_(k));
    });
    props_().deleteProperty(xBlockedUntilProp_('UNKNOWN'));
    // ★旧・共有キーの残骸も消す。残しても誰も読まないが、
    //   プロパティ欄が50件で見切れる環境なので拾えるゴミは拾う。
    props_().deleteProperty(X_BLOCKED_UNTIL_PROP);
  } catch (e) {}
}

function triggerEmergencyStop_(accountKey, reason) {
  const key = accountKey ? accountStopProp_(accountKey) : EMERGENCY_STOP_PROP;
  const already = getProp_(key, '') === '1';
  const label = (accountKey ? '[' + accountKey + '] ' : '[全体] ') + truncate_(reason, 400);

  props_().setProperty(key, '1');
  // ★理由はアカウント単位で持つ。共有の1枠に書くと他方の理由を消してしまう。
  if (accountKey) props_().setProperty(accountStopReasonProp_(accountKey), label);
  props_().setProperty(EMERGENCY_STOP_REASON_PROP, label);
  props_().setProperty(EMERGENCY_STOP_AT_PROP, new Date().toISOString());

  /*
   * ★402で止めた時点で、自動再試行の時計を今に合わせる。
   *
   * これが無いと「止めた直後の次のサイクルで即もう一度試す」になる。
   * 402で止まった直後に試しても、まず同じ402が返ってくるだけで、
   * その呼び出しぶんの課金だけが消える。最初の1回もきちんと間隔を空ける。
   */
  if (accountKey && /402|クレジット/.test(String(reason))) {
    props_().setProperty(creditRetryProp_(accountKey), String(Date.now()));
  }

  if (already) {
    console.warn('既に停止中（通知は省略）: ' + reason);
    return false;
  }

  console.error('🛑 自動投稿を停止: ' + reason);
  notifyAdmin_([
    '🛑 自動投稿を停止しました',
    accountKey ? '対象: ' + accountKey : '対象: 全アカウント',
    '',
    truncate_(reason, 400),
    '',
    'LINEで「再開」と送ると解除できます。',
    '原因を直してから再開してください。'
  ].join('\n'));
  return true;
}

/** 停止を解除する。@return {string} 何を解除したか */
/**
 * 直前の停止がXのクレジット切れ(402)だったか。
 *
 * ★これを見ないと「再開→また402で停止」を繰り返す。
 * 実際に 14:16に再開 → 14:45に再停止 という往復が起きた（2026-08-18）。
 * 残高が無いまま再開しても、次の投稿試行で必ず同じ場所に戻るうえ、
 * その試行分の呼び出しは消費される。
 */
function lastStopWasCredits_(accountKey) {
  return /402|クレジット/.test(stopReasonFor_(accountKey));
}

/* ------------------------------------------------------------------ */
/* クレジット切れからの自動復帰                                         */
/* ------------------------------------------------------------------ */

/** 402で止まった後、次に試すまでの間隔。 */
const CREDIT_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

function creditRetryProp_(accountKey) {
  return 'credit_retry_at_' + String(accountKey).toUpperCase();
}

/**
 * 402での停止中に、そろそろ1回試してよいか。
 *
 * ★ここでは時刻を書かない。isAccountStopped_ は1サイクルに何度も
 * 呼ばれるので、判定のたびに記録すると即座に窓を使い切ってしまう。
 * 記録は実際に投稿を試みる1箇所（noteCreditRetryAttempt_）だけで行う。
 */
function creditRetryDue_(accountKey) {
  if (!lastStopWasCredits_(accountKey)) return false;
  const last = Number(getProp_(creditRetryProp_(accountKey), '0')) || 0;
  // 時計が無い＝旧バージョンで止まったまま移行してきた場合。1回試してよい。
  if (!last) return true;
  return (Date.now() - last) >= CREDIT_RETRY_INTERVAL_MS;
}

/** 402停止中の自動再試行を1回消費する。停止中でなければ何もしない。 */
function noteCreditRetryAttempt_(accountKey) {
  if (getProp_(accountStopProp_(accountKey), '') !== '1') return;
  if (!lastStopWasCredits_(accountKey)) return;
  try {
    props_().setProperty(creditRetryProp_(accountKey), String(Date.now()));
    console.warn('402停止中の自動再試行 [' + accountKey + ']');
  } catch (e) {}

  /*
   * ★再試行するなら遮断器も一緒に解く（2026-08-24）。
   *
   * 402の遮断は6時間、402停止の自動再試行も6時間。片方だけ解けても
   * 「再試行する権利はあるがXを叩けない」という噛み合わない状態になり、
   * 残高を足しても復帰しない。せっかくの1回を無駄にしないため揃える。
   */
  clearXBlock_(accountKey);
}

/**
 * 投稿が通ったので、そのアカウントの停止を解除する。
 * 残高が戻ったことを実際の成功で確認できた時だけ呼ぶ。
 */
function clearAccountStopAfterSuccess_(accountKey) {
  if (getProp_(accountStopProp_(accountKey), '') !== '1') return;
  try {
    props_().deleteProperty(accountStopProp_(accountKey));
    props_().deleteProperty(accountStopReasonProp_(accountKey));
    props_().deleteProperty(creditRetryProp_(accountKey));
  } catch (e) {}
  clearXBlock_(accountKey);   // ★実際に通ったのだから遮断も要らない
  notifyAdmin_('✅ ' + accountKey + ': 残高が戻ったので自動で再開しました。');
}

function clearEmergencyStop_() {
  const cleared = [];
  if (getProp_(EMERGENCY_STOP_PROP, '') === '1') cleared.push('全体');
  props_().deleteProperty(EMERGENCY_STOP_PROP);

  Object.keys(ACCOUNTS).forEach(function (k) {
    if (getProp_(accountStopProp_(k), '') === '1') cleared.push(k);
    props_().deleteProperty(accountStopProp_(k));
    props_().deleteProperty(accountStopReasonProp_(k));
    props_().deleteProperty(creditRetryProp_(k));
  });

  props_().deleteProperty(EMERGENCY_STOP_REASON_PROP);
  props_().deleteProperty(EMERGENCY_STOP_AT_PROP);
  /*
   * ★遮断器も解く（2026-08-24）。
   * ここを消し忘れると「再開」と送っても最大6時間Xを叩かないままで、
   * 残高を足したのに何も起きない、という状態になる。
   */
  clearXBlock_();
  resetConsecutiveErrors_();

  return cleared.length ? cleared.join(' / ') : 'なし（停止していませんでした）';
}

/** 状態表示用の1行。 */
function emergencyStopStatusText_() {
  if (isEmergencyStopped_()) {
    return '🛑 緊急停止中\n  理由: ' + (getProp_(EMERGENCY_STOP_REASON_PROP, '(不明)')) +
           '\n  停止時刻: ' + (getProp_(EMERGENCY_STOP_AT_PROP, '(不明)')) +
           '\n  →「再開」で解除';
  }
  const stopped = Object.keys(ACCOUNTS).filter(function (k) {
    return getProp_(accountStopProp_(k), '') === '1';
  });
  if (stopped.length) {
    // ★理由はアカウントごとに出す。共有枠を読むと他方の理由が出る。
    return '⚠️ 一部停止中\n' + stopped.map(function (k) {
      return '  ' + k + ': ' + truncate_(stopReasonFor_(k), 120);
    }).join('\n') + '\n  →「再開」で解除';
  }
  return '✅ 稼働中';
}

/* ------------------------------------------------------------------ */
/* 連続エラーによる自動停止                                             */
/* ------------------------------------------------------------------ */

/** 原因不明のエラーが何回続いたら止めるか。 */
const CONSECUTIVE_ERROR_LIMIT = 3;

/**
 * ★アカウント別に持つ。
 *
 * これを1本のグローバルカウンタにしていた旧実装には実害のあるバグがあった。
 * A/Bは交互に投稿されるため、Aが連続でエラーを起こしても、
 * 間に挟まるBの成功が recordSuccess_() でカウンタをリセットしてしまい、
 * 「原因不明エラー3回で自動停止」が実質発動しなかった。
 */
function consecutiveErrorProp_(accountKey) {
  return 'consecutive_errors_' + String(accountKey).toUpperCase();
}

function recordSuccess_(accountKey) {
  props_().deleteProperty(consecutiveErrorProp_(accountKey));
}

/** 全アカウントぶんをまとめて消す。緊急停止の解除時に使う。 */
function resetConsecutiveErrors_() {
  Object.keys(ACCOUNTS).forEach(function (k) {
    props_().deleteProperty(consecutiveErrorProp_(k));
  });
}

function consecutiveErrorCount_(accountKey) {
  return Number(getProp_(consecutiveErrorProp_(accountKey), '0')) || 0;
}

/**
 * 原因の特定できないエラーを1回数える。上限に達したら止める。
 * @return {number} 現在の連続回数（そのアカウント分）
 */
function recordUnknownError_(accountKey, reason) {
  const n = consecutiveErrorCount_(accountKey) + 1;
  props_().setProperty(consecutiveErrorProp_(accountKey), String(n));
  console.warn('原因不明のエラー[' + accountKey + '] ' + n + '/' + CONSECUTIVE_ERROR_LIMIT + ': ' + reason);

  if (n >= CONSECUTIVE_ERROR_LIMIT) {
    // 全体ではなく、そのアカウントだけを止める。もう片方は無関係のため。
    triggerEmergencyStop_(accountKey,
      '原因不明のエラーが' + n + '回続きました。\n最後のエラー: ' + truncate_(reason, 250));
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Xのエラー種別ごとの扱い（P1-11）                                     */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_STREAK_PROP = 'rate_limit_streak_';
const RATE_LIMIT_STREAK_LIMIT = 3;

/**
 * 投稿失敗をエラー種別で仕分けし、必要なら自動停止する。
 *
 * 種別ごとの方針（指示書P1-11）
 *   401 認証切れ    → 即停止。放置すると全投稿が失敗し続ける
 *   402 残高不足    → 即停止。叩くだけ無駄
 *   403 拒否        → 停止。権限設定かポリシー違反で、再試行では直らない
 *   429 レート超過  → 今回は見送り。連続したら停止
 *   5xx / 通信断    → 結果不明として別扱い（UNKNOWN。ここには来ない）
 *   その他          → 連続3回で停止
 *
 * @return {boolean} 停止させたなら true
 */
function handlePostFailure_(accountKey, err) {
  const msg = String((err && err.message) || err);
  const code = detectHttpStatus_(msg);

  if (err instanceof NeedsAuthError || code === 401) {
    triggerEmergencyStop_(accountKey,
      'Xの認証が無効です（401）。再連携するまで投稿できません。\n' +
      'LINEで「Xリンク ' + accountKey + '」から再連携してください。');
    return true;
  }

  if (code === 402) {
    triggerEmergencyStop_(accountKey,
      'Xのクレジット残高が不足しています（402）。\n' +
      'Developer Portal で購入してから「再開」してください。\n' +
      '※クレジットはXのアカウントではなく Developer Portal の開発者アカウントに紐づきます。\n' +
      '　両アプリが同じ開発者アカウント配下なら共有、分けているなら別々です。');
    return true;
  }

  if (code === 403) {
    triggerEmergencyStop_(accountKey,
      'Xに投稿を拒否されました（403）。再試行では直りません。\n' +
      'アプリ権限（Read and write）とポリシー違反を確認してください。\n' + truncate_(msg, 200));
    return true;
  }

  if (code === 429) {
    const key = RATE_LIMIT_STREAK_PROP + String(accountKey).toUpperCase();
    const n = (Number(getProp_(key, '0')) || 0) + 1;
    props_().setProperty(key, String(n));

    if (n >= RATE_LIMIT_STREAK_LIMIT) {
      triggerEmergencyStop_(accountKey,
        'レートリミット（429）が' + n + '回続きました。投稿間隔か件数を見直してください。');
      return true;
    }
    console.warn('429 ' + n + '回目。今回は見送ります。');
    return false;
  }

  // 種別が判別できないもの
  recordUnknownError_(accountKey, msg);
  return isAccountStopped_(accountKey);
}

/** 成功したらレートリミット・連続エラーのカウントも戻す（そのアカウント分だけ）。 */
function recordPostSuccess_(accountKey) {
  props_().deleteProperty(RATE_LIMIT_STREAK_PROP + String(accountKey).toUpperCase());
  recordSuccess_(accountKey);
}

/**
 * Geminiの安全フィルタによる拒否かどうか。
 *
 * 安全フィルタは「その内容が通らなかった」だけで、システムの故障ではない。
 * 停止させず、その投稿だけ捨てて別の角度で作り直すのが正しい扱い。
 */
function isSafetyBlock_(err) {
  const msg = String((err && err.message) || err);
  return /SAFETY|blockReason|安全フィルタ|拒否しました/i.test(msg);
}

/** エラー文からHTTPステータスを拾う。判別できなければ 0。 */
function detectHttpStatus_(message) {
  const m = String(message || '').match(/\b(401|402|403|429|5\d\d)\b/);
  return m ? Number(m[1]) : 0;
}

/* ------------------------------------------------------------------ */
/* アカウント取り違え防止（P1-8）                                       */
/* ------------------------------------------------------------------ */

function expectedUserIdProp_(accountKey) {
  return 'X_EXPECTED_USER_ID_' + String(accountKey).toUpperCase();
}
function expectedUsernameProp_(accountKey) {
  return 'X_EXPECTED_USERNAME_' + String(accountKey).toUpperCase();
}

/**
 * 連携完了時に「このアカウントはこのXユーザー」と固定する。
 *
 * ★同じXユーザーが既に別のキーへ紐づいていたら拒否する。
 * これは実際に起きる事故で、Aを連携するつもりでB側のXアカウントに
 * ログインしたまま承認すると、AとBが同じXアカウントを指してしまう。
 * そのまま運用すると、A用の投稿がBのタイムラインへ流れ続ける。
 *
 * @return {{ok:boolean, message:string}}
 */
function pinExpectedXUser_(accountKey, userId, username) {
  const key = String(accountKey).toUpperCase();
  if (!userId) {
    return { ok: true, message: 'Xユーザー情報を取得できなかったため、固定をスキップしました。' };
  }

  // 他のキーが同じXユーザーを既に押さえていないか
  const conflict = Object.keys(ACCOUNTS).filter(function (k) {
    return k !== key && getProp_(expectedUserIdProp_(k), '') === String(userId);
  });

  if (conflict.length) {
    const msg = '⚠️ ' + key + ' と ' + conflict.join('/') +
      ' が同じXアカウント（@' + (username || userId) + '）を指しています。\n' +
      'Xからログアウトしてから、正しいアカウントで連携し直してください。';
    console.error(msg);
    notifyAdmin_(msg);
    return { ok: false, message: msg };
  }

  const previous = getProp_(expectedUserIdProp_(key), '');
  props_().setProperty(expectedUserIdProp_(key), String(userId));
  if (username) props_().setProperty(expectedUsernameProp_(key), String(username));

  if (previous && previous !== String(userId)) {
    notifyAdmin_('ℹ️ ' + key + ' の連携先Xアカウントが変わりました。\n' +
                 '旧: ' + previous + '\n新: ' + userId + ' (@' + (username || '?') + ')');
  }
  return { ok: true, message: '連携先を @' + (username || userId) + ' に固定しました。' };
}

/**
 * 投稿の直前に、トークンの持ち主が想定どおりか確かめる。
 *
 * 毎回 users/me を叩くと、その読み取りも従量課金の対象になる。
 * そのため通常はローカルに保存済みのIDと突き合わせるだけにし、
 * 24時間に1回だけ実サーバーへ問い合わせて裏取りする。
 *
 * @throws {Error} 不一致の場合（投稿してはいけない）
 */
function assertAccountBinding_(accountKey) {
  const key = String(accountKey).toUpperCase();
  let expected = getProp_(expectedUserIdProp_(key), '');

  let actual = '';
  try {
    actual = String(getXService_(key).getStorage().getValue('user_id') || '');
  } catch (e) {
    console.warn('保存済みユーザーIDの取得に失敗: ' + e);
  }

  // まだ固定していない場合は、ここで固定する。
  // 再連携するまで無防備になるのを避けるための措置。
  //
  // ★このときはローカルの保存値ではなく、users/me の応答を正とする。
  // 保存値は過去のもので、その後トークンを取り直していれば古い可能性がある。
  // 古い値を「正解」として固定すると、直後の再確認で食い違い、
  // 何も壊れていないのに停止してしまう。
  if (!expected) {
    let authoritative = '';
    let name = '';
    try {
      const info = fetchXUserInfo_(key);
      if (info && info.id) { authoritative = String(info.id); name = info.username || ''; }
    } catch (e) {
      console.warn('固定用の users/me 取得に失敗: ' + e);
    }
    // サーバーへ届かない場合だけ、保存値で代用する
    if (!authoritative) authoritative = actual;
    if (!authoritative) return;                // 判定材料が無い。素通し

    const pin = pinExpectedXUser_(key, authoritative, name || getStoredUsername_(key));
    if (!pin.ok) {
      triggerEmergencyStop_(key, pin.message);
      throw new Error('⚠️ Xアカウント不一致。投稿を停止しました。\n' + pin.message);
    }
    expected = authoritative;
    actual = authoritative;
    // 今まさに実物を確認したので、直後の再確認は不要
    props_().setProperty(BINDING_CHECK_PROP + key, String(Date.now()));
  }

  if (actual && actual !== expected) {
    const msg = key + ' のトークンが別のXアカウントを指しています。\n' +
                '想定: ' + expected + ' (@' + getProp_(expectedUsernameProp_(key), '?') + ')\n' +
                '実際: ' + actual + '\n投稿を中止しました。';
    triggerEmergencyStop_(key, msg);
    throw new Error('⚠️ Xアカウント不一致。投稿を停止しました。\n' + msg);
  }

  // 24時間に1回、実サーバーへ確認する
  if (shouldReverifyBinding_(key)) {
    reverifyAccountBinding_(key, expected);
  }
}

const BINDING_CHECK_PROP = 'binding_checked_at_';
const BINDING_CHECK_INTERVAL_HOURS = 24;

function shouldReverifyBinding_(accountKey) {
  const last = Number(getProp_(BINDING_CHECK_PROP + accountKey, '0')) || 0;
  return (Date.now() - last) > BINDING_CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
}

/**
 * users/me を実際に叩いて突き合わせる。
 * 取得できなかった場合は「不一致」と断定しない（通信不調で止めない）。
 */
function reverifyAccountBinding_(accountKey, expected) {
  // 先に時刻を記録する。失敗し続けた時に毎回叩いて課金が膨らむのを防ぐ。
  props_().setProperty(BINDING_CHECK_PROP + accountKey, String(Date.now()));

  let info = null;
  try {
    info = fetchXUserInfo_(accountKey);
  } catch (e) {
    console.warn('アカウント確認の通信に失敗（投稿は継続）: ' + e);
    return;
  }
  if (!info || !info.id) {
    console.warn('アカウント確認: users/me から情報を取得できませんでした（投稿は継続）');
    return;
  }

  if (String(info.id) !== String(expected)) {
    const msg = accountKey + ' の実際の投稿先が想定と違います。\n' +
                '想定: ' + expected + '\n実際: ' + info.id + ' (@' + (info.username || '?') + ')';
    triggerEmergencyStop_(accountKey, msg);
    throw new Error('⚠️ Xアカウント不一致。投稿を停止しました。\n' + msg);
  }
  console.log('アカウント確認OK [' + accountKey + '] ' + info.id);
}
