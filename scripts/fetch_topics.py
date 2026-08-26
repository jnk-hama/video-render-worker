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
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

# GAS の BUZZ_SUBS と揃えてある（33_BuzzSource.gs）。
# ここを変えたら向こうも変える必要はない（GASは受け取るだけ）。
SUBS = {
    'A': ['nextfuckinglevel', 'Damnthatsinteresting', 'BeAmazed',
          'WinStupidPrizes', 'Unexpected', 'holdmybeer',
          'toptalent', 'interestingasfuck', 'ContagiousLaughter'],
    'B': ['Animemes', 'awwnime', 'anime_irl',
          'AnimeSakuga', 'animegifs', 'cosplay', 'streetwear'],
}

# 1アカウントあたり何件まで残すか。GAS 側は上位10件しか見ないので、
# それより少し多めに持たせておく。
MAX_PER_ACCOUNT = 15

# 1板あたり何件取るか
PER_SUB = 5

# ★UA を名乗る。名乗らないリクエストは 429 を返されやすい
UA = 'jmas-topic-fetcher/1.0 (+https://github.com/jnk-hama/video-render-worker)'

TIMEOUT = 20

ATOM = '{http://www.w3.org/2005/Atom}'


def log(msg):
    print(msg, flush=True)


def fetch_sub(sub):
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


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'data/topics.json'

    accounts = {}
    total = 0
    for key, subs in SUBS.items():
        log('[%s] %d板' % (key, len(subs)))
        got = []
        seen = set()
        for sub in subs:
            for c in fetch_sub(sub):
                if c['id'] in seen:
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
        log('[%s] → %d件を採用' % (key, len(accounts[key])))

    if total == 0:
        # ★空のファイルで上書きしない。前回ぶんが残っていた方がまだ役に立つ
        log('1件も取れませんでした。ファイルは更新しません。')
        return 1

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
