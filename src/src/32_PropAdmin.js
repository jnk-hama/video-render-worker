/**
 * ==========================================================
 * 32_PropAdmin.gs － スクリプトプロパティをLINEから管理する
 * ==========================================================
 *
 * ★2026-08-22、プロパティが69個に達し、GASの設定画面が
 * 「最初の50個のみ表示・読み取り専用」になった。
 * 画面からは追加も削除もできず、PEXELS_API_KEY を登録できない。
 *
 * 50個はあくまで画面の表示上限で、保存領域の上限ではない
 * （実際の上限は1件9KB・合計500KB）。つまりコードから
 * setProperty すれば普通に登録できる。
 *
 * エディタに一時的な関数を貼って消す運用は、消し忘れると
 * APIキーがコードに残る（PART 1 §8違反）。恒久的な入口を
 * ここに用意し、画面を二度と触らなくて済むようにする。
 */

/** 値を書き換えさせないキー。壊れると認証が黙って死ぬ。 */
const PROP_ADMIN_PROTECTED_ = /^oauth2\./i;

/** 値をそのまま表示しないキー。LINEの履歴に生の秘密を残さない。 */
const PROP_ADMIN_SECRET_ = /(KEY|SECRET|TOKEN|PASSWORD|ACCESS)/i;

/**
 * 表示用に値を伏せる。
 * 「設定できているか」を確認したいだけなので、先頭4文字と長さが分かれば足りる。
 */
function maskPropValue_(key, value) {
  const s = String(value == null ? '' : value);
  if (!PROP_ADMIN_SECRET_.test(key)) {
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
  if (s.length <= 4) return '****';
  return s.slice(0, 4) + '…（' + s.length + '文字）';
}

/**
 * プロパティを1件設定する。
 *
 * @return {string} LINEへ返す文面
 */
function setPropFromLine_(key, value) {
  const k = String(key || '').trim();
  // ★手順文の「<値>」をカッコごと貼るのは誰でもやる。機械側で落とす
  const v = stripKeyWrappers_(value);

  if (v && looksLikePlaceholder_(v) && PROP_ADMIN_SECRET_.test(k)) {
    return '❌ 見本の文字をそのまま送っています。\n' +
      'カッコを消して、実際の値に置き換えてください。\n\n' +
      '✗ 設定 ' + k + ' <キー>\n' +
      '○ 設定 ' + k + ' 4451685-60023a6e5a1955e0b5db7381e';
  }

  if (!k) return '書式: 設定 キー名 値';
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k)) {
    return '❌ キー名に使えない文字が含まれています: ' + truncate_(k, 40) +
      '\n英数字・アンダースコアのみ使えます。';
  }
  if (PROP_ADMIN_PROTECTED_.test(k)) {
    return '❌ ' + k + ' は認証が管理しているキーのため、ここからは変更できません。\n' +
      '連携をやり直す場合は「連携解除 A」→「Xリンク A」を使ってください。';
  }
  if (!v) return '❌ 値が空です。消したい場合は「設定削除 ' + k + '」を使ってください。';
  // 1件あたり9KBの上限。超えると setProperty が例外を投げる。
  if (v.length > 9000) return '❌ 値が長すぎます（' + v.length + '文字）。9000文字以内にしてください。';

  const existed = props_().getProperty(k) !== null;
  try {
    props_().setProperty(k, v);
  } catch (e) {
    return '❌ 保存に失敗しました: ' + truncate_(String(e), 200);
  }

  return (existed ? '✅ 更新しました' : '✅ 登録しました') + '\n\n' +
    k + ' = ' + maskPropValue_(k, v) + '\n\n' +
    '現在のプロパティ総数: ' + props_().getKeys().length + '件';
}

/** プロパティを1件削除する。 */
function deletePropFromLine_(key) {
  const k = String(key || '').trim();
  if (!k) return '書式: 設定削除 キー名';
  if (PROP_ADMIN_PROTECTED_.test(k)) {
    return '❌ ' + k + ' は認証が管理しているキーのため、ここからは削除できません。\n' +
      '連携を切る場合は「連携解除 A」を使ってください。';
  }
  if (props_().getProperty(k) === null) {
    return '⚠️ ' + k + ' は設定されていません（既に無い状態です）。';
  }
  props_().deleteProperty(k);
  return '🗑 削除しました: ' + k + '\n\n現在のプロパティ総数: ' + props_().getKeys().length + '件';
}

/**
 * プロパティ一覧。
 *
 * ★getKeys() は設定画面と違い50件の表示上限を受けない。全件見える。
 * 設定値（人が決めるもの）と実行時の記録（コードが勝手に増やすもの）を
 * 分けて出す。どれを消していいか判断できないと意味がないため。
 */
function buildPropListText_() {
  const props = props_();
  const keys = props.getKeys().sort();

  // コードが実行中に作る記録。人が設定するものではない＝消しても再生成される。
  const runtimePatterns = [
    /^post_count_/, /^recent_texts_/, /^last_post_text_/, /^b_post_history$/,
    /^binding_checked_at_/, /^buzz_/, /^cycle_outcomes$/, /^gh_recent$/,
    /^link_counter_/, /^poor_quality_notified_at/, /^metrics_trigger_checked_at$/,
    /^rss_health$/, /^ref_used_ids$/, /^stock_/, /_notified_at$/, /^delegate_/
  ];
  const isRuntime = function (k) {
    return runtimePatterns.some(function (re) { return re.test(k); });
  };

  const settings = [];
  const runtime = [];
  const oauth = [];
  keys.forEach(function (k) {
    if (/^oauth2\./i.test(k)) oauth.push(k);
    else if (isRuntime(k)) runtime.push(k);
    else settings.push(k);
  });

  const lines = [];
  lines.push('📋 スクリプトプロパティ（全' + keys.length + '件）');
  lines.push('※設定画面は50件までしか出ませんが、ここは全部見えます');
  lines.push('');
  lines.push('■ 設定値（' + settings.length + '件）');
  settings.forEach(function (k) {
    lines.push('  ' + k + ' = ' + maskPropValue_(k, props.getProperty(k)));
  });
  lines.push('');
  lines.push('■ 実行時の記録（' + runtime.length + '件・消しても自動で作り直されます）');
  runtime.forEach(function (k) { lines.push('  ' + k); });
  lines.push('');
  lines.push('■ 認証（' + oauth.length + '件・触らないこと）');
  lines.push('');
  lines.push('変更: 設定 キー名 値');
  lines.push('削除: 設定削除 キー名');

  return truncate_(lines.join('\n'), 4900);   // LINEの1通あたりの上限に収める
}

/* ------------------------------------------------------------------ */
/* 動画投稿の初期設定（1コマンドで完結させる）                          */
/* ------------------------------------------------------------------ */
/*
 * ★キーを入れるだけでは動画は出ない。
 *
 * VIDEO_UPLOAD が既定OFFのため、PEXELS_API_KEY を登録しても
 * pickBuzzVideo_ は即nullを返す。さらに在庫が空なら
 * ストック補充も別途必要になる。
 *
 * 「キーを入れた → まだ出ない → なぜ？」を3往復繰り返すことになるので、
 * 必要な設定と初回補充をここで一度に済ませる。
 */
/**
 * キーの見た目からサービスを判別する。
 *
 * Pixabay : 「数字-16進数」の形（例 4451685-60023a6e5a1955e0b5db7381e）
 * Pexels  : ハイフン無しの英数字1本（50文字前後）
 *
 * 形が違うので取り違えようがない。どちらのキーを持っているかを
 * 人に選ばせる必要はない。
 */
function detectStockService_(key) {
  const k = stripKeyWrappers_(key);
  if (/^\d{4,12}-[0-9a-f]{16,}$/i.test(k)) return 'PIXABAY';
  if (/^[A-Za-z0-9]{20,}$/.test(k)) return 'PEXELS';
  return null;
}

/**
 * 貼り付けに付いてくる飾りを落とす。
 *
 * ★手順文の「<Pexelsのキー>」を、カッコごとそのまま貼ってしまうのは
 * 誰でもやる（2026-08-22に実際に発生）。書き方を覚えさせるより、
 * 機械が落とす方が速い。引用符・角カッコ・全角カッコも同様に扱う。
 */
function stripKeyWrappers_(key) {
  return String(key || '')
    .trim()
    .replace(/^[<＜"'「『【\[(（]+/, '')
    .replace(/[>＞"'」』】\])）]+$/, '')
    .trim();
}

/**
 * 「キーの中身ではなく、手順書の穴埋め文字をそのまま貼った」状態か。
 * 日本語が入っていれば、それはキーではなく説明文である。
 */
function looksLikePlaceholder_(token) {
  return /[ぁ-んァ-ヶ一-龠]/.test(String(token || '')) ||
         /^(your|api|key|xxx+)/i.test(stripKeyWrappers_(token));
}

/**
 * @param {string} arg LINEで受け取った引数。キーを1つでも2つでも受ける。
 *   「初期設定 <キー>」「初期設定 <Pexelsキー> <Pixabayキー>」どちらも可。
 */
function setupVideoFromLine_(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(function (t) { return t; });

  if (!tokens.length) {
    return [
      '書式: 初期設定 <キー>',
      '',
      'PexelsでもPixabayでも、どちらのキーでも構いません。',
      '形で自動判別するので、どちらか言う必要はありません。',
      '両方持っているなら並べて送れば両方登録します。',
      '',
      'キーの取り方（無料・審査なし・1分）:',
      '  Pexels : pexels.com/api →「Get Started」',
      '  Pixabay: pixabay.com/api/docs （ログインすれば頁内に表示）',
      '',
      '例) 初期設定 4451685-60023a6e5a1955e0b5db7381e'
    ].join('\n');
  }

  const found = {};
  const rejected = [];
  let sawPlaceholder = false;
  tokens.forEach(function (t) {
    const svc = detectStockService_(t);
    if (svc) { found[svc] = stripKeyWrappers_(t); return; }
    if (looksLikePlaceholder_(t)) sawPlaceholder = true;
    rejected.push(t);
  });

  // ★穴埋め文字をそのまま貼った場合は、形の説明より先に「中身を貼れ」と言う
  if (!Object.keys(found).length && sawPlaceholder) {
    return [
      '❌ 見本の文字をそのまま送っています。',
      '',
      '「<Pixabayのキー>」の部分は、カッコごと消して',
      'キーの中身に置き換えてください。',
      '',
      '✗ 初期設定 <Pixabayのキー>',
      '○ 初期設定 4451685-60023a6e5a1955e0b5db7381e',
      '',
      'キーの在り処:',
      '  Pixabay … pixabay.com/api/docs にログインした状態で開くと',
      '            頁の上の方に「Your API key」として表示されます',
      '  Pexels  … pexels.com/api の自分のダッシュボードに',
      '            50文字ほどの英数字が1本出ています'
    ].join('\n');
  }

  if (!Object.keys(found).length) {
    return [
      '❌ キーとして読めませんでした: ' + truncate_(rejected.join(' '), 60),
      '',
      '想定している形:',
      '  Pixabay … 4451685-60023a6e5a1955e0b5db7381e（数字-英数字）',
      '  Pexels  … 英数字が50文字ほど続く1本',
      '',
      '途中で改行や空白が混ざっていないか確認してください。'
    ].join('\n');
  }

  const lines = ['🚀 動画投稿の初期設定', ''];

  ['PEXELS', 'PIXABAY'].forEach(function (svc) {
    const k = found[svc];
    if (!k) return;
    props_().setProperty(svc + '_API_KEY', k);
    lines.push('✅ ' + svc + '_API_KEY を登録（' + k.slice(0, 4) + '…／' + k.length + '文字）');
  });

  if (rejected.length) {
    lines.push('⚠️ 読めなかった文字列は無視しました: ' + truncate_(rejected.join(' '), 40));
  }

  // 既に入っている方のキーも活きる（両方あれば在庫の幅が広がる）
  ['PEXELS', 'PIXABAY'].forEach(function (svc) {
    if (found[svc]) return;
    if (getProp_(svc + '_API_KEY', '')) lines.push('・' + svc + '_API_KEY は登録済み（そのまま使います）');
  });

  // ★これを入れ忘れると、キーがあっても動画は1本も出ない
  props_().setProperty('VIDEO_UPLOAD', '1');
  lines.push('✅ VIDEO_UPLOAD を有効化');

  if (String(getProp_('MEDIA_UPLOAD', '1')) === '0') {
    props_().setProperty('MEDIA_UPLOAD', '1');
    lines.push('✅ MEDIA_UPLOAD を有効化（無効になっていました）');
  }

  lines.push('');
  lines.push('📦 在庫を取りに行きます…');
  lines.push('');

  let total = 0;
  Object.keys(ACCOUNTS).forEach(function (k) {
    try {
      const r = refillStock_(k, STOCK_REFILL_MAX);
      const added = (r && r.added) || 0;
      total += added;
      lines.push('[' + k + '] ' + added + '本 追加' +
        (added === 0 && r && r.reason ? '（' + r.reason + '）' : ''));
    } catch (e) {
      lines.push('[' + k + '] ❌ ' + truncate_(String(e), 120));
    }
  });

  lines.push('');
  if (total > 0) {
    lines.push('🎉 完了。合計' + total + '本の素材が入りました。');
    lines.push('「バズ」と送ると、今すぐ動画付きで1本出します。');
  } else {
    lines.push('⚠️ 素材が1本も取れませんでした。');
    lines.push('キーが正しいか確認のうえ、「ストック補充」で再試行してください。');
    lines.push('原因を見るには「バズ診断」。');
  }

  return lines.join('\n');
}
