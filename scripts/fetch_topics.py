#!/usr/bin/env python3
"""
Reddit の話題を取ってきて data/topics.json に書く。

★★2026-08-26。GASの材料が0件で固定されていたのを迂回するために作った。

【何が起きていたか】
Reddit は 2026-05-28 に未認証の .json API を廃止した（33_BuzzSource.gs
にも記録がある）。GAS からは 403 しか返らず、バズ診断はずっとこう出ていた。

    A: 話題の材料は0件（Reddit 36板: 認証が必要（未認証APIは廃止済み） /
       YouTube: APIキー未設定）。映像そのものを題材にして投稿します

材料が0件だと「映像そのものを題材にする」経路へ落ちる。その結果、
本文が在庫映像の説明になり、スケート動画やRiotの手描き動画が出ていた。
文章を磨いても、題材が「たまたま在庫にあった映像」では伸びようがない。

【なぜ RSS なのか】
廃止されたのは .json のAPI。**RSS フィードは認証なしで今も応答する**。
公開されているものを、公開されている形式で読むだけなので、
スクレイピングでも規約の回避でもない。

★ただし RSS には score（upvote数）が入らない。GAS 側は
  BUZZ_MIN_SCORE で足切りする作りなので、score が無いと全部落ちる。
  そこで「RSS由来である」ことを明示し、GAS側で別扱いにする
  （source: "rss" を持たせる。33_BuzzSource.gs 側で閾値を適用しない）。

  伸びているかどうかを確認できない材料を使うことになる。これは劣化だが、
  0件よりはよい。Reddit のアプリ登録が済んだら本来の経路が自動で復活する。

【出力】data/topics.json
{
  "generated_at": "...",
  "accounts": { "A": [ {id,title,url,subreddit,views,source}, ... ], "B": [...] }
}
"""

import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

# GAS の BUZZ_SUBS と揃えてある（33_BuzzSource.gs）。
# ここを変えたら向こうも変える必要はない（GASは受け取るだけ）。
SUBS = {
    'A': ['nextfuckinglevel', 'Damnthatsinteresting', 'BeAmazed',
          'WinStupidPrizes', 'Unexpected', 'holdmybeer',
          'toptalent', 'interestingasfuck', 'ContagiousLaughter'],
    # ★anime_irl を外した（2026-08-26）。画像だけを投げる板で、
    #   タイトルが板名の使い回し（"anime_irl"）になり材料にならない。
    #   実データで5件すべてが除外対象だった。
    #   代わりに見出しが文章になる板を足す。
    'B': ['Animemes', 'awwnime', 'AnimeSakuga', 'animegifs',
          'cosplay', 'streetwear', 'anime', 'manga', 'Genshin_Impact'],
}

# 1アカウントあたり何件まで残すか。GAS 側は上位10件しか見ないので、
# それより少し多めに持たせておく。
MAX_PER_ACCOUNT = 15

# 1板あたり何件取るか
PER_SUB = 5

# ★UA を名乗る。名乗らないリクエストは 429 を返されやすい
UA = 'jmas-topic-fetcher/1.0 (+https://github.com/jnk-hama/video-render-worker)'

TIMEOUT = 20

# ★★429（叩きすぎ）への対処（2026-08-26、初回実行で実際に食らった）。
#
#   16板を1秒で連続アクセスした結果、大半が 429 で落ちた。
#   特にBは全板が429に当たり0件になった。Reddit は短時間の連続アクセスを弾く。
#
#   「速く終わらせる」ことに価値は無い。6時間おきの定期実行なので、
#   2分かかっても構わない。取れないほうが損。
SLEEP_BETWEEN = 3      # 板と板の間に必ず空ける秒数
MAX_RETRY = 2          # 429 を食った時に再試行する回数
RETRY_WAIT = 12        # 再試行までの既定の待ち（Retry-Afterがあればそちらを優先）

ATOM = '{http://www.w3.org/2005/Atom}'


def log(msg):
    print(msg, flush=True)


def fetch_sub(sub, attempt=1):
    """
    1つの板から上位を取る。失敗しても例外にしない。

    ★1板が落ちただけで全体を止めない。Reddit は板単位で消えたり
      privateになったりする（33_BuzzSource.gs も 404 を個別に扱っている）。
    """
    url = 'https://www.reddit.com/r/%s/top/.rss?t=week&limit=%d' % (sub, PER_SUB)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            body = res.read()
    except urllib.error.HTTPError as e:
        # ★429 は「叩きすぎ」であって、板が死んでいるわけではない。
        #   待てば通るので、諦める前に必ず1度は待って試す。
        if e.code == 429 and attempt <= MAX_RETRY:
            wait = RETRY_WAIT
            try:
                wait = max(wait, int(e.headers.get('Retry-After') or 0))
            except (TypeError, ValueError):
                pass
            log('  r/%s: HTTP 429 → %d秒待って再試行 (%d/%d)'
                % (sub, wait, attempt, MAX_RETRY))
            time.sleep(wait)
            return fetch_sub(sub, attempt + 1)
        log('  r/%s: HTTP %s' % (sub, e.code))
        return []
    except Exception as e:
        log('  r/%s: 到達できません (%s)' % (sub, str(e)[:80]))
        return []

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        log('  r/%s: 応答が壊れています (%s)' % (sub, str(e)[:60]))
        return []

    out = []
    for entry in root.findall(ATOM + 'entry'):
        title = (entry.findtext(ATOM + 'title') or '').strip()
        if not title:
            continue

        link_el = entry.find(ATOM + 'link')
        href = link_el.get('href') if link_el is not None else ''
        eid = (entry.findtext(ATOM + 'id') or href or title).strip()

        """
        ★本文（content）から画像・動画の有無を見る。

        GAS 側の redditHasMotion_ は .json の media フィールドを見ていたが、
        RSS には無い。代わりに本文HTMLに埋まっているリンクの拡張子で見る。
        完全ではないが、テキストだけの投稿を落とすには足りる。
        """
        content = entry.findtext(ATOM + 'content') or ''
        has_media = bool(re.search(
            r'\.(mp4|gifv|gif|jpg|jpeg|png|webm)|v\.redd\.it|i\.redd\.it|imgur',
            content, re.I))

        out.append({
            'id': eid,
            'title': title,
            'url': href,
            'subreddit': sub,
            # ★RSS には score が無い。0 のままにして、GAS側で
            #   「スコア不明」と分かるようにする。嘘の数字を入れない
            'views': 0,
            'has_media': has_media,
            'source': 'rss',
        })

    log('  r/%s: %d件' % (sub, len(out)))
    return out


def is_usable_title(title, sub):
    """
    見出しとして使えるか。

    ★★2026-08-26、実データを見て追加した。

    r/anime_irl は画像だけを投げる板で、タイトルが板名の使い回しになる。
    実際にこう取れた。

        r/anime_irl  anime_irl
        r/anime_irl  anime_irl
        r/anime_irl  Anime_irl

    これを材料に渡しても、LLMは書く材料が無いので在庫映像の説明へ戻る。
    材料0件を直したのに、中身が空では意味がない。
    """
    t = (title or '').strip()
    if len(t) < 20:
        return False
    # 板名そのもの（大文字小文字・アンダースコアの違いは無視）
    norm = lambda x: x.lower().replace('_', '').replace(' ', '')
    if norm(t) == norm(sub):
        return False
    return True


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'data/topics.json'

    accounts = {}
    total = 0
    for key, subs in SUBS.items():
        log('[%s] %d板' % (key, len(subs)))
        got = []
        seen = set()
        for idx, sub in enumerate(subs):
            # ★2板目以降は必ず間隔を空ける（上の SLEEP_BETWEEN 参照）
            if idx:
                time.sleep(SLEEP_BETWEEN)
            for c in fetch_sub(sub):
                if c['id'] in seen:
                    continue
                # ★見出しが板名の使い回しなど、材料にならないものを落とす
                if not is_usable_title(c['title'], c['subreddit']):
                    continue
                seen.add(c['id'])
                got.append(c)

        """
        ★メディアがある投稿を先に並べる。

        GAS 側は動画を添付する前提で材料を選ぶ。テキストだけの投稿を
        上位に置くと、題材と映像が噛み合わない元の問題へ戻る。
        """
        got.sort(key=lambda c: (0 if c['has_media'] else 1))
        accounts[key] = got[:MAX_PER_ACCOUNT]
        total += len(accounts[key])
        log('[%s] → %d件を採用（見出しが使えないものは除外済み）'
            % (key, len(accounts[key])))

    """
    ★★片方が空でも書き出す（2026-08-26）。

    初回実行では A が5件、B が0件（全板429）になった。ここで
    「全体が0件でなければOK」とすると、B が空のまま上書きされ、
    B は材料無しの状態が続く。

    かといって全体を捨てると A の5件まで失う。
    片方だけ空なら、そのアカウントは前回ぶんを残す。
    """
    if total == 0:
        # ★空のファイルで上書きしない。前回ぶんが残っていた方がまだ役に立つ
        log('1件も取れませんでした。ファイルは更新しません。')
        return 1

    prev = {}
    if os.path.exists(out_path):
        try:
            prev = (json.load(open(out_path, encoding='utf-8'))
                    .get('accounts') or {})
        except Exception:
            prev = {}
    for key in list(accounts):
        if not accounts[key] and prev.get(key):
            accounts[key] = prev[key]
            log('[%s] 今回0件のため前回ぶん %d件 を維持します。'
                % (key, len(accounts[key])))

    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    payload = {
        'generated_at': datetime.datetime.now(
            datetime.timezone.utc).isoformat(timespec='seconds'),
        '_note': ('Reddit の公開RSSから取得。未認証の .json API は '
                  '2026-05-28 に廃止されたが RSS は応答する。'
                  'RSS には score が無いため views は常に0。'
                  'GAS 側はこれをスコア足切りの対象外として扱うこと。'),
        'accounts': accounts,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    log('書き出しました: %s (%d件)' % (out_path, total))
    return 0


if __name__ == '__main__':
    sys.exit(main())
