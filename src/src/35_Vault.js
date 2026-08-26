/**
 * ===========================================================================
 * 35_Vault.gs  —  自前の素材貯蔵庫（Google Drive）
 * ===========================================================================
 *
 * ★何のためか（オーナー指示 2026-08-24）
 * 「自前の貯蔵庫を作れるか。Webから著作権フリーの素材を貯めていって、
 *   繋ぎ合わせて使いたい。無料で」
 *
 * ★これまでの弱点
 * VideoStock は「外部CDNのURLの一覧」でしかなかった。つまり、
 *   ・相手が消せば404。実際に取得失敗が続いて在庫を壊しかけた
 *   ・投稿のたびに外部から落とし直す（毎回の通信）
 *   ・APIキーが失効／レート制限に当たれば全部止まる
 * URLは「借り物へのリンク」であって、資産ではない。
 *
 * ★貯蔵庫にすると
 * 一度落としたものは自分のDriveに残る。以後は無料・無制限に使える。
 * 相手が消しても、キーが切れても、こちらの在庫は減らない。
 *
 * ★drive.file スコープでも動く（ここが以前の誤解）
 *
 * `drive.file` は「このアプリが作った／開いたファイル」だけに触れる権限。
 * 2026-08-21に pickDriveVideo_ が失敗したのは、**オーナーが手で作った
 * フォルダ**を getFolderById で開こうとしたから。
 * **アプリ自身が createFolder したフォルダなら、権限の対象に入る。**
 * だから貯蔵庫はコード側で作る。新しい認可は要らない。
 *
 * ★ライセンス
 * 保存するのは Pexels / Pixabay（商用利用可・帰属不要）と、
 * オーナーが明示的に指定したURLだけ。他人の作品を落として貯めることはしない。
 */

const VAULT_FOLDER_PROP = 'vault_folder_id';
const VAULT_FOLDER_NAME = 'JmasVideoVault';

/** 貯蔵庫を使うか。既定で有効（無料なので止める理由が無い）。 */
function vaultEnabled_() {
  return String(getProp_('VAULT_MODE', '1')) !== '0';
}

/**
 * 1回の補充で何本まで落とすか。
 * ★GASの実行枠は6分。1本数MBのダウンロード＋保存を欲張ると時間切れになる。
 */
const VAULT_SAVE_PER_RUN = 3;

/** 貯蔵庫の上限（本数）。Driveの無料枠15GBを食い潰さないため。 */
const VAULT_MAX_FILES = 300;

/* ------------------------------------------------------------------ */
/* フォルダ                                                             */
/* ------------------------------------------------------------------ */

/**
 * 貯蔵庫のフォルダを得る。無ければ作る。
 *
 * ★必ず createFolder で作る。オーナーが手で作ったフォルダを
 * IDで開こうとすると drive.file では失敗する（2026-08-21に実証済み）。
 *
 * @return {?Object} DriveのFolder。失敗時 null
 */
function vaultFolder_() {
  const id = getProp_(VAULT_FOLDER_PROP, '');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // 消された・共有が外れた等。作り直す
      console.warn('貯蔵庫のフォルダを開けません。作り直します: ' + truncate_(String(e), 100));
    }
  }

  try {
    const folder = DriveApp.createFolder(VAULT_FOLDER_NAME);
    props_().setProperty(VAULT_FOLDER_PROP, folder.getId());
    console.log('貯蔵庫を作成しました: ' + folder.getId());
    return folder;
  } catch (e) {
    console.warn('貯蔵庫を作成できません: ' + truncate_(String(e), 120));
    return null;
  }
}

/** 貯蔵庫にある本数。 */
function vaultCount_() {
  const folder = vaultFolder_();
  if (!folder) return 0;
  let n = 0;
  try {
    const it = folder.getFiles();
    while (it.hasNext()) { it.next(); n++; }
  } catch (e) {}
  return n;
}

/* ------------------------------------------------------------------ */
/* 保存と取り出し                                                       */
/* ------------------------------------------------------------------ */

/**
 * 在庫のURL表記。貯蔵庫にあるものは drive: で始める。
 * こうすると VideoStock の1列で「外部URL」と「自前」を両方扱える。
 */
function vaultRef_(fileId) {
  return 'drive:' + String(fileId);
}

function isVaultRef_(url) {
  return /^drive:/.test(String(url || ''));
}

function vaultIdOf_(url) {
  return String(url || '').replace(/^drive:/, '');
}

/**
 * 外部URLの動画を落として貯蔵庫へ保存する。
 *
 * @return {?string} 保存できたら drive:<id>
 */
function saveToVault_(url, name) {
  if (!vaultEnabled_()) return null;

  const folder = vaultFolder_();
  if (!folder) return null;

  const got = fetchVideoBlob_(url);
  if (!got || !got.blob) return null;

  try {
    const blob = got.blob.setName(String(name || 'clip') + '.mp4');
    const file = folder.createFile(blob);
    console.log('貯蔵庫へ保存: ' + file.getId() + '（' +
                Math.round((got.bytes || 0) / 1024) + 'KB）');
    return vaultRef_(file.getId());
  } catch (e) {
    console.warn('貯蔵庫へ保存できません: ' + truncate_(String(e), 120));
    return null;
  }
}

/**
 * 貯蔵庫から動画を読む。
 *
 * ★fetchVideoBlob_ と同じ形を返す。呼び出し側は出所を意識しなくていい。
 * @return {?{blob:!Object, name:string, bytes:number, source:string}}
 */
function vaultBlob_(ref) {
  const id = vaultIdOf_(ref);
  if (!id) return null;
  try {
    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    const bytes = file.getSize();
    if (bytes > VIDEO_MAX_BYTES) {
      console.warn('貯蔵庫の動画が大きすぎます: ' + Math.round(bytes / 1024 / 1024) + 'MB');
      return null;
    }
    return { blob: blob, name: file.getName(), bytes: bytes, source: 'vault' };
  } catch (e) {
    console.warn('貯蔵庫から読めません（' + id + '）: ' + truncate_(String(e), 100));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 在庫を貯蔵庫へ移す                                                   */
/* ------------------------------------------------------------------ */

/**
 * 在庫の中でまだ外部URLのものを、順に落として自前に置き換える。
 *
 * ★これが「貯めていく」の実体。
 * 1回で全部はやらない（実行枠）。毎日少しずつ自前の資産に変わっていく。
 *
 * @return {{moved:number, reason:string}}
 */
function fillVaultFromStock_(limit) {
  if (!vaultEnabled_()) return { moved: 0, reason: '貯蔵庫が無効です' };

  const have = vaultCount_();
  if (have >= VAULT_MAX_FILES) {
    return { moved: 0, reason: '貯蔵庫が上限（' + VAULT_MAX_FILES + '本）です' };
  }

  const want = Math.min(Number(limit) || VAULT_SAVE_PER_RUN, VAULT_SAVE_PER_RUN);
  const ss = openLogSpreadsheet_();
  const sheet = getOrCreateStockSheet_(ss);
  const last = sheet.getLastRow();
  if (last < 2) return { moved: 0, reason: '在庫が空です' };

  const values = sheet.getRange(2, 1, last - 1, STOCK_HEADERS.length).getValues();
  let moved = 0;

  for (let i = 0; i < values.length && moved < want; i++) {
    const row = values[i];
    const url = String(row[STOCK_COL_URL - 1] || '').trim();
    const status = String(row[STOCK_COL_STATUS - 1] || '').toUpperCase();

    if (!/^https?:\/\//i.test(url)) continue;   // 既に自前、または壊れた行
    if (status && status !== 'OK') continue;    // NGの行を貯める意味は無い

    const ref = saveToVault_(url, 'stock_' + (i + 2));
    if (!ref) continue;

    try {
      // URLを自前の参照へ置き換える。以後この行は外部へ行かない
      sheet.getRange(i + 2, STOCK_COL_URL).setValue(ref);
      sheet.getRange(i + 2, STOCK_COL_SOURCE).setValue(
        String(row[STOCK_COL_SOURCE - 1] || '') + '→vault');
      moved++;
    } catch (e) {
      console.warn('在庫の書き換えに失敗: ' + truncate_(String(e), 100));
    }
  }

  return {
    moved: moved,
    reason: moved ? '' : '移せる行がありませんでした（既に自前か、取得に失敗）'
  };
}

/* ------------------------------------------------------------------ */
/* 表示                                                                 */
/* ------------------------------------------------------------------ */

/** 診断用の1行。 */
function vaultStatusLine_() {
  if (!vaultEnabled_()) return '貯蔵庫: 無効（VAULT_MODE=0）';
  const n = vaultCount_();
  return '貯蔵庫: ' + n + '/' + VAULT_MAX_FILES + '本' +
         (n ? '（この分は無料で使い回せます）' : '（まだ空です）');
}

/** GASエディタ用の公開ラッパー。 */
function fillVault() {
  const r = fillVaultFromStock_(VAULT_SAVE_PER_RUN);
  const msg = '貯蔵庫へ ' + r.moved + ' 本移しました。' + (r.reason || '');
  console.log(msg);
  return msg;
}
