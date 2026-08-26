/**
 * ===========================================================================
 * 16_Quality.gs  —  投稿品質のゲート
 * ===========================================================================
 * 生成した文章をそのまま投稿しない。基準を満たすまで作り直す。
 *
 * 【なぜ必要か】
 * LLMは指示に従っているつもりで、平均的で当たり障りのない文章を出す。
 * 「具体的に書け」と指示しても、具体性の判定は書き手側では甘くなる。
 * 出てきたものを機械的に測って、通らなければ理由を添えて突き返す。
 *
 * 【2段構え】
 *   1段目: ローカル判定（API不要・即時・無料）
 *          汎用アドバイス構文、抽象語、具体物の欠如を機械的に弾く。
 *   2段目: LLMによる採点（1回の追加呼び出し）
 *          1段目で拾えない「読んで面白いか」を0〜100で採点させる。
 *
 * 1段目だけでも大半の凡庸な投稿は止まる。2段目は仕上げ。
 */

/**
 * 品質基準に届かず、投稿を見送ったことを示すエラー。
 *
 * ★これは「障害」ではなく「正常な判断」。
 * 連続エラーの計数や緊急停止の対象にしてはいけない。
 * 見送りが続くのは直すべき状態だが、止めるべき状態ではない。
 */
class QualityFloorError extends Error {
  constructor(accountKey, bestScore) {
    super('品質基準に届かなかったため投稿を見送りました（最良 ' + bestScore + '点 / 基準 ' +
          qualityMinScore_() + '点）。次回のトリガーで作り直します。');
    this.name = 'QualityFloorError';
    this.accountKey = accountKey;
    this.bestScore = bestScore;
  }
}

/**
 * 品質不足の通知。連続しても鬱陶しくならないよう間隔を空ける。
 *
 * 見送り自体は正常動作なので毎回は知らせない。
 * ただし「ずっと出せていない」状態には気づける必要がある。
 */
const POOR_QUALITY_NOTIFIED_PROP = 'poor_quality_notified_at';
const POOR_QUALITY_STREAK_PROP = 'poor_quality_streak';

function notifyPoorQualityOnce_(accountKey, best, attemptLog) {
  const streakKey = POOR_QUALITY_STREAK_PROP + '_' + accountKey;
  const streak = (Number(getProp_(streakKey, '0')) || 0) + 1;
  try { props_().setProperty(streakKey, String(streak)); } catch (e) {}

  /*
   * ★2026-08-18、通知を短くした（オーナー指示）。
   *
   * 旧版は5回分の試行・採点理由の英文・最良案の本文・設定項目名まで
   * 全部LINEへ流していた。スマホで読むには長すぎて、
   * しかも読んだところで打つ手は1つしかない。
   *
   * 出すのは「何回連続で・何点で止まっているか」と「次の一手」だけにする。
   * 内訳はGASの実行ログに残っているので、必要なら見に行ける。
   */
  if (streak < 3) return;
  const last = Number(getProp_(POOR_QUALITY_NOTIFIED_PROP + '_' + accountKey, '0')) || 0;
  if (last && (Date.now() - last) < 6 * 60 * 60 * 1000) return;
  try {
    props_().setProperty(POOR_QUALITY_NOTIFIED_PROP + '_' + accountKey, String(Date.now()));
  } catch (e) {}

  const log = Array.isArray(attemptLog) ? attemptLog : [];
  const overLength = log.filter(function (a) {
    return /^長すぎ/.test(String(a && a.reason || ''));
  }).length;

  const bestScore = best ? best.score : 0;
  const min = qualityMinScore_();

  // 次の一手は1つだけ出す。並べると結局どれもやらない。
  let advice;
  if (overLength >= 2) {
    advice = '→ 長さで落ちています。様子見で直らなければ連絡ください。';
  } else if (bestScore >= min - 10) {
    advice = '→ あと' + (min - bestScore) + '点です。次のトリガーで通る見込み。';
  } else {
    advice = '→ 題材が薄いようです。「情報源診断」で話題を拾えているか確認を。';
  }

  notifyAdmin_([
    '⚠️ ' + accountKey + ': 品質不足で ' + streak + '回見送り（最良 ' + bestScore +
      '点 / 基準 ' + min + '点）',
    advice
  ].join('\n'));
}

/**
 * 基準未満のまま投稿したことを知らせる。
 *
 * ★2026-08-18、最良案を採用する方式に変えたので、
 * 「投稿はされたが弱かった」状態が起こり得るようになった。
 * 止めはしないが、黙って続けると気づけない。
 *
 * 毎回鳴らすと通知として無意味になるので、
 * 続いた時だけ1日1回まで知らせる。
 */
const WEAK_POST_STREAK_PROP = 'weak_post_streak';
const WEAK_POST_NOTIFIED_PROP = 'weak_post_notified_at';
const WEAK_POST_ALERT_STREAK = 4;

function notifyWeakPostOnce_(accountKey, score) {
  const key = WEAK_POST_STREAK_PROP + '_' + accountKey;
  const streak = (Number(getProp_(key, '0')) || 0) + 1;
  try { props_().setProperty(key, String(streak)); } catch (e) {}
  if (streak < WEAK_POST_ALERT_STREAK) return;

  const last = Number(getProp_(WEAK_POST_NOTIFIED_PROP + '_' + accountKey, '0')) || 0;
  if (last && (Date.now() - last) < 24 * 60 * 60 * 1000) return;
  try {
    props_().setProperty(WEAK_POST_NOTIFIED_PROP + '_' + accountKey, String(Date.now()));
  } catch (e) {}

  notifyAdmin_(
    'ℹ️ ' + accountKey + ': ' + streak + '回続けて基準未満のまま投稿しています（直近 ' +
    score + '点 / 基準 ' + qualityMinScore_() + '点）\n' +
    '→ 投稿は出ています。「点検」の採点分布で傾向を確認できます。');
}

/** 基準を超えた投稿が出たら連続回数を消す。 */
function resetWeakPostStreak_(accountKey) {
  try { props_().deleteProperty(WEAK_POST_STREAK_PROP + '_' + accountKey); } catch (e) {}
}

/** 投稿に成功したら見送りの連続回数をリセットする。 */
function resetPoorQualityStreak_(accountKey) {
  try { props_().deleteProperty(POOR_QUALITY_STREAK_PROP + '_' + accountKey); } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* 1段目: ローカル判定                                                  */
/* ------------------------------------------------------------------ */

/**
 * 汎用アドバイスの書き出し。
 * これで始まる投稿は、ほぼ確実に「誰でも書ける一般論」になる。
 */
const GENERIC_OPENERS = [
  'people keep', 'most people', 'everyone is', 'everybody', 'stop doing',
  'stop using', 'here is how', "here's how", 'here is why', "here's why",
  'the mistake', 'pro tip', 'reminder:', 'hot take:', 'unpopular opinion',
  'let me explain', 'thread:', 'a lot of people', 'many people',
  'if you are', "if you're", 'you need to', 'you should'
];

/**
 * 一般論の指示構文。
 * 「あなたはこうすべき」は、経験の共有ではなく助言であり、
 * 読み手にとって新しい情報が無い割に上から目線に読める。
 */
const ADVISORY_PATTERNS = [
  /\byou should\b/i,
  /\byou need to\b/i,
  /\bmake sure (to|you)\b/i,
  /\bdon'?t forget to\b/i,
  /\balways (use|do|make|check|start)\b/i,
  /\bnever (use|do|forget|skip)\b/i,
  /\bbe sure to\b/i,
  /\bremember to\b/i
];

/**
 * Bで禁止するCTA文言。
 * バナー広告そのものの言い回しで、キュレーターとしての立場が消える。
 */
const B_BANNED_CTA = [
  'buy now', 'buy this', 'click here', 'link below', 'link in bio',
  'check it out now', 'dont miss', "don't miss", 'act now', 'limited offer',
  'shop now', 'order now', 'get yours'
];

/**
 * Bで弾く「低意図」の文言（指示書 §15）。
 *
 * この手の投稿は反応こそ付くが、集まるのは買わない層で、
 * タイムラインを埋めるほどアカウントの購買意図が薄まる。
 * キュレーターとしての立場とも噛み合わない。
 */
/*
 * ★「自分自身を見せる」方向の誘い文句だけを弾く。
 * Miaは自分の裸を売る人格ではなく、他人の作ったカタログへ案内する人格。
 * "come see me" 系が出た時点で、扱う商材と噛み合わない別種のアカウントになる。
 *
 * 挑発・煽り（"you are barely scratching the surface" 等）はここで弾かない。
 * あれは商材マーケティングとして正常な範囲であり、
 * 弾くと文章から緊張感が消えて誰もクリックしなくなる。
 */
const B_LOW_INTENT = [
  'come see me', 'come check me', 'come see more', 'see more of me', 'more of me',
  'dm me', 'dms are open', 'subscribe to me', 'my onlyfans',
  'feeling sexy', 'feeling naughty', 'feeling horny'
];

/**
 * 定義型の書き出しを機械的に弾く。
 *
 * ★2026-08-18追加。落ち続けていた失敗の形そのもの。
 *
 *   GaN chargers trade thermal mass for form factor.   ← 52点で落ちた実物
 *   Mechanical keyboards use different switch types.
 *   USB-C cables vary in supported wattage.
 *
 * どれも「カテゴリ＋説明動詞」で、辞書の見出しと同じ形をしている。
 * GENERIC_OPENERS は「People keep...」のような助言型のリストなので、
 * この形は1つも捕まえられず、毎回LLM採点まで行ってから落ちていた。
 * つまり分かりきった不合格に採点1回ぶんの課金を払っていた。
 *
 * 機械的に判定できるので、API呼び出しの前に落とす。
 */
const DEFINITIONAL_VERBS =
  /^[A-Z][A-Za-z0-9\-]*(?:\s+[A-Za-z0-9\-]+){0,3}\s+(is|are|uses|use|trades?|provides?|allows?|offers?|varies|vary|requires?|means?|refers?|consists?|contains?|includes?|supports?)\s/;

/**
 * 摩擦の目印。これが1つでもあれば定義文とは見なさない。
 *
 * ★この抜け道が無いと、良い冒頭まで巻き込む。
 *   "Your retries are not running."          → are に一致するが not/Your がある
 *   "That 65W block is only 65W for a minute" → is に一致するが That/only がある
 * 弾きたいのは「摩擦がゼロの説明文」だけ。
 */
const FRICTION_MARKERS = /\b(you|your|that|this|these|those|not|never|no|only|still|already|but|actually|why|what|when|until|unless|wrong|cannot|can't|isn't|aren't|doesn't|won't)\b|\?/i;

/**
 * 中身の無い問いかけ（いわゆる釣り）。
 *
 * ★2026-08-18、冒頭差し替えを入れた直後に空いた穴。
 *
 * FRICTION_MARKERS には "?" と "you" が入っているので、
 *   "Have you ever wondered about 65W chargers?"
 * は定義型の判定を素通りする。しかも修正呼び出しに
 * 「摩擦を作れ」と指示すると、モデルが一番楽に摩擦を出せるのがこの形。
 *
 * 機械判定は必ず通り、採点官は必ず落とす。
 * 気づかないまま投稿枠だけが消える経路になる。
 *
 * ★本物の問いかけは弾かない。
 *   "Why does the second write always win?"  → 対象そのものを問う。通す
 *   "Have you ever wondered why..."          → 読者の自覚を問う。弾く
 * 違いは「主題を問うか、読者の認知を問うか」。
 */
const HOLLOW_QUESTION_PATTERNS = [
  /^(have|has) you\b/i,
  /\bhave you ever\b/i,
  /\bever wondered\b/i,
  /\bdid you know\b/i,
  /\bdo you know\b/i,
  /\byou ever (wonder|notice|think)\b/i,
  /\bwhat if I told you\b/i,
  /\bcan you guess\b/i,
  /\bwant to know\b/i,
  /\bguess what\b/i,
  /\bthink again\b/i
];

function isHollowQuestionOpener_(text) {
  const first = firstLineOf_(text);
  if (!first) return false;
  return HOLLOW_QUESTION_PATTERNS.some(function (re) { return re.test(first); });
}

/** 空行を飛ばした最初の行。 */
function firstLineOf_(text) {
  return String(text || '').split('\n')
    .map(function (l) { return l.trim(); })
    .filter(Boolean)[0] || '';
}

function isDefinitionalOpener_(text) {
  const first = firstLineOf_(text);
  if (!first) return false;
  if (FRICTION_MARKERS.test(first)) return false;
  return DEFINITIONAL_VERBS.test(first);
}

/**
 * Bで絶対に投稿してはいけない3本の線。
 *
 * ★2026-08-19、オーナー指示でBの品質判定を「文が切れていないか」と
 * 「URLが間違っていないか」だけに絞った。表現のきわどさは全部通す。
 *
 * ただしこの3本は品質基準ではない。外すと壊れるのは文章ではなく
 * アカウントと報酬そのものなので、判定の場所を移して残す。
 *
 *   1. 未成年に見える対象   … 法域によっては違法。日本の法にも触れうる
 *   2. 流出・無修正・割れ   … 権利者＝報酬の出所を殴る行為。ASPを切られる
 *   3. 実在個人の性的な扱い … 名誉毀損・肖像権。3本の中で最も重い
 *
 * これまではLLM採点官の基準として書かれていた。採点を外すと一緒に
 * 消えてしまうので、機械判定へ移した。副次的に、判定が決定的になり
 * 採点1回ぶんのAPIも要らなくなる。
 *
 * ★3のうち機械で確実に捕まえられるのは限られる。
 * 「実在の誰か」を語だけで判定するのは無理なので、ここでは
 * 明確な手掛かり（本人アカウントへの言及＋性的文脈）だけを拾う。
 * 生成側プロンプトの禁止は従来どおり残してある。
 */
const B_HARD_LINE_PATTERNS = [
  // 1. 未成年
  { re: /\b(loli|lolicon|shota|shotacon|underage|under[- ]?age|minors?|preteen|jailbait)\b/i,
    why: '未成年を示す語が含まれています。この線は例外なく越えません。' },
  { re: /\b(child|kid|toddler)\b[^.!?]{0,40}\b(sexy|lewd|erotic|nude|nsfw)\b/i,
    why: '未成年と性的表現が同じ文にあります。' },

  // 2. 流出・無修正・割れ
  { re: /\b(uncensored|decensored|no[- ]mosaic|mosaic[- ]removed)\b/i,
    why: '無修正を示唆しています。権利者を害するため出せません。' },
  { re: /\b(leaked|leak|ripped|cracked|pirated|torrent|nyaa|megaupload|mega\.nz)\b/i,
    why: '流出・海賊版を示唆しています。報酬の出所を害するため出せません。' },
  { re: /\bfree\s+(download|dl)\b/i,
    why: '無料ダウンロードを示唆しています。正規の購入導線と矛盾します。' },

  // 3. 実在個人の性的な扱い（機械で拾える範囲だけ）
  { re: /@[A-Za-z0-9_]{2,}[^.!?]{0,60}\b(nude|naked|lewd|sexy|fuck|cum|tits|pussy)\b/i,
    why: '実在アカウントへの言及と性的表現が同じ文にあります。' },
  { re: /\b(cosplayer|idol|actress|streamer|vtuber)\b[^.!?]{0,40}\b(nude|naked|lewd|leaked)\b/i,
    why: '実在の人物像と性的表現が結びついています。' }
];

/**
 * Bの絶対的な線に触れていないか。
 * @return {Array<string>} 触れた理由。問題なければ空
 */
function checkBHardLines_(text) {
  const s = String(text || '');
  const hits = [];
  B_HARD_LINE_PATTERNS.forEach(function (p) {
    if (p.re.test(s)) hits.push(p.why);
  });
  return hits;
}

/** 中身の無い抽象語。これが多いほど「何も言っていない」投稿になる。 */
const VAGUE_WORDS = [
  'optimize your', 'maximize your', 'boost your', 'improve your',
  'take it to the next level', 'best practice', 'best practices',
  'key takeaway', 'actionable', 'synergy', 'holistic', 'robust solution',
  'cutting edge', 'state of the art', 'game changer', 'must-have'
];

/**
 * 具体物を含んでいるか。
 *
 * 数値・固有名詞・単位のいずれも無い投稿は、ほぼ確実に抽象論。
 * 大文字で始まる語（ツール名・サービス名）を固有名詞の目印にする。
 * 文頭の1語目は普通の文でも大文字なので数えない。
 */
/**
 * 語で書かれた数量。"three weeks" "a tenth" も具体性として扱う。
 * 曖昧になりやすい "one" は入れない（"one thing" のような filler が多いため）。
 */
const SPELLED_QUANTITIES = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|dozen|half|third|quarter|tenth|twice)\b/i;

/**
 * 「ツールの名前らしい」語か。
 * 文頭に来ていても固有名詞と判定できる形だけを拾う。
 *   GitHub / PostgreSQL … 途中に大文字
 *   API / DNS / CSV     … 全部大文字
 *   example.com         … ドメイン形
 *   gemini-3.6          … 英数字混在
 */
function looksLikeToolName_(word) {
  const w = String(word || '').replace(/[^A-Za-z0-9.\-]/g, '');
  if (w.length < 2) return false;
  if (/^[A-Z]{2,}$/.test(w)) return true;                 // API, DNS
  if (/^[A-Za-z]+[A-Z]/.test(w)) return true;             // GitHub, PostgreSQL
  if (/^[A-Za-z][A-Za-z0-9]*[-.][A-Za-z0-9]/.test(w)) return true;  // gemini-3.6, example.com
  return false;
}

function hasConcreteAnchor_(text) {
  const s = String(text || '');

  // 数字（箇条書きの番号だけは具体性とみなさない）
  if (/\d/.test(s.replace(/^\s*\d+[.)]\s*/gm, ''))) return true;

  // 語で書かれた数量も具体性として認める
  if (SPELLED_QUANTITIES.test(s)) return true;

  // ★固有名詞の判定では「文頭の大文字」を素朴に数えない。
  // 数えてしまうと "Build it slowly and the results follow." の Build を
  // ツール名と誤認し、中身が空の抽象論を通してしまう。
  //   ・文の2語目以降の大文字始まり → 固有名詞とみなす
  //   ・文頭でも「ツール名の形」をしていれば固有名詞とみなす（Gemini, GitHub）
  const sentences = s.split(/[.!?\n]+/);
  for (let i = 0; i < sentences.length; i++) {
    const words = sentences[i].trim().split(/\s+/);
    for (let j = 0; j < words.length; j++) {
      const clean = words[j].replace(/[^A-Za-z0-9.\-]/g, '');
      if (clean.length < 2) continue;

      if (j === 0) {
        if (looksLikeToolName_(clean)) return true;   // 文頭はツール名の形のときだけ
        continue;
      }
      if (/^[A-Z]/.test(clean)) return true;
    }
  }

  return false;
}

/**
 * 「測っていないのに測ったふりをした数字」の形。
 *
 * ★これが今いちばん効く検査。
 * hasConcreteAnchor_ が「数字があれば具体的」と判定するため、
 * LLMにとって最も楽な合格方法が「それらしい数字を捏造すること」になっていた。
 * 実際に $105 per 1,000 leads という、誰も測っていない単価が投稿された。
 *
 * ツール名（Twilio / Redis 等）だけでも具体性は足りるので、
 * 金額と単位経済の断定は落とす。実在の一般知識（HTTP 500、280字）は
 * 通貨記号も "per N" も伴わないので、この検査には掛からない。
 */
const INVENTED_FIGURE = [
  // 金額。$105 / ¥3,000 / 105 dollars
  /[$¥€£]\s?\d[\d,.]*/,
  /\b\d[\d,.]*\s?(dollars|usd|yen|jpy|eur|gbp)\b/i,
  // 単位経済。per 1,000 leads / per 1k users / a month
  /\bper\s+[\d,]+\s*k?\s+\w+/i,
  /\b\d[\d,.]*\s?(%|percent)\s+(faster|slower|cheaper|higher|lower|more|less)\b/i,
  // 倍率の断定
  /\b\d+(\.\d+)?\s?x\s+(faster|cheaper|better|more|less)\b/i
];

/**
 * その数字が出典の本文に実際に書かれているか。
 *
 * ★「読んだ記事から引用した数字」と「でっち上げた数字」を分ける唯一の手段。
 * 本文を渡されていない回は常に false を返す（＝従来どおり弾く）。
 * 判定を甘くするのではなく、照合できた時だけ通す。
 *
 * 1桁の数字は偶然一致しやすいので、表記そのものの一致を要求する。
 *
 * @param {string} figure 本文中で見つかった数値表現（"$99" など）
 * @param {string} sourceText 取得済みの記事本文
 */
function figureAppearsInSource_(figure, sourceText) {
  const src = String(sourceText || '');
  if (!src) return false;

  const f = String(figure || '').trim();
  if (!f) return false;

  // 表記がそのまま出てくるなら確実に引用
  if (src.indexOf(f) !== -1) return true;

  /*
   * 記号や空白の違いを吸収して数値部分だけで照合する（$99 と 99 dollars など）。
   *
   * ★ただし部分一致では駄目（2026-08-16）。
   * 単純な indexOf だと "1400mAh" の中の "400" に当たり、
   * 記事に無い "$400 Ultra" という価格が引用として通ってしまった。
   * 数として独立している時だけ一致とみなす。
   */
  const num = (f.match(/\d[\d,.]*/) || [''])[0].replace(/,/g, '');
  if (num.replace(/[^0-9]/g, '').length < 2) return false;   // 1桁は偶然一致するので不可

  const normalisedSrc = src.replace(/,/g, '');
  const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 前後が数字でないこと。小数点で続く場合も別の数なので一致としない。
  return new RegExp('(^|[^0-9.])' + escaped + '($|[^0-9.])').test(normalisedSrc);
}

/** 「〜がゼロになる」等の言い切り。ほぼ必ず誇張になる。 */
const ABSOLUTE_CLAIMS = [
  /\bto zero\b/i, /\bzero cost\b/i, /\bnever fails?\b/i,
  /\b100%\s+(reliable|accurate|safe)\b/i, /\beliminates?\s+all\b/i,
  /\bcompletely\s+(free|eliminates|removes)\b/i
];

/* ------------------------------------------------------------------ */
/* 見た目と掴み（読まれるかどうか）                                      */
/* ------------------------------------------------------------------ */
/*
 * ★ここが長らく欠けていた検査。
 *
 * 品質判定が「技術的に濃いか」「嘘が無いか」しか見ていなかったため、
 * 内容は正しいのに誰も読まない投稿が78点で通っていた。実例：
 *
 *   An HTTP 200 response containing {"success": false} silently disables
 *   workflow retries. Most automation middleware inspects transport status
 *   codes, not internal JSON keys. The execution is flagged as successful
 *   while the record update fails.
 *
 * 事実は正しく、数字の捏造も無い。それでも読まれない。理由は3つ。
 *   1. 1行目が88字の平叙文。スクロールを止める掴みが無い
 *   2. 改行が1つも無い。スマホのXでは灰色の壁に見える
 *   3. 3文とも同じ長さ・同じ調子で、リズムが無い
 *
 * 内容の良し悪しはLLMに採点させるが、この3つは機械的に測れる。
 * 測れるものを主観に投げない。
 */

/*
 * 絵文字の判定。
 *
 * ★★(U+2605) と ☆(U+2606) を除外している。
 * この2文字は Unicode の Misc Symbols(2600-27BF) に入っているため、
 * 素朴に数えると「☆☆☆ for the premise」が絵文字3つ扱いで弾かれていた。
 * 採点表示は絵文字ではないので、数える対象から外す。
 */
const EMOJI_CHAR = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2604}\u{2607}-\u{27BF}]/u;
const EMOJI_CHAR_G = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2604}\u{2607}-\u{27BF}]/gu;

/** 1行目（掴み）の上限。これを超えると一目で読み取れない。 */
const HOOK_MAX_LEN = 75;

/** 改行を要求する本文長。これ未満の短文は1段落のままでよい。 */
const WALL_THRESHOLD = 140;

/** 段落1つの上限。超えると塊に見える。 */
const PARAGRAPH_MAX_LEN = 200;

/*
 * ★「掴みとして面白いか」はここで判定しない。
 *
 * 一度、掴みらしい語（you / but / why / turns out …）の一覧を作って
 * 「どれも入っていなければ平板」と判定したが、Bのキュレーター調
 * （"Doujin does not mean amateur." 等）が軒並み落ちた。
 * 面白さは語彙では測れない。単語表を意味判断の代わりにしない。
 *
 * 局所判定は機械的に測れるもの（長さ・改行）だけを見る。
 * 「1行目でスクロールが止まるか」はLLM採点側の基準に置いてある。
 */

/*
 * 反応投稿の行数。2〜5行（2026-08-16、オーナー指定）。
 *
 * 1行だと投げっぱなしに見え、6行を超えるとタイムラインで折りたたまれる。
 * 空行は数えない。「行」は改行で区切られた実体のある行のこと。
 */
const REACTION_MIN_LINES = 2;
const REACTION_MAX_LINES = 5;

/*
 * 単独投稿の最小行数。
 *
 * ★2026-08-17に実害が出たので追加した。
 * 採点基準を生成プロンプトへ渡した際に「1行目が点数を決める」を強調しすぎ、
 * モデルが1行目だけを書いて本文を落とすようになった。実際に出てしまったのが
 * これ（掴みだけで、なぜそうなるかが無い）:
 *
 *   Your scraper is blocked because Chromium sends HTTP/2 headers
 *   in alphabetical order.
 *
 * 短いため「壁」判定にも掛からず、1行なので掴みの長さ判定にも掛からず、
 * 局所検査を全て素通りしていた。
 *
 * 単独投稿はプロンプト上 PATTERN INTERRUPT → PAYOFF の2段が必須なので、
 * 実体のある行が1行しかない時点で PAYOFF が無い。
 * 言い回しでの指示はモデルの解釈次第で崩れるが、行数は崩れない。
 */
const STANDALONE_MIN_LINES = 2;

/**
 * 投稿の「形」を見る。内容ではなく、指を止めるかどうか。
 *
 * @param {string} text
 * @param {boolean} isReaction 反応投稿なら行数の上下限も見る
 * @return {Array<string>} 直すべき点（空なら合格）
 */
function checkPostShape_(text, isReaction, requirePayoff) {
  const s = String(text || '').trim();
  const reasons = [];
  if (!s) return reasons;

  // URLだけの行はリンクであって本文ではない。形の判定から外す。
  const bodyLines = s.split('\n').filter(function (ln) {
    const t = ln.trim();
    return t && !/^https?:\/\/\S+$/.test(t);
  });
  if (!bodyLines.length) return reasons;

  const body = bodyLines.join('\n');
  const bodyLen = estimateWeightedLength_(body);

  // --- 0. 行数（反応投稿のみ）-----------------------------------------
  if (isReaction) {
    if (bodyLines.length < REACTION_MIN_LINES) {
      reasons.push('This is ' + bodyLines.length + ' line. A reaction needs ' +
                   REACTION_MIN_LINES + ' to ' + REACTION_MAX_LINES + ' lines: ' +
                   'the verdict on its own line, then why you land there.');
    } else if (bodyLines.length > REACTION_MAX_LINES) {
      reasons.push('This is ' + bodyLines.length + ' lines. Keep it to ' +
                   REACTION_MAX_LINES + ' at most — past that it gets collapsed ' +
                   'in the timeline and nobody expands it. Cut, do not compress.');
    }
  } else if (requirePayoff && bodyLines.length < STANDALONE_MIN_LINES) {
    // ★掴みだけで本文が無い投稿を止める（上の定数のコメント参照）
    reasons.push('This is only the hook. There is no payoff under it. ' +
                 'A claim with no mechanism is a headline, not a post: ' +
                 'state the thing that stops the scroll, then break the line and ' +
                 'explain why it happens.');
  }

  // --- 1. 掴みの長さ -------------------------------------------------
  // ★短い投稿には適用しない。1行で終わる投稿の1行目は「掴み」ではなく
  // 投稿そのもので、そこを分割させても読みやすくならない。
  const first = bodyLines[0].trim();
  const firstLen = estimateWeightedLength_(first);
  if (bodyLen > WALL_THRESHOLD && firstLen > HOOK_MAX_LEN) {
    reasons.push('The first line is ' + firstLen + ' characters long. A hook has to land ' +
                 'in one glance. Break after the first idea so the opening line is under ' +
                 HOOK_MAX_LEN + '.');
  }

  // --- 2. 壁になっていないか ------------------------------------------
  if (bodyLen > WALL_THRESHOLD && bodyLines.length === 1) {
    reasons.push('The whole post is one unbroken block of ' + bodyLen + ' characters. ' +
                 'On a phone that is a grey wall and gets scrolled past. ' +
                 'Break it into at least two parts.');
  }

  // --- 3. 段落が長すぎないか ------------------------------------------
  s.split(/\n\s*\n/).forEach(function (para) {
    const p = para.trim();
    if (!p) return;
    if (estimateWeightedLength_(p) > PARAGRAPH_MAX_LEN) {
      reasons.push('One block runs ' + estimateWeightedLength_(p) +
                   ' characters without a break. Split it.');
    }
  });

  return reasons;
}

/**
 * 文の途中で切れている語。ここで終わっていたら未完成。
 * 実際に "...on step one because `autocomplete" が投稿されていた。
 */
const DANGLING_TAIL = /\b(because|and|or|but|the|a|an|with|for|to|of|in|on|at|that|which|when|while|if|so|than|from|into|about|is|are|was|were|be|been|has|have|had|do|does|did|will|would|can|could|it|this|these|those|you|your|my|its)$/i;

/** プロンプトの雛形が漏れた痕跡。人間の投稿には絶対に出ない。 */
const TEMPLATE_LEAK = [
  /\{[A-Z_]{2,}\}/,          // {URL} {AUTO} {TARGET_TWEET_TEXT}
  /\[[A-Za-z ]+label\]/i,    // [Bracket label]
  /\{\{.*?\}\}/,
  /^(structure|rule|rules|example|examples|hook|flex|drop)\s*[:：]/i
];

/**
 * 投稿として完成しているかを見る。
 *
 * ★これが無かったせいで、トークン上限で切れた断片が3本続けて投稿された。
 * 生成側（MAX_TOKENS検知）でも止めているが、こちらは最後の関門。
 * 「途中で切れた文を出すくらいなら投稿しない」を機械的に保証する。
 *
 * @return {{ok:boolean, reason:string}}
 */
function looksIncomplete_(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, reason: 'Empty.' };

  for (let i = 0; i < TEMPLATE_LEAK.length; i++) {
    if (TEMPLATE_LEAK[i].test(s)) {
      return { ok: false, reason: 'Contains leftover template text or a placeholder. ' +
                                  'Write the finished post, not the instructions.' };
    }
  }

  // 記号の対応が取れていない＝途中で切れている
  const pairs = [['(', ')'], ['[', ']'], ['「', '」'], ['『', '』'], ['"', '"']];
  for (let j = 0; j < pairs.length; j++) {
    const open = s.split(pairs[j][0]).length - 1;
    const close = s.split(pairs[j][1]).length - 1;
    if (open !== close) {
      return { ok: false, reason: 'Unbalanced ' + pairs[j][0] + pairs[j][1] +
                                  '. The text is cut off partway.' };
    }
  }

  /*
   * ★末尾のハッシュタグは「文の終わり」の判定から外す（2026-08-19）。
   *
   * Bのハッシュタグ禁止を解除した結果、"... worth a look. #mood" のように
   * タグで終わる投稿が「終止符が無い＝途中で切れている」と誤判定された。
   * タグは文の一部ではなく後置きのラベルなので、剥がしてから本文を見る。
   * Aはハッシュタグ自体を別途弾いているので、こちらの挙動は変わらない。
   */
  const last = s.replace(/(?:\s+#[^\s#]+)+\s*$/, '').replace(/\s+$/, '') || s.replace(/\s+$/, '');
  // ★絵文字はサロゲートペアなので slice(-1) では下位半分しか取れず判定を誤る。
  // コードポイント単位で末尾を取る。
  const chars = Array.from(last);
  const tail = chars.length ? chars[chars.length - 1] : '';
  const endsProperly =
    /[.!?。！？…]/.test(tail) ||
    EMOJI_CHAR.test(tail) ||
    /https?:\/\/\S+$/.test(last);

  if (!endsProperly) {
    // 終止符が無くても、体言止めの短い一文なら許す。
    // ただし接続詞・前置詞で終わっていたら確実に途中。
    const words = last.split(/\s+/);
    const lastWord = String(words[words.length - 1] || '').replace(/[^A-Za-z']/g, '');
    if (DANGLING_TAIL.test(lastWord)) {
      return { ok: false, reason: 'Ends on "' + lastWord + '", so the sentence is unfinished. ' +
                                  'Write a complete post.' };
    }
    if (words.length >= 4) {
      return { ok: false, reason: 'The last sentence has no ending punctuation and reads ' +
                                  'as cut off. Finish the thought.' };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * ローカルでの品質判定。API を使わない。
 *
 * @return {{ok:boolean, reasons:Array<string>}}
 */
function checkPostQualityLocal_(accountKey, text, angle, sourceText) {
  const key = String(accountKey).toUpperCase();
  // ★記事や動画への反応投稿は、単独投稿とは別の基準で見る。
  // 反応投稿の仕事は「見つけたものへの判断」であって、
  // 自前でツール名や数字を持ち出すことではない。
  const isReaction = /^SOURCE|^QUOTE/i.test(String(angle || ''));
  /*
   * ★★バズ投稿は単独投稿とも反応投稿とも仕事が違う（2026-08-24）。
   *
   * 【なぜ足したか】
   * オーナー報告「Bは動画が出ているのにAが出ない」を追う中で、
   * A のバズ投稿が構造的に1本も通らないことが分かった。
   * バズ投稿は設計上ハッシュタグを3〜5個付けるが、Aの基準には
   * 「ハッシュタグを含むなら不合格」がある。さらに
   * 「具体物の名前か数字が要る」も課されるが、バズ投稿の具体物は
   * 添付した映像であって本文ではない。
   * つまり生成側と採点側が正反対の指示で動いていた。
   * B は key !== 'B' のガードで全部免除されていたので通っていた。
   * これが「Bだけ動画が出る」の本当の理由。
   *
   * ★免除するのは上の2つと「形」だけ。文が切れていないか、
   *   捏造した数字が無いか、3本の絶対線は今までどおり課す。
   */
  const isBuzz = /^BUZZ/i.test(String(angle || ''));
  const s = String(text || '').trim();
  const lower = s.toLowerCase();
  const reasons = [];

  if (!s) return { ok: false, reasons: ['本文が空です。'] };

  // --- 両アカウント共通 ---------------------------------------------
  // ★最優先。途中で切れた文・雛形の漏れは、内容の良し悪し以前の問題。
  const complete = looksIncomplete_(s);
  if (!complete.ok) reasons.push(complete.reason);

  /*
   * ★掴みと改行の形はAだけに課す（2026-08-19にBを除外）。
   * Bは「文が切れていないか」と「URL」以外を判定しない方針になったため。
   * 1行目が長い・改行が無いといった見た目の指摘も、内容側の判断に当たる。
   */
  if (key !== 'B') {
    // ★バズは「掴み＋一言＋タグ行」で完結する型。payoff の行数は課さない
    checkPostShape_(s, isReaction, key === 'A' && !isBuzz)
      .forEach(function (r) { reasons.push(r); });
  }

  // ★抽象語の判定はAだけ（2026-08-19）。Bは内容を判定しない方針。
  if (key !== 'B') {
    VAGUE_WORDS.forEach(function (w) {
      if (lower.indexOf(w) !== -1) {
        reasons.push('Contains the empty marketing phrase "' + w + '". Cut it and say the actual thing.');
      }
    });
  }

  // --- A だけの基準（専門性で読ませるアカウント）---------------------
  if (key !== 'B') {
    GENERIC_OPENERS.forEach(function (op) {
      if (lower.indexOf(op) === 0) {
        reasons.push('Opens with "' + op + '", which announces generic advice. ' +
                     'Start from something that actually happened instead.');
      }
    });

    ADVISORY_PATTERNS.forEach(function (re) {
      const m = s.match(re);
      if (m) {
        reasons.push('Uses the instructional phrase "' + m[0] + '". ' +
                     'Do not tell the reader what to do. Report what you did and what happened.');
      }
    });

    // ★定義型の書き出し（辞書の説明文）を機械的に弾く。下記 isDefinitionalOpener_ 参照。
    if (!isReaction && isDefinitionalOpener_(s)) {
      reasons.push('The first line is a definition ("X is/uses/trades..."), which is ' +
                   'what a dictionary entry sounds like. Say the same thing with ' +
                   'friction: implicate something the reader owns, contradict what ' +
                   'they assume, or name the moment it breaks.');
    }

    /*
     * ★読者の自覚を問うだけの釣りを弾く。
     *
     * 定義型を禁じた先で、モデルが一番楽に「摩擦」を作れるのがこの形。
     * FRICTION_MARKERS に "?" と "you" が入っているので機械判定は必ず通り、
     * 採点官は必ず落とす。気づかないまま投稿枠だけが消える経路になる。
     */
    if (isHollowQuestionOpener_(s)) {
      reasons.push('The first line is bait aimed at the reader\'s awareness ' +
                   '("Have you ever...", "Did you know..."), which promises nothing. ' +
                   'Make a claim about the subject instead of asking whether they ' +
                   'have thought about it.');
    }

    /*
     * ★捏造した数字を弾く。ただし「出典に書いてある数字」は捏造ではない。
     *
     * 【2026-08-16に見つけた実害】
     * "Apple Watch battery replacement: How much does it cost" という
     * 価格の記事に感想を書かせたが、価格に触れた瞬間ここで落ちる。
     * 5回作り直して5回とも同じ理由で不合格になり、
     * アフィリエイトに最も近い題材が丸ごと捨てられていた。
     *
     * 本文を読めている回は、その数字が本文に在るかを実際に照合する。
     * 在れば引用なので通す。無ければ捏造なので従来どおり弾く。
     */
    /*
     * ★1文に複数の数字が出るので、全件を見る。
     * s.match(re) は最初の1件しか返さないため、以前は
     * "$99 ... on a $400 Ultra" の $99（正当）を確認した時点で終わり、
     * 記事に無い $400 を素通りさせていた。
     */
    INVENTED_FIGURE.forEach(function (re) {
      const all = s.match(new RegExp(re.source, re.flags.indexOf('g') === -1
        ? re.flags + 'g' : re.flags));
      if (!all) return;
      all.forEach(function (hit) {
        if (figureAppearsInSource_(hit, sourceText)) return;
        reasons.push('States a specific figure "' + hit.trim() + '" that is not in the ' +
                     'source and that you did not measure. Quote a number the article ' +
                     'actually gives, or name the mechanism instead.');
      });
    });

    ABSOLUTE_CLAIMS.forEach(function (re) {
      const m = s.match(re);
      if (m) {
        reasons.push('Claims "' + m[0].trim() + '", which overstates it. ' +
                     'Say what actually changes, not that the problem disappears.');
      }
    });

    // ★反応投稿には課さない。
    // リンク先のカードが具体物そのものであり、こちらの仕事は判断を言うこと。
    // ここを課していたため、記事への感想が「ツール名が無い」で落ちていた。
    // ★バズの具体物は添付した映像そのもの。本文に道具名を求めない
    if (!isReaction && !isBuzz && !hasConcreteAnchor_(s)) {
      reasons.push('There is no concrete anchor: no number, no named tool or service, ' +
                   'no specific detail. As written this could have been posted by anyone ' +
                   'about anything. Add a real number or a real tool name.');
    }

    // ★バズ投稿はリンクを捨てる代わりにタグで拾われにいく型。
    //   ここを課すと、生成側が必ず付けるタグで必ず落ちる（実際にそうなっていた）
    if (!isBuzz && /#\w/.test(s)) {
      reasons.push('Contains a hashtag. This account does not use hashtags.');
    }
    // 絵文字は2つまで許可（2026-08-15）。
    // 全面禁止にしていたが、フックの型と噛み合わず文章が硬くなっていた。
    // 並べ立てる（3つ以上）のだけを弾く。
    const emojiA = s.match(EMOJI_CHAR_G) || [];
    if (emojiA.length > 2) {
      reasons.push('Uses ' + emojiA.length + ' emojis. At most two, and only where they mean something.');
    }
  }

  /*
   * --- B の基準 --------------------------------------------------------
   *
   * ★2026-08-19、オーナー指示で内容の判定を全て外した。
   * 「文が切れてないかURLが間違ってないかのみで文の内容は通して」。
   *
   * 外したもの（表現の自由度を上げるため。全て意図的）:
   *   ・ハッシュタグ禁止
   *   ・バナー広告的CTA（buy now 等）
   *   ・価格・セール・ランキングへの言及
   *   ・低意図の誘い文句（come see me 等）
   *   ・絵文字の個数
   *   ・抽象語（VAGUE_WORDS）… 下の共通部分でBを除外
   *
   * 残したものは2つだけ:
   *   ・文が途中で切れていないか（共通部分の looksIncomplete_）
   *   ・絶対に越えない3本の線（未成年 / 流出・無修正 / 実在個人）
   *
   * 3本の線は「品質」ではない。表現がどれだけきわどくても構わないが、
   * ここを越えると壊れるのは文章ではなくアカウントと報酬そのものなので、
   * 内容判定の撤廃とは切り離して残している。
   *
   * URLの正しさは 17_BFunnel.gs 側（checkBLinkUsage_）で見ている。
   */
  if (key === 'B') {
    checkBHardLines_(s).forEach(function (r) { reasons.push(r); });
  }

  return { ok: reasons.length === 0, reasons: reasons };
}

/* ------------------------------------------------------------------ */
/* 2段目: LLMによる採点                                                 */
/* ------------------------------------------------------------------ */

/** これ未満なら作り直す。 */
const QUALITY_MIN_SCORE = 70;

/** 採点を有効にするか。0にするとローカル判定だけになる（API節約用）。 */
function qualityScoringEnabled_() {
  return getProp_('QUALITY_SCORING', '1') === '1';
}

function qualityMinScore_() {
  const n = Number(getProp_('QUALITY_MIN_SCORE', String(QUALITY_MIN_SCORE)));
  return isNaN(n) ? QUALITY_MIN_SCORE : n;
}

/**
 * 生成物を別のプロンプトで採点させる。
 *
 * 書いた本人に「良いか」と聞くと甘くなるので、
 * 「これを見せられたフォロワーが実際にどう反応するか」を判定させる。
 *
 * 採点に失敗した場合は通す（採点機能の不調で投稿が止まる方が損失が大きい）。
 *
 * @return {{score:number, reason:string, scored:boolean}}
 */
function scorePostWithLLM_(accountKey, text, angle) {
  if (!qualityScoringEnabled_()) return { score: 100, reason: '', scored: false };

  const isB = String(accountKey).toUpperCase() === 'B';
  /*
   * ★Bの投稿タイプは「売る型」と「教える型」に分かれている。
   *
   * 【2026-08-18に見つけた矛盾】
   * Linksシートが0行の間、選ばれるのは非リンク型だけ
   * （CATEGORY_GUIDE / CULTURE / DISCOVERY / CREATOR_WORK_DISCOVERY /
   *   TERMINOLOGY / COMMUNITY_QUESTION）。
   * それらのブリーフは「教えろ。売るな。リンクは無し」と指示している。
   *
   * ところが採点官は全タイプ共通で
   *   「買い手が実際にクリックするか」「欲求を生むか」
   * で測っていた。貼るリンクが無く、売るなと言われて書いた文を、
   * クリック率で採点していたことになる。
   * 生成側と採点側が反対の指示で動いていた。
   *
   * 教える型の仕事は購買ではなくフォロー。そこで測る。
   */
  const bSellingTypes = { ACCESS_GUIDE: 1, PRODUCT_DISCOVERY: 1, PROBLEM_SOLUTION: 1,
                          COMPARISON: 1, DIRECT_CTA: 1 };
  const isBTeaching = isB && !bSellingTypes[String(angle || '').toUpperCase()];
  // ★反応投稿（記事・動画・他人の投稿へのコメント）は単独投稿と仕事が違う。
  // 単独投稿の基準（自前のツール名・自分の経験）で採点すると、
  // 良い感想が「ツール名が無い」「経験が無い」で落ちる。
  const isReaction = /^SOURCE|^QUOTE/i.test(String(angle || ''));
  // ★バズ投稿（リンク無し・動画付き）は別の物差しで見る。理由は
  //   checkPostQualityLocal_ の isBuzz のコメントに書いた
  const isBuzz = /^BUZZ/i.test(String(angle || ''));

  const system = (isBuzz && !isB)
    ? 'You judge BUZZ posts on X — a short post with a video attached and no link. ' +
      'Its only job is reach: stop the scroll, get a reply or a repost. ' +
      'You are strict, but judge it as entertainment, not as expertise. ' +
      'It is not supposed to teach anyone anything or name a product.'
    : isB
    ? 'You judge posts for an adult-content affiliate account with a teasing insider ' +
      'persona, aimed at English speakers who buy Japanese adult and doujin content. ' +
      'You are strict. Most accounts in this space are bland affiliate spam and get ' +
      'ignored. Provocative and seductive is CORRECT for this account; bland is the ' +
      'failure mode. Judge whether it would actually make someone click.'
    : isReaction
    ? 'You judge REACTION posts on X — a comment attached to an article or video ' +
      'the account is sharing. The link carries the news; the comment has to carry ' +
      'the judgement. You are strict. A comment that only restates the headline is ' +
      'worthless, because the headline is already right there in the preview card.'
    : 'You judge posts for a technical marketing account on X. ' +
      'You are strict. Generic advice is worthless because thousands of accounts post it.';

  // ★1行ずつ並べるための改行。criteria の各行末に付ける
  const NL = '\n';

  const criteria = (isBuzz && !isB)
    ? 'A VIDEO IS ATTACHED. The reader watches before reading. Judge the post as' + NL +
      '  the caption on that video, not as a standalone statement.' + NL +
      '- READ ONLY THE FIRST LINE. Would that alone stop a thumb mid-scroll?' + NL +
      '  A neutral statement of fact scores under 45.' + NL +
      '- Does it give the reader something to say back: a claim to argue with,' + NL +
      '  a preference to defend, a "that happened to me too"? That is the whole' + NL +
      '  point of this post. If there is nothing to reply to, score under 50.' + NL +
      '- Does it sound like one thought caught mid-flight, or like a tidy summary?' + NL +
      '  A neat concluding sentence that restates the point scores under 55.' + NL +
      '- Does it narrate the video ("this video shows...", "watch how...")?' + NL +
      '  Score narration under 40. Reacting is right; describing is not.' + NL +
      '- Would it read exactly the same with a different clip behind it?' + NL +
      '  If yes, score under 45. It has to belong to this footage.' + NL +
      '- Does it invent a number, a price, or a fact? Score under 30.' + NL +
      'Do NOT penalise it for these, they are correct for this format:' + NL +
      '  hashtags on the last line, no link, no product name, no personal' + NL +
      '  credentials, no lesson, being short.'
    : isB
    ? (isBTeaching
      /*
       * 教える型。この回にリンクは無い。クリックで測らない。
       * 測るのは「このアカウントを追う理由になるか」。
       */
      ? '- This post has NO link and is not supposed to sell. Do not judge it on\n' +
        '  whether someone would click or buy. There is nothing to click.\n' +
        '- Judge it on this: after reading, would an English speaker who is into\n' +
        '  this world follow the account to get more like it?\n' +
        '- Does it hand over one specific thing they did not have before — a word,\n' +
        '  a convention, how the scene actually works, something that exists and\n' +
        '  they did not know existed?\n' +
        '- Is it concrete about that one thing, or is it a general description of\n' +
        '  a category that says nothing? General overviews score under 45.\n' +
        '- Does it sound like someone who is actually in this world, or like a\n' +
        '  travel guide written from outside? Outside voice scores under 50.\n' +
        '- Is the voice consistent: all lowercase, confident, unbothered?\n' +
        '- Any invented titles, prices, ratings or creators? If so, score under 20.\n'
      : '- Does it create real desire or curiosity? Flat and polite is a FAILURE here.\n' +
        '- Is there tension: does it imply something the reader is missing out on?\n' +
        '- Does it sound like an insider with taste, or like a generic affiliate bot?\n' +
        '- Is the voice consistent: all lowercase, confident, teasing, never begging?\n' +
        '- Would a buyer actually click, or is it just words?\n' +
        // ★捏造の禁止は型を問わず必要。売る型では作品名や価格が特に出やすい
        '- Any invented titles, prices, ratings or creators? If so, score under 20.\n') +
      /*
       * ★2026-08-18、オーナー指示で register を調整した。
       *
       * 参考にしたのは1.9万フォロワーのFANZAアフィリエイトアカウント。
       * あの型が効いているのは、上品だからではなく、
       * 作品の中身を短く官能的に言い切っているから。
       * 「品はいいが何も言っていない」文はこのジャンルでは売れない。
       *
       * ただし線は3本残す。ここは緩めない。
       *   ・実在の個人（コスプレイヤー・著名人・一般人）を性的に書かない
       *     → 作品内の架空のキャラクターを描くのは対象外。ここは許す
       *   ・流出・無修正・割れを匂わせない（権利者＝報酬元を守る線）
       *   ・未成年に見える対象は絶対に扱わない
       */
      '- Suggestive, sensual and provocative is CORRECT here. Tasteful but empty is a FAILURE.\n' +
      '  Describe what the work delivers in a way that creates want. Do not be coy.\n' +
      '- Fictional characters in a published work may be described. That is the product.\n' +
      '- Does it sexualise a REAL, identifiable person (a cosplayer, a performer by name,\n' +
      '  a public figure, anyone photographed)? If so, score it 0.\n' +
      '- Does it promise uncensored, leaked, ripped or stolen material? If so, score it 0.\n' +
      '- Does it involve anyone who reads as a minor? If so, score it 0.\n' +
      '- Is it pornographic prose rather than marketing? A blow-by-blow account of an act\n' +
      '  is not a hook and does not sell. Score anatomical, step-by-step description under 30.'
    : isReaction
    ? /* 反応投稿の基準。冒頭フックと判断の強さが全て。 */
      'THE FIRST LINE DECIDES THIS SCORE. Read it alone, with nothing after it.\n' +
      '  It is competing with the preview card right below it. If it only names the\n' +
      '  topic, or restates the headline, or eases in with a warm-up, the post is\n' +
      '  dead: score it under 45 however good the rest is.\n' +
      '  A first line earns its place by doing one of these:\n' +
      '    - taking a side ("the caching argument here does not hold")\n' +
      '    - naming the stake ("this breaks the moment you shard")\n' +
      '    - contradicting what the reader assumes\n' +
      '    - a verdict, including a rating with a stated subject\n' +
      '- Is there an actual OPINION, or just a neutral summary? A summary of\n' +
      '  something the card already shows is worthless. Score summaries under 40.\n' +
      '- Does the opinion commit? Hedged both-sides comments score under 50.\n' +
      '- Does it add something past the headline — a consequence, a limit, a\n' +
      '  reason it breaks, who it does not apply to?\n' +
      '- Does it claim to have used or bought something? The author has not.\n' +
      '  If it does, score it under 30.\n' +
      '- Does it invent a number the source did not give? Score it under 30.\n' +
      '- Does it read like a person reacting, or like an abstract for a paper?\n' +
      'Do NOT penalise it for lacking a tool name or a personal anecdote.\n' +
      'The job of this post is the take, not the credentials.'
    : '- READ ONLY THE FIRST LINE. Would that alone stop a thumb mid-scroll?\n' +
      '  If it is a neutral statement of fact, score the whole post under 55\n' +
      '  no matter how correct the rest is. Being right is not being read.\n' +
      '- Does it look like a person typed it, or like a paragraph from a manual?\n' +
      '  Three same-length declarative sentences in a row is a manual.\n' +
      '- Is there a concrete anchor: a NAMED TOOL or a real mechanism?\n' +
      '  A bare number is NOT enough, and an invented one is a failure.\n' +
      '- Does it state a price, a cost per unit, or a measured percentage?\n' +
      '  The author has no such data. If it does, score it under 30.\n' +
      '- Does it claim something drops "to zero" or "never fails"? Score it under 40.\n' +
      '- Does it report experience, or does it give generic advice?\n' +
      '- Would someone who already knows this field still learn something?\n' +
      '- Would anyone save or screenshot this? If it is forgettable, score it low.\n' +
      '- Does it sound like a person who has built things, or like a content marketer?';


  /* ---------------- 採点の物差し（アカウント別）---------------- */

  const calibrationA =
    '  This draft already passed mechanical checks before reaching you: no generic\n' +
    '  opener, no advice syntax, a named concrete anchor, correct shape on screen,\n' +
    '  no invented figures. The average post on X is already excluded from this\n' +
    '  population, so do not score against it. Score against other drafts that also\n' +
    '  cleared those checks.\n' +
    '  70 is the working bar, not a distinction: specific, has a real mechanism,\n' +
    '  worth one read by someone in the field. Remarkable starts at 85.\n' +
    '  Withhold 70 for exactly two reasons — the first line is flat, or someone who\n' +
    '  works in this field would learn nothing. Those are what matter here.\n' +
    '  Do not withhold it for tone, for length, or for not being clever.';

  /*
   * ★★バズの物差し（2026-08-24）。
   *
   * calibrationA をそのまま当ててはいけない。あれは
   * 「具体物の名前」「仕組み」「その分野の人が学べるか」で測る物差しで、
   * リンクも商品名も持たないバズ投稿には一つも当てはまらない。
   * Bの物差しをAへ流用して35点で止まった件（下のコメント）と同じ失敗を、
   * 今度はバズで繰り返さないために分ける。
   */
  const calibrationBuzz =
    '  This draft already passed mechanical checks: it is complete, has no link,\n' +
    '  no invented figures, and fits the character limit. A video is attached.\n' +
    '  Score it against other video captions, not against informative posts.\n' +
    '  70 is the working bar: the first line stops a scroll and there is something\n' +
    '  to reply to. Remarkable starts at 85.\n' +
    '  Withhold 70 for exactly two reasons — the first line is flat, or the post\n' +
    '  would work just as well over any other clip.\n' +
    '  Do NOT withhold it for being short, for having hashtags, for not teaching\n' +
    '  anything, or for not naming a product. None of those apply to this format.';

  const anchorsBuzz = [
    'Anchors. Score consistently with these (video of a skater landing a trick):',
    '',
    '  35 — "This is an incredible display of skill and dedication. #skate"',
    '        Praise with nothing in it. Works over any clip. Reads as a bot.',
    '',
    '  55 — "Took him months to land this one. #skate #sports"',
    '        True, specific to the clip, but there is nothing to say back.',
    '',
    '  75 — "He knew it was clean before his back foot came down. #skate #sports"',
    '        Points at one visible moment. A reader who skates will reply about',
    '        exactly that. This is what 70+ looks like.',
    '',
    '  90 — Something people quote-post with their own version of the story.'
  ].join('\n');

  /*
   * ★Bの物差しはAと別。ここに「具体物の名前」「仕組み」「その分野の人が
   * 学べるか」を書いてはいけない。Bが売っているのは知識ではなく欲求で、
   * 判定すべきは「読んだ人が見に行きたくなるか」の一点。
   */
  const calibrationB =
    '  This draft already passed mechanical checks: no banner-ad phrasing, no\n' +
    '  hashtags, no invented titles or prices, nothing that sexualises a real\n' +
    '  person. Score against other drafts that also cleared those checks, not\n' +
    '  against the average post on X.\n' +
    '  70 is the working bar, not a distinction: it has a point of view, it makes\n' +
    '  one specific thing sound worth finding, and it does not read like an\n' +
    '  affiliate bot. Remarkable starts at 85.\n' +
    '  Withhold 70 for exactly two reasons — it leaves the reader with nothing\n' +
    '  specific, or it could have been written by any account in this space.\n' +
    '  Do NOT withhold it for missing a product name, a mechanism, a number, or\n' +
    '  technical detail. This account does not deal in those. Do not withhold it\n' +
    '  for being suggestive; that is the correct register here.';

  const anchorsA = [
    'Anchors. Score consistently with these:',
    '',
    '  38 — "GaN chargers use gallium nitride instead of silicon, which allows',
    '        smaller chargers. This is why new chargers are compact."',
    '        A definition with a restatement. Correct, and there is nothing in it.',
    '',
    '  55 — "GaN chargers trade thermal mass for form factor.\n\nSmall 65W blocks',
    '        have no internal heat sink, so sustained load pushes the controller',
    '        into throttling."',
    '        Real mechanism, and someone in the field learns nothing. Flat opener.',
    '',
    '  74 — "That 65W block is only 65W for about a minute.\n\nNo internal heat',
    '        sink means sustained load pushes the controller into throttling.',
    '        The number on the box is a peak, not a rating you can hold."',
    '        Same facts as the 55. The opener implicates the reader, and the last',
    '        line reframes what the spec means. This is what 70+ looks like.',
    '',
    '  90 — Something a person in this field would screenshot and send to someone.'
  ].join('\n');

  /*
   * Bのアンカー。Aと同じ「同じ中身で冒頭だけ違う対」の作りにしてある。
   * 露骨な描写は置かない（それ自体が30点未満の対象なので、
   * 手本として置くと基準が壊れる）。
   */
  const anchorsB = [
    'Anchors. Score consistently with these:',
    '',
    '  35 — "Japanese doujin platforms have a wide selection of works across',
    '        many genres for every taste."',
    '        Could be any affiliate bot. Says nothing, wants nothing.',
    '',
    '  55 — "a lot of the best doujin work never gets an official english',
    '        release, so most people outside japan never see it."',
    '        True, and stated politely enough that nobody moves. No want.',
    '',
    '  74 — "the work you would actually like is the work nobody bothered to',
    '        translate.\n\nit sits on the japanese storefronts untouched, and',
    '        the catalogue you have been browsing is the leftovers."',
    '        Same fact as the 55. Now it implicates what the reader has been',
    '        missing and makes them want to look. This is what 70+ looks like.',
    '',
    '  90 — A buyer opens the link because they feel they are late to something.'
  ].join('\n');

  const prompt = [
    'Score this X post from 0 to 100.',
    '',
    'Post:',
    '"""',
    String(text),
    '"""',
    '',
    'Intended angle: ' + (angle || 'unspecified'),
    '',
    'Criteria:',
    criteria,
    '',
    'Scoring guide:',
    '  0-40  Generic. Could be posted by any account. Nobody would follow for this.',
    '  41-69 Fine but forgettable. Nothing wrong, nothing memorable.',
    '  70-84 Good. Specific and worth reading.',
    '  85-100 Genuinely strong. Someone would save or quote this.',
    '',
    /*
     * ★2026-08-18、ここを直した。以前は次の1行だった。
     *   "Be harsh. Most posts are 40-60. Do not be generous."
     *
     * これは合格点70と噛み合っていない。
     * 「大半は40〜60だ」と言っておいて70で切るのは、
     * 採点官に「基本は落とせ」と言っているのと同じで、
     * 実測でも 35 / 52 / 35 と70の下に張り付いていた。
     *
     * さらに悪いのは、その「大半」がXの投稿全体を指していること。
     * ここへ来る文章は既にローカル判定を通っている——
     * 汎用的な書き出し無し・助言構文無し・具体物あり・形が整っている・
     * 捏造数字無し。つまり母集団が既に絞られている。
     * 絞られた母集団を、絞っていない前提で採点させていた。
     *
     * 厳しさは落とさない。落とすべき2点（平坦な冒頭・学びが無い）は
     * 明示して残し、母集団の前提だけを実態へ合わせる。
     */
    /*
     * ★キャリブレーションもアンカーもアカウント別にする。
     *
     * 【2026-08-18に自分で作った不具合】
     * 共通の1枠に書いていたため、Bの採点官が
     *   「具体物の名前があるか」「画面上の形が正しいか」（＝Aのローカル判定）
     *   「実際の仕組みがあるか」「その分野の人が一読の価値を感じるか」
     * という基準と、GaN充電器の例で採点していた。
     * 同人作品の紹介文をハードウェア記事の物差しで測れば当然落ちる。
     * 実際にBが35点で止まった。
     */
    'Calibration:',
    isB ? calibrationB : (isBuzz ? calibrationBuzz : calibrationA),
    '',
    /*
     * ★採点の基準点（アンカー）。
     *
     * 生成側のプロンプトには良い例・悪い例が5組以上あるのに、
     * 採点側には1つも無かった。基準無しで0〜100の絶対評価をさせると、
     * 同じ文が呼ぶたびに違う点になる。「70点」が何を指すのか、
     * モデルにも我々にも分かっていなかった。
     *
     * 実際に落ちた文（52点）を境界の例として置き、
     * その上下を1本ずつ添える。これで70の位置が固定される。
     */
    isB ? anchorsB : (isBuzz ? anchorsBuzz : anchorsA),
    '',
    'Report the first line separately from the score, so that a flat opener on an',
    'otherwise solid post can be fixed without rewriting the whole post.',
    '  hook_ok = true  when the first line alone would stop a scroll',
    '  hook_ok = false when it is a definition, a restatement, or a warm-up',
    'Judge hook_ok on the first line ONLY. Judge score on the whole post.',
    '',
    /*
     * ★診断（flaw）と指示（fix_instruction）を分けて返させる。
     *
     * 以前は "reason" 1文だけを受け取り、書き直しの指示は
     * コード側で「1行目を書き直せ」という定型文にしていた。
     * 何が悪いかを見ている当人に、次の一手まで言わせたほうが具体的になる。
     * ただし「どこを直すか」の判断はコード側（hook_ok）に残す。
     */
    'Return only JSON: {"score": <number>, "hook_ok": <true|false>, ' +
      '"reason": "<one sentence naming the primary structural failure>", ' +
      '"fix_instruction": "<one concrete directive, such as: ' +
      'Turn line 1 into a tension without adding numbers>"}'
  ].join('\n');

  try {
    /*
     * ★temperature 0 で呼ぶ。
     * 既定の0.85は文章を書かせるための値で、採点に使うと同じ文が
     * 呼ぶたびに違う点になる。判定は創作ではないので揺らす理由が無い。
     */
    const raw = callLLM_(system, prompt, { temperature: 0 });
    const parsed = JSON.parse(extractJson_(String(raw)));
    const score = Number(parsed && parsed.score);
    if (isNaN(score)) return { score: 100, reason: '', scored: false };
    return {
      score: score,
      // 明示的に false の時だけ「冒頭が弱い」と扱う。
      // 未指定や壊れた応答を「弱い」と解釈すると、全部落ちる側へ倒れる。
      hookOk: !(parsed && parsed.hook_ok === false),
      reason: String((parsed && parsed.reason) || ''),
      fix: String((parsed && parsed.fix_instruction) || ''),
      scored: true
    };
  } catch (e) {
    // 採点できないことを理由に投稿を止めない
    console.warn('品質採点に失敗（投稿は継続）: ' + e);
    return { score: 100, reason: '', scored: false };
  }
}

/**
 * ローカル判定と採点をまとめて行う。
 *
 * @return {{ok:boolean, score:number, critique:string}}
 */
function evaluatePost_(accountKey, text, angle, sourceText) {
  const local = checkPostQualityLocal_(accountKey, text, angle, sourceText);
  if (!local.ok) {
    /*
     * ★不合格の原因が「冒頭が定義文」だけなら、それは冒頭の問題だと
     * ここで断定できる。採点官に聞くまでもない。
     *
     * hook_ok を立てておくと、呼び出し側が冒頭差し替え（repairHook_）へ
     * 進めるので、採点1回ぶんを使わずに直せる。
     *
     * ただし理由が他にもある場合は立てない。
     * 冒頭を差し替えても、捏造数字や壊れた文はそのまま残るため。
     */
    const hookOnly = local.reasons.length === 1 &&
      local.reasons[0].indexOf('The first line is a definition') === 0;
    return {
      ok: false,
      /*
       * ★どの段で落ちたかを返す。
       * 'local' は捏造・途中で切れた文・禁止表現など「事故」。
       *          相対評価の候補にしてはいけない（投稿してはいけない）。
       * 'llm'   は「読んで面白いか」という主観。候補として比較してよい。
       */
      stage: 'local',
      score: 0,
      critique: local.reasons.join('\n'),
      hookOk: hookOnly ? false : undefined,
      fix: hookOnly
        ? 'Replace the definition with a line that creates tension, using only the facts already in the body.'
        : ''
    };
  }

  /*
   * ★反応投稿はLLM採点に掛けない（2026-08-16、オーナー判断）。
   *
   * 理由は3つ。
   *   1. 反応投稿の価値は「読んだ上での判断」であり、
   *      それを別のLLMに100点満点で採点させても精度が出ない。
   *      実際、良い感想が「ツール名が無い」で落ち続けていた
   *   2. 採点で落ちると投稿が丸ごと見送られる。
   *      本文を読みに行った手間ごと捨てることになる
   *   3. 投稿1本あたりのAPI呼び出しが1回減る
   *
   * 品質が野放しになるわけではない。ローカル判定は全て通している。
   *   ・途中で切れた文（MAX_TOKENS断片）
   *   ・捏造した金額・単価・測定値
   *   ・見ていない本編への批評（checkQuoteClaims_ 側）
   *   ・冒頭フックの長さ、行数、壁になっていないか
   * 機械的に測れる嘘と読みにくさは、これまでどおり止まる。
   * 止めるのをやめたのは「面白いかどうか」の主観判定だけ。
   */
  if (/^SOURCE|^QUOTE/i.test(String(angle || ''))) {
    return { ok: true, score: 0, critique: '' };
  }

  /*
   * ★Bは採点そのものを行わない（2026-08-19、オーナー指示）。
   *
   * 「Bはスレスレギリギリまで言って。採点も通すな。
   *   文が切れてないかURLが間違ってないかのみで文の内容は通して」
   *
   * 採点官は「欲求を生むか」「この界隈の誰でも書けないか」で
   * 落としていたが、それは表現の強さを抑える方向に働いていた。
   * Bに求めているのは無難さではないので、主観の判定を丸ごと外す。
   *
   * 通したのは内容の判断だけで、線は残っている:
   *   ・文が途中で切れていないか  → checkPostQualityLocal_（共通部分）
   *   ・3本の絶対線              → checkBHardLines_
   *   ・URLの取り違え・捏造URL    → 17_BFunnel.gs checkBLinkUsage_
   * これらは上の local 判定で既に通過済み。
   */
  if (String(accountKey).toUpperCase() === 'B') {
    return { ok: true, score: 0, critique: '' };
  }

  const judged = scorePostWithLLM_(accountKey, text, angle);
  const min = qualityMinScore_();
  /*
   * ★採点結果を残す。
   *
   * これまで記録されていたのは「通った投稿の点数」だけだった。
   * 落ちた案は例外と一緒に消えるので、ログには70点以上しか残らない。
   * その状態では「基準が厳しすぎるのか」を誰も判定できない。
   * 実際、オーナーに聞かれて答えられなかった。
   *
   * 落ちた点数こそが判断材料になる。
   *   ・落ちた案が60〜69に集まっている → 基準が数点高い
   *   ・落ちた案が20〜40に散っている   → 基準ではなく文章の問題
   * 感覚ではなく数字で決められるようにする。
   */
  if (judged.scored) recordQualityScore_(accountKey, judged.score);
  if (judged.score < min) {
    /*
     * ★不合格の理由を「冒頭が原因か、中身が原因か」に切り分ける。
     *
     * 以前は採点コメント1文をそのまま書き直し指示に流していた。
     * その1文は毎回ニュアンスが違うので、
     * 冒頭だけ直せば済む回にも本文ごと作り直させていた。
     *
     * 採点官に hook_ok を別で答えさせているので、
     * どちらを直すかはコード側で決められる。判断をLLMに任せない。
     */
    const directive = judged.fix ? ' Do this: ' + judged.fix : '';
    const critique = judged.hookOk === false
      ? 'Scored ' + judged.score + '/100 (needs ' + min + '). ' +
        'THE FIRST LINE IS THE ONLY PROBLEM. The body is fine — leave it exactly ' +
        'as it is, word for word. Rewrite the first line alone so it stops a ' +
        'scroll, using the same facts. Judge said: ' + judged.reason + directive
      : 'Scored ' + judged.score + '/100 (needs ' + min + '). ' +
        'The opening line is doing its job; the body is what falls short. ' +
        'Keep the first line as it is. ' + judged.reason + directive;

    return {
      ok: false,
      stage: 'llm',          // 主観の不足。候補として比較してよい
      score: judged.score,
      critique: critique,
      hookOk: judged.hookOk,
      fix: judged.fix
    };
  }
  return { ok: true, score: judged.score, critique: '' };
}

/* ------------------------------------------------------------------ */
/* 採点結果の記録（基準が妥当かを数字で判断するため）                   */
/* ------------------------------------------------------------------ */

/**
 * ★なぜ要るか。
 *
 * Logシートに残るのは「投稿できた文の点数」だけで、必ず基準以上になる。
 * 落ちた案の点数はどこにも残らないため、
 * 「基準が厳しすぎるのか、文章が弱いのか」を切り分けられなかった。
 *
 * ここでは合否に関わらず全ての採点結果を残す。
 * プロパティ1つに直近60件だけ持つ（シートを増やすほどの情報ではない）。
 */
const QUALITY_SCORE_LOG_PROP = 'quality_scores';
const QUALITY_SCORE_KEEP = 60;

function recordQualityScore_(accountKey, score) {
  try {
    const list = readQualityScores_();
    list.push({ a: String(accountKey).toUpperCase(), s: Math.round(Number(score) || 0) });
    props_().setProperty(QUALITY_SCORE_LOG_PROP,
                         JSON.stringify(list.slice(-QUALITY_SCORE_KEEP)));
  } catch (e) {
    // 記録に失敗しても投稿は続ける。監視が本業を止めてはいけない。
    console.warn('採点結果の記録に失敗: ' + e);
  }
}

function readQualityScores_() {
  try {
    const raw = getProp_(QUALITY_SCORE_LOG_PROP, '');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 「基準は妥当か」を1画面で判断できる形にする（「点検」用）。
 *
 * 見るべきは通過率ではなく【惜しい】の数。
 *   ・落ちた案が基準の10点以内に集まっている → 基準が数点高いだけ
 *   ・落ちた案がそれより下に散っている       → 基準ではなく文章の問題
 * ここを取り違えると、直すべきでない方を直すことになる。
 */
function buildQualityScoreText_() {
  const list = readQualityScores_();
  if (!list.length) return '';

  const min = qualityMinScore_();
  const lines = ['【採点の分布】直近' + list.length + '回 / 基準' + min + '点'];

  ['A', 'B'].forEach(function (key) {
    const scores = list.filter(function (r) { return r.a === key; })
                       .map(function (r) { return r.s; });
    if (!scores.length) return;

    const passed = scores.filter(function (s) { return s >= min; }).length;
    const near = scores.filter(function (s) { return s < min && s >= min - 10; }).length;
    const far = scores.length - passed - near;
    const best = Math.max.apply(null, scores);

    lines.push('  ' + key + ': 合格' + passed + ' / 惜しい' + near +
               ' / 遠い' + far + '（最高' + best + '点）');
  });

  // 判断は数字が出揃ってからにする。数件で基準を動かすと戻せなくなる。
  if (list.length < 10) {
    lines.push('  ※判断には10回以上ほしい。もう少し様子を見てください。');
    return lines.join('\n');
  }

  const all = list.map(function (r) { return r.s; });
  const passedAll = all.filter(function (s) { return s >= min; }).length;
  const nearAll = all.filter(function (s) { return s < min && s >= min - 10; }).length;

  if (passedAll === 0 && nearAll >= all.length * 0.5) {
    lines.push('  → 落ちた案の半分が基準の10点以内。基準が数点高い可能性があります。');
    lines.push('    QUALITY_MIN_SCORE を ' + (min - 5) + ' にすると通り始めます。');
  } else if (passedAll === 0) {
    lines.push('  → 基準から遠い案が中心。閾値ではなく題材や書き方の問題です。');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 冒頭1行だけを直す専用の呼び出し                                      */
/* ------------------------------------------------------------------ */

/**
 * 冒頭の1行だけを差し替える。本文には触らない。
 *
 * ★なぜ専用の呼び出しにするか。
 *
 * 実測で落ちた5回のうち3回が「冒頭が平坦」だけの理由だった。
 * それまでは生成用のプロンプト一式（人格・地域・角度・型・良い例悪い例・
 * 禁止事項）をもう一度丸ごと送って書き直させていた。
 * 1行を直させるために数千字の指示を送っていたことになる。
 * 指示が多いほど「1行だけ直せ」は守られにくくもなる。
 *
 * ここでは本文と失敗した1行と理由だけを渡し、候補を3本もらう。
 * 3本あるので、機械判定（isDefinitionalOpener_）でふるいに掛けられる。
 * 書き手と採点官が同じモデルである以上、1本勝負だと同じ癖が出る。
 * 3本引いて機械で選ぶことで、そこに人手以外の選別を1枚挟む。
 *
 * @return {?string} 差し替え済みの全文。作れなければ null
 */
function repairHook_(accountKey, text, judgeFix, budget) {
  const lines = String(text || '').split('\n');
  const firstIdx = lines.findIndex(function (l) { return l.trim().length > 0; });
  if (firstIdx < 0) return null;

  const failedHook = lines[firstIdx].trim();
  const body = lines.slice(firstIdx + 1).join('\n').trim();
  // 本文が無いなら「1行だけ直す」話ではない。通常の書き直しに任せる。
  if (!body) return null;

  /*
   * 冒頭に使える文字数。本文はそのまま残すので、上限から本文を引いた残り。
   * これを渡さないと、収まらない候補を選んでから丸ごと捨てることになり、
   * 修正の呼び出し1回がまるまる無駄になる。
   */
  const bodyLen = estimateWeightedLength_(body) + 2;   // +2 は間の空行
  const room = (Number(budget) > 0 ? Number(budget) : TWEET_MAX_WEIGHTED_LENGTH) - bodyLen;
  const hookCharBudget = Math.max(20, Math.min(70, room));

  const system =
    'You rewrite the opening line of a post on X. You never touch the body. ' +
    'The body is already approved and must be returned unchanged.';

  const prompt = [
    'The body below is approved. Do not change it.',
    '',
    'APPROVED BODY:',
    '"""', body, '"""',
    '',
    'FAILED OPENING LINE:',
    '"' + failedHook + '"',
    '',
    'WHY IT FAILED:',
    judgeFix || 'It is a neutral statement of fact and does not stop a scroll.',
    '',
    /*
     * ★3案それぞれに別の型を指定する。
     *
     * 型を指定せずに「3案出せ」と言うと、2案目・3案目は1案目を読んだ上で
     * 書かれるため、同じ発想の言い換えになる。そうなると後段の機械判定は
     * ほぼ同じもの同士から選んでいるだけで、仕組みとして意味を成さない。
     * 枠ごとに互いに排他的な型を割り当てると、別々の方向へ振れる。
     *
     * 温度を上げて3回別々に呼べば確実に多様になるが、呼び出しが3倍になり、
     * 高温は捏造（測っていない数字・使ったふり）を呼び込む。
     * このアカウントではそれが一番避けたい失敗なので、1回のまま型で散らす。
     */
    'Write 3 alternative opening lines to replace it.',
    'Each slot has a DIFFERENT required shape. Do not blur them together:',
    '  1. A contradiction. State that something the reader believes is wrong.',
    '  2. A consequence. Name the moment or condition where it stops working.',
    '  3. A reframe. Say what the thing actually is, against what it is sold as.',
    '',
    'All three must:',
    '  - lead naturally into the approved body,',
    '  - use ONLY facts already present in the body. You may not add a number,',
    '    a price, a measurement, a benchmark, or any claim of having used the',
    '    product. Those are automatic failures,',
    '  - stay under ' + hookCharBudget + ' characters,',
    '  - not be a definition ("X is...", "X trades Y for Z"),',
    '  - not be a hollow question aimed at the reader\'s awareness',
    '    ("Have you ever wondered...", "Did you know..."). Those are bait and',
    '    are rejected outright. A question about the SUBJECT is fine.',
    '',
    'Return only JSON: {"candidates": ["<1>", "<2>", "<3>"]}'
  ].join('\n');

  let candidates;
  try {
    // 判定的な作業なので温度を下げる。ただし3本に差が要るので0にはしない。
    const raw = callLLM_(system, prompt, { temperature: 0.4 });
    const parsed = JSON.parse(extractJson_(String(raw)));
    candidates = (parsed && parsed.candidates) || [];
  } catch (e) {
    console.warn('冒頭の修正に失敗（通常の書き直しへ）: ' + e);
    return null;
  }
  if (!Array.isArray(candidates) || !candidates.length) return null;

  /*
   * ★機械でふるいに掛ける。ここが3本もらう意味。
   * 定義型に戻っているもの、長すぎるもの、元と変わっていないものを外す。
   */
  const usable = candidates
    .map(function (c) { return String(c || '').trim().split('\n')[0].trim(); })
    .filter(function (c) {
      if (!c || c === failedHook) return false;
      // 定義型に戻っているもの
      if (isDefinitionalOpener_(c)) return false;
      // 読者の自覚を問うだけの釣り。機械判定は通るが採点官は必ず落とす
      if (isHollowQuestionOpener_(c)) return false;
      // 収まらないもの。ここで見ておかないと、選んでから丸ごと捨てる羽目になる
      return estimateWeightedLength_(c) <= room;
    });

  if (!usable.length) {
    console.warn('使える冒頭の候補がありませんでした（通常の書き直しへ）');
    return null;
  }

  console.log('冒頭を差し替え: "' + truncate_(failedHook, 50) + '" → "' +
              truncate_(usable[0], 50) + '"');
  return usable[0] + '\n\n' + body;
}

/* ------------------------------------------------------------------ */
/* A/B共通の採否ルール                                                  */
/* ------------------------------------------------------------------ */

/**
 * ★AとBでジャンルは違うが、採否の考え方は1つにする。
 *
 * 【なぜ共通化するか】
 * AとBは別々の生成ループを持っている（07_AIGenerator.gs / 17_BFunnel.gs）。
 * そのため片方に入れた修正がもう片方に入らず、実際に事故が起きた:
 *   ・2026-08-18 Aに採点アンカーを足したらBにも流れ込み、
 *     同人作品の紹介文をハードウェア記事の物差しで採点していた
 *   ・冒頭差し替え(repairHook_)はAだけに入り、Bは古い経路のままだった
 *
 * ジャンル固有のもの（プロンプト・採点基準・アンカー・投稿タイプ）は
 * 分けたままでよい。分けてはいけないのは「どう採否を決めるか」。
 * ここに集約して、両方から呼ぶ。
 *
 * 【ルール】
 *   1. ローカル判定（捏造・途中で切れた文・禁止表現）で落ちたものは
 *      絶対に投稿しない。これは品質ではなく事故
 *   2. LLM採点の点数は相対評価。候補の中で一番高いものを出す
 *   3. 候補が1本も無い時だけ投稿を見送る
 *
 * 2により、片方が投稿できてもう片方だけがエラーになる状況が起きにくい。
 *
 * @param {string} accountKey
 * @param {?{text:string, score:number}} best ローカル判定を通った最良の候補
 * @param {Array} attemptLog 通知用
 * @param {function(string, number)} finish 採用時に呼ぶ組み立て関数
 * @return {*} finish の戻り値
 * @throws {QualityFloorError} 候補が1本も無い場合のみ
 */
function acceptBestCandidate_(accountKey, best, attemptLog, finish) {
  if (best && best.text) {
    console.log(accountKey + ': 基準未満だが候補中の最良を採用 (' + best.score +
                '点 / 基準 ' + qualityMinScore_() + '点)');
    notifyWeakPostOnce_(accountKey, best.score);
    return finish(best.text, best.score);
  }

  /*
   * 候補ゼロ＝全てローカル判定で落ちた。
   * 主観の問題ではなく、捏造や壊れた文が出続けている状態なので投稿しない。
   */
  const log = Array.isArray(attemptLog) ? attemptLog : [];
  const detail = log.map(function (a, i) {
    return '  ' + (i + 1) + '回目 ' + a.score + '点: ' + truncate_(a.reason, 90);
  }).join('\n');
  console.warn(accountKey + ': 採用できる候補がありませんでした。\n' + detail);
  notifyPoorQualityOnce_(accountKey, best, log);
  throw new QualityFloorError(accountKey, best ? best.score : 0);
}

/**
 * 判定結果を受けて、次に何をするかを1箇所で決める。
 *
 * AとBの両方から呼ぶ。戻り値の意味:
 *   best        … 候補として控えるべきか（ローカルを通ったものだけ）
 *   repairHook  … 冒頭だけ差し替えるべきか
 *
 * @return {{keepAsCandidate:boolean, tryHookRepair:boolean}}
 */
function nextActionFor_(verdict) {
  return {
    // ローカルで落ちたものは投稿できない。候補に入れない
    keepAsCandidate: verdict.stage === 'llm',
    // 冒頭だけが原因だと分かっている時は、そこだけ直す
    tryHookRepair: verdict.hookOk === false
  };
}
