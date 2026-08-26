/**
 * ===========================================================================
 * 37_Ingest.gs  —  LINEへ送った動画・画像を素材として取り込む
 * ===========================================================================
 *
 * ★★2026-08-24、オーナー指示「LINEから添付追加できるように構築」。
 *
 * 【なぜ要るか】
 * これまで素材を足す手段が「素材サイトからの自動補充」しか無かった。
 * つまり社長が「この映像を使え」と渡す方法が存在しなかった。
 * ストックサイトに無いもの（自分で撮った・自分で作った素材）は、
 * どうやってもシステムへ入らない。
 *
 * 【流れ】
 *   LINEで動画を送る
 *     → messageId でコンテンツを取得（api-data.line.me）
 *     → Driveの貯蔵庫へ保存（35_Vault.gs と同じフォルダ）
 *     → VideoStock へ1行足す（source=line）
 *     → 以降、通常の在庫として選ばれる
 *
 * 【退役されない理由】
 * 30_Stock.gs の retireStaleStock_ は出所が pexels / pixabay の行しか
 * 触らない。source=line は検索語リストと無関係なので、
 * 「今の検索語に無い」を理由に消されることはない。
 * 人が意図して入れたものを、機械が勝手に捨ててはいけない。
 */

/** LINEのコンテンツ取得。通常のAPIとはホストが違う（api-data）。 */
const LINE_CONTENT_URL = 'https://api-data.line.me/v2/bot/message/';

/**
 * 取り込む上限。
 *
 * ★29_Video.gs の VIDEO_MAX_BYTES と揃える。
 * ここで通しても、後段のアップロードで弾かれては意味がない。
 */
const INGEST_MAX_BYTES = 32 * 1024 * 1024;

/**
 * どちらのアカウントの素材にするか。
 *
 * ★添付には宛先が書かれていない。直前に「素材A」「素材B」と
 * 送ってもらう方式にすると手順が増えるので、既定を持って
 * あとから移せるようにする。
 */
function ingestTargetAccount_() {
  const v = String(getProp_('INGEST_ACCOUNT', 'B')).toUpperCase();
  return ACCOUNTS[v] ? v : 'B';
}

/**
 * LINEへ送られた添付を素材として取り込む。
 *
 * @param {string} messageId LINEのメッセージID
 * @param {string} kind 'video' | 'image'
 * @param {?string} userId 送信者（ログ用）
 * @return {string} LINEへ返す文面
 */
function ingestLineAttachment_(messageId, kind, userId) {
  if (kind !== 'video') {
    /*
     * ★画像は今のところ受け付けない。
     *   在庫(VideoStock)は動画を前提にしており、静止画を混ぜると
     *   「動かないカット」が連結に入る。受け取ったふりをして
     *   使われない場所へ入れるより、はっきり断る方がよい。
     */
    return '📎 画像は素材として受け付けていません。\n' +
           '動画を送ってください（1〜10秒程度の短いものが最適です）。';
  }

  let blob;
  try {
    blob = fetchLineContent_(messageId);
  } catch (e) {
    console.warn('LINEの添付を取得できません: ' + truncate_(String(e), 150));
    return '📎 動画を取得できませんでした。もう一度送ってみてください。';
  }
  if (!blob) return '📎 動画を取得できませんでした。';

  const bytes = blob.getBytes().length;
  if (bytes > INGEST_MAX_BYTES) {
    return '📎 動画が大きすぎます（' + Math.round(bytes / 1024 / 1024) + 'MB）。\n' +
           Math.round(INGEST_MAX_BYTES / 1024 / 1024) + 'MB以下にしてください。';
  }
  if (bytes < 10 * 1024) {
    return '📎 動画が小さすぎます（壊れている可能性があります）。';
  }

  const account = ingestTargetAccount_();

  let ref;
  try {
    ref = saveIngestToVault_(blob, account);
  } catch (e) {
    console.warn('貯蔵庫へ保存できません: ' + truncate_(String(e), 150));
    return '📎 保存できませんでした（Driveの権限をご確認ください）。';
  }
  if (!ref) return '📎 保存先を用意できませんでした。';

  let row;
  try {
    row = addIngestedStockRow_(account, ref, bytes);
  } catch (e) {
    console.warn('在庫へ登録できません: ' + truncate_(String(e), 150));
    return '📎 保存はできましたが、在庫へ登録できませんでした。';
  }

  console.log('LINEの添付を取り込みました (' + account + ' / ' +
              Math.round(bytes / 1024) + 'KB / row ' + row + ')');

  return [
    '📎 素材として登録しました',
    '',
    '宛先: ' + account + '（変えるなら「設定 INGEST_ACCOUNT=A」）',
    'サイズ: ' + (bytes / 1024 / 1024).toFixed(1) + 'MB',
    '',
    '次の組み立てから使われます。',
    '今すぐ確かめるなら「試作 ' + account + '」。'
  ].join('\n');
}

/**
 * LINEからコンテンツ本体を取る。
 *
 * ★ホストが api-data.line.me であることに注意。
 *   通常の api.line.me へ投げると404になる。
 */
function fetchLineContent_(messageId) {
  const url = LINE_CONTENT_URL + encodeURIComponent(messageId) + '/content';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + lineAccessToken_() },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code === 404) {
    // ★LINEはコンテンツを一定期間で消す。古いものは取れない
    throw new Error('コンテンツが見つかりません（期限切れの可能性）');
  }
  if (code !== 200) {
    throw new Error('HTTP ' + code + ': ' + truncate_(res.getContentText(), 120));
  }
  return res.getBlob();
}

/**
 * 貯蔵庫（35_Vault.gs と同じフォルダ）へ保存し、取得できるURLを返す。
 *
 * ★★`drive:` 形式では返さない（2026-08-24、作ってすぐ気づいた穴）。
 *
 * 描画は GitHub Actions の中で走る。あちらは社長のGoogleアカウントを
 * 持っていないので、`drive:<id>` を渡しても取得できない。
 * 実際 36_Render.gs の pickRenderClips_ は `drive:` を除外している。
 * つまりこの形式で入れると、**社長がわざわざ送った素材が
 * 一生使われない在庫**になる。
 *
 * リンクを知っていれば取れる共有にし、直接ダウンロードできるURLを返す。
 *
 * ★共有範囲について：
 *   「リンクを知っている全員」になる。ただしこの動画は、そもそも
 *   Xへ公開投稿するために入れたものなので、実質の露出は変わらない。
 *   非公開のまま扱いたい場合は、GitHubのReleaseへ上げる方式へ
 *   替えられる（実装量が増えるので、必要になったら申し出る）。
 */
function saveIngestToVault_(blob, accountKey) {
  const folder = vaultFolder_();
  if (!folder) return '';

  const name = 'line_' + String(accountKey) + '_' +
               Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MMdd_HHmmss') + '.mp4';
  const file = folder.createFile(blob.setName(name));

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    console.warn('共有設定に失敗しました。描画側から取得できない可能性があります: ' +
                 truncate_(String(e), 120));
  }

  /*
   * ★drive.google.com/uc?export=download は、大きいファイルで
   *   ウイルススキャンの確認ページ（HTML）を返すことがある。
   *   こちらは32MB以下に制限しているので直接返る想定だが、
   *   より新しい直リンク用ホストを使う。
   */
  return 'https://drive.usercontent.google.com/download?export=download&id=' +
         file.getId();
}

/**
 * 在庫へ1行足す。
 *
 * ★Query列には人が見て分かる印を入れる。
 *   ここが空だと、関連度の判定(stockRelevance_)で常に0点になり、
 *   話題と噛み合う映像がある時に選ばれなくなる。
 *   「どんな話題でも使える手持ちの素材」として扱えるよう、
 *   アカウントの検索語の1つを借りておく。
 */
function addIngestedStockRow_(accountKey, ref, bytes) {
  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateStockSheet_(ss);
  const row = sheet.getLastRow() + 1;

  let label = 'line upload';
  try {
    const qs = stockQueries_(accountKey);
    if (qs.length) label = 'line upload / ' + qs[0];
  } catch (e) {}

  sheet.getRange(row, 1, 1, STOCK_HEADERS.length).setValues([[
    new Date(),
    String(accountKey).toUpperCase(),
    label,
    ref,
    0,                    // 尺は不明。取得できないので0のまま
    1080,                 // 画質は不明。低い扱いにすると選ばれにくくなるので既定値
    'line',               // ★出所。これが retireStaleStock_ の対象外になる根拠
    0,
    ''
  ]]);
  return row;
}

/* ------------------------------------------------------------------ */
/* 状態表示                                                             */
/* ------------------------------------------------------------------ */

/** 手で入れた素材が何本あるか。診断に出す。 */
function ingestedStockCount_(accountKey) {
  let n = 0;
  try {
    listStock_(accountKey).forEach(function (r) {
      if (String(r.source || '').toLowerCase() === 'line') n++;
    });
  } catch (e) {}
  return n;
}
