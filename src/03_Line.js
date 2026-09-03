/**
 * ===========================================================================
 * 03_Line.gs  —  LINE Messaging API
 * ===========================================================================
 * 【重要な制約】
 * Apps Script の doPost はリクエストヘッダを一切参照できないため、
 * LINE の x-line-signature による署名検証が原理的に実装できない。
 * 代替として ALLOWED_LINE_USER_IDS による userId ホワイトリストで防御する。
 * ウェブアプリURL自体も秘匿すること（漏れると第三者が POST を送れる）。
 */

function lineAccessToken_() {
  return getRequiredProp_('LINE_CHANNEL_ACCESS_TOKEN');
}

/**
 * @param {string} replyToken
 * @param {string} text
 * @param {Object|null} [quickReply] クイックリプライのボタン群。
 *   省略（undefined）… 常用コマンドのメインメニューを自動付与する。
 *   null              … ボタンを付けない。
 *   オブジェクト       … 指定したものをそのまま使う（本文入力待ち時の「キャンセル」等）。
 */
function replyToLine_(replyToken, text, quickReply) {
  if (!replyToken) return;

  const message = { type: 'text', text: truncate_(text, 4900) };
  const qr = (quickReply === undefined) ? mainMenuQuickReply_() : quickReply;
  if (qr) message.quickReply = qr;

  const res = UrlFetchApp.fetch(LINE_REPLY_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineAccessToken_() },
    payload: JSON.stringify({ replyToken: replyToken, messages: [message] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE reply 失敗 ' + res.getResponseCode() + ': ' + truncate_(res.getContentText(), 300));
  }
}

function pushToLine_(userId, text) {
  if (!userId) return;
  const res = UrlFetchApp.fetch(LINE_PUSH_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineAccessToken_() },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: truncate_(text, 4900) }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE push 失敗 ' + res.getResponseCode() + ': ' + truncate_(res.getContentText(), 300));
  }
}

/* ------------------------------------------------------------------ */
/* クイックリプライ（コマンドをタップで選べるボタン列）                   */
/* ------------------------------------------------------------------ */

/**
 * ボタン列を組み立てる。
 * @param {Array<{label:string, text:string}>} items 最大13個（LINEの上限）
 */
function buildQuickReply_(items) {
  return {
    items: items.slice(0, 13).map(function (it) {
      return { type: 'action', action: { type: 'message', label: it.label, text: it.text } };
    })
  };
}

/** 常用コマンドのメインメニュー。replyToLine_ の既定値として毎回付与される。 */
function mainMenuQuickReply_() {
  return buildQuickReply_([
    { label: '状態',      text: '状態' },
    { label: 'AでAI投稿', text: 'Aで自動投稿' },
    { label: 'BでAI投稿', text: 'Bで自動投稿' },
    { label: 'Aに投稿',   text: 'Aに投稿' },
    { label: 'Bに投稿',   text: 'Bに投稿' },
    { label: 'メンション', text: 'メンション' },
    { label: 'リンク一覧', text: 'リンク一覧' },
    { label: 'ストップ',   text: 'ストップ' },
    { label: 'スタート',   text: 'スタート' },
    { label: 'ヘルプ',    text: 'ヘルプ' }
  ]);
}

/** 本文入力待ちなど、選択肢を絞りたい場面用。 */
function cancelOnlyQuickReply_() {
  return buildQuickReply_([{ label: 'キャンセル', text: 'キャンセル' }]);
}

/* ------------------------------------------------------------------ */
/* 保留状態（「Aに投稿」ボタン→本文待ち、のような複数ターンのやり取り）   */
/* ------------------------------------------------------------------ */

const PENDING_ACTION_TTL_SEC = 300; // 5分。ボタンを押したまま放置されたら自動失効させる

function setPendingAction_(userId, action) {
  if (!userId) return;
  CacheService.getScriptCache().put('pending_' + userId, JSON.stringify(action), PENDING_ACTION_TTL_SEC);
}

function getPendingAction_(userId) {
  if (!userId) return null;
  const raw = CacheService.getScriptCache().get('pending_' + userId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function clearPendingAction_(userId) {
  if (!userId) return;
  CacheService.getScriptCache().remove('pending_' + userId);
}

/**
 * 管理者への通知。
 * ADMIN_LINE_USER_ID が未設定でも、許可リストの先頭へ送る。
 * トリガー実行の失敗はエディタを開かないと気づけないため、
 * 「設定し忘れて通知が来ない」状態を作らないようにしている。
 */
/* ------------------------------------------------------------------ */
/* 通知の一時停止（2026-09-03、オーナー指示「一旦通知も止めて」）        */
/* ------------------------------------------------------------------ */
/*
 * 【なぜ要るか】
 * Geminiの残高が尽きた状態では、キューの全行が同じ理由で失敗し、
 * 2時間ごとに同じ通知が届く。原因は1つで、しかも**オーナーは既に
 * 知っている**。直すまでの間、同じ話を鳴らし続ける価値は無い。
 *
 * 【なぜ「消す」ではなく「期限つきで黙らせる」か】
 * 恒久的に切ると、直した後に戻し忘れて**本当の異常に気づけなくなる**。
 * 期限が来れば自動で戻るので、戻し忘れが起きない。
 *
 * 【この判定を通らないもの】
 * 無い。全部止める。LINEから「通知停止」で入れ、「通知再開」で解く。
 */
const NOTIFY_MUTE_UNTIL_PROP = 'notify_mute_until';

/** @return {number} 消音の期限（epoch ms）。設定が無ければ0 */
function notifyMuteUntil_() {
  const raw = getProp_(NOTIFY_MUTE_UNTIL_PROP, '');
  if (!raw) return 0;
  const at = Number(raw);
  return isFinite(at) && at > 0 ? at : 0;
}

/** 消音中か。期限切れなら記録も消して通常へ戻す。 */
function isNotifyMuted_() {
  const until = notifyMuteUntil_();
  if (!until) return false;
  if (Date.now() < until) return true;
  try { props_().deleteProperty(NOTIFY_MUTE_UNTIL_PROP); } catch (e) {}
  return false;
}

/** @param {number} hours 何時間黙らせるか @return {Date} 解除予定時刻 */
function muteNotifications_(hours) {
  const h = Math.max(1, Math.min(24 * 14, Number(hours) || 24));
  const until = Date.now() + h * 60 * 60 * 1000;
  props_().setProperty(NOTIFY_MUTE_UNTIL_PROP, String(until));
  return new Date(until);
}

function unmuteNotifications_() {
  try { props_().deleteProperty(NOTIFY_MUTE_UNTIL_PROP); } catch (e) {}
}

function notifyAdmin_(text) {
  if (isNotifyMuted_()) {
    // 送らないが、何を言おうとしたかはログに残す。
    // 消音は「聞こえなくする」であって「記録しない」ではない。
    console.warn('通知は消音中のため送信しませんでした（' +
                 Utilities.formatDate(new Date(notifyMuteUntil_()),
                   'Asia/Tokyo', 'MM/dd HH:mm') + 'まで）: ' +
                 truncate_(String(text || ''), 200));
    return;
  }
  try {
    const to = adminNotifyTarget_();
    if (to) pushToLine_(to, text);
    else console.warn('通知先が無いため送信しませんでした（ADMIN_LINE_USER_ID / ALLOWED_LINE_USER_IDS が未設定）');
  } catch (e) {
    console.warn('管理者通知に失敗: ' + e);
  }
}

/* ------------------------------------------------------------------ */
/* 通知の間引き（同じ話を何度も送らない）                                */
/* ------------------------------------------------------------------ */
/*
 * ★2026-08-22、オーナー指摘。
 *
 * 「6回連続で1本も投稿できていません」という完全に同一の文面が
 * 0:13 と 6:13 に届いていた。各通知が個別に「6時間あけて再送」を
 * 持っているだけで、「前と同じことを言っているか」を見ていなかった。
 *
 * 状況が変わらないなら、繰り返すほど価値は下がる。
 * 同じ文面が続く限り間隔を倍にしていき、
 * 文面が変わったら（＝新しい情報）すぐ送る。
 *
 * 記録は1つのプロパティにまとめる。通知の種類ごとにプロパティを
 * 増やすと、以前の50件上限問題を自分で再発させることになる。
 */
const NOTIFY_STATE_PROP = 'notify_state';

/** 通知の最短間隔。文面が変わってもこれより速くは鳴らさない。 */
const NOTIFY_MIN_INTERVAL_MS = 30 * 60 * 1000;      // 30分

/** 同じ文面が続いた時の上限。ここまで伸びたら以後はこの間隔。 */
const NOTIFY_MAX_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48時間

/** 文面の同一性を見るための短いハッシュ。暗号用途ではない。 */
function notifyHash_(text) {
  /*
   * ★★2026-09-03、行番号を無視して比べる。
   *
   * 「Queue 157行目」「Queue 158行目」は**原因が同じでも文面が違う**ため、
   * 間引きが一度も効かず、失敗のたびに通知が飛んでいた（実際に18:10と
   * 20:10へ同じ内容が届いた）。数字を潰してから比べれば、
   * 「同じことを言っている」と判定できる。
   *
   * 数字が意味を持つ通知（残数・スコア）も潰れるが、
   * その場合も「値が変わっただけで内容は同じ」ことが多い。
   * 鳴らしすぎるより、まとめる方を選ぶ。
   */
  const s = String(text || '').replace(/\d+/g, '#');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function readNotifyState_() {
  try {
    const raw = getProp_(NOTIFY_STATE_PROP, '');
    if (!raw) return {};
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    return {};   // 壊れていたら作り直す。通知が止まる方が困る
  }
}

function writeNotifyState_(state) {
  try { props_().setProperty(NOTIFY_STATE_PROP, JSON.stringify(state)); }
  catch (e) { console.warn('通知状態を保存できません: ' + truncate_(String(e), 100)); }
}

/**
 * 間引きつきの管理者通知。
 *
 * @param {string} kind 通知の種類。種類ごとに独立して間引く
 * @param {string} text 本文
 * @param {number} [baseMs] 同じ文面の初回再送までの間隔。既定6時間
 * @return {boolean} 実際に送ったか
 */
function notifyAdminOnce_(kind, text, baseMs) {
  const key = String(kind || 'default');
  const base = Number(baseMs) || (6 * 60 * 60 * 1000);
  const hash = notifyHash_(text);
  const now = Date.now();

  const state = readNotifyState_();
  const prev = state[key] || {};
  const sameAsLast = prev.h === hash;

  // 同じ文面が続くほど間隔を倍に伸ばす（6h → 12h → 24h → 48h で頭打ち）
  const repeats = sameAsLast ? (Number(prev.n) || 1) : 0;
  const wait = sameAsLast
    ? Math.min(base * Math.pow(2, repeats), NOTIFY_MAX_INTERVAL_MS)
    : NOTIFY_MIN_INTERVAL_MS;

  if (prev.at && (now - Number(prev.at)) < wait) return false;

  notifyAdmin_(text);

  state[key] = { h: hash, at: now, n: sameAsLast ? repeats + 1 : 1 };
  writeNotifyState_(state);
  return true;
}

/**
 * 状況が解消した時に、その種類の間引き記録を消す。
 * 次に同じことが起きたら、待たされずに1回目として鳴る。
 */
function clearNotifyState_(kind) {
  const state = readNotifyState_();
  if (!(kind in state)) return;
  delete state[kind];
  writeNotifyState_(state);
}

/** 通知先のLINE userId。明示指定 → 許可リストの先頭 の順で決める。 */
function adminNotifyTarget_() {
  const admin = getProp_('ADMIN_LINE_USER_ID');
  if (admin) return admin.trim();

  const allowed = getProp_('ALLOWED_LINE_USER_IDS');
  if (!allowed) return '';
  const first = allowed.split(',').map(function (s) { return s.trim(); }).filter(Boolean)[0];
  return first || '';
}

/** 送信元 userId が許可されているか。ALLOWED_LINE_USER_IDS 未設定なら全許可（非推奨）。 */
function isAllowedLineUser_(userId) {
  const raw = getProp_('ALLOWED_LINE_USER_IDS');
  if (!raw) return true;
  return raw.split(',').map(function (s) { return s.trim(); })
            .filter(Boolean)
            .indexOf(userId) !== -1;
}

/**
 * userIdごとの流量制限。1分あたり LINE_RATE_LIMIT 件まで。
 * 許可リストを突破された場合や、誤って連投された場合に、
 * X APIとLLM APIの課金が青天井にならないようにするための歯止め。
 * @return {boolean} true なら処理を継続してよい
 */
const LINE_RATE_LIMIT = 5;          // 件
const LINE_RATE_WINDOW_SEC = 60;    // 秒

function checkRateLimit_(userId) {
  if (!userId) return true;

  const cache = CacheService.getScriptCache();
  const key = 'rl_' + userId;
  const current = Number(cache.get(key) || '0');

  if (current >= LINE_RATE_LIMIT) {
    console.warn('レート制限により破棄: userId=' + userId +
                 ' (' + current + '/' + LINE_RATE_LIMIT + ' per ' + LINE_RATE_WINDOW_SEC + 's)');
    return false;
  }

  // CacheServiceに原子的なincrementは無いため、get→putで数える。
  // 厳密なカウントではないが、暴走を止める用途には十分。
  // TTLは毎回更新せず固定窓として扱う（putで上書きすると窓が延び続けるため、
  // 初回putのTTLを基準にする実装が理想だが、GASでは残TTLを取得できない）。
  cache.put(key, String(current + 1), LINE_RATE_WINDOW_SEC);
  return true;
}

/**
 * 同一イベントの二重処理を防ぐ。
 * LINE はタイムアウト時などに同じ webhookEventId で再送してくることがあり、
 * これを弾かないと同じ内容が2回ツイートされる。
 * @return {boolean} true なら「初めて見るイベント」
 */
function markEventProcessed_(webhookEventId) {
  if (!webhookEventId) return true;

  // 1段目：キャッシュ。速いが最大6時間で、容量都合でいつ消えてもよい仕様。
  const cache = CacheService.getScriptCache();
  const key = 'evt_' + webhookEventId;
  if (cache.get(key)) return false;

  // 2段目：スクリプトプロパティに24時間ぶん。
  // キャッシュが消えた直後に再送が来ても、ここで止まる。
  if (!markEventProcessedPersistent_(webhookEventId)) return false;

  cache.put(key, '1', 21600);   // 6時間（CacheServiceの最大値）
  return true;
}
