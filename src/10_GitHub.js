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

  return {
    fullName: fullName,
    url: url,
    description: String(item.description || '').trim(),
    stars: Number(item.stargazers_count || 0) || 0,
    language: String(item.language || '').trim()
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
 * 既定の検索条件。スターが多く、直近90日以内に更新のあるものに絞る。
 *
 * ★この条件は必ず商材のジャンルに合わせて上書きすること。
 * 既定のままだと分野を問わず人気リポジトリが出るため、
 * 「無料ツールが欲しいだけの層」が集まり、商材の購買層と重ならない。
 * 例: GITHUB_QUERY = topic:marketing-automation stars:>500 pushed:>2026-06-01
 */
function defaultGitHubQuery_() {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const d = Utilities.formatDate(since, 'UTC', 'yyyy-MM-dd');
  return 'stars:>2000 pushed:>' + d;
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
  lines.push('');
  lines.push('Introduce this repository. Say what it is useful for in plain terms.');
  lines.push('Use the URL exactly as given. Do not invent features, benchmarks, or comparisons.');
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
