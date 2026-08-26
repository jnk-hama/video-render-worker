/**
 * ===========================================================================
 * 14_Similarity.gs  —  投稿の類似度チェック（P1-9）
 * ===========================================================================
 * ハッシュ（12_Integrity.gs）は「完全に同じ」しか止められない。
 * 実際にアカウントを傷めるのは、
 *   ・1単語だけ変えた投稿
 *   ・URLだけ差し替えた投稿
 *   ・同じ型を延々と繰り返す投稿
 * のような「別物だが実質同じ」パターンで、これはハッシュを素通りする。
 *
 * ここでは文字trigram（3文字の並び）のJaccard係数で近さを測る。
 * 日本語は単語で切りにくく、英語混じりでも破綻しない方式が必要なため。
 *
 *   Jaccard = 共通するtrigram数 / どちらかに含まれるtrigram数
 *   0.0 = 全く別物 / 1.0 = 完全一致
 *
 * A/B間もチェックする。同じ内容を2アカウントから流すと、
 * Xの重複コンテンツ判定に触れるうえ、アカウントを分けている意味が消える。
 */

/** これ以上似ていたら投稿を止める（同一アカウント内）。 */
const SIMILARITY_LIMIT_SAME = 0.72;

/** A/B間のしきい値。別アカウントなので少しだけ緩める。 */
const SIMILARITY_LIMIT_CROSS = 0.82;

/** 何件前まで遡って比べるか。増やすほど厳しくなるが遅くなる。 */
const SIMILARITY_HISTORY_MAX = 40;

/**
 * スクリプトプロパティ1件あたりの安全な上限バイト数。
 *
 * GASのプロパティ値には9KB(9216バイト)の上限があり、超えると setProperty が
 * 例外を投げる。40件 × 400文字 だと英語アカウントでも上限(約11KB)を超え、
 * 日本語（UTF-8で1文字最大3バイト）ならさらに簡単に超える。
 * 超過時は setProperty が失敗し、既存の try/catch で握りつぶされて
 * 「類似度チェックの記録が更新されなくなる」という気づきにくい壊れ方をしていた。
 * 固定の文字数で当て推量せず、実際のシリアライズ後サイズを見て収まるまで
 * 古い方から削る（8000は9216に対して安全マージンを見た値）。
 */
const SIMILARITY_HISTORY_BUDGET_BYTES = 8000;

function similarityHistoryKey_(accountKey) {
  return 'recent_texts_' + String(accountKey).toUpperCase();
}

/** 比較用に正規化する。URL・記号・空白の差は無視する。 */
function normalizeForSimilarity_(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#＃@＠]/g, '')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

/** 文字trigramの集合を作る。3文字未満の場合は文字そのものを使う。 */
function trigrams_(text) {
  const s = normalizeForSimilarity_(text);
  const set = {};
  if (s.length < 3) {
    for (let i = 0; i < s.length; i++) set[s[i]] = true;
    return set;
  }
  for (let i = 0; i <= s.length - 3; i++) set[s.substring(i, i + 3)] = true;
  return set;
}

/**
 * 2つの文章の近さを 0〜1 で返す。
 * @return {number}
 */
function similarity_(a, b) {
  const A = trigrams_(a);
  const B = trigrams_(b);
  const keysA = Object.keys(A);
  const keysB = Object.keys(B);
  if (!keysA.length || !keysB.length) return 0;

  let common = 0;
  keysA.forEach(function (k) { if (B[k]) common++; });

  const union = keysA.length + keysB.length - common;
  return union === 0 ? 0 : common / union;
}

/** 直近の投稿本文を読む。 */
function readRecentTexts_(accountKey) {
  try {
    const raw = getProp_(similarityHistoryKey_(accountKey), '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** UTF-8でのバイト数を数える。Utilities.newBlob は日本語混じりでも正確。 */
function byteLength_(s) {
  try {
    return Utilities.newBlob(String(s)).getBytes().length;
  } catch (e) {
    // 万一失敗しても致命傷にしない。文字数を目安として使う（安全側に少なめ見積り）。
    return String(s).length;
  }
}

/** 投稿に成功した本文を履歴へ足す。 */
function rememberRecentText_(accountKey, text) {
  try {
    const list = readRecentTexts_(accountKey);
    list.unshift(truncate_(String(text || ''), 280));   // 実際の投稿上限(280)を超えて持つ意味は無い
    let trimmed = list.slice(0, SIMILARITY_HISTORY_MAX);

    // ★当て推量の件数上限だけに頼らず、実際のシリアライズ後サイズで判定する。
    // 日本語運用（1文字最大3バイト）でも確実に9KBへ収まるよう、
    // 超えていたら古い方から削り、収まるまで繰り返す。
    let json = JSON.stringify(trimmed);
    while (byteLength_(json) > SIMILARITY_HISTORY_BUDGET_BYTES && trimmed.length > 1) {
      trimmed = trimmed.slice(0, trimmed.length - 1);
      json = JSON.stringify(trimmed);
    }

    props_().setProperty(similarityHistoryKey_(accountKey), json);
  } catch (e) {
    console.warn('投稿履歴の記録に失敗: ' + e);
  }
}

/**
 * 過去の投稿と似すぎていないか調べる。
 *
 * @return {?{score:number, against:string, scope:string, text:string}}
 *   似すぎている場合のみオブジェクトを返す。問題なければ null。
 */
function findTooSimilar_(accountKey, text) {
  const key = String(accountKey).toUpperCase();
  let worst = null;

  const scan = function (againstKey, limit, scope) {
    readRecentTexts_(againstKey).forEach(function (old) {
      const score = similarity_(text, old);
      if (score >= limit && (!worst || score > worst.score)) {
        worst = { score: score, against: againstKey, scope: scope, text: old };
      }
    });
  };

  scan(key, SIMILARITY_LIMIT_SAME, '同一アカウント');
  Object.keys(ACCOUNTS).forEach(function (other) {
    if (other !== key) scan(other, SIMILARITY_LIMIT_CROSS, 'アカウント間');
  });

  return worst;
}

/** 類似判定の内容を人が読める文にする。 */
function describeSimilarity_(hit) {
  return '類似度 ' + Math.round(hit.score * 100) + '%（' + hit.scope +
         ' / ' + hit.against + '）\n似ている投稿: ' + truncate_(hit.text, 100);
}

/**
 * 投稿してよいか判定する。似すぎていれば例外を投げる。
 * 生成をやり直せる場面では、呼び出し側が捕まえて再生成する。
 */
function assertNotTooSimilar_(accountKey, text) {
  const hit = findTooSimilar_(accountKey, text);
  if (!hit) return;
  const err = new Error('過去の投稿と似すぎています。\n' + describeSimilarity_(hit));
  err.name = 'TooSimilarError';
  err.similarity = hit;
  throw err;
}
