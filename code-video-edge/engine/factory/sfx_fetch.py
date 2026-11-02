#!/usr/bin/env python3
# ============================================================
# 効果音の取得（#330→#331・Openverse・商用可ライセンスのみ）
#   「合成で出しにくい実録音だけ」を Openverse から取る（追加であって置き換えではない）。
#   オーナー指示（#331）：商用利用を許可するライセンスのみに絞る。帰属表示が要る
#   ライセンス（CC-BY）の場合に備え、各ファイルの所有者名（creator）を保存する
#   →投稿の説明文に記載する（画面には焼かない）。
#
#   使ってよいライセンス（ALLOWED）＝ 商用可かつ改変可かつ継承/非改変でない：
#     cc0（表記不要）／pdm（パブリックドメイン・表記不要）／by（表記必要）。
#   除外：by-sa（継承＝我々の動画まで同ライセンスに縛る）・by-nd（改変不可＝混ぜる我々は不可）
#         ・by-nc*（非商用）・その他。
#
#   この環境（描画コンテナ）からは api.openverse.org に出られないため、
#   声や参考ページと同じく GitHub Actions の中でだけ実行する。取った wav と
#   出典（.json＝所有者名・ライセンス・URL）を暗号化アセットに同梱し、
#   描画時はローカル固定を使う＝0円・決定論。
#
# 使い方（Actions の中）： python3 factory/sfx_fetch.py <request.json> <outdir>
#   request.json の "sfx": ["paper page flip", ...] を1件ずつ取り、
#   <outdir>/sfx/<slug>.wav と <slug>.json（出典）を書く。<slug>=md5(q)[:12]。
#   既にある slug は再取得しない（キャッシュ・冪等）。
#   商用可が1件も無ければ exit 1（それ以外へ落とさない）。
# ============================================================
import sys, os, json, re, time, hashlib, subprocess, urllib.request, urllib.parse

API = "https://api.openverse.org/v1/audio/"
UA = "jmas-ai-os motion sample fetch (+https://github.com/jnk-hama/jmas-ai-os)"   # Openverse は User-Agent 必須
ALLOWED = {"cc0", "pdm", "by"}   # 商用可・改変可・継承/非改変でない（#331）
ATTRIB_REQUIRED = {"by"}         # 帰属表示が必要なライセンス（cc0/pdm は不要）


def slug_of(q):
    return hashlib.md5(q.encode("utf-8")).hexdigest()[:12]


def pick_allowed(results):
    """検索結果から『編集に最適な商用可の音』を1件選ぶ。
    ランキング順（Openverse は関連度順）で先頭の、license が ALLOWED かつ
    再生URLを持つものを返す。該当が無ければ None（それ以外は選ばない）。"""
    for r in results or []:
        if (r.get("license") or "").strip().lower() not in ALLOWED:
            continue
        if not r.get("url"):
            continue
        return r
    return None


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    tok = os.environ.get("OPENVERSE_TOKEN")   # 任意：登録クライアントの Bearer（レート上限が上がる）。無ければ匿名
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    for i in range(3):   # 絞りの少ない検索は 40 秒で時間切れになった（#339）→ 待ちを延ばし、時間切れだけ引き直す
        try:
            with urllib.request.urlopen(req, timeout=90) as f:
                return json.load(f)
        except TimeoutError:
            if i == 2: raise
            time.sleep(5 * (i + 1))


def search_commercial(q):
    # 商用可（license_type=commercial）・効果音・短め に絞って検索（「編集に最適なオプション」）。
    # 継承(by-sa)/非改変(by-nd) は commercial に含まれるので、最終の絞りは pick_allowed（ALLOWED）が行う
    # 分類（category）が付いていない録音が多く、"water pour" が0件だった（#339）→ 0件なら分類の絞りを外し、効果音の録音が集まる Freesound に絞って引き直す。商用可の絞りは外さない
    base = {"q": q, "license_type": "commercial", "page_size": "20"}
    for extra in ({"category": "sound_effect", "length": "short"}, {"source": "freesound", "length": "short"}):
        res = _get_json(API + "?" + urllib.parse.urlencode({**base, **extra})).get("results", [])
        if pick_allowed(res):
            return res
    return res


def download_wav(item, wav_path, ff):
    src = item["url"]
    if not src.startswith("https://"):
        sys.exit(f"音源URLが https でない: {src}")
    tmp = wav_path + ".src"
    req = urllib.request.Request(src, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as o:
        o.write(r.read())
    # 48k mono wav へ。先頭の無音を軽く削り、頂点を正規化（混ぜる時の gain は描画側で掛ける）
    subprocess.run([ff, "-v", "error", "-y", "-i", tmp, "-ac", "1", "-ar", "48000",
                    "-af", "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB",
                    wav_path], check=True)
    os.remove(tmp)


def main():
    reqp, outdir = sys.argv[1], sys.argv[2]
    ff = os.environ.get("FFMPEG", "ffmpeg")
    req = json.load(open(reqp, encoding="utf-8"))
    queries = req.get("sfx") or []
    if not queries:
        print("sfx: 依頼なし（スキップ）")
        return
    sfxdir = os.path.join(outdir, "sfx")
    os.makedirs(sfxdir, exist_ok=True)
    for q in queries:
        slug = slug_of(q)
        wav_p = os.path.join(sfxdir, slug + ".wav")
        meta_p = os.path.join(sfxdir, slug + ".json")
        if os.path.exists(wav_p) and os.path.exists(meta_p):
            print(f"sfx: キャッシュ {q} ({slug})")
            continue
        # 失敗理由は「::error::」で出す＝Actions の注記（annotations）に残る。
        # このセッションからはジョブのログ本体を読めないので、注記が唯一の手がかり（#339・2回原因不明で落ちた）
        try:
            res = search_commercial(q)
        except Exception as e:
            sys.exit(f"::error::sfx: 検索に失敗 {q}: {type(e).__name__}: {e}")
        item = pick_allowed(res)
        if not item:
            lics = sorted({(r.get("license") or "?") for r in res})
            sys.exit(f"::error::sfx: 商用可の効果音が見つからない: {q}（{len(res)}件・ライセンス {lics}）… 語を変えるか合成SFXで代用（商用可=cc0/pdm/by のみ・#331）")
        lic = (item.get("license") or "").strip().lower()
        try:
            download_wav(item, wav_p, ff)
        except Exception as e:
            sys.exit(f"::error::sfx: 取り込みに失敗 {q} ← {item.get('url')}: {type(e).__name__}: {e}")
        meta = {"q": q, "slug": slug, "license": lic,
                "attribution_required": lic in ATTRIB_REQUIRED,   # #331 by は説明文に所有者名を記載
                "creator": item.get("creator"),                   # 所有者名（帰属先）を保存
                "id": item.get("id"), "title": item.get("title"),
                "license_url": item.get("license_url"),
                "foreign_landing_url": item.get("foreign_landing_url"), "url": item.get("url"),
                "source": item.get("source"), "attribution": item.get("attribution"),
                "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        json.dump(meta, open(meta_p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"sfx: 取得 {q} ({slug}・{lic}) by {item.get('creator')} ← {item.get('foreign_landing_url')}")


if __name__ == "__main__":
    main()
