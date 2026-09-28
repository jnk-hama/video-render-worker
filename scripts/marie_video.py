#!/usr/bin/env python3
"""
商品1つから、マリーの動画を最後まで作る（決定#182）。
  計画（shot_plan）→ カットごとに Veo を起動（video-scene）→ 回収 → 描画の依頼（render_job.json）

★Veo は有料（$0.05/秒・月$50の蓋は video-scene 側 #155）。ここは決まった本数しか起動しない。
  作り直しは1カットにつき1回まで。対象は「音声フィルタで止まった回（Google は課金しない）」と、
  「セリフが言っている絵（must_show）が映っていないと判定された回」（#185）。
  それでも映っていなければ描画の前で止める（嘘の絵を描かない）。判定は承認ではない（#068）。
★鍵は環境変数から読み、ログへ出さない。依頼の中身（セリフ・URL）も公開ログへ全文は出さない。

使い方（Actions）: python3 scripts/marie_video.py product.json render_job.json [--dry-run]
★product.json に reuse_ids（カット順の video_library の id）を入れると、Veo を起動せず手元のクリップで
  照合→描画までを通す（0円に近い試験・作り直しもしない）。本番の流れを初回で壊さないための口。
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shot_plan  # noqa: E402
import speech_qa  # noqa: E402

START_GAP_SEC = 25     # 起動の間隔。まとめて叩くと 429（E-031）
POLL_SEC = 30
POLL_TIMEOUT_SEC = 900
RETRY_PER_CUT = 1      # 1カットの作り直し回数（音声フィルタ・絵のずれを合わせて）


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
        # ★本文は JSON なら読んで返す。400字で切ると Veo の状態コードまで届かなかった（#215）
        raw = e.read()[:8000].decode('utf-8', 'replace')
        try:
            parsed = json.loads(raw)
            return e.code, parsed if isinstance(parsed, dict) else {'error': raw[:2000]}
        except ValueError:
            return e.code, {'error': raw[:2000]}


# ★語尾の「ね」を足させない（オーナー指摘 2026-09-24・2026-09-28「語尾にねが多すぎる」#217）。
#   自然な喋り（speech_style=natural・#176）は言い換えとつなぎ言葉を許すので、Veo が全カットに「ね」を足した。
#   video-scene のプロンプトを直すにはデプロイが要る（10/1まで不可）ので、場面の説明の末尾で伝える
NO_NE = (" In her speech she never adds the sentence particle ne (ね) or yo ne (よね) anywhere,"
         " and adds no filler words beyond the line.")
EXTRA_NE_MAX = 1   # 台本に無い「ね」は1回まで。2回以上は作り直す


def situation_text(cut):
    """Veo へ渡す場面の説明（使い回しの照合にも同じ文を使う）"""
    return cut['action'] + NO_NE


def extra_ne(line, said):
    return said.count('ね') - line.count('ね')


def start_cut(base, key, product, cut):
    body = {'action': 'start', 'genre': product.get('library_genre') or product.get('genre'),
            'product_key': product['product_key'], 'person_url': cut['still_url'],
            'animate_still': True, 'seconds': cut['seconds'], 'speech_style': 'natural',
            'speech': cut['line'], 'situations': [situation_text(cut)]}
    code, res = _req('%s/functions/v1/video-scene' % base, key, body)
    started = (res or {}).get('started') or []
    if code != 200 or not started:
        # ★429（1日の上限・E-031）/ 402（前払い残高・E-028）は待っても直らない。止めて知らせる
        # ★状態と本文を先に出す。場面の説明（長い）から出すと 300 字で切れて理由が読めなかった（#215）
        errs = (res or {}).get('errors') or []
        why = '; '.join('HTTP %s %s' % (e.get('status'), str(e.get('body') or '')[:400]) for e in errs) \
            or json.dumps(res, ensure_ascii=False)[:400]
        raise SystemExit('Veo を起動できません（%s・%s・HTTP %s）: %s' % (
            cut['role'], (cut.get('feature') or '').split('\n')[0], code, why))
    return started[0]['id']


# 静止画のファイル名の頭は作った時刻（ミリ秒）。product-scene の保存名（例: 1790490103321-293fa7e9.jpg）
STILL_TIME = re.compile(r'/(\d{13})-[0-9a-f]{8}\.[a-z]+$')


def find_reusable(base, key, product, cut):
    """
    前に作った同じカット（同じ商品・同じ動きの指示・その静止画ができた後に作った物）の id。無ければ None（#198）。
    ★合格したカットを作り直さない（オーナー「自然に使い回せるならあり」）。Veo は秒で課金されるので、使い回した分がそのまま浮く。
    ★video_library には元の静止画が残らない。代わりに「静止画の作成時刻より後の物だけ」を拾う。静止画を差し替えれば古いクリップは拾わない。
      作成時刻が読めない静止画は使い回さない（取り違えるより作る方が安全）。
    ★拾った物も、新しく作った物と同じ照合（映る物・言うべき語・丁寧語・言い淀み）を通す。落ちれば新しく作る。
    """
    m = STILL_TIME.search(cut.get('still_url') or '')
    if not m:
        return None
    since = datetime.fromtimestamp(int(m.group(1)) / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    q = urllib.parse.urlencode({
        'select': 'id', 'product_key': 'eq.%s' % product['product_key'],
        'situation': 'eq.%s' % situation_text(cut)[:500], 'status': 'neq.rejected',
        'video_url': 'not.is.null', 'created_at': 'gte.%s' % since, 'order': 'id.desc', 'limit': '1'})
    code, res = _req('%s/rest/v1/video_library?%s' % (base, q), key)
    return res[0]['id'] if code == 200 and isinstance(res, list) and res else None


def rows(base, key, ids):
    q = '%s/rest/v1/video_library?select=id,status,video_url,reviewed_note&id=in.(%s)' % (
        base, ','.join(str(i) for i in ids))
    _code, res = _req(q, key)
    return {r['id']: r for r in (res or [])}


def verify_cut(base, key, video_url, must_show):
    """
    must_show が映っているか（1/0）と、何と言ったか（said）。must_show が空なら喋りだけを取る（#189）。
    呼べない・読めない時は止める（未設定なら閉じる・#185）
    """
    code, res = _req('%s/functions/v1/video-scene' % base, key,
                     {'action': 'verify', 'video_url': video_url, 'must_show': must_show or ''})
    if code != 200 or (res or {}).get('match') not in (0, 1):
        raise SystemExit('絵の照合を呼べません（%s）: %s' % (code, json.dumps(res, ensure_ascii=False)[:300]))
    # ★判定は毎回ログへ残す（朝の報告と、判定の当たり外れの記録に使う・#185）
    print('  照合 %s: %s（%s）／喋り「%s」' % ('OK' if res['match'] else 'NG', (must_show or '（絵の問いなし）')[:60],
                                         str(res.get('seen') or '')[:100], str(res.get('said') or '')[:60]))
    return res['match'], str(res.get('seen') or ''), str(res.get('said') or '')


# ★聞こえた喋りがセリフの何倍まで長ければ許すか（#197）。言い淀み・言い足しで伸びた喋りを止める。
#   実測（2026-09-27）：通すべき物は 1.07〜1.43 倍、「うん、ね、これね、ね、片手で持てる軽さね、マジで楽だよね。あ」は 2.25 倍
SAID_MAX_RATIO = 1.6


# ★生成クリップの顔（#215）。Veo は静止画の人物を保たないことがある（一人称の絵から別人が正面で喋った）。
#   描く前に数コマ抜いて face_score で見る：一人称のカットは顔が出たら不合格、それ以外はマリーでない顔が出たら不合格。
#   顔が映らないコマ（横を向いた等）は落とさない（見えない物は判定しない）
FACE_FRAMES = 6


def is_pov(cut):
    return str(cut.get('action') or '').startswith('First-person')


def face_problem(url, pov, refs, who='marie'):
    import face_score
    import hand_score
    d = tempfile.mkdtemp(prefix='clip_')
    path = os.path.join(d, 'clip.mp4')
    urllib.request.urlretrieve(url, path)
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                               capture_output=True, text=True, check=True).stdout.strip() or 0)
    for i in range(FACE_FRAMES):
        at = dur * (i + 0.5) / FACE_FRAMES
        f = os.path.join(d, 'f%02d.jpg' % i)
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', '%.3f' % at, '-i', path, '-frames:v', '1', f], check=True)
        n = hand_score.count_hands(f)
        if n is not None and n > 2:
            return '手が%d本映っている（%.1f秒）' % (n, at)
        s = face_score.score(f, refs)
        if s is None:
            continue
        if pov:
            return '一人称のカットに顔が映っている（%.1f秒）' % at
        if not s['passed']:
            return '本人（%s）ではない顔（%.1f秒・類似度 %.2f）' % (who, at, s['best'])
    return None


def make_face_check(persona=None):
    """
    クリップの顔の判定（同じ動画を2度見ない）。マスターは初回に読む。読めなければ止まる（未設定なら閉じる）。
    persona は product_json の "persona"（無ければマリー・#218）。知らない名前は face_score が止める
    """
    import face_score
    who = persona or face_score.DEFAULT_PERSONA
    state = {}

    def face(url, pov):
        if 'refs' not in state:
            state['refs'] = face_score.reference_set(who)
        if (url, pov) not in state:
            state[(url, pov)] = face_problem(url, pov, state['refs'], who)
            print('  顔 %s: %s' % ('NG' if state[(url, pov)] else 'OK', state[(url, pov)] or ('一人称・顔なし' if pov else who)))
        return state[(url, pov)]
    return face


def redo_targets(cuts, got, ids, verify, lang='ja', face=None):
    """
    作り直すカット番号と理由。動画が無い＝フィルタ、must_show が映っていない＝絵のずれ、
    言い終わりが丁寧語＝Veo の「です」足し（#189。描画側で切れない時に動画ごと止まるので、ここで作り直す）、
    言うべき語（must_say）が聞こえない＝Veo がセリフを言い換えた（#193。「抜け感出せる」が「座ったら…」になり、
    切れた喋りのまま描かれた）。描画側の検査も must_say で止めるので、描く前に作り直す方が安い
    """
    out = {}
    for k, i in enumerate(ids):
        url = got[i].get('video_url')
        if not url:
            out[k] = 'フィルタ等で動画なし'
            continue
        match, seen, said = verify(url, cuts[k].get('must_show'))
        if not match:
            out[k] = '絵がセリフと合わない（映っていた物: %s）' % seen[:120]
        elif speech_qa.ends_polite(said, lang):
            out[k] = '言い終わりが丁寧語（「%s」）' % said[:60]
        elif any(speech_qa._norm(w, lang) not in speech_qa._norm(said, lang) for w in shot_plan.says(cuts[k])):
            miss = [w for w in shot_plan.says(cuts[k]) if speech_qa._norm(w, lang) not in speech_qa._norm(said, lang)]
            out[k] = '「%s」と言っていない（「%s」）' % ('」「'.join(miss), said[:60])
        elif len(speech_qa._norm(said, lang)) > SAID_MAX_RATIO * len(speech_qa._norm(cuts[k]['line'], lang)):
            out[k] = '言い淀み・言い足しが多い（「%s」）' % said[:60]
        elif lang == 'ja' and extra_ne(cuts[k]['line'], said) > EXTRA_NE_MAX:
            out[k] = '「ね」を足しすぎ（%d回・「%s」）' % (extra_ne(cuts[k]['line'], said), said[:60])
        elif speech_qa.script_match(cuts[k]['line'], said, lang) < speech_qa.SCRIPT_MATCH_MIN:
            out[k] = '台本と大きく違う（「%s」）' % said[:60]
        elif face:
            why = face(url, is_pov(cuts[k]))
            if why:
                out[k] = why
    return out


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
    plan = shot_plan.plan_long(product) if product.get('layout') == 'long' else shot_plan.plan(product)
    print('カット計画（%d本）:' % len(plan['cuts']))
    for i, c in enumerate(plan['cuts']):
        print('  %d. %-7s %-10s %s' % (i + 1, c['role'], c['still'], c.get('feature') or ''))
    if plan['cards_only']:
        print('  カードだけ（絵にしない）: %s' % ' / '.join(plan['cards_only']))
    print('Veo の見積り: $%.2f' % (sum(c['seconds'] for c in plan['cuts']) * 0.05))
    if dry:
        return
    base, key = _base_and_key()
    reuse = product.get('reuse_ids')
    reused = set()  # 前のクリップを使い回したカットの番号（#198）
    if reuse:
        if len(reuse) != len(plan['cuts']):
            raise SystemExit('reuse_ids は %d 本（カット数）必要です（%d 本）' % (len(plan['cuts']), len(reuse)))
        ids = [int(i) for i in reuse]
        print('手元のクリップを使います（Veo は起動しない）: %s' % ids)
    else:
        ids = []
        started = 0
        for c in plan['cuts']:
            rid = None if product.get('reuse') is False else find_reusable(base, key, product, c)
            if rid:
                print('  使い回し: %s（前のクリップ id=%s・照合は通し直す）' % (c['role'] + '/' + (c.get('feature') or '').split('\n')[0], rid))
                reused.add(len(ids))
                ids.append(rid)
                continue
            if started:
                time.sleep(START_GAP_SEC)
            ids.append(start_cut(base, key, product, c))
            started += 1
        print('Veo を起動したカット: %d / %d（残りは使い回し）' % (started, len(ids)))
    got = wait_all(base, key, ids)
    seen_before = {}  # ★同じ動画を2度判定しない（判定も有料）

    def verify(url, must_show):
        if url not in seen_before:
            seen_before[url] = verify_cut(base, key, url, must_show)
        return seen_before[url]

    face = make_face_check(product.get('persona'))

    # ★使い回して照合に落ちたカットは、作り直しの回数に数えずに新しく作る（新しく作った物には通常どおり作り直しが1回残る）
    if not reuse and reused:
        stale = {k: why for k, why in redo_targets(plan['cuts'], got, ids, verify, face=face).items() if k in reused}
        for n, (k, why) in enumerate(stale.items()):
            print('カット %d は使い回せません（%s）。新しく作ります' % (k + 1, why))
            if n:
                time.sleep(START_GAP_SEC)
            ids[k] = start_cut(base, key, product, plan['cuts'][k])
        if stale:
            got.update(wait_all(base, key, [ids[k] for k in stale]))

    for attempt in range(0 if reuse else RETRY_PER_CUT):
        bad = redo_targets(plan['cuts'], got, ids, verify, face=face)
        if not bad:
            break
        for k, why in bad.items():
            print('カット %d を作り直します: %s' % (k + 1, why))
        for n, k in enumerate(bad):
            if n:
                time.sleep(START_GAP_SEC)
            ids[k] = start_cut(base, key, product, plan['cuts'][k])
        got.update(wait_all(base, key, [ids[k] for k in bad]))
    # ★作り直した後も、動画が無い・絵が合わないカットがあれば描かずに止める
    still_bad = redo_targets(plan['cuts'], got, ids, verify, face=face)
    if still_bad:
        raise SystemExit('描画の前で止めました: %s' % '; '.join(
            'カット%d %s %s' % (k + 1, why, str(got[ids[k]].get('reviewed_note') or '')[:120])
            for k, why in still_bad.items()))
    path = 'preview/marie-%s-auto.mp4' % re.sub(r'[^a-z0-9-]', '-', product['product_key'].lower())
    job = shot_plan.render_job(product, plan, [got[i]['video_url'] for i in ids], path, clip_ids=ids)
    json.dump(job, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False)
    print('描画の依頼を作りました: %s（%d カット）' % (path, len(ids)))


if __name__ == '__main__':
    main()
