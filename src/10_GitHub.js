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
  /*
   * --- 道具の帯 ---
   * 動く物。スター上限で「記念碑」(tensorflow / react / vscode)を外す。
   */
  'topic:ai-agents stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:llm stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:developer-tools stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:cli stars:300..20000 pushed:>{since}',
  'topic:self-hosted stars:' + GITHUB_STAR_BAND + ' pushed:>{since}',
  'topic:automation stars:300..20000 pushed:>{since}',
  'topic:productivity stars:300..20000 pushed:>{since}',

  /*
   * --- 「持ち帰って今日使う」帯（2026-08-27追加）---
   *
   * ★★ブックマーク数がいいね数を上回る投稿の正体がこれだった。
   *
   * 実例: multica-ai/andrej-karpathy-skills を紹介した投稿
   *   いいね 52 / リポスト 9 / 返信 1 / **ブックマーク 86**
   * ブックマークがいいねを上回るのは、「反応したい」ではなく
   * 「後で使うために取っておきたい」と思われた時にだけ起きる。
   * 紹介アカウントが取りに行くべきはこちらで、いいねではない。
   *
   * ★スター上限を掛けない。この帯には掛けてはいけない。
   *   上の実例は **207,912スター** で、上限30,000なら確実に外れる。
   *   だが中身は 20KB の CLAUDE.md 1枚で、フレームワークではない。
   *   つまり「スターが多い＝誰でも知っている記念碑」は成り立たない。
   *
   * 上限の代わりに **種類** で絞る。awesome / prompts / skills /
   * cheatsheet といった語は、道具ではなく資料に付く。
   * tensorflow や react がこれらに引っかかることは無いので、
   * 上限が無くても記念碑は入ってこない。
   */
  'topic:awesome-list stars:>1000 pushed:>{since}',
  'prompts in:name,description stars:>800 pushed:>{since}',
  'skills in:name,description stars:>500 pushed:>{since}',
  'cheatsheet in:name,description stars:>500 pushed:>{since}',

  /*
   * --- 固定ソース（2026-08-29追加）---
   *
   * ★ここだけ検索ではなく **リポジトリを名指し** する。
   *   'repo:owner/name' と書くと fetchGitHubRepo_ が検索APIを使わず
   *   GET /repos/owner/name を直接叩く。
   *
   * 【なぜ名指しが要るか】
   * system-design-primer は 366,597スター。上の道具の帯（上限30,000）では
   * 絶対に届かず、下の資料の帯は awesome / prompts / skills / cheatsheet で
   * 絞っているので topics（design, interview, programming）が一致しない。
   * つまり **今の検索条件では一生出てこない**。だから名指しする。
   *
   * 【なぜこのリポジトリか】
   * Aの読み手（海外エンジニア）にとって、大規模システム設計と面接対策は
   * 「後で読むために保存する」動機が最も強い題材の一つ。
   * 我々が狙っているのは、いいねではなくブックマークである。
   */
  'repo:donnemartin/system-design-primer',
];

/**
 * 名指しで取るリポジトリのうち、**帰属表示が要る**ものの一覧。
 *
 * ★★2026-08-29、ライセンス本文を読んで確認した。
 *
 * system-design-primer の LICENSE.txt は CC BY 4.0（GitHubのAPI上は
 * NOASSERTION と表示されるので、API任せでは分からない）。
 * リンクを貼るだけなら帰属表示の義務は生じないが、この先この中身から
 * 台本を作るなら必要になる。**出典を書く癖を最初から付けておく。**
 *
 * ★ここに無いリポジトリには何も足さない。要らない一文を毎回入れると
 *   本文の文字数を食う。
 */
const GITHUB_ATTRIBUTION = {
  'donnemartin/system-design-primer': 'CC BY 4.0'
};

/**
 * 紹介するリポジトリを1件取得する。
 * @return {?{fullName:string, url:string, description:string, stars:number, language:string}}
 */
function fetchGitHubRepo_() {
  const query = getProp_('GITHUB_QUERY', defaultGitHubQuery_());

  /*
   * ★'repo:owner/name' は検索ではなく名指し。
   *   検索APIは同じ条件でも並びが揺れるうえ、qualifierの扱いも一定しない。
   *   名指しなら GET /repos/... が必ずその1件を返す。決定的である。
   */
  if (query.indexOf('repo:') === 0) {
    return fetchGitHubRepoByName_(query.slice(5).trim());
  }

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
 * リポジトリを名指しで1件取る。
 *
 * ★gh_recent による除外を通さない。固定ソースは「順番が来たら必ず出す」
 *   ものなので、一度紹介したことを理由に飛ばしてはいけない。
 *   ただし記録はする（検索の帯が同じものを引いた時に重複させないため）。
 *
 * @param {string} fullName 'owner/name'
 * @return {?Object} 取れなければ null（呼び出し側は投稿を諦める）
 */
function fetchGitHubRepoByName_(fullName) {
  if (!fullName || fullName.indexOf('/') === -1) {
    console.warn('固定ソースの指定が不正です: ' + fullName);
    return null;
  }

  let res;
  try {
    res = fetchWithRetry_('https://api.github.com/repos/' + fullName, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'gas-x-line-bot'   // GitHub APIはUser-Agent必須
      },
      muteHttpExceptions: true
    });
  } catch (err) {
    console.warn('GitHub API への接続に失敗（固定ソース ' + fullName + '）: ' + err);
    return null;
  }

  const code = res.getResponseCode();
  if (code !== 200) {
    console.warn('GitHub API エラー ' + code + '（固定ソース ' + fullName + '）: ' +
                 truncate_(res.getContentText(), 300));
    return null;
  }

  let repo;
  try {
    repo = normalizeGitHubRepo_(JSON.parse(res.getContentText()));
  } catch (e) {
    console.warn('GitHub 応答の解釈に失敗（固定ソース ' + fullName + '）: ' + e);
    return null;
  }
  if (!repo) {
    console.warn('固定ソースから必要なフィールドを取り出せませんでした: ' + fullName);
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

  /*
   * ★★2026-08-29、帰属表示が要るリポジトリだけ一文を足す。
   *
   * CC BY のような表示義務のあるライセンスは、GitHubのAPIでは
   * NOASSERTION としか返らないことがある（system-design-primer が実際そう）。
   * APIの license 欄を信じず、こちらで確認した一覧だけを根拠にする。
   */
  const credit = GITHUB_ATTRIBUTION[repo.fullName];
  if (credit) {
    lines.push('- License: ' + credit + ' (attribution required)');
  }
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
  /*
   * ★★2026-08-27。伸びている他人のリポジトリ紹介投稿を分解して反映した。
   *
   * 【見本】prompts.chat を紹介した中国語の投稿
   *   9,123インプレッション / 169いいね / 22リポスト
   * 効いていたのは次の3点だった。
   *   1) 数字が「リポジトリの有名さ」ではなく「読み手の得」に付いていた
   *      （3000+テンプレ / 15分で構築 / 月50ドル節約）
   *   2) 何と比べて何が要らなくなるかを言っていた
   *   3) 最後が問いかけで終わっていた（返信が付くと配信が伸びる）
   *
   * 【真似してはいけない点】
   * あの投稿には 166.8k / 143k / 168k と、同じスター数が3つ出てくる。
   * 数字が食い違うのは、AIが書いた文章の最も分かりやすい兆候である。
   * こちらはAPIの実データを1つだけ持っているので、そこで必ず勝てる。
   * また「先週これを構築した」といった一人称の体験談も真似しない。
   * 我々は使っていない。嘘を書けば、訂正の返信で伸びても信用が減る
   * （このファイル冒頭の方針と同じ）。
   */
  lines.push('Introduce this repository to developers who have never heard of it.');
  lines.push('');
  lines.push('# What makes this kind of post work');
  /*
   * ★狙う数字はブックマークであっていいねではない（2026-08-27）。
   *   実例の投稿は いいね52 に対して ブックマーク86。
   *   後で使うために取っておかれた時にだけ、この逆転が起きる。
   */
  lines.push('- Aim to be SAVED, not liked. Someone should bookmark this to');
  lines.push('  come back to it. That means saying when they would reach for it.');
  lines.push('- Lead with what the reader stops doing, or what this replaces.');
  lines.push('- Attach a number to the READER\'S outcome, not to the repo\'s fame.');
  lines.push('  Only use numbers that appear in the facts above. Never estimate.');
  lines.push('- Name the specific thing from the description. Not "a tool" -- what it is.');
  lines.push('- End with a real question to developers. Not rhetorical. Something');
  lines.push('  someone would actually answer. This is what earns replies.');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- The star count is NOT the story. Do not open with it and do not');
  lines.push('  call it impressive. Use the exact figure above or omit it entirely.');
  lines.push('  NEVER write the same number two different ways in one post.');
  lines.push('- Do NOT claim you used it, installed it, tested it, or compared it.');
  lines.push('  You have not. No "I set this up", no "I tried five alternatives".');
  lines.push('- No emoji-numbered lists (1/2/3), no "hidden gem", "treasure",');
  lines.push('  "game changer", "must-have", "bookmark this". Those read as bot copy.');
  lines.push('- Use the URL exactly as given. Do not invent features, benchmarks,');
  lines.push('  pricing, install steps, or anything not listed above.');
  if (credit) {
    lines.push('- This repository is licensed ' + credit + '. The URL above is the');
    lines.push('  credit -- keep it in the post. Do not quote or paraphrase its');
    lines.push('  contents; point to it.');
  }
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
