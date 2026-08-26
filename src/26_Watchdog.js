/**
 * ===========================================================================
 * 26_Watchdog.gs  —  「何も投稿していない」ことに気づく仕組み
 * ===========================================================================
 *
 * ★このファイルは、今セッションで起きた障害すべてに共通する
 * 唯一の根本原因に対処するために作った。
 *
 * 2026-08-16〜18に投稿が止まった原因は毎回違った。
 *
 *   ・引用がAPIアクセス階層の制限で403 → リツイートがサイクルを消費
 *   ・品質ゲートが全案を却下 → 行が未処理へ戻るだけ（設計どおり）
 *   ・Webアプリへの委譲が失敗 → HTTP 200なので成功と誤認
 *   ・画像添付が未接続 → 呼ばれないので何も起きない
 *   ・RSSフィードが404 → console.warn だけ
 *
 * 原因は毎回違うのに、**症状は毎回同じだった**。
 * 「システムは正常と表示され、通知は来ず、タイムラインだけが増えない」。
 * そしてオーナーがそれに気づいて報告する、という流れを何度も繰り返した。
 *
 * 個々のcatchに通知を足す方向では解決しない（catchは185箇所あり、
 * 大半は正当な小さいフォールバックで、全部通知したら騒音になる）。
 * 見るべきは1つ、**「結局この数時間で1本でも出たのか」** だけ。
 *
 * ここでは各サイクルの結末を記録し、一定回数続けて何も出せなければ
 * 理由の内訳を添えて知らせる。原因が何であれ必ず検知できる。
 */

/** サイクルの結末を覚えるプロパティ。 */
const CYCLE_LOG_PROP = 'cycle_outcomes';

/** 何回連続で投稿ゼロなら知らせるか。2時間おきなので6回＝約12時間。 */
const SILENCE_ALERT_CYCLES = 6;

/** 通知の間隔。鳴り続けても意味が無い。 */
const SILENCE_NOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SILENCE_NOTIFIED_PROP = 'silence_notified_at';

/** 覚えておくサイクル数。 */
const CYCLE_LOG_KEEP = 20;

/**
 * 結末の種類。人が読んで次の手が分かる粒度にする。
 * 「失敗した」ではなく「何が無くて出せなかったのか」を残す。
 */
const CYCLE_POSTED       = 'posted';        // 投稿できた
const CYCLE_NO_TARGET    = 'no_target';     // 引用・情報源の対象が無い
const CYCLE_NO_QUEUE     = 'no_queue';      // キューが空
const CYCLE_QUALITY      = 'quality';       // 品質基準に届かなかった
const CYCLE_PACED        = 'paced';         // 今日のぶんを使い切った
const CYCLE_STOPPED      = 'stopped';       // 緊急停止中
const CYCLE_ERROR        = 'error';         // 例外

const CYCLE_LABELS = {
  posted:    '投稿できた',
  no_target: '引用・情報源の対象が見つからない',
  no_queue:  'キューが空',
  quality:   '品質基準に届かない',
  paced:     '今日のぶんを使い切った',
  stopped:   '停止中',
  error:     'エラー'
};

/*
 * ★このサイクルの結末。processQueueCore_ の各経路が上書きし、
 * finally で1回だけ記録する。return が多い関数なので、
 * 記録漏れが起きない形にしてある。
 */
let currentCycleOutcome_ = null;

/** このサイクルの結末を宣言する。最後に宣言されたものが残る。 */
function noteCycleOutcome_(kind, detail) {
  currentCycleOutcome_ = { kind: kind, detail: String(detail || '').slice(0, 120) };
}

/** サイクル開始時に初期化する。 */
function beginCycle_() {
  currentCycleOutcome_ = null;
}

function readCycleLog_() {
  try {
    const raw = getProp_(CYCLE_LOG_PROP, '');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * サイクルの結末を確定して記録し、必要なら沈黙を知らせる。
 * ★ここで例外を投げない。監視が投稿を壊してはいけない。
 */
function endCycle_() {
  try {
    const outcome = currentCycleOutcome_ ||
      { kind: CYCLE_NO_TARGET, detail: '結末が記録されませんでした' };

    const log = readCycleLog_();
    log.push({ at: Date.now(), k: outcome.kind, d: outcome.detail });
    const trimmed = log.slice(-CYCLE_LOG_KEEP);
    try { props_().setProperty(CYCLE_LOG_PROP, JSON.stringify(trimmed)); } catch (e) {}

    if (outcome.kind === CYCLE_POSTED) {
      /*
       * 出せたので沈黙の通知状態を解除する。
       * ★間引きの記録も消す。消さないと、次に本当に止まった時に
       * 前回の「倍に伸びた間隔」を引き継いで最大48時間鳴らなくなる。
       */
      try { props_().deleteProperty(SILENCE_NOTIFIED_PROP); } catch (e) {}
      try { clearNotifyState_('silence'); } catch (e) {}
      try { clearNotifyState_('buzz_media_abort'); } catch (e) {}
      return;
    }
    checkSilence_(trimmed);
  } catch (e) {
    console.warn('サイクル記録に失敗（投稿には影響しません）: ' + e);
  } finally {
    currentCycleOutcome_ = null;
  }
}

/** 直近が全て「投稿なし」で埋まっていたら知らせる。 */
function checkSilence_(log) {
  const recent = log.slice(-SILENCE_ALERT_CYCLES);
  if (recent.length < SILENCE_ALERT_CYCLES) return;
  if (recent.some(function (r) { return r.k === CYCLE_POSTED; })) return;

  /*
   * ★全部が「日割り上限に達した」だけなら知らせない（2026-08-19）。
   *
   * 1日4本の目標に対して2時間おき=1日12サイクルなので、
   * 上限に達した後の残り8サイクルは毎回「今日のぶんを使い切った」で
   * 終わる。これは設計どおりの正常な状態で、対処法も無い
   * （nextStepFor_ も「異常ではありません」としか言えない）。
   *
   * それでも従来はこの状態を「壊れているかもしれない」通知と
   * 同じ形で毎日出していた。オーナー指摘のとおり、
   * 「使い切った」を知らせたら、その日はもう鳴らす必要がない。
   *
   * 1件でも paced 以外の理由が混ざっているなら、そちらは
   * 対処のしようがあるので今までどおり知らせる。
   */
  const allPaced = recent.every(function (r) { return r.k === CYCLE_PACED; });
  if (allPaced) return;

  // 理由ごとに数える。内訳が分かれば次の手が決まる。
  const counts = {};
  recent.forEach(function (r) { counts[r.k] = (counts[r.k] || 0) + 1; });
  const breakdown = Object.keys(counts).map(function (k) {
    return '  ・' + (CYCLE_LABELS[k] || k) + ': ' + counts[k] + '回';
  }).join('\n');

  const lastDetail = recent[recent.length - 1].d;

  /*
   * ★同じ文面の再送は間隔を倍にしていく（notifyAdminOnce_）。
   *
   * 以前はここで一律6時間の再送だったため、状況が1つも変わっていない
   * のに全く同じ文面が0:13と6:13に届いた（2026-08-22、オーナー指摘）。
   * 内訳が変われば文面も変わるので、新しい情報はすぐ届く。
   */
  notifyAdminOnce_('silence', [
    // ★短くする（2026-08-22、オーナー指示「シンプルに」）。
    //   毎回の注意書き2行は、繰り返すほど読まれなくなるので消した。
    '🔇 ' + SILENCE_ALERT_CYCLES + '回連続で投稿ゼロ',
    '',
    breakdown,
    lastDetail ? '直近: ' + lastDetail : '',
    '',
    nextStepFor_(counts)
  ].filter(String).join('\n'), SILENCE_NOTIFY_INTERVAL_MS);
}

/** 内訳から、次に取るべき手を1つ提案する。 */
function nextStepFor_(counts) {
  const top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  switch (top) {
    case CYCLE_QUALITY:
      return '→ 品質基準に届いていません。「点検」で今日の消化を確認し、\n' +
             '   続くようなら QUALITY_MIN_SCORE の見直しを検討してください。';
    case CYCLE_NO_TARGET:
      return '→ 話題が見つかっていません。「情報源診断」でフィードの生死を確認してください。';
    case CYCLE_NO_QUEUE:
      return '→ キューが空です。「補充A3」「補充B3」で自動補充を設定できます。';
    case CYCLE_PACED:
      return '→ 日割りの上限に達しています。異常ではありません。';
    case CYCLE_STOPPED:
      /*
       * ★クレジット切れの時に「再開で解除」とだけ言うのは誤った案内。
       * 残高が無いまま再開しても同じ402に戻る。原因で文面を変える。
       */
      if (lastStopWasCredits_()) {
        return '→ Xのクレジット残高が不足しています。これはコードでは直せません。\n' +
               '   https://developer.x.com/en/portal/dashboard で購入してから「再開」。\n' +
               '   購入せずに再開すると、試行ぶんの呼び出しだけ消費して再び止まります。';
      }
      return '→ 停止中です。「状態」で理由を確認し、「再開」で解除できます。';
    case CYCLE_ERROR:
      return '→ 例外が続いています。直近の理由を確認してください。';
    default:
      return '→ 「点検」で全体を確認してください。';
  }
}

/** 直近のサイクルの様子を人が読める形にする（「点検」用）。 */
function buildCycleHealthText_() {
  const log = readCycleLog_();
  if (!log.length) return '';

  const recent = log.slice(-SILENCE_ALERT_CYCLES);
  const posted = recent.filter(function (r) { return r.k === CYCLE_POSTED; }).length;
  const lines = ['【直近' + recent.length + 'サイクル】投稿できた: ' + posted + '回'];

  if (!posted) {
    const counts = {};
    recent.forEach(function (r) { counts[r.k] = (counts[r.k] || 0) + 1; });
    Object.keys(counts).forEach(function (k) {
      lines.push('  ⚠️ ' + (CYCLE_LABELS[k] || k) + ': ' + counts[k] + '回');
    });
  }
  return lines.join('\n');
}
