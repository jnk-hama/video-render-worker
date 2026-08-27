/**
 * ===========================================================================
 * 10_GitHub.gs  —  実在するGitHubリポジトリの取得
 * ===========================================================================
 * 「有用なリポジトリを紹介する」投稿のための素材取得。
 *
 * 【なぜAPIから取るのか】
 * LLMにリポジトリを挙げさせると、実在しない名前とURLを平然と生成する。
 * フォロワーがクリックして404だった時点でアカウントの信用が終わるため、
 * 名前・説明・スター数・URLは必ずGitHub APIの実データだけを使う。
 * LLMには「渡した事実の範囲で書く」ことしかさせない。
 *
 * 【認証について】
 * 未認証で叩く。検索APIの未認証レートは10回/分程度だが、
 * 呼び出しは最大でも2時間に1回なので問題にならない。
 * トークンを置くとスクリプトプロパティに秘密情報が増えるので、あえて使わない。
 *
 * 【必要なスクリプトプロパティ】
 *   GITHUB_QUERY … 検索条件（任意）。既定は「スター多め＋直近更新あり」
 *
 * ※このファイルのAPIレスポンス形状は、開発環境から実際に叩いて確認できていない
 *   （ネットワーク制限のため）。フィールドが取れない場合に落ちないよう
 *   防御的に書いてある。実物は testGitHubFetch() で確認できる。
 */

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';

/** 上位何件からランダムに選ぶか。1件固定だと毎回同じリポジトリになる。 */
const GITHUB_PICK_FROM_TOP = 30;

/** 直近で紹介したリポジトリを覚えておく件数（重複紹介の防止） */
const GITHUB_RECENT_MEMORY = 40;

/**
 * 狙うスターの帯。
 *
 * ★下限だけでなく **上限** が要る。上限が無いと、star降順で引く以上
 *   毎回GitHub全体の最上位（10万スター級）しか返らない。
 *   知られていないが実用に足るものは、この帯にいる。
 */
const GITHUB_STAR_BAND = '300..30000';

/**
 * 既定の検索条件。順番に回す。
 *
 * ★分野を絞ってあるのは、10_GitHub.gs の旧コメントにあった指摘のとおり
 *   「分野を問わない人気リポジトリ」を出すと、無料ツール目当ての層しか
 *   集まらず、紹介したい商材の購買層と重ならないため。
 *   Aの土俵（開発者・AI・自動化）へ寄せてある。
 */
const GITHUB_QUERY_ROTATION = [
  'topic:ai-agents stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:llm stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:developer-tools stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:cli stars:300..20000 pushed:>{since}',
  'topic:self-hosted stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:automation stars:300..20000 pushed:>{since}',
  'topic:productivity stars:300..20000 pushed:>{since}',
];

/**
 * 紹介するリポジトリを1件取得する。
 * @return {?{fullName:string, url:string, description:string, stars:number, language:string}}
 */
function fetchGitHubRepo_() {
  const query = getProp_('GITHUB_QUERY', defaultGitHubQuery_());

  const url = GITHUB_SEARCH_URL +
    '?q=' + encodeURIComponent(query) +
    '&sort=stars&order=desc&per_page=' + GITHUB_PICK_FROM_TOP;

  let res;
  try {
    res = fetchWithRetry_(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'gas-x-line-bot'   // GitHub APIはUser-Agent必須
      },
      muteHttpExceptions: true
    });
  } catch (err) {
    console.warn('GitHub API への接続に失敗: ' + err);
    return null;
  }

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200) {
    console.warn('GitHub API エラー ' + code + ': ' + truncate_(body, 300));
    return null;
  }

  let items;
  try {
    items = (JSON.parse(body) || {}).items || [];
  } catch (e) {
    console.warn('GitHub API 応答の解釈に失敗: ' + truncate_(body, 200));
    return null;
  }
  if (!items.length) {
    console.warn('GitHub 検索結果が0件でした。GITHUB_QUERY を見直してください: ' + query);
    return null;
  }

  // 直近で紹介済みのものを除外する
  const recent = getProp_('gh_recent', '').split(',').filter(String);
  const fresh = items.filter(function (it) {
    return recent.indexOf(String(it.full_name || '')) === -1;
  });
  const pool = fresh.length ? fresh : items;   // 全部紹介済みなら諦めて再利用

  const picked = pool[Math.floor(Math.random() * pool.length)];
  const repo = normalizeGitHubRepo_(picked);
  if (!repo) {
    console.warn('GitHub 応答から必要なフィールドを取り出せませんでした: ' +
                 truncate_(JSON.stringify(picked), 300));
    return null;
  }

  rememberGitHubRepo_(repo.fullName);
  return repo;
}

/**
 * APIの1件分を、こちらで使う形に落とす。
 * フィールド名が想定と違っても落ちないよう、取れないものは空で返す。
 * ただし名前とURLだけは必須（無ければ紹介できない）。
 */
function normalizeGitHubRepo_(item) {
  if (!item) return null;

  const fullName = String(item.full_name || '').trim();
  const url = String(item.html_url || '').trim() ||
              (fullName ? 'https://github.com/' + fullName : '');

  if (!fullName || !url) return null;

  /*
   * ★topics と最終更新を足した（2026-08-27）。
   *   説明文だけだと「何をするものか」しか書けず、投稿がスター数の話へ
   *   逃げる（実際にそうなった）。topics は用途、pushed_at は「生きているか」
   *   を示す。どちらもAPIの実データなので、LLMに作らせずに済む。
   */
  return {
    fullName: fullName,
    url: url,
    description: String(item.description || '').trim(),
    stars: Number(item.stargazers_count || 0) || 0,
    language: String(item.language || '').trim(),
    topics: (item.topics || []).slice(0, 6).map(String),
    pushedAt: String(item.pushed_at || '').slice(0, 10)
  };
}

function rememberGitHubRepo_(fullName) {
  try {
    const recent = getProp_('gh_recent', '').split(',').filter(String);
    recent.unshift(fullName);
    props_().setProperty('gh_recent', recent.slice(0, GITHUB_RECENT_MEMORY).join(','));
  } catch (e) {
    console.warn('紹介済みリポジトリの記録に失敗: ' + e);
  }
}

/**
 * 既定の検索条件を1つ返す。呼ぶたびに次の条件へ進む。
 *
 * ★★2026-08-27、実測を見て作り直した。
 *
 * 【何が起きていたか】
 * 旧実装は 'stars:>2000' を star降順で引き、上位30件から選んでいた。
 * 下限しか無いので、返るのは常に **GitHubで最もスターが多い30件** になる。
 * tensorflow / react / vscode / linux — 毎回この顔ぶれになる。
 *
 * 実際に出た投稿がこれだった。
 *   「197,638 stars for a C++ repository is a wild sight on GitHub.」
 * リンククリックは1/15（CTR 6.7%）と数字自体は良かったが、
 * 書ける内容が「スターが多い」しか無い。TensorFlowを知らない開発者は
 * いないので、2本目からは価値が落ちる。有名なものを有名だと言う投稿は
 * 続かない。
 *
 * 【変えたこと】
 * 1) スターに **上限** を付けた（既定 30,000）。記念碑ではなく、
 *    「知らなかったが今日から使える道具」の帯を狙う。
 *    197,638スターの相手は、この上限で自動的に外れる
 * 2) 条件を **複数持って順番に回す**。1つの条件だと分野が固定され、
 *    数十件を出し切った後は gh_recent の除外により品質が落ちていく
 * 3) ランダムにしない。順番に回せば必ず一巡する（rotatingStockQuery_ と同じ考え方）
 *
 * GITHUB_QUERY を設定してあれば従来どおりそちらが優先される（挙動は不変）。
 * GITHUB_QUERIES に「|」区切りで並べれば、この既定を丸ごと差し替えられる。
 */
function defaultGitHubQuery_() {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const d = Utilities.formatDate(since, 'UTC', 'yyyy-MM-dd');

  const custom = String(getProp_('GITHUB_QUERIES', '')).trim();
  const list = custom
    ? custom.split('|').map(function (x) { return x.trim(); }).filter(String)
    : GITHUB_QUERY_ROTATION.map(function (q) { return q.replace('{since}', d); });

  if (!list.length) return 'stars:' + GITHUB_STAR_BAND + ' pushed:>' + d;

  /*
   * ★順番に回す。プロパティが読めない環境でも投稿は止めない
   *   （その場合は毎回1本目になるが、0件になるよりよい）。
   */
  let i = 0;
  try {
    i = Number(getProp_('gh_query_idx', '0')) || 0;
    props_().setProperty('gh_query_idx', String((i + 1) % list.length));
  } catch (e) {
    console.warn('検索条件の順番を保存できませんでした: ' + e);
  }
  return list[((i % list.length) + list.length) % list.length];
}

/**
 * LLMへ渡す「事実」の文字列を作る。
 * ここに書かれていないことは書くなと指示しているので、必要な情報は全部入れる。
 */
function buildGitHubFacts_(repo) {
  const lines = [
    'A real GitHub repository (verified from the GitHub API just now):',
    '- Name: ' + repo.fullName,
    '- URL: ' + repo.url
  ];
  if (repo.description) lines.push('- What it is: ' + repo.description);
  if (repo.stars) lines.push('- Stars: ' + repo.stars.toLocaleString());
  if (repo.language) lines.push('- Main language: ' + repo.language);
  if (repo.topics && repo.topics.length) {
    lines.push('- Topics: ' + repo.topics.join(', '));
  }
  if (repo.pushedAt) lines.push('- Last pushed: ' + repo.pushedAt);
  lines.push('');

  /*
   * ★★書かせ方（2026-08-27）。
   *
   * 実測: TensorFlowの回はリンククリック1/15（CTR 6.7%）と数字は良かったが、
   * 本文は「197,638 stars is a wild sight」——スター数の話だけだった。
   * スター数は誰でも見れば分かる情報で、読む理由にならない。
   * 有名な相手を有名だと言う投稿は、2本目から価値が落ちる。
   *
   * star上限で相手は変わったので、書かせ方も合わせる。
   * 開くに値する理由は「今まで何でやっていた作業が要らなくなるか」であり、
   * それは description と topics から言える。星の数からは言えない。
   */
  lines.push('Introduce this repository to developers who have never heard of it.');
  lines.push('Lead with what it lets you stop doing, or what it replaces.');
  lines.push('The star count is NOT the story. Do not open with it, and do not');
  lines.push('call the number impressive. Mention it only if it adds something.');
  lines.push('Use the URL exactly as given. Do not invent features, benchmarks,');
  lines.push('comparisons, install steps, or anything not listed above.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 動作確認                                                            */
/* ------------------------------------------------------------------ */

/**
 * GitHub APIが実際に何を返すか確認する。
 * 開発環境から検証できていないため、まずこれを実行して形を確かめること。
 */
function testGitHubFetch() {
  const query = getProp_('GITHUB_QUERY', defaultGitHubQuery_());
  console.log('検索条件: ' + query);

  const repo = fetchGitHubRepo_();
  if (!repo) {
    console.log('取得できませんでした。上のログにエラー内容が出ています。');
    return;
  }

  console.log([
    '',
    '=== 取得したリポジトリ ===',
    '名前   : ' + repo.fullName,
    'URL    : ' + repo.url,
    '説明   : ' + (repo.description || '(なし)'),
    'スター : ' + repo.stars.toLocaleString(),
    '言語   : ' + (repo.language || '(不明)'),
    '',
    '=== LLMへ渡す事実 ===',
    buildGitHubFacts_(repo)
  ].join('\n'));
}
