/**
 * ===========================================================================
 * 12_Integrity.gs  —  二重投稿防止・追跡・コスト管理の土台（P0）
 * ===========================================================================
 * ここに集めた関数は「同じものを2回Xへ送らない」ことだけを目的にしている。
 * 投稿処理そのものからは独立させ、単体で検証できるようにしてある。
 *
 * 【なぜ複数の防御が必要か】
 * 二重投稿は経路が多い。1つの対策では塞ぎきれない。
 *   1. LINEのWebhook再送        → イベントIDの記録（24時間）
 *   2. Gemini再生成・手動実行   → コンテンツハッシュ（30日）
 *   3. 投稿後にGASが停止        → Queueの UNKNOWN 状態（自動再送を禁止）
 *   4. 5xx時の自動リトライ      → 投稿APIではリトライしない
 * どれか1つが漏れても、別の層で止まるようにしている。
 */

/* ------------------------------------------------------------------ */
/* コンテンツハッシュ                                                   */
/* ------------------------------------------------------------------ */

/** ハッシュを覚えておく期間。これを過ぎた投稿は再投稿を許す。 */
const HASH_HISTORY_DAYS = 30;

/** 1アカウントあたりの保持件数。スクリプトプロパティの容量制限(9KB/値)を守るため。 */
const HASH_HISTORY_MAX = 150;

function hashHistoryKey_(accountKey) {
  return 'posted_hashes_' + String(accountKey).toUpperCase();
}

/**
 * 投稿本文を、表記ゆれを無視した比較用の形に整える。
 *
 * URLは本文から抜く。同じ文章でリンクだけ差し替えたものを
 * 「別の投稿」と数えたいので、URLはハッシュの別要素として渡す。
 */
function normalizeForHash_(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * アカウント + 正規化本文 + URL からハッシュを作る。
 * @return {string} 32文字の16進文字列
 */
function contentHash_(accountKey, text, url) {
  const raw = String(accountKey || '').toUpperCase() + '\n' +
              normalizeForHash_(text) + '\n' +
              String(url || '').trim();
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);

  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
  }
  return hex.slice(0, 32);
}

/** 保存済み履歴を [hash, epochMs] の配列で読む。壊れていたら空で返す。 */
function readHashHistory_(accountKey) {
  try {
    const raw = getProp_(hashHistoryKey_(accountKey), '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('ハッシュ履歴の読み込みに失敗（空として扱う）: ' + e);
    return [];
  }
}

/**
 * 同じ内容を最近投稿していないか調べる。
 * @return {boolean} true なら重複（投稿してはいけない）
 */
function isDuplicateContentHash_(accountKey, hash) {
  if (!hash) return false;
  const limit = Date.now() - HASH_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return readHashHistory_(accountKey).some(function (row) {
    return row && row[0] === hash && Number(row[1]) >= limit;
  });
}

/** 投稿に成功したハッシュを記録する。古いものと溢れた分は捨てる。 */
function rememberContentHash_(accountKey, hash) {
  if (!hash) return;
  try {
    const limit = Date.now() - HASH_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const kept = readHashHistory_(accountKey)
      .filter(function (row) { return row && Number(row[1]) >= limit && row[0] !== hash; });

    kept.unshift([hash, Date.now()]);
    props_().setProperty(hashHistoryKey_(accountKey),
                         JSON.stringify(kept.slice(0, HASH_HISTORY_MAX)));
  } catch (e) {
    // 記録に失敗しても投稿自体は成功している。次回の重複判定が甘くなるだけ。
    console.warn('ハッシュ履歴の記録に失敗: ' + e);
  }
}

/* ------------------------------------------------------------------ */
/* LINEイベントIDの永続的な重複排除                                     */
/* ------------------------------------------------------------------ */

/**
 * CacheService は最大6時間で、しかも容量都合でいつ消えてもよい仕様。
 * 消えた直後に再送が来ると素通りしてしまうため、
 * スクリプトプロパティ側にも24時間ぶんを持たせて二段構えにする。
 */
const EVENT_HISTORY_HOURS = 24;
const EVENT_HISTORY_MAX = 150;
const EVENT_HISTORY_PROP = 'seen_webhook_events';

function readEventHistory_() {
  try {
    const raw = getProp_(EVENT_HISTORY_PROP, '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * このイベントIDを過去24時間に処理済みか調べ、未処理なら記録する。
 * @return {boolean} true なら「初めて見るイベント」（処理してよい）
 */
function markEventProcessedPersistent_(webhookEventId) {
  if (!webhookEventId) return true;
  try {
    const limit = Date.now() - EVENT_HISTORY_HOURS * 60 * 60 * 1000;
    const history = readEventHistory_()
      .filter(function (row) { return row && Number(row[1]) >= limit; });

    const seen = history.some(function (row) { return row[0] === webhookEventId; });
    if (seen) return false;

    history.unshift([webhookEventId, Date.now()]);
    props_().setProperty(EVENT_HISTORY_PROP,
                         JSON.stringify(history.slice(0, EVENT_HISTORY_MAX)));
    return true;
  } catch (e) {
    // 判定できない場合は通す。ここで止めるとLINEが一切効かなくなる。
    console.warn('イベント履歴の記録に失敗（処理は継続）: ' + e);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* X APIコストの見積り                                                  */
/* ------------------------------------------------------------------ */

/**
 * 1投稿あたりの単価はコードに書かない。
 *
 * Xの従量課金は改定され得るし、公式に自動取得する手段が無い。
 * 値を焼き込むと、古い数字を根拠に判断を誤る。
 * スクリプトプロパティに入っている時だけ「参考値」として集計し、
 * 未設定なら金額を出さずに件数だけ見せる。
 *
 * 実際の残高と使用量は X Developer Console を正とすること。
 *   X_COST_TEXT_POST … URLなし投稿1件の参考単価
 *   X_COST_URL_POST  … URLあり投稿1件の参考単価
 *   X_COST_READ      … 読み取り1件の参考単価（メンション取得など）
 */
function xCostProp_(name) {
  const raw = getProp_(name, '');
  if (raw === null || raw === '') return null;   // 未設定と 0 は区別する
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

/**
 * 投稿1件の参考コスト。単価が未設定なら null を返す（0円ではない）。
 * @param {boolean} hasLink URLを含む投稿か
 * @return {?number}
 */
function estimateXPostCost_(hasLink) {
  return xCostProp_(hasLink ? 'X_COST_URL_POST' : 'X_COST_TEXT_POST');
}


/** 本文にURLが含まれるか。Log上でURL投稿と通常投稿を分けるために使う。 */
function containsLink_(text) {
  return /https?:\/\/\S+/.test(String(text || ''));
}

/**
 * セルの値を日付として読む。読めなければ null。
 *
 * instanceof Date だけで判定すると、人が手で「2026/8/15」と打ち直した行や
 * 書式が文字列になっている行を「時刻なし」と誤認する。
 * 復旧処理はこの判定で挙動が変わるため、文字列も受け付ける。
 */
function toDateOrNull_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v.getTime === 'function') {       // 別realmのDate対策
    const t = v.getTime();
    return isNaN(t) ? null : new Date(t);
  }
  const parsed = new Date(v);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * LLMの応答から JSON 部分だけを取り出す。
 *
 * 「JSONだけ返せ」と指示しても、コードフェンスや前置きが付くことがある。
 * 素の JSON.parse に渡すと落ちるので、最初の { から最後の } までを抜く。
 * 見つからなければ元の文字列をそのまま返す（呼び出し側で失敗させる）。
 */
function extractJson_(text) {
  let s = String(text || '').trim();

  // ```json ... ``` を剥がす
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start, end + 1);
}

/* ------------------------------------------------------------------ */
/* Logの集計                                                            */
/* ------------------------------------------------------------------ */

/** 集計で読むLogの最大行数。無制限にすると行数が増えるほど遅くなる。 */
const LOG_SCAN_MAX_ROWS = 2000;

/**
 * Logシートから、当日ぶんと累計の投稿件数・推定コストを数える。
 *
 * 単価が未設定なら金額は null のまま返す。
 * 「0円」と表示すると、コストが掛かっていないと誤解させるため。
 *
 * @return {{today:{text:number,url:number,cost:?number},
 *           total:{text:number,url:number,cost:?number}, scanned:number}}
 */
function summarizePostCosts_(ss) {
  const empty = { text: 0, url: 0, cost: null };
  const result = {
    today: Object.assign({}, empty),
    total: Object.assign({}, empty),
    scanned: 0
  };

  let sheet;
  try {
    sheet = ss.getSheetByName(LOG_SHEET_NAME);
  } catch (e) {
    return result;
  }
  if (!sheet) return result;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;

  const startRow = Math.max(2, lastRow - LOG_SCAN_MAX_ROWS + 1);
  const numRows = lastRow - startRow + 1;
  const width = Math.min(LOG_TOTAL_COLUMNS, sheet.getLastColumn());
  if (width < LOG_COL_STATUS) return result;

  const values = sheet.getRange(startRow, 1, numRows, width).getValues();
  const todayKey = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  values.forEach(function (row) {
    if (String(row[LOG_COL_STATUS - 1] || '') !== QUEUE_STATUS_POSTED) return;
    result.scanned++;

    // Has Link 列がまだ無い古い行は、本文から判定する
    const marker = width >= LOG_COL_HAS_LINK ? String(row[LOG_COL_HAS_LINK - 1] || '') : '';
    const isUrl = marker ? (marker === 'URL') : containsLink_(row[3]);

    const rawCost = width >= LOG_COL_COST ? row[LOG_COL_COST - 1] : '';
    const cost = (rawCost === '' || rawCost === null || isNaN(Number(rawCost)))
      ? null : Number(rawCost);

    const ts = toDateOrNull_(row[LOG_COL_TIMESTAMP - 1]);
    const isToday = !!ts &&
      Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy-MM-dd') === todayKey;

    [result.total].concat(isToday ? [result.today] : []).forEach(function (bucket) {
      if (isUrl) bucket.url++; else bucket.text++;
      if (cost !== null) bucket.cost = (bucket.cost || 0) + cost;
    });
  });

  return result;
}

/** 状態表示用に、コスト集計を数行の文字列へ整える。 */
function buildCostSummaryText_(ss) {
  let s;
  try {
    s = summarizePostCosts_(ss);
  } catch (e) {
    return '\n【投稿コスト】集計できません: ' + truncate_(String(e), 120);
  }

  const line = function (label, b) {
    return '  ' + label + ': 通常 ' + b.text + ' / URL付 ' + b.url +
           '（推定 ' + (b.cost === null ? '単価未設定' : b.cost) + '）';
  };

  const out = ['\n【投稿コスト】（Log直近' + LOG_SCAN_MAX_ROWS + '行より）'];
  out.push(line('本日', s.today));
  out.push(line('累計', s.total));
  if (s.total.cost === null) {
    out.push('  ※単価は X_COST_TEXT_POST / X_COST_URL_POST に設定すると表示されます');
  }
  out.push('  ※金額は参考値。実残高は X Developer Console で確認してください');
  return out.join('\n');
}
