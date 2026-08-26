/**
 * ===========================================================================
 * 04_WebApp.gs  —  doPost（LINE Webhook）/ doGet（認証開始・状態確認）
 * ===========================================================================
 */

/* ------------------------------------------------------------------ */
/* LINE Webhook                                                        */
/* ------------------------------------------------------------------ */

function doPost(e) {
  // 何があっても 200 を返す。500 を返すと LINE がリトライし、二重投稿を招く。
  try {
    // --- Webhook難読化ゲート -------------------------------------------
    // Apps Script の doPost は HTTP ヘッダを読めないため x-line-signature を検証できない。
    // 代替として、URLのクエリに載せた共有シークレットで発信元を絞る。
    // 不一致なら JSON のパースすら行わずに 200 を返して即終了する（探索者に情報を与えない）。
    if (!checkWebhookSecret_(e)) {
      return jsonOutput_({ ok: true });
    }
    // -------------------------------------------------------------------

    if (!e || !e.postData || !e.postData.contents) {
      return jsonOutput_({ ok: true, note: 'no body' });
    }

    // 正規の実行アカウントを、まだ記録していなければここで確定させる。
    //
    // Webアプリは executeAs: USER_DEPLOYING なので、必ずスクリプト所有者として動く。
    // そしてこの経路からはスプレッドシートを読めることが実際に確認できている。
    // つまり「シートを開ける主体」の正解がここにある。
    // これを控えておけば、以降は別アカウントのトリガーを自動で判別できる。
    seedQueueTriggerOwnerIfUnset_();

    // 委譲用トークンもここで用意しておく。
    // トリガー側からでも発行できるが、認可が壊れている環境では
    // 何が動かないか読みきれない。確実に動くこちらで先に作っておく。
    ensureTaskToken_();

    const body = JSON.parse(e.postData.contents);
    const events = body.events || [];   // 検証リクエストは events が空配列

    events.forEach(function (event) {
      try {
        handleLineEvent_(event);
      } catch (err) {
        console.error('イベント処理で例外: ' + (err && err.stack ? err.stack : err));
        try {
          replyToLine_(event.replyToken, '⚠️ 内部エラーが発生しました。\n' + truncate_(String(err), 300));
        } catch (e2) {}
      }
    });

    return jsonOutput_({ ok: true });

  } catch (err) {
    console.error('doPost で例外: ' + (err && err.stack ? err.stack : err));
    return jsonOutput_({ ok: false });
  }
}

/**
 * Webhook の共有シークレットを検証する。
 * @param {Object} e doPost のイベントオブジェクト
 * @return {boolean} true なら処理を継続してよい
 */
/* ------------------------------------------------------------------ */
/* 内部タスクの受け口（トリガーからの委譲専用）                          */
/* ------------------------------------------------------------------ */

/** 同じタスクを何秒あけずに受け付けないか。漏洩時の乱用を抑える。 */
const TASK_MIN_INTERVAL_SECONDS = 60;

/**
 * 文字列を先頭から順に比較せず、常に全長を見て突き合わせる。
 *
 * 通常の === は不一致が見つかった時点で返るため、
 * 応答時間の差から「何文字目まで合っていたか」を推測される余地がある。
 * トークンの照合ではそれを避ける。
 */
function timingSafeEquals_(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= (x.charCodeAt(i) ^ y.charCodeAt(i));
  }
  return diff === 0;
}

/**
 * トリガーから委譲されたタスクを実行する。
 *
 * 【この口を開けることの意味】
 * /exec は ANYONE_ANONYMOUS で公開されている。つまりURLを知っていれば誰でも叩ける。
 * そこで実処理を動かす以上、認証と流量制限を必ず掛ける。
 *
 *   1. 専用トークン(TASK_TOKEN)必須。LINE用の WEBHOOK_SECRET は流用しない。
 *      あちらは未設定でも通す作りで、そのままではジョブ実行口の認証にならない。
 *   2. トークンが未発行なら口を閉じる。認証なしでは絶対に実行しない。
 *   3. 一致しない場合は理由を返さない（総当たりの手がかりを与えない）。
 *   4. 最短間隔を設ける。URLが漏れても連打でクレジットを溶かされないようにする。
 *   5. 実行できるのは決められたタスクだけ。任意の関数は呼べない。
 */
function handleTaskRequest_(params) {
  const expected = getProp_(TASK_TOKEN_PROP, '');
  const given = String(params.task_token || '');

  // 未発行なら開けない。認証のないジョブ実行口を公開しないため。
  if (!expected || !given || !timingSafeEquals_(given, expected)) {
    console.warn('taskリクエストを拒否しました。given_length=' + given.length);
    return jsonOutput_({ ok: false });
  }

  const task = String(params.task || '');
  const throttleKey = 'task_last_' + task;
  const last = Number(getProp_(throttleKey, '0')) || 0;
  if ((Date.now() - last) < TASK_MIN_INTERVAL_SECONDS * 1000) {
    console.warn('taskリクエストが短時間に連続したためスキップ: ' + task);
    return jsonOutput_({ ok: true, skipped: 'throttled' });
  }
  props_().setProperty(throttleKey, String(Date.now()));

  if (task === 'queue') {
    try {
      // 本体を直接呼ぶ。processQueue を呼ぶと委譲判定に戻ってしまうため。
      // このコンテキストは認可が有効なので、判定を通す必要がない。
      processQueueCore_();
      return jsonOutput_({ ok: true, task: 'queue' });
    } catch (err) {
      console.error('委譲されたキュー処理で例外: ' + (err && err.stack ? err.stack : err));
      return jsonOutput_({ ok: false, task: 'queue' });
    }
  }

  if (task === 'metrics') {
    try {
      runDailyMetricsCore_();
      return jsonOutput_({ ok: true, task: 'metrics' });
    } catch (err) {
      console.error('委譲された計測処理で例外: ' + (err && err.stack ? err.stack : err));
      return jsonOutput_({ ok: false, task: 'metrics' });
    }
  }

  console.warn('未知のtask: ' + truncate_(task, 40));
  return jsonOutput_({ ok: false });
}

function checkWebhookSecret_(e) {
  const secret = getProp_('WEBHOOK_SECRET');

  // フェイルセーフ：未設定なら通す。設定を忘れた状態でBotが無反応になると
  // 原因の切り分けが難しくなるため、止めずに警告だけ残す。
  if (!secret) {
    console.warn(
      'WEBHOOK_SECRET が未設定のため、Webhookの発信元を検証せずに処理しています。' +
      'スクリプトプロパティに WEBHOOK_SECRET を登録し、LINEのWebhook URLへ ' +
      '?bot_token=<その値> を付与してください。'
    );
    return true;
  }

  const given = (e && e.parameter && e.parameter.bot_token) || '';
  if (given !== secret) {
    // 値そのものはログに残さない。残すと Cloud Logging から漏れる。
    console.warn('Webhookのbot_tokenが不一致のため破棄しました。given_length=' + String(given).length);
    return false;
  }
  return true;
}

function handleLineEvent_(event) {
  if (event.type !== 'message' || !event.message) return;

  /*
   * ★★動画・画像の添付を受け取る（2026-08-24、オーナー指示
   *   「LINEから添付追加できるように構築」）。
   *
   * これまでテキスト以外は無条件に捨てていた。素材を足す手段が
   * 「素材サイトの自動補充」しか無く、社長が「これを使え」と
   * 渡す方法が無かった。添付をそのまま在庫へ入れる。
   */
  const mtype = event.message.type;
  if (mtype !== 'text' && mtype !== 'video' && mtype !== 'image') return;

  // 再送イベントは処理しない（二重投稿の防止）
  if (event.deliveryContext && event.deliveryContext.isRedelivery) {
    console.warn('再送イベントのためスキップ: ' + event.webhookEventId);
    return;
  }
  if (!markEventProcessed_(event.webhookEventId)) {
    console.warn('処理済みイベントのためスキップ: ' + event.webhookEventId);
    return;
  }

  const userId = event.source && event.source.userId;
  const replyToken = event.replyToken;

  if (mtype !== 'text') {
    // ★許可された相手かどうかは、下のテキスト経路と同じ関門を通す
    if (!checkRateLimit_(userId)) return;
    if (!isAllowedLineUser_(userId)) {
      console.warn('許可されていないユーザーからの添付を破棄しました。');
      return;
    }
    replyToLine_(replyToken, ingestLineAttachment_(event.message.id, mtype, userId));
    return;
  }

  const rawText = event.message.text || '';

  // 流量制限。許可リストの判定より前に置く。
  // 弾いたことを相手に伝えると総当たりの手がかりになるため、返信せず黙って捨てる。
  if (!checkRateLimit_(userId)) {
    return;
  }

  if (!isAllowedLineUser_(userId)) {
    console.warn('未許可ユーザーからのメッセージ: ' + userId);
    replyToLine_(replyToken, 'このBotの利用は許可されていません。');
    return;
  }

  const command = parseCommand_(rawText);

  // 「Aに投稿」ボタン等で本文入力待ちの状態にしている場合、
  // 認識できないテキスト（＝コマンドではない自由な発言）はその本文として扱う。
  // 逆に、既知のコマンドを送ってきた場合は待機状態を解除して通常どおり処理する
  // （メインメニューのボタンで途中離脱できるようにするため）。
  const pending = getPendingAction_(userId);
  if (pending) {
    clearPendingAction_(userId);
    if (command.type === 'unknown') {
      handlePendingAnswer_(replyToken, pending, rawText);
      return;
    }
    // それ以外はそのまま下の switch へ流し、通常のコマンドとして処理する
  }

  switch (command.type) {
    case 'post':
      handlePostCommand_(replyToken, command.account, command.body);
      break;
    case 'link':
      handleLinkCommand_(replyToken, command.account);
      break;
    case 'status':
      replyToLine_(replyToken, buildStatusText_());
      break;
    case 'report':
      replyToLine_(replyToken, buildReportText_());
      break;
    case 'mode_quote':
      props_().setProperty('POST_MODE', 'quote');
      replyToLine_(replyToken, [
        '投稿モードを「引用のみ」にしました。',
        '',
        '出るのは次の2種類だけです。',
        '  ・引用リポスト … 引用元の写真が必ず付きます',
        '  ・情報源への反応 … 記事や動画のURLが付きます',
        '',
        '画像もURLも無い単独投稿は出しません。',
        '対象が見つからない回は、何も投稿せず次の回に回します。',
        '',
        '戻すときは「引用優先」と送ってください。'
      ].join('\n'));
      break;
    case 'mode_mixed':
      props_().setProperty('POST_MODE', 'mixed');
      replyToLine_(replyToken,
        '投稿モードを「引用優先」にしました。\n' +
        '引用 → 情報源反応 → 単独投稿 の順で試します。\n' +
        '対象が無い回は単独投稿（画像・URLなし）になります。');
      break;
    case 'mode_reset':
      props_().deleteProperty('POST_MODE');
      replyToLine_(replyToken,
        '投稿モードを既定（mixed）へ戻しました。\n' +
        '引用 → 情報源反応（RSS/YouTube） → 単独投稿 の優先順位で動きます。\n' +
        '「状態」で確認できます。');
      break;
    case 'unlink':
      resetService_(command.account);
      replyToLine_(replyToken,
        getAccount_(command.account).label + ' の連携を解除しました。\n' +
        '再度投稿するには「Xリンク ' + command.account + '」で連携し直してください。');
      break;
    case 'whoami':
      // ALLOWED_LINE_USER_IDS に登録する値を、エディタのログを見ずに取得できるようにする
      replyToLine_(replyToken,
        'あなたの LINE userId です。\n\n' + userId +
        '\n\nこれをスクリプトプロパティ ALLOWED_LINE_USER_IDS に登録すると、' +
        'あなた以外はこのBotを使えなくなります。' +
        (getProp_('ALLOWED_LINE_USER_IDS') ? '\n\n現在: 登録済み（許可リスト有効）' : '\n\n現在: 未登録（誰でも投稿できる状態）'));
      break;
    case 'stop':
      handleStopCommand_(replyToken);
      break;
    case 'start':
      handleStartCommand_(replyToken);
      break;
    case 'cap':
      handleCapCommand_(replyToken, command.value);
      break;
    case 'refill':
      handleRefillCommand_(replyToken, command.account, command.value);
      break;
    case 'refill_off':
      handleRefillOffCommand_(replyToken);
      break;
    case 'link_add':
      handleLinkAddCommand_(replyToken, command.account, command.url, command.note);
      break;
    case 'link_add_help':
      replyToLine_(replyToken,
        '書式が違います。対象（A か B）とURLが必要です。\n\n' +
        '例:\n' +
        'リンク追加 A https://example.com/lp メモ\n\n' +
        '※対象を必ず指定してください。指定を省くと、B用のリンクがAの投稿に' +
        '出てしまう恐れがあるため必須にしています。');
      break;
    case 'link_list':
      handleLinkListCommand_(replyToken);
      break;
    case 'link_delete':
      handleLinkDeleteCommand_(replyToken, command.row);
      break;
    case 'diag':
      replyToLine_(replyToken, buildAuthDiagnosticsText_());
      break;
    case 'help':
      replyToLine_(replyToken, helpText_());
      break;
    case 'post_malformed': {
      // 「Aに投稿」ボタン、またはコロン抜けの打ち間違い。
      // 本文入力待ちの状態にして、次のメッセージをそのまま本文として受け取る。
      const acc = getAccount_(command.account);
      setPendingAction_(userId, { action: 'post_body', account: command.account });
      replyToLine_(replyToken,
        '📝 ' + acc.label + ' に投稿する本文を送ってください。\n' +
        '（5分以内に送らないと自動でキャンセルされます）',
        cancelOnlyQuickReply_());
      break;
    }
    case 'post_auto':
      handlePostAutoCommand_(replyToken, command.account);
      break;
    case 'cancel':
      replyToLine_(replyToken, 'キャンセルしました。');
      break;
    case 'recent':
      handleRecentCommand_(replyToken, command.account, command.count);
      break;
    case 'diagnose':
      handleDiagnoseCommand_(replyToken, command.account);
      break;
    case 'diagnose_quote':
      replyToLine_(replyToken, diagnoseQuote_(command.account));
      break;
    case 'diagnose_sources':
      replyToLine_(replyToken, command.account
        ? diagnoseSources_(command.account)
        : Object.keys(ACCOUNTS).map(function (k) {
            try { return diagnoseSources_(k); }
            catch (e) { return '【' + k + '】診断に失敗: ' + truncate_(String(e), 80); }
          }).join('\n\n'));
      break;
    /*
     * ★バズ投稿を今すぐ1本出す（28_Buzz.gs）。
     *
     * 配分に任せると、いつバズの番が来るか分からない。
     * 実装した機能を確かめる手段が「待つ」しか無いのは運用として弱い。
     * ここから手で叩ければ、動くか動かないかが即座に分かる。
     */
    case 'buzz_now':
      replyToLine_(replyToken, runBuzzNowForLine_(command.account));
      break;
    case 'buzz_diag':
      replyToLine_(replyToken, buildBuzzDiagText_());
      break;
    // ★投稿せずに動画だけ作る／受け取る（36_Render.gs）
    case 'render_preview':
      replyToLine_(replyToken, requestPreviewFromLine_(command.account));
      break;
    case 'render_check':
      replyToLine_(replyToken, checkPreviewFromLine_(command.account));
      break;
    /*
     * ★スクリプトプロパティの管理（32_PropAdmin.gs）。
     * 設定画面が50件で頭打ちになったため、ここが正規の入口。
     */
    case 'setup_video':
      replyToLine_(replyToken, setupVideoFromLine_(command.key));
      break;
    case 'prop_set':
      replyToLine_(replyToken, setPropFromLine_(command.key, command.value));
      break;
    case 'prop_delete':
      replyToLine_(replyToken, deletePropFromLine_(command.key));
      break;
    case 'prop_list':
      replyToLine_(replyToken, buildPropListText_());
      break;
    case 'prop_help':
      replyToLine_(replyToken,
        '書式が違います。\n\n' +
        '登録・変更:\n  設定 キー名 値\n' +
        '  例) 設定 PEXELS_API_KEY abc123\n\n' +
        '削除:\n  設定削除 キー名\n\n' +
        '一覧:\n  設定一覧');
      break;
    case 'seedlinks':
      replyToLine_(replyToken, seedJapanLinksReport_());
      break;
    case 'rtcandidate':
      replyToLine_(replyToken, previewRetweetTarget_(command.account));
      break;
    case 'rtexecute':
      // ★ここだけが実際にXへ書き込む。他は全部読み取りのみ。
      replyToLine_(replyToken, attemptRetweet_(command.account, command.tweetId));
      break;
    case 'fullcheck':
      handleFullCheckCommand_(replyToken);
      break;
    case 'dryrun':
      handleDryRunCommand_(replyToken, command.account);
      break;
    case 'refill_set':
      props_().setProperty('AUTO_REFILL_' + command.account, String(command.value));
      replyToLine_(replyToken,
        'AUTO_REFILL_' + command.account + ' を ' + command.value + ' にしました。' +
        (command.value > 0
          ? '\nキューが空になったら' + command.value + '件ずつ自動生成されます。'
          : '\n0なので、このアカウントは自動投稿されなくなります。'));
      break;
    case 'setup':
      handleSetupCommand_(replyToken);
      break;
    case 'mention_on':
      handleMentionOnCommand_(replyToken, command.hours);
      break;
    case 'mention_off':
      handleMentionOffCommand_(replyToken);
      break;
    case 'mention_now':
      handleMentionNowCommand_(replyToken);
      break;

    case 'reply_draft':
      props_().setProperty('REPLY_DRAFT', command.on ? '1' : '0');
      replyToLine_(replyToken, command.on
        ? '✅ 返信案の生成をオンにしました。\nメンション通知に返信案が付きます（送信はしません）。'
        : '🔕 返信案の生成をオフにしました。\nメンション通知だけ届きます。');
      break;

    case 'emergency_stop':
      triggerEmergencyStop_(null, 'LINEから手動で停止しました。');
      replyToLine_(replyToken,
        '🛑 自動投稿を停止しました。\n' +
        'トリガーは残っていますが、投稿は行いません。\n' +
        '「再開」で戻せます。', mainMenuQuickReply_());
      break;

    case 'emergency_resume': {
      /*
       * ★クレジット切れ(402)で止まっていた場合は、解除する前に警告する。
       * 残高が無いまま再開しても次の投稿試行で必ず同じ402に戻り、
       * その試行分の呼び出しだけが消費される。
       * 実際に「再開→29分後に再停止」の往復が起きた（2026-08-18）。
       */
      const wasCredits = lastStopWasCredits_();
      const cleared = clearEmergencyStop_();

      if (wasCredits) {
        replyToLine_(replyToken, [
          '⚠️ 直前の停止はXのクレジット残高不足（402）でした。',
          '',
          // ★LINEはMarkdownを解釈しない。** を書くとそのまま画面に出る。
          '解除はしましたが、残高を購入していない場合はまた止まります。',
          '購入せずに再開すると、次の投稿試行ぶんの呼び出しだけが消費されます。',
          '',
          '購入: https://developer.x.com/en/portal/dashboard',
          '※クレジットはXのアカウントではなく Developer Portal の開発者アカウントに紐づきます。',
          '　両アプリが同じ開発者アカウント配下なら共有、分けているなら別々です。',
          '　購入画面でどちらか確認してください。',
          '',
          '購入済みならこのまま動きます。次のトリガーで投稿を試みます。'
        ].join('\n'), mainMenuQuickReply_());
        break;
      }

      // 緊急停止フラグはトリガーを消さない。だから「クリアした」＝「動く」ではない。
      // 「ストップ」でトリガー自体を削除していた場合、フラグだけ解除しても
      // 投稿は再開しない。誤って「再開しました」と言い切らないよう、実物を見て判定する。
      let triggerExists = false;
      try {
        triggerExists = ScriptApp.getProjectTriggers().some(function (t) {
          return t.getHandlerFunction() === QUEUE_TRIGGER_HANDLER;
        });
      } catch (e) { /* 取得できない場合は下の分岐で安全側の文言を出す */ }

      replyToLine_(replyToken,
        (triggerExists
          ? '▶️ 自動投稿を再開しました。\n解除した停止: ' + cleared + '\n' +
            '次回のトリガーから投稿を再開します。'
          : '✅ 停止フラグは解除しました（' + cleared + '）。\n' +
            '⚠️ ただし自動投稿トリガー自体が存在しません。\n' +
            '「スタート」も送ってトリガーを作成してください。'),
        mainMenuQuickReply_());
      break;
    }

    default:
      // 認識できない発言には返信しない。雑談まで拾うと鬱陶しいので黙る。
      console.log('コマンド以外のメッセージ: ' + truncate_(rawText, 80));
      break;
  }
}

/* ------------------------------------------------------------------ */
/* コマンド解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 対応する書式:
 *   「Aに投稿：本文」「Bに投稿:本文」   （全角/半角コロン両対応、改行を含む本文も可）
 *   「Xリンク A」「Xリンク B」          （認証URLの発行）
 *   「連携解除 A」
 *   「状態」「ステータス」
 *   「ヘルプ」
 */
function parseCommand_(rawText) {
  const text = normalizeInput_(rawText);

  let m = text.match(/^([AB])\s*に投稿\s*[:：]\s*([\s\S]+)$/i);
  if (m) {
    return { type: 'post', account: m[1].toUpperCase(), body: m[2].trim() };
  }

  // 「Aに投稿」で始まっているのにコロンが無い/本文が空など、投稿コマンドの書き損じ。
  // 完全に無視すると「打ち間違えたのか、Botが壊れているのか」判別できず不便なので、
  // 雑談への反応を増やさない範囲でヒントだけ返す。
  m = text.match(/^([AB])\s*に投稿/i);
  if (m) {
    return { type: 'post_malformed', account: m[1].toUpperCase() };
  }

  m = text.match(/^X\s*リンク\s*([AB])$/i);
  if (m) {
    return { type: 'link', account: m[1].toUpperCase() };
  }

  m = text.match(/^連携解除\s*([AB])$/i);
  if (m) {
    return { type: 'unlink', account: m[1].toUpperCase() };
  }

  // 「Aで自動投稿」… ボタンからのワンタップAI投稿。Linksからリンクを選び、Geminiで即生成して投稿する。
  m = text.match(/^([AB])で自動投稿$/i);
  if (m) return { type: 'post_auto', account: m[1].toUpperCase() };

  if (/^(キャンセル|cancel|やめる)$/i.test(text)) return { type: 'cancel' };

  // 投稿せずに生成だけ試す。「試作A」「試作B」
  m = text.match(/^試作\s*([AB])$/i);
  if (m) return { type: 'dryrun', account: m[1].toUpperCase() };

  // 日本製の商材候補をLinksシートへ追加する。「候補追加」
  if (/^(候補追加|候補|seed)$/i.test(text)) return { type: 'seedlinks' };

  /*
   * 素のリツイート（Native Retweet）の実地検証。2段階。
   *   RT候補A / RT候補B          … 検索するだけ。投稿しない
   *   RT実行A <id> / RT実行B <id> … 見せたIDを指定した時だけ実際に試す
   */
  m = text.match(/^RT候補\s*([AB])$/i);
  if (m) return { type: 'rtcandidate', account: m[1].toUpperCase() };

  m = text.match(/^RT実行\s*([AB])\s+(\d{5,25})$/i);
  if (m) return { type: 'rtexecute', account: m[1].toUpperCase(), tweetId: m[2] };

  // 全部まとめて見る。「点検」
  if (/^(点検|全部|チェック|check)$/i.test(text)) return { type: 'fullcheck' };

  /*
   * ★診断系はアカウントを前にも後ろにも書けるようにする（2026-08-18）。
   *
   * 投稿系は「Bで自動投稿」「Bに投稿」と前置きなのに、
   * 診断系は「診断B」と後置きだけを受け付けていた。
   * オーナーが自然に打った「B情報源診断」がどこにも一致せず、
   * 無反応のまま原因が分からない、という状態になった。
   *
   * 打ち方を覚えさせるより、どちらでも通す方が正しい。
   */
  const accountScoped_ = function (word) {
    const re = new RegExp('^(?:([AB])\\s*)?' + word + '\\s*([AB])?$', 'i');
    const hit = text.match(re);
    if (!hit) return null;
    const acc = hit[1] || hit[2] || '';
    return acc ? acc.toUpperCase() : '';
  };

  // YouTube / RSS が使えるか実際に叩いて確かめる。
  // 「情報源診断」「情報源診断B」「B情報源診断」
  let acc = accountScoped_('情報源診断');
  // ★アカウント無指定ならA/B両方見る。片方だけ出すと、
  //   出ていない方の原因に気づけない（実際にBがそうなった）。
  if (acc !== null) return { type: 'diagnose_sources', account: acc };

  /*
   * ★バズ関連は2つだけ（2026-08-22、オーナー指示「シンプルに」）。
   *
   * 「バズ材料」「ストック」「ストック補充」「参照投稿」を廃止した。
   * 機能を消したのではなく、覚える言葉を減らした：
   *   ・材料と在庫の状況 → 「バズ診断」に統合
   *   ・在庫の補充       → 自動（なくなり次第）と「初期設定」で足りる
   *   ・参照投稿         → 既定OFFで一度も使っていない
   *
   * 「バズ診断」を「バズ」より先に見る。逆にすると
   * accountScoped_('バズ') が「バズ診断」を食う。
   */
  acc = accountScoped_('バズ診断');
  if (acc !== null) return { type: 'buzz_diag' };

  /*
   * ★★「試作」… 投稿せずに動画だけ作って見せる（2026-08-24）。
   *
   * オーナー指示「あとから間違いでしたとか絶対に無いように」への答え。
   * こちらが「できました」と言うのではなく、実物を見て判断してもらう。
   * 「試作」で依頼、「試作確認」で出来上がりを受け取る。
   */
  acc = accountScoped_('試作確認');
  if (acc !== null) return { type: 'render_check', account: acc };

  acc = accountScoped_('試作');
  if (acc !== null) return { type: 'render_preview', account: acc };

  // 今すぐ1本出す。「バズ」「バズA」「Bバズ」
  acc = accountScoped_('バズ');
  if (acc !== null) return { type: 'buzz_now', account: acc };

  // 引用が動かない理由を実APIで確かめる。「引用診断」「引用診断B」「B引用診断」
  acc = accountScoped_('引用診断');
  if (acc !== null) return { type: 'diagnose_quote', account: acc || 'B' };

  // 「なぜ投稿されないのか」を切り分ける。「診断」「診断B」「B診断」
  acc = accountScoped_('診断');
  if (acc !== null) return { type: 'diagnose', account: acc };

  // 自動補充の件数を変える。「補充B 3」「補充A 0」
  m = text.match(/^補充\s*([AB])\s*(\d+)$/i);
  if (m) return { type: 'refill_set', account: m[1].toUpperCase(), value: Number(m[2]) };

  // 直近の投稿文をそのまま見る。
  // 品質を直すには現物が要る。Logシートを開かずLINEだけで確認できるようにする。
  // 「直近」「直近A」「直近B 5」
  m = text.match(/^直近\s*([AB])?\s*(\d+)?$/i);
  if (m) {
    return { type: 'recent',
             account: m[1] ? m[1].toUpperCase() : '',
             count: Math.min(Math.max(m[2] ? Number(m[2]) : 3, 1), 10) };
  }

  // 構築をLINE（＝スクリプト所有者のコンテキスト）から実行する。
  // エディタで別アカウントとして実行すると、Webアプリ/トリガーから開けないシートが
  // できてしまうため、こちらを正規の手順にする。
  if (/^(セットアップ|構築|setup|再構築)$/i.test(text)) return { type: 'setup' };

  // --- リプライ通知 ---
  // 「通知オン」「通知12時間」で間隔も指定できる
  m = text.match(/^通知\s*(\d+)\s*時間?$/);
  if (m) return { type: 'mention_on', hours: Number(m[1]) };
  if (/^通知\s*(?:オン|on|開始)$/i.test(text))              return { type: 'mention_on' };
  if (/^通知\s*(?:オフ|off|停止|なし|解除)$/i.test(text))   return { type: 'mention_off' };
  if (/^(メンション|リプライ|返信|mentions?)$/i.test(text)) return { type: 'mention_now' };

  // 返信案の生成を止める／再開する（自動返信ではなく、案を出すかどうか）
  if (/^返信案\s*(?:オフ|off|停止|なし)$/i.test(text)) return { type: 'reply_draft', on: false };
  if (/^返信案\s*(?:オン|on|開始)$/i.test(text))       return { type: 'reply_draft', on: true };

  // --- 緊急停止・再開（P1-11） ---
  //
  // ★「止めて」「再開」は下の自動投稿制御（ストップ/スタート）とは
  // 別の言葉にしてある。両方の候補に同じ語を入れると、先に評価される
  // こちらが常に勝ってしまい、下側のその語だけが永久に発火しなくなる
  // （実際に「再開」で起きていた：スタート側のトリガー再作成が呼ばれず、
  //   「再開しました」という表示だけ出て実際には止まったままになっていた）。
  //
  // 通知文はすべて緊急停止の解除語として「再開」を案内しているため、
  // こちらを正とする。トリガーの作り直しは案内どおり「スタート」を使う。
  if (/^(緊急停止|全停止|止めて|emergency)$/i.test(text)) return { type: 'emergency_stop' };
  if (/^(再開|復帰|resume|解除)$/i.test(text))            return { type: 'emergency_resume' };

  // --- 自動投稿の制御（トリガーそのものの作成/削除） ---
  if (/^(ストップ|すとっぷ|停止|stop)$/i.test(text))        return { type: 'stop' };
  if (/^(スタート|すたーと|開始|start)$/i.test(text))       return { type: 'start' };

  // 上限設定: 「上限100」「上限 100」「月100件」「キャップ100」
  m = text.match(/^(?:上限|キャップ|cap)\s*(\d+)\s*件?$/i) || text.match(/^月\s*(\d+)\s*件$/);
  if (m) return { type: 'cap', value: Number(m[1]) };

  if (/^(?:上限|キャップ|cap)\s*(?:なし|無し|解除|off|オフ)$/i.test(text)) {
    return { type: 'cap', value: 0 };
  }

  // 自動補充: 「補充A3」「補充 A 3」「補充なし」
  m = text.match(/^補充\s*([AB])\s*(\d+)$/i);
  if (m) return { type: 'refill', account: m[1].toUpperCase(), value: Number(m[2]) };

  if (/^補充\s*(?:なし|無し|停止|解除|off|オフ)$/i.test(text)) {
    return { type: 'refill_off' };
  }

  // --- リンク管理 ---
  // 「リンク追加 A https://... メモ」。対象(A/B)は必須にしている。
  // 空欄だと両アカウント共通になり、B用リンクがAに出る事故が起きるため。
  m = text.match(/^リンク追加\s*([AB])\s+(https?:\/\/\S+)\s*(.*)$/i);
  if (m) {
    return { type: 'link_add', account: m[1].toUpperCase(), url: m[2], note: (m[3] || '').trim() };
  }
  if (/^リンク追加/i.test(text)) return { type: 'link_add_help' };

  if (/^(リンク一覧|リンク|links)$/i.test(text)) return { type: 'link_list' };

  m = text.match(/^リンク削除\s*(\d+)$/i);
  if (m) return { type: 'link_delete', row: Number(m[1]) };

  /*
   * --- スクリプトプロパティの管理（32_PropAdmin.gs） ---
   *
   * ★2026-08-22、プロパティが69個に達し設定画面が読み取り専用になった。
   * 画面から登録できないので、ここを恒久的な入口にする。
   *
   * 「設定削除」を「設定」より先に見る。順序を逆にすると
   * 「設定削除 X」が「設定」コマンドとして食われる。
   */
  // 動画投稿に必要な設定を一度に済ませる。
  // 「初期設定 <キー>」。Pexels/Pixabayは形で自動判別。両方並べてもよい。
  m = text.match(/^初期設定\s*([\s\S]*)$/);
  if (m) return { type: 'setup_video', key: (m[1] || '').trim() };

  m = text.match(/^設定削除\s+(\S+)$/);
  if (m) return { type: 'prop_delete', key: m[1] };

  if (/^設定一覧$/.test(text)) return { type: 'prop_list' };

  // 値は空白を含み得る（URLやカンマ区切りリスト）ので、キー以降を全部値として取る
  m = text.match(/^設定\s+(\S+)\s+([\s\S]+)$/);
  if (m) return { type: 'prop_set', key: m[1], value: m[2] };

  if (/^設定/.test(text)) return { type: 'prop_help' };

  if (/^(状態|ステータス|status)$/i.test(text)) return { type: 'status' };
  // 投稿コスト・役割配分・Bファネルなど、数字を追いたい時だけ見る詳細。
  if (/^(レポート|実績|report)$/i.test(text)) return { type: 'report' };
  // POST_MODEが意図せず standalone のままだった場合の復旧コマンド。
  if (/^(反応優先に戻す|モード復旧|mode reset)$/i.test(text)) return { type: 'mode_reset' };
  // ★投稿モードの切替。引用のみにすると、画像もURLも無い単独投稿が出なくなる。
  if (/^(引用のみ|引用だけ|引用モード)$/i.test(text)) return { type: 'mode_quote' };
  if (/^(引用優先|通常モード)$/i.test(text)) return { type: 'mode_mixed' };
  if (/^(ヘルプ|help|使い方)$/i.test(text))    return { type: 'help' };
  if (/^(id|ID|アイディー|マイID)$/i.test(text)) return { type: 'whoami' };
  if (/^(診断|しんだん|diag|debug)$/i.test(text)) return { type: 'diag' };

  return { type: 'unknown' };
}

/* ------------------------------------------------------------------ */
/* コマンド実行                                                        */
/* ------------------------------------------------------------------ */

/**
 * LINEからの即時投稿をLogシートへ記録する。
 * スプレッドシート未設定でも投稿自体は成立させたいので、失敗しても握りつぶす。
 */
function logImmediatePost_(accountKey, status, text, generated, result) {
  try {
    if (!getProp_('LOG_SPREADSHEET_ID')) return;
    appendLogRow_(openLogSpreadsheet_(), buildLogRow_({
      account: accountKey,
      status: status,
      text: text,
      region: generated ? generated.region : '',
      angle: generated ? generated.angle : '',
      format: generated ? (generated.format || '') : '',
      postId: result ? result.id : '',
      hash: result ? result.contentHash : '',
      hasLink: result ? result.hasLink : undefined,
      cost: result ? result.costEstimate : undefined
    }));
  } catch (e) {
    console.warn('即時投稿のLog記録に失敗（投稿は成立）: ' + e);
  }
}

/** 「Aに投稿」ボタンで本文入力待ちにした後、実際に送られてきたテキストを処理する。 */
function handlePendingAnswer_(replyToken, pending, rawText) {
  if (pending.action === 'post_body') {
    const body = String(rawText || '').trim();
    if (!body) {
      replyToLine_(replyToken, '本文が空でした。もう一度送るか「キャンセル」と送ってください。');
      return;
    }
    handlePostCommand_(replyToken, pending.account, body);
    return;
  }
  // 未知の保留アクションは無視する（TTL切れ等で構造が変わった場合の保険）
}

/**
 * 「AでAI投稿」ボタン用。Linksからリンクを選び、Geminiで本文を生成してそのまま投稿する。
 * キューを介さない即時実行版（Scheduler の {AUTO} と同じ生成ロジックを使う）。
 */
function handlePostAutoCommand_(replyToken, accountKey) {
  const acc = getAccount_(accountKey);

  if (!getProp_('GEMINI_API_KEY') && !getProp_('LLM_API_KEY')) {
    replyToLine_(replyToken,
      '⚠️ GEMINI_API_KEY が未設定のため、AI投稿は使えません。\n' +
      '「' + accountKey + 'に投稿」から手動で本文を送ってください。');
    return;
  }

  let generated;
  try {
    // 毎回リンクを貼るとリーチが潰れるため、スケジューラと同じ比率判定を通す
    const link = shouldIncludeLink_(accountKey) ? pickRandomLink_(accountKey) : null;
    generated = generateTweet(accountKey, link, '');
  } catch (err) {
    replyToLine_(replyToken,
      '❌ ' + acc.label + ' の本文生成に失敗しました。\n' + String(err.message || err));
    return;
  }

  handlePostCommand_(replyToken, accountKey, generated.text, generated);
}

/**
 * @param {Object} [generated] AI生成の場合の {text, region, angle}。
 *   A/Bテストの集計から漏れないよう、キュー経由と同じ形式でLogへ記録する。
 */
function handlePostCommand_(replyToken, accountKey, body, generated) {
  const acc = getAccount_(accountKey);
  try {
    const result = postTweet_(accountKey, body);
    const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;
    const countLine = result.monthlyCount >= 0
      ? '\n今月の投稿数: ' + result.monthlyCount + (cap > 0 ? ' / ' + cap : '') + ' 件'
      : '';

    logImmediatePost_(accountKey, QUEUE_STATUS_POSTED, body, generated, result);

    replyToLine_(replyToken,
      '✅ ' + acc.label + ' に投稿しました。' +
      (generated ? '\n[' + generated.region + ' / ' + generated.angle +
                   (generated.format ? ' / ' + generated.format : '') + ']' : '') +
      (result.url ? '\n' + result.url : '') + countLine);

  } catch (err) {
    if (err instanceof DuplicatePostError) {
      replyToLine_(replyToken,
        '⏭ ' + acc.label + ' の直前の投稿と同じ本文のため、送信しませんでした。\n' +
        'Xは重複を拒否するので、送るとクレジットだけ消費されます。文面を変えてください。');
      return;
    }
    if (err instanceof DuplicateContentError) {
      replyToLine_(replyToken,
        '⏭ ' + acc.label + ' で過去' + HASH_HISTORY_DAYS + '日以内に同じ内容を投稿済みです。\n' +
        '二重投稿とクレジットの無駄を防ぐため送信しませんでした。文面を変えてください。');
      return;
    }
    if (err instanceof IndeterminatePostError) {
      // 投稿されたか分からない。ここで「失敗」と言い切ると再送されて二重投稿になる。
      logImmediatePost_(accountKey, QUEUE_STATUS_UNKNOWN, body, generated);
      replyToLine_(replyToken,
        '⚠️ ' + acc.label + ' への投稿結果を確認できませんでした。\n' +
        String(err.message || err) + '\n\n' +
        '同じ内容をもう一度送らないでください（二重投稿になります）。\n' +
        'Xのタイムラインを確認してください。');
      notifyAdmin_('⚠️ 投稿結果不明（LINE即時投稿）\nAccount: ' + accountKey + '\n' +
                   truncate_(String(err.message || err), 300));
      return;
    }
    if (err instanceof NeedsAuthError) {
      // 未連携ならその場で認証URLを出す。ユーザーに手順を思い出させない。
      let authUrl = '';
      try { authUrl = getAuthorizationUrl_(accountKey); } catch (e) {}
      replyToLine_(replyToken,
        '⚠️ ' + acc.label + ' が未連携、またはトークンが失効しています。\n' +
        '下記URLから連携してください。\n' + authUrl);
      return;
    }
    replyToLine_(replyToken, '❌ ' + String(err.message || err));
  }
}

function handleLinkCommand_(replyToken, accountKey) {
  const acc = getAccount_(accountKey);
  try {
    const already = isAuthorized_(accountKey);
    const url = getAuthorizationUrl_(accountKey);
    const username = getStoredUsername_(accountKey);

    replyToLine_(replyToken,
      '🔗 ' + acc.label + ' の連携URLです。\n' +
      (already ? '（現在すでに連携済み' + (username ? '：@' + username : '') +
                 'です。連携先を変える場合のみ実行してください）\n' : '') +
      '\n' + url +
      '\n\n※ ブラウザで開き、' + acc.label + ' の X アカウントでログインした状態で承認してください。' +
      '別アカウントでログイン中だとそちらに紐づいてしまいます。');

  } catch (err) {
    replyToLine_(replyToken, '❌ 連携URLの発行に失敗しました。\n' + String(err.message || err));
  }
}

/**
 * LINEから初期構築を実行する。
 * Webアプリはスクリプト所有者として動くため、ここで作ったシートとトリガーは
 * 必ずWebアプリと同じ実行主体になる。エディタ実行のようなアカウントずれが起きない。
 */
function handleSetupCommand_(replyToken) {
  try {
    const report = runBootstrap_();
    replyToLine_(replyToken, truncate_(report, 4500));
  } catch (err) {
    replyToLine_(replyToken, '❌ 構築に失敗しました。\n' + String(err.message || err));
  }
}

/* ------------------------------------------------------------------ */
/* リンク管理（LINEから操作する）                                       */
/* ------------------------------------------------------------------ */

function handleLinkAddCommand_(replyToken, accountKey, url, note) {
  try {
    const acc = getAccount_(accountKey);
    const row = addLink_(url, note, accountKey);
    const count = listLinks_().filter(function (l) {
      return l.target === accountKey || l.target === '';
    }).length;

    replyToLine_(replyToken,
      '✅ ' + acc.label + ' 用のリンクを追加しました（' + row + '行目）\n' +
      url + (note ? '\nメモ: ' + note : '') + '\n\n' +
      acc.label + ' で使えるリンク: ' + count + ' 件\n' +
      (note
        ? 'このメモをAIに渡すので、「その悩みを持つ人」に向けた文章を書きます。'
        : '⚠️ メモが未入力です。\n' +
          'AIは行き先を知らないまま書くことになり、商品を必要とする人に' +
          '刺さる文章になりません。\n' +
          '「リンク削除 ' + row + '」で消してから、\n' +
          'リンク追加 ' + accountKey + ' ' + url + ' 誰のどんな悩みを解決するか\n' +
          'の形で入れ直すことを勧めます。'));
  } catch (err) {
    replyToLine_(replyToken, '❌ 追加に失敗しました。\n' + String(err.message || err));
  }
}

function handleLinkListCommand_(replyToken) {
  try {
    const links = listLinks_();
    if (!links.length) {
      replyToLine_(replyToken,
        'リンクは1件も登録されていません。\n' +
        'この状態でもリンク無しの文章が生成されるので、投稿自体は動きます。\n\n' +
        '追加するには:\n' +
        'リンク追加 A https://example.com/lp メモ');
      return;
    }

    const lines = ['🔗 登録済みリンク（' + links.length + '件）', ''];
    links.forEach(function (l) {
      lines.push('[' + l.row + '] ' + (l.target || '⚠️A・B両方') +
                 (l.note ? ' … ' + l.note : ''));
      lines.push('  ' + l.url);
    });

    const noTarget = links.filter(function (l) { return !l.target; }).length;
    if (noTarget > 0) {
      lines.push('', '⚠️ 対象未指定が ' + noTarget + ' 件あります。');
      lines.push('B用リンクがAの投稿に出る恐れがあるので、');
      lines.push('スプレッドシートのC列を埋めるか、削除して登録し直してください。');
    }
    lines.push('', '削除: 「リンク削除 2」のように行番号を指定');

    replyToLine_(replyToken, lines.join('\n'));
  } catch (err) {
    replyToLine_(replyToken, '❌ 取得に失敗しました。\n' + String(err.message || err));
  }
}

function handleLinkDeleteCommand_(replyToken, row) {
  try {
    const url = deleteLinkRow_(row);
    replyToLine_(replyToken, '🗑 ' + row + '行目を削除しました。\n' + truncate_(url, 200));
  } catch (err) {
    replyToLine_(replyToken, '❌ 削除に失敗しました。\n' + String(err.message || err));
  }
}

/* ------------------------------------------------------------------ */
/* 自動投稿の制御（LINEから操作する）                                   */
/* ------------------------------------------------------------------ */

function handleStopCommand_(replyToken) {
  try {
    const removed = deleteAutoPost();
    replyToLine_(replyToken,
      removed > 0
        ? '🛑 自動投稿を停止しました（トリガー' + removed + '件を削除）。\n' +
          'キューの中身は消えていません。「スタート」で再開できます。'
        : '自動投稿はすでに停止しています。');
  } catch (err) {
    replyToLine_(replyToken, '❌ 停止に失敗しました。\n' + String(err.message || err));
  }
}

function handleStartCommand_(replyToken) {
  try {
    setupAutoPost();
    const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;

    /*
     * ★「スタート」と「再開」は別物なのに、同じ「止まっている」に見える。
     *
     * スタートが直すのはトリガー（時計）で、緊急停止フラグには触らない。
     * 2026-08-18、緊急停止が残ったままスタートした結果、
     * 「▶️ 自動投稿を開始しました」と答えた直後に
     * 「停止中です」で投稿が落ちた。開始したと言っておいて動いていない。
     *
     * 時計を動かしても止まったままなら、その場で言う。
     */
    const stillStopped = Object.keys(ACCOUNTS).filter(function (k) {
      return getProp_(accountStopProp_(k), '') === '1';
    });
    const whole = isEmergencyStopped_();

    const lines = [
      '▶️ 自動投稿を開始しました。',
      QUEUE_TRIGGER_INTERVAL_HOURS + '時間おきに1件ずつ投稿します。',
      '',
      cap > 0
        ? '月間上限: ' + cap + ' 件/アカウント'
        : '⚠️ 月間上限が未設定です。「上限100」のように送って設定してください。'
    ];

    if (whole || stillStopped.length) {
      lines.push('', '⚠️ ただし緊急停止が残っているため、まだ投稿されません。');
      if (whole) {
        lines.push('  全体: ' + truncate_(stopReasonFor_(null), 100));
      }
      stillStopped.forEach(function (k) {
        lines.push('  ' + k + ': ' + truncate_(stopReasonFor_(k), 100));
      });
      lines.push('', '→ 原因を直してから「再開」を送ってください。');
      // 402で止まっている場合は、放っておいても自動で復帰する
      const creditOnly = !whole && stillStopped.length &&
        stillStopped.every(function (k) { return lastStopWasCredits_(k); });
      if (creditOnly) {
        lines.push('（残高を入れた場合は、最大6時間以内に自動で再開します）');
      }
    }

    replyToLine_(replyToken, lines.join('\n'));
  } catch (err) {
    replyToLine_(replyToken, '❌ 開始に失敗しました。\n' + String(err.message || err));
  }
}

function handleCapCommand_(replyToken, value) {
  try {
    if (value > 0) {
      props_().setProperty('MONTHLY_SOFT_CAP', String(value));
      const usage = Object.keys(ACCOUNTS).map(function (k) {
        return '  ' + k + ': ' + getMonthlyCount_(k) + ' / ' + value + ' 件';
      }).join('\n');
      replyToLine_(replyToken,
        '✅ 月間上限を ' + value + ' 件/アカウント に設定しました。\n\n' +
        '今月の消化状況\n' + usage + '\n\n' +
        '上限に達すると投稿を拒否します。解除するには「上限なし」と送ってください。');
    } else {
      props_().deleteProperty('MONTHLY_SOFT_CAP');
      replyToLine_(replyToken,
        '⚠️ 月間上限を解除しました。\n' +
        '以後、件数の歯止めはありません。投稿ごとにXのクレジットを消費します。');
    }
  } catch (err) {
    replyToLine_(replyToken, '❌ 設定に失敗しました。\n' + String(err.message || err));
  }
}

function handleRefillCommand_(replyToken, accountKey, value) {
  try {
    const acc = getAccount_(accountKey);
    props_().setProperty('AUTO_REFILL_' + accountKey, String(value));
    const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;
    replyToLine_(replyToken,
      '✅ ' + acc.label + ' の自動補充を ' + value + ' 件に設定しました。\n' +
      'キューが空になると自動で ' + AUTO_TAG + ' 行が追加され、投稿が続きます。\n\n' +
      (cap > 0
        ? '月間上限: ' + cap + ' 件/アカウント'
        : '⚠️ 月間上限が未設定です。このままだと止まりません。\n「上限100」のように送って設定してください。'));
  } catch (err) {
    replyToLine_(replyToken, '❌ 設定に失敗しました。\n' + String(err.message || err));
  }
}

function handleRefillOffCommand_(replyToken) {
  try {
    Object.keys(ACCOUNTS).forEach(function (k) {
      props_().deleteProperty('AUTO_REFILL_' + k);
    });
    replyToLine_(replyToken,
      '✅ 自動補充を解除しました。\n' +
      'キューを消化しきったら、それ以上は投稿しません。');
  } catch (err) {
    replyToLine_(replyToken, '❌ 設定に失敗しました。\n' + String(err.message || err));
  }
}

/** 自動投稿まわりの状況を1ブロックにまとめる。状態表示から呼ぶ。 */
/**
 * 「状態」用。稼働しているか・詰まっていないかだけを見る。
 *
 * ★2026-08-16、大幅に削った。
 * トリガー実行者・月間上限・リンク挿入・自動補充・実行アカウント・
 * リプライ通知・投稿コスト・役割配分・Bファネルは全部ここに常時
 * 出していたが、これらは「診断」「点検」「レポート」で個別に確認できる
 * （診断はアカウントごとに自動補充・今月・今日・Geminiキーまで見せている）。
 * 「状態」に来る用件はほぼ「動いているか」だけなので、それ以外は
 * 問題がある時（⚠️）だけ出す形にした。詳しい実績は「レポート」を見る。
 */
function buildSchedulerStatusText_() {
  const lines = [];

  let triggers = 0;
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === QUEUE_TRIGGER_HANDLER) triggers++;
    });
  } catch (e) {
    return '\n【自動投稿】状態を取得できません: ' + e;
  }

  lines.push('\n【自動投稿】' + (triggers > 0
    ? '▶️ 稼働中（' + QUEUE_TRIGGER_INTERVAL_HOURS + '時間おき）'
    : '🛑 停止中'));

  // トリガーの持ち主がここと食い違うと「シートを開けません」になる。
  // 一致している間は何も言わない。問題がある時だけ出す。
  const triggerOwner = getProp_(QUEUE_TRIGGER_OWNER_PROP);
  const runningAs = getEffectiveUserEmail_();
  if (!triggerOwner) {
    lines.push('  ⚠️ トリガー実行者が未記録（セットアップを実行してください）');
  } else if (runningAs && triggerOwner.toLowerCase() !== runningAs.toLowerCase()) {
    lines.push('  ⚠️ トリガー実行者(' + triggerOwner + ')とこのアプリの実行者(' +
               runningAs + ')が不一致');
  }

  const sheetId = getProp_('LOG_SPREADSHEET_ID');
  if (!sheetId) {
    lines.push('  キュー残: ❌ LOG_SPREADSHEET_ID が未設定');
    lines.push('  → エディタで bootstrap を実行してください');
  } else {
    try {
      const ss = openLogSpreadsheet_();
      const sheet = getQueueSheet_(ss);
      const lastRow = sheet.getLastRow();
      let pending = 0, unknown = 0, posting = 0;
      if (lastRow >= QUEUE_FIRST_DATA_ROW) {
        const v = sheet.getRange(QUEUE_FIRST_DATA_ROW, 1, lastRow - QUEUE_FIRST_DATA_ROW + 1, 3).getValues();
        v.forEach(function (r) {
          const st = String(r[QUEUE_COL_STATUS - 1] || '').trim();
          const a = String(r[QUEUE_COL_ACCOUNT - 1] || '').trim();
          const c = String(r[QUEUE_COL_CONTENT - 1] || '').trim();
          if (st === '' && (a || c)) pending++;
          else if (st === QUEUE_STATUS_UNKNOWN) unknown++;
          else if (st === QUEUE_STATUS_POSTING) posting++;
        });
      }
      lines.push('  キュー残: ' + pending + ' 件');
      if (posting > 0) lines.push('  送信中: ' + posting + ' 件');
      // UNKNOWNは放置すると溜まる一方なので、0件でない時だけ強く出す。
      if (unknown > 0) {
        lines.push('  ⚠️ 投稿結果不明: ' + unknown + ' 件（要確認・自動再投稿しません）');
      }
    } catch (e) {
      lines.push('  キュー残: ❌ 読めません');
      lines.push('  → ' + truncate_(String(e && e.message ? e.message : e), 250));
      lines.push('  ※ シートを作ったアカウントと、実行アカウントが');
      lines.push('    一致しているか確認してください。');
    }
  }
  lines.push('  詳しい実績・費用・配分は「レポート」で見られます。');

  return lines.join('\n');
}

/**
 * 「レポート」用。投稿コスト・役割配分・Bファネルなど、
 * 数字を追いたい時だけ見る詳細。日常の「状態」からは分離してある。
 */
function buildReportText_() {
  const sheetId = getProp_('LOG_SPREADSHEET_ID');
  if (!sheetId) return 'LOG_SPREADSHEET_ID が未設定のため集計できません。';

  let ss;
  try {
    ss = openLogSpreadsheet_();
  } catch (e) {
    return 'シートを読めませんでした: ' + truncate_(String(e && e.message ? e.message : e), 200);
  }

  const lines = ['📈 レポート（' + nowMonthKey_() + '）'];
  // ★投稿の種類の配分を最初に出す。フェーズ（種まき/販売）が
  // ここで分かると、以降の数字の読み方が決まるため。
  try {
    lines.push(buildPostMixText_(ss));
  } catch (e) {
    console.warn('配分の表示に失敗（レポートは続行）: ' + e);
  }
  lines.push(buildCostSummaryText_(ss));
  Object.keys(ACCOUNTS).forEach(function (k) {
    lines.push(buildRoleSummaryText_(ss, k));
  });
  lines.push(buildBFunnelStatusText_());
  return lines.join('\n');
}

function buildStatusText_() {
  const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;
  const lines = ['📊 連携状況（' + nowMonthKey_() + '）'];

  /*
   * ★投稿モードを必ず先頭で見せる（2026-08-16追加）。
   *
   * 過去に POST_MODE を 'standalone' へ自動で書き換える実装があり、
   * それが発動すると引用サイクルだけでなく情報源投稿（RSS/YouTube反応）
   * まで丸ごと止まっていた。しかもこの値はどの日常的な診断
   * （状態・点検）にも出ておらず、気づく手段が無かった。
   * この実装は撤去済みだが、過去に一度でも発動していれば
   * POST_MODE=standalone がスクリプトプロパティに残ったままの可能性がある。
   * 毎回ここに出すことで、二度と静かに沈黙しないようにする。
   */
  const mode = postMode_();
  if (mode === 'standalone') {
    lines.push('⚠️ 投稿モード: standalone（引用も情報源反応も行わず、単独投稿のみ）');
    lines.push('   意図的な設定でなければ、スクリプトプロパティの POST_MODE を');
    lines.push('   削除するか mixed にしてください。');
  } else {
    lines.push('✅ 投稿モード: ' + mode);
  }
  Object.keys(ACCOUNTS).forEach(function (key) {
    if (isQuoteBlocked_(key)) {
      lines.push('   ℹ️ ' + key + ': 引用は権限で使えません（自動でリツイートに切替済み）');
    }
  });
  lines.push('');

  const seen = {};
  Object.keys(ACCOUNTS).forEach(function (key) {
    const acc = ACCOUNTS[key];
    const ok = isAuthorized_(key);
    // 連携時に users/me が失敗しているとユーザー名が空になり、A と B の区別がつかない。
    // 未取得なら実際に問い合わせて確定させ、次回以降のために保存する。
    let username = getStoredUsername_(key);
    if (ok && !username) {
      try {
        username = fetchXUsername_(key) || '';
        if (username) getXService_(key).getStorage().setValue('username', username);
      } catch (e) {
        console.warn('users/me の再取得に失敗 (' + key + '): ' + e);
      }
    }
    if (username) seen[username] = (seen[username] || 0) + 1;
    const count = getMonthlyCount_(key);

    const block = [
      '\n[' + key + '] ' + acc.label,
      '  連携: ' + (ok ? '✅ 済' + (username ? '（@' + username + '）' : '（ユーザー名取得不可）') : '❌ 未'),
      '  今月: ' + count + (cap > 0 ? ' / ' + cap : '') + ' 件'
    ];

    // 固定した投稿先。ここがズレていると別アカウントへ投稿してしまう。
    const pinned = getProp_(expectedUsernameProp_(key), '');
    if (pinned) block.push('  投稿先固定: @' + pinned);

    if (getProp_(accountStopProp_(key), '') === '1') {
      block.push('  🛑 このアカウントは停止中（「再開」で解除）');
    }
    lines.push(block.join('\n'));
  });

  // 同じXアカウントが複数の枠に紐づいていたら警告する（ブラウザのセッション混在で起きやすい）
  const dup = Object.keys(seen).filter(function (u) { return seen[u] > 1; });
  if (dup.length) {
    lines.push('\n⚠️ 同じアカウント(@' + dup.join(', @') + ')が複数の枠に紐づいています。' +
               '該当する枠を resetA / resetB で解除してやり直してください。');
  }

  // 稼働状態は一番上に近い位置で見たいので、スケジューラ情報の直前に置く
  lines.push('\n【システム】' + emergencyStopStatusText_());

  Object.keys(ACCOUNTS).forEach(function (k) {
    const errs = consecutiveErrorCount_(k);
    if (errs > 0) {
      lines.push('  連続エラー[' + k + ']: ' + errs + ' / ' + CONSECUTIVE_ERROR_LIMIT + '（上限で自動停止）');
    }
  });
  if (getProp_(DELEGATE_MODE_PROP, '') === '1') {
    lines.push('  実行経路: 🔁 迂回中（トリガーの認可が古いためWebアプリで実行）');
    lines.push('    → 投稿は正常です。直すならエディタで setupAutoPost を1回実行');
  }
  // ★Geminiモデル・返信案の設定は「診断」に譲り、ここでは常時表示しない
  // （2026-08-16、状態を簡潔にするため。問題があるわけではない設定は削る）。

  lines.push(buildSchedulerStatusText_());
  return lines.join('\n');
}

/**
 * 直近に投稿した本文をそのまま返す。
 *
 * ★品質を直すには現物が要る。
 * 「なんとなく品質が低い」では原因が特定できず、プロンプトを推測で
 * いじることになる。実際に出た文を読めば、硬いのか、薄いのか、
 * 型が崩れているのかが1回で分かる。
 * Logシートを開かなくてもLINEだけで確認・転送できるようにしてある。
 */
function handleRecentCommand_(replyToken, accountFilter, count) {
  let rows;
  try {
    const ss = openLogSpreadsheet_();
    const sheet = ss.getSheetByName(LOG_SHEET_NAME);
    if (!sheet) {
      replyToLine_(replyToken, 'Logシートがまだありません。');
      return;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      replyToLine_(replyToken, 'まだ投稿の記録がありません。');
      return;
    }
    // 直近200行だけ見る。全件読むとシートが育った時に遅くなる。
    const from = Math.max(2, lastRow - 199);
    rows = sheet.getRange(from, 1, lastRow - from + 1, LOG_COL_POST_TYPE).getValues();
  } catch (e) {
    replyToLine_(replyToken, 'Logを読めませんでした。\n' + truncate_(String(e), 150));
    return;
  }

  const wanted = rows.filter(function (r) {
    const acct = String(r[LOG_COL_ACCOUNT - 1] || '').toUpperCase();
    const text = String(r[LOG_COL_POST_TEXT - 1] || '').trim();
    if (!text) return false;
    if (accountFilter && acct !== accountFilter) return false;
    return String(r[LOG_COL_STATUS - 1] || '').toLowerCase().indexOf('post') === 0;
  }).reverse().slice(0, count);

  if (!wanted.length) {
    replyToLine_(replyToken,
      '該当する投稿が見つかりませんでした' + (accountFilter ? '（' + accountFilter + '）' : '') + '。');
    return;
  }

  const out = wanted.map(function (r, i) {
    const score = r[LOG_COL_QUALITY - 1];
    const type = String(r[LOG_COL_POST_TYPE - 1] || '');
    const head = '── ' + (i + 1) + '. [' + String(r[LOG_COL_ACCOUNT - 1] || '?') + ']' +
                 (type ? ' ' + type : '') +
                 (score !== '' && score != null ? ' ' + score + '点' : '');
    return head + '\n' + String(r[LOG_COL_POST_TEXT - 1] || '');
  });

  replyToLine_(replyToken, out.join('\n\n'));
}

/**
 * 「なぜこのアカウントが投稿していないのか」を上から順に調べる。
 *
 * ★投稿が出ない理由は7つあり、どれも症状が同じ（何も起きない）。
 * 「動いていない」だけでは切り分けられないので、
 * 止まっている場所を1回で特定できるようにする。
 */
function diagnoseAccount_(key) {
  const lines = ['【' + key + ' 診断】'];
  let blocker = '';

  // 1. X連携
  let linked = false;
  try { linked = getXService_(key).hasAccess(); } catch (e) {}
  lines.push((linked ? '✅' : '❌') + ' X連携: ' + (linked ? '済' : '未連携'));
  if (!linked && !blocker) blocker = '「Xリンク ' + key + '」で連携してください。';

  // 2. 停止状態
  const stopped = isAccountStopped_(key);
  lines.push((stopped ? '❌' : '✅') + ' 稼働: ' + (stopped ? '停止中' : '正常'));
  if (stopped && !blocker) blocker = '「再開」で解除できます。';

  // 3. 月間上限
  const cap = Number(getProp_('MONTHLY_SOFT_CAP', '0')) || 0;
  const used = getMonthlyCount_(key);
  const over = isOverMonthlyCap_(key);
  lines.push((over ? '❌' : '✅') + ' 今月: ' + used + (cap > 0 ? ' / ' + cap : ' （上限なし）'));
  if (over && !blocker) blocker = '今月の上限に達しています。「上限なし」または翌月まで待機。';

  // 3b. 今日のぶん。上限だけ見ていると月末に沈黙することに気づけない。
  if (cap > 0 && !over) {
    const allowance = dailyPostAllowance_(key);
    const todayUsed = getDailyCount_(key);
    const paced = isOverDailyPace_(key);
    lines.push((paced ? 'ℹ️' : '✅') + ' 今日: ' + todayUsed + ' / ' + allowance + ' 件' +
               (paced ? '（本日分は消化済。明日また出ます）' : ''));
  }

  // 4. Geminiキー（{AUTO}の生成に必須）
  const hasKey = !!(getProp_('GEMINI_API_KEY') || getProp_('LLM_API_KEY'));
  lines.push((hasKey ? '✅' : '❌') + ' Geminiキー: ' + (hasKey ? '設定済' : '未設定'));
  if (!hasKey && !blocker) blocker = 'GEMINI_API_KEY をスクリプトプロパティに設定してください。';

  // 5. 自動補充の設定 ★ここが0だと、キューに行が一切作られず永久に投稿されない
  const refillRaw = getProp_("AUTO_REFILL_" + key, "");
  const refill = (refillRaw === "" || refillRaw === null) ? AUTO_REFILL_DEFAULT : (Number(refillRaw) || 0);
  lines.push((refill > 0 ? '✅' : '❌') + ' 自動補充: AUTO_REFILL_' + key + ' = ' + refill);
  if (refill <= 0 && !blocker) {
    blocker = 'AUTO_REFILL_' + key + ' が0です。これが0だとキューに行が作られず、' +
              'このアカウントは永久に投稿しません。「補充' + key + ' 3」で設定できます。';
  }

  // 6. キューの未処理行
  let pending = 0;
  try {
    const sheet = getQueueSheet_(openLogSpreadsheet_());
    const lastRow = sheet.getLastRow();
    if (lastRow >= QUEUE_FIRST_DATA_ROW) {
      const v = sheet.getRange(QUEUE_FIRST_DATA_ROW, 1,
                               lastRow - QUEUE_FIRST_DATA_ROW + 1, QUEUE_TOTAL_COLUMNS).getValues();
      pending = v.filter(function (r) {
        return String(r[QUEUE_COL_STATUS - 1] || '').trim() === '' &&
               String(r[QUEUE_COL_ACCOUNT - 1] || '').trim().toUpperCase() === key;
      }).length;
    }
  } catch (e) {
    lines.push('⚠️ Queueを読めません: ' + truncate_(String(e), 80));
  }
  lines.push((pending > 0 ? '✅' : '⚠️') + ' 未処理キュー: ' + pending + '件');

  // 7. Bだけ：規約ゲートを通るリンクがあるか
  if (key === 'B') {
    try {
      const cands = listLinkCandidates_(getOrCreateLinksSheet_(), 'B');
      const usable = cands.filter(function (c) {
        return validateAffiliateLink_(c, 'US').ok;
      }).length;
      lines.push('ℹ️ 使えるリンク: ' + usable + ' / ' + cands.length + '件');
      if (cands.length && !usable) {
        lines.push('   （未確認のためリンク無し投稿のみ。投稿自体は出ます）');
      }
    } catch (e) {}
  }

  lines.push('');
  lines.push(blocker ? '▶ ' + blocker : '▶ 投稿を止めている設定は見つかりませんでした。');
  return lines.join('\n');
}

function handleDiagnoseCommand_(replyToken, accountFilter) {
  const keys = accountFilter ? [accountFilter] : Object.keys(ACCOUNTS);
  const out = keys.map(function (k) { return diagnoseAccount_(k); });
  replyToLine_(replyToken, out.join('\n\n'));
}

/**
 * 投稿せずに1本だけ生成して見せる。
 *
 * ★品質を直すのに、2時間待って結果を見るのは遅すぎる。
 * その場で作らせて、通ったか落ちたかを理由ごと返す。
 */
function handleDryRunCommand_(replyToken, accountKey) {
  const key = String(accountKey || 'A').toUpperCase();
  let out;
  try {
    out = generateTweet(key, null, '');
  } catch (err) {
    if (err && err.name === 'QualityFloorError') {
      replyToLine_(replyToken,
        '【' + key + ' 試作】基準未達で見送り\n\n' +
        err.message + '\n\n' +
        'この状態では自動投稿も出ません。もう一度「試作' + key + '」で引き直せます。');
      return;
    }
    replyToLine_(replyToken, '【' + key + ' 試作】生成に失敗\n\n' +
                             truncate_(String(err && err.message ? err.message : err), 400));
    return;
  }

  replyToLine_(replyToken, [
    '【' + key + ' 試作】' + (out.qualityScore || '?') + '点 / 基準' + qualityMinScore_() + '点',
    '角度: ' + (out.angle || '-') + ' / ' + (out.region || '-'),
    '文字数: ' + estimateWeightedLength_(out.text),
    '',
    out.text,
    '',
    '※これは投稿していません。'
  ].join('\n'));
}

/**
 * 全部まとめて点検する。
 *
 * ★コマンドを覚えなくても、これ1つで現状が分かるようにする。
 * 「診断」「引用診断」「情報源診断」「試作」を個別に打たせるのは、
 * 何が問題か分かっている人向けの設計だった。
 * 分からない状態から始められる入口を用意する。
 */
function handleFullCheckCommand_(replyToken) {
  const out = [];

  /*
   * 0. 投稿モードを最初に見せる。
   * ★ここに無かったせいで、POST_MODEが意図せず変わっていても
   * 「点検」だけでは一度も気づけなかった（2026-08-16に発見）。
   */
  const mode = postMode_();
  out.push(
    (mode === 'standalone'
      ? '⚠️ 投稿モード: standalone（引用も情報源反応も行わず、単独投稿のみ）'
      : '✅ 投稿モード: ' + mode) +
    Object.keys(ACCOUNTS).filter(isQuoteBlocked_).map(function (k) {
      return '\nℹ️ ' + k + ': 引用は権限で使えません（自動でリツイートに切替済み）';
    }).join('')
  );

  /*
   * 0. 直近のサイクルで実際に投稿できているか（26_Watchdog.gs）。
   *
   * ★点検でいちばん先に見るべき数字。
   * 設定が全て正常でも投稿がゼロ、という状態を何度も踏んだ。
   * 個別の設定より「結局出ているのか」を先に出す。
   */
  try {
    const health = buildCycleHealthText_();
    if (health) out.push(health);
  } catch (e) {
    out.push('サイクルの記録を読めませんでした: ' + truncate_(String(e), 80));
  }

  /*
   * 0-2. 採点の分布（16_Quality.gs）。
   *
   * ★「基準が厳しすぎるのか」を感覚で議論しないために出す。
   * 落ちた案が基準の10点以内に集まっているのか、
   * ずっと下に散っているのかで、直す場所が変わる。
   */
  // 0-1. X検索の消費（課金対象。見えないと増える）
  try { out.push(buildXSearchCostText_()); }
  catch (e) { out.push('X検索の回数を読めませんでした: ' + truncate_(String(e), 60)); }

  try {
    const scores = buildQualityScoreText_();
    if (scores) out.push(scores);
  } catch (e) {
    out.push('採点の記録を読めませんでした: ' + truncate_(String(e), 80));
  }

  // 1. アカウントが投稿できる状態か
  Object.keys(ACCOUNTS).forEach(function (k) {
    try { out.push(diagnoseAccount_(k)); }
    catch (e) { out.push('【' + k + '】診断に失敗: ' + truncate_(String(e), 100)); }
  });

  // 2. 話題をどこから取れるか
  // ★A固定だった。Bが出ていない時に気づけない
  try { Object.keys(ACCOUNTS).forEach(function (k) { out.push(diagnoseSources_(k)); }); }
  catch (e) { out.push('情報源の確認に失敗: ' + truncate_(String(e), 100)); }

  /*
   * 3. 記事への反応を実際に1本書いてみせる（投稿はしない）。
   *
   * ★点検で最初に見るべきものはこれ。
   * POST_MODE=mixed では記事への反応が主経路で、単独投稿は
   * 反応が取れなかった回の予備でしかない。
   * ここに単独投稿しか出していなかったため、反応投稿を一度も
   * 目にしないまま「何も変わっていない」ように見えていた。
   */
  try {
    out.push(previewSourcePost_('A'));
  } catch (err) {
    out.push('【A 反応試作】生成に失敗\n' +
             truncate_(String(err && err.message ? err.message : err), 300));
  }

  // 4. 単独投稿（反応が取れなかった回の予備経路）
  try {
    const sample = generateTweet('A', null, '');
    out.push('【A 単独試作】' + (sample.qualityScore || '?') + '点 — 投稿できる状態です\n\n' +
             sample.text);
  } catch (err) {
    if (err && err.name === 'QualityFloorError') {
      out.push('【A 単独試作】基準未達で見送り\n' + err.message +
               '\n※単独は予備経路です。上の反応試作が出ていれば投稿は回ります。');
    } else {
      out.push('【A 単独試作】生成に失敗\n' + truncate_(String(err && err.message ? err.message : err), 300));
    }
  }

  replyToLine_(replyToken, out.join('\n\n────────\n\n'));
}

function helpText_() {
  return [
    '使えるコマンド',
    '（下のボタンからタップでも送れます）',
    '',
    '▼ 投稿',
    '  Aに投稿：本文',
    '  Bに投稿：本文',
    '  （コロンは全角・半角どちらでも可。本文の改行もそのまま反映されます）',
    '  Aに投稿 … コロン無しで送ると、本文入力待ちになります',
    '  Aで自動投稿 … GeminiでAIが本文を書いてそのまま投稿します',
    '',
    '▼ まず困ったらこれ',
    '  点検      … 全部まとめて確認（これ1つでOK）',
    '  状態      … 稼働しているか・詰まっていないかだけを見る',
    '  レポート   … 投稿コスト・役割配分・Bファネルなど詳しい数字',
    '',
    '▼ 動いていない時',
    '  試作A     … 投稿せずに1本だけ生成して見せる',
    '  候補追加   … 日本製の商材候補をLinksシートへ入れる（未検証・下書き）',
    '  RT候補A   … 素のリツイート対象を検索するだけ（投稿しない）',
    '  RT実行A <id> … RT候補で見せたIDを実際にリツイート（1回・外部に見える）',
    '  引用のみ   … 引用RT（写真つき）と情報源反応（URLつき）だけを出す',
    '  引用優先   … 上記に加えて、対象が無い回は単独投稿も出す',
    '  反応優先に戻す … POST_MODEがstandaloneのままだった場合の復旧',
    '  診断      … A/Bが投稿しない原因を上から順に調べる',
    '  引用診断B … 引用RTが動かない原因を実APIで確かめる',
    '  情報源診断 … YouTube/RSSから話題を拾えるか確かめる（A/B両方）',
    '  B情報源診断 … 片方だけ見る（「情報源診断B」でも可）',
    '  バズ      … 動画付きの投稿を今すぐ1本出す',
    '  バズ診断  … 出せない原因があれば、それだけを表示',
    '  診断B     … Bだけ調べる',
    '  補充B 3   … Bの自動生成を3件/回にする（0だと投稿されません）',
    '',
    '▼ 投稿内容の確認',
    '  直近      … 直近3件の投稿文をそのまま表示',
    '  直近A 5   … Aの直近5件（1〜10件）',
    '',
    '▼ 初回連携／再連携',
    '  Xリンク A',
    '  Xリンク B',
    '',
    '▼ リンク管理',
    '  リンク追加 A https://... 誰のどんな悩みを解決するか',
    '  ※メモは必ず書いてください。AIがこれを読んで',
    '    「その悩みを持つ人」向けに書き分けます',
    '  リンク一覧 … 登録済みを表示',
    '  リンク削除 2 … 行番号で削除',
    '',
    '▼ 初期構築',
    '  セットアップ … シート作成・トリガー設定を一括実行',
    '  ※必ずLINEから実行してください（エディタ実行はアカウントずれの原因）',
    '',
    '▼ リプライ通知',
    '  メンション … 今すぐ新着を確認',
    '  通知オン   … 定期確認を開始（既定8時間おき）',
    '  通知12時間 … 間隔を指定して開始',
    '  通知オフ   … 停止',
    '  返信案オフ … 返信案の生成を止める（通知は続く）',
    '  ※返信はXアプリから。自動返信はしません',
    '  ※Xは読み取りにも課金されます',
    '',
    '▼ 緊急時',
    '  緊急停止 … 投稿を即座に止める（トリガーは残る）',
    '  再開     … 停止を解除する',
    '  ※401/402/403、429の連続、原因不明エラー3回で自動停止します',
    '',
    '▼ 自動投稿の制御',
    '  ストップ   … 自動投稿を止める',
    '  スタート   … 自動投稿を再開する（2時間おき）',
    '  上限100    … 月間上限を100件/アカウントに設定',
    '  上限なし   … 上限を解除（⚠️歯止めが無くなります）',
    '  補充A3     … Aのキューが空になったら3件自動追加',
    '  補充なし   … 自動補充を解除',
    '',
    '▼ 設定（APIキー等）',
    '  初期設定 <キー> … 動画投稿に必要な設定を一括で行う',
    '  ※Pexels/Pixabayどちらのキーでも可（形で自動判別・両方並べてもよい）',
    '  設定一覧  … 登録済みの設定を全部見る',
    '  設定 PEXELS_API_KEY abc123 … 登録・変更',
    '  設定削除 キー名 … 削除',
    '  ※GASの設定画面は50件までしか出ませんが、ここは全件扱えます',
    '',
    '▼ その他',
    '  状態      … 連携状況・投稿数・自動投稿の稼働状況',
    '  診断      … Portalに登録すべきCallback URI等を表示',
    '  ID        … 自分の LINE userId を表示',
    '  連携解除 A … トークンを破棄',
    '  ヘルプ'
  ].join('\n');
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* doGet — 認証開始・OAuthコールバック・状態確認                        */
/* ------------------------------------------------------------------ */
/*
 * OAuthコールバックは、Googleの /usercallback ではなく、この /exec に
 * 直接返ってくる（01_OAuth.gs 参照。既知のGoogle側不具合を回避するため）。
 * X からの ?code=...&state=... はここで最優先に処理し、
 * ADMIN_TOKEN のチェックより前に通す（Xの認可コードは1回・数分しか有効でないため、
 * トークン不一致で弾くとその1回を無駄に消費してしまう）。
 *
 *   ?code=...&state=...  … Xからのコールバック（成功・拒否とも）
 *   ?auth=A / ?auth=B    … プロジェクトA/Bの認証開始（Xの認可画面へリダイレクト）
 *   （引数なし）          … 状態確認ページ
 * ADMIN_TOKEN を設定している場合、上記以外は ?token=... の一致を要求する。
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.code || params.error) {
    return handleOAuthCallbackViaExec_(e);
  }

  /*
   * ★クリック計測の入口。ADMIN_TOKEN の検査より前に置く。
   * 投稿を読んだ第三者がトークンを持っているはずがなく、
   * ここを後ろに置くと全てのアフィリエイトリンクが
   * 「アクセスできません」になって収益が丸ごと消える。
   *
   * 行き先はURLパラメータではなくClickMap上のtokenで決まるため、
   * オープンリダイレクタにはならない（23_Redirect.gs 冒頭を参照）。
   */
  if (params.go) {
    return handleGoRequest_(params);
  }

  /*
   * ★プライバシーポリシー・利用規約の公開ページ（27_Legal.gs）。
   * ADMIN_TOKEN の検査より前に置く。TikTok・Xの審査担当者は
   * トークンを持っていないため、後ろに置くと審査で開けない。
   *
   * 自前ドメインを買わずに公開URLを用意するための経路でもある。
   *   ?legal=privacy / ?legal=terms
   */
  if (params.legal) {
    return handleLegalRequest_(params);
  }

  // 集計側は逆に ADMIN_TOKEN を要求する（handleClickStatsRequest_ 内で検査）
  if (params.clickstats) {
    return handleClickStatsRequest_(params);
  }

  // トリガーの認可が古くてシートを読めない場合の受け口。
  // 実処理をこちら側（スクリプト所有者として動く）で行う。
  if (params.task) {
    return handleTaskRequest_(params);
  }

  const adminToken = getProp_('ADMIN_TOKEN');
  if (adminToken && params.token !== adminToken) {
    return renderPage_('アクセスできません', 'token パラメータが正しくありません。', false);
  }

  const target = normalizeInput_(params.auth || '').toUpperCase();

  if (target) {
    if (!ACCOUNTS[target]) {
      return renderPage_('不正な指定', 'auth には A または B を指定してください。', false);
    }
    const url = getAuthorizationUrl_(target);
    return HtmlService.createHtmlOutput(
      '<script>window.top.location.href=' + JSON.stringify(url) + ';</script>' +
      '<p>リダイレクトしない場合は <a target="_top" href="' + escapeHtml_(url) + '">こちら</a></p>'
    );
  }

  return renderPage_('X連携Bot', buildStatusText_() + '\n\n' +
    '認証開始: このURLに ?auth=A または ?auth=B を付けてアクセス' +
    (adminToken ? '（&token=... も必要）' : ''), true);
}
