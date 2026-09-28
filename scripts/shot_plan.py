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
  station    商品が充電台・ステーションに置かれ、その横に立つ絵（置くだけ系の家電）
  cleaning   商品を実際に使っている絵（掃除機なら床のゴミの上をヘッドが通る）。機能の中心は「使って効く所」を見せる
  ceiling    暗い寝室のベッドに仰向け、天井に映像が大きく映っている絵（プロジェクター・#211）
  gaming     一人称視点。手にコントローラー、前の床に三脚の本体、レンズの先の壁にゲーム（顔なし・#214）
  wall       一人称視点。手で三脚の本体をテーブルに置き、レンズの先の壁に映像（顔なし・#214）

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
CARD_SFX = 'pop'      # カードが出る時の効果音（assets/shared/sfx/ にある物・#189）

"""
★規則表。上から順に当てる（先に当たった規則が勝つ）。
  still は優先順（左が第一候補）。action は静止画ごとに書く（同じ機能でも絵によって出来る動作が違う）。
  line は 18文字以下・タメ口・です/ます・？ 無し（video-scene が ？ を弾く）。
  must_say は line の中の語を1つ。聞こえなければ描く前に作り直す（#193。Veo の言い換え・言いかけで切れた喋りを通さない）。
  must_show は「セリフが言っている絵」を英語1文で（#185）。見せる主張のある規則だけに付け、動作全体ではなく1点に絞る。
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
     'line': 'フードが大きいから、頭まで隠れる', 'must_say': 'フード',
     'must_show': 'The hood is up and covers the top of her head.'},
    # ★「すっぽり」は Veo が「おっぽり」と崩して読んだ（9/26・オーナー指摘）。崩れやすい語は規則表に置かない
    {'genres': ('apparel', 'hoodie'), 'match': r'袖',
     'still': {'selfie': "She is filming herself at arm's length. With her free hand she pulls the long sleeve down "
                         "over her hand until the cuff covers her fingers, holds that hand up next to her cheek and "
                         "talks casually like she is telling a friend. That hand stays inside the sleeve; no peace sign."},
     'line': '袖長めで、指先まで隠れるの盛れる', 'must_say': '指先',
     'must_show': 'A sleeve cuff covers her fingers so the fingertips are hidden.'},
    {'genres': ('apparel', 'hoodie'), 'match': r'ジップ|ファスナー',
     'still': {'free_hands': "Waist-up. She looks down, takes the second zipper pull at the bottom hem with both "
                             "hands and slides it up a little so the hem opens, then looks up and talks to the viewer "
                             "like a friend."},
     'line': '下からも開くから、抜け感出せる', 'must_say': '抜け感',
     'must_show': 'She moves a zipper pull at the bottom hem of the garment.'},
    {'genres': ('apparel', 'hoodie'), 'match': r'サイズ|大きめ|オーバー|ゆったり|ビッグ|[MSL]〜',
     'still': {'mirror': "Mirror selfie, full body. She turns slightly left and right in front of the mirror to show "
                         "the loose, roomy silhouette, then smiles and talks to the mirror like a friend."},
     'line': 'サイズ大きめで、シルエットかわいい', 'must_say': 'シルエット',
     'must_show': 'Her full body is visible in a mirror, showing a loose silhouette.'},
    {'genres': ('apparel', 'hoodie'), 'match': r'ポケット',
     'still': {'free_hands': "Waist-up. She slides both hands into the front pockets, shows how deep they are, then "
                             "smiles and talks to the viewer like a friend."},
     'line': 'ポケット深めで、手ぶらでいける', 'must_say': 'ポケット',
     'must_show': 'Her hands go into the front pockets of the garment.'},
    # ---- ガジェット（商品を持った絵 holding が要る） ----
    # ★プロジェクター（カベーニ・#211）。説明文「お子様と一緒に横になりながら天井でアニメを楽しむ」から、
    #   一番の見せ場（何に使うか）＝寝ながら天井に映す、をフックにする。汎用のガジェット規則より前に置く
    #   （「220g」が軽量の規則に、「バッテリー」が充電式の規則に先に当たらないように）。
    #   ★「4K」「フルHD」「高画質」は言わない：入力は4K対応だが本体の解像度は 854×480（優良誤認になる）。
    #   ★映す映像はアニメ・映画の実在作品にしない（著作権）。抽象的な映像と書く
#   ★★映像はレンズが向いた面にだけ出す（オーナー「商品が写している壁ではない所に映像が出ているのが AI 感」）。
#     本体は付属のミニ三脚に載せ、レンズ側を壁・天井へ向け、光の筋と映像をその先に置く。must_show でも向きを見る
#   ★壁・ゲームは一人称視点（手だけ・顔なし。オーナー案・#214）。顔が崩れる場所を減らし、使う人の目線で見せる
#   ★★一人称でもセリフがあると Veo は話す人を足した（別人が正面で喋った・#215）。声は画面外と明記する。
#     動き回らせると商品が別物に描き変わった（充電式のカット）。商品は持って見せるだけにする
    {'genres': ('gadget',), 'match': r'天井', 'hook': True,
     'still': {'ceiling': "She lies on her back on a bed in a dark bedroom, looking up. On the bedside table the small "
                          "projector sits on its mini tripod, tilted so its lens end points straight up; a soft cone of "
                          "light rises from the lens and the colorful abstract nature video lands on the ceiling directly "
                          "above it. She turns her head to the camera with an excited smile and talks like she is telling "
                          "a friend a secret."},
     'line': '寝ながら天井で、映画見れる', 'must_say': '天井',
     'must_show': 'The image on the ceiling is directly above the projector, whose lens points up at it.'},
    {'genres': ('gadget',), 'match': r'スマホサイズ|手のひら',
     'still': {'holding': "She holds the small projector flat on her open palm next to her face to show it is about "
                          "the size of a phone, then talks to the camera like a friend."},
     'line': 'スマホくらいの大きさで、持ち歩ける', 'must_say': 'スマホ',
     'must_show': 'She holds a small projector about the size of a phone in one hand.'},
    {'genres': ('gadget',), 'match': r'アプリ内蔵',
     'still': {'wall': "First-person view from the sofa at night: her hands in cream knit sleeves set the small projector "
                       "on its mini tripod on the coffee table, lens end aimed at the plain wall ahead; a faint beam runs "
                       "from the lens to the wall and a colorful video with no logos fills the wall exactly where the lens "
                       "points. Her voice is heard off-camera; the camera never turns around and no face ever appears."},
     'line': 'アプリ入りだから、届いてすぐ見れる', 'must_say': 'アプリ',
     'must_show': 'The projector lens points at the wall where the video image appears.'},
    {'genres': ('gadget',), 'match': r'ゲーム|Switch|PS[45]',
     'still': {'gaming': "First-person view sitting on the floor: her hands in cream knit sleeves hold a plain game controller. "
                         "Just ahead on the floor the small projector sits on its mini tripod, lens end facing the plain wall, "
                         "with an HDMI cable to a small plain game console; the colorful game image appears on the wall right "
                         "where the lens aims. No logos. Her voice is heard off-camera; the camera never turns around "
                         "and no face ever appears."},
     'line': 'ゲームも大画面で、テンション上がる', 'must_say': 'ゲーム',
     'must_show': 'A game image is on the wall where the projector lens points while she holds a controller.'},
    {'genres': ('gadget',), 'match': r'連続[0-9.]+時間',
     'still': {'holding': "She holds the small projector up next to her face and turns it slowly so the viewer sees "
                          "no cable is attached; the projector keeps exactly the same shape and colors throughout. "
                          "She smiles and talks to the camera like a friend."},
     'line': '充電式で、映画一本まるっと見れる', 'must_say': '映画',
     'must_show': 'She holds the small projector and no cable is attached to it.'},
    # ★フック（#196）。orage RR35 の説明文「大容量抗菌紙パックで、最大約4－5か月ゴミ捨て不要。※1」から。
    #   数字は Veo が読み崩しやすいので「4〜5」を言わせず「最大約5か月」に留め、条件（※1日1回の掃除で計測）はカードに書く
    {'genres': ('gadget',), 'match': r'ゴミ捨て不要', 'hook': True,
     'still': {'selfie': "She is filming herself at arm's length, leans toward the camera with a surprised, excited look "
                         "and talks like she is telling a friend a secret. The product stands in its station behind her."},
     'line': '最大約5か月、ゴミ捨て不要', 'must_say': 'ゴミ捨て不要'},
    # ★オーナー「ゴミ捨てってではなく、ゴミ捨て不要で のほうがわかりやすい」（2026-09-27）。説明文の語をそのまま言わせる
    # ★★掃除機の肝は吸い込む所（オーナー「一番肝心な掃除機のパワーや吸い込み描写は絶対いる。何に使うかを考えて」）。
    #   説明文「強力吸引で細かい粉じんもどんどん吸い込みます」から。数値（Pa）は言わない（説明文自身が「使い方で異なる」と打ち消している）
    {'genres': ('gadget',), 'match': r'吸引|吸い込',
     'still': {'cleaning': "She pushes the vacuum slowly across the rug. The floor head passes over scattered crumbs and dust, "
                           "which disappear into it and leave a clean stripe behind. She glances at the camera, impressed."},
     'line': '細かいゴミも、どんどん吸い込む', 'must_say': '吸い込む',
     'must_show': 'The floor head passes over visible crumbs or dust on the floor and they disappear.'},
    {'genres': ('gadget',), 'match': r'コードレス|ワイヤレス|充電式',
     'still': {'holding': "She lifts the product with one hand to show there is no cord at all, then looks at the "
                          "camera and talks like she is telling a friend."},
     'line': 'コードないから、サッと使える', 'must_say': 'コード',
     'must_show': 'She holds the product and no cable is attached to it.'},
    {'genres': ('gadget',), 'match': r'静音|静か|dB',
     'still': {'holding': "The product is running next to her; she leans in to listen, smiles because it is quiet, "
                          "and talks softly to the camera like a friend."},
     'line': '動いてても、ほぼ音しない', 'must_say': '音'},
    {'genres': ('gadget',), 'match': r'軽量|軽い|[0-9.]+ ?(g|kg)',
     'still': {'holding': "She holds the product up easily with one hand and bounces it slightly to show how light "
                          "it is, then talks to the camera like a friend."},
     'line': '片手で持てる軽さ、ガチで楽', 'must_say': '片手',
     'must_show': 'She holds the product up with one hand.'},
    {'genres': ('gadget',), 'match': r'自動|ステーション|オート',
     'still': {'station': "The product is docked in its station next to her. She points at it with an open hand, "
                          "gives a relaxed smile and talks to the camera like a friend.",
               'holding': "She sets the product on its station and steps back, pointing at it with a relaxed smile "
                          "while talking to the camera like a friend."},
     'line': '置くだけで、あとは勝手にやってくれる', 'must_say': '置くだけ',
     'must_show': 'The product sits on its station or base.'},
]

# フックに使える機能が無い時・CTA。どちらも自撮り（顔が大きく映る方が止まる）
FALLBACK_HOOK = {'still': {'selfie': "She is filming herself at arm's length, leans toward the camera with an "
                                     "excited look and talks like she is telling a friend a secret."},
                 'line': 'ちょっと見て、これかなりいい'}
CTA = {'still': {'selfie': "She is filming herself at arm's length, smiles, points down toward the bottom of the "
                           "frame with her free index finger and talks casually to the camera like a friend."},
       'line': '気になったら、リンクから見てみて', 'must_say': 'リンク'}
# 色・サイズ展開は動画で見せる物ではない。最後のカットの POINT カードへ回す（#193）
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
    if rule.get('must_show'):
        cut['must_show'] = rule['must_show']  # 映っているべき物。出来た動画を video-scene の verify で照合する（#185）
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
                continue  # 色展開など絵で見せない物は最後の POINT カードだけ（サイズは鏡のカットにも使う）
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
    if cuts and cuts[-1]['role'] == 'cta':
        # ★前のカードで出した情報は最後に繰り返さない（オーナー「M〜は前のシーンで書いてるからいらない」#184）
        shown = {c['card'] for c in cuts if c.get('card')}
        rest = [b for b in panel_bits if b not in shown]
        # ★色展開は前のカットと同じ POINT カードで上に出す。パネルの大見出し（「2色」）は置かない
        #   （オーナー「最後のシーンの2色はいらない。付けるなら前のシーンみたく上に POINT として」#193）
        if rest:
            cuts[-1]['card'] = '・'.join(rest[:2])
        if product.get('image_url'):
            panel = {'cut_index': len(cuts) - 1, 'images': [product['image_url']], 'cutout': False}
    return {'cuts': cuts, 'cards_only': cards_only, 'panel': panel}


def render_job(product, plan_, clip_urls, upload_path, clip_ids=None):
    """描画の依頼（{"job":{...}}）を組む。clip_urls は cuts と同じ並び"""
    cuts = plan_['cuts']
    clips = []
    for c, url in zip(cuts, clip_urls):
        # ★台本（line）も渡す。描画側が字幕（文字起こし）と比べ、大きくずれたら止める（#199）
        clip = {'url': url, 'start': 0, 'duration': c['seconds'], 'product_key': product['product_key'], 'line': c['line']}
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
        'auto_trim_polite': True,  # ★Veo が足す言い終わりの「です」を描画側で切る（#189）
        'quality_gate': product.get('quality_gate') or 'block',
        'bgm': product.get('bgm') or 'assets/shared/bgm/duru-roomscene-lofi.mp3',
        'design_tokens': {'text_color_hex': '#ffffff', 'accent_color_hex': '#ff3b5c'},
        'highlight_words': [c['must_say'] for c in cuts if c.get('must_say')],
        'clips': clips, 'info_cards': cards,
        'upload': {'bucket': 'videos', 'path': upload_path},
    }
    if plan_.get('panel'):
        job['product_panel'] = plan_['panel']
    # ★最後のカット（CTA）で画面下を指す矢印を弾ませる（#204）。秒は描画側がカット番号から解く
    if cuts and cuts[-1]['role'] == 'cta':
        job['cta_arrow'] = {'cut_index': len(cuts) - 1}
    # ★完成したらオーナーの LINE へ［承認］［作り直し］を送る（決定#191）。押された返事で素材が approved になる
    if clip_ids:
        job['review'] = {'clip_ids': [int(i) for i in clip_ids]}
    # ★カードが出る瞬間に短い効果音（決定#189）。目を文字へ向けさせる。秒は描画側がカット番号から解く
    job['sfx'] = [{'tag': CARD_SFX, 'cut_index': c['cut_index']} for c in cards]
    return {'job': job}


if __name__ == '__main__':
    print(json.dumps(plan(json.load(open(sys.argv[1], encoding='utf-8'))), ensure_ascii=False, indent=1))
