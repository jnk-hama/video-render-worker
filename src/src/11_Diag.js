/**
 * ===========================================================================
 * 11_Diag.gs  —  調査専用。既存の動作には一切影響しない
 * ===========================================================================
 * 目的：2時間おきのトリガー実行だけが
 *   「LOG_SPREADSHEET_ID のスプレッドシートを開けません」
 * で失敗する原因を、推測ではなく実測で特定する。
 *
 * 【このファイルの制約】
 * - 既存関数を一切書き換えない。読むだけ・出すだけ。
 * - 投稿もしない。X API も LLM も呼ばない。
 * - スプレッドシートの共有設定も変更しない（人間が判断する）。
 *
 * 【重要：どこで実行するかで結果が変わる】
 * GAS の実行主体は3系統あり、それぞれ別のGoogleアカウントになり得る。
 *   エディタ実行  … 今ログインしているアカウント
 *   Webアプリ実行 … スクリプト所有者（executeAs: USER_DEPLOYING のため）
 *   トリガー実行  … そのトリガーを作成したアカウント
 * 今回の症状は「Webアプリからは開ける／トリガーからは開けない」なので、
 * エディタで実行しただけでは犯人は映らない可能性が高い。
 * diag_installOneShot() で「トリガーとして」走らせた結果まで取ること。
 */

/* ------------------------------------------------------------------ */
/* 1. 実行主体とスプレッドシートアクセスの実測                          */
/* ------------------------------------------------------------------ */

/**
 * 今この実行がどのアカウントで走っていて、
 * そのアカウントから LOG_SPREADSHEET_ID が本当に開けるのかを出す。
 * 例外は握りつぶさず、生のメッセージをそのまま表示する
 * （openLogSpreadsheet_() は自前の文言に差し替えてしまい、原因が消える）。
 *
 * @return {string} レポート本文（ログにも出すが、戻り値でも使える）
 */
function diag_checkExecutionIdentity() {
  const lines = ['===== 実行主体とシートアクセスの診断 =====', ''];

  // --- 実行主体 ---------------------------------------------------------
  let effective = '', active = '';
  try { effective = Session.getEffectiveUser().getEmail() || '(空)'; }
  catch (e) { effective = '(取得不可: ' + e + ')'; }
  try { active = Session.getActiveUser().getEmail() || '(空)'; }
  catch (e) { active = '(取得不可: ' + e + ')'; }

  lines.push('EffectiveUser（実際にAPIを叩く主体）: ' + effective);
  lines.push('ActiveUser  （起動した人・出ないことが多い）: ' + active);
  lines.push('タイムゾーン: ' + Session.getScriptTimeZone());
  lines.push('');

  // --- プロパティの実値 --------------------------------------------------
  // ★ LOG_SPREADSHEET_ID は「プロパティ名の文字列」であって定数ではない。
  //   Logger.log(LOG_SPREADSHEET_ID) と書くと ReferenceError で落ちる。
  const id = getProp_('LOG_SPREADSHEET_ID');
  lines.push('LOG_SPREADSHEET_ID = ' + (id ? id + '（' + id.length + '文字）' : '❌ 未設定'));
  lines.push('');

  if (!id) {
    lines.push('→ プロパティ自体が空。この実行主体からはスクリプトプロパティが');
    lines.push('  読めていない可能性もある（別プロジェクトを実行している等）。');
    console.log(lines.join('\n'));
    return lines.join('\n');
  }

  // --- 開けるかどうかを実際に試す ---------------------------------------
  lines.push('--- SpreadsheetApp.openById() ---');
  try {
    const ss = SpreadsheetApp.openById(id);
    lines.push('✅ 開けた');
    lines.push('  名前: ' + ss.getName());
    lines.push('  URL : ' + ss.getUrl());
    lines.push('  タブ: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(' / '));
  } catch (e) {
    lines.push('❌ 開けない');
    lines.push('  生のエラー: ' + (e && e.message ? e.message : String(e)));
    lines.push('  ※この生メッセージが決め手になる。');
    lines.push('    「見つかりません」= そのアカウントに共有されていない or ID違い');
    lines.push('    「権限がありません」= 共有はされているが権限不足');
  }
  lines.push('');

  // --- Drive 側からも確認 ------------------------------------------------
  // マニフェストのスコープは drive.file のため、スクリプトが作ったファイル
  // 以外では失敗し得る。失敗しても診断としては情報になる。
  lines.push('--- DriveApp.getFileById() ---');
  try {
    const f = DriveApp.getFileById(id);
    lines.push('✅ 参照できた');
    lines.push('  ファイル名: ' + f.getName());
    try { lines.push('  オーナー  : ' + f.getOwner().getEmail()); }
    catch (e2) { lines.push('  オーナー  : (取得不可: ' + e2 + ')'); }
    try { lines.push('  自分の権限: ' + f.getAccess(effective)); }
    catch (e3) { lines.push('  自分の権限: (取得不可: ' + e3 + ')'); }
  } catch (e) {
    lines.push('❌ 参照できない: ' + (e && e.message ? e.message : String(e)));
    lines.push('  ※ drive.file スコープの制限でも失敗するため、');
    lines.push('    これ単体では権限不足の証拠にならない。');
  }
  lines.push('');

  // --- この実行主体から見えるトリガー -------------------------------------
  lines.push('--- この実行主体が作成したトリガー ---');
  lines.push('※ ScriptApp.getProjectTriggers() は「自分が作った分」しか返さない。');
  lines.push('  ここが0件なのに投稿が動いているなら、別アカウントのトリガーが存在する。');
  try {
    const triggers = ScriptApp.getProjectTriggers();
    if (!triggers.length) {
      lines.push('  0件');
    } else {
      triggers.forEach(function (t) {
        lines.push('  - ' + t.getHandlerFunction() +
                   ' / ' + t.getEventType() +
                   ' / uid=' + t.getUniqueId());
      });
    }
  } catch (e) {
    lines.push('  取得不可: ' + e);
  }

  const out = lines.join('\n');
  console.log(out);
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 「トリガーとして」走らせるための一発トリガー                       */
/* ------------------------------------------------------------------ */

/** 一発診断トリガーが呼ぶ関数名。 */
const DIAG_ONESHOT_HANDLER = 'diag_oneShotRun';

/**
 * 1分後に diag_oneShotRun を1回だけ実行するトリガーを作る。
 *
 * ★注意：これは「今このコードを実行しているアカウント」が作るトリガーになる。
 * つまり、これで分かるのは
 *   「このアカウントが作ったトリガーからはシートが開けるのか」
 * であって、既に裏で動いている謎トリガーの主体は分からない。
 * 両方の結果を突き合わせることで、犯人が別アカウントかどうかを切り分ける。
 */
function diag_installOneShot() {
  diag_deleteOneShot();
  ScriptApp.newTrigger(DIAG_ONESHOT_HANDLER)
    .timeBased()
    .after(60 * 1000)
    .create();
  console.log([
    '1分後に ' + DIAG_ONESHOT_HANDLER + ' がトリガーとして1回実行されます。',
    '実行後、左メニューの［実行数］でその実行のログを開いてください。',
    '',
    '作成主体: ' + getEffectiveUserEmail_(),
    '後片付け: diag_deleteOneShot() を実行してください。'
  ].join('\n'));
}

/** 一発診断トリガーが呼ばれる本体。投稿は一切しない。 */
function diag_oneShotRun() {
  console.log('【トリガー実行としての診断】');
  diag_checkExecutionIdentity();
}

/** 一発診断トリガーを消す。診断が終わったら必ず実行する。 */
function diag_deleteOneShot() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DIAG_ONESHOT_HANDLER) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  console.log('診断トリガーを ' + removed + '件 削除しました。');
  return removed;
}
