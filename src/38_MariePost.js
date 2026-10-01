/**
 * ===========================================================================
 * 38_MariePost.gs  —  承認したマリー動画を X（アカウントA＝日本語）へ投稿する
 * ===========================================================================
 *
 * ★★2026-10-01、オーナー指示「Aも動かして」（jmas-ai-os 決定#245）。
 *
 * 【なぜ要るか】
 * マリー動画（jmas-ai-os の部署B）は LINE で承認しても、投稿は手作業だった。
 * Supabase には X の鍵が無い。X の鍵は GAS（ここ）にだけある（CLAUDE.md・#201）。
 *
 * 【流れ】
 *   描画（render-video）… Release「render-<job_id>」に out.mp4 と post.json（投稿文）を置く
 *   承認依頼（LINE）     … ［Xに投稿］ボタン＝「X投稿 <job_id>」という文を、オーナーの指で GAS へ送る
 *   ここ                 … Release から動画と投稿文を取り、アカウントAへ動画付きで投稿する
 *
 * 【守ること】
 *   ・動くのは許可された LINE ユーザー（isAllowedLineUser_）が「X投稿 <job_id>」を送った時だけ。自動では投稿しない
 *   ・投稿文は描画側が組んだ物をそのまま使う（#PR 先頭・※条件・#AI生成）。ここで書き換えない
 *   ・本文に楽天のリンクが無ければ投稿しない。リンクの無い本文には固定CTA（別の商材のリンク）が付いてしまうため
 *   ・同じ job は2度投稿しない
 *   ・他の自動投稿の動画スイッチ（VIDEO_UPLOAD）は変えない。この命令だけ動画を付ける
 */

/** 投稿先。★GAS の A＝日本語（部署B）。部署の記号と逆（#201） */
function mariePostAccount_() {
  const v = String(getProp_('MARIE_X_ACCOUNT', 'A')).toUpperCase();
  return ACCOUNTS[v] ? v : 'A';
}

/** job_id の形（marie-<商品>-auto）。Release のタグにそのまま使うので形を絞る */
const MARIE_JOB_RE = /^marie-[a-z0-9-]{3,80}$/;

/** 投稿文に必要な楽天のリンク */
const MARIE_LINK_RE = /https:\/\/(hb\.afl\.rakuten\.co\.jp|item\.rakuten\.co\.jp|a\.r10\.to)\//;

/** Release「render-<job_id>」の資産一覧。無ければ null */
function marieReleaseAssets_(jobId) {
  let res;
  try {
    res = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + githubRepo_() + '/releases/tags/render-' + encodeURIComponent(jobId), {
        headers: {
          Authorization: 'Bearer ' + githubToken_(),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        muteHttpExceptions: true
      });
  } catch (e) {
    console.warn('Releaseを確認できません: ' + truncate_(String(e), 100));
    return null;
  }
  if (res.getResponseCode() !== 200) return null;
  try {
    return (JSON.parse(res.getContentText()).assets) || [];
  } catch (e) {
    return null;
  }
}

/** Release の小さな文字の資産（post.json）を読む */
function marieReadTextAsset_(assetId) {
  const res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + githubRepo_() + '/releases/assets/' + encodeURIComponent(assetId), {
      headers: {
        Authorization: 'Bearer ' + githubToken_(),
        Accept: 'application/octet-stream',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      muteHttpExceptions: true
    });
  if (res.getResponseCode() !== 200) return null;
  return res.getContentText('UTF-8');
}

/**
 * 「X投稿 <job_id>」の本体。LINE へ返す文面を返す。
 * @param {string} jobId
 * @return {string}
 */
function handleMariePost_(jobId) {
  if (!MARIE_JOB_RE.test(jobId)) return '動画の番号の形が違います（marie-〜）。';
  const doneKey = 'marie_posted_' + jobId;
  const done = getProp_(doneKey, '');
  if (done) return 'この動画はもう投稿済みです。\n' + done;
  if (!githubRepo_() || !githubToken_()) return 'GITHUB_REPO / GITHUB_TOKEN が未設定のため、動画を取りに行けません。';

  const assets = marieReleaseAssets_(jobId);
  if (!assets) return '動画が見つかりません（描画から3日を過ぎると片づけられます）。描き直してください。';
  const mp4 = assets.filter(function (a) { return /\.mp4$/i.test(String(a.name || '')); })[0];
  const pj = assets.filter(function (a) { return String(a.name || '') === 'post.json'; })[0];
  if (!mp4 || !pj) return '動画か投稿文が Release にありません（' + (mp4 ? 'post.json' : 'mp4') + ' が無い）。';

  let text = '';
  try {
    text = String((JSON.parse(marieReadTextAsset_(pj.id) || '{}')).x || '').trim();
  } catch (e) {
    return '投稿文を読めません。';
  }
  if (!/^#PR/.test(text)) return '投稿文の先頭に #PR がありません。投稿しません。';
  if (!MARIE_LINK_RE.test(text)) return '投稿文に楽天のリンクがありません。投稿しません（product_json に affiliate_url を入れて描き直してください）。';

  const acc = mariePostAccount_();
  const blob = downloadRenderAsset_(mp4.id);
  if (!blob) return '動画を取り出せません（大きさ・通信）。';
  const mediaId = uploadVideoToX_(acc, { blob: blob }, { force: true });
  if (!mediaId) return 'X へ動画を上げられませんでした（連携の media.write・残高・制限）。「点検」で状態を見てください。';

  let r;
  try {
    r = postTweet_(acc, text, { mediaIds: [mediaId] });
  } catch (e) {
    return 'X への投稿で止まりました:\n' + truncate_(String(e && e.message ? e.message : e), 300);
  }
  props_().setProperty(doneKey, r.url || r.id || 'posted');
  return getAccount_(acc).label + ' に投稿しました。\n' + (r.url || '');
}
