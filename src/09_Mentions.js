/**
 * ===========================================================================
 * 09_Mentions.gs  —  リプライ／メンションのLINE通知
 * ===========================================================================
 * X の投稿に付いたリプライ・メンションを定期的に取得し、新着だけLINEへ転送する。
 * 返信は自分でXアプリから行う。**自動返信は実装していない。**
 *
 * 自動返信を入れない理由：
 *   - Xのスパムポリシーは自動返信・自動メンションを名指しで規制しており、
 *     一斉投稿より厳しく扱われる（凍結リスクが上がる）
 *   - 個々の相手に自動で返すと、相手は生身の人間と会話しているつもりになる
 * ここは「気づくための仕組み」に限定している。
 *
 * 【コスト】
 * Xは従量課金のため、読み取りにも課金される。
 * 投稿(2時間おき)とは別トリガーにし、既定を8時間おき(1日3回)に抑えている。
 * 1回の取得件数も MENTION_MAX_RESULTS で上限を設けている。
 *
 * 【必要なスクリプトプロパティ】
 *   MENTION_CHECK_HOURS … 確認間隔（任意。既定8時間）
 *   ADMIN_LINE_USER_ID  … 通知先（未設定なら ALLOWED_LINE_USER_IDS の先頭）
 */

const MENTION_TRIGGER_HANDLER = 'checkMentions';
const MENTION_DEFAULT_HOURS = 8;
const MENTION_MAX_RESULTS = 10;      // 1アカウント1回あたりの取得上限（課金対象）
const MENTION_NOTIFY_LIMIT = 5;      // 1通のLINEに載せる最大件数

/* ------------------------------------------------------------------ */
/* メイン処理（トリガーから呼ばれる）                                   */
/* ------------------------------------------------------------------ */

/**
 * 全アカウントの新着メンションを確認し、あればLINEへ通知する。
 * 新着が無ければ何もしない（通知も飛ばさない）。
 */
function checkMentions() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.warn('checkMentions: 別の実行が処理中のためスキップしました。');
    return;
  }

  try {
    Object.keys(ACCOUNTS).forEach(function (key) {
      try {
        checkMentionsForAccount_(key);
      } catch (err) {
        // 1アカウントの失敗で他方を巻き込まない
        console.error('メンション確認に失敗 (' + key + '): ' +
                      (err && err.stack ? err.stack : err));
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function checkMentionsForAccount_(accountKey) {
  const acc = getAccount_(accountKey);

  if (!isAuthorized_(accountKey)) {
    console.log('メンション確認をスキップ (' + accountKey + '): 未連携');
    return;
  }

  const sinceKey = 'last_mention_id_' + accountKey;
  const sinceId = getProp_(sinceKey);

  const result = fetchMentions_(accountKey, sinceId);
  if (!result) return;

  // 初回は履歴を全部流さない。最新IDだけ記録して次回から差分を見る。
  // （初回に過去分を大量通知すると、読み取り課金も通知も無駄に膨らむ）
  if (!sinceId) {
    if (result.newestId) props_().setProperty(sinceKey, result.newestId);
    console.log('メンション監視の基準を設定 (' + accountKey + '): ' + (result.newestId || 'なし'));
    return;
  }

  if (!result.items.length) {
    console.log('新着メンションなし (' + accountKey + ')');
    return;
  }

  if (result.newestId) props_().setProperty(sinceKey, result.newestId);
  notifyAdmin_(buildMentionNotification_(acc, result.items));
  console.log('新着メンション ' + result.items.length + ' 件を通知 (' + accountKey + ')');
}

/**
 * メンションを取得する。
 * @param {string} accountKey
 * @param {string} [sinceId] これより新しいものだけ取得する
 * @return {?{items:Array, newestId:string}}
 */
function fetchMentions_(accountKey, sinceId) {
  const service = getXService_(accountKey);
  const userId = getXUserId_(accountKey);
  if (!userId) {
    console.warn('ユーザーIDを取得できないため、メンション確認をスキップ (' + accountKey + ')');
    return null;
  }

  const params = [
    'max_results=' + MENTION_MAX_RESULTS,
    'tweet.fields=created_at,author_id,conversation_id',
    'expansions=author_id',
    'user.fields=username,name'
  ];
  if (sinceId) params.push('since_id=' + encodeURIComponent(sinceId));

  const url = 'https://api.x.com/2/users/' + encodeURIComponent(userId) +
              '/mentions?' + params.join('&');

  const res = fetchWithRetry_(url, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200) {
    console.error('メンション取得エラー ' + code + ' (' + accountKey + '): ' + truncate_(body, 300));

    // 読み取り権限やプランの問題は、放置すると毎回同じ失敗を繰り返す。
    // 気づけるようLINEにも流すが、通知が煩くならないよう致命的な種類だけに絞る。
    if (code === 402) {
      notifyAdmin_('⚠️ メンション確認: Xのクレジット残高が不足しています（402）。\n' +
                   '読み取りにも課金されます。通知を止めるにはLINEで「通知オフ」。');
    } else if (code === 403) {
      notifyAdmin_('⚠️ メンション確認: 読み取りが許可されていません（403）。\n' +
                   'プランまたはアプリ権限を確認してください。通知を止めるには「通知オフ」。');
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    console.error('メンション応答の解釈に失敗: ' + truncate_(body, 200));
    return null;
  }

  const data = parsed.data || [];
  const users = {};
  if (parsed.includes && parsed.includes.users) {
    parsed.includes.users.forEach(function (u) { users[u.id] = u; });
  }

  const items = data.map(function (t) {
    const u = users[t.author_id] || {};
    return {
      id: String(t.id),
      text: String(t.text || ''),
      username: u.username || '',
      name: u.name || '',
      createdAt: t.created_at || ''
    };
  });

  // newest_id が無い場合（フィールド未提供）に備え、data から最大IDを取る。
  // IDは数値文字列で桁数が揃わないため、長さ→辞書順の順で比較する。
  let newestId = (parsed.meta && parsed.meta.newest_id) ? String(parsed.meta.newest_id) : '';
  if (!newestId && items.length) {
    newestId = items.reduce(function (a, b) {
      if (a.length !== b.id.length) return a.length > b.id.length ? a : b.id;
      return a > b.id ? a : b.id;
    }, items[0].id);
  }

  return { items: items, newestId: newestId };
}

function buildMentionNotification_(acc, items) {
  const lines = ['💬 ' + acc.label + ' に新着 ' + items.length + ' 件', ''];

  items.slice(0, MENTION_NOTIFY_LIMIT).forEach(function (it) {
    lines.push('@' + (it.username || '不明') + (it.name ? '（' + it.name + '）' : ''));
    lines.push(truncate_(it.text, 140));
    if (it.username) {
      lines.push('https://x.com/' + it.username + '/status/' + it.id);
    }

    // 返信案だけ作る。送信は人間が行う（自動返信は実装しない）。
    const draft = buildReplyDraft_(acc.key, it.text);
    if (draft) lines.push('返信案: ' + draft);

    lines.push('');
  });

  if (items.length > MENTION_NOTIFY_LIMIT) {
    lines.push('…ほか ' + (items.length - MENTION_NOTIFY_LIMIT) + ' 件');
    lines.push('');
  }

  lines.push('※返信案はコピー用です。送信はXアプリから行ってください。');
  lines.push('※自動では返信しません（「返信案オフ」で案の生成を止められます）');
  return lines.join('\n');
}

/**
 * メンションへの返信案を1つ作る（P2-20 Human-in-the-loop）。
 *
 * ★AIに送信させない。案を出すところで止める。
 * 自動返信は文脈を取り違えたときに取り返しがつかず、
 * 大量に打てばスパム判定の原因にもなる。判断は人間が持つ。
 *
 * 生成に失敗しても通知自体は出したいので、必ず null を返して続行する。
 *
 * @return {?string} 返信案。無効・失敗時は null
 */
function buildReplyDraft_(accountKey, mentionText) {
  if (getProp_('REPLY_DRAFT', '1') !== '1') return null;
  if (!mentionText || !String(mentionText).trim()) return null;

  try {
    const lang = getLang_(accountKey);
    const out = callLLM_(
      'You draft short replies for a social media account. ' +
      'Reply in ' + (lang === 'ja' ? 'Japanese' : 'English') + '. ' +
      'One or two sentences. Sound like a person, not a brand. ' +
      'Never promise anything. Never include links. Output the reply text only.',
      'Someone replied to our post with:\n"' + truncate_(String(mentionText), 300) + '"\n\n' +
      'Write one reply we could send.');

    const draft = sanitizeGeneratedText_(out);
    return draft ? truncate_(draft, 200) : null;

  } catch (e) {
    console.warn('返信案の生成に失敗（通知は継続）: ' + e);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* トリガー管理                                                        */
/* ------------------------------------------------------------------ */

function mentionCheckHours_() {
  const n = Number(getProp_('MENTION_CHECK_HOURS', String(MENTION_DEFAULT_HOURS))) || MENTION_DEFAULT_HOURS;
  // GASの everyHours は 1〜24 の範囲で扱う
  return Math.min(24, Math.max(1, Math.floor(n)));
}

/** メンション通知を開始する。既存の同名トリガーは置き換える。 */
function setupMentionCheck() {
  const removed = deleteMentionCheck();
  const hours = mentionCheckHours_();

  ScriptApp.newTrigger(MENTION_TRIGGER_HANDLER)
    .timeBased()
    .everyHours(hours)
    .create();

  console.log('メンション通知を開始しました（' + hours + '時間おき）' +
              (removed > 0 ? '（既存 ' + removed + '件を置き換え）' : ''));
  return hours;
}

/** メンション通知を停止する。@return {number} 削除件数 */
function deleteMentionCheck() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === MENTION_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/* ------------------------------------------------------------------ */
/* LINEからの操作                                                      */
/* ------------------------------------------------------------------ */

function handleMentionOnCommand_(replyToken, hours) {
  try {
    if (hours) props_().setProperty('MENTION_CHECK_HOURS', String(hours));
    const h = setupMentionCheck();
    replyToLine_(replyToken,
      '🔔 リプライ通知を開始しました（' + h + '時間おき）。\n\n' +
      '新しいリプライ・メンションが来たらLINEへ転送します。\n' +
      '返信はXアプリから行ってください（自動返信はしません）。\n\n' +
      '⚠️ Xは読み取りにも課金されます。頻度を変えるなら「通知12時間」のように送ってください。\n' +
      '止めるときは「通知オフ」。');
  } catch (err) {
    replyToLine_(replyToken, '❌ 開始に失敗しました。\n' + String(err.message || err));
  }
}

function handleMentionOffCommand_(replyToken) {
  try {
    const removed = deleteMentionCheck();
    replyToLine_(replyToken,
      removed > 0 ? '🔕 リプライ通知を停止しました。' : 'リプライ通知はすでに停止しています。');
  } catch (err) {
    replyToLine_(replyToken, '❌ 停止に失敗しました。\n' + String(err.message || err));
  }
}

/** 「メンション」… 待たずに今すぐ確認する。 */
function handleMentionNowCommand_(replyToken) {
  try {
    let total = 0;
    const details = [];

    Object.keys(ACCOUNTS).forEach(function (key) {
      if (!isAuthorized_(key)) {
        details.push('[' + key + '] 未連携');
        return;
      }
      const sinceKey = 'last_mention_id_' + key;
      const sinceId = getProp_(sinceKey);
      const r = fetchMentions_(key, sinceId);

      if (!r) { details.push('[' + key + '] 取得できませんでした'); return; }
      if (r.newestId) props_().setProperty(sinceKey, r.newestId);

      if (!sinceId) {
        details.push('[' + key + '] 監視の基準を設定しました（次回から差分を通知）');
        return;
      }
      total += r.items.length;
      details.push('[' + key + '] 新着 ' + r.items.length + ' 件');
      if (r.items.length) {
        notifyAdmin_(buildMentionNotification_(getAccount_(key), r.items));
      }
    });

    replyToLine_(replyToken,
      '💬 メンション確認\n\n' + details.join('\n') +
      (total > 0 ? '\n\n内容は別メッセージで送りました。' : ''));

  } catch (err) {
    replyToLine_(replyToken, '❌ 確認に失敗しました。\n' + String(err.message || err));
  }
}
