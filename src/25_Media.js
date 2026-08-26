/**
 * ===========================================================================
 * 25_Media.gs  —  画像の添付（X メディアアップロード）
 * ===========================================================================
 *
 * ★なぜ要るか
 *
 * 参考にしたFANZAアフィリエイトのアカウント（1.9万フォロワー）は、
 * 「公式サンプル画像/動画 ＋ 短い煽り文」だけで4,000いいねを取っている。
 * この型の主役は画像であって文章ではない。
 *
 * これまでこのBotは画像を1枚も添付できなかった。
 * 引用RTで「引用元が持っている画像」を借りることしかできず、
 * 自分の作品紹介は文字だけになっていた。物を売る投稿としては勝負にならない。
 *
 * ★使う画像
 *
 * ASPが配布している公式の宣伝素材のみ。
 * DMM(FANZA)のアフィリエイトAPIはパッケージ画像のURLを返すので、
 * それを取得してXへ上げる。作品ページから勝手に抜いた画像は使わない。
 *
 * ★この機能は投稿を止めない
 *
 * アップロードに失敗した回は、画像なしでそのまま投稿する。
 * 画像が付かないことより、投稿が消える方が損失が大きい。
 *
 * ★未検証
 *
 * Xのメディアアップロードの仕様（エンドポイント・OAuth2で通るか・
 * 対応形式）を、この環境から一次情報で確認できていない（egress制限）。
 * 実機で1回通すまでは「未確認」のまま扱うこと。
 * 失敗しても投稿自体は出るので、試して確かめるコストは低い。
 */

/** アップロード先。v2が使えない場合に備えて差し替えられるようにしておく。 */
const X_MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';

/** 1枚あたりの上限（X の画像上限は5MB。余裕を見て手前で止める）。 */
const MEDIA_MAX_BYTES = 4.5 * 1024 * 1024;

/** 添付できる形式。 */
const MEDIA_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** 画像添付を使うか。既定は有効。問題が出たら MEDIA_UPLOAD=0 で止める。 */
function mediaUploadEnabled_() {
  return String(getProp_('MEDIA_UPLOAD', '1')) !== '0';
}

/**
 * URLから画像を取得する。
 * @return {?{blob:!Object, type:string, bytes:number}}
 */
function fetchMediaBlob_(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(u)) return null;

  let res;
  try {
    res = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    console.warn('画像を取得できませんでした（画像なしで続行）: ' + truncate_(String(e), 120));
    return null;
  }

  if (res.getResponseCode() !== 200) {
    console.warn('画像の取得が HTTP ' + res.getResponseCode() + '（画像なしで続行）: ' + truncate_(u, 80));
    return null;
  }

  const blob = res.getBlob();
  const type = String(blob.getContentType() || '').toLowerCase();
  if (MEDIA_ALLOWED_TYPES.indexOf(type) === -1) {
    console.warn('対応していない形式のため画像を諦めます: ' + type);
    return null;
  }

  const bytes = blob.getBytes().length;
  if (bytes > MEDIA_MAX_BYTES) {
    console.warn('画像が大きすぎるため諦めます: ' + Math.round(bytes / 1024) + 'KB');
    return null;
  }

  return { blob: blob, type: type, bytes: bytes };
}

/**
 * 画像をXへ上げて media_id を返す。
 *
 * ★失敗しても例外を投げない。null を返し、呼び出し側は画像なしで投稿する。
 *
 * @return {?string} media_id。失敗したら null
 */
function uploadMediaToX_(accountKey, imageUrl) {
  if (!mediaUploadEnabled_()) return null;

  /*
   * ★★Xが既に拒否しているなら、素材を取りに行く前にやめる（2026-08-24）。
   * ここを見ていなかったため、402の後も候補を替えて何度も叩き続け、
   * 投稿0本のままクレジットだけ消えた。
   */
  if (xCallsBlocked_(accountKey)) {
    console.warn('[' + accountKey + '] Xが受け付けない状態のため、画像のアップロードを行いません。');
    return null;
  }

  const media = fetchMediaBlob_(imageUrl);
  if (!media) return null;

  let service;
  try {
    service = getXService_(accountKey);
    if (!service.hasAccess()) return null;
  } catch (e) {
    console.warn('未連携のため画像を添付しません: ' + truncate_(String(e), 100));
    return null;
  }

  /*
   * ★まず4段階(INIT/APPEND/FINALIZE)で上げる（2026-08-21 訂正）。
   *
   * 実装済みライブラリ(plhery/node-twitter-api-v2)のv2クライアントには
   * 単発POSTの経路が存在せず、画像もGIFも動画も同じ4段階を通っている。
   * ここは長らく「未検証」のままだったが、画像が付かなかった原因は
   * これだった可能性が高い。
   *
   * ★単発POSTも残す。
   * 一次情報で確認できていない以上、4段階が通らない階層もありうる。
   * 通った方を覚えるので、無駄な往復は最初の1回だけ。
   */
  const chunked = uploadImageChunked_(accountKey, media);
  if (chunked) return chunked;

  let res;
  try {
    res = UrlFetchApp.fetch(X_MEDIA_UPLOAD_URL, {
      method: 'post',
      headers: { Authorization: 'Bearer ' + service.getAccessToken() },
      payload: { media: media.blob },      // multipart/form-data はGASが組み立てる
      muteHttpExceptions: true
    });
  } catch (e) {
    console.warn('画像のアップロードで通信エラー（画像なしで続行）: ' + truncate_(String(e), 120));
    return null;
  }

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200 && code !== 201) {
    /*
     * ★401/402/403/429 は「次の候補なら通る」種類の失敗ではない。
     * 遮断器を立てて、この実行では以降Xを叩かない（2026-08-24）。
     * 402ならアカウントの停止まで進む（残高が無いので投稿もできない）。
     */
    noteXRefusal_(accountKey, code, '画像アップロード');

    console.warn('画像のアップロードに失敗 HTTP ' + code + ': ' + truncate_(body, 200));
    notifyMediaFailureOnce_(accountKey, code, body);
    return null;
  }

  try {
    const parsed = JSON.parse(body);
    // v2 は data.id、v1.1 は media_id_string を返す。どちらでも拾えるようにする。
    const id = (parsed.data && parsed.data.id) || parsed.media_id_string || parsed.media_key;
    return id ? String(id) : null;
  } catch (e) {
    console.warn('アップロード応答を解釈できませんでした: ' + truncate_(body, 150));
    return null;
  }
}

/**
 * 画像添付が続けて失敗している時だけ知らせる。
 * 1枚失敗するたびに通知すると鬱陶しいので、24時間に1回まで。
 */
const MEDIA_FAIL_NOTIFIED_PROP = 'media_fail_notified_at';

function notifyMediaFailureOnce_(accountKey, code, body) {
  const last = Number(getProp_(MEDIA_FAIL_NOTIFIED_PROP, '0')) || 0;
  if (last && (Date.now() - last) < 24 * 60 * 60 * 1000) return;
  try { props_().setProperty(MEDIA_FAIL_NOTIFIED_PROP, String(Date.now())); } catch (e) {}

  notifyAdmin_([
    '⚠️ 画像の添付に失敗しています（' + accountKey + '）',
    '',
    'HTTP ' + code,
    truncate_(body, 200),
    '',
    '投稿自体は画像なしで続いています。',
    code === 403 || code === 401
      ? 'Xアプリの権限（media.write）が足りていない可能性があります。'
      : 'Xのメディアアップロード仕様が想定と違う可能性があります。',
    '',
    '止めるなら MEDIA_UPLOAD を 0 にしてください。'
  ].join('\n'));
}


/**
 * 画像を4段階（INIT/APPEND/FINALIZE）で上げる。
 *
 * ★動画と同じ手順を使う。29_Video.gs の関数をそのまま呼ぶ。
 * 画像は小さいのでAPPENDは通常1回で終わり、変換待ちも発生しない。
 *
 * ★media_category は種別で変える。
 * 参照実装は image→tweet_image、gif→tweet_gif と分けている。
 * GIFを tweet_image で申告すると弾かれうる。
 *
 * @return {?string} media_id。使えなければ null（呼び出し側が単発POSTへ降りる）
 */
function uploadImageChunked_(accountKey, media) {
  let token;
  try {
    const service = getXService_(accountKey);
    if (!service.hasAccess()) return null;
    token = service.getAccessToken();
  } catch (e) {
    return null;
  }

  const auth = { Authorization: 'Bearer ' + token };
  const type = String(media.type || 'image/jpeg').toLowerCase();
  const category = type.indexOf('gif') >= 0 ? 'tweet_gif' : 'tweet_image';

  let bytes;
  try { bytes = media.blob.getBytes(); }
  catch (e) { return null; }

  const mediaId = videoInit_(auth, bytes.length, type, category, accountKey);
  if (!mediaId) return null;

  // 画像はチャンク上限より小さいので通常1回。大きければ分割される
  let segment = 0;
  for (let offset = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES) {
    const slice = bytes.slice(offset, Math.min(offset + VIDEO_CHUNK_BYTES, bytes.length));
    const chunk = Utilities.newBlob(slice, 'application/octet-stream', 'chunk');
    if (!videoAppend_(auth, mediaId, segment, chunk)) return null;
    segment++;
  }

  const fin = videoFinalize_(auth, mediaId);
  if (!fin.ok) return null;

  // 画像は通常ここで変換待ちに入らないが、GIFは入ることがある
  if (fin.processing && !waitForVideoProcessing_(auth, mediaId)) return null;

  return mediaId;
}
