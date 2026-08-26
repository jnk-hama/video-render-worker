/**
 * ===========================================================================
 * 20_LinkSeeds.gs  —  Linksシートの下ごしらえ
 * ===========================================================================
 * アフィリエイトIDが取れる前に、扱う商材の枠だけ作っておく。
 *
 * 【なぜURLを入れないのか】
 * 商品URL（ASIN）をこちらで用意することはできない。
 * 実在を確認できない商品URLを書けば、それは捏造であり、
 * 貼った瞬間に読者を存在しないページへ送ることになる。
 *
 * だからここで作るのは「枠」だけにする。
 *   ・何を扱うか（カテゴリ・商品タイプ）
 *   ・なぜこのアカウントに合うか
 *   ・どう探すか（amazon.com での検索語）
 * URL列は空のまま置き、オーナーが実物を貼る。
 *
 * 【安全側の既定値】
 * 追加する行は全て Verified=FALSE / Status=DRAFT / Active=FALSE。
 * 検証していないものが自動投稿に混ざらないことを、
 * 既定値の側で保証する（PART 1の「規約が曖昧なら安全側」と同じ考え方）。
 */

/**
 * 日本製・日本発の商材の候補。
 *
 * ★選定の基準は「日本にいる人間にしか書けない説明があるか」。
 * 単に日本製なだけの物は入れていない。
 * 国内版と輸出版で中身が違う、日本語の情報しか無い、
 * 現地では別カテゴリ扱いになる——そういう物を選んでいる。
 *
 * search は amazon.com で探すときの検索語。
 * 米国の読者がそのまま買えることを条件にしているので、
 * amazon.co.jp ではなく amazon.com を前提にしている。
 */
const JAPAN_LINK_SEEDS = [
  { category: 'Kitchen', type: 'knife',
    search: 'japanese santoku knife VG-10',
    note: '包丁。鋼材（VG-10/白紙/青紙）と刃付けの違いは英語圏でほぼ説明されていない。単価が高く初回から利益が出る' },
  { category: 'Kitchen', type: 'knife-care',
    search: 'japanese whetstone 1000 6000 grit',
    note: '砥石。包丁を買った人が次に必ず要る。抱き合わせが自然に成立する' },
  { category: 'Kitchen', type: 'cookware',
    search: 'japanese carbon steel wok / iron pan',
    note: '鉄鍋。手入れの手順が日本語資料に偏っており、説明に価値がある' },
  { category: 'Kitchen', type: 'donabe',
    search: 'donabe clay pot japanese',
    note: '土鍋。海外では調理器具としての使い方自体が知られていない' },
  { category: 'Kitchen', type: 'rice',
    search: 'zojirushi rice cooker',
    note: '炊飯器。国内版と輸出版で電圧と機能が違う。ここは実際に説明の需要がある' },

  { category: 'Stationery', type: 'pen',
    search: 'japanese gel pen fine 0.38',
    note: '筆記具。単価は低いが購入点数が多く、リピートしやすい' },
  { category: 'Stationery', type: 'notebook',
    search: 'japanese notebook tomoe river paper',
    note: '紙。にじみ・裏抜けの差が実測で語れる。万年筆層と接続する' },
  { category: 'Stationery', type: 'fountain-pen',
    search: 'japanese fountain pen fine nib',
    note: '万年筆。日本の細字は海外の同表記より細い。これは説明すべき差' },

  { category: 'Tools', type: 'hand-tool',
    search: 'japanese pull saw ryoba',
    note: '引いて切る鋸。西洋鋸と挙動が逆で、使い方の説明が要る' },
  { category: 'Tools', type: 'garden',
    search: 'japanese hori hori garden knife',
    note: '園芸具。園芸層は購買力が高く、季節性もある' },
  { category: 'Tools', type: 'precision',
    search: 'japanese precision tweezers / nippers',
    note: '精密工具。模型・電子工作層に刺さる。指名買いされやすい' },

  { category: 'Home', type: 'textile',
    search: 'imabari towel japan',
    note: 'タオル。産地の規格が実在し、説明に根拠を置ける' },
  { category: 'Home', type: 'kitchenware',
    search: 'japanese bento box',
    note: '弁当箱。用途と密閉性の説明で差がつく' },

  { category: 'Outdoor', type: 'gear',
    search: 'snow peak titanium',
    note: 'アウトドア。日本のメーカーが海外で評価されており、単価も高い' },

  { category: 'Audio', type: 'headphone',
    search: 'japanese iem earphone',
    note: 'イヤホン。日本のブランドとチューニングの傾向を説明できる' }
];

/**
 * 候補をLinksシートへ追加する。
 *
 * ★既にある行には触らない。URLが空の候補行が既にあれば重複追加もしない。
 *
 * @return {{added:number, skipped:number}}
 */
function seedJapanLinkCandidates_() {
  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateLinksSheet_(ss);

  // 既存のNoteを集めて重複を避ける
  const lastRow = sheet.getLastRow();
  const existing = {};
  if (lastRow >= 2) {
    const notes = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    notes.forEach(function (r) {
      const v = String(r[0] || '').trim();
      if (v) existing[v] = true;
    });
  }

  const col = {};
  LINKS_HEADERS.forEach(function (h, i) { col[h] = i; });

  const rows = [];
  let skipped = 0;

  JAPAN_LINK_SEEDS.forEach(function (seed) {
    const note = '[候補] ' + seed.search + ' — ' + seed.note;
    if (existing[note]) { skipped++; return; }

    const row = new Array(LINKS_HEADERS.length).fill('');
    row[col['URL']] = '';                      // ★オーナーが実物を貼る
    row[col['Note']] = note;
    row[col['Target']] = 'A';
    row[col['Platform']] = 'AMAZON';
    row[col['Category']] = seed.category;
    row[col['ProductType']] = seed.type;
    row[col['GEO']] = 'US';
    row[col['Priority']] = '';
    row[col['Active']] = 'FALSE';
    row[col['Adult']] = 'FALSE';
    row[col['DisclosureRequired']] = 'TRUE';
    row[col['DisclosureText']] = '#ad';
    // ★検証していないことを既定値で保証する。
    // ここを埋めるのは、規約と実URLを自分で確認した人間の仕事。
    row[col['Verified']] = 'FALSE';
    row[col['Status']] = 'DRAFT';
    row[col['RiskLevel']] = 'UNVERIFIED';
    rows.push(row);
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LINKS_HEADERS.length)
         .setValues(rows);
    SpreadsheetApp.flush();
  }

  return { added: rows.length, skipped: skipped };
}

/** LINEへ返す文面。 */
function seedJapanLinksReport_() {
  let r;
  try {
    r = seedJapanLinkCandidates_();
  } catch (e) {
    return '【候補追加】失敗\n' + truncate_(String(e && e.message ? e.message : e), 200);
  }

  return [
    '【候補追加】Linksシートに ' + r.added + '件 追加しました' +
      (r.skipped ? '（既存 ' + r.skipped + '件はそのまま）' : ''),
    '',
    'すべて Status=DRAFT / Verified=FALSE で入れてあります。',
    'この状態では投稿に使われません。',
    '',
    '次にやること（シート上で）',
    '  1. amazon.com でNote欄の検索語を引く',
    '  2. アソシエイトのリンクを URL 列へ貼る',
    '  3. 実際にリンクを踏んで、商品ページが開くことを確認する',
    '  4. Verified=TRUE / Status=ACTIVE / Active=TRUE にする',
    '',
    '3を飛ばさないでください。踏まずに有効化すると、',
    '読者を壊れたページへ送ることになります。'
  ].join('\n');
}
