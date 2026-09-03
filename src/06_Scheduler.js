/**
 * ===========================================================================
 * 06_Scheduler.gs  —  予約投稿エンジン（Queue / Links / Log）
 * ===========================================================================
 * スプレッドシートに積んだ投稿を、時間主導トリガーで自動投稿する。
 *
 * 【Queueシート】
 *   A: Account   … "A" または "B"
 *   B: Content   … 投稿本文。{AUTO} を含めるとLLMで自動生成する
 *   C: Status    … 空=未投稿 / "Posted" / "Processing" / "エラー: ..."
 *   D: Timestamp … 投稿完了時刻
 *   E: Posted Text … 実際に投稿された本文（{AUTO}時に何が出たかの記録）
 *   1行目はヘッダとして扱い、2行目から走査する。
 *
 * 【Linksシート】
 *   A: URL   … http(s) で始まる文字列のみ有効
 *   B: Note  … メモ（任意）
 *   C: Target … "A" / "B" / 空=両方
 *
 * 【Logシート】無ければ自動生成する
 *   Timestamp / Account / Status / Post Text / Target Region / Strategy Angle / Format
 *   どの地域・訴求角度・文章の型が効いたかを後から比較するための蓄積。
 *
 * 【1回の実行で1行だけ処理する】
 * X APIのレートリミットと、意図しないクレジット消費を避けるための制約。
 *
 * 【必要なスクリプトプロパティ】
 *   LOG_SPREADSHEET_ID … 上記シートを持つスプレッドシートのID
 */

const QUEUE_SHEET_NAME = 'Queue';
const LINKS_SHEET_NAME = 'Links';
const LOG_SHEET_NAME   = 'Log';

const QUEUE_TRIGGER_HANDLER = 'processQueue';
const QUEUE_TRIGGER_INTERVAL_HOURS = 2;

/**
 * 自動投稿トリガーを作成したGoogleアカウントを控えておくプロパティ名。
 *
 * 【なぜ必要か】
 * GASのトリガーは「作成したアカウント」として実行される。
 * そして ScriptApp.getProjectTriggers() は自分が作った分しか返さないため、
 * 別アカウントで作られたトリガーは一覧に出ず、削除もできないまま動き続ける。
 * そのアカウントにスプレッドシートが共有されていなければ、
 * 2時間おきに「シートを開けません」を出し続ける幽霊トリガーになる。
 *
 * ただし幽霊トリガー自身の実行中は、実行主体がその別アカウントになる。
 * つまり「その瞬間だけ」自分自身を削除できる。それが下の guard の仕組み。
 */
const QUEUE_TRIGGER_OWNER_PROP = 'QUEUE_TRIGGER_OWNER';

// Queue列（1始まり）
const QUEUE_COL_ACCOUNT     = 1;  // A
const QUEUE_COL_CONTENT     = 2;  // B
const QUEUE_COL_STATUS      = 3;  // C
const QUEUE_COL_TIMESTAMP   = 4;  // D
const QUEUE_COL_POSTED_TEXT = 5;  // E
// ↓ 追跡用に後から足した列。既存シートには自動で追加される（ensureQueueColumns_）
const QUEUE_COL_JOB_ID       = 6;   // F  行を一意に識別する
const QUEUE_COL_CONTENT_HASH = 7;   // G  重複判定に使ったハッシュ
const QUEUE_COL_STARTED_AT   = 8;   // H  処理開始時刻
const QUEUE_COL_X_POST_ID    = 9;   // I  XのPost ID
const QUEUE_COL_POSTED_AT    = 10;  // J  投稿確定時刻
const QUEUE_COL_LAST_ERROR   = 11;  // K  最後のエラー
const QUEUE_COL_RETRY_COUNT  = 12;  // L  再処理回数
const QUEUE_TOTAL_COLUMNS    = 12;

const QUEUE_HEADERS = ['Account', 'Content', 'Status', 'Timestamp', 'Posted Text',
                       'Job ID', 'Content Hash', 'Processing Started At',
                       'X Post ID', 'Posted At', 'Last Error', 'Retry Count'];

const QUEUE_FIRST_DATA_ROW  = 2;

// Links列
const LINKS_COL_URL    = 1;  // A
const LINKS_COL_NOTE   = 2;  // B  何のリンクかの説明。空だと投稿を書けない
const LINKS_COL_TARGET = 3;  // C  'A' / 'B' / 空=両方
// ↓ Bの収益ファネル用に後から足した列。既存シートには自動追加される
const LINKS_COL_PLATFORM     = 4;   // D  DLsite / Fantia / DiGiket
const LINKS_COL_CATEGORY     = 5;   // E  doujin / voice / ASMR / game ...
const LINKS_COL_GEO          = 6;   // F  対象地域（空=制限なし・旧列。国別可否はG以降で見る）
const LINKS_COL_PRODUCT_TYPE = 7;   // G  作品種別
const LINKS_COL_PRIORITY     = 8;   // H  数値。大きいほど優先
const LINKS_COL_ACTIVE       = 9;   // I  旧の有効/無効フラグ（Statusと併用。どちらかでも無効なら使わない）
// ↓ 規約確認（§22-23）用に追加。すべて「確認できるまでFALSE/空」が既定＝安全側。
const LINKS_COL_AFFILIATE_URL        = 10;  // J  実際に使うアフィリエイトURL（無ければURL列を使う）
const LINKS_COL_ADULT                = 11;  // K  'TRUE' なら成人向け
const LINKS_COL_AFFILIATE_ALLOWED    = 12;  // L  そのASPがアフィリエイトを許可しているか
const LINKS_COL_SNS_ALLOWED          = 13;  // M  SNS掲載を許可しているか
const LINKS_COL_X_ALLOWED            = 14;  // N  X上での掲載を許可しているか
const LINKS_COL_AUTOMATION_ALLOWED   = 15;  // O  Bot/自動投稿での掲載を許可しているか
const LINKS_COL_OVERSEAS_ALLOWED     = 16;  // P  海外ユーザーへの訴求を許可しているか
const LINKS_COL_US_ALLOWED           = 17;  // Q
const LINKS_COL_CA_ALLOWED           = 18;  // R
const LINKS_COL_UK_ALLOWED           = 19;  // S
const LINKS_COL_AU_ALLOWED           = 20;  // T
const LINKS_COL_DISCLOSURE_REQUIRED  = 21;  // U  'TRUE' なら開示表記が必須
const LINKS_COL_DISCLOSURE_TEXT      = 22;  // V  使う開示文言（例: #ad / #affiliate）
const LINKS_COL_PAYOUT_METHOD        = 23;  // W  参考情報。投稿判定には使わない
const LINKS_COL_JAPAN_BANK_PAYOUT    = 24;  // X  参考情報
const LINKS_COL_VERIFIED             = 25;  // Y  'TRUE' は「人間が一次情報で確認した」印。AIは書き換えない
const LINKS_COL_VERIFICATION_SOURCE  = 26;  // Z  確認した一次情報のURL・文書名
const LINKS_COL_VERIFICATION_DATE    = 27;  // AA 確認日（規約は変わるため、古すぎる確認は無効扱いにする）
const LINKS_COL_TERMS_URL            = 28;  // AB 規約ページのURL
const LINKS_COL_RISK_LEVEL           = 29;  // AC 参考情報（LOW/MEDIUM/HIGH等）
const LINKS_COL_STATUS               = 30;  // AD UNVERIFIED / PENDING / ACTIVE / PAUSED / BLOCKED
const LINKS_COL_LAST_USED            = 31;  // AE 自動更新（読むだけでなく書く）
const LINKS_COL_COOLDOWN_UNTIL       = 32;  // AF 自動更新
/*
 * ★AG ImageURL（2026-08-18追加）。
 * 画像添付(25_Media.gs)を実際に使うために要る。ASPが配布している
 * 公式の宣伝素材のURLをここに入れる。空なら画像なしで投稿する。
 * 末尾に足しているので、既存シートは ensureTrailingHeaders_ が自動で列を作る。
 */
const LINKS_COL_IMAGE_URL            = 33;  // AG
const LINKS_TOTAL_COLUMNS            = 33;

const LINKS_HEADERS = ['URL', 'Note', 'Target', 'Platform', 'Category', 'GEO', 'ProductType',
                       'Priority', 'Active',
                       'AffiliateURL', 'Adult', 'AffiliateAllowed', 'SNSAllowed', 'XAllowed',
                       'AutomationAllowed', 'OverseasAllowed',
                       'USAllowed', 'CAAllowed', 'UKAllowed', 'AUAllowed',
                       'DisclosureRequired', 'DisclosureText',
                       'PayoutMethod', 'JapanBankPayout',
                       'Verified', 'VerificationSource', 'VerificationDate', 'TermsURL',
                       'RiskLevel', 'Status', 'LastUsed', 'CooldownUntil', 'ImageURL'];

/**
 * 確認から何日経ったら「古すぎる」として無効扱いにするか。
 * 規約は改定される。一度確認しただけで永久に信用しない。
 */
const LINKS_VERIFICATION_MAX_AGE_DAYS = 180;

const LINKS_FIRST_DATA_ROW = 2;

/**
 * Logの列。
 *
 * 後半の計測列は、投稿時点では空のまま置く。
 * 投稿してすぐ分かるのは「何を出したか」だけで、
 * 効いたかどうかは24時間・48時間・7日後にしか分からない。
 * 先に列を用意しておかないと、後から遡って測れない。
 */
const LOG_HEADERS = ['Timestamp', 'Account', 'Status', 'Post Text', 'Target Region',
                     'Strategy Angle', 'Format',
                     'X Post ID', 'Content Hash', 'Has Link', 'Cost Estimate',
                     'Post Role', 'Length', 'Model', 'Gen Seconds',
                     'Quality Score',
                     // ↓ Bの収益ファネル用（どのタイプ・どの販売先が効いたかを見る）
                     'Post Type', 'Platform', 'Category', 'Link URL',
                     // ↓ 投稿後に測る指標。取れないものは空のままにする
                     'Impressions', 'Likes', 'Replies', 'Reposts',
                     'Profile Visits', 'Link Clicks', 'Follower Delta',
                     'Conversions', 'Revenue', 'EPC', 'CTR', 'Conversion Rate',
                     'Measured 24h', 'Measured 48h', 'Measured 7d'];

const LOG_COL_TIMESTAMP  = 1;
const LOG_COL_ACCOUNT    = 2;
const LOG_COL_STATUS     = 3;
const LOG_COL_POST_TEXT  = 4;
const LOG_COL_ANGLE      = 6;   // Strategy Angle。投稿の種類判定に使う（24_PostMix.gs）
const LOG_COL_X_POST_ID  = 8;
const LOG_COL_HAS_LINK   = 10;
const LOG_COL_COST       = 11;
const LOG_COL_POST_ROLE  = 12;
const LOG_COL_QUALITY    = 16;
const LOG_COL_POST_TYPE  = 17;
const LOG_COL_PLATFORM   = 18;
const LOG_COL_CATEGORY   = 19;
const LOG_COL_LINK_URL   = 20;
const LOG_COL_IMPRESSIONS = 21;
const LOG_COL_LINK_CLICKS = 26;
const LOG_COL_CONVERSIONS = 28;
const LOG_COL_REVENUE     = 29;
const LOG_COL_EPC         = 30;
const LOG_COL_CTR         = 31;
const LOG_COL_CVR         = 32;
const LOG_TOTAL_COLUMNS  = 35;

const QUEUE_STATUS_POSTED      = 'Posted';
const QUEUE_STATUS_PROCESSING  = 'Processing';
const QUEUE_STATUS_ERROR       = 'Error';
const QUEUE_STATUS_SKIPPED_DUP = 'Skipped: Duplicate';

/**
 * X APIへ送信中で、まだ結果が確定していない状態。
 *
 * "Processing"（着手しただけ・Xには未送信）と分けているのが要点。
 *   Processing で止まった → Xに届いていないので、未処理へ戻して再試行してよい
 *   Posting    で止まった → 届いたか不明。再送すると二重投稿になる
 * この区別が無いと、復旧処理そのものが二重投稿の原因になる。
 */
const QUEUE_STATUS_POSTING = 'Posting';

/** 投稿されたか確定できない状態。人間が確認するまで自動では絶対に動かさない。 */
const QUEUE_STATUS_UNKNOWN = 'UNKNOWN';

/* ------------------------------------------------------------------ */
/* メイン処理（トリガーから呼ばれる）                                   */
/* ------------------------------------------------------------------ */

/**
 * Queueシートの最上段の未投稿行を1件だけ投稿する。
 * 未投稿行が無ければ何もしない（正常終了）。
 */
function processQueue() {
  // 別アカウントが作った幽霊トリガーなら、ここで自分自身を消して終わる。
  // 投稿処理には一切入らない（そのアカウントはシートを開けないため）。
  if (!guardQueueTriggerOwner_()) return;

  // 異常検知で停止中なら何もしない。
  // トリガーは動き続けるが、投稿だけを止める（LINEの「再開」で復帰できる）。
  if (isEmergencyStopped_()) {
    console.warn('緊急停止中のためスキップ: ' + getProp_(EMERGENCY_STOP_REASON_PROP, ''));
    return;
  }

  // ★このコンテキストからスプレッドシートを開けるかを先に確かめる。
  //
  // GASのトリガーは「作成された時点の認可」で動き続ける。
  // 後からマニフェストへスコープを足しても、既存トリガーの認可は更新されない。
  // その結果、UrlFetchApp（旧スコープ）は通るのに
  // SpreadsheetApp（後から足したスコープ）だけが permission エラーになる。
  // Session.getEffectiveUser() も空になるため、アカウント違いと見分けがつかない。
  //
  // 認可を入れ直せるのは人間だけなので、コード側は
  // 「認可が生きている経路」＝Webアプリへ処理を委譲して動かし続ける。
  if (!canOpenLogSpreadsheet_()) {
    delegateQueueToWebApp_();
    return;
  }

  // ★直接処理できている＝認可はもう有効。迂回中フラグが残っていれば消す。
  //
  // このフラグは setupAutoPost() 実行時にも消しているが、
  // bootstrap()/startEngine() は独自にトリガーを作り直すため経路が別になる。
  // 「どうやって直したか」に依存させず、直接処理が実際に成功した時点で
  // 一律にクリアする方が確実（自己修復にする）。
  if (getProp_(DELEGATE_MODE_PROP)) {
    props_().deleteProperty(DELEGATE_MODE_PROP);
    props_().deleteProperty(DELEGATE_NOTIFIED_PROP);
    console.log('直接処理が成功したため、迂回モードを解除しました。');
  }

  // 計測トリガーが無ければここで用意する。
  // ここは正しい実行アカウントであることが確定しているので、
  // 人が手を動かさなくても計測が立ち上がる。
  ensureDailyMetricsTrigger_();

  processQueueCore_();
}

/**
 * キュー処理の本体。
 * トリガーからも、Webアプリへの委譲経由（handleTaskRequest_）でも、ここに合流する。
 *
 * ★停止判定はここでも行う。
 * processQueue() 側にも同じ判定があるが、委譲経路（/exec?task=queue）は
 * この関数を直接呼ぶため、processQueue() の判定を経由しない。
 * postTweet_ 側にも isAccountStopped_ の防御はあり誤投稿はしないが、
 * それだけだと「毎回Gemini生成だけ無駄に行って投稿時に弾かれる」状態になる。
 * ここで先に止めれば、停止中は生成コストも掛けない。
 */
function processQueueCore_() {
  /*
   * ★このサイクルの結末を必ず1回記録する（26_Watchdog.gs）。
   * 停止中の経路もここを通すため、いちばん先頭で始める。
   */
  beginCycle_();

  if (isEmergencyStopped_()) {
    console.warn('緊急停止中のためスキップ（core）: ' + getProp_(EMERGENCY_STOP_REASON_PROP, ''));
    noteCycleOutcome_(CYCLE_STOPPED, getProp_(EMERGENCY_STOP_REASON_PROP, '理由不明'));
    endCycle_();
    return;
  }

  /*
   * ★★2026-09-03、残高切れの自動休止。
   *
   * 【なぜ要るか】
   * Geminiの残高が尽きると、2時間ごとにキューの全行が同じ理由で失敗する。
   * 失敗しても消費は起きないが、**通知だけが積まれ、ログが埋まり、
   * 本当の異常が見えなくなる**。原因が「時間では解けないもの」だと
   * 分かっているのに、同じ試行を繰り返す意味が無い。
   *
   * 【なぜ緊急停止ではなく期限つきか】
   * 緊急停止は手で解除するまで戻らない。入金しても止まったままになり、
   * 「なぜ動かない」を探す時間が生まれる。期限が来れば自分で1回試し、
   * まだ駄目ならまた休む。入金すればその回から自然に動き出す。
   */
  const pausedUntil = Number(getProp_(LLM_PAUSED_UNTIL_PROP, '0')) || 0;
  if (pausedUntil && Date.now() < pausedUntil) {
    const at = Utilities.formatDate(new Date(pausedUntil), 'Asia/Tokyo', 'MM/dd HH:mm');
    console.warn('LLMの残高切れで休止中のためスキップ（' + at + 'に再開）。');
    noteCycleOutcome_(CYCLE_STOPPED, 'Geminiの残高切れで休止中（' + at + 'に再開）');
    endCycle_();
    return;
  }

  const lock = LockService.getScriptLock();

  // トリガーの実行が重なった場合に、同じ行を二重投稿しないための排他制御。
  // 取れなければ今回はスキップする（待たない。待つと次のトリガーと衝突するため）。
  if (!lock.tryLock(30000)) {
    console.warn('processQueue: 別の実行が処理中のためスキップしました。');
    // 別の実行が担当するので、このサイクルとしては数えない
    return;
  }

  // ★引用リポストを主モードにする（POST_MODE）。
  // 単独投稿は「誰も見ていないタイムラインでの独り言」になりやすい。
  // 既に伸びている投稿へぶら下がる方が露出は桁違いに取れる。
  //
  //   quote      … 引用のみ。対象が無い回は投稿しない（既定）
  //   mixed      … 引用を試し、対象が無ければ単独投稿へ落とす
  //   standalone … 従来どおり単独投稿のみ
  //
  // ロックの内側で呼ぶ。引用も投稿なので、単独投稿と同時には走らせない。
  // ★returnしてもロックが漏れないよう、既存の try/finally の中に入れている。
  // 引用専用モードの時だけ true。AIによる自動補充を止めるために使う
  let skipAutoRefill = false;

  try {
    const mode = postMode_();
    if (mode !== 'standalone') {
      /*
       * ★どの種類を優先するかを配分で決める（24_PostMix.gs）。
       *
       * 以前はここが固定の優先順（引用→情報源→単独）で、比率という概念が
       * 無かった。そのため引用が取れる限り単独投稿は永久に出ず、
       * 逆に引用が取れない時期は単独投稿だけになる、という極端な偏りが出る。
       *
       * 配分は「優先順位」であって「禁止」ではない。
       * 選ばれた種類が作れなければ、これまでどおり次の手段へ降りる。
       * だから配分の判定が失敗しても投稿は止まらない。
       */
      let mix = null;
      try {
        /*
         * ★スプレッドシートは1回だけ開いて使い回す。
         * 以前は primaryMixAccount_ が内部でもう一度開いていた。
         *
         * なお hasUsableAffiliateLink_ の結果をキャッシュする案は試して
         * 取り下げた。1サイクルで3回読む無駄は消えるが、実行の途中で
         * リンクを登録しても販売期へ切り替わらなくなる。
         * シート読み取り3回は1秒程度で、6分の実行枠に対して実害が無い。
         * 速度のために「古い判定を返しうる」性質を持ち込む価値はない。
         */
        const ssForMix = openLogSpreadsheet_();
        mix = pickPostKind_(ssForMix, primaryMixAccount_(ssForMix));
        console.log('配分: ' + mix.phase + ' / 今回は ' + mix.kind + '（' + mix.reason + '）');
      } catch (err) {
        console.warn('配分を決められないため従来の優先順で続行: ' + err);
      }

      /*
       * 人間らしい投稿の番なら、引用より先に単独投稿へ進む。
       * mixed の時だけ。quote モードは画像・URLのある投稿しか出さない設定
       * （オーナー指示）なので、そちらを優先する。
       */
      const humanFirst = !!(mix && mix.kind === POST_KIND_HUMAN && mode === 'mixed');

      /*
       * ★配分がバズを選んだ回は、まずバズを試す（28_Buzz.gs）。
       *
       * これが無いと BUZZ は「配分で選ばれるが誰も実行しない種類」になり、
       * 通常の生成へ流れて固定CTA付きの普通の投稿が出る。
       * 配分に足すことと、実行経路を作ることは別の作業だった。
       *
       * ★引用より前に置く。バズは無料の情報源だけで完結し、
       * 引用はX検索（課金）を伴うため。安い方を先に試す。
       *
       * 作れなかった回は、これまでどおり下の経路へ降りる。
       * 配分は「優先順位」であって「これ以外を出すな」ではない。
       */
      /*
       * ★参照投稿（31_RefPost.gs）。既定は無効。
       * X検索を1回使うため、無料で回るバズより先には置かない。
       */
      if (mix && mix.kind === POST_KIND_HIJACK && refPostEnabled_()) {
        let refPosted = false;
        try {
          refPosted = runRefCycleAll_();
        } catch (err) {
          console.error('参照投稿サイクルで例外: ' + (err && err.stack ? err.stack : err));
        }
        if (refPosted) {
          noteCycleOutcome_(CYCLE_POSTED, '参照投稿');
          return;
        }
        console.log('参照投稿を作れなかったため、通常の経路へ降ります。');
      }

      // ★アカウント別の停止は runBuzzCycleAll_ の中で判定される
      if (mix && mix.kind === POST_KIND_BUZZ && anyBuzzModeEnabled_()) {
        let buzzed = false;
        try {
          // ★引用専用モードでは、メディアの無いバズ投稿は出さない
          //   （quoteモード＝画像・URLのある投稿しか出さない、というオーナー指示）
          buzzed = runBuzzCycleAll_({ requireMedia: mode === 'quote' });
        } catch (err) {
          console.error('バズサイクルで例外: ' + (err && err.stack ? err.stack : err));
        }
        if (buzzed) {
          noteCycleOutcome_(CYCLE_POSTED, 'バズ投稿');
          return;
        }
        console.log('バズ投稿を作れなかったため、通常の経路へ降ります。');
      }

      if (!humanFirst) {
        /*
         * ★無料の情報源を先に試す（2026-08-19に順序を入れ替えた）。
         *
         * 【入れ替えた理由】
         * 以前は 引用サイクル（X検索）→ 情報源サイクル（Reddit/RSS）の順で、
         * 無料の材料が十分にある回でも必ずX検索を通っていた。
         *
         * Xの検索は1回ごとに課金される。実測（2026-08-19）:
         *   B  … 1サイクルにつき2回（QUOTE_PATTERN_TRIES）
         *   A  … 引用は403なので0回。ただしリツイート埋めで1回
         *   計 … 1日12サイクル × 3回 ＝ 36回/日
         * これで購入したクレジットが数日で尽きた（402）。
         *
         * Reddit と RSS は無料で、材料も十分にある
         * （Aは12フィードから191件、Bはジャンル検索を追加済み）。
         * 先に無料側で出せれば、X検索は1回も叩かずにサイクルが終わる。
         *
         * ★引用を諦めたわけではない。無料側で出せなかった回だけ
         * 引用へ進む。引用が使えるようになれば今までどおり機能する。
         */
        if (sourceModeEnabled_()) {
          let fromSource = false;
          try {
            // ★1アカウントだけ渡さない。渡していたせいで、フィードを持たない
            // アカウントに当たった回はAに候補があっても何も投稿されなかった。
            fromSource = runSourceCycleAll_();
          } catch (err) {
            console.error('情報源サイクルで例外: ' + (err && err.stack ? err.stack : err));
          }
          if (fromSource) {
            noteCycleOutcome_(CYCLE_POSTED, '情報源への反応');
            return;
          }
        }

        // 無料の材料で出せなかった回だけ、課金される引用検索へ進む
        let quoted = false;
        try {
          quoted = runQuoteCycle_();
        } catch (err) {
          // 引用が壊れても単独投稿まで巻き添えにしない
          console.error('引用サイクルで例外: ' + (err && err.stack ? err.stack : err));
        }
        if (quoted) {
          noteCycleOutcome_(CYCLE_POSTED, '引用リポスト');
          return;
        }

        if (mode === 'quote') {
        /*
         * ★引用専用モードでも、引用が権限で使えないアカウントには
         * 素のリツイートという手段が残っている。ここで試す。
         * 単独投稿（画像もURLも無い）へは落とさない方針は維持する。
         */
          let retweeted = false;
          try { retweeted = runRetweetFallback_(); }
          catch (err) { console.warn('リツイート埋めに失敗: ' + err); }
          if (retweeted) return;

          /*
           * ★ここで return しない（2026-08-18に直した）。
           *
           * 以前は引用が取れなければそのまま終了していたため、
           * キューに積まれた行が一度も処理されなかった。
           * 実機のQueue 53行目が残り続けていたのはこれ。
           *
           * 「自動投稿は引用だけ」という方針は、
           * 「人が入れた行も出さない」という意味ではない。
           * 予約投稿やシートに手で足した行は人間の明示的な指示であって、
           * 自動生成の単独投稿とは別物。
           *
           * 下のキュー処理へ進むが、AIによる自動補充だけは行わない。
           * 補充は「材料が無いから単独投稿を作る」処理で、
           * それこそが引用専用モードで止めたかったもの。
           */
          noteQuoteMiss_();
          skipAutoRefill = true;
        }
        console.log('引用も情報源も無かったため単独投稿へ切り替えます（mixed）。');
      } else {
        console.log('配分により、今回は単独投稿（人間らしい投稿）を先に出します。');
      }
    }

    const ss = openLogSpreadsheet_();
    const sheet = getQueueSheet_(ss);

    // 追跡用の列（Job ID / Content Hash / X Post ID …）が無い古いシートに足す。
    // 既存の列とデータには触らないので、何度通っても安全。
    ensureQueueColumns_(sheet);

    // 実行時間切れ等で "Processing" のまま取り残された行を先に復旧する。
    // これをやらないと、その行が永久に未処理のまま残り、以降のキューも進まない。
    recoverStaleProcessingRows_(sheet);

    let job = findNextPendingRow_(sheet);

    // キューが尽きたら自動補充する（AUTO_REFILL_A / AUTO_REFILL_B が設定されている場合）。
    // これにより、行を手で足さなくても稼働し続ける。
    if (!job && !skipAutoRefill) {
      if (autoRefillQueue_(sheet) > 0) {
        job = findNextPendingRow_(sheet);
      }
    }

    if (!job) {
      console.log('processQueue: 未投稿の行はありません。');
      noteCycleOutcome_(CYCLE_NO_QUEUE, 'キューに未処理の行が無い');
      return;
    }

    const accountKey = String(job.account || '').toUpperCase();

    // 入力不備は投稿を試みずにエラーとして記録する（APIを無駄に叩かない）
    if (!ACCOUNTS[accountKey]) {
      failQueueRow_(ss, sheet, job, accountKey,
        'A列は A または B を指定してください（現在の値: "' + job.account + '"）', '', '');
      return;
    }
    if (!job.content) {
      failQueueRow_(ss, sheet, job, accountKey, 'B列（投稿内容）が空です。', '', '');
      return;
    }

    postQueueRow_(ss, sheet, job, accountKey);

  } catch (err) {
    // シートが開けない・タブが無い等、行単位ではなく処理全体の失敗。
    // トリガー実行なので画面に出ない。ログとLINE通知に残す。
    const msg = String(err && err.message ? err.message : err);
    console.error('processQueue で例外: ' + (err && err.stack ? err.stack : err));
    notifyAdmin_('⚠️ 予約投稿の処理に失敗しました。\n' +
                 '実行アカウント: ' + (getEffectiveUserEmail_() || '(取得不可)') + '\n\n' +
                 truncate_(msg, 700));
    noteCycleOutcome_(CYCLE_ERROR, truncate_(msg, 100));

  } finally {
    // ★結末の記録は必ず通る場所で行う。return が多い関数なので、
    // 各経路に書くと必ずどこかで漏れる。
    endCycle_();
    lock.releaseLock();
  }
}

/**
 * 1行を処理する（リンク選択 → 生成 → 投稿 → 記録）。
 *
 * 投稿前に "Processing" を書き込んで flush している。
 * 投稿成功後にシート更新へ到達できなかった場合（実行時間切れ等）、
 * 行が未投稿のまま残ると次回起動で二重投稿になり、クレジットも二重に消費する。
 * 先に行を確保しておけば、最悪でも "Processing" のまま止まるだけで済む。
 */
function postQueueRow_(ss, sheet, job, accountKey) {
  const startedAt = new Date();
  sheet.getRange(job.rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_PROCESSING);
  // 開始時刻もここで書く。これが無いと、後述のデッドロック復旧が
  // 「いつから固まっているのか」を判定できない。成功時に完了時刻で上書きする。
  sheet.getRange(job.rowIndex, QUEUE_COL_TIMESTAMP).setValue(startedAt);
  sheet.getRange(job.rowIndex, QUEUE_COL_STARTED_AT).setValue(startedAt);
  if (!job.jobId) {
    job.jobId = newJobId_();
    sheet.getRange(job.rowIndex, QUEUE_COL_JOB_ID).setValue(job.jobId);
  }
  SpreadsheetApp.flush();

  // 月間上限に達しているなら、生成する前に止める。
  // postTweet_ 側でも弾かれるが、そこまで進むとGeminiの生成分が丸ごと無駄になる。
  if (isOverMonthlyCap_(accountKey)) {
    failQueueRow_(ss, sheet, job, accountKey,
      '今月の上限（' + getProp_('MONTHLY_SOFT_CAP') + '件）に達しています。', '', '');
    noteCycleOutcome_(CYCLE_PACED, accountKey + ': 月間上限に到達');
    return;
  }

  /*
   * ★今日のぶんを使い切っていたら、行を失敗にせず未処理のまま戻す。
   *
   * これは障害ではなく配分。失敗扱いにすると、
   * ペース調整のたびにキューが減っていき、翌日に投稿する分が消える。
   */
  if (isOverDailyPace_(accountKey)) {
    // 未処理は空文字（findNextPendingRow_ が status === '' で拾う）。
    // 定数は存在しないので、ここで文字列を作らない。
    sheet.getRange(job.rowIndex, QUEUE_COL_STATUS).clearContent();
    sheet.getRange(job.rowIndex, QUEUE_COL_STARTED_AT).clearContent();
    SpreadsheetApp.flush();
    console.log('今日のぶん（' + dailyPostAllowance_(accountKey) + '件）を使い切りました (' +
                accountKey + ')。この行は未処理に戻します。');
    noteCycleOutcome_(CYCLE_PACED,
      accountKey + ': 今日の上限' + dailyPostAllowance_(accountKey) + '件に到達');
    return;
  }

  // Linksシートから、このアカウント向けのURLを1本ランダムに選ぶ。
  // ただし毎回リンクを貼るとリーチが潰れるため、N回に1回だけにする（下記参照）。
  const link = shouldIncludeLink_(accountKey) ? pickRandomLink_(accountKey, ss) : null;

  let text = job.content;
  let region = '';
  let angle = '';
  let format = '';
  let meta = null;      // AI生成時のモデル名・生成秒数・役割

  // {AUTO} を含む行はLLMで生成する。{AUTO} という文字列自体は投稿しない。
  if (isAutoContent_(job.content)) {
    // 過去と似すぎた場合は作り直す。同じ型が続くとアカウントが痩せるため、
    // 「止める」ではなく「別の角度で作り直す」を先に試す。
    const MAX_TRIES = 3;
    let generated = null;
    let lastSimilar = null;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      let candidate;
      try {
        candidate = generateTweet(accountKey, link, extractTopicHint_(job.content));
      } catch (err) {
        // ★品質基準に届かなかっただけなら、行をエラーにしない。
        // それは障害ではなく「今回は出さない」という正常な判断であり、
        // 行を潰すと題材が失われて次回も作り直せなくなる。
        // Statusを空のままにしておけば、次のトリガーで同じ行を再生成する。
        if (err instanceof QualityFloorError) {
          writeQueueStatus_(sheet, job.rowIndex, '');
          console.warn('品質基準未達のため今回は投稿を見送りました（行は残します）: ' +
                       err.message);
          noteCycleOutcome_(CYCLE_QUALITY,
            accountKey + ': 最良' + err.bestScore + '点 / 基準' + qualityMinScore_() + '点');
          return;
        }
        // 生成に失敗した行をそのまま投稿すると {AUTO} が流れてしまうため確実に止める
        const msg = truncate_(String(err && err.message ? err.message : err), 500);
        failQueueRow_(ss, sheet, job, accountKey, 'AI生成: ' + msg, '', '');
        return;
      }

      const hit = findTooSimilar_(accountKey, candidate.text);
      if (!hit) { generated = candidate; break; }

      lastSimilar = hit;
      console.warn('生成物が過去と類似（' + attempt + '/' + MAX_TRIES + '）: ' +
                   describeSimilarity_(hit));
    }

    if (!generated) {
      // 3回作り直しても似てしまう＝ネタが尽きている。投稿せず知らせる。
      failQueueRow_(ss, sheet, job, accountKey,
        MAX_TRIES + '回生成しても過去の投稿と似すぎました。\n' +
        describeSimilarity_(lastSimilar) + '\n' +
        'Linksやお題を追加して、話題の幅を広げてください。', '', '');
      return;
    }

    text = generated.text;
    region = generated.region;
    angle = generated.angle;
    format = generated.format || '';
    meta = generated;
    console.log('AI生成 row=' + job.rowIndex + ' [' + region + '/' + angle + '] link=' +
                ((link && link.url) || 'なし'));
  }

  const weighted = estimateWeightedLength_(text);
  console.log('投稿予定 row=' + job.rowIndex + ' 文字数(重み付き)=' +
              weighted + '/' + getTweetMaxLen_(accountKey));

  // ハッシュは送信前に確定させ、シートにも先に書く。
  // 投稿直後にGASが落ちても、何を送ったのかを後から追えるようにするため。
  const linkUrl = (link && link.url) || '';
  const hash = contentHash_(accountKey, text, linkUrl);
  sheet.getRange(job.rowIndex, QUEUE_COL_CONTENT_HASH).setValue(hash);

  // ★ここから先はXへ実際に送る区間。"Posting" に変えてから送る。
  // この状態で止まった行は、投稿されたか分からないので自動再送しない。
  sheet.getRange(job.rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_POSTING);
  sheet.getRange(job.rowIndex, QUEUE_COL_POSTED_TEXT).setValue(text);
  SpreadsheetApp.flush();

  /*
   * ★画像を添付する（25_Media.gs）。
   *
   * 昨日この機能を作ったが、どこからも呼んでいなかった＝完全な死にコード
   * だった（2026-08-18の監査で発覚）。ここで実際に繋ぐ。
   *
   * 画像はLinksシートの ImageURL 列から取る。ASPが配布する公式素材だけを
   * 想定している。空なら画像なしでこれまでどおり投稿する。
   * uploadMediaToX_ は失敗しても null を返すだけなので、投稿は止まらない。
   */
  let mediaIds = [];
  if (link && link.imageUrl) {
    const mediaId = uploadMediaToX_(accountKey, link.imageUrl);
    if (mediaId) {
      mediaIds = [mediaId];
      console.log('画像を添付します row=' + job.rowIndex + ': ' + truncate_(link.imageUrl, 60));
    }
  }

  let result;
  try {
    result = postTweet_(accountKey, text, { url: linkUrl, mediaIds: mediaIds });
  } catch (err) {
    // 重複・類似はエラーではなく「意図した節約」なので、区別して記録する
    if (err instanceof DuplicatePostError || err instanceof DuplicateContentError ||
        (err && err.name === 'TooSimilarError')) {
      writeQueueStatus_(sheet, job.rowIndex, QUEUE_STATUS_SKIPPED_DUP);
      appendLogRow_(ss, buildLogRow_({
        account: accountKey, status: QUEUE_STATUS_SKIPPED_DUP, text: text,
        region: region, angle: angle, format: format, hash: hash
      }));
      console.warn('重複のためスキップ row=' + job.rowIndex + ' (' + err.name + ')');
      return;
    }

    // 投稿されたか確定できない場合。ここが二重投稿を止める最後の砦。
    if (err instanceof IndeterminatePostError) {
      markQueueRowUnknown_(ss, sheet, job, accountKey, text, region, angle, format,
                           hash, String(err.message || err));
      return;
    }

    const msg = truncate_(String(err && err.message ? err.message : err), 500);
    failQueueRow_(ss, sheet, job, accountKey, msg, region, angle, text, format);
    return;
  }

  const postedAt = new Date();
  // Post ID を最初に書く。ここまで書けていれば、以降が落ちても追跡できる。
  sheet.getRange(job.rowIndex, QUEUE_COL_X_POST_ID).setValue(result.id || '');
  sheet.getRange(job.rowIndex, QUEUE_COL_POSTED_AT).setValue(postedAt);
  sheet.getRange(job.rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_POSTED);
  sheet.getRange(job.rowIndex, QUEUE_COL_TIMESTAMP).setValue(postedAt);

  appendLogRow_(ss, buildLogRow_({
    account: accountKey, status: QUEUE_STATUS_POSTED, text: text,
    region: region, angle: angle, format: format,
    postId: result.id, hash: result.contentHash || hash,
    hasLink: result.hasLink, cost: result.costEstimate,
    model: meta && meta.model, genSeconds: meta && meta.genSeconds,
    role: meta && meta.role, qualityScore: meta && meta.qualityScore,
    postType: meta && meta.postType, platform: meta && meta.platform,
    category: meta && meta.category, linkUrl: meta && meta.linkUrl
  }));

  // ★Bのファネル履歴は「実際に投稿できた」ものだけを数える。
  // 生成時点で数えると、重複や品質で落ちた分まで配分に混ざり、
  // 実際には出していないタイプが「もう出した」ことになってしまう。
  resetPoorQualityStreak_(accountKey);

  if (accountKey === 'B' && meta && meta.postType) {
    rememberBPost_({
      type: meta.postType,
      platform: meta.platform,
      category: meta.category,
      url: meta.linkUrl
    });
  }
  console.log('予約投稿の成功 row=' + job.rowIndex + ' id=' + (result.id || '?') +
              ' ' + (result.url || ''));
  noteCycleOutcome_(CYCLE_POSTED, '単独投稿 row=' + job.rowIndex);
}

/**
 * 投稿されたか確定できない行を UNKNOWN にする。
 *
 * ★この状態から自動で復帰させてはいけない……のだが、
 * 2026-08-16、確定できる場合だけは例外にした。
 *
 * X自身の直近ツイートに、送ろうとした本文と完全一致するものがあれば、
 * それは「投稿できていた」ことの強い証拠になる。その場合はUNKNOWNへ
 * 落とさず、そのままPostedとして確定する（人間の目視を待たせない）。
 *
 * 一致するものが無かった場合は、これまでどおりUNKNOWNへ落として
 * 人間の判断に委ねる。「無かった」は「投稿されていない」の証明には
 * ならない（X側の反映遅延がありうる）ため、そちらは自動化しない。
 * 非対称に扱っている理由は checkRecentTweetsForText_ のコメントを参照。
 */
function markQueueRowUnknown_(ss, sheet, job, accountKey, text, region, angle, format, hash, message) {
  let check = { checked: false, found: false, note: '' };
  try {
    check = checkRecentTweetsForText_(accountKey, text);
  } catch (e) {
    console.warn('直近ツイートの確認に失敗（UNKNOWNとして通常どおり続行）: ' + e);
  }

  if (check.found) {
    const postedAt = new Date();
    sheet.getRange(job.rowIndex, QUEUE_COL_X_POST_ID).setValue(check.tweetId);
    sheet.getRange(job.rowIndex, QUEUE_COL_POSTED_AT).setValue(postedAt);
    sheet.getRange(job.rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_POSTED);
    sheet.getRange(job.rowIndex, QUEUE_COL_TIMESTAMP).setValue(postedAt);
    SpreadsheetApp.flush();

    const hasLink = containsLink_(text);
    appendLogRow_(ss, buildLogRow_({
      account: accountKey, status: QUEUE_STATUS_POSTED, text: text,
      region: region, angle: angle, format: format,
      postId: check.tweetId, hash: hash,
      hasLink: hasLink, cost: estimateXPostCost_(hasLink)
    }));

    console.log('送信結果が不明だったが、X側で確認できたため確定: row=' + job.rowIndex +
                ' ' + check.url);
    notifyAdmin_([
      '✅ 投稿結果を自動確認できました（対応不要）',
      'Account: ' + accountKey,
      'Queue行: ' + job.rowIndex,
      '',
      '送信直後に結果が確認できませんでしたが、Xの直近ツイートに',
      '完全一致する本文が見つかったため、投稿済みとして確定しました。',
      check.url
    ].join('\n'));
    return;
  }

  sheet.getRange(job.rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_UNKNOWN);
  sheet.getRange(job.rowIndex, QUEUE_COL_LAST_ERROR).setValue(truncate_(message, 500));
  SpreadsheetApp.flush();

  appendLogRow_(ss, buildLogRow_({
    account: accountKey, status: QUEUE_STATUS_UNKNOWN, text: text,
    region: region, angle: angle, format: format, hash: hash
  }));

  console.error('投稿結果が不明 row=' + job.rowIndex + ': ' + message);
  notifyAdmin_([
    '⚠️ 投稿結果不明',
    'Account: ' + accountKey,
    'Queue行: ' + job.rowIndex,
    'Job ID: ' + (job.jobId || '(なし)'),
    '',
    truncate_(message, 300),
    '',
    check.checked ? ('X側の確認: ' + check.note) : 'X側の確認: 実行できませんでした。',
    '',
    '自動再投稿は停止しました。',
    'Xのタイムラインを確認し、',
    '  投稿済み → Status を Posted に',
    '  未投稿   → Status を空に',
    'してください。'
  ].join('\n'));
}

/**
 * Logの1行を作る。列が増えても呼び出し側を直さずに済むようにまとめてある。
 * 並び順は LOG_HEADERS と必ず一致させること。
 */
function buildLogRow_(o) {
  const hasLink = (o.hasLink === undefined) ? containsLink_(o.text) : !!o.hasLink;
  const cost = (o.cost === undefined) ? estimateXPostCost_(hasLink) : o.cost;
  const text = o.text || '';

  const row = [
    new Date(),
    o.account || '',
    o.status || '',
    text,
    o.region || '',
    o.angle || '',
    o.format || '',
    o.postId || '',
    o.hash || '',
    hasLink ? 'URL' : 'TEXT',
    (cost === null || cost === undefined) ? '' : cost,
    o.role || classifyPostRole_(o.angle, hasLink),
    text.length,
    o.model || '',
    (o.genSeconds === undefined || o.genSeconds === null) ? '' : o.genSeconds,
    (o.qualityScore === undefined || o.qualityScore === null) ? '' : o.qualityScore,
    o.postType || '',
    o.platform || '',
    o.category || '',
    o.linkUrl || ''
  ];

  // 計測列（Impressions以降）は投稿時点では空。後から埋める。
  while (row.length < LOG_TOTAL_COLUMNS) row.push('');
  return row;
}

/**
 * 投稿の役割を判定する（P2-14 / P2-16）。
 *
 * 「無料情報だけを配るアカウント」で終わらせないため、
 * 1本ごとに集客側か販売側かを記録しておき、後から比率を検証できるようにする。
 *
 *   FREE VALUE … 持ち帰れるものを渡す。フォローの理由をつくる
 *   BRIDGE     … 無料/自力の限界を示し、有料が要る条件を言う
 *   COMMERCIAL … 誰に向くかを名指しする
 *   PERSONAL   … 人として読ませる（Bの生活感）
 */
function classifyPostRole_(angle, hasLink) {
  const a = String(angle || '');

  if (a === 'Bridge' || a === 'Cost of DIY') return 'BRIDGE';
  if (a === 'Who it is for' || a === 'Direct') return 'COMMERCIAL';
  if (a === 'Slice of life' || a === 'Mood' || a === 'Reply bait') return 'PERSONAL';
  if (a === 'GitHub' || a === 'Tool' || a === 'Cheat Code' ||
      a === 'Teardown' || a === 'Mistake' || a === 'Contrarian') return 'FREE VALUE';

  // 角度が分からない場合はリンクの有無で寄せる
  return hasLink ? 'COMMERCIAL' : 'FREE VALUE';
}

/** 失敗をQueueとLogの両方に記録し、管理者へ通知する。 */
function failQueueRow_(ss, sheet, job, accountKey, message, region, angle, text, format) {
  writeQueueStatus_(sheet, job.rowIndex, 'エラー: ' + message);
  try {
    sheet.getRange(job.rowIndex, QUEUE_COL_LAST_ERROR).setValue(truncate_(message, 500));
  } catch (e) {
    console.warn('Last Error 列への記録に失敗: ' + e);
  }
  appendLogRow_(ss, buildLogRow_({
    account: accountKey, status: QUEUE_STATUS_ERROR,
    text: text || job.content || '', region: region, angle: angle, format: format
  }));
  console.error('予約投稿の失敗 row=' + job.rowIndex + ': ' + message);
  /*
   * ★★2026-08-31、残高切れの通知を1日1回に絞った。
   *
   * 【なぜ】
   * Geminiの残高が尽きると、キューの全行が同じ理由で失敗する。
   * 実際に「予約投稿に失敗しました」が同じ本文で3回連続で飛んだ。
   * 原因は1つなのに通知は行数だけ出る。**通知が多いほど読まれなくなる**ので、
   * 本当に見てほしい1回が埋もれる。
   *
   * ★抑制するのは残高切れだけ。他の失敗は今までどおり毎回知らせる。
   *   原因が行ごとに違う可能性があるため、まとめてはいけない。
   * ★1日で解除する。入金しても通知が出ないままだと、直ったのかどうかが
   *   分からなくなる。
   */
  if (/残高が尽きています/.test(String(message || ''))) {
    /*
     * ★試行そのものを止める（2026-09-03）。
     *   通知を1日1回に絞っても、キューは2時間おきに全行を試し続ける。
     *   残高切れは時間で解けないので、6時間休んでから1回だけ試す。
     *   入金済みならその回から動き出し、まだなら再び休む。
     */
    try {
      props_().setProperty(LLM_PAUSED_UNTIL_PROP,
                           String(Date.now() + LLM_PAUSE_HOURS * 60 * 60 * 1000));
    } catch (e) {
      console.warn('残高切れの休止を記録できません: ' + e);
    }

    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    if (getProp_('llm_credits_notified_on', '') === today) {
      console.warn('残高切れの通知は本日分を送信済みのため省略します（' +
                   accountKey + ' / ' + job.rowIndex + '行目）。');
      return;
    }
    try { props_().setProperty('llm_credits_notified_on', today); } catch (e) {}
    notifyAdmin_('🛑 Geminiの残高が尽きています\n' +
      '**レート上限ではありません。待っても回復しません。**\n' +
      'AI Studio で残高を入れるまで、すべての投稿が止まります。\n' +
      'https://ai.studio/projects\n\n' +
      '生成の試行は' + LLM_PAUSE_HOURS + '時間休みます（入金後は自動で戻ります）。\n' +
      '（同じ理由の通知は本日はこれ1回だけ出します）\n' + message);
    return;
  }

  notifyAdmin_('⚠️ 予約投稿に失敗しました\n' +
    'Queue ' + job.rowIndex + '行目 / ' + accountKey + '\n' + message);
}

/* ------------------------------------------------------------------ */
/* シートの列を後から足す（既存データを壊さない移行）                    */
/* ------------------------------------------------------------------ */

/**
 * 既存シートに、後から追加した列のヘッダーを足す。
 *
 * 既に入っているヘッダー名は書き換えない。既存データも触らない。
 * 足りない右側の列だけを埋める。何度呼んでも同じ結果になる。
 *
 * @return {number} 追加した列数
 */
function ensureTrailingHeaders_(sheet, headers) {
  const need = headers.length;

  // 物理的に列が足りなければ先に足す。無いと getRange が例外になる。
  if (sheet.getMaxColumns() < need) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
  }

  const current = sheet.getRange(1, 1, 1, need).getValues()[0];
  let added = 0;
  for (let i = 0; i < need; i++) {
    if (String(current[i] || '').trim() === '') {
      sheet.getRange(1, i + 1).setValue(headers[i]);
      added++;
    }
  }
  if (added > 0) {
    SpreadsheetApp.flush();
    console.log('シート「' + sheet.getName() + '」に ' + added + ' 列のヘッダーを追加しました。');
  }
  return added;
}

function ensureQueueColumns_(sheet) {
  return ensureTrailingHeaders_(sheet, QUEUE_HEADERS);
}

/** Queue行を一意に識別するID。既存行には後から付かないので空も許容する。 */
function newJobId_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmmss') + '-' +
         Math.random().toString(36).slice(2, 8);
}

/* ------------------------------------------------------------------ */
/* 認可切れトリガーの救済（Webアプリへの委譲）                           */
/* ------------------------------------------------------------------ */

/** 委譲モードで動いていることを覚えておくプロパティ */
const DELEGATE_MODE_PROP = 'QUEUE_DELEGATED';
const DELEGATE_NOTIFIED_PROP = 'QUEUE_DELEGATE_NOTIFIED_AT';

/**
 * 委譲専用トークンのプロパティ名。
 *
 * LINEの WEBHOOK_SECRET を流用しない。
 * あちらは未設定でも通す作り（設定漏れでBotが無反応になるのを避けるため）で、
 * それをジョブ実行口に使うと「誰でも投稿を実行できる口」になってしまう。
 * こちらは専用に持ち、無ければ自動生成する。人手の設定を必要としない。
 */
const TASK_TOKEN_PROP = 'TASK_TOKEN';

/**
 * 委譲用トークンを取得する。無ければ作る。
 * UUID v4（122ビットの乱数）なので推測はできない。
 * 値はログにも通知にも出さない。
 */
function ensureTaskToken_() {
  try {
    let token = getProp_(TASK_TOKEN_PROP, '');
    if (!token) {
      token = Utilities.getUuid() + Utilities.getUuid();
      props_().setProperty(TASK_TOKEN_PROP, token);
      console.log('委譲用トークンを新規発行しました。');
    }
    return token;
  } catch (e) {
    console.error('委譲用トークンの用意に失敗: ' + e);
    return '';
  }
}

/**
 * 今の実行コンテキストからスプレッドシートを開けるか。
 *
 * 設定そのものが無い場合は true を返す。
 * それは権限の問題ではなく設定漏れなので、本体側で正しいエラーを出させる。
 */
function canOpenLogSpreadsheet_() {
  if (!getProp_('LOG_SPREADSHEET_ID')) return true;
  try {
    openLogSpreadsheet_();
    return true;
  } catch (e) {
    console.warn('この実行からはシートを開けません。Webアプリへ委譲します: ' +
                 truncate_(String(e && e.message ? e.message : e), 200));
    return false;
  }
}

/**
 * Webアプリ（/exec）を叩いて、そちらでキュー処理を実行させる。
 *
 * Webアプリは executeAs: USER_DEPLOYING なので必ずスクリプト所有者として動き、
 * その認可は最新（LINEからの操作でシートを読めていることが実証済み）。
 * トリガー側に必要なのは UrlFetchApp だけで、これは古い認可でも通る。
 *
 * 【安全側の設計】
 * ・専用トークン(TASK_TOKEN)が用意できない場合は委譲しない。
 *   認証なしのジョブ実行口を外部へ晒すことになるため。
 * ・秘密の値はログにも通知にも出さない。
 */
function delegateQueueToWebApp_() {
  const token = ensureTaskToken_();

  if (!token) {
    notifyDelegationIssue_(
      'トリガーの認可が古く、スプレッドシートを開けません。\n' +
      '委譲用トークンを作成できなかったため、処理を中止しました。');
    return false;
  }

  const url = WEBAPP_EXEC_URL + '?task=queue&task_token=' + encodeURIComponent(token);

  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (err) {
    notifyDelegationIssue_('Webアプリへの委譲に失敗しました（通信エラー）。\n' +
                           truncate_(String(err), 200));
    return false;
  }

  const code = res.getResponseCode();
  if (code !== 200) {
    notifyDelegationIssue_('Webアプリへの委譲に失敗しました（HTTP ' + code + '）。\n' +
                           'デプロイURLが最新か確認してください。');
    return false;
  }

  /*
   * ★HTTP 200 でも、実際には何も処理されていないことがある。
   *
   * handleTaskRequest_ は「トークン不一致」「Webアプリ側の例外」「連続実行の
   * スロットル」のいずれでも 200 を返す（本文の ok / skipped で区別する）。
   * ステータスコードだけを見ていると、委譲が空振りし続けているのに
   * 「委譲して処理しました」と記録され、通知も出ないまま投稿が止まる。
   * 実際にこの状態を運用中に踏んだ（2026-08-17）。
   */
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) {}

  if (!body || body.ok !== true) {
    notifyDelegationIssue_(
      'Webアプリは応答しましたが、キュー処理は実行されませんでした。\n' +
      '応答: ' + truncate_(res.getContentText(), 200) + '\n\n' +
      '考えられる原因:\n' +
      '・委譲用トークンの不一致\n' +
      '・Webアプリ側での例外\n' +
      'エディタで「セットアップ」を1回実行すると直ることがあります。');
    return false;
  }

  if (body.skipped) {
    // 短時間に連続して呼ばれただけ。異常ではないので通知しない。
    console.log('委譲はスキップされました: ' + body.skipped);
    return true;
  }

  props_().setProperty(DELEGATE_MODE_PROP, '1');
  console.log('Webアプリへ委譲してキューを処理しました。');
  return true;
}

/**
 * 迂回モードのLINE通知は廃止した（2026-08-15）。
 *
 * 【経緯】実機で2時間ごと＝トリガーが動くたびに同じ通知が飛んでいた。
 * 24時間スロットル → 状態変化のみ＋書き込みの読み返し確認、と2段階で直したが、
 * どちらも実機では止まらなかった。
 *
 * 【原因の推定】認可が古いトリガーのコンテキストでは、PropertiesService への
 * 書き込みが同一実行内では読めるのに、実行をまたぐと消えている疑いが強い。
 * つまり「前回通知したか」を覚えられない。覚えられない場所で
 * 抑制フラグを使う設計は、どう作っても連投になる。
 *
 * 【判断】この通知は緊急性が無い（迂回中でも投稿は正常に出ている）。
 * 一度読めば分かる内容を2時間おきに送り続ける害の方が大きい。
 * 押し通知はやめ、状態は「状態」コマンドに常時表示する方式へ切り替えた。
 * 復旧手順もそこに出る。
 *
 * ★抑制フラグに頼る実装をここへ戻さないこと。同じ理由で必ず連投になる。
 */

/** 委譲そのものが失敗した場合。こちらは投稿が止まるので毎回知らせる。 */
function notifyDelegationIssue_(message) {
  console.error('委譲に失敗: ' + message);
  notifyAdmin_('⚠️ 自動投稿を実行できませんでした\n\n' + message);
}

/* ------------------------------------------------------------------ */
/* 幽霊トリガー対策                                                     */
/* ------------------------------------------------------------------ */

/**
 * まだ持ち主を記録していない場合だけ、今の実行主体を正解として控える。
 *
 * Webアプリ（LINE）からのみ呼ぶこと。Webアプリは executeAs: USER_DEPLOYING で
 * 必ずスクリプト所有者として動くため、ここで得られる主体は信用してよい。
 * トリガー実行から呼ぶと、幽霊アカウントが自分を正解として登録してしまう。
 *
 * 既に記録がある場合は上書きしない（setupAutoPost だけが正解を更新できる）。
 */
function seedQueueTriggerOwnerIfUnset_() {
  try {
    if (getProp_(QUEUE_TRIGGER_OWNER_PROP)) return;
    const me = getEffectiveUserEmail_();
    if (!me) return;
    props_().setProperty(QUEUE_TRIGGER_OWNER_PROP, me);
    console.log('正規の実行アカウントを記録しました: ' + me);
  } catch (e) {
    // ここで落ちるとLINE全体が止まる。記録は次回でよい。
    console.warn('実行アカウントの記録に失敗: ' + e);
  }
}

/** 今トリガーを作ったアカウントを控える。トリガー作成と必ずセットで呼ぶ。 */
function rememberQueueTriggerOwner_() {
  const me = getEffectiveUserEmail_();
  if (me) props_().setProperty(QUEUE_TRIGGER_OWNER_PROP, me);
  return me;
}

/**
 * 想定外のアカウントによる実行なら、そのアカウントのトリガーを削除する。
 *
 * 実行主体が取れない場合や、まだ持ち主を記録していない場合は「何もしない」。
 * 判定に自信が持てないまま正規のトリガーを消す方が、被害が大きいため。
 *
 * @return {boolean} 通常処理を続けてよいなら true
 */
function guardQueueTriggerOwner_() {
  const expected = getProp_(QUEUE_TRIGGER_OWNER_PROP);
  const me = getEffectiveUserEmail_();

  if (!expected || !me) return true;                 // 判定材料が無い
  if (expected.toLowerCase() === me.toLowerCase()) return true;   // 正規の実行

  let removed = 0;
  let deleteError = '';
  try {
    // ここは幽霊アカウントとして動いているので、幽霊自身のトリガーが見える。
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === QUEUE_TRIGGER_HANDLER) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    });
  } catch (e) {
    deleteError = String(e && e.message ? e.message : e);
    console.error('幽霊トリガーの削除に失敗: ' + deleteError);
  }

  console.warn('想定外アカウントの実行を検出: ' + me + '（想定: ' + expected + '）/ 削除 ' + removed + '件');

  notifyAdmin_([
    '🧹 別アカウントのトリガーを検出しました',
    '',
    '実行していたアカウント: ' + me,
    '本来のアカウント      : ' + expected,
    '削除したトリガー      : ' + removed + '件',
    '',
    'これが「スプレッドシートを開けません」の正体です。',
    removed > 0
      ? '削除したので、このエラーはもう出ません。'
      : ('自動削除できませんでした（' + (deleteError || '対象なし') + '）。\n' +
         me + ' でGASを開き、トリガー画面から手動で削除してください。')
  ].join('\n'));

  return false;
}

/* ------------------------------------------------------------------ */
/* シート取得                                                          */
/* ------------------------------------------------------------------ */

function openLogSpreadsheet_() {
  const id = getRequiredProp_('LOG_SPREADSHEET_ID');
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    // ★Googleが返した生のメッセージを必ず残す。
    // ここを自前の文言だけに差し替えていたため、
    //   「別アカウントで実行されている」「認可が古い」「IDが違う」
    // の区別が永久につかず、同じエラーを何度も出す原因になっていた。
    const raw = (e && e.message) ? e.message : String(e);
    throw new Error(
      'LOG_SPREADSHEET_ID のスプレッドシートを開けません（ID: ' + id + '）\n' +
      '実行アカウント: ' + (getEffectiveUserEmail_() || '(取得不可)') + '\n' +
      '想定アカウント: ' + (getProp_(QUEUE_TRIGGER_OWNER_PROP) || '(未記録)') + '\n' +
      'Googleの生エラー: ' + raw + '\n' +
      '→「見つかりません/not found」= そのアカウントに共有されていない、またはID違い\n' +
      '→「権限/Authorization」= 認可が古い。setupAutoPost を作り直すこと'
    );
  }
}

function getQueueSheet_(ss) {
  const spreadsheet = ss || openLogSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) {
    throw new Error(
      'スプレッドシートに「' + QUEUE_SHEET_NAME + '」という名前のシートがありません。' +
      'タブ名を確認してください（大文字小文字も一致させる必要があります）。'
    );
  }
  return sheet;
}

/** Logシートを取得。無ければヘッダ付きで作る（手動作成を不要にするため）。 */
function getOrCreateLogSheet_(ss) {
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
    console.log('Logシートを新規作成しました。');
    return sheet;
  }
  // 後から列を増やした場合、既存シートのヘッダーが足りないままになる。
  // ただし全体を setValues で上書きすると、利用者が付け替えた見出しまで消える。
  // 空いている列だけを埋める ensureTrailingHeaders_ に統一する。
  ensureTrailingHeaders_(sheet, LOG_HEADERS);
  return sheet;
}

/* ------------------------------------------------------------------ */
/* Queue操作                                                           */
/* ------------------------------------------------------------------ */

/**
 * Status列(C)が空の最初の行を返す。無ければ null。
 * A:E を一括で読み込む（1行ずつ getRange すると行数分のAPI呼び出しになるため）。
 * @return {?{rowIndex:number, account:string, content:string}}
 */
function findNextPendingRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < QUEUE_FIRST_DATA_ROW) return null;

  const numRows = lastRow - QUEUE_FIRST_DATA_ROW + 1;
  const values = sheet.getRange(QUEUE_FIRST_DATA_ROW, 1, numRows, QUEUE_TOTAL_COLUMNS).getValues();

  for (let i = 0; i < values.length; i++) {
    const status = String(values[i][QUEUE_COL_STATUS - 1] || '').trim();
    if (status !== '') continue;   // 投稿済・処理中・UNKNOWN・エラー行は飛ばす

    const account = String(values[i][QUEUE_COL_ACCOUNT - 1] || '').trim();
    const content = String(values[i][QUEUE_COL_CONTENT - 1] || '').trim();

    // 完全な空行は「未投稿」ではなく「データ無し」として無視する。
    // エラー扱いにすると、シート末尾の空行で毎回エラーが書かれてしまう。
    if (!account && !content) continue;

    return {
      rowIndex: QUEUE_FIRST_DATA_ROW + i,
      account: account,
      content: content,
      jobId: String(values[i][QUEUE_COL_JOB_ID - 1] || '').trim()
    };
  }
  return null;
}

function writeQueueStatus_(sheet, rowIndex, status) {
  sheet.getRange(rowIndex, QUEUE_COL_STATUS).setValue(status);
}

/* ------------------------------------------------------------------ */
/* キューの自動補充                                                    */
/* ------------------------------------------------------------------ */

/**
 * キューに {AUTO} 行を追加する。
 * @param {number} count 追加する件数
 * @param {string} accountKey 'A' or 'B'
 * @param {string} [topicHint] お題（省略可）
 * @return {number} 実際に追加した件数
 */
function fillQueue(count, accountKey, topicHint) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const key = String(accountKey || 'A').toUpperCase();
  if (!ACCOUNTS[key]) throw new Error('アカウントは A または B を指定してください: ' + accountKey);
  if (n === 0) return 0;

  const sheet = getQueueSheet_();
  const content = topicHint ? (AUTO_TAG + ' ' + topicHint) : AUTO_TAG;

  const rows = [];
  for (let i = 0; i < n; i++) rows.push([key, content, '', '', '']);

  // 末尾に一括追記する（1行ずつ appendRow すると件数分のAPI呼び出しになる）
  const startRow = Math.max(sheet.getLastRow() + 1, QUEUE_FIRST_DATA_ROW);
  sheet.getRange(startRow, 1, rows.length, 5).setValues(rows);
  SpreadsheetApp.flush();

  console.log(key + ' に ' + n + ' 件の ' + AUTO_TAG + ' 行を追加しました。');
  return n;
}

/**
 * キューが空のときに自動補充する。
 * AUTO_REFILL_A / AUTO_REFILL_B に件数を設定すると有効になる（未設定なら何もしない）。
 *
 * ※これを有効にすると、行を足さなくても投稿が続く。
 *   1件ごとにXのクレジットを消費するため、MONTHLY_SOFT_CAP の併用を強く推奨する。
 * @return {number} 補充した件数
 */
function autoRefillQueue_(sheet) {
  let total = 0;

  Object.keys(ACCOUNTS).forEach(function (key) {
    // ★既定値を0にしていたのが原因で、AUTO_REFILL_B を設定していないアカウントは
    // キューに行が1件も作られず、エラーも出さずに永久に沈黙していた（実機で発生）。
    // 「未設定」と「明示的に0」を区別する。未設定なら既定値で動かし、
    // 止めたい時だけ 0 を明示してもらう。
    const raw = getProp_('AUTO_REFILL_' + key, '');
    const n = (raw === '' || raw === null) ? AUTO_REFILL_DEFAULT : (Number(raw) || 0);
    if (n <= 0) return;

    // Geminiキーが無いと {AUTO} は生成できないので、補充しても全行エラーになるだけ
    if (!getProp_('GEMINI_API_KEY') && !getProp_('LLM_API_KEY')) {
      console.warn('自動補充をスキップ: GEMINI_API_KEY が未設定のため {AUTO} を生成できません。');
      return;
    }

    // 上限に達しているのに補充すると、2時間ごとにエラー行だけが増え続ける。
    // 翌月カウンタがリセットされれば自然に再開する。
    if (isOverMonthlyCap_(key)) {
      console.warn('自動補充をスキップ (' + key + '): 今月の上限に達しています。');
      return;
    }

    try {
      total += fillQueue(n, key);
    } catch (err) {
      console.warn('自動補充に失敗 (' + key + '): ' + err);
    }
  });

  if (total > 0) {
    console.log('キューが空になったため ' + total + ' 件を自動補充しました。');
  }
  return total;
}

/**
 * AUTO_REFILL_<key> が未設定のときに使う件数。
 * 0にすると「設定し忘れたアカウントが黙って死ぬ」ため、動く側を既定にする。
 */
const AUTO_REFILL_DEFAULT = 3;

/** "Processing" のまま放置された行を未処理に戻す閾値（分） */
const QUEUE_STALE_MINUTES = 15;

/**
 * "Processing" のまま固まった行を復旧する。
 *
 * GASの実行時間切れやクラッシュで、Statusを "Processing" にした直後に
 * 処理が止まると、その行は未投稿でも投稿済でもない状態で残り続ける。
 * 開始から15分以上経過していれば、実行は確実に終わっている（GASの上限は6分）ので、
 * Statusを空に戻して再処理の対象にする。
 *
 * D列が空の "Processing" 行は、開始時刻を記録する前のバージョンで作られたか、
 * 書き込み途中で落ちたもの。いずれにせよ古いので復旧対象にする。
 *
 * @return {number} 復旧した行数
 */
function recoverStaleProcessingRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < QUEUE_FIRST_DATA_ROW) return 0;

  const numRows = lastRow - QUEUE_FIRST_DATA_ROW + 1;
  const values = sheet.getRange(QUEUE_FIRST_DATA_ROW, 1, numRows, QUEUE_TOTAL_COLUMNS).getValues();
  const thresholdMs = QUEUE_STALE_MINUTES * 60 * 1000;
  const now = Date.now();

  let recovered = 0;
  let unknown = 0;
  const unknownRows = [];

  for (let i = 0; i < values.length; i++) {
    const status = String(values[i][QUEUE_COL_STATUS - 1] || '').trim();

    // UNKNOWN は人間が判断するまで絶対に触らない。
    if (status !== QUEUE_STATUS_PROCESSING && status !== QUEUE_STATUS_POSTING) continue;

    const started = toDateOrNull_(values[i][QUEUE_COL_TIMESTAMP - 1]);
    const startedMs = started ? started.getTime() : NaN;

    // 時刻が読めない場合も古いものとみなして復旧対象にする
    if (!isNaN(startedMs) && (now - startedMs) < thresholdMs) continue;

    const rowIndex = QUEUE_FIRST_DATA_ROW + i;

    if (status === QUEUE_STATUS_POSTING) {
      /*
       * Xへ送信中に落ちた行。投稿されたか分からないので未処理へは戻さない。
       *
       * ★2026-08-16、ここもX側で確認してから判断するようにした。
       * markQueueRowUnknown_ と同じ非対称の扱い（見つかれば確定、
       * 見つからなくても未投稿と断定はしない）。ここは復旧処理が
       * 何行もループで処理する場所なので、確認自体が失敗しても
       * 他の行の復旧を止めない。
       */
      const accountKey = String(values[i][QUEUE_COL_ACCOUNT - 1] || '').trim();
      const postedText = String(values[i][QUEUE_COL_POSTED_TEXT - 1] || '').trim();
      let check = { checked: false, found: false };
      if (accountKey && postedText) {
        try { check = checkRecentTweetsForText_(accountKey, postedText); }
        catch (e) { console.warn('直近ツイート確認に失敗 row=' + rowIndex + ': ' + e); }
      }

      if (check.found) {
        const postedAt = new Date();
        sheet.getRange(rowIndex, QUEUE_COL_X_POST_ID).setValue(check.tweetId);
        sheet.getRange(rowIndex, QUEUE_COL_POSTED_AT).setValue(postedAt);
        sheet.getRange(rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_POSTED);
        sheet.getRange(rowIndex, QUEUE_COL_TIMESTAMP).setValue(postedAt);
        console.log('復旧中にX側で投稿済みと確認: row=' + rowIndex + ' ' + check.url);
        continue;
      }

      sheet.getRange(rowIndex, QUEUE_COL_STATUS).setValue(QUEUE_STATUS_UNKNOWN);
      sheet.getRange(rowIndex, QUEUE_COL_LAST_ERROR)
           .setValue('送信中に実行が中断されました。投稿有無は未確認です。' +
                     (check.checked ? '（' + check.note + '）' : ''));
      unknown++;
      unknownRows.push(rowIndex);
      console.error('投稿結果不明として保留: row=' + rowIndex);
      continue;
    }

    // Processing はXへ送る前の段階。届いていないので安全に戻せる。
    sheet.getRange(rowIndex, QUEUE_COL_STATUS).clearContent();
    const retried = Number(values[i][QUEUE_COL_RETRY_COUNT - 1] || 0) + 1;
    sheet.getRange(rowIndex, QUEUE_COL_RETRY_COUNT).setValue(retried);
    recovered++;
    console.warn('デッドロック復旧: row=' + rowIndex + ' を未処理へ戻しました（' +
                 (isNaN(startedMs) ? '開始時刻なし'
                                   : '開始から' + Math.round((now - startedMs) / 60000) + '分経過') +
                 ' / 通算' + retried + '回目）');
  }

  if (recovered > 0 || unknown > 0) SpreadsheetApp.flush();

  if (recovered > 0) {
    notifyAdmin_('🔧 予約投稿: X送信前に停止していた ' + recovered +
                 ' 件を未処理に戻しました。\n' +
                 '（Xへは送信していないため、二重投稿にはなりません）');
  }
  if (unknown > 0) {
    notifyAdmin_([
      '⚠️ 投稿結果不明 ' + unknown + ' 件',
      'Queue行: ' + unknownRows.join(', '),
      '',
      'X送信中に処理が中断されました。',
      '自動再投稿は停止しました。',
      'Xのタイムラインを確認し、Statusを手で確定してください。'
    ].join('\n'));
  }
  return recovered;
}

/* ------------------------------------------------------------------ */
/* Links / Log                                                         */
/* ------------------------------------------------------------------ */

/**
 * 今回の投稿にリンクを含めるべきか判定する。
 *
 * 【なぜ毎回貼らないか】
 * Bufferが18.8M件の投稿を分析した結果、2025年3月以降、
 * 非Premiumアカウントのリンク付き投稿はエンゲージメント率の中央値が0%になっている。
 * Premiumでもリンク投稿はテキスト・画像・動画に劣る。
 * 毎回リンクを貼ると、投稿の大半が誰にも届かないまま消える。
 *
 * また実務側の定石として「価値提供4〜5本につき宣伝1本」が挙げられており、
 * ここでも同じ比率を既定にしている。
 *
 * LINK_EVERY_A / LINK_EVERY_B で変更可（1にすれば毎回、0にすればリンク無し）。
 * 確率ではなくカウンタで判定し、実際にN回に1回へ寄せている。
 *
 * @return {boolean}
 */
const DEFAULT_LINK_EVERY = 5;

function shouldIncludeLink_(accountKey) {
  const key = String(accountKey).toUpperCase();
  const every = Number(getProp_('LINK_EVERY_' + key, String(DEFAULT_LINK_EVERY)));

  if (!every || every <= 0) return false;   // 0 なら常にリンク無し
  if (every === 1) return true;             // 1 なら毎回

  const counterKey = 'link_counter_' + key;
  const n = (Number(getProp_(counterKey, '0')) || 0) + 1;
  props_().setProperty(counterKey, String(n % every));

  // n が every の倍数になったときだけ貼る
  return (n % every) === 0;
}

/**
 * Linksシートから、対象アカウントに合致するリンクをランダムに1件返す。
 * シートが無い・該当が無い場合は null を返す（リンク無しで続行する）。
 * @return {?{url:string, note:string}}
 */
function pickRandomLink_(accountKey, ss) {
  const key = String(accountKey).toUpperCase();
  try {
    const spreadsheet = ss || openLogSpreadsheet_();
    const sheet = spreadsheet.getSheetByName(LINKS_SHEET_NAME);
    if (!sheet) {
      console.log('Linksシートが無いため、リンク無しで生成します。');
      return '';
    }

    const candidates = listLinkCandidates_(sheet, key);
    if (!candidates.length) return null;

    // ★A側もB側と同じ規約ゲートを通す。
    // 以前はここが素通りで、未確認のリンクがそのまま貼られる状態だった。
    // 収益化を進めるほど「確認済みのものだけ貼る」が効いてくる。
    const region = pickRegionByJstHour_();
    const usable = [];
    candidates.forEach(function (c) {
      const v = validateAffiliateLink_(c, region, key);
      if (v.ok) usable.push(c);
      else console.warn('リンクを除外(' + key + '): ' + v.reason + ' ' + truncate_(c.url, 60));
    });

    if (!usable.length) {
      console.log('検証を通るリンクが無いため、リンク無しで生成します(' + key + ')。');
      return null;
    }

    // Priority が高いものを優先。同点はランダム。
    let top = 0;
    usable.forEach(function (c) { top = Math.max(top, Number(c.priority) || 0); });
    const best = usable.filter(function (c) { return (Number(c.priority) || 0) === top; });
    return best[Math.floor(Math.random() * best.length)];

  } catch (err) {
    // リンクが取れないだけで投稿全体を落とす必要はない
    console.warn('Linksシートの読み取りに失敗（リンク無しで続行）: ' + err);
    return null;
  }
}

/**
 * Linksシートの行を、対象アカウント向けに絞って読み出す。
 *
 * 列が3つしか無い古いシートでも動くよう、実際の列数までしか読まない。
 * @return {Array<Object>}
 */
function listLinkCandidates_(sheet, accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const lastRow = sheet.getLastRow();
  if (lastRow < LINKS_FIRST_DATA_ROW) return [];

  const width = Math.max(3, Math.min(LINKS_TOTAL_COLUMNS, sheet.getLastColumn()));
  const values = sheet.getRange(LINKS_FIRST_DATA_ROW, 1,
                                lastRow - LINKS_FIRST_DATA_ROW + 1, width).getValues();

  const cell = function (row, col) {
    return width >= col ? String(row[col - 1] || '').trim() : '';
  };

  const boolCell = function (r, col) {
    const v = cell(r, col).toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === '有効';
  };

  return values.filter(function (r) {
    const url = cell(r, LINKS_COL_URL);
    if (!/^https?:\/\//i.test(url)) return false;          // URL形式でない行は除外
    const target = cell(r, LINKS_COL_TARGET).toUpperCase();
    return target === '' || target === key;                 // 空欄は両方が対象
  }).map(function (r, i) {
    const activeRaw = cell(r, LINKS_COL_ACTIVE).toLowerCase();
    return {
      row: LINKS_FIRST_DATA_ROW + i,
      url: cell(r, LINKS_COL_URL),
      // メモ列は「何のリンクか」をLLMに伝えるために使う。
      // ここが空だと、AIは行き先を知らないまま文章を書くことになり、
      // 文脈に織り込めず「本文＋URL」の不自然な形にしかならない。
      note: cell(r, LINKS_COL_NOTE),
      target: cell(r, LINKS_COL_TARGET).toUpperCase(),
      platform: cell(r, LINKS_COL_PLATFORM),
      category: cell(r, LINKS_COL_CATEGORY),
      geo: cell(r, LINKS_COL_GEO),
      productType: cell(r, LINKS_COL_PRODUCT_TYPE),
      priority: Number(cell(r, LINKS_COL_PRIORITY)) || 0,
      // 空欄は「有効」。無効にしたい時だけ明示的に書いてもらう（旧列。Statusと併用）。
      active: !(activeRaw === 'false' || activeRaw === '0' ||
                activeRaw === 'no' || activeRaw === '無効'),

      // ↓ §22 規約確認用フィールド。すべて「未入力＝false／未確認」が安全側の既定。
      affiliateUrl: cell(r, LINKS_COL_AFFILIATE_URL) || cell(r, LINKS_COL_URL),
      adult: boolCell(r, LINKS_COL_ADULT),
      affiliateAllowed: boolCell(r, LINKS_COL_AFFILIATE_ALLOWED),
      snsAllowed: boolCell(r, LINKS_COL_SNS_ALLOWED),
      xAllowed: boolCell(r, LINKS_COL_X_ALLOWED),
      automationAllowed: boolCell(r, LINKS_COL_AUTOMATION_ALLOWED),
      overseasAllowed: boolCell(r, LINKS_COL_OVERSEAS_ALLOWED),
      countryAllowed: {
        US: boolCell(r, LINKS_COL_US_ALLOWED),
        CA: boolCell(r, LINKS_COL_CA_ALLOWED),
        UK: boolCell(r, LINKS_COL_UK_ALLOWED),
        AU: boolCell(r, LINKS_COL_AU_ALLOWED)
      },
      disclosureRequired: boolCell(r, LINKS_COL_DISCLOSURE_REQUIRED),
      disclosureText: cell(r, LINKS_COL_DISCLOSURE_TEXT),
      verified: boolCell(r, LINKS_COL_VERIFIED),
      verificationSource: cell(r, LINKS_COL_VERIFICATION_SOURCE),
      verificationDate: cell(r, LINKS_COL_VERIFICATION_DATE),
      termsUrl: cell(r, LINKS_COL_TERMS_URL),
      riskLevel: cell(r, LINKS_COL_RISK_LEVEL),
      status: cell(r, LINKS_COL_STATUS).toUpperCase() || 'UNVERIFIED',
      lastUsed: cell(r, LINKS_COL_LAST_USED),
      cooldownUntil: cell(r, LINKS_COL_COOLDOWN_UNTIL),
      imageUrl: cell(r, LINKS_COL_IMAGE_URL)
    };
  });
}

/** Linksシートを取得する。無ければヘッダー付きで作る。 */
function getOrCreateLinksSheet_(ss) {
  const spreadsheet = ss || openLogSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(LINKS_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LINKS_SHEET_NAME);
    sheet.getRange(1, 1, 1, LINKS_HEADERS.length).setValues([LINKS_HEADERS]);
    sheet.getRange(1, 1, 1, LINKS_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  // 3列だけの古いシートに、後から足した列を補う（既存データは触らない）
  ensureTrailingHeaders_(sheet, LINKS_HEADERS);
  return sheet;
}

/**
 * Linksシートへ1件追加する。
 * @return {number} 追加した行番号
 */
function addLink_(url, note, target, opts) {
  const o = opts || {};
  const sheet = getOrCreateLinksSheet_();
  const row = Math.max(sheet.getLastRow() + 1, LINKS_FIRST_DATA_ROW);

  const rowValues = new Array(LINKS_TOTAL_COLUMNS).fill('');
  rowValues[LINKS_COL_URL - 1] = url;
  rowValues[LINKS_COL_NOTE - 1] = note || '';
  rowValues[LINKS_COL_TARGET - 1] = String(target || '').toUpperCase();
  rowValues[LINKS_COL_PLATFORM - 1] = o.platform || '';
  rowValues[LINKS_COL_CATEGORY - 1] = o.category || '';
  rowValues[LINKS_COL_GEO - 1] = o.geo || '';
  rowValues[LINKS_COL_PRODUCT_TYPE - 1] = o.productType || '';
  rowValues[LINKS_COL_PRIORITY - 1] = (o.priority === undefined || o.priority === null) ? '' : o.priority;
  // Active は空欄＝有効（旧列）。Status は既定で UNVERIFIED にする。
  // ★LINEや簡易APIから追加したリンクを、規約確認前に自動で使わせないための安全側デフォルト。
  rowValues[LINKS_COL_STATUS - 1] = o.status || 'UNVERIFIED';
  rowValues[LINKS_COL_ADULT - 1] = (o.adult === undefined) ? '' : (o.adult ? 'TRUE' : 'FALSE');

  sheet.getRange(row, 1, 1, LINKS_TOTAL_COLUMNS).setValues([rowValues]);
  SpreadsheetApp.flush();
  return row;
}

/** Linksシートの中身を返す。 */
function listLinks_() {
  const sheet = getOrCreateLinksSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < LINKS_FIRST_DATA_ROW) return [];

  const width = Math.max(3, Math.min(LINKS_TOTAL_COLUMNS, sheet.getLastColumn()));
  const values = sheet.getRange(LINKS_FIRST_DATA_ROW, 1,
                                lastRow - LINKS_FIRST_DATA_ROW + 1, width).getValues();
  const cell = function (r, col) { return width >= col ? String(r[col - 1] || '').trim() : ''; };

  return values.map(function (r, i) {
    const activeRaw = cell(r, LINKS_COL_ACTIVE).toLowerCase();
    return {
      row: LINKS_FIRST_DATA_ROW + i,
      url: cell(r, LINKS_COL_URL),
      note: cell(r, LINKS_COL_NOTE),
      target: cell(r, LINKS_COL_TARGET).toUpperCase(),
      platform: cell(r, LINKS_COL_PLATFORM),
      category: cell(r, LINKS_COL_CATEGORY),
      priority: Number(cell(r, LINKS_COL_PRIORITY)) || 0,
      active: !(activeRaw === 'false' || activeRaw === '0' ||
                activeRaw === 'no' || activeRaw === '無効')
    };
  }).filter(function (x) { return x.url; });
}

/** Linksシートの指定行を削除する。 */
function deleteLinkRow_(rowIndex) {
  const sheet = getOrCreateLinksSheet_();
  if (rowIndex < LINKS_FIRST_DATA_ROW || rowIndex > sheet.getLastRow()) {
    throw new Error('その行は存在しません: ' + rowIndex);
  }
  const url = sheet.getRange(rowIndex, LINKS_COL_URL).getValue();
  sheet.deleteRow(rowIndex);
  SpreadsheetApp.flush();
  return String(url || '');
}

/** Logシートへ1行追記する。失敗しても投稿処理は止めない。 */
function appendLogRow_(ss, row) {
  try {
    // 列の補完は getOrCreateLogSheet_ 側で済んでいる（責務を一箇所にまとめてある）
    getOrCreateLogSheet_(ss).appendRow(row);
  } catch (err) {
    console.warn('Logシートへの記録に失敗（処理は継続）: ' + err);
  }
}

/* ------------------------------------------------------------------ */
/* トリガー管理（エディタから手動実行する）                             */
/* ------------------------------------------------------------------ */

/**
 * ★これを1回だけ手動実行すると自動投稿が始まる。
 * processQueue を2時間おきに実行する時間主導トリガーを作成する。
 * 既存の同名トリガーは先に削除するため、複数回実行しても重複登録されない。
 */
function setupAutoPost() {
  try {
    const removed = deleteAutoPost();

    ScriptApp.newTrigger(QUEUE_TRIGGER_HANDLER)
      .timeBased()
      .everyHours(QUEUE_TRIGGER_INTERVAL_HOURS)
      .create();

    // ★誰が作ったトリガーなのかを必ず記録する。
    // これが無いと、別アカウントの幽霊トリガーを検出できない。
    const owner = rememberQueueTriggerOwner_();

    // 作り直した＝この実行の認可が新しいトリガーへ引き継がれた。
    // その認可でシートを開けるなら、迂回は不要になる。
    if (canOpenLogSpreadsheet_()) {
      props_().deleteProperty(DELEGATE_MODE_PROP);
      props_().deleteProperty(DELEGATE_NOTIFIED_PROP);
    }

    console.log([
      '✅ 自動投稿を開始しました。',
      '  実行アカウント: ' + (owner || '(取得不可)'),
      '  実行する関数: ' + QUEUE_TRIGGER_HANDLER,
      '  実行間隔    : ' + QUEUE_TRIGGER_INTERVAL_HOURS + '時間ごと',
      '  1回の実行で処理する行数: 1件',
      removed > 0 ? '  （既存のトリガー ' + removed + '件を置き換えました）' : '',
      '',
      '停止するには deleteAutoPost を実行してください。'
    ].filter(String).join('\n'));

  } catch (err) {
    console.error('setupAutoPost に失敗: ' + (err && err.stack ? err.stack : err));
    throw new Error('トリガーの作成に失敗しました: ' + (err && err.message ? err.message : err));
  }
}

/**
 * processQueue の時間主導トリガーを全て削除する（自動投稿の停止）。
 * @return {number} 削除した件数
 */
function deleteAutoPost() {
  let removed = 0;
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === QUEUE_TRIGGER_HANDLER) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    });
  } catch (err) {
    console.error('deleteAutoPost に失敗: ' + (err && err.stack ? err.stack : err));
    throw new Error('トリガーの削除に失敗しました: ' + (err && err.message ? err.message : err));
  }
  console.log('削除したトリガー: ' + removed + '件');
  return removed;
}

/* ------------------------------------------------------------------ */
/* 状態確認                                                            */
/* ------------------------------------------------------------------ */

/** 自動投稿の稼働状況とキューの残数を表示する。 */
function showAutoPostStatus() {
  const lines = ['📅 自動投稿の状況', ''];

  let triggerCount = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === QUEUE_TRIGGER_HANDLER) triggerCount++;
  });
  lines.push(triggerCount > 0
    ? '【トリガー】✅ 稼働中（' + triggerCount + '件 / ' + QUEUE_TRIGGER_INTERVAL_HOURS + '時間ごと）'
    : '【トリガー】❌ 未設定。setupAutoPost を実行してください');
  lines.push('');

  try {
    const ss = openLogSpreadsheet_();
    const sheet = getQueueSheet_(ss);
    const lastRow = sheet.getLastRow();

    let pending = 0, posted = 0, errored = 0, processing = 0, skipped = 0;
    if (lastRow >= QUEUE_FIRST_DATA_ROW) {
      const values = sheet.getRange(QUEUE_FIRST_DATA_ROW, 1, lastRow - QUEUE_FIRST_DATA_ROW + 1, 5).getValues();
      values.forEach(function (r) {
        const status = String(r[QUEUE_COL_STATUS - 1] || '').trim();
        const account = String(r[QUEUE_COL_ACCOUNT - 1] || '').trim();
        const content = String(r[QUEUE_COL_CONTENT - 1] || '').trim();
        if (status === '') { if (account || content) pending++; }
        else if (status === QUEUE_STATUS_POSTED) posted++;
        else if (status === QUEUE_STATUS_PROCESSING) processing++;
        else if (status === QUEUE_STATUS_SKIPPED_DUP) skipped++;
        else errored++;
      });
    }

    lines.push('【キュー】');
    lines.push('  未投稿: ' + pending + ' 件');
    lines.push('  投稿済: ' + posted + ' 件');
    lines.push('  重複スキップ: ' + skipped + ' 件');
    lines.push('  エラー: ' + errored + ' 件');
    if (processing > 0) {
      lines.push('  処理中: ' + processing + ' 件');
      lines.push('  ※「Processing」のまま残っている行は、投稿が成功したのに');
      lines.push('    シート更新前に実行が中断された可能性があります。');
      lines.push('    Xのタイムラインを確認し、未投稿ならC列を空にして再実行させてください。');
    }
    if (pending > 0) {
      const hours = pending * QUEUE_TRIGGER_INTERVAL_HOURS;
      lines.push('');
      lines.push('  現在の間隔だと、消化まで約 ' + hours + ' 時間（' +
                 (Math.round(hours / 24 * 10) / 10) + ' 日）かかります。');
    }
  } catch (err) {
    lines.push('【キュー】読み取り失敗: ' + (err && err.message ? err.message : err));
  }

  console.log(lines.join('\n'));
}

/** Logシートを集計し、地域×訴求角度ごとの投稿本数を出す。A/Bテストの確認用。 */
function showAbTestSummary() {
  try {
    const ss = openLogSpreadsheet_();
    const sheet = ss.getSheetByName(LOG_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) {
      console.log('Logシートにまだデータがありません。');
      return;
    }

    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, LOG_HEADERS.length).getValues();
    const tally = {};
    values.forEach(function (r) {
      const account = String(r[1] || '');
      const status = String(r[2] || '');
      const region = String(r[4] || '(なし)');
      const angle = String(r[5] || '(なし)');
      const format = String(r[6] || '(なし)');
      if (status !== QUEUE_STATUS_POSTED) return;
      const key = account + ' | ' + region + ' | ' + angle + ' | ' + format;
      tally[key] = (tally[key] || 0) + 1;
    });

    const keys = Object.keys(tally).sort();
    const lines = ['📊 A/Bテストの投稿本数（Account | Region | Angle | Format）', ''];
    if (!keys.length) lines.push('投稿成功の記録がまだありません。');
    keys.forEach(function (k) { lines.push('  ' + k + '  →  ' + tally[k] + ' 件'); });
    lines.push('', '※ここに出るのは投稿本数のみです。');
    lines.push('  クリック数・エンゲージメントは別途 /api/go 等の計測が必要です。');
    console.log(lines.join('\n'));

  } catch (err) {
    console.error('集計に失敗: ' + (err && err.message ? err.message : err));
  }
}
