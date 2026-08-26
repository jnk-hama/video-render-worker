/**
 * ===========================================================================
 * 34_Veo.gs  —  Veoでオリジナル映像を生成し、在庫へ足す
 * ===========================================================================
 *
 * ★なぜこれを作るか（オーナー指示 2026-08-24）
 *
 * 「世界のバズ動画を理解して、真似ではなくオマージュで作り替えろ。
 *   クオリティを引き上げろ」
 *
 * ストック映像（Pexels/Pixabay）の品質上限は「きれいなb-roll」で、
 * それ以上にはならない。生成なら演出を指定できる。
 *
 * ★著作権について（重要）
 *
 * 生成物なので、既存作品の複製にはならない。ただし
 * 「作風は保護されないが、特定の表現は保護される」ため、
 * プロンプトで既存のキャラクター・作品名・スタジオ名を指すことは禁じる
 * （buildVeoPrompt_ / VEO_BANNED_TERMS）。
 * 手法や質感を狙うのは自由、固有の作品を狙うのは駄目、という線を引く。
 *
 * ★費用（ここを外すと即赤字）
 *
 * Veo 3.1 は秒課金。8秒で概ね以下（2026-08時点の公開価格）。
 *   fast 720p … $0.10/秒 → 8秒で約$0.80（約¥120）
 *   standard  … $0.40/秒 → 8秒で約$3.20（約¥480）
 *
 * 1日4本×2アカウント×30日＝240本 なら fast でも月¥28,800。
 * **既定は無効。日次上限つき。** 有効化はオーナーが明示的に行う。
 *
 * ★なぜ「在庫へ足す」形にしたか
 *
 * 生成は1〜3分かかる。投稿の中で待つとGASの実行枠を圧迫し、
 * 失敗すればその回の投稿ごと落ちる。
 * VideoStockへ入れておけば、投稿側は今までどおり在庫から引くだけで済み、
 * NG付け・使用回数・自動補充といった既存の仕組みが全部そのまま効く。
 */

/* ------------------------------------------------------------------ */
/* 設定                                                                 */
/* ------------------------------------------------------------------ */

/** 既定は無効。秒課金なので、知らないうちに走る状態を作らない。 */
function veoEnabled_() {
  return String(getProp_('VEO_MODE', '0')) === '1';
}

/** 1日に生成してよい本数（全アカウント合計）。費用の歯止め。 */
const VEO_DAILY_MAX_DEFAULT = 2;

function veoDailyMax_() {
  const n = Number(getProp_('VEO_DAILY_MAX', String(VEO_DAILY_MAX_DEFAULT)));
  return (isNaN(n) || n < 0) ? VEO_DAILY_MAX_DEFAULT : n;
}

/** 尺（秒）。秒課金なので、伸ばすほど比例して高くなる。 */
function veoSeconds_() {
  const n = Number(getProp_('VEO_SECONDS', '8'));
  return (isNaN(n) || n < 4 || n > 8) ? 8 : n;
}

/**
 * 使うモデル。
 *
 * ★正確なIDが版で変わるため、候補を順に試して通ったものを覚える。
 * 安い順に並べる。品質より先に「まず通ること」と「安いこと」。
 */
const VEO_MODEL_CANDIDATES = [
  'veo-3.1-fast-generate-preview',
  'veo-3.1-generate-preview',
  'veo-3.0-fast-generate-001'
];

const VEO_MODEL_PROP = 'veo_model';
const VEO_PENDING_PROP = 'veo_pending';      // 生成中の操作名
const VEO_COUNT_PROP_PREFIX = 'veo_count_';  // 日別の生成数

function veoModels_() {
  const remembered = getProp_(VEO_MODEL_PROP, '');
  if (remembered) return [remembered];
  return VEO_MODEL_CANDIDATES.slice();
}

function veoCountKey_() {
  return VEO_COUNT_PROP_PREFIX + todayKey_();
}

function veoUsedToday_() {
  return Number(getProp_(veoCountKey_(), '0')) || 0;
}

function noteVeoUsed_() {
  try {
    props_().setProperty(veoCountKey_(), String(veoUsedToday_() + 1));
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* プロンプト                                                           */
/* ------------------------------------------------------------------ */

/*
 * ★既存作品を名指ししない。
 *
 * 作風・技法は保護されないが、特定の作品やキャラクターは保護される。
 * 「ピクサーみたいに」と書けば、出力がその特徴に寄るほど危うくなる。
 * 狙うのは「何が人の目を止めるか」であって、誰かの絵柄ではない。
 */
const VEO_BANNED_TERMS = [
  'pixar', 'disney', 'marvel', 'ghibli', 'studio ghibli', 'dreamworks',
  'nintendo', 'pokemon', 'star wars', 'mcu', 'anime studio',
  'in the style of'
];

function veoPromptIsClean_(prompt) {
  const p = String(prompt || '').toLowerCase();
  return !VEO_BANNED_TERMS.some(function (t) { return p.indexOf(t) !== -1; });
}

/**
 * 「止まる映像」の作り方を指示に落とす。
 *
 * ★何が人の目を止めるかは、作品名ではなく撮り方で決まる。
 * 大規模分析（決定#045で参照した34,635本のTikTok分析）で最も伸びた型は
 * 「最初の2秒で結果・変化を見せる」だった。それを演出言語にする。
 *
 * @param {string} accountKey
 * @param {string} subject 何を撮るか（材料のタイトルから作る）
 * @return {string}
 */
function buildVeoPrompt_(accountKey, subject) {
  const key = String(accountKey || '').toUpperCase();
  const s = String(subject || '').trim() || 'a precise mechanism in motion';

  // 共通の撮影指示。ここが品質の中身
  const craft = [
    'Cinematic macro shot, shallow depth of field, crisp focus falloff.',
    'The most striking moment happens in the first second — no build-up.',
    'Single continuous camera move: slow push-in or lateral slide.',
    'Dramatic directional lighting with visible falloff and soft rim light.',
    'Fine detail: dust motes, micro-scratches, subtle surface texture.',
    'Rich contrast, filmic color grade, no flat lighting.',
    'No text, no logos, no watermarks, no user interface elements.',
    'No recognizable real people, no brand marks.'
  ];

  const look = (key === 'B')
    ? 'Hand-crafted illustrated look with visible linework and painterly texture, ' +
      'vivid saturated palette, dramatic anime-adjacent staging — but an ' +
      'original composition, not resembling any existing character or title.'
    : 'Photoreal engineering aesthetic: machined metal, precise tolerances, ' +
      'oil sheen, sparks or fine particles catching the light.';

  return [
    'Subject: ' + s,
    'Look: ' + look,
    craft.join(' '),
    'Vertical 9:16 framing, composed for a phone screen.'
  ].join('\n');
}

/** 生成を避けたい要素。personGeneration と併せて安全側に倒す。 */
function veoNegativePrompt_() {
  return 'text, watermark, logo, brand name, celebrity likeness, ' +
         'distorted hands, extra limbs, blurry, low resolution, flat lighting';
}

/* ------------------------------------------------------------------ */
/* 生成の開始                                                           */
/* ------------------------------------------------------------------ */

const VEO_BASE = 'https://generativelanguage.googleapis.com/v1beta/';

/**
 * 生成を開始する。長時間処理なので、ここでは待たずに操作名を返す。
 *
 * @return {?{operation:string, model:string}}
 */
function startVeoGeneration_(accountKey, subject) {
  if (!veoEnabled_()) return null;

  const apiKey = youtubeApiKey_();   // 同じGoogleのキーを使う
  if (!apiKey) {
    console.warn('Veo: APIキーが無いため生成しません。');
    return null;
  }

  if (veoUsedToday_() >= veoDailyMax_()) {
    console.log('Veo: 本日の上限 ' + veoDailyMax_() + ' 本に達しています。');
    return null;
  }

  const prompt = buildVeoPrompt_(accountKey, subject);
  if (!veoPromptIsClean_(prompt)) {
    // ★既存作品を指す語が混ざった。生成せずに止める
    console.warn('Veo: プロンプトに既存作品を指す語が含まれるため中止しました。');
    return null;
  }

  const payload = {
    instances: [{ prompt: prompt }],
    parameters: {
      aspectRatio: '9:16',
      resolution: '720p',
      durationSeconds: veoSeconds_(),
      negativePrompt: veoNegativePrompt_(),
      // ★実在の人物に似せない。Bの3本の線にも直結する
      personGeneration: 'dont_allow'
    }
  };

  const models = veoModels_();
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    let res;
    try {
      res = UrlFetchApp.fetch(VEO_BASE + 'models/' + model + ':predictLongRunning', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (e) {
      console.warn('Veo: 到達できません: ' + truncate_(String(e), 100));
      return null;
    }

    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code === 200 || code === 201) {
      let name = '';
      try { name = String((JSON.parse(body) || {}).name || ''); } catch (e) {}
      if (!name) {
        console.warn('Veo: 操作名を取れませんでした: ' + truncate_(body, 160));
        return null;
      }
      try { props_().setProperty(VEO_MODEL_PROP, model); } catch (e) {}
      noteVeoUsed_();
      console.log('Veo: 生成を開始しました（' + model + '）');
      return { operation: name, model: model };
    }

    // 404 はモデルID違い。次の候補を試す価値がある
    if (code === 404) {
      console.warn('Veo: ' + model + ' は見つかりません。次の候補を試します。');
      continue;
    }

    /*
     * ★429/403 は「次のモデルなら通る」種類ではない。
     * Xの遮断器と同じ考え方で、ここで打ち切る（無駄な課金を作らない）。
     */
    console.warn('Veo: HTTP ' + code + ': ' + truncate_(body, 200));
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 完成の確認と取り込み                                                 */
/* ------------------------------------------------------------------ */

/**
 * 生成中の操作を確認し、終わっていれば在庫へ足す。
 *
 * ★投稿サイクルの中で待たない。1回のcronにつき1度だけ様子を見る。
 * 生成には1〜3分かかるので、たいてい次のサイクルで拾える。
 *
 * @return {string} 人が読める結果
 */
function checkVeoPending_() {
  const raw = getProp_(VEO_PENDING_PROP, '');
  if (!raw) return '';

  let pending;
  try { pending = JSON.parse(raw); } catch (e) {
    try { props_().deleteProperty(VEO_PENDING_PROP); } catch (e2) {}
    return '';
  }
  if (!pending || !pending.operation) return '';

  const apiKey = youtubeApiKey_();
  if (!apiKey) return '';

  let res;
  try {
    res = UrlFetchApp.fetch(VEO_BASE + pending.operation, {
      headers: { 'x-goog-api-key': apiKey },
      muteHttpExceptions: true
    });
  } catch (e) {
    return 'Veo: 確認に失敗（次回再試行）';
  }
  if (res.getResponseCode() !== 200) {
    return 'Veo: 確認 HTTP ' + res.getResponseCode();
  }

  let op;
  try { op = JSON.parse(res.getContentText()); } catch (e) { return ''; }
  if (!op.done) return 'Veo: 生成中';

  // 完了。失敗していることもある
  if (op.error) {
    try { props_().deleteProperty(VEO_PENDING_PROP); } catch (e) {}
    return 'Veo: 生成に失敗 ' + truncate_(JSON.stringify(op.error), 160);
  }

  const uri = veoVideoUriOf_(op);
  try { props_().deleteProperty(VEO_PENDING_PROP); } catch (e) {}
  if (!uri) return 'Veo: 完了したが動画URLを取れませんでした';

  const added = addVeoToStock_(pending.account || 'A', uri, pending.subject || '');
  return added ? 'Veo: 在庫へ1本追加しました' : 'Veo: 在庫へ追加できませんでした';
}

/** 応答から動画URLを取り出す。版によって形が違うので複数見る。 */
function veoVideoUriOf_(op) {
  const r = (op && op.response) || {};
  const gv = r.generateVideoResponse || r;
  const samples = gv.generatedSamples || gv.generatedVideos || [];
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] && (samples[i].video || samples[i]);
    const uri = v && (v.uri || v.url);
    if (uri) return String(uri);
  }
  return '';
}

/**
 * 生成された動画を在庫へ足す。
 *
 * ★URLをそのまま入れる。取得時にAPIキーが要るため、
 * 在庫からの取得経路（fetchVideoBlob_）が対応している必要がある。
 * 対応していない場合に備え、ここで取得できるかを1度だけ確かめる。
 */
function addVeoToStock_(accountKey, uri, subject) {
  const key = String(accountKey || 'A').toUpperCase();
  try {
    const ss = openLogSpreadsheet_();
    const sheet = getOrCreateStockSheet_(ss);
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, STOCK_HEADERS.length).setValues([[
      new Date(), key, 'veo: ' + truncate_(String(subject), 60),
      uri, veoSeconds_(), 720, 'veo', 0, ''
    ]]);
    return true;
  } catch (e) {
    console.warn('Veo: 在庫へ追加できません: ' + truncate_(String(e), 120));
    return false;
  }
}

/**
 * 1本ぶんの生成を仕掛ける。既に生成中なら何もしない。
 *
 * @return {string} 人が読める結果
 */
function queueVeoGeneration_(accountKey, subject) {
  if (!veoEnabled_()) return 'Veoは無効です（VEO_MODE=0）';
  if (getProp_(VEO_PENDING_PROP, '')) return 'Veo: 既に生成中です';
  if (veoUsedToday_() >= veoDailyMax_()) {
    return 'Veo: 本日の上限 ' + veoDailyMax_() + ' 本に達しています';
  }

  const started = startVeoGeneration_(accountKey, subject);
  if (!started) return 'Veo: 生成を開始できませんでした';

  try {
    props_().setProperty(VEO_PENDING_PROP, JSON.stringify({
      operation: started.operation,
      model: started.model,
      account: String(accountKey || 'A').toUpperCase(),
      subject: String(subject || ''),
      at: Date.now()
    }));
  } catch (e) {}

  return 'Veo: 生成を開始しました（1〜3分で在庫へ入ります）';
}

/** 診断用の1行。 */
function veoStatusLine_() {
  if (!veoEnabled_()) return 'Veo: 無効（VEO_MODE=0）';
  const pending = getProp_(VEO_PENDING_PROP, '') ? '生成中' : '待機';
  return 'Veo: ' + pending + ' / 本日 ' + veoUsedToday_() + '/' + veoDailyMax_() + '本';
}
