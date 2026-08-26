/**
 * ===========================================================================
 * 08_Bootstrap.gs  —  初期構築の自動化
 * ===========================================================================
 * bootstrap() を1回実行するだけで、以下を自動で行う。
 *   1. スプレッドシートの作成（既にあれば再利用）
 *   2. Queue / Links / Log タブの作成とヘッダー設定
 *   3. LOG_SPREADSHEET_ID のスクリプトプロパティ登録
 *   4. 2時間おきの自動投稿トリガー作成
 *   5. 不足している設定の洗い出しと報告
 *
 * 何度実行しても安全（冪等）。既にあるものは作り直さない。
 *
 * ※ APIキー類だけは本人しか用意できないため、ここでは登録できない。
 *   実行結果に不足分が一覧で出るので、それを見て手で埋める。
 */

const BOOTSTRAP_SHEET_TITLE = 'X Auto Post — Queue';

const SHEET_SPECS = [
  { name: QUEUE_SHEET_NAME, headers: QUEUE_HEADERS },
  { name: LINKS_SHEET_NAME, headers: ['URL', 'Note', 'Target'] },
  { name: LOG_SHEET_NAME,   headers: LOG_HEADERS }
];

/**
 * ★これを1回実行すれば初期構築が完了する。
 */
/**
 * 構築処理の本体。エディタからも、LINE（Webアプリ）からも呼べるようにしてある。
 *
 * ★どのアカウントで実行するかが決定的に重要。
 * GASは実行場所ごとに実行主体が変わり、しかもトリガーは「作成したアカウント」として動く。
 * さらに ScriptApp.getProjectTriggers() は自分が作ったトリガーしか返さないため、
 * 別アカウントが作ったトリガーは一覧にも出ず削除もできない。
 *
 * そのため、スプレッドシート作成もトリガー作成も
 * 「Webアプリと同じ実行主体＝スクリプト所有者」で行うのが唯一の安全な運用になる。
 * LINEの「セットアップ」から実行すれば必ずその条件を満たす。
 *
 * @return {string} 実行レポート
 */
function runBootstrap_() {
  const me = getEffectiveUserEmail_();
  const report = ['🚀 初期構築を開始します', ''];

  // 実行主体を最初に出す。ここがWebアプリ／トリガーの実行主体とずれると、
  // 「作れたのに開けない」という状態になる。
  report.push('【実行アカウント】' + (me || '(取得不可)'));
  report.push('  ※このアカウントのドライブにシートが作られます。');
  report.push('  ※スクリプト所有者と違うアカウントで実行すると、');
  report.push('    LINEからシートを読めなくなります。');
  report.push('');

  // --- 1. スプレッドシート ---------------------------------------------
  let ss = null;
  const existingId = getProp_('LOG_SPREADSHEET_ID');

  if (existingId) {
    try {
      ss = SpreadsheetApp.openById(existingId);
      report.push('【スプレッドシート】既存のものを使用します');
    } catch (e) {
      report.push('【スプレッドシート】LOG_SPREADSHEET_ID のシートを開けませんでした。新規作成します');
      report.push('  （開けなかったID: ' + existingId + '）');
      ss = null;
    }
  }

  if (!ss) {
    try {
      ss = SpreadsheetApp.create(BOOTSTRAP_SHEET_TITLE);
      props_().setProperty('LOG_SPREADSHEET_ID', ss.getId());
      report.push('【スプレッドシート】新規作成しました');
      report.push('  LOG_SPREADSHEET_ID を自動登録済み');
    } catch (err) {
      report.push('❌ スプレッドシートの作成に失敗しました: ' + (err && err.message ? err.message : err));
      report.push('   手動でスプレッドシートを作り、そのIDを LOG_SPREADSHEET_ID に登録してから再実行してください。');
      return report.join('\n');
    }
  }

  report.push('  名前: ' + ss.getName());
  report.push('  URL : ' + ss.getUrl());
  report.push('');

  // --- 2. タブとヘッダー -----------------------------------------------
  report.push('【タブ】');
  SHEET_SPECS.forEach(function (spec) {
    const created = ensureSheetWithHeaders_(ss, spec.name, spec.headers);
    // 既存シートに後から追加した列を足す（既存ヘッダーとデータは書き換えない）
    const added = ensureTrailingHeaders_(ss.getSheetByName(spec.name), spec.headers);
    report.push('  ' + (created ? '＋作成' : '✓既存') + ' ' + spec.name +
                (added > 0 ? '（列を' + added + '個追加）' : ''));
  });

  // SpreadsheetApp.create() が作る初期タブ。空なら邪魔なので消す。
  removeDefaultEmptySheet_(ss, report);
  report.push('');

  // --- 3. トリガー -------------------------------------------------------
  report.push('【自動投稿トリガー】');
  try {
    const removed = deleteAutoPost();
    ScriptApp.newTrigger(QUEUE_TRIGGER_HANDLER)
      .timeBased()
      .everyHours(QUEUE_TRIGGER_INTERVAL_HOURS)
      .create();
    // 誰が作ったトリガーかを記録する。別アカウントの幽霊トリガー検出に使う。
    rememberQueueTriggerOwner_();
    report.push('  ✅ ' + QUEUE_TRIGGER_INTERVAL_HOURS + '時間おきに ' +
                QUEUE_TRIGGER_HANDLER + ' を実行するよう設定しました' +
                (removed > 0 ? '（既存 ' + removed + '件を置き換え）' : ''));
    report.push('  実行アカウントとして ' + (me || '(取得不可)') + ' を登録しました');
  } catch (err) {
    report.push('  ❌ トリガーの作成に失敗: ' + (err && err.message ? err.message : err));
  }
  report.push('  ※ここで表示・削除できるのは、この実行アカウントが作ったトリガーだけです。');
  report.push('    別アカウントで作ったトリガーは見えず、裏で動き続けます。');

  // 日次計測（クリック取り込みと24h/48h/7dの評価印）
  try {
    setupDailyMetrics();
    report.push('  ✅ 日次計測トリガーを設定しました（毎日6時台）');
  } catch (err) {
    report.push('  ⚠️ 日次計測トリガーの設定に失敗: ' + (err && err.message ? err.message : err));
  }
  report.push('');

  // --- 4. 設定の充足チェック ---------------------------------------------
  report.push(buildBootstrapChecklist_());

  return report.join('\n');
}

/** エディタから実行する用。ログに出す。 */
function bootstrap() {
  console.log(runBootstrap_());
}

/**
 * 指定名のシートを用意し、1行目にヘッダーを入れる。
 * @return {boolean} 新規作成したなら true
 */
function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  const created = !sheet;
  if (created) sheet = ss.insertSheet(name);

  // 既存シートのヘッダーは上書きしない。手で列名を変えている場合を壊さないため。
  const firstCell = sheet.getRange(1, 1).getValue();
  if (created || String(firstCell || '').trim() === '') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return created;
}

/** SpreadsheetApp.create() が自動生成する空の初期タブを削除する。 */
function removeDefaultEmptySheet_(ss, report) {
  const known = SHEET_SPECS.map(function (s) { return s.name; });
  ss.getSheets().forEach(function (sheet) {
    const name = sheet.getName();
    if (known.indexOf(name) !== -1) return;
    // データが入っているタブは触らない
    if (sheet.getLastRow() > 0 || sheet.getLastColumn() > 0) return;
    if (ss.getSheets().length <= 1) return;   // 最後の1枚は消せない
    try {
      ss.deleteSheet(sheet);
      report.push('  －削除 ' + name + '（空の初期タブ）');
    } catch (e) {
      // 消せなくても実害はない
    }
  });
}

/** 不足している設定を洗い出す。 */
function buildBootstrapChecklist_() {
  const lines = ['【残りの設定】'];
  const missing = [];

  const need = [
    { key: 'APP_A_CLIENT_ID',           label: 'X アプリの Client ID' },
    { key: 'APP_A_CLIENT_SECRET',       label: 'X アプリの Client Secret' },
    { key: 'APP_B_CLIENT_ID',           label: 'X アプリの Client ID（B）' },
    { key: 'APP_B_CLIENT_SECRET',       label: 'X アプリの Client Secret（B）' },
    { key: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'LINE チャネルアクセストークン' }
  ];
  need.forEach(function (n) {
    if (!getProp_(n.key)) missing.push('  ❌ ' + n.key + ' … ' + n.label);
  });

  // Geminiキーはどちらの名前でも可
  if (!getProp_('GEMINI_API_KEY') && !getProp_('LLM_API_KEY')) {
    missing.push('  ❌ GEMINI_API_KEY … https://aistudio.google.com/apikey で発行');
    missing.push('     ※ {AUTO} による自動生成を使う場合のみ必要');
  }

  if (missing.length) {
    lines.push('  以下がまだ設定されていません。');
    lines.push('  [プロジェクトの設定] → [スクリプト プロパティ] から登録してください。');
    lines.push('');
    missing.forEach(function (m) { lines.push(m); });
  } else {
    lines.push('  ✅ 必要なプロパティは全て設定済みです。');
  }

  lines.push('');
  lines.push('【連携状況】');
  Object.keys(ACCOUNTS).forEach(function (key) {
    const ok = isAuthorized_(key);
    const name = getStoredUsername_(key);
    lines.push('  ' + (ok ? '✅' : '❌') + ' ' + key + ': ' +
      (ok ? '連携済' + (name ? '（@' + name + '）' : '') : '未連携 → LINEで「Xリンク ' + key + '」'));
  });

  lines.push('');
  lines.push('【次にやること】');
  lines.push('  1. 上の❌があれば埋める');
  lines.push('  2. listAvailableModels を実行し、使えるモデル名を LLM_MODEL に設定');
  lines.push('  3. testGenerateA5 を実行して生成文を確認（投稿・課金なし）');
  lines.push('  4. Queueシートに1行入れて processQueue を手動実行');
  lines.push('  5. 問題なければ放置。2時間おきに自動投稿されます');
  return lines.join('\n');
}

/**
 * ★これ1つで「構築 → キュー投入 → 実際に1件投稿」まで通す。
 * 手作業を最小にしたい場合はこれを実行する。
 *
 * 注意: 最後に実際の投稿を1件行う。Xのクレジットを消費する。
 */
function startEngine() {
  const report = ['⚡ エンジン起動シーケンス', ''];

  // --- 1. 構築（未実施なら実施。実施済みなら何も壊さない）-----------------
  bootstrap();
  report.push('【1】構築 … 完了（詳細は直前のログ）');

  // --- 2. 前提チェック ---------------------------------------------------
  const hasLlmKey = !!(getProp_('GEMINI_API_KEY') || getProp_('LLM_API_KEY'));
  const linkedA = isAuthorized_('A');
  const linkedB = isAuthorized_('B');

  if (!linkedA && !linkedB) {
    report.push('', '❌ A・Bとも未連携です。LINEで「Xリンク A」から連携してください。');
    console.log(report.join('\n'));
    return;
  }
  const target = linkedA ? 'A' : 'B';
  report.push('【2】投稿先 … ' + target + '（連携済みのアカウント）');

  // --- 3. キュー投入 -----------------------------------------------------
  const sheet = getQueueSheet_();
  let pending = findNextPendingRow_(sheet);

  if (pending) {
    report.push('【3】キュー … 既に未投稿の行があるので、それを使います（' +
                pending.rowIndex + '行目）');
  } else if (hasLlmKey) {
    fillQueue(1, target);
    report.push('【3】キュー … ' + AUTO_TAG + ' 行を1件追加しました（AIが本文を生成します）');
  } else {
    // Geminiキーが無い場合は固定文で通す。時刻を入れて重複ブロックを回避する。
    const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d HH:mm');
    sheet.appendRow([target, '接続テスト ' + stamp, '', '', '']);
    SpreadsheetApp.flush();
    report.push('【3】キュー … GEMINI_API_KEY が無いため、固定文のテスト行を追加しました');
  }

  // --- 4. 実行 -----------------------------------------------------------
  report.push('【4】投稿を実行します…');
  console.log(report.join('\n'));

  processQueue();

  // --- 5. 結果 -----------------------------------------------------------
  const after = [];
  const lastRow = sheet.getLastRow();
  if (lastRow >= QUEUE_FIRST_DATA_ROW) {
    const v = sheet.getRange(lastRow, 1, 1, 5).getValues()[0];
    after.push('', '【5】結果（Queue ' + lastRow + '行目）');
    after.push('  Status: ' + (v[QUEUE_COL_STATUS - 1] || '(空)'));
    after.push('  投稿文: ' + truncate_(String(v[QUEUE_COL_POSTED_TEXT - 1] || v[QUEUE_COL_CONTENT - 1] || ''), 200));
  }

  after.push('', '【次】自動投稿は2時間おきに動きます。');
  after.push('  行を足さずに回し続けたい場合は、スクリプトプロパティに');
  after.push('    AUTO_REFILL_A = 3   （Aへ毎回3件ずつ自動補充）');
  after.push('  のように設定してください。');
  after.push('  ⚠ 併せて MONTHLY_SOFT_CAP を設定してください。');
  after.push('    未設定だと上限なしでXのクレジットを消費し続けます。');

  console.log(after.join('\n'));
}

/**
 * LOG_SPREADSHEET_ID を消して、次の bootstrap でシートを作り直せるようにする。
 *
 * 別アカウントで作ってしまい、Webアプリ／トリガーから開けなくなった場合の復旧用。
 * 既存のシート自体は削除しない（中身が必要ならドライブから手で移せる）。
 */
function resetSpreadsheetId() {
  const old = getProp_('LOG_SPREADSHEET_ID');
  props_().deleteProperty('LOG_SPREADSHEET_ID');
  console.log([
    'LOG_SPREADSHEET_ID を削除しました。',
    old ? '  削除した値: ' + old : '  （元々未設定でした）',
    '',
    '実行アカウント: ' + (getEffectiveUserEmail_() || '(取得不可)'),
    '',
    'このまま bootstrap を実行すると、上記アカウントのドライブに',
    'シートが新規作成され、IDが登録し直されます。',
    '※必ずスクリプト所有者のアカウントで実行してください。'
  ].join('\n'));
}

/** 構築状況をもう一度確認したいとき用。何も変更しない。 */
function showBootstrapStatus() {
  const lines = ['🔎 構築状況', '',
                 '【実行アカウント】' + (getEffectiveUserEmail_() || '(取得不可)'), ''];

  const id = getProp_('LOG_SPREADSHEET_ID');
  if (!id) {
    lines.push('【スプレッドシート】❌ 未設定。bootstrap を実行してください');
  } else {
    try {
      const ss = SpreadsheetApp.openById(id);
      lines.push('【スプレッドシート】✅ ' + ss.getName());
      lines.push('  ' + ss.getUrl());
      SHEET_SPECS.forEach(function (spec) {
        const sheet = ss.getSheetByName(spec.name);
        lines.push('  ' + (sheet ? '✅' : '❌') + ' ' + spec.name +
          (sheet ? '（' + Math.max(0, sheet.getLastRow() - 1) + '行）' : ''));
      });
    } catch (e) {
      lines.push('【スプレッドシート】❌ 開けません（ID: ' + id + '）');
    }
  }
  lines.push('');

  let triggers = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === QUEUE_TRIGGER_HANDLER) triggers++;
  });
  lines.push('【トリガー】' + (triggers > 0 ? '✅ 稼働中（' + triggers + '件）' : '❌ 未設定'));
  lines.push('');
  lines.push(buildBootstrapChecklist_());

  console.log(lines.join('\n'));
}
