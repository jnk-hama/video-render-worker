/**
 * ===========================================================================
 * 36_Render.gs  —  GitHub Actions で動画を組み立てる
 * ===========================================================================
 *
 * ★★2026-08-24、オーナー判断
 *   「フォロワーとViewを稼ぐ為に金を払う意味がない」
 *
 * JSON2Video（1秒=1クレジット）も映像ライセンス購入も使わない。
 * GitHub Actions の無料枠で ffmpeg を回す。
 *   public リポジトリ … 無制限
 *   private リポジトリ … 2,000分/月（1本1〜3分。4本/日なら月120〜360分）
 *
 * 【なぜ外へ出すか】
 * GASは Python も FFmpeg も動かせず、実行も6分で切れる。
 * 描画だけ外へ出せば、指示された
 *   ・単語ごとにポップするダイナミック字幕
 *   ・1〜2秒のハイペースなカット割り
 * が費用0で出せる。
 *
 * 【流れ（非同期）】
 *   ① requestRender_()  … 素材URLと字幕をJSONにして dispatch する
 *   ② GitHub Actions    … ffmpeg で組み立て、Release へMP4を上げる
 *   ③ collectRender_()  … 次のサイクルでReleaseから取りに行く
 *
 * GASは完了を待てないので、待たない。頼んで、後で取りに行く。
 * これは 29_Video.gs の「素材を取ってすぐ上げる」とは別の経路になる。
 *
 * 【必要な設定】
 *   GITHUB_REPO   … "owner/repo"
 *   GITHUB_TOKEN  … Fine-grained PAT（contents:write / actions:write）
 */

/* ------------------------------------------------------------------ */
/* 設定                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 描画を使うか。設定が揃っている時だけ有効。
 *
 * ★スイッチ名は RENDER_ENABLED（2026-08-24に改名）。
 *   モード指定が RENDER_MODE_A / RENDER_MODE_B なので、
 *   ON/OFFも RENDER_MODE のままだと1文字違いで並ぶ。
 *   「RENDER_MODE=B」と書いて全体を止めたつもりになる、
 *   あるいは止めたつもりが止まっていない、という取り違えが起きる。
 *   旧名も 0 の時だけは尊重する（既に設定済みなら止まったままにする）。
 */
function renderEnabled_() {
  if (String(getProp_('RENDER_ENABLED', '1')) === '0') return false;
  if (String(getProp_('RENDER_MODE', '1')) === '0') return false;   // 旧名
  return !!(githubRepo_() && githubToken_());
}

function githubRepo_() { return String(getProp_('GITHUB_REPO', '')).trim(); }
function githubToken_() { return String(getProp_('GITHUB_TOKEN', '')).trim(); }

/**
 * 1本に使うクリップの数。
 *
 * ★オーナー指示「1〜2秒の超ハイペースなカット割りで15秒〜30秒」。
 * 1.6秒 × 10本 = 16秒。ここを増やすほど尺が伸びる。
 */
const RENDER_CLIPS_DEFAULT = 10;
const RENDER_CLIP_SECONDS = 1.6;

/**
 * そのアカウントの編集モード。
 *
 * ★★オーナー指示（2026-08-24）
 *   A … 読み上げ音声＋発声に合わせたダイナミック字幕
 *   B … 音声解析も字幕も一切なし。ハイテンポなカット割りのみ
 *
 * ★★T を追加（2026-08-26）
 *   T … 素材映像を使わない。単色に近い背景へ本文を単語ごとに
 *        ポップさせて焼く（タイポグラフィ）
 *
 *   【なぜ要るか】
 *   無料ストック(Pexels/Pixabay)には、Bの題材（同人・アニメ・
 *   オタク文化）に噛み合う映像が事実上存在しない。検索語を
 *   何度書き直しても「それっぽい別のもの」しか返らなかった。
 *   実際に出たのは、手描きの話に対して暗くぼやけた手元の映像で、
 *   オーナー評価は「出すくらいなら出さない方がマシ」。
 *   素材を良くする方向は行き止まりと判断し、素材を使わない道を足した。
 *
 *   Tでは clips を送らなくても成立する（描画側が背景を作る）。
 *
 * 取り違えるとBに字幕が乗る。既定をアカウント名と一致させ、
 * それでも変えたい時だけプロパティで上書きできるようにする。
 */
function renderModeFor_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const v = String(getProp_('RENDER_MODE_' + key, key)).toUpperCase();
  return (v === 'A' || v === 'B' || v === 'T') ? v : 'A';
}

function renderClipCount_(accountKey) {
  const n = Number(getProp_('RENDER_CLIPS_' + String(accountKey).toUpperCase(),
                            String(RENDER_CLIPS_DEFAULT)));
  // ★上限を置く。増やしすぎるとダウンロードだけで実行枠を食う
  return (isNaN(n) || n < 2) ? RENDER_CLIPS_DEFAULT : Math.min(n, 20);
}

/** 待っている描画の記録。アカウントごとに1件だけ持つ。 */
function renderPendingProp_(accountKey) {
  return 'render_pending_' + String(accountKey).toUpperCase();
}

/**
 * 描画を諦めるまでの時間。
 *
 * ★これが無いと、Actionsが落ちた回の記録が永久に残り、
 * そのアカウントは二度と新しい描画を頼めなくなる。
 */
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 字幕                                                                 */
/* ------------------------------------------------------------------ */

/** 1枚の字幕に載せる語数。3語ずつが読みやすく、テンポも出る。 */
const CAPTION_WORDS_PER_CHUNK = 3;

/**
 * 投稿本文から、画面に出す字幕を組み立てる。
 *
 * ★LLMを追加で呼ばない。本文は既に出来ているので、それを割るだけで足りる。
 * 呼び出しを増やせば、失敗する場所とコストが増える。
 *
 * ★ハッシュタグは画面に出さない。あれは検索に引っかかるためのもので、
 * 映像に焼き込んでも読み手には邪魔にしかならない。
 *
 * @param {string} text 投稿本文
 * @param {number} totalSeconds 動画の長さ
 * @return {!Array<{text:string, start:number, end:number}>}
 */
function buildCaptions_(text, totalSeconds) {
  const body = String(text || '')
    .split('\n')
    .filter(function (ln) { return !/^\s*#/.test(ln); })   // タグだけの行を落とす
    .join(' ')
    .replace(/#\S+/g, ' ')                                  // 文中のタグも落とす
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = body.split(' ').filter(Boolean);
  if (!words.length) return [];

  const chunks = [];
  for (let i = 0; i < words.length; i += CAPTION_WORDS_PER_CHUNK) {
    chunks.push(words.slice(i, i + CAPTION_WORDS_PER_CHUNK).join(' '));
  }

  const total = Number(totalSeconds) || (chunks.length * 1.6);
  const per = total / chunks.length;

  return chunks.map(function (c, i) {
    return { text: c, start: +(i * per).toFixed(2), end: +((i + 1) * per).toFixed(2) };
  });
}

/* ------------------------------------------------------------------ */
/* 依頼                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 描画を依頼する。★MP4はGAS側でダウンロードしない。
 *
 * 素材のURLを渡すだけで、実際の取得も結合もActions側が行う。
 * GASの実行枠もメモリも使わない。
 *
 * @param {string} accountKey
 * @param {!Array<{url:string}>} clips
 * @param {string} text 投稿本文（字幕の元）
 * @return {?{jobId:string}} 依頼できたら
 */
/**
 * モードTの配色。**アカウントごとの定数**であって、毎回作るものではない。
 *
 * ★★2026-08-29追加。指示書ではLLMに色を出力させる案だったが、採らなかった。
 *   色を毎回LLMに選ばせると、同じアカウントの動画の色が回ごとに変わる。
 *   ブランドが崩れるし、決定論的な構成という前提にも反する。
 *   色は「その日の判断」ではなく「アカウントの持ち物」である。
 *
 * ★アクセント色は、背景ではなく **本文色から離れている** ことが要件。
 *   実測したコントラスト比（対 背景#09090b / 対 本文#f4f4f5）:
 *     Sky   #38bdf8 …  9.29 / 1.95  ← 明るいが本文と同化して強調にならない
 *     Lime  #a3e635 … 13.19 / 1.37  ← 同上
 *     Blue  #3b82f6 …  5.41 / 3.35
 *     Violet#8b5cf6 …  4.70 / 3.85  ← 採用
 */
const RENDER_THEME = {
  bg_color_hex: '#09090b',      // Zinc 950
  text_color_hex: '#f4f4f5',    // Zinc 100
  accent_color_hex: '#8b5cf6'   // Violet 500
};

/**
 * 強調しない語。冠詞・前置詞・助動詞など、色を変えても意味が無いもの。
 * ★「短い語を外す」だけでは the / and / for が残るので、名指しで落とす。
 */
const RENDER_STOPWORDS = (
  'the a an and or but for nor so yet of to in on at by with from into over ' +
  'is are was were be been being do does did done have has had will would ' +
  'can could should may might must this that these those it its you your ' +
  'my our their his her they we he she i not no if then than as up out'
).split(' ');

/**
 * 本文から「色を変える語」を選ぶ。
 *
 * ★★LLMに選ばせない（2026-08-29）。
 *   台本そのものは既にLLMが書いているが、そこへ強調語のキーを足すと
 *   「AI社員の共通契約」第3条（キー名の追加・変更の禁止）に触れる。
 *   契約を破ってシステムが止まった実例が E-002 / E-005。
 *   強調語は本文さえあれば決まるので、こちらで決めれば契約に触れずに済む。
 *
 * 【選び方：文の最後の実語を1つ】
 * 英語は文の終わりに要点が来る。"make you dangerous" / "gives you the
 * answer" / "out of excuses" ——効かせたい語は末尾にある。
 *
 * ★最初は「3語ごとの塊で最長の語」にしたが、実際に走らせて捨てた。
 *   塊が文の切れ目をまたぐため、"Phind. Google hands" という塊ができ、
 *   文字数で Google(6) が Phind(5) に勝つ。**商品名が塗られず、
 *   関係のない語が塗られる。** 長さは重要度の代わりにならなかった。
 *
 * ★カウントダウン動画では "Number three." の three が塗られる。
 *   これは狙ったものではないが、順位が目立つのは都合がよい。
 *
 * @param {string} text 読み上げる本文
 * @return {!Array<string>} 強調する語（重複なし）
 */
function pickHighlightWords_(text, subject) {
  // 文で切る。区切りが無ければ全体を1文として扱う
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  const out = [];
  sentences.forEach(function (sen) {
    const words = sen.split(/\s+/).filter(String);
    /*
     * ★短い文は塗らない（実測して足した規則）。
     *   文ごとに1語塗ると、"Bolt." や "Number two." のような
     *   1〜2語の断片まで対象になり、**字幕18枚中14枚（77%）が紫**になった。
     *   ほぼ全部が強調色では、強調の意味が消える。
     *
     *   そもそも1語だけの行は、その行全体が既に強調である。
     *   同じ行に対比する相手がいないので、色を変えても浮かない。
     */
    if (words.length < 3) return;
    // 後ろから見て、最初に見つかった実語を採る
    for (let i = words.length - 1; i >= 0; i--) {
      const bare = words[i].replace(/[^0-9A-Za-z]/g, '');
      if (!bare) continue;
      if (RENDER_STOPWORDS.indexOf(bare.toLowerCase()) !== -1) continue;
      if (out.indexOf(bare) === -1) out.push(bare);
      return;   // 1文につき1語だけ
    }
  });

  /*
   * ★★商品名は無条件で塗る（2026-08-31）。
   *
   * 【なぜ足したか】
   * 架空商品でデモを作って気づいた。台本
   *   "The NOVA Pulse just sticks to your phone."
   * に対し、文末規則が選んだのは **phone** だった。
   * 商品名 NOVA Pulse は一度も色が付かない。
   *
   * ツール紹介では文末に要点が来るので機能したが、商品動画では
   * **商品名こそ塗るべき語**である。名前を覚えてもらえなければ、
   * 動画を見た人は検索することすらできない。用途に対して規則が
   * 合っていなかった。
   *
   * 文末規則は残したまま、商品名だけを足す形にする。
   */
  String(subject || '').split(/\s+/).forEach(function (w) {
    const bare = w.replace(/[^0-9A-Za-z]/g, '');
    if (!bare || bare.length < 2) return;
    if (RENDER_STOPWORDS.indexOf(bare.toLowerCase()) !== -1) return;
    // 本文に実際に出てくる語だけ。出ない語を渡しても塗る対象が無い
    const re = new RegExp('(^|[^0-9A-Za-z])' + bare + '([^0-9A-Za-z]|$)', 'i');
    if (!re.test(String(text || ''))) return;
    if (out.indexOf(bare) === -1) out.push(bare);
  });

  return out;
}

function requestRender_(accountKey, clips, text) {
  const key = String(accountKey || '').toUpperCase();
  if (!renderEnabled_()) {
    console.warn('描画は無効です（GITHUB_REPO / GITHUB_TOKEN 未設定）。');
    return null;
  }
  const list = (clips || []).filter(function (c) { return c && c.url; });
  // ★モードTは背景を描画側で作るため、素材0本でも成立する（2026-08-26）
  if (!list.length && renderModeFor_(key) !== 'T') {
    console.warn('描画に渡す素材がありません。');
    return null;
  }

  const jobId = key.toLowerCase() + '-' + String(Date.now()) +
                '-' + Math.floor(Math.random() * 1000);
  const mode = renderModeFor_(key);

  /*
   * ★★2026-08-25、モードBの「カット尺をランダムにする」が
   *   一度も効いていなかったのを直した（実際に走らせて確認）。
   *
   *   render_video.py はこう書いてある。
   *     each = float(c.get('duration') or rng.uniform(1.0, 3.0))
   *   つまり尺を送らなければ 1〜3秒でばらつく設計だった。
   *   ところがこちらは全クリップに duration=1.6 を入れて送っていたため
   *   `or` の右側へ一度も進まず、**全カットが等間隔の1.6秒**になっていた。
   *
   *   等間隔のカットは、速くてもテンポとして感じられない。ただ機械が
   *   切っているだけに見える。「ハイテンポなMAD風」を要件にしている以上、
   *   ここは揺らぐ必要がある。モードBでは尺を送らず、描画側に決めさせる。
   *
   *   ★モードAは変えない。あちらは音声の発声時刻に合わせる必要があり、
   *     尺をこちらで決めないと絵と声がずれる。
   */
  const seconds = (mode === 'B')
    ? list.length * 2.0                      // 1〜3秒の平均。目安表示にだけ使う
    : list.length * RENDER_CLIP_SECONDS;

  const payload = {
    job_id: jobId,
    account: key,
    mode: mode,
    width: 1080, height: 1920, fps: 30,
    clip_seconds: RENDER_CLIP_SECONDS,
    clips: list.map(function (c) {
      const clip = {
        url: String(c.url),
        // ★頭を少し飛ばす。ストック映像は冒頭が静止していることが多い
        //   （モードBでは描画側が中盤からランダムに切り直す）
        start: Number(c.start) || 0.5
      };
      // ★モードBは尺を送らない。描画側に1〜3秒で振らせる（上のコメント）
      if (mode !== 'B') clip.duration = RENDER_CLIP_SECONDS;
      return clip;
    })
  };

  /*
   * ★モードBには本文も字幕も渡さない（オーナー指示）。
   *   渡すと描画側で誤って使われる余地が残る。送らなければ事故は起きない。
   *
   * ★★モードTは逆に、本文が動画そのものになる（2026-08-26）。
   *   ここを 'A' の決め打ちにすると、Tへ切り替えた瞬間に
   *   narration も captions も届かず、**背景だけの真っ黒な動画**が出る。
   *   描画側でも同じ決め打ちで一度それを出しており、両側で踏んだ。
   */
  if (mode === 'A' || mode === 'T') {
    payload.narration = String(text || '')
      .split('\n')
      .filter(function (ln) { return !/^\s*#/.test(ln); })
      .join(' ')
      .replace(/#\S+/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // ★TTSが使えなかった回の予備。均等割りだが、字幕が消えるよりよい
    payload.captions = buildCaptions_(text, seconds);
  }

  /*
   * ★配色と強調語はモードTだけに送る（2026-08-29）。
   *   モードAは映像の上に字幕を乗せるので、暗い背景色は使わないし、
   *   映像の上での見え方を実測していない。**測っていないものは送らない。**
   *   描画側は未指定なら従来の黄/白で描くので、Aの挙動は変わらない。
   */
  if (mode === 'T') {
    payload.design_tokens = RENDER_THEME;
    payload.highlight_words = pickHighlightWords_(payload.narration);
  }

  let res;
  try {
    res = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + githubRepo_() + '/dispatches', {
        method: 'post',
        contentType: 'application/json',
        headers: {
          Authorization: 'Bearer ' + githubToken_(),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        /*
         * ★★client_payload は「最上位プロパティ10個まで」（GitHub APIの制限）。
         *   超えると 422 が返り、ワークフローは起動すらしない。
         *
         *   平置きで送っていた頃、モードAの最上位は
         *     job_id / account / mode / width / height / fps /
         *     clip_seconds / clips / narration / captions
         *   でちょうど10。**上限に張り付いていて余白がゼロだった。**
         *   render_video.py は voice / seed / font_size も読む作りなのに、
         *   どれか1つ足した瞬間に全部の描画が止まる状態で、
         *   実装済みの機能へ永久に手が届かなかった。
         *
         *   1個に畳めば天井が消える。描画側は入れ子・平置きの両方を読む。
         */
        payload: JSON.stringify({
          event_type: 'render-video',
          client_payload: { job: payload }
        }),
        muteHttpExceptions: true
      });
  } catch (e) {
    console.warn('GitHubへ到達できません: ' + truncate_(String(e), 120));
    return null;
  }

  const code = res.getResponseCode();
  // dispatches は成功すると 204（本文なし）
  if (code !== 204 && code !== 200) {
    console.error('描画を依頼できませんでした HTTP ' + code + ': ' +
                  truncate_(res.getContentText(), 200));
    return null;
  }

  /*
   * ★★2026-08-25、ここの握り潰しをやめた。
   *
   *   保存に失敗すると、GitHub 側では描画が走って Release まで出来るのに
   *   **こちらは頼んだ事実を忘れる**。回収しに行かないので動画は永久に
   *   宙に浮き、そのアカウントは無言のまま一本も投稿されない。
   *   しかも次のサイクルでまた頼むので、CI時間だけが減り続ける。
   *
   *   これは絵空事ではない。00_Config.gs にある通り、2026-08-22 に
   *   スクリプトプロパティが50個の上限に達して新規登録できなくなった
   *   実績がある。つまり setProperty は現に失敗しうる。
   *
   *   直せはしないので、せめて黙らない。
   */
  try {
    props_().setProperty(renderPendingProp_(key), JSON.stringify({
      jobId: jobId,
      at: Date.now(),
      text: truncate_(String(text || ''), 400),
      clips: list.length
    }));
  } catch (e) {
    console.error(
      '描画は依頼できましたが、待ち状態を保存できませんでした: ' + jobId +
      ' / ' + truncate_(String(e), 150) +
      ' → この回の動画は回収されません。' +
      'プロパティ数の上限（50個）が原因の可能性があります。' +
      'cleanupScriptPropertiesNow() で空きを作ってください。');
  }

  console.log('描画を依頼しました (' + key + ' / モード' + mode + ' / ' + jobId +
              ' / ' + list.length + '本 ' +
              (mode === 'B' ? '≒ ' + seconds.toFixed(0) + '秒前後（尺は可変）'
                            : '≒ ' + seconds.toFixed(1) + '秒') + ')');
  return { jobId: jobId };
}

/* ------------------------------------------------------------------ */
/* 回収                                                                 */
/* ------------------------------------------------------------------ */

/** 待っている依頼。無ければ null。 */
function pendingRender_(accountKey) {
  const raw = getProp_(renderPendingProp_(accountKey), '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function clearPendingRender_(accountKey) {
  try { props_().deleteProperty(renderPendingProp_(accountKey)); } catch (e) {}
}

/**
 * 出来上がっていれば MP4 を取ってくる。
 *
 * ★まだ描画中なら null を返すだけで、待たない。次のサイクルで見に来る。
 *
 * @return {?{blob:!Object, bytes:number, text:string, jobId:string}}
 */
function collectRender_(accountKey) {
  const key = String(accountKey || '').toUpperCase();
  const pend = pendingRender_(key);
  if (!pend) return null;

  // ★時間切れは捨てる。残し続けると次を頼めなくなる
  if (Date.now() - (Number(pend.at) || 0) > RENDER_TIMEOUT_MS) {
    console.warn('描画が時間内に終わりませんでした（諦めます）: ' + pend.jobId);
    clearPendingRender_(key);
    return null;
  }

  const asset = findRenderAsset_(pend.jobId);
  if (!asset) return null;                 // まだ出来ていない

  const blob = downloadRenderAsset_(asset.id);
  if (!blob) return null;

  clearPendingRender_(key);
  return {
    blob: blob,
    bytes: Number(asset.size) || 0,
    text: String(pend.text || ''),
    jobId: pend.jobId
  };
}

/** Release を名前で探す。無ければ null（＝まだ描画中）。 */
function findRenderAsset_(jobId) {
  let res;
  try {
    res = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + githubRepo_() +
      '/releases/tags/render-' + encodeURIComponent(jobId), {
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

  const code = res.getResponseCode();
  if (code === 404) return null;           // まだ出来ていない。異常ではない
  if (code !== 200) {
    console.warn('Releaseの確認が HTTP ' + code);
    return null;
  }

  let rel;
  try { rel = JSON.parse(res.getContentText()); } catch (e) { return null; }
  const assets = (rel && rel.assets) || [];
  for (let i = 0; i < assets.length; i++) {
    if (/\.mp4$/i.test(String(assets[i].name || ''))) return assets[i];
  }
  return null;
}

/**
 * Release のアセットをMP4として取る。
 *
 * ★Accept: application/octet-stream を付けないとJSONが返る。
 * GASは既定でリダイレクトを追うので、署名付きURLへの転送も通る。
 */
function downloadRenderAsset_(assetId) {
  let res;
  try {
    res = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + githubRepo_() +
      '/releases/assets/' + encodeURIComponent(assetId), {
        headers: {
          Authorization: 'Bearer ' + githubToken_(),
          Accept: 'application/octet-stream',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        muteHttpExceptions: true
      });
  } catch (e) {
    console.warn('描画結果を取得できません: ' + truncate_(String(e), 120));
    return null;
  }

  if (res.getResponseCode() !== 200) {
    console.warn('描画結果の取得が HTTP ' + res.getResponseCode());
    return null;
  }

  const blob = res.getBlob();
  const bytes = blob.getBytes().length;
  if (bytes < 10 * 1024) {
    console.warn('描画結果が小さすぎます（' + bytes + 'B）。壊れている可能性。');
    return null;
  }
  if (bytes > VIDEO_MAX_BYTES) {
    console.warn('描画結果が大きすぎます: ' + Math.round(bytes / 1024 / 1024) + 'MB');
    return null;
  }
  try { blob.setName('render.mp4'); } catch (e) {}
  return blob;
}

/* ------------------------------------------------------------------ */
/* 素材を選ぶ                                                           */
/* ------------------------------------------------------------------ */

/**
 * 描画に渡すクリップを選ぶ。★ここではダウンロードしない。
 *
 * 在庫から、話題と噛み合う順に必要な本数だけURLを集める。
 * 足りなければ補充してからもう一度見る。
 *
 * @return {!Array<{url:string, query:string}>}
 */
function pickRenderClips_(accountKey, query, want) {
  const key = String(accountKey || '').toUpperCase();
  const need = Number(want) || renderClipCount_(key);

  try { ensureStockLevel_(key); } catch (e) {}

  let rows = [];
  try { rows = freshStock_(key) || []; } catch (e) { return []; }
  if (!rows.length) {
    try { rows = listStock_(key) || []; } catch (e) { return []; }
  }
  if (!rows.length) return [];

  // 話題と語が重なる順に並べる。同点なら使用回数の少ない方
  const words = (typeof stockQueryWords_ === 'function') ? stockQueryWords_(query) : [];
  const scored = rows.map(function (r) {
    return { row: r, rel: stockRelevance_(r.query, words) };
  }).sort(function (a, b) {
    if (b.rel !== a.rel) return b.rel - a.rel;
    return (a.row.used || 0) - (b.row.used || 0);
  });

  const out = [];
  const seen = {};
  for (let i = 0; i < scored.length && out.length < need; i++) {
    const r = scored[i].row;
    // ★drive: は外部から取れない。Actions側が落とせるURLだけ渡す
    if (!/^https?:\/\//i.test(r.url) || seen[r.url]) continue;
    seen[r.url] = true;
    out.push({ url: r.url, query: r.query, row: r.row });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* LINEからの試作（投稿しない）                                          */
/* ------------------------------------------------------------------ */
/*
 * ★★2026-08-24、オーナー指示
 *   「あとから間違いでしたとか絶対に無いように」
 *
 * こちらが「できました」と言うのをやめる。1本作って、投稿せずに
 * 動画そのものを見てもらい、OKが出るまで1本も投稿しない。
 * テストが何件通ったかは、もう根拠として出さない。
 */

/** 「試作」… 1本組み立てる。投稿はしない。 */
function requestPreviewFromLine_(accountKey) {
  const key = String(accountKey || 'A').toUpperCase();
  if (!ACCOUNTS[key]) return '不明なアカウントです: ' + accountKey;

  if (!githubRepo_() || !githubToken_()) {
    return [
      '🎬 まだ動画を組み立てられません。',
      '',
      'GitHubの設定が2つ要ります（どちらも無料）:',
      '  ① 設定 GITHUB_REPO owner/repo',
      '  ② 設定 GITHUB_TOKEN <PAT>',
      '',
      'PATの権限は contents:write と actions:write だけで足ります。'
    ].join('\n');
  }

  const pend = pendingRender_(key);
  if (pend) {
    const min = Math.round((Date.now() - (Number(pend.at) || 0)) / 60000);
    return '🎬 ' + key + ' は既に組み立て中です（' + min + '分経過）。\n' +
           '→「試作確認 ' + key + '」で出来上がりを受け取れます。';
  }

  const query = rotatingStockQuery_(key);
  const clips = pickRenderClips_(key, query);
  /*
   * ★★モードTは素材を使わないので、在庫が0本でも成立する（2026-08-26）。
   *   ここを素通しにしないと、素材問題を捨てるために作ったモードが
   *   「素材が足りません」で止まるという、噛み合わない状態になる。
   */
  if (renderModeFor_(key) !== 'T' && clips.length < 2) {
    return '🎬 素材が足りません（' + clips.length + '本）。\n' +
           '在庫は自動で補充されるので、少し待ってからもう一度お試しください。';
  }

  /*
   * ★試作でもGeminiで本文を作る。字幕はこの本文から焼くので、
   *   ここを固定文にすると「本番と違うもの」を見せることになる。
   */
  let text = '';
  try {
    // ★第4引数は付くメディアの種類。ここは必ず動画になる（明示しておく）
    const gen = generateBuzzText_(key, null, query, 'video');
    if (gen && gen.text) text = gen.text;
  } catch (e) {
    console.warn('試作用の本文生成で例外: ' + truncate_(String(e), 100));
  }
  if (!text) {
    return '🎬 本文を作れませんでした。字幕の元が無いので組み立てを止めます。\n' +
           '→「バズ診断」で原因を確認できます。';
  }

  const job = requestRender_(key, clips, text);
  if (!job) return '🎬 組み立てを依頼できませんでした。GitHubの設定をご確認ください。';

  const sec = (clips.length * RENDER_CLIP_SECONDS).toFixed(1);
  return [
    '🎬 ' + key + ' の試作を始めました。',
    '',
    'クリップ ' + clips.length + '本 ≒ ' + sec + '秒',
    '素材: ' + truncate_(query, 60),
    '',
    '本文（字幕もこれになります）:',
    truncate_(text, 200),
    '',
    '★1〜3分かかります。',
    '　「試作確認 ' + key + '」と送ると動画を返します（投稿はしません）。'
  ].join('\n');
}

/** 「試作確認」… 出来ていれば動画を返す。投稿はしない。 */
function checkPreviewFromLine_(accountKey) {
  const key = String(accountKey || 'A').toUpperCase();
  if (!ACCOUNTS[key]) return '不明なアカウントです: ' + accountKey;

  const pend = pendingRender_(key);
  if (!pend) return '🎬 ' + key + ' に組み立て中のものはありません。\n→「試作 ' + key + '」で始められます。';

  const asset = findRenderAsset_(pend.jobId);
  if (!asset) {
    const min = Math.round((Date.now() - (Number(pend.at) || 0)) / 60000);
    return '🎬 まだ組み立て中です（' + min + '分経過）。\n' +
           'もう少し待ってから、もう一度「試作確認 ' + key + '」を送ってください。';
  }

  /*
   * ★動画そのものをLINEへ送る。URLだけだと、GitHubの認証が要るので
   *   スマホから開けない。ファイルとして送れば、その場で再生できる。
   */
  const blob = downloadRenderAsset_(asset.id);
  if (!blob) return '🎬 出来上がっていますが、取得に失敗しました。';

  clearPendingRender_(key);
  const mb = (blob.getBytes().length / 1024 / 1024).toFixed(1);
  const link = savePreviewToDrive_(blob, key);

  return [
    '🎬 ' + key + ' の試作が出来ました',
    '',
    link ? '▼ここから見られます\n' + link : '※Driveへ保存できませんでした',
    '',
    'サイズ: ' + mb + 'MB ／ クリップ ' + (pend.clips || '?') + '本',
    '',
    '本文（画面の字幕もこれです）:',
    truncate_(String(pend.text || ''), 240),
    '',
    'これで良ければ「バズ ' + key + '」で本番投稿できます。',
    '違うなら、どこが違うか教えてください。直します。'
  ].filter(String).join('\n');
}

/**
 * 試作をDriveへ保存し、その場で見られるリンクを返す。
 *
 * ★★なぜLINEの動画メッセージにしないか。
 *   LINEの video メッセージは originalContentUrl に「公開HTTPSのURL」を
 *   要求する。手元のBlobをそのまま添付する方法が無い。
 *   GitHubのReleaseは private だと認証が要り、LINE側から取得できない。
 *   GASのWebアプリもバイナリを返せない（ContentServiceはテキストのみ）。
 *
 *   Driveならリンク1本で、スマホのブラウザでもアプリでも再生できる。
 *   遠回りに見えるが、これが確実に届く唯一の経路だった。
 *
 * ★保存先は貯蔵庫(35_Vault.gs)と同じフォルダ。
 *   drive.file スコープは「自分が作ったフォルダ」なら扱える。
 */
function savePreviewToDrive_(blob, accountKey) {
  let folder = null;
  try {
    folder = (typeof vaultFolder_ === 'function') ? vaultFolder_() : null;
  } catch (e) {}
  if (!folder) {
    console.warn('保存先フォルダを用意できませんでした。');
    return '';
  }

  try {
    const name = 'preview_' + String(accountKey) + '_' +
                 Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MMdd_HHmm') + '.mp4';
    const file = folder.createFile(blob.setName(name));
    /*
     * ★リンクを知っていれば見られる状態にする。
     *   これをしないと、オーナーのGoogleアカウントで開いても
     *   「権限がありません」になる（作成者はスクリプトの実行主体で、
     *   オーナー本人とは限らないため）。
     */
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      console.warn('共有設定に失敗（リンクは返します）: ' + truncate_(String(e), 100));
    }
    return 'https://drive.google.com/file/d/' + file.getId() + '/view';
  } catch (e) {
    console.warn('試作の保存に失敗: ' + truncate_(String(e), 120));
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 状態表示                                                             */
/* ------------------------------------------------------------------ */

/** 診断に出す1行。 */
function renderStatusLine_() {
  if (!githubRepo_() || !githubToken_()) {
    return '🎬 動画の組み立て: 未設定 →「初期設定」でGitHubの設定が要ります';
  }
  if (String(getProp_('RENDER_ENABLED', '1')) === '0' ||
      String(getProp_('RENDER_MODE', '1')) === '0') {
    return '🎬 動画の組み立て: 停止中（RENDER_ENABLED=0）';
  }
  const waiting = Object.keys(ACCOUNTS).filter(function (k) {
    return !!pendingRender_(k);
  });
  return '🎬 動画の組み立て: 有効' +
         (waiting.length ? '（描画中: ' + waiting.join('・') + '）' : '');
}
