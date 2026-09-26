#!/usr/bin/env python3
"""
商品1つから、マリーの動画を最後まで作る（決定#182）。
  計画（shot_plan）→ カットごとに Veo を起動（video-scene）→ 回収 → 描画の依頼（render_job.json）

★Veo は有料（$0.05/秒・月$50の蓋は video-scene 側 #155）。ここは決まった本数しか起動しない。
  作り直しは「音声フィルタで止まった回（Google は課金しない）」だけ、1回まで。
★鍵は環境変数から読み、ログへ出さない。依頼の中身（セリフ・URL）も公開ログへ全文は出さない。

使い方（Actions）: python3 scripts/marie_video.py product.json render_job.json [--dry-run]
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shot_plan  # noqa: E402

START_GAP_SEC = 25     # 起動の間隔。まとめて叩くと 429（E-031）
POLL_SEC = 30
POLL_TIMEOUT_SEC = 900
RETRY_FILTERED = 1     # 音声フィルタ（課金されない）で止まった回の作り直し回数


def _base_and_key():
    def clean(v, allowed):
        return ''.join(c for c in (v or '') if re.match(allowed, c))
    base = clean(os.environ.get('SUPABASE_URL'), r'[A-Za-z0-9:/._-]').rstrip('/')
    if not base.startswith('http'):
        base = 'https://%s' % base.lstrip('/')
    key = clean(os.environ.get('SUPABASE_SERVICE_ROLE_KEY'), r'[A-Za-z0-9._-]')
    if not key or 'supabase' not in base:
        raise SystemExit('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がありません（未設定なら止める）')
    return base, key


def _req(url, key, body=None, method=None):
    hdr = {'Authorization': 'Bearer %s' % key, 'apikey': key, 'Content-Type': 'application/json'}
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, headers=hdr, method=method or ('POST' if data else 'GET'))
    try:
        with urllib.request.urlopen(r, timeout=150) as res:
            return res.status, json.loads(res.read().decode() or 'null')
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read()[:400].decode('utf-8', 'replace')}


def start_cut(base, key, product, cut):
    body = {'action': 'start', 'genre': product.get('library_genre') or product.get('genre'),
            'product_key': product['product_key'], 'person_url': cut['still_url'],
            'animate_still': True, 'seconds': cut['seconds'], 'speech_style': 'natural',
            'speech': cut['line'], 'situations': [cut['action']]}
    code, res = _req('%s/functions/v1/video-scene' % base, key, body)
    started = (res or {}).get('started') or []
    if code != 200 or not started:
        # ★429（1日の上限・E-031）/ 402（前払い残高・E-028）は待っても直らない。止めて知らせる
        raise SystemExit('Veo を起動できません（%s・%s）: %s' % (
            cut['role'], cut.get('feature'), json.dumps(res, ensure_ascii=False)[:300]))
    return started[0]['id']


def rows(base, key, ids):
    q = '%s/rest/v1/video_library?select=id,status,video_url,reviewed_note&id=in.(%s)' % (
        base, ','.join(str(i) for i in ids))
    _code, res = _req(q, key)
    return {r['id']: r for r in (res or [])}


def wait_all(base, key, ids):
    t0 = time.time()
    while True:
        _req('%s/functions/v1/video-scene' % base, key, {'action': 'fetch_pending'})
        got = rows(base, key, ids)
        done = {i: r for i, r in got.items() if r.get('video_url') or r.get('status') == 'rejected'}
        print('  回収 %d/%d' % (len(done), len(ids)), flush=True)
        if len(done) == len(ids):
            return got
        if time.time() - t0 > POLL_TIMEOUT_SEC:
            raise SystemExit('Veo の回収が %d 秒で終わりません（残り %s）' % (
                POLL_TIMEOUT_SEC, [i for i in ids if i not in done]))
        time.sleep(POLL_SEC)


def main():
    product = json.load(open(sys.argv[1], encoding='utf-8'))
    out_path = sys.argv[2]
    dry = '--dry-run' in sys.argv
    plan = shot_plan.plan(product)
    print('カット計画（%d本）:' % len(plan['cuts']))
    for i, c in enumerate(plan['cuts']):
        print('  %d. %-7s %-10s %s' % (i + 1, c['role'], c['still'], c.get('feature') or ''))
    if plan['cards_only']:
        print('  カードだけ（絵にしない）: %s' % ' / '.join(plan['cards_only']))
    print('Veo の見積り: $%.2f' % (sum(c['seconds'] for c in plan['cuts']) * 0.05))
    if dry:
        return
    base, key = _base_and_key()
    ids = []
    for i, c in enumerate(plan['cuts']):
        if i:
            time.sleep(START_GAP_SEC)
        ids.append(start_cut(base, key, product, c))
    got = wait_all(base, key, ids)
    for attempt in range(RETRY_FILTERED):
        # ★音声フィルタで止まった回は Google が課金しない（返答に明記）。1回だけ作り直す
        bad = [k for k, i in enumerate(ids) if not got[i].get('video_url')]
        if not bad:
            break
        print('音声フィルタ等で止まったカット %s を作り直します' % [k + 1 for k in bad])
        for n, k in enumerate(bad):
            if n:
                time.sleep(START_GAP_SEC)
            ids[k] = start_cut(base, key, product, plan['cuts'][k])
        got.update(wait_all(base, key, [ids[k] for k in bad]))
    missing = [k + 1 for k, i in enumerate(ids) if not got[i].get('video_url')]
    if missing:
        raise SystemExit('作れなかったカット: %s（%s）' % (
            missing, [str(got[ids[k - 1]].get('reviewed_note') or '')[:120] for k in missing]))
    path = 'preview/marie-%s-auto.mp4' % re.sub(r'[^a-z0-9-]', '-', product['product_key'].lower())
    job = shot_plan.render_job(product, plan, [got[i]['video_url'] for i in ids], path)
    json.dump(job, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False)
    print('描画の依頼を作りました: %s（%d カット）' % (path, len(ids)))


if __name__ == '__main__':
    main()
