/**
 * ===========================================================================
 * 15_Metrics.gs  —  投稿後の評価（P2-12 / P2-13 / P2-15 / P2-16）
 * ===========================================================================
 * 投稿した瞬間に分かるのは「何を出したか」だけ。
 * 効いたかどうかは後からしか分からないので、24時間・48時間・7日の
 * 3つのタイミングで測れる構造を先に用意しておく。
 *
 * 【今すぐ埋まる指標と、埋まらない指標がある】
 * インプレッション・プロフィール訪問などは X公式アナリティクスAPIが必要で、
 * 利用には審査が要る。取れないものを前提に設計すると全部が止まるため、
 *   ・自前で確実に取れる = リンククリック（/api/go）
 *   ・審査が通れば取れる = X側の各種指標
 * を分けて扱う。列だけ先に作り、埋められるものから埋める。
 *
 * 【なぜ「投稿数」をKPIにしないか】
 * 投稿数は増やそうと思えばいくらでも増やせるが、それ自体は成果ではない。
 * 追うのは 1投稿あたりの反応と、その先の売上。
 */

const METRICS_SHEET_NAME = 'Metrics';

/** 評価を行う経過時間（時間単位）と、対応するLogの列 */
const METRIC_CHECKPOINTS = [
  { hours: 24,      label: '24h', column: 33 },
  { hours: 48,      label: '48h', column: 34 },
  { hours: 24 * 7,  label: '7d',  column: 35 }
];

/* ------------------------------------------------------------------ */
/* リンククリックの取り込み                                             */
/* ------------------------------------------------------------------ */

/**
 * 自前のリダイレクタ（/api/go）が記録したクリック数を取り込む。
 *
 * ここだけは審査もAPIキーも要らず、今日から確実に測れる。
 * 集計元のURLは CLICK_STATS_URL に入れる。
 * 期待する応答は {"clicks": {"<X Post ID>": 12, ...}} の形。
 *
 * 未設定なら何もしない（設定していない機能でエラーを出さない）。
 *
 * @return {number} 更新した行数
 */
function importLinkClicks() {
  const endpoint = getProp_('CLICK_STATS_URL', '');
  let clicks;

  if (endpoint) {
    // 外部のリダイレクタへ移行した場合だけ、HTTPで取りに行く
    try {
      const res = fetchWithRetry_(endpoint, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        console.warn('クリック集計の取得に失敗 ' + res.getResponseCode());
        return 0;
      }
      clicks = (JSON.parse(res.getContentText()) || {}).clicks || {};
    } catch (e) {
      console.warn('クリック集計の取得に失敗: ' + e);
      return 0;
    }
  } else {
    /*
     * ★未設定なら、自前のリダイレクタ(23_Redirect.gs)から直接読む。
     *
     * 集計しているのは同じスクリプト自身なので、
     * 自分のWebアプリを自分でHTTP取得する意味が無い。
     * 直接呼べば、設定作業・ADMIN_TOKEN・通信失敗・
     * Webアプリの応答待ちがまとめて消える。
     * CLICK_STATS_URL は外部リダイレクタへ移す場合の逃げ道として残す。
     */
    try {
      clicks = buildClickStats_();
    } catch (e) {
      console.warn('クリック集計に失敗: ' + e);
      return 0;
    }
  }

  const ids = Object.keys(clicks);
  if (!ids.length) return 0;

  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateLogSheet_(ss);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const values = sheet.getRange(2, 1, lastRow - 1, LOG_TOTAL_COLUMNS).getValues();
  let updated = 0;

  values.forEach(function (row, i) {
    const postId = String(row[LOG_COL_X_POST_ID - 1] || '');
    if (!postId || !(postId in clicks)) return;
    sheet.getRange(2 + i, LOG_COL_LINK_CLICKS).setValue(Number(clicks[postId]) || 0);
    updated++;
  });

  if (updated) SpreadsheetApp.flush();
  console.log('リンククリックを ' + updated + ' 行に反映しました。');
  return updated;
}

/* ------------------------------------------------------------------ */
/* 評価タイミングの記録                                                 */
/* ------------------------------------------------------------------ */

/**
 * 24時間・48時間・7日を過ぎた投稿に、評価済みの印を付ける。
 *
 * 実際の数値取得はAPI審査が要るため、ここでは
 * 「いつ測ったか」だけを確定させる。後から指標を足すときに、
 * どの行がどの時点のものか分からなくなるのを防ぐ。
 *
 * @return {number} 印を付けた件数
 */
function markMetricCheckpoints() {
  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateLogSheet_(ss);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const values = sheet.getRange(2, 1, lastRow - 1, LOG_TOTAL_COLUMNS).getValues();
  const now = Date.now();
  let marked = 0;

  values.forEach(function (row, i) {
    if (String(row[LOG_COL_STATUS - 1] || '') !== QUEUE_STATUS_POSTED) return;

    const posted = toDateOrNull_(row[LOG_COL_TIMESTAMP - 1]);
    if (!posted) return;
    const elapsedHours = (now - posted.getTime()) / 3600000;

    METRIC_CHECKPOINTS.forEach(function (cp) {
      if (elapsedHours < cp.hours) return;
      if (String(row[cp.column - 1] || '').trim() !== '') return;   // 記録済み
      sheet.getRange(2 + i, cp.column).setValue(new Date());
      marked++;
    });
  });

  if (marked) SpreadsheetApp.flush();
  return marked;
}

/** 1日1回動かす。クリック取り込みと評価印付けをまとめて行う。 */
function runDailyMetrics() {
  // ★processQueue と同じ理由でこのトリガーの認可も将来古くなり得る
  // （マニフェストへ新しいスコープを足した後に作られたトリガーだけが影響を受ける）。
  // 同じ委譲経路（/exec?task=metrics）を使い、投稿トリガー用に作った仕組みを流用する。
  if (!canOpenLogSpreadsheet_()) {
    delegateMetricsToWebApp_();
    return;
  }
  runDailyMetricsCore_();
}

/** 計測本体。トリガーからも、Webアプリへの委譲経由でも、ここに合流する。 */
function runDailyMetricsCore_() {
  try {
    const clicks = importLinkClicks();
    const marked = markMetricCheckpoints();
    const cleanedProps = cleanupOldCountProps_();
    // ★在庫は投稿時にも補充されるが、そこで補充すると投稿の実行時間を食う。
    //   1日1回ここで先回りしておけば、投稿時にはたいてい在庫がある。
    let stockAdded = 0;
    try { stockAdded = topUpAllStock_(); }
    catch (e) { console.warn('在庫の先回り補充に失敗: ' + truncate_(String(e), 120)); }
    console.log('日次計測: クリック更新 ' + clicks + '行 / 評価印 ' + marked + '件 / ' +
                '古いプロパティ削除 ' + cleanedProps + '件 / 動画在庫 +' + stockAdded + '本');
  } catch (e) {
    console.error('日次計測に失敗: ' + e);
    notifyAdmin_('⚠️ 日次計測に失敗しました。\n' + truncate_(String(e), 300));
  }
}

/** processQueue側の delegateQueueToWebApp_ と同じ仕組み。task だけ差し替える。 */
function delegateMetricsToWebApp_() {
  const token = ensureTaskToken_();
  if (!token) return false;   // トークンすら用意できない場合は諦める。次の投稿トリガーが直す

  const url = WEBAPP_EXEC_URL + '?task=metrics&task_token=' + encodeURIComponent(token);
  try {
    UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    return true;
  } catch (e) {
    console.warn('計測の委譲に失敗（次回の投稿トリガーで復旧見込み）: ' + e);
    return false;
  }
}

const METRICS_TRIGGER_HANDLER = 'runDailyMetrics';
const METRICS_ARM_CHECK_PROP = 'metrics_trigger_checked_at';

/**
 * 日次計測トリガーが無ければ作る。
 *
 * processQueue から呼ぶ。processQueue は幽霊トリガー判定を通過した後なので、
 * ここで作られるトリガーは必ず正しいアカウントの持ち物になる。
 * 人が「セットアップ」を実行しなくても、放っておけば計測が始まる。
 *
 * 毎回トリガー一覧を読むのは無駄なので、1日1回だけ確認する。
 */
function ensureDailyMetricsTrigger_() {
  try {
    const last = Number(getProp_(METRICS_ARM_CHECK_PROP, '0')) || 0;
    if ((Date.now() - last) < 24 * 60 * 60 * 1000) return false;
    props_().setProperty(METRICS_ARM_CHECK_PROP, String(Date.now()));

    const exists = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === METRICS_TRIGGER_HANDLER;
    });
    if (exists) return false;

    ScriptApp.newTrigger(METRICS_TRIGGER_HANDLER).timeBased().atHour(6).everyDays(1).create();
    console.log('日次計測トリガーを自動作成しました。');
    return true;
  } catch (e) {
    // 計測は本体ではない。失敗しても投稿処理は続ける。
    console.warn('日次計測トリガーの自動作成に失敗: ' + e);
    return false;
  }
}

/** 日次計測のトリガーを作る。1日1回・朝に動かす。 */
function setupDailyMetrics() {
  deleteDailyMetrics();
  ScriptApp.newTrigger(METRICS_TRIGGER_HANDLER).timeBased().atHour(6).everyDays(1).create();
  console.log('日次計測トリガーを作成しました（毎日6時台）。');
}

function deleteDailyMetrics() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === METRICS_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/* ------------------------------------------------------------------ */
/* 役割別の成績（P2-15 / P2-16）                                        */
/* ------------------------------------------------------------------ */

/**
 * 投稿の役割ごとに、件数とクリック数を集計する。
 *
 * 見たいのは「GitHub紹介が無料層しか集めていないか」。
 * FREE VALUE ばかり伸びて BRIDGE / COMMERCIAL が動いていないなら、
 * 集客はできているが売上に繋がっていない状態なので、比率を変える。
 *
 * ★2026-08-16、accountKeyでの絞り込みを追加した。
 * 元々はA・Bを合算していたため、"SOURCE: 1件" のような数字が
 * どちらのアカウントの実績か判別できなかった。実際にはAが46件・Bが10件
 * 投稿している状態で合算されると、少数派の役割がどちらの成果か
 * 見分けようがなく、AとBを別々に育てている意味が薄れる。
 *
 * @param {Sheet} ss
 * @param {string=} accountKey 省略時は従来どおり全アカウント合算
 * @param {boolean=} todayOnly trueなら本日（Asia/Tokyo）の投稿だけに絞る
 * @return {Object<string,{count:number, clicks:number, withLink:number}>}
 */
function summarizeByRole_(ss, accountKey, todayOnly) {
  const out = {};
  const sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) return out;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;

  const width = Math.min(LOG_TOTAL_COLUMNS, sheet.getLastColumn());
  if (width < LOG_COL_POST_ROLE) return out;   // 役割列がまだ無い

  const filterKey = accountKey ? String(accountKey).toUpperCase() : '';
  const todayKey = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  values.forEach(function (row) {
    if (String(row[LOG_COL_STATUS - 1] || '') !== QUEUE_STATUS_POSTED) return;
    if (filterKey && String(row[LOG_COL_ACCOUNT - 1] || '').toUpperCase() !== filterKey) return;

    if (todayOnly) {
      const ts = toDateOrNull_(row[LOG_COL_TIMESTAMP - 1]);
      const isToday = !!ts && Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy-MM-dd') === todayKey;
      if (!isToday) return;
    }

    const role = String(row[LOG_COL_POST_ROLE - 1] || '').trim() || '(未分類)';
    if (!out[role]) out[role] = { count: 0, clicks: 0, withLink: 0 };
    out[role].count++;
    if (String(row[LOG_COL_HAS_LINK - 1] || '') === 'URL') out[role].withLink++;
    if (width >= LOG_COL_LINK_CLICKS) {
      out[role].clicks += Number(row[LOG_COL_LINK_CLICKS - 1] || 0) || 0;
    }
  });

  return out;
}

/**
 * 状態表示用。役割ごとの件数とクリックを数行にまとめる。
 *
 * ★2026-08-16、「本日」の内訳を追加した。
 * 月間の累計だけだと、直したばかりの不具合が実際に効いているかを
 * 判定できない。1ヶ月ぶんの実績に対して当日ぶんは数件しかなく、
 * 変化があっても累計の比率にはほとんど表れない
 * （実例：修正を跨いだ1ヶ月分の中で SOURCE がわずか1件のように見えても、
 * それが「今日直った直後の1件」なのか「直す前からある1件」なのか、
 * 累計だけでは区別できない）。当日ぶんを別枠で出し、直った/直っていない
 * を当日のうちに判断できるようにする。
 *
 * @param {Sheet} ss
 * @param {string=} accountKey 省略時は従来どおり全アカウント合算（後方互換）
 */
function buildRoleSummaryText_(ss, accountKey) {
  let roles;
  try {
    roles = summarizeByRole_(ss, accountKey);
  } catch (e) {
    return '';
  }

  const keys = Object.keys(roles);
  if (!keys.length) return '';

  const total = keys.reduce(function (n, k) { return n + roles[k].count; }, 0);
  const lines = ['\n【投稿の役割配分' + (accountKey ? '（' + accountKey + '）' : '') + '】'];

  keys.sort(function (a, b) { return roles[b].count - roles[a].count; }).forEach(function (k) {
    const r = roles[k];
    const pct = total ? Math.round(r.count / total * 100) : 0;
    lines.push('  ' + k + ': ' + r.count + '件 (' + pct + '%)' +
               (r.clicks ? ' / クリック ' + r.clicks : ''));
  });

  const clicksKnown = keys.some(function (k) { return roles[k].clicks > 0; });
  if (!clicksKnown) {
    lines.push('  ※クリック数は CLICK_STATS_URL を設定すると入ります');
  }

  let todayRoles = {};
  try { todayRoles = summarizeByRole_(ss, accountKey, true); } catch (e) {}
  const todayKeys = Object.keys(todayRoles);
  if (todayKeys.length) {
    const todayTotal = todayKeys.reduce(function (n, k) { return n + todayRoles[k].count; }, 0);
    lines.push('  本日(' + todayTotal + '件): ' +
      todayKeys.sort(function (a, b) { return todayRoles[b].count - todayRoles[a].count; })
        .map(function (k) { return k + ' ' + todayRoles[k].count + '件'; })
        .join(' / '));
  }

  return lines.join('\n');
}

/** エディタから役割別の成績を確認する。 */
function showRoleSummary() {
  console.log(buildRoleSummaryText_(openLogSpreadsheet_()) || '集計できるデータがまだありません。');
}
