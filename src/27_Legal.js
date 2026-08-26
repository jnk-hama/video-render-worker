/**
 * 公開ページ（プライバシーポリシー / 利用規約）。
 *
 * 【なぜ要るか】
 * TikTok Content Posting API の審査は、プライバシーポリシーの
 * 「公開URL」を必須で求める。X も同様の欄を持つ。
 * このプロジェクトには自前のドメインが無く、ホスティングも無かった。
 *
 * 【なぜここに置くか】
 * 既にWebアプリ（/exec）が公開されている。`?go=` のクリック計測が
 * ADMIN_TOKEN 無しで通っているのと同じ経路に相乗りすれば、
 * ドメイン購入もGitHub Pagesも要らずに公開URLが手に入る。
 *
 *   https://script.google.com/macros/s/<ID>/exec?legal=privacy
 *   https://script.google.com/macros/s/<ID>/exec?legal=terms
 *
 * 【重要】ここに書く内容は「実装と一致していなければならない」。
 * 審査で提出した説明と実際の挙動がずれると、規約違反として扱われる。
 * データの扱いを変えたら、必ずこのファイルも直すこと。
 *
 * ★2026-08-20 時点の実装で確認した事実：
 *   ・クリック計測(23_Redirect.gs)が記録するのは
 *     [token, 日時, ref(200字まで)] の3つだけ
 *   ・IPアドレス・User-Agent・Cookie は一切保存していない
 *   ・第三者のアカウント情報は扱わない（運用者自身のアカウントのみ）
 */

/** 連絡先。スクリプトプロパティ CONTACT_EMAIL で差し替えられる。 */
function legalContactEmail_() {
  return getProp_('CONTACT_EMAIL', '') || '(未設定：CONTACT_EMAIL を設定してください)';
}

/** 運用者名。審査書類と揃える。 */
function legalOperatorName_() {
  return getProp_('OPERATOR_NAME', '') || 'Jmas';
}

/** 最終更新日。内容を変えたらここも変える。 */
const LEGAL_LAST_UPDATED = '2026-08-20';

/**
 * 公開ページの入口。ADMIN_TOKEN の検査より前に呼ばれる。
 *
 * ★トークンを要求してはいけない。審査担当者も一般の閲覧者も
 * トークンを持っていない。持たせたら公開URLとして成立しない。
 */
function handleLegalRequest_(params) {
  const kind = String((params && params.legal) || '').toLowerCase();
  if (kind === 'terms') {
    return renderLegalPage_('Terms of Service', buildTermsHtml_());
  }
  return renderLegalPage_('Privacy Policy', buildPrivacyHtml_());
}

/**
 * 法務ページ用の描画。
 *
 * ★renderPage_ は本文を <pre> でエスケープするため、見出しやリンクを
 * 出せない。審査で読まれるページなので、こちらは独自に組む。
 */
function renderLegalPage_(title, bodyHtml) {
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title>' +
    '<style>' +
    'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.75;' +
    'max-width:760px;margin:0 auto;padding:32px 20px 80px;color:#1a1a1a}' +
    'h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}' +
    '.meta{color:#666;font-size:14px;margin:0 0 28px}' +
    'ul{padding-left:22px}li{margin:6px 0}' +
    'code{background:#f3f3f3;padding:2px 5px;border-radius:3px;font-size:13px}' +
    'a{color:#1d9bf0}' +
    '@media(prefers-color-scheme:dark){body{background:#15181c;color:#e7e9ea}' +
    'code{background:#26292e}.meta{color:#9aa0a6}}' +
    '</style></head><body>' +
    '<h1>' + escapeHtml_(title) + '</h1>' +
    '<p class="meta">' + escapeHtml_(legalOperatorName_()) +
    ' &middot; Last updated: ' + LEGAL_LAST_UPDATED + '</p>' +
    bodyHtml +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * プライバシーポリシー本文。
 *
 * ★英語で書く。TikTok・X の審査担当者が読む。
 * 日本語だけだと読まれずに差し戻される可能性がある。
 */
function buildPrivacyHtml_() {
  const mail = escapeHtml_(legalContactEmail_());
  const op = escapeHtml_(legalOperatorName_());

  return '' +
    '<p>This service is a personal automation tool operated by ' + op + '. ' +
    'It publishes posts to social media accounts that the operator owns, and ' +
    'measures clicks on links contained in those posts.</p>' +

    '<h2>1. Who this policy covers</h2>' +
    '<ul>' +
    '<li><strong>The operator.</strong> The only account holder whose credentials this service stores.</li>' +
    '<li><strong>Visitors who click a link in a post.</strong> See section 3.</li>' +
    '</ul>' +
    '<p>This service does not offer sign-up, does not create accounts for other people, ' +
    'and does not act on behalf of any third party.</p>' +

    '<h2>2. Data stored for the operator</h2>' +
    '<ul>' +
    '<li>OAuth access tokens and refresh tokens for the operator’s own social media accounts</li>' +
    '<li>The operator’s own messaging account identifier, used to send status notifications</li>' +
    '<li>Text and images the service generates and publishes</li>' +
    '</ul>' +
    '<p>These are held in Google Apps Script Properties and Google Sheets under the ' +
    'operator’s own Google account. They are not sold, rented, or shared with third parties, ' +
    'and are not used to build advertising profiles.</p>' +

    '<h2>3. Data recorded when someone clicks a link</h2>' +
    '<p>When a visitor follows a redirect link published by this service, exactly three ' +
    'values are appended to a private spreadsheet:</p>' +
    '<ul>' +
    '<li>an opaque link token (identifies which link was clicked, not who clicked it)</li>' +
    '<li>the date and time of the click</li>' +
    '<li>an optional short referrer label supplied in the URL (truncated to 200 characters)</li>' +
    '</ul>' +
    '<p><strong>The service does not record IP addresses, user agents, device identifiers, ' +
    'location, or any other information about the visitor, and sets no cookies.</strong> ' +
    'Redirect pages are sent with <code>referrer: no-referrer</code>. ' +
    'Because no identifier tied to a person is stored, click records cannot be traced ' +
    'back to an individual.</p>' +

    '<h2>4. Third-party services</h2>' +
    '<p>To operate, this service sends data to the following providers, each governed by ' +
    'its own privacy policy:</p>' +
    '<ul>' +
    '<li>Google (Apps Script, Sheets) &mdash; hosting and storage</li>' +
    '<li>X (Twitter) API &mdash; publishing posts to the operator’s own account</li>' +
    '<li>TikTok Content Posting API &mdash; publishing videos to the operator’s own account</li>' +
    '<li>LINE Messaging API &mdash; status notifications to the operator</li>' +
    '<li>Google Gemini API &mdash; generating post text</li>' +
    '</ul>' +
    '<p>Visitor click data described in section 3 is <strong>not</strong> sent to any of these ' +
    'providers.</p>' +

    '<h2>5. Retention and deletion</h2>' +
    '<p>Click records are kept for as long as they are useful for measuring which posts ' +
    'performed well, and may be deleted at any time. OAuth tokens are deleted when the ' +
    'operator disconnects the corresponding account. Because no personal data about visitors ' +
    'is collected, there is nothing about a visitor to retrieve, correct, or erase.</p>' +

    '<h2>6. Children</h2>' +
    '<p>This service is not directed to children and does not knowingly collect information ' +
    'from anyone under the age required by the platforms it publishes to.</p>' +

    '<h2>7. Changes</h2>' +
    '<p>If the data handling described above changes, this page is updated and the ' +
    '“Last updated” date at the top is revised.</p>' +

    '<h2>8. Contact</h2>' +
    '<p>' + mail + '</p>';
}

/** 利用規約本文。審査フォームに規約URL欄がある場合に使う。 */
function buildTermsHtml_() {
  const mail = escapeHtml_(legalContactEmail_());
  const op = escapeHtml_(legalOperatorName_());

  return '' +
    '<p>This service is a private automation tool operated by ' + op + ' for its own ' +
    'social media accounts. It is not a product offered to the public, and there is no ' +
    'sign-up, subscription, or user account.</p>' +

    '<h2>1. Scope</h2>' +
    '<p>The only interactive surface available to the public is a redirect link that ' +
    'forwards a visitor to a destination named in a published post. Following such a link ' +
    'creates no agreement beyond this page.</p>' +

    '<h2>2. Affiliate disclosure</h2>' +
    '<p>Some links published by this service are affiliate links. If a visitor makes a ' +
    'purchase after following one, the operator may receive a commission at no additional ' +
    'cost to the visitor.</p>' +

    '<h2>3. Content</h2>' +
    '<p>Posts are generated with automated assistance and reviewed against the publishing ' +
    'rules of each platform. Content that is generated or substantially edited by AI is ' +
    'labelled as such where the platform provides a labelling mechanism.</p>' +

    '<h2>4. No warranty</h2>' +
    '<p>Information in published posts is provided as is, without warranty of any kind. ' +
    'Destinations reached through redirect links are operated by third parties and are ' +
    'outside the operator’s control.</p>' +

    '<h2>5. Contact</h2>' +
    '<p>' + mail + '</p>';
}
