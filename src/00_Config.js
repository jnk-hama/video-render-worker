/**
 * ===========================================================================
 * 00_Config.gs  —  設定・定数・共通ユーティリティ
 * ===========================================================================
 * 【必要なスクリプトプロパティ】
 *   必須:
 *     APP_A_CLIENT_ID           … プロジェクトA用 X アプリの Client ID
 *     APP_A_CLIENT_SECRET       … 同 Client Secret
 *     APP_B_CLIENT_ID           … プロジェクトB用 X アプリの Client ID
 *     APP_B_CLIENT_SECRET       … 同 Client Secret
 *     LINE_CHANNEL_ACCESS_TOKEN … LINE Messaging API の長期チャネルアクセストークン
 *   任意:
 *     WEBHOOK_SECRET            … Webhook難読化の共有シークレット。設定した場合、
 *                                 LINE の Webhook URL を /exec?bot_token=<この値> にする。
 *                                 未設定なら検証をスキップする（フェイルセーフ）
 *     ALLOWED_LINE_USER_IDS     … 投稿を許可する LINE userId（カンマ区切り）
 *                                 未設定だと「URLを知る誰でも投稿できる」状態になる。設定推奨。
 *     ADMIN_LINE_USER_ID        … 認証完了などをプッシュ通知する宛先 userId
 *     ADMIN_TOKEN               … doGet の管理画面を保護する合言葉（?token=... で照合）
 *     MONTHLY_SOFT_CAP          … 1アカウントあたりの月間投稿上限。到達すると投稿を拒否する。
 *                                 未設定なら上限チェックなし（カウントのみ）
 *     AUTH_MODE                 … 'exec'(既定) / 'usercallback'。認証の戻り先の方式
 *     LOG_SPREADSHEET_ID        … 予約投稿キュー（Queueシート）を持つスプレッドシートのID。
 *                                 06_Scheduler.gs の自動投稿を使う場合のみ必須
 *     GEMINI_API_KEY / LLM_API_KEY … Gemini APIキー。{AUTO}による本文自動生成に必須
 *     LLM_MODEL                 … モデル名（任意。既定 gemini-2.0-flash）
 *                                 404が出たら listAvailableModels() で現行名を調べる
 *     LLM_PROMPT_A / LLM_PROMPT_B … 各アカウントのsystem prompt（任意）。
 *                                 未設定なら 07_AIGenerator.gs の既定値を使う
 *     AUTO_REFILL_A / AUTO_REFILL_B … キューが空になったとき自動補充する件数。
 *                                 設定すると行を足さずに投稿が続く。
 *                                 ⚠ MONTHLY_SOFT_CAP と併用しないと青天井になる
 */

/**
 * デプロイの版。診断の末尾に出す。
 *
 * ★★2026-08-24に追加。
 *
 * 「直したのに実機が変わらない」時、原因は2通りある。
 *   ・直し方が間違っていた
 *   ・そもそも新しいコードが動いていない
 * この2つを区別できないまま推測で直し続け、丸一日を失った。
 * 版が画面に出ていれば、最初の30秒で切り分けられる。
 *
 * ★コードを変えてデプロイするたびに手で上げること。
 *   自動で埋める仕組みは入れない（GASにビルド工程が無いため、
 *   入れるなら push 前のスクリプトが要る。今はそこまでしない）。
 */
const BUILD_STAMP = '2026-08-30a';

/** アカウント定義。C, D を増やしたい場合はここに足すだけでよい（+ コールバック関数の追加）。 */
const ACCOUNTS = Object.freeze({
  A: Object.freeze({
    key: 'A',
    label: 'プロジェクトA',
    // トークンの保存キー接頭辞。A と B で別名にすることで保存領域が完全に分離される。
    serviceName: 'x_acct_a',
    clientIdProp: 'APP_A_CLIENT_ID',
    clientSecretProp: 'APP_A_CLIENT_SECRET',
    // ★ここに書いた名前と同名のグローバル関数が 01_OAuth.gs に必要
    callbackFunctionName: 'authCallbackA'
  }),
  B: Object.freeze({
    key: 'B',
    label: 'プロジェクトB',
    serviceName: 'x_acct_b',
    clientIdProp: 'APP_B_CLIENT_ID',
    clientSecretProp: 'APP_B_CLIENT_SECRET',
    callbackFunctionName: 'authCallbackB'
  })
});

/** 要件3のスコープ。offline.access がないとリフレッシュトークンが発行されない。 */
/*
 * ★★2026-08-22、メディアが1枚も上がらなかった根本原因はここだった。
 *
 * X API v2 のメディアアップロード（/2/media/upload 系）は
 * `media.write` スコープを別に要求する。
 * tweet.write だけでは本文の投稿は通るが、メディアだけが403で落ちる。
 * 「テキストは出るのに画像も動画も付かない」という症状は全てこれ。
 *
 * ★スコープを増やしたトークンは、再連携するまで有効にならない。
 * 既存のトークンは古いスコープのままなので、LINEで
 * 「Xリンク A」「Xリンク B」をやり直す必要がある。
 * hasMediaScope_() で判定し、未再連携なら明示的に知らせる。
 */
const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read',
                  'media.write', 'offline.access'].join(' ');

// 旧ドメイン(twitter.com / api.twitter.com)でも現状は動作する。障害時の代替として記憶しておく。
const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL     = 'https://api.x.com/2/oauth2/token';
const X_TWEETS_URL    = 'https://api.x.com/2/tweets';
const X_ME_URL        = 'https://api.x.com/2/users/me';

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_PUSH_URL  = 'https://api.line.me/v2/bot/message/push';

// OAuthコールバックの宛先。Google の /usercallback は複数アカウント環境で既知の不具合が
// あるため使わず、この自前の /exec に直接コールバックさせている（01_OAuth.gs 参照）。
// デプロイを作り直す(create-deployment)とURLが変わるため、update-deployment で
// 同じデプロイIDを更新し続けること。変えた場合はこの定数と、X Developer Portal の
// Callback URI の両方を必ず同時に更新する。
const WEBAPP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbyawFD-lI_arA_kjlsXgUVlLbsmn2n5WfQuj2_7N_g0QTEzCitK-p30zR4IREO6q633/exec';

/**
 * 認証の戻り先の方式。スクリプトプロパティ AUTH_MODE で切り替える。
 *   'exec'         … 自前の /exec で受ける（既定）。Googleの多重ログイン不具合を回避できる。
 *   'usercallback' … ライブラリ標準。Googleの /macros/d/{id}/usercallback で受ける。
 * どちらの方式にするかで、X Developer Portal に登録すべき Callback URI が変わる。
 * 必ず「AUTH_MODE の値」と「Portalの登録値」を一致させること。
 * 現在どちらを送っているかは showAuthDiagnostics() / LINEの「診断」で確認できる。
 */
function getAuthMode_() {
  return getProp_('AUTH_MODE', 'exec') === 'usercallback' ? 'usercallback' : 'exec';
}

/** 現在の方式で、実際にXへ送る（＝Portalに登録すべき）Callback URI を返す。 */
function getOAuthRedirectUri_() {
  return getAuthMode_() === 'usercallback' ? OAuth2.getRedirectUri() : WEBAPP_EXEC_URL;
}

/** X の投稿上限（重み付き文字数） */
const TWEET_MAX_WEIGHTED_LENGTH = 280;

/**
 * アカウント別の投稿上限（重み付き文字数）。
 *
 * 280超の長文投稿は X Premium の機能。未加入のまま長い本文を送ると
 * API側で拒否されるため、既定は280のままにしてある。
 * Premiumに入っているなら TWEET_MAX_LEN_A / TWEET_MAX_LEN_B に
 * 大きい値（例: 2000）を入れると長文モードになる。
 */
function getTweetMaxLen_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const n = Number(getProp_('TWEET_MAX_LEN_' + key, '0')) || 0;
  return n > 0 ? n : TWEET_MAX_WEIGHTED_LENGTH;
}

/**
 * 生成する言語。既定は英語（対象地域が英語圏のため）。
 * LLM_LANG_A / LLM_LANG_B に 'ja' を入れると日本語で生成する。
 */
function getLang_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  return String(getProp_('LLM_LANG_' + key, 'en')).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* プロパティ                                                          */
/* ------------------------------------------------------------------ */

function props_() {
  return PropertiesService.getScriptProperties();
}

function getProp_(name, fallback) {
  const v = props_().getProperty(name);
  if (v === null || v === '') return (fallback === undefined ? null : fallback);
  return v;
}

function getRequiredProp_(name) {
  const v = getProp_(name);
  if (!v) {
    throw new Error(
      'スクリプトプロパティ "' + name + '" が未設定です。' +
      '[プロジェクトの設定] → [スクリプト プロパティ] から登録してください。'
    );
  }
  return v;
}

/**
 * 今このコードを実行しているGoogleアカウント。
 *
 * エディタ実行・トリガー実行・Webアプリ実行で、実行主体が違うことがある。
 * 主体がずれると「片方では開けるがもう片方では開けない」という状態になるため、
 * 診断のたびに必ず表示する。取得できない場合は空文字を返す（例外にしない）。
 */
function getEffectiveUserEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

function getAccount_(accountKey) {
  const acc = ACCOUNTS[String(accountKey || '').toUpperCase()];
  if (!acc) throw new Error('不明なアカウント指定です: ' + accountKey);
  return acc;
}

/* ------------------------------------------------------------------ */
/* 文字列ユーティリティ                                                */
/* ------------------------------------------------------------------ */

/** 全角英数・全角スペースを半角に寄せる。LINEの日本語入力対策。 */
function normalizeInput_(s) {
  if (!s) return '';
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .replace(/　/g, ' ')
    .trim();
}

/**
 * X の「重み付き文字数」を概算する。
 * twitter-text の設定に準拠：下記の範囲は重み1、それ以外（日本語・絵文字など）は重み2。
 * URL は実長に関係なく 23 としてカウントされる。
 * ※ 一部の絵文字（ZWJシーケンス等）は実際の判定とわずかにずれる可能性がある。
 */
function estimateWeightedLength_(text) {
  if (!text) return 0;
  // URL を除去して 23 文字ぶんとして別途加算する
  const URL_WEIGHT = 23;
  let urlCount = 0;
  const stripped = String(text).replace(/https?:\/\/\S+/g, function () {
    urlCount++;
    return '';
  });

  let weight = 0;
  for (const ch of stripped) {          // for...of はサロゲートペアを1文字として扱う
    const cp = ch.codePointAt(0);
    const light =
      (cp >= 0     && cp <= 4351) ||
      (cp >= 8192  && cp <= 8205) ||
      (cp >= 8208  && cp <= 8223) ||
      (cp >= 8242  && cp <= 8247);
    weight += light ? 1 : 2;
  }
  return weight + urlCount * URL_WEIGHT;
}

/** ログ・エラー返信用に長文を切り詰める */
function truncate_(s, max) {
  const str = String(s == null ? '' : s);
  return str.length <= max ? str : str.slice(0, max) + '…';
}

function nowMonthKey_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
}

/* ------------------------------------------------------------------ */
/* 月間投稿カウンタ                                                    */
/* ------------------------------------------------------------------ */

function monthlyCountKey_(accountKey) {
  return 'post_count_' + accountKey + '_' + nowMonthKey_();
}

function getMonthlyCount_(accountKey) {
  return Number(getProp_(monthlyCountKey_(accountKey), '0')) || 0;
}

/**
 * 投稿成功後に加算する。ロックで同時実行時の取りこぼしを防ぐ。
 *
 * ★呼び出し元(postTweet_)は processQueueCore_ の外側ロックの中で動くことが多く、
 * ここは同一実行内で二重にロックを取りに行く形になる。GASの公式ドキュメントは
 * 同一実行からの再入可否を明言していないため、待機は短く抑えて安全側に倒す
 * （最悪ブロックしても数百ms〜1秒で諦め、失敗時も投稿自体は成立させる）。
 */
function incrementMonthlyCount_(accountKey) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(1000);
    const key = monthlyCountKey_(accountKey);
    const next = (Number(getProp_(key, '0')) || 0) + 1;
    props_().setProperty(key, String(next));
    return next;
  } catch (err) {
    // カウントに失敗しても投稿自体は成功しているので、握りつぶしてログだけ残す
    console.warn('月間カウンタの更新に失敗: ' + err);
    return -1;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** ソフトキャップに達しているか。MONTHLY_SOFT_CAP 未設定なら常に false。 */
function isOverMonthlyCap_(accountKey) {
  const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;
  if (cap <= 0) return false;
  return getMonthlyCount_(accountKey) >= cap;
}

/* ------------------------------------------------------------------ */
/* 日割りペース配分                                                     */
/* ------------------------------------------------------------------ */
/*
 * ★月間上限だけでは、月末に必ず沈黙する（2026-08-16に発見）。
 *
 * トリガーは2時間おき＝1日12回。投稿が安定して出るようになると
 * 上限100件を8日ほどで使い切り、残り3週間は1本も出せない。
 * 「今月: 41/100」が緑で表示されていたのは、投稿が不安定で
 * たまたま消化が遅かっただけ。直った瞬間に問題が表面化する。
 *
 * 残予算を残り日数で割り、その日のぶんだけ出す。
 * 上限に当たってから気づくのではなく、最初から均しておく。
 */

function todayKey_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function dailyCountKey_(accountKey) {
  return 'post_count_day_' + accountKey + '_' + todayKey_();
}

/** 今日このアカウントが投稿した数。 */
function getDailyCount_(accountKey) {
  return Number(getProp_(dailyCountKey_(accountKey), '0')) || 0;
}

function incrementDailyCount_(accountKey) {
  const key = dailyCountKey_(accountKey);
  const next = (Number(getProp_(key, '0')) || 0) + 1;
  try { props_().setProperty(key, String(next)); } catch (e) {}
  return next;
}

/* ------------------------------------------------------------------ */
/* プロパティの自動掃除                                                 */
/* ------------------------------------------------------------------ */
/*
 * ★2026-08-22、Script Propertiesが50個の上限に達し新規登録ができなくなった。
 *
 * post_count_day_<ACCOUNT>_<日付> は日付が変わるたびに新しいキーが増えるだけで、
 * 消す仕組みが無かった（このファイルの dailyCountKey_ 参照）。過去日付の値は
 * この先二度と読まれないため、残す理由が無い。日次計測(runDailyMetricsCore_)に
 * 相乗りし、1日1回だけ古いキーを削除する。
 */
const PROP_KEEP_DAYS = 2;     // 今日・昨日ぶんは念のため残す
const PROP_KEEP_MONTHS = 3;   // post_count_<ACCOUNT>_<年月>（月次）はこちらの基準で残す

function cleanupOldCountProps_() {
  let removed = 0;
  try {
    const props = props_();
    // ★getKeys() はUI（プロジェクトの設定画面）と違い50件の表示上限を受けない。全件取れる。
    const keys = props.getKeys();
    const todayStr = todayKey_();

    /*
     * ★残す日付を「文字列の集合」で持つ（2026-08-22に修正）。
     *
     * 以前は「JST0時のタイムスタンプ < 今からN日前」で比較していた。
     * 基準が実行時刻とともに動くため、同じ日でも実行が遅い時間帯だと
     * 昨日ぶんが消える。今日ぶんが消えれば getDailyCount_ が0に戻り、
     * 日割り上限を超えて投稿できてしまう。
     * 暦日で数えれば実行時刻に左右されない。
     */
    const keepDays = {};
    for (let i = 0; i < PROP_KEEP_DAYS; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      keepDays[Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd')] = true;
    }
    keepDays[todayStr] = true;   // 念のため（タイムゾーン差の保険）

    const cutoffMonth = new Date();
    cutoffMonth.setMonth(cutoffMonth.getMonth() - PROP_KEEP_MONTHS);
    const cutoffMonthStr = Utilities.formatDate(cutoffMonth, 'Asia/Tokyo', 'yyyy-MM');

    keys.forEach(function (key) {
      let m = key.match(/^post_count_day_[AB]_(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        if (!keepDays[m[1]]) {
          props.deleteProperty(key);
          removed++;
        }
        return;
      }
      m = key.match(/^post_count_[AB]_(\d{4}-\d{2})$/);
      if (m && m[1] < cutoffMonthStr) {
        props.deleteProperty(key);
        removed++;
      }
    });

    if (removed > 0) console.log('古い投稿カウンターのプロパティを ' + removed + ' 件削除しました。');
  } catch (e) {
    console.warn('プロパティの自動掃除に失敗: ' + e);
  }
  return removed;
}

/**
 * 一度きりの掃除：Cloudinaryでの動画テキスト焼き込み機能（実装後に削除済み）が
 * 使っていた設定値。読むコードが無くなったので、存在すれば消してよい。
 */
const DEAD_PROPS_ONE_TIME_ = [
  'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_BASE_A', 'CLOUDINARY_BASE_B',
  'CLOUDINARY_FONT', 'CLOUDINARY_FONT_SIZE', 'CLOUDINARY_ACCENT',
  'BUZZ_VIDEO_SECONDS'
];

function cleanupDeadPropsOnce_() {
  const props = props_();
  let removed = 0;
  DEAD_PROPS_ONE_TIME_.forEach(function (key) {
    if (props.getProperty(key) !== null) {
      props.deleteProperty(key);
      removed++;
    }
  });
  if (removed > 0) console.log('未使用になった旧プロパティを ' + removed + ' 件削除しました。');
  return removed;
}

/**
 * エディタから手動実行できる版。「実行」の対象関数プルダウンで選べる。
 * 50個上限に当たった直後など、翌朝の日次計測を待たずに今すぐ掃除したい時に使う。
 */
function cleanupScriptPropertiesNow() {
  const dead = cleanupDeadPropsOnce_();
  const old = cleanupOldCountProps_();
  const msg = '旧プロパティ ' + dead + ' 件 / 古い日別カウンター ' + old + ' 件を削除しました。';
  console.log(msg);
  return msg;
}

/**
 * 診断専用（何も削除しない）。
 *
 * ★2026-08-22、cleanupScriptPropertiesNow() が「0件 / 0件」を返し、
 * 見えているはずの過去日付のカウンターが消えなかった。推測で直す前に、
 * 実際にgetKeys()が何を返し、今日の日付・締切日をどう計算しているかを
 * そのままログに出す。
 */
function diagnosePropCleanup() {
  const props = props_();
  const keys = props.getKeys();
  const todayStr = todayKey_();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - PROP_KEEP_DAYS);

  const dayKeys = keys.filter(function (k) {
    return /^post_count_day_[AB]_\d{4}-\d{2}-\d{2}$/.test(k);
  });

  const lines = [];
  lines.push('プロパティ総数(getKeys): ' + keys.length);
  lines.push('todayKey_(): ' + todayStr);
  lines.push('cutoffDate: ' + cutoffDate.toISOString() + ' / ' + cutoffDate.toString());
  lines.push('post_count_day_* 該当: ' + dayKeys.length + '件');
  dayKeys.sort().forEach(function (k) {
    const m = k.match(/^post_count_day_[AB]_(\d{4}-\d{2}-\d{2})$/);
    const d = new Date(m[1] + 'T00:00:00+09:00');
    const willDelete = (m[1] !== todayStr) && (d.getTime() < cutoffDate.getTime());
    lines.push(' - ' + k + '  日付=' + m[1] + '  削除対象=' + willDelete);
  });

  const msg = lines.join('\n');
  console.log(msg);
  return msg;
}

/**
 * 今日あと何本出してよいか。
 *
 * 残予算 ÷ 残り日数。端数は切り上げる（切り捨てると0本の日ができる）。
 *
 * @return {number} 上限が無い場合は -1
 */
/**
 * 1日に出す本数の目標（1アカウントあたり）。
 *
 * ★2026-08-18、オーナー指示で「1日4本ずつ」を明示。
 *
 * これまでは月間上限を残り日数で割るだけだったので、
 * 上限が未設定なら青天井、設定していても月末に向けて増減していた。
 * 「1日何本出るか」を先に決めて、月間上限はその上の安全弁として残す。
 *
 * DAILY_POST_TARGET で変更できる。0にすると従来どおり月割りのみ。
 */
const DAILY_POST_TARGET_DEFAULT = 4;

function dailyPostTarget_() {
  const n = Number(getProp_('DAILY_POST_TARGET', String(DAILY_POST_TARGET_DEFAULT)));
  return (isNaN(n) || n < 0) ? DAILY_POST_TARGET_DEFAULT : n;
}

function dailyPostAllowance_(accountKey) {
  const target = dailyPostTarget_();
  const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;

  // 月間上限が無いなら、日次目標だけで決まる（未設定なら青天井）
  if (cap <= 0) return target > 0 ? target : -1;

  const left = cap - getMonthlyCount_(accountKey);
  if (left <= 0) return 0;

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
  const paced = Math.max(1, Math.ceil(left / daysLeft));

  /*
   * 日次目標と月割りの小さい方を採る。
   * ★月間上限のほうが厳しい場合は月割りが勝つ。
   * 例: 上限100本 / 4本×30日=120本 → 月末が近いほど月割りが効いて絞られる。
   * 4本/日を維持したいなら MONTHLY_SOFT_CAP を120以上にする必要がある。
   */
  return target > 0 ? Math.min(target, paced) : paced;
}

/** 今日のぶんを使い切ったか。 */
function isOverDailyPace_(accountKey) {
  const allowance = dailyPostAllowance_(accountKey);
  if (allowance < 0) return false;              // 上限なし
  return getDailyCount_(accountKey) >= allowance;
}
