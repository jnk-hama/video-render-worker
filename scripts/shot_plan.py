#!/usr/bin/env python3
"""
商品ごとに「どのカットを、どの撮り方で、どの静止画から作るか」を決める（決定#182）。

★決まった規則で選ぶ（LLM に選ばせない。CLAUDE.md「確率で揺れる処理を持ち込まない」）。
★機能1つにカット1つ。同じ撮り方を続けない。自撮りだけにしない（#181・オーナー指摘）。
★売り文句は依頼の features（ASP・人が確かめた物）だけ。無い機能のカットは作らない（E-032）。
  規則に当たらない機能は、Veo を回さず情報カードにだけ出す（作れない絵を無理に作らない）。

静止画の種類（stills のキー）:
  selfie     片手にスマホの自撮り。空いている手は1本 → 生地を引く・袖で手を隠す・指さす まで
  free_hands 両手が空いた腰上〜全身 → フードを被る・ジップを開ける・ポケット
  hood       フードを被った状態の free_hands（あればフードのカットはこちらを優先）
  mirror     鏡越しの全身 → シルエット・サイズ感
  holding    商品を手に持った／使っている絵（ガジェット等）

使い方: python3 scripts/shot_plan.py product.json  → 計画（JSON）を標準出力へ
"""
import json
import re
import sys

HOOK_SECONDS = 6      # フックは言い切りが長い（実測 5.6秒）
CUT_SECONDS = 4       # 機能のカット。セリフは JA_CHARS_4S 文字まで
JA_CHARS_4S = 18      # 自然な喋りの実測 約4.5文字/秒 × 4秒（marie-redial-ja-v3 の実測）
MAX_FEATURE_CUTS = 4  # フック・CTA を除く。20秒前後に収める
SPEECH_SPEED = 1.15   # 喋りの速さ（オーナー「もう少し早く」#183）。render_video の上限は 1.3

"""
★規則表。上から順に当てる（先に当たった規則が勝つ）。
  still は優先順（左が第一候補）。action は静止画ごとに書く（同じ機能でも絵によって出来る動作が違う）。
  line は 18文字以下・タメ口・です/ます・？ 無し（video-scene が ？ を弾く）。
  実地で通った物（2026-09-26 の本番）を元にしている。
"""
RULES = [
    # ---- アパレル ----
    {'genres': ('apparel', 'hoodie'), 'match': r'ヴィンテージ|洗い|色落ち|ウォッシュ|加工', 'hook': True,
     'still': {'selfie': "She is filming herself on her phone at arm's length, glances down at the faded fabric "
                         "of the garment, tugs it slightly with her free hand, then looks back at the camera and "
                         "talks like she is telling a friend."},
     'line': '見て！この色落ち、えぐいくらいヴィンテージ感ある', 'must_say': '色落ち'},
    # ★「見てて」より「見て！」が自然（オーナー #183）。「見て、」だと Veo が「見てて」と伸ばした（9/26）ので ！ で言い切らせる
    {'genres': ('apparel', 'hoodie'), 'match': r'フード',
     'still': {'hood': "Waist-up. The big hood is already up over her head; she holds its edges with both hands, "
                       "gently tugs it forward so it frames her face, then smiles and talks to the viewer like a friend.",
               'free_hands': "Waist-up. She pulls the big hood up over her head with both hands so it frames her "
                             "face, then smiles and talks to the viewer like a friend."},
     'line': 'フードが大きいから、頭まで隠れる', 'must_say': 'フード'},
    # ★「すっぽり」は Veo が「おっぽり」と崩して読んだ（9/26・オーナー指摘）。崩れやすい語は規則表に置かない
    {'genres': ('apparel', 'hoodie'), 'match': r'袖',
     'still': {'selfie': "She is filming herself at arm's length. With her free hand she pulls the long sleeve down "
                         "over her hand until the cuff covers her fingers, holds that hand up next to her cheek and "
                         "talks casually like she is telling a friend. That hand stays inside the sleeve; no peace sign."},
     'line': '袖長めで、指先まで隠れるの盛れる', 'must_say': '指先'},
    {'genres': ('apparel', 'hoodie'), 'match': r'ジップ|ファスナー',
     'still': {'free_hands': "Waist-up. She looks down, takes the second zipper pull at the bottom hem with both "
                             "hands and slides it up a little so the hem opens, then looks up and talks to the viewer "
                             "like a friend."},
     'line': '下からも開くから、抜け感出せる'},
    {'genres': ('apparel', 'hoodie'), 'match': r'サイズ|大きめ|オーバー|ゆったり|ビッグ|[MSL]〜',
     'still': {'mirror': "Mirror selfie, full body. She turns slightly left and right in front of the mirror to show "
                         "the loose, roomy silhouette, then smiles and talks to the mirror like a friend."},
     'line': 'サイズ大きめで、シルエットかわいい'},
    {'genres': ('apparel', 'hoodie'), 'match': r'ポケット',
     'still': {'free_hands': "Waist-up. She slides both hands into the front pockets, shows how deep they are, then "
                             "smiles and talks to the viewer like a friend."},
     'line': 'ポケット深めで、手ぶらでいける'},
    # ---- ガジェット（商品を持った絵 holding が要る） ----
    {'genres': ('gadget',), 'match': r'コードレス|ワイヤレス|充電式',
     'still': {'holding': "She lifts the product with one hand to show there is no cord at all, then looks at the "
                          "camera and talks like she is telling a friend."},
     'line': 'コードないから、サッと使える'},
    {'genres': ('gadget',), 'match': r'静音|静か|dB',
     'still': {'holding': "The product is running next to her; she leans in to listen, smiles because it is quiet, "
                          "and talks softly to the camera like a friend."},
     'line': '動いてても、ほぼ音しない'},
    {'genres': ('gadget',), 'match': r'軽量|軽い|[0-9.]+ ?(g|kg)',
     'still': {'holding': "She holds the product up easily with one hand and bounces it slightly to show how light "
                          "it is, then talks to the camera like a friend."},
     'line': '片手で持てる軽さ、ガチで楽'},
    {'genres': ('gadget',), 'match': r'自動|ステーション|オート',
     'still': {'holding': "She sets the product on its station and steps back, pointing at it with a relaxed smile "
                          "while talking to the camera like a friend."},
     'line': '置くだけで、あとは勝手にやってくれる'},
]

# フックに使える機能が無い時・CTA。どちらも自撮り（顔が大きく映る方が止まる）
FALLBACK_HOOK = {'still': {'selfie': "She is filming herself at arm's length, leans toward the camera with an "
                                     "excited look and talks like she is telling a friend a secret."},
                 'line': 'ちょっと見て、これかなりいい'}
CTA = {'still': {'selfie': "She is filming herself at arm's length, smiles, points down toward the bottom of the "
                           "frame with her free index finger and talks casually to the camera like a friend."},
       'line': '気になったら、リンクから見てみて', 'must_say': 'リンク'}
# 色・サイズ展開は動画で見せる物ではない。最後の実画像パネルの見出しへ回す
PANEL_MATCH = r'[0-9一二三四五]色|カラー|展開|[SML]〜|[0-9]?XL'


def _pick_still(rule, stills):
    """規則の候補のうち、手元にある静止画の最初の1つ。無ければ None（そのカットは作らない）"""
    for key, action in rule['still'].items():
        if stills.get(key):
            return key, action
    return None, None


def _cut(role, rule, stills, feature, seconds):
    key, action = _pick_still(rule, stills)
    if not key:
        return None
    cut = {'role': role, 'feature': feature, 'still': key, 'still_url': stills[key],
           'action': action, 'line': rule['line'], 'seconds': seconds, 'card': feature}
    if rule.get('must_say'):
        cut['must_say'] = rule['must_say']
    return cut


def _no_repeat(cuts):
    """同じ静止画が続かないように並べ替える（機能カットの中だけ。先頭のフックと最後のCTAは動かさない）"""
    out = []
    rest = list(cuts)
    while rest:
        k = next((i for i, c in enumerate(rest) if not out or c['still'] != out[-1]['still']), 0)
        out.append(rest.pop(k))
    return out


def plan(product):
    """
    @param product {'product_key','genre','product_name','features':[...],'image_url','stills':{key:url}}
    @return {'cuts':[...], 'cards_only':[...], 'panel':{...}|None}
    """
    genre = str(product.get('genre') or '').lower()
    stills = product.get('stills') or {}
    features = [str(f).strip() for f in (product.get('features') or []) if str(f).strip()]
    hook, body, cards_only, panel_bits = None, [], [], []
    used = set()
    for f in features:
        rule = next((r for r in RULES if genre in r['genres'] and re.search(r['match'], f)), None)
        if re.search(PANEL_MATCH, f):
            panel_bits.append(f)
            if not rule:
                continue  # 色展開など絵で見せない物はパネルの見出しだけ（サイズは鏡のカットにも使う）
        if not rule or id(rule) in used:
            cards_only.append(f)
            continue
        if rule.get('hook') and hook is None:
            c = _cut('hook', rule, stills, f, HOOK_SECONDS)
            if c:
                hook = c
                used.add(id(rule))
                continue
        if len(body) >= MAX_FEATURE_CUTS:
            cards_only.append(f)
            continue
        c = _cut('feature', rule, stills, f, CUT_SECONDS)
        if c:
            body.append(c)
            used.add(id(rule))
        else:
            cards_only.append(f)  # 必要な静止画が無い → 作らずカードに回す
    if hook is None:
        hook = _cut('hook', FALLBACK_HOOK, stills, None, HOOK_SECONDS)
    cta = _cut('cta', CTA, stills, None, CUT_SECONDS)
    cuts = [c for c in [hook] + _no_repeat(body) + [cta] if c]
    for c in cuts:
        # ★規則表の書き間違いをここで落とす（長いセリフは言い切れずに切れる・？ は video-scene が弾く）
        lim = JA_CHARS_4S * c['seconds'] // CUT_SECONDS
        if len(c['line']) > lim or re.search(r'[?？]|です$|ます$', c['line']):
            raise SystemExit('規則表のセリフが不正: %r（%d文字・上限%d）' % (c['line'], len(c['line']), lim))
    panel = None
    if product.get('image_url') and cuts and cuts[-1]['role'] == 'cta':
        panel = {'cut_index': len(cuts) - 1, 'title': '・'.join(panel_bits[:2]) or '',
                 'images': [product['image_url']], 'cutout': False}
    return {'cuts': cuts, 'cards_only': cards_only, 'panel': panel}


def render_job(product, plan_, clip_urls, upload_path):
    """描画の依頼（{"job":{...}}）を組む。clip_urls は cuts と同じ並び"""
    cuts = plan_['cuts']
    clips = []
    for c, url in zip(cuts, clip_urls):
        clip = {'url': url, 'start': 0, 'duration': c['seconds'], 'product_key': product['product_key']}
        if c.get('must_say'):
            clip['must_say'] = [c['must_say']]
        clips.append(clip)
    cards = [{'text': c['card'], 'cut_index': i} for i, c in enumerate(cuts) if c.get('card')]
    job = {
        'job_id': upload_path.rsplit('/', 1)[-1].rsplit('.', 1)[0],
        'mode': 'A', 'width': 1080, 'height': 1920, 'fps': 30,
        'target_market': product.get('target_market') or 'ja',
        'product_key': product['product_key'],
        'clip_audio': True, 'captions_from_speech': True, 'transition_seconds': 0,
        'speech_speed': SPEECH_SPEED,
        'quality_gate': product.get('quality_gate') or 'block',
        'bgm': product.get('bgm') or 'assets/shared/bgm/duru-roomscene-lofi.mp3',
        'design_tokens': {'text_color_hex': '#ffffff', 'accent_color_hex': '#ff3b5c'},
        'highlight_words': [c['must_say'] for c in cuts if c.get('must_say')],
        'clips': clips, 'info_cards': cards,
        'upload': {'bucket': 'videos', 'path': upload_path},
    }
    if plan_.get('panel'):
        job['product_panel'] = plan_['panel']
    return {'job': job}


if __name__ == '__main__':
    print(json.dumps(plan(json.load(open(sys.argv[1], encoding='utf-8'))), ensure_ascii=False, indent=1))
