/**
 * ===========================================================================
 * 24_PostMix.gs  —  投稿の種類の配分（引用 / アフィリエイト / 人間らしい投稿）
 * ===========================================================================
 *
 * オーナー指示（2026-08-17）:
 *
 *   いま（アフィリエイトリンク未登録）
 *     引用            80%
 *     人間みたいな投稿 20%
 *
 *   リンクを登録したあと
 *     アフィリエイト   60%
 *     引用            30%
 *     人間みたいな投稿 10%
 *
 * ★フェーズは手で切り替えない。
 * Linksシートに「実際に使えるリンク」が1本でもあるかで自動的に決まる。
 * 手動フラグにすると、登録したのに切り替え忘れる／リンクが失効したのに
 * 販売比率のままになる、という食い違いが必ず起きる。
 *
 * ★抽選ではなく「目標との差が最大のものを選ぶ」方式。
 * 重み付きランダムは短期のブレが大きく、20%の枠が5回続くことが起きる。
 * 直近の実績を数えて不足している種類を選べば、本数が溜まるほど
 * 設計どおりの比率に収束する。Bのファネル配分と同じ考え方（DESIGN §7）。
 *
 * ★この仕組みは投稿を止めない。
 * 選ばれた種類が作れなかった回は、次点の種類へ静かに降りる。
 * 配分は「どれを優先するか」であって、「これ以外は出すな」ではない。
 */

/** 投稿の種類。 */
const POST_KIND_AFFILIATE = 'AFFILIATE';   // アフィリエイトリンク付きの単独投稿
const POST_KIND_QUOTE     = 'QUOTE';       // 引用RT・素RT・記事/動画への反応
const POST_KIND_HUMAN     = 'HUMAN';       // リンクの無い単独投稿

/**
 * フェーズ別の目標配分（%）。合計は100。
 *
 *   SEED … 種を撒く時期。売る物がまだ無いので、露出とフォローを取りに行く
 *   SELL … リンクがある時期。収益投稿を主役にする
 */
/*
 * ★BUZZ を足した（2026-08-20、オーナー指示「XのViewが少ない」）。
 *
 * 引用(QUOTE)はAでは403で使えず、実際には出せていない枠だった。
 * SEED期の枠をそこへ寝かせておく理由が無い。
 *
 * SELL期でも0にしない。売る投稿だけのタイムラインは伸びが止まり、
 * 結局そのアフィリエイト投稿も見られなくなる。露出は収益の前提。
 *
 * BUZZ_MODE=0 にすると BUZZ の枠は他へ配分し直される（下の postMixTargets_）。
 */
const POST_MIX_TARGETS = {
  SEED: { AFFILIATE: 0,  QUOTE: 40, HUMAN: 20, BUZZ: 40, HIJACK: 0 },
  SELL: { AFFILIATE: 55, QUOTE: 20, HUMAN: 10, BUZZ: 15, HIJACK: 0 }
};

/*
 * ★参照投稿(HIJACK)の既定は0%。
 * まだ伸びるか分かっておらず、しかもリンク付き投稿なので、
 * バズモードの前提（Xはリンク付きの到達を落とす）と衝突する。
 * REF_POST_SHARE で比率を与えると配分に入る。数字を見てから増やす。
 */
function refPostShare_() {
  const n = Number(getProp_('REF_POST_SHARE', '0'));
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(50, n);
}

/** 配分を測る母数。直近何本を見るか。 */
const POST_MIX_WINDOW = 50;

/**
 * 実際に使えるアフィリエイトリンクが1本でもあるか。
 *
 * ★ここが SEED / SELL の分かれ目。
 * 「登録されているか」ではなく「検証を通って投稿に使えるか」で見る。
 * UNVERIFIED のまま並んでいる行は使えないので、あっても SEED のまま。
 *
 * 読めない場合は false（＝SEED）を返す。判断できない時に
 * 販売比率へ倒すと、リンク無しのアフィリエイト投稿を作ろうとして空回りする。
 */
function hasUsableAffiliateLink_(accountKey, ss) {
  try {
    const sheet = getOrCreateLinksSheet_(ss);
    const candidates = listLinkCandidates_(sheet, accountKey);
    for (let i = 0; i < candidates.length; i++) {
      // 地域は問わない（どこか1つの地域で使えれば「ある」とみなす）
      if (validateAffiliateLink_(candidates[i], '', accountKey).ok) return true;
    }
  } catch (e) {
    console.warn('Linksを読めないため種まきフェーズとして扱います: ' + e);
  }
  return false;
}

/** 現在のフェーズ。 */
function currentPostPhase_(accountKey, ss) {
  return hasUsableAffiliateLink_(accountKey, ss) ? 'SELL' : 'SEED';
}

/**
 * 現在の目標配分（%）。
 *
 * ★BUZZ_MODE=0 の時は BUZZ の枠を捨てずに他へ配り直す。
 * 単に0にすると合計が100を割り、「どの種類も目標に届いている」状態が
 * 作れなくなって配分の判定が歪む。
 */
function postMixTargets_(accountKey, ss) {
  let base = POST_MIX_TARGETS[currentPostPhase_(accountKey, ss)] || POST_MIX_TARGETS.SEED;

  /*
   * ★参照投稿に比率が与えられていれば、BUZZから分ける。
   * どちらも「露出を取りに行く枠」なので、そこで奪い合わせる。
   * アフィリエイト枠を削ると収益が落ちる。
   */
  /*
   * ★31_RefPost.gs が無くても落ちないようにする。
   * 配分は投稿の入口で必ず通る。ここで例外を出すと、
   * 実験的な機能1つのために投稿が全部止まる。
   */
  const refOn = (typeof refPostEnabled_ === 'function') && refPostEnabled_();
  const refShare = refOn ? refPostShare_() : 0;
  if (refShare > 0) {
    const take = Math.min(refShare, Number(base.BUZZ) || 0);
    base = Object.assign({}, base, {
      BUZZ: (Number(base.BUZZ) || 0) - take,
      HIJACK: take
    });
  }

  if (buzzModeEnabled_()) return base;

  const out = {};
  const share = Number(base.BUZZ) || 0;
  const others = Object.keys(base).filter(function (k) { return k !== 'BUZZ'; });
  const rest = others.reduce(function (s, k) { return s + (Number(base[k]) || 0); }, 0);

  others.forEach(function (k) {
    const v = Number(base[k]) || 0;
    // 残りの枠の比率どおりに上乗せする（rest が0なら均等に配る）
    out[k] = rest > 0 ? v + share * (v / rest) : v + share / others.length;
  });
  out.BUZZ = 0;
  return out;
}

/**
 * Logの1行がどの種類だったかを判定する。
 *
 * @param {string} angle Strategy Angle 列
 * @param {string} hasLink Has Link 列（'URL' / 'TEXT'）
 */
function classifyPostKind_(angle, hasLink) {
  const a = String(angle || '').toUpperCase();

  /*
   * ★BUZZ を先に見る。
   * BUZZもリンク無しなので、後ろに置くと全部 HUMAN として数えられ、
   * 「HUMANが目標超過・BUZZが常に不足」という壊れた配分になる。
   */
  if (a.indexOf('BUZZ') === 0) return POST_KIND_BUZZ;

  /*
   * ★参照投稿(31_RefPost.gs)。BUZZより先に見る。
   * どちらもリンクの有無で判別できないため、angleの文字列で分ける。
   */
  if (a.indexOf('HIJACK') === 0) return POST_KIND_HIJACK;

  // 引用RT・素RT・記事/動画への反応。外にあるものへ乗る投稿はここ。
  if (a.indexOf('QUOTE') === 0 || a.indexOf('RETWEET') === 0 || a.indexOf('SOURCE') === 0) {
    return POST_KIND_QUOTE;
  }
  return String(hasLink || '').toUpperCase() === 'URL' ? POST_KIND_AFFILIATE : POST_KIND_HUMAN;
}

/**
 * 直近の投稿を種類別に数える。
 * @return {{AFFILIATE:number, QUOTE:number, HUMAN:number, BUZZ:number,
 *           HIJACK:number, total:number}}
 */
function recentPostKindCounts_(ss, accountKey) {
  // ★新しい種類を足したらここも足す。忘れると out[kind]++ が NaN になる
  const out = { AFFILIATE: 0, QUOTE: 0, HUMAN: 0, BUZZ: 0, HIJACK: 0, total: 0 };
  try {
    const sheet = getOrCreateLogSheet_(ss);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;

    const from = Math.max(2, lastRow - POST_MIX_WINDOW * 3);   // 失敗行も混ざるので広めに取る
    const values = sheet.getRange(from, 1, lastRow - from + 1, LOG_TOTAL_COLUMNS).getValues();
    const key = String(accountKey || '').toUpperCase();

    // 新しい方から数え、投稿できたものだけを対象にする
    for (let i = values.length - 1; i >= 0 && out.total < POST_MIX_WINDOW; i--) {
      const row = values[i];
      if (String(row[LOG_COL_ACCOUNT - 1] || '').toUpperCase() !== key) continue;
      if (String(row[LOG_COL_STATUS - 1] || '') !== QUEUE_STATUS_POSTED) continue;
      const kind = classifyPostKind_(row[LOG_COL_ANGLE - 1], row[LOG_COL_HAS_LINK - 1]);
      out[kind]++;
      out.total++;
    }
  } catch (e) {
    console.warn('配分の集計に失敗（配分なしで続行）: ' + e);
  }
  return out;
}

/**
 * 次に出すべき種類を、目標との差が最大のものとして選ぶ。
 *
 * @return {{kind:string, phase:string, reason:string}}
 */
function pickPostKind_(ss, accountKey) {
  const phase = currentPostPhase_(accountKey, ss);
  // ★POST_MIX_TARGETS を直接読まない。BUZZ_MODE=0 の配り直しを通すため
  const target = postMixTargets_(accountKey, ss);
  const counts = recentPostKindCounts_(ss, accountKey);

  // まだ実績が無い時は、目標の一番大きい種類から始める
  if (!counts.total) {
    let top = POST_KIND_QUOTE;
    Object.keys(target).forEach(function (k) { if (target[k] > target[top]) top = k; });
    return { kind: top, phase: phase, reason: '実績なし（目標最大の種類から開始）' };
  }

  let best = null;
  let bestGap = -Infinity;
  Object.keys(target).forEach(function (k) {
    if (!target[k]) return;                       // 目標0%の種類は選ばない
    const actual = (counts[k] / counts.total) * 100;
    const gap = target[k] - actual;
    if (gap > bestGap) { bestGap = gap; best = k; }
  });

  // 全種類が目標を満たしている場合も、何かは出す（目標最大の種類）
  if (!best) best = POST_KIND_QUOTE;

  return {
    kind: best,
    phase: phase,
    reason: '直近' + counts.total + '本: 引用' + counts.QUOTE +
            ' / アフィ' + counts.AFFILIATE + ' / 人間' + counts.HUMAN +
            ' / バズ' + counts.BUZZ + ' / 参照' + counts.HIJACK +
            ' → 不足は' + best
  };
}

/**
 * 配分の現状を人が読める形にする（LINEの「レポート」用）。
 */
function buildPostMixText_(ss) {
  const lines = ['📐 投稿の配分'];
  ['A', 'B'].forEach(function (key) {
    let phase, target, counts;
    try {
      phase = currentPostPhase_(key, ss);
      target = postMixTargets_(key, ss);   // ★BUZZ_MODE=0 の配り直しを反映する
      counts = recentPostKindCounts_(ss, key);
    } catch (e) {
      lines.push('[' + key + '] 集計できません');
      return;
    }

    lines.push('');
    lines.push('[' + key + '] ' + (phase === 'SEED' ? '種まき期' : '販売期') +
               '（使えるリンク' + (phase === 'SEED' ? 'なし' : 'あり') + '）');

    if (!counts.total) {
      lines.push('  まだ投稿がありません');
      return;
    }
    [[POST_KIND_AFFILIATE, 'アフィリエイト'],
     [POST_KIND_QUOTE, '引用・反応'],
     [POST_KIND_BUZZ, 'バズ（リンク無し）'],
     [POST_KIND_HIJACK, '参照（他人の動画URL）'],
     [POST_KIND_HUMAN, '人間らしい投稿']].forEach(function (pair) {
      const k = pair[0];
      if (!target[k] && !counts[k]) return;
      const pct = Math.round((counts[k] / counts.total) * 100);
      lines.push('  ' + pair[1] + ': ' + counts[k] + '本 ' + pct +
                 '%（目標' + Math.round(target[k]) + '%）');
    });
  });
  return lines.join('\n');
}

/**
 * 配分の判定に使う代表アカウント。
 *
 * 投稿サイクルはアカウント単位ではなく1本ずつ回るため、
 * 「どちらのアカウントの配分を見るか」を決める必要がある。
 * 収益化が先に立つ側（使えるリンクを持っている方）を優先し、
 * どちらも無ければAを使う。
 */
function primaryMixAccount_(ss) {
  try {
    if (hasUsableAffiliateLink_('A', ss)) return 'A';
    if (hasUsableAffiliateLink_('B', ss)) return 'B';
  } catch (e) {
    console.warn('代表アカウントを決められないためAを使います: ' + e);
  }
  return 'A';
}
