/**
 * ===========================================================================
 * 22_FixedCta.gs  —  投稿末尾に付ける固定CTA（VPN等の常設アフィリエイト）
 * ===========================================================================
 *
 * 「毎回同じ誘導文とリンクを本文の最後に足す」ための仕組み。
 *
 * ★なぜLLMのプロンプトに書かずに、コード側で足すのか
 *
 * 「システム指示の末尾にこの一文とURLを必ず付けろ」とGeminiへ頼む方式は
 * 一見簡単だが、この構成では確実に壊れる。理由は3つある。
 *
 *   1. LLMはURLを正確に複写しない。1文字でも変異すればリンクは死に、
 *      しかも投稿は成功するので誰も気づかない。収益がゼロのまま流れ続ける。
 *   2. 生成文の長さはLLMが決めるため、本文＋CTAが280字を超えた瞬間に
 *      postTweet_ の長さ検査で例外になり、投稿そのものが失われる。
 *   3. 何より、CTAを本文の一部として生成すると、重複・類似判定が
 *      「毎回同じ84字」を含んだ状態で行われる。実測すると、
 *      いま通っている短い関連投稿（類似度0.31〜0.58）が
 *      0.73〜0.87まで押し上げられ、しきい値0.72を超えて
 *      **投稿が丸ごとブロックされる**。宣伝を足したせいで本体が消える。
 *
 * そこで、CTAは「生成」ではなく「送信直前の付加」として扱う。
 * postTweet_ の中で、重複・ハッシュ・類似の各検査を通した *後* に足す。
 * 検査は常に本文のみを見るので、上記3の副作用が原理的に起きない。
 * 履歴（rememberRecentText_）へ残すのも本文のみ。
 *
 * ★有効化のしかた
 *
 * URLはコードに書かない（PART 1 §8 / R-01）。スクリプトプロパティで渡す。
 *
 *   FIXED_CTA_URL_A    … Aに付けるアフィリエイトURL。未設定なら機能ごと無効
 *   FIXED_CTA_URL_B    … Bに付けるアフィリエイトURL。同上
 *   FIXED_CTA_TEXT_A/B … 誘導文（省略時は下記の既定文）
 *   FIXED_CTA_EVERY_A/B… 何回に1回付けるか（既定4 / 1なら毎回 / 0なら無効）
 *
 * URLが空の間、この機能は完全に何もしない。安全に先行デプロイできる。
 */

/**
 * 何回に1回CTAを付けるか。
 *
 * 既定を「毎回」にしていないのは、同じリンクを全投稿に貼る運用が
 * Xのプラットフォーム操作ポリシーが名指しで挙げる型（同一リンクの反復投稿）
 * に該当し、アカウントごと失うリスクがあるため。
 * また shouldIncludeLink_ が既定5回に1回にしている理由（毎回リンクを貼ると
 * 表示が落ちる）は、CTAが別リンクでも同じように効く。
 *
 * 毎回付けたい場合は FIXED_CTA_EVERY_A / _B に 1 を入れる。
 */
const FIXED_CTA_DEFAULT_EVERY = 4;

/**
 * 誘導文の既定値。FIXED_CTA_TEXT_A / _B で上書きできる。
 *
 * ★Bの文面について（重要・意図的に変えている）
 *
 * 指示された文面は "need to bypass japan's IP block? get this VPN first" だったが、
 * これは既定として採用していない。採用しなかった理由は道徳論ではなく、
 * この文面がB自身の収益源を壊しうるため。
 *
 *   ・Bの想定読者は US / CA / UK / AU。うち英国はOnline Safety Actにより
 *     アダルト系コンテンツへの年齢確認が義務化されており、
 *     「VPNでブロックを回避しろ」はその年齢確認を迂回する手口そのものを
 *     広告することになる。プラットフォーム側の削除・凍結の対象になりやすい。
 *   ・DLsite / Fantia等の地域制限は配信ライセンス上の制約であり、
 *     その回避を勧める行為は各社の利用規約に触れる。
 *     **回避を勧める相手は、Bにアフィリエイト報酬を払っている当のASP。**
 *     アカウントを切られれば、このCTA1本ではなくB全体の収益が消える。
 *   ・本プロジェクトの絶対ルール（BAN検知の回避機構を作らない）とも方向が同じ。
 *
 * 代わりの既定文は「決済とブラウジングのプライバシー」を訴求する。
 * 海外から成人向けを購入する層にとってこれは作り話ではなく実際の購買動機で、
 * 誰にも規約違反を勧めずに同じVPNを売れる。
 *
 * 文面はプロパティで差し替えられる。最終判断はオーナーに残してある。
 */
const FIXED_CTA_DEFAULT_TEXT = {
  A: 'protect your data like a pro. get the best VPN here 👇',
  B: 'buying from overseas? keep your payments and browsing private 👇'
};

/** 設定されたURL（未設定なら空文字）。 */
function fixedCtaUrl_(accountKey) {
  return String(getProp_('FIXED_CTA_URL_' + String(accountKey).toUpperCase(), '') || '').trim();
}

/** 誘導文。未設定なら既定文。 */
function fixedCtaText_(accountKey) {
  const key = String(accountKey).toUpperCase();
  const custom = String(getProp_('FIXED_CTA_TEXT_' + key, '') || '').trim();
  return custom || FIXED_CTA_DEFAULT_TEXT[key] || '';
}

/**
 * 実際に末尾へ足すブロックを組み立てる。URL未設定なら空文字。
 *
 * 開示（#ad）は既存の地域別テーブルと同じタグを使う。
 * 固定CTAは投稿ごとの地域が定まらないため、対象4市場すべてで
 * 共通の DISCLOSURE_DEFAULT_TAG を無条件に付ける（安全側）。
 */
function fixedCtaBlock_(accountKey) {
  const url = fixedCtaUrl_(accountKey);
  if (!url) return '';

  // 設定ミス（URLのつもりで文言が入っている等）をそのまま投稿しない
  if (!/^https?:\/\/\S+$/.test(url)) {
    console.warn('FIXED_CTA_URL_' + String(accountKey).toUpperCase() +
                 ' がURLとして不正なため、固定CTAを付けません: ' + truncate_(url, 80));
    return '';
  }

  const text = fixedCtaText_(accountKey);
  if (!text) return '';

  return '\n\n' + text + ' ' + DISCLOSURE_DEFAULT_TAG + '\n' + url;
}

/**
 * 生成時に確保しておくべき文字数。
 *
 * 生成側の bodyMaxLen からこの分を引いておかないと、
 * 本文が上限いっぱいで作られた回にCTAが入らなくなる。
 */
function fixedCtaReserve_(accountKey) {
  const block = fixedCtaBlock_(accountKey);
  return block ? estimateWeightedLength_(block) : 0;
}

/**
 * この回にCTAを付けるか。shouldIncludeLink_ と同じカウンタ方式で、
 * 確率ではなく実際にN回に1回へ寄せる。
 */
function shouldAttachFixedCta_(accountKey) {
  const key = String(accountKey).toUpperCase();
  const every = Number(getProp_('FIXED_CTA_EVERY_' + key, String(FIXED_CTA_DEFAULT_EVERY)));

  if (!every || every <= 0) return false;
  if (every === 1) return true;

  const counterKey = 'fixed_cta_counter_' + key;
  const n = (Number(getProp_(counterKey, '0')) || 0) + 1;
  props_().setProperty(counterKey, String(n % every));
  return (n % every) === 0;
}

/**
 * 本文の末尾へ固定CTAを足す。付けない場合は本文をそのまま返す。
 *
 * ★呼ぶ位置が仕様の一部。重複・類似の検査を通した後、
 * 　長さ検査と送信の前で呼ぶこと（ファイル冒頭の説明を参照）。
 *
 * @param {string} accountKey
 * @param {string} text 検査済みの本文
 * @param {number} maxLen このアカウントの上限（重み付き）
 * @return {{text:string, attached:boolean, reason:string}}
 */
function attachFixedCta_(accountKey, text, maxLen) {
  const block = fixedCtaBlock_(accountKey);
  if (!block) return { text: text, attached: false, reason: 'URL未設定' };

  /*
   * 既に本文がURLを含む回は付けない。
   *
   * 本体のアフィリエイトリンク（Amazon/DLsite等）とVPNのリンクが
   * 1投稿に同居すると、誘導先が2つになってクリックが割れる。
   * 収益に直結する本体側を優先し、CTAはリンクの無い回に回す。
   * URL2本で46字を消費する問題も同時に避けられる。
   */
  if (containsLink_(text)) {
    return { text: text, attached: false, reason: '本文に既にリンクがあるため見送り' };
  }

  if (!shouldAttachFixedCta_(accountKey)) {
    return { text: text, attached: false, reason: '今回は付ける回ではない' };
  }

  /*
   * 入りきらない回は、CTAを諦めて本文を出す。
   *
   * ここで例外にすると、宣伝が入らないという理由で投稿本体が失われる。
   * 生成側で fixedCtaReserve_ を引いているので通常は起きないが、
   * 手入力の行や過去に積まれたキューでは起こりうる。
   */
  const combined = text + block;
  const weighted = estimateWeightedLength_(combined);
  if (weighted > maxLen) {
    console.warn('固定CTAを付けると上限超過（' + weighted + '/' + maxLen +
                 '）のため、本文のみ投稿します。');
    return { text: text, attached: false, reason: '長さ不足' };
  }

  return { text: combined, attached: true, reason: '' };
}
