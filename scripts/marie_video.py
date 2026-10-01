#!/usr/bin/env python3
"""
商品1つから、マリーの動画を最後まで作る（決定#182）。
  計画（shot_plan）→ カットごとに Veo を起動（video-scene）→ 回収 → 描画の依頼（render_job.json）

★Veo は有料（$0.05/秒・月$50の蓋は video-scene 側 #155）。ここは決まった本数しか起動しない。
  作り直しは1カットにつき1回まで。対象は「音声フィルタで止まった回（Google は課金しない）」と、
  「セリフが言っている絵（must_show）が映っていないと判定された回」（#185）。
  それでも合格しないカットは止めずに、試した中の使える物か、承認済みの静止画で埋めて描く（#230）。
  問題は LINE の承認依頼に書き、オーナーが見て決める。判定は承認ではない（#068）。
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
    return cut['action'] + shot_plan.gendered(NO_NE, cut.get('persona'))


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
        # ★止めない（#230・オーナー「停止という概念がおかしい。お金かけてるんだぞ」）。
        #   起動できないカットは「動画なし」として扱い、最後に承認済みの静止画で埋める（Veo は起動していないので費用は出ていない）
        print('  Veo を起動できません（%s・%s・HTTP %s）: %s' % (
            cut['role'], (cut.get('feature') or '').split('\n')[0], code, why))
        return None
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
    ids = [i for i in ids if i is not None]
    if not ids:
        return {}
    q = '%s/rest/v1/video_library?select=id,status,video_url,reviewed_note&id=in.(%s)' % (
        base, ','.join(str(i) for i in ids))
    _code, res = _req(q, key)
    return {r['id']: r for r in (res or [])}


def verify_cut(base, key, video_url, must_show, demo=False):
    """
    must_show が映っているか（1/0）と、何と言ったか（said）。must_show が空なら喋りだけを取る（#189）。
    demo（実演のカット）は、最初と最後を比べた travel / debris も選ばせる（#239）。
    呼べない・読めない時は止める（未設定なら閉じる・#185）
    """
    body = {'action': 'verify', 'video_url': video_url, 'must_show': must_show or ''}
    if demo:
        body['demo'] = True
    code, res = _req('%s/functions/v1/video-scene' % base, key, body)
    if code != 200 or (res or {}).get('match') not in (0, 1):
        raise SystemExit('絵の照合を呼べません（%s）: %s' % (code, json.dumps(res, ensure_ascii=False)[:300]))
    # ★判定は毎回ログへ残す（朝の報告と、判定の当たり外れの記録に使う・#185）
    print('  照合 %s: %s（%s）／喋り「%s」／手 %s' % ('OK' if res['match'] else 'NG', (must_show or '（絵の問いなし）')[:60],
                                         str(res.get('seen') or '')[:100], str(res.get('said') or '')[:60], res.get('hands')))
    if demo:
        print('    実演: travel %s／debris %s' % (res.get('travel'), res.get('debris')))
    # ★手の本数も同じ判定で数える（#231）。読めない時は None（判定しない）
    return (res['match'], str(res.get('seen') or ''), str(res.get('said') or ''), res.get('hands'),
            {'travel': res.get('travel'), 'debris': res.get('debris')} if demo else None)


def demo_problem(d):
    """
    実演（吸い込む等）が映っていない所を返す（無ければ空・#239）。判定できなかった項目（None）は見ない。
    ★must_show の 1 だけでは通さない：ヘッドがほぼ動かずパン屑が全部残った動画を 1 で通した（RR35 本番）
    """
    if not d:
        return []
    out = []
    # ★short は通す（#247・大げさにしない＝往復で約30cm。最初と最後を比べる問いでは short と返る）
    if d.get('travel') == 'none':
        out.append('実演でヘッドがほとんど動いていない（travel=%s）' % d['travel'])
    if d.get('debris') in ('unchanged', 'no_debris'):
        out.append('ゴミが吸い込まれて消えていない（debris=%s）' % d['debris'])
    return out


# ★聞こえた喋りがセリフの何倍まで長ければ許すか（#197）。言い淀み・言い足しで伸びた喋りを止める。
#   実測（2026-09-27）：通すべき物は 1.07〜1.43 倍、「うん、ね、これね、ね、片手で持てる軽さね、マジで楽だよね。あ」は 2.25 倍
SAID_MAX_RATIO = 1.6


# ★生成クリップの顔（#215）。Veo は静止画の人物を保たないことがある（一人称の絵から別人が正面で喋った）。
#   描く前に数コマ抜いて face_score で見る：一人称のカットは顔が出たら不合格、それ以外はマリーでない顔が出たら不合格。
#   顔が映らないコマ（横を向いた等）は落とさない（見えない物は判定しない）
FACE_FRAMES = 6
# ★見えてよい手の数（#231）。一人称は片手がスマホなので1本、それ以外は2本（3本目は生成の破綻・#216）
MAX_HANDS = 2
MAX_HANDS_POV = 1


def hand_problem(n, pov):
    """数えた手の本数 n が多すぎれば理由の文、よければ None（数えられない None は判定しない）"""
    limit = MAX_HANDS_POV if pov else MAX_HANDS
    if n is None or n <= limit:
        return None
    return ('一人称なのに手が%d本（片手はスマホのはず）' % n) if pov else ('手が%d本映っている' % n)


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
        why = hand_problem(hand_score.count_hands(f), pov)
        if why:
            return '%s（%.1f秒）' % (why, at)
        s = face_score.score(f, refs)
        if s is None:
            continue
        if pov:
            return '一人称のカットに顔が映っている（%.1f秒）' % at
        if not s['passed']:
            return '本人（%s）ではない顔（%.1f秒・類似度 %.2f）' % (who, at, s['best'])
    return None


# ★誰が紹介するかは「商品を使う人の性別」で決める（#220・オーナー決定）。言語では分けない（日英どちらも同じ2人）。
#   product_json の persona が最優先、無ければ target から引く。どちらも無ければマリー（従来どおり）。
#   男女兼用（unisex）は、ガジェット・家電（genre=gadget）ならヒロ、それ以外はマリー（#221・オーナー決定「B」）。
#   ただし家事の道具（キッチン用品・掃除機など＝category）はガジェットでもマリー（#222・オーナー「キッチン用品や掃除機などはマリーの方がいい」）
TARGET_PERSONA = {'women': 'marie', 'men': 'hiro'}
UNISEX_BY_GENRE = {'gadget': 'hiro'}
HOUSEWORK = {'kitchen', 'cleaning', 'laundry'}


def persona_of(product):
    if product.get('persona'):
        return product['persona']
    target = product.get('target')
    if target == 'unisex':
        if product.get('category') in HOUSEWORK:
            return 'marie'
        return UNISEX_BY_GENRE.get(product.get('genre'), 'marie')
    if target and target not in TARGET_PERSONA:
        raise SystemExit('target は women / men / unisex のどれか: %r' % target)
    return TARGET_PERSONA.get(target, 'marie')


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


def issues_of(cut, row, verify, lang='ja', face=None):
    """
    1本のクリップの問題を (絵の問題, 喋りの問題) に分けて返す（#230）。
    絵の問題（動画なし・絵がセリフと合わない・顔/手）はそのクリップの映像を使えない。
    喋りの問題（丁寧語・言い換え・言い淀み・ね・台本違い）は映像は使える（オーナーが LINE で見て決める）
    """
    url = (row or {}).get('video_url')
    if not url:
        return ['フィルタ等で動画なし'], []
    try:
        r = verify(url, cut.get('must_show'), True) if cut.get('demo') else verify(url, cut.get('must_show'))
        match, seen, said = r[:3]
        hands = r[3] if len(r) > 3 else None
        demo = r[4] if len(r) > 4 else None
    except SystemExit as e:
        # ★照合が呼べない時も止めない。確かめられなかったことを LINE に書く（オーナーが目で見る）
        return [], ['照合できず（%s）' % str(e)[:80]]
    visual, speech = [], []
    if not match:
        visual.append('絵がセリフと合わない（映っていた物: %s）' % seen[:120])
    visual += demo_problem(demo)
    why_hands = hand_problem(hands, is_pov(cut))
    if why_hands:
        visual.append(why_hands)
    if speech_qa.ends_polite(said, lang):
        speech.append('言い終わりが丁寧語（「%s」）' % said[:60])
    miss = [w for w in shot_plan.says(cut) if speech_qa._norm(w, lang) not in speech_qa._norm(said, lang)]
    if miss:
        speech.append('「%s」と言っていない（「%s」）' % ('」「'.join(miss), said[:60]))
    if len(speech_qa._norm(said, lang)) > SAID_MAX_RATIO * len(speech_qa._norm(cut['line'], lang)):
        speech.append('言い淀み・言い足しが多い（「%s」）' % said[:60])
    if lang == 'ja' and extra_ne(cut['line'], said) > EXTRA_NE_MAX:
        speech.append('「ね」を足しすぎ（%d回・「%s」）' % (extra_ne(cut['line'], said), said[:60]))
    if speech_qa.script_match(cut['line'], said, lang) < speech_qa.SCRIPT_MATCH_MIN:
        speech.append('台本と大きく違う（「%s」）' % said[:60])
    if face and not visual:
        why = face(url, is_pov(cut))
        if why:
            visual.append(why)
    return visual, speech


def redo_targets(cuts, got, ids, verify, lang='ja', face=None):
    """
    作り直すカット番号と理由。動画が無い＝フィルタ、must_show が映っていない＝絵のずれ、
    言い終わりが丁寧語＝Veo の「です」足し（#189。描画側で切れない時に動画ごと止まるので、ここで作り直す）、
    言うべき語（must_say）が聞こえない＝Veo がセリフを言い換えた（#193。「抜け感出せる」が「座ったら…」になり、
    切れた喋りのまま描かれた）。描画側の検査も must_say で止めるので、描く前に作り直す方が安い
    """
    out = {}
    for k, i in enumerate(ids):
        visual, speech = issues_of(cuts[k], got.get(i) if i is not None else None, verify, lang, face)
        # 理由の並びは従来どおり（動画なし・絵 → 喋り → 顔）
        head = [v for v in visual if '顔' not in v and '手が' not in v]
        tail = [v for v in visual if v not in head]
        why = (head + speech + tail)[:1]
        if why:
            out[k] = why[0]
    return out


def choose(cut, tried, got, verify, lang='ja', face=None):
    """
    作り直した後の、1カットの使い道（#230・止めない）。tried は古い順の id（None＝起動できなかった）。
    @return (映像の id か None, 声の id か None, 問題の説明のリスト)
      1. 問題の無いクリップ → そのまま
      2. 喋りだけの問題 → 映像も声もそのクリップ（問題はオーナーへ書く）
      3. 映像が使えないが声は合っている → 承認済みの静止画を動かし、声だけそのクリップから当てる
      4. どれも無い → 承認済みの静止画だけ（無音・カードは出る）
    """
    judged = [(i, issues_of(cut, got.get(i) if i is not None else None, verify, lang, face)) for i in tried]
    for i, (v, sp) in reversed(judged):
        if not v and not sp:
            return i, i, []
    speech_only = [(i, sp) for i, (v, sp) in judged if not v]
    if speech_only:
        i, sp = min(reversed(speech_only), key=lambda x: len(x[1]))
        return i, i, sp
    voice_ok = [(i, v) for i, (v, sp) in judged if not sp and (got.get(i) or {}).get('video_url')]
    if voice_ok:
        i, v = voice_ok[-1]
        return None, i, ['映像を静止画に差し替え（%s）' % v[0]]
    last = next(((v + sp) for i, (v, sp) in reversed(judged)), ['Veo を起動できず'])
    return None, None, ['静止画だけ・声なし（%s）' % (last[0] if last else 'Veo を起動できず')]


# ★外すカットの喋りの問題（#246）。別の声に替えない（keep_voice）ので、台本と違うことを言ったカットは使わない。
#   「ね」の足しすぎ・言い終わりの丁寧語は軽い（描画が切る・#189）ので残す
SEVERE_SPEECH = ('台本と大きく違う', 'と言っていない', '言い淀み')
# 外した後に残すカットの下限。これ未満なら喋りの問題があるカットも戻す（静止画では埋めない）
MIN_KEEP_CUTS = 2


def keep_cuts(plan, picks, features):
    """
    描画に使うカットを選ぶ（#246・オーナー「1シーン目の静止画いらない」「マリーじゃないのが喋ってる」）。
    ★静止画で埋めない（#230 の埋め方をやめる）：映像の無いカットと、台本と違うことを言ったカットを外す。
      外したカットの性能は最後のまとめへ回す（summary_topics）。パネルは残った最後のカットへ付け直す
    @return (計画, picks, 外したカットの説明)。1つも残らなければ SystemExit
    """
    def severe(ns):
        return any(w in n for n in ns for w in SEVERE_SPEECH)
    keep = [k for k, (v, _a, ns) in enumerate(picks) if v is not None and not severe(ns)]
    if len(keep) < MIN_KEEP_CUTS:
        keep = [k for k, (v, _a, _n) in enumerate(picks) if v is not None]
    if not keep:
        raise SystemExit('使える映像が1カットもありません（静止画では埋めない・#246）')
    dropped = ['カット%d を外しました（%s）' % (k + 1, '・'.join(picks[k][2]) or '映像なし')
               for k in range(len(picks)) if k not in keep]
    cuts = [plan['cuts'][k] for k in keep]
    out = dict(plan, cuts=cuts)
    if plan.get('panel'):
        out['panel'] = dict(plan['panel'], cut_index=len(cuts) - 1)
        if 'topics' in plan['panel']:
            out['panel']['topics'] = shot_plan.summary_topics(features, cuts)
    return out, [picks[k] for k in keep], dropped


def still_look(base, key, url, parts=()):
    """静止画を video-scene の verify（Gemini）で1回見る → (手の本数, 握り方 dict か None)。
    parts（握る所の選択肢・先頭が正・#237）を渡すと、どこを・どう握っているかを選ばせる。見られなければ (None, None)。
    ★1回の呼び出しで両方取る（判定も有料）"""
    body = {'action': 'verify', 'image_url': url, 'must_show': ''}
    if parts:
        body['grip_parts'] = list(parts)
    code, res = _req('%s/functions/v1/video-scene' % base, key, body)
    if code != 200:
        print('  静止画を判定できません（HTTP %s）: %s' % (code, json.dumps(res, ensure_ascii=False)[:200]))
        return None, None
    ergo = {k: res.get(k) for k in ('held_part', 'grip', 'wrist', 'anatomy')} if parts else None
    return res.get('hands'), ergo


# ★人間工学の規則（決定#237）。重い道具（掃除機 1.6kg）を片手で操るなら、手のひらで包む（power）か、
#   かばんのように上から提げる（hook）。指先でつまむ（pinch）・手のひらで押すだけ（push）は落とす／持てない。
#   手首が大きく曲がった持ち方は長く続かない（掃除機の持ち手の研究で、手首の曲げ＝不快の主因）。
#   ★どちらの握りも通す＝柔軟性（オーナー OK の id99 は power、オーナーが普通と言ったかばん持ちは hook）
# ★実物で合わせた（2026-09-30・RR35 の5枚）：オーナー OK の id99＝持ち手・power で通る。本体の下を握った id93＝held_part none で落ちる。
#   持ち手の端を握った id95 / id98（オーナー NG）は持ち手・power と返り、通る＝細かい位置は見抜けない（目視で落とす）。
#   hook と power の見分けは5枚とも power と返った（どちらも通すので合否には効かない）
ERGO_GRIPS_OK = ('power', 'hook')


def ergo_problem(ergo, parts):
    """握り方の答えから、人間工学的におかしい所を返す（無ければ空）。判定できなかった項目（None）は見ない"""
    if not ergo or not parts:
        return []
    out = []
    if ergo.get('anatomy') == 'distorted':
        out.append('手の形が崩れている（指の数・関節・物と溶け合う）')
    held = ergo.get('held_part')
    if held is not None and held != parts[0]:
        out.append('握っている所が %s（%s を握るはず）' % (held, parts[0]))
    grip = ergo.get('grip')
    if grip is not None and grip not in ERGO_GRIPS_OK:
        out.append('握り方が %s（重い道具は手のひらで包むか、かばんのように提げる）' % grip)
    if ergo.get('wrist') == 'bent':
        out.append('手首が不自然に曲がっている')
    return out


# ★本番の前の点検（#227 の自動化・#232）。顔の点がこれ未満の静止画は Veo に渡さない（暗い・小さい・横顔・寝転び・E-038）。
#   face_score の合否（0.42）より厳しい。Veo は静止画の顔を保ちきれないので、元の顔がはっきりしている物だけ使う
PREFLIGHT_FACE_MIN = 0.7


def still_face(persona):
    """静止画の顔の点（persona のマスターと比べる）。顔が見つからなければ None"""
    import face_score
    refs = face_score.reference_set(persona)

    def face(url):
        d = tempfile.mkdtemp(prefix='still_')
        path = os.path.join(d, 'still.jpg')
        urllib.request.urlretrieve(url, path)
        r = face_score.score(path, refs)
        return None if not r else r['best']
    return face


def preflight_stills(cuts, look, face):
    """
    本番の前に、使う静止画を全部機械で点検する（#227 を人の手順から機械へ・#232）。落ちたら Veo を起動せずに止める（費用なし）。
      一人称：手は1本まで（片手はスマホ・#231）・顔が映っていない
      それ以外：顔が見つかり、点が PREFLIGHT_FACE_MIN 以上・手は2本まで
      全部：絵の問い（must_show）がその絵の規則の物（E-037）
      握る所の選択肢（grip_parts）がある絵：正しい所を、無理のない握り方で握っている（#235・#237 ergo_problem）
    ★静止画から作る動画も、差し替えに使う静止画もその絵になるので、描いてから気づいても直せない。直すのは静止画。
    ★手と握り方は Gemini（verify）、顔は insightface（face_score）で見る。判定できない時（None）は判定しない。
    look(url, parts) → (本数 か None, 握り方 dict か None)／face(url) → 点 か None（顔なし）
    """
    def owners(ms, who):
        """その絵の問いを持つ規則の静止画キー（紹介者の代名詞に直して比べる）"""
        return {k for r in shot_plan.RULES if r.get('must_show') and shot_plan.gendered(r['must_show'], who) == ms
                for k in (r.get('still') or {})}
    bad, seen, faces = [], {}, {}
    for k, c in enumerate(cuts):
        url, parts = c['still_url'], tuple(c.get('grip_parts') or ())
        if (url, parts) not in seen:
            seen[(url, parts)] = look(url, parts)
        if url not in faces:
            faces[url] = face(url)
        (n, ergo), f = seen[(url, parts)], faces[url]
        pov = is_pov(c)
        print('  点検 カット%d（%s）: 手 %s／顔 %s%s' % (k + 1, c['still'], n, '—' if f is None else '%.3f' % f,
                                                  '／握り方 %s' % json.dumps(ergo, ensure_ascii=False) if parts else ''))
        why = [hand_problem(n, pov)] + ergo_problem(ergo, parts)
        if parts and (len(parts) > 8 or any(len(x) > 60 for x in parts)):  # ★verify が断る形。判定できないまま通さない
            why.append('握る所の選択肢が verify の制限を超える（8個・各60文字まで）。product の handle を短く')
        if pov and f is not None:
            why.append('一人称の静止画に顔が映っている（%.2f）' % f)
        if not pov and f is None:
            why.append('顔が見つからない')
        elif not pov and f < PREFLIGHT_FACE_MIN:
            why.append('顔の点が %.2f（%.1f 未満・暗い／小さい／横顔）' % (f, PREFLIGHT_FACE_MIN))
        ms = c.get('must_show')
        if ms and owners(ms, c.get('persona')) and c['still'] not in owners(ms, c.get('persona')):
            why.append('絵の問いがこの絵の物ではない（E-037）')
        bad += ['カット%d（%s）: %s' % (k + 1, c['still'], w) for w in why if w]
    if bad:
        raise SystemExit('静止画を直してください（Veo は起動していません・費用なし）: ' + '; '.join(bad))
    print('静止画の点検: 合格（%d枚）' % len(faces))


def wait_all(base, key, ids):
    ids = [i for i in ids if i is not None]
    if not ids:
        return {}
    t0 = time.time()
    while True:
        _req('%s/functions/v1/video-scene' % base, key, {'action': 'fetch_pending'})
        got = rows(base, key, ids)
        done = {i: r for i, r in got.items() if r.get('video_url') or r.get('status') == 'rejected'}
        print('  回収 %d/%d' % (len(done), len(ids)), flush=True)
        if len(done) == len(ids):
            return got
        if time.time() - t0 > POLL_TIMEOUT_SEC:
            # ★止めない（#230）。回収できなかったカットは動画なしとして静止画で埋める
            print('Veo の回収が %d 秒で終わりません（残り %s）。取れた分で進めます' % (
                POLL_TIMEOUT_SEC, [i for i in ids if i not in done]))
            return got
        time.sleep(POLL_SEC)


def main():
    product = json.load(open(sys.argv[1], encoding='utf-8'))
    out_path = sys.argv[2]
    dry = '--dry-run' in sys.argv
    plan = shot_plan.plan_long(product) if product.get('layout') == 'long' else shot_plan.plan(product)
    persona = persona_of(product)
    phone = product.get('look') == 'phone'
    for c in plan['cuts']:
        c['persona'] = persona
        c['action'] = shot_plan.gendered(c['action'], persona) + (shot_plan.PHONE_LOOK if phone else '')
        if c.get('must_show'):
            c['must_show'] = shot_plan.gendered(c['must_show'], persona)
    print('紹介者: %s' % persona)
    print('カット計画（%d本）:' % len(plan['cuts']))
    for i, c in enumerate(plan['cuts']):
        print('  %d. %-7s %-10s %s' % (i + 1, c['role'], c['still'], c.get('feature') or ''))
    if plan['cards_only']:
        print('  カードだけ（絵にしない）: %s' % ' / '.join(plan['cards_only']))
    print('Veo の見積り: $%.2f' % (sum(c['seconds'] for c in plan['cuts']) * 0.05))
    # ★予行でも本番と同じ点検を回す（予行＝#227 の点検そのもの。鍵が無い手元の試験では飛ばす）
    if dry and not os.environ.get('SUPABASE_SERVICE_ROLE_KEY'):
        print('静止画の点検: 鍵が無いので飛ばします（Actions の予行では必ず回る）')
        return
    base, key = _base_and_key()
    preflight_stills(plan['cuts'], lambda u, parts: still_look(base, key, u, parts), still_face(persona))
    if dry:
        return
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
            started += ids[-1] is not None
        print('Veo を起動したカット: %d / %d（残りは使い回し）' % (started, len(ids)))
    got = wait_all(base, key, ids)
    seen_before = {}  # ★同じ動画を2度判定しない（判定も有料）

    def verify(url, must_show, demo=False):
        if url not in seen_before:
            seen_before[url] = verify_cut(base, key, url, must_show, demo)
        return seen_before[url]

    face = make_face_check(persona)
    tried = [[i] for i in ids]  # カットごとに試したクリップ（古い順）。作り直しても前の物を捨てない（#230）

    # ★使い回して照合に落ちたカットは、作り直しの回数に数えずに新しく作る（新しく作った物には通常どおり作り直しが1回残る）
    if not reuse and reused:
        stale = {k: why for k, why in redo_targets(plan['cuts'], got, ids, verify, face=face).items() if k in reused}
        for n, (k, why) in enumerate(stale.items()):
            print('カット %d は使い回せません（%s）。新しく作ります' % (k + 1, why))
            if n:
                time.sleep(START_GAP_SEC)
            ids[k] = start_cut(base, key, product, plan['cuts'][k])
            tried[k] = [ids[k]]  # 使い回せなかった前のクリップは候補に残さない（静止画の前の物・言い方が古い）
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
            tried[k].append(ids[k])
        got.update(wait_all(base, key, [ids[k] for k in bad]))
    # ★★止めない（#230・オーナー「停止という概念がおかしい。絶対通せ。お金かけてるんだぞ」）。
    #   作り直しても合格しないカットは、試した中で一番ましな物を使い、映像が使えなければ承認済みの静止画で埋める。
    #   それでも「悪い動画を出さない」は崩れない：出来た動画は必ずオーナーが LINE で見て承認してから使う（#068・#191）。
    #   問題はカットごとに LINE へ書く
    picks = [choose(c, tried[k], got, verify, face=face) for k, c in enumerate(plan['cuts'])]
    plan, picks, dropped = keep_cuts(plan, picks, product['features'])
    notes = dropped + ['カット%d %s' % (k + 1, n) for k, (_v, _a, ns) in enumerate(picks) for n in ns]
    for n in notes:
        print('★' + n)
    path = 'preview/marie-%s-auto.mp4' % re.sub(r'[^a-z0-9-]', '-', product['product_key'].lower())
    urls = [got[v]['video_url'] for v, _a, _n in picks]
    used = [i for v, a, _n in picks for i in (v, a) if i is not None]
    ids_for_review = list(dict.fromkeys(used)) or [i for t in tried for i in t if i is not None]
    job = shot_plan.render_job(product, plan, urls, path, clip_ids=ids_for_review)
    if notes:
        job['job'].setdefault('review', {})['notes'] = notes
    if product.get('hold_review'):
        # ★LINE へ送る前に完成動画を点検する（jmas E-040・#246）。送るのは点検した後の send-review.yml
        job['job'].setdefault('review', {})['hold'] = True
    json.dump(job, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False)
    print('描画の依頼を作りました: %s（%d カット・外した %d）' % (path, len(picks), len(dropped)))


if __name__ == '__main__':
    main()
