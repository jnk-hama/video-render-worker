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
# ★★一人称の絵では、片手はスマホを持っている（オーナー「カメラを撮りながら両手で掃除機を使うのは不自然。片手の描写で」#231）。
#   だから作業に使える手は1本だけ。一人称の指示は全部、この一文で終える（言い換えない・機械で見張る）。
#   自撮り・鏡の自撮りも同じく片手はスマホ（両手を使う動きを書かない）
ONE_HAND_POV = (" She is filming with the phone in her other hand, so exactly one of her hands is visible, doing the"
                " action; the phone and the second hand never appear. Her voice is heard off-camera; the camera never"
                " turns around and no face ever appears.")
PHONE_IN_HAND = ('selfie', 'mirror')   # 本人がスマホを持って撮る絵（作業に使える手は1本）

# ★★掴む位置（オーナー「Id93 掃除機を掴む位置が違う」→「ベージュ部分を掴んで。あの場面はかばんのような持ち方で
#   掃除するのが普通」2026-09-30・#235）。持ち手（RR35 ではベージュの部分）を、かばんの持ち手のように上から握る
#   （手の甲が上・指は持ち手の下に回す）。本体・バッテリー・ダストカップ・パイプには触れない。
#   絵の指示（STICK_GRIP）と、本番前の静止画の点検の部品名（STICK_PARTS）を同じ規則に置く（言い換えない）
#   ★問いは実物で合わせた（2026-09-30・verify を実際に呼んだ）。オーナーの目視との比較：
#     「かばん持ちか」→ オーナー OK の id99 を 0 にした（厳しすぎ）。「指が1本も黒に触れない」→ id99 を 0（同）。
#     下の「持ち手そのものを握っているか」→ id99=1・id93=0（本体の下を握った）は一致。id98（持ち手の上端・境目）は 1＝見抜けない。
#     ＝機械が止めるのは大きな外れ（本体・パイプを握る）まで。境目のような細かい所はオーナーの目視で落とす
# ★握る部分は商品ごとに違う（RR35 は「ベージュ部分」・オーナー 2026-09-30）。product の handle で名指しする。
#   無ければ HANDLE_DEFAULT。{handle} は plan() が必ず埋める（Veo や verify に {handle} のまま渡さない）
HANDLE_DEFAULT = "the handle shown in the product photo"
# 絵の指示はオーナー OK の id99 を作った文から（持ち手の真ん中を包む・他の部分に触れない）
STICK_GRIP = (" Her hand is wrapped around the middle of {handle} like a bag handle, back of the hand up, fingers"
              " curled under it. Every finger and the palm touch only {handle}: never the motor body, the battery"
              " pack, the dust cup, the pipe or any other part. The vacuum keeps exactly the shape and colours of"
              " the product photo.")
# ★点検は「はい／いいえ」の1問にしない（決定#237）。はい／いいえは「はい」に寄り、言い回しで正しい絵も落とした。
#   verify に部品名の選択肢を渡し、どこを・どう握っているかを選ばせる。先頭が握るべき所。合否は marie_video.ergo_problem
STICK_PARTS = ("{handle}", "the motor body", "the battery pack", "the dust cup", "the pipe", "the floor head")


def with_handle(text, handle=None):
    """{handle} を商品の握る部分（product['handle']）で埋める。無ければ HANDLE_DEFAULT"""
    return text.replace('{handle}', handle or HANDLE_DEFAULT) if text else text


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
# ★セリフは2つ繋いで27文字（6秒）に収まる長さにする（オーナー「カベーニのセリフも27文字に詰めて」#224）
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
     'line': 'スマホサイズで、持ち歩ける', 'must_say': 'スマホ',
     'must_show': 'She holds a small projector about the size of a phone in one hand.'},
    {'genres': ('gadget',), 'match': r'アプリ内蔵',
     'still': {'wall': "First-person view from the sofa at night: one hand in a cream knit sleeve sets the small projector "
                       "on its mini tripod on the coffee table, lens end aimed at the plain wall ahead; a faint beam runs "
                       "from the lens to the wall and a colorful video with no logos fills the wall exactly where the lens "
                       "points." + ONE_HAND_POV},
     'line': 'アプリ入りで、届いてすぐ見れる', 'must_say': 'アプリ',
     'must_show': 'The projector lens points at the wall where the video image appears.'},
    {'genres': ('gadget',), 'match': r'ゲーム|Switch|PS[45]',
     'still': {'gaming': "First-person view sitting on the floor: one hand in a cream knit sleeve holds a plain game "
                         "controller. Just ahead on the floor the small projector sits on its mini tripod, lens end facing "
                         "the plain wall, with an HDMI cable to a small plain game console; the colorful game image appears "
                         "on the wall right where the lens aims. No logos." + ONE_HAND_POV},
     'line': 'ゲームも大画面で、遊べる', 'must_say': 'ゲーム',
     'must_show': 'A game image is on the wall where the projector lens points while she holds a controller.'},
    {'genres': ('gadget',), 'match': r'連続[0-9.]+時間',
     'still': {'holding': "She holds the small projector up next to her face and turns it slowly so the viewer sees "
                          "no cable is attached; the projector keeps exactly the same shape and colors throughout. "
                          "She smiles and talks to the camera like a friend."},
     'line': '充電式で、映画一本見れる', 'must_say': '映画',
     'must_show': 'She holds the small projector and no cable is attached to it.'},
    # ★フック（#196）。orage RR35 の説明文「大容量抗菌紙パックで、最大約4－5か月ゴミ捨て不要。※1」から。
    #   数字は Veo が読み崩しやすいので「4〜5」を言わせず「最大約5か月」に留め、条件（※1日1回の掃除で計測）はカードに書く
    {'genres': ('gadget',), 'match': r'ゴミ捨て不要', 'hook': True,
     # ★動きで見せる（#249・オーナー「動きのある説明をAI動画で心がけて」）：脇へ一歩よけて、後ろの商品を見せてから話す
     'still': {'selfie': "She is filming herself at arm's length. The product stands in its station behind her. She steps one pace "
                         "to the side so it comes into full view, sweeps her free hand toward it, then leans toward the camera "
                         "with a surprised, excited look and talks like she is telling a friend a secret."},
     # ★冒頭の大見出し（#250・バズる型）：声（最大約5か月）を繰り返さず、見る人を絞る3〜7語。数字は作らない
     # ★問いかけの形（#251・vidIQ で伸びた日本の掃除動画は「洗濯機掃除してる？？」等の悩みの問いかけが多い）。
     #   「〜やめた」は架空の体験談になるので使わない。？は画面の文字だけ（声では Veo が読み違える・#169）
     # ★#252：オーナー共有の参考（「掃除機のゴミ捨て嫌いな人 全員見て!!」）の型＝「〇〇な人」で絞り、2行目で呼びかける
     'hook_text': 'ゴミ捨てが嫌いな人\n全員見て!!',
     'line': '最大約5か月、ゴミ捨て不要', 'must_say': 'ゴミ捨て不要'},
    # ★オーナー「ゴミ捨てってではなく、ゴミ捨て不要で のほうがわかりやすい」（2026-09-27）。説明文の語をそのまま言わせる
    # ★★掃除機の肝は吸い込む所（オーナー「一番肝心な掃除機のパワーや吸い込み描写は絶対いる。何に使うかを考えて」）。
    #   説明文「強力吸引で細かい粉じんもどんどん吸い込みます」から。数値（Pa）は言わない（説明文自身が「使い方で異なる」と打ち消している）
    # ★「slowly」をやめた（#239）。4秒でヘッドがほぼ動かず、パン屑が全部残った（RR35 本番・オーナー「吸い込みも悪そう」）
    # ★★大げさにしない（#247・オーナー「吸い込みも描写もこんなくらいでいい 君のは大げさすぎ」・参考の TikTok）。
    #   #239 の「一押しで50cm以上・はっきりした筋」をやめ、普段の掃除の量（往復・約30cm・少しのパン屑）で言う
    # ★手だけの静止画（cleaning_pov）を先に見る。顔の無い絵に「カメラを見る」を渡すと Veo が顔を足し、顔の判定で落ちる（#229）
    {'genres': ('gadget',), 'match': r'吸引|吸い込',
     'still': {'cleaning_pov': "First-person view from her own eyes, looking down and forward; her body is not in the frame. "
                               "One hand in her sleeve moves the stick vacuum back and forth over the rug in a few relaxed strokes at a normal pace." + STICK_GRIP
                               + " The floor head moves about 30 cm each way over a few small crumbs, which quietly disappear into it."
                               + ONE_HAND_POV,
               'cleaning': "She moves the vacuum back and forth over the rug in a few relaxed strokes at a normal pace." + STICK_GRIP + " The floor head "
                           "moves about 30 cm each way over a few small crumbs, which quietly disappear into it. "
                           "She glances at the camera with a small smile."},
     'line': '細かいゴミも、どんどん吸い込む', 'must_say': '吸い込む', 'demo': True, 'grip_parts': STICK_PARTS,
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
     # ★「置くだけ」を動きで見せる（#249）：少し持ち上げて戻し、手を離すと自立して収まる
     'still': {'station': "The product is docked in its station next to her. She lifts it a few centimetres out of the station "
                          "by {handle}, sets it straight back down so it settles into place, lets go so it stands on its own, "
                          "and gestures at it with an open hand while talking to the camera like a friend. "
                          "The product and the station keep exactly the shape and colours of the product photo.",
               'holding': "She sets the product on its station and steps back, pointing at it with a relaxed smile "
                          "while talking to the camera like a friend."},
     'line': '置くだけで、あとは勝手にやってくれる', 'must_say': '置くだけ',
     'must_show': 'The product sits on its station or base.'},
]

# フックに使える機能が無い時・CTA。どちらも自撮り（顔が大きく映る方が止まる）
FALLBACK_HOOK = {'still': {'selfie': "She is filming herself at arm's length, leans toward the camera with an "
                                     "excited look and talks like she is telling a friend a secret."},
                 'line': 'ちょっと見て、これかなりいい'}
CTA = {'still': {'selfie': "She is filming herself at arm's length, takes one step closer to the camera, smiles, points down "
                           "toward the bottom of the frame with her free index finger and talks casually to the camera like a friend."},
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
    if rule.get('grip_parts'):
        cut['grip_parts'] = list(rule['grip_parts'])  # 握る所の選択肢（先頭が正）。本番の前に verify で見る（#235・#237）
    if rule.get('hook_text') and role == 'hook':
        cut['hook_text'] = rule['hook_text']  # 冒頭の大見出し（#250）
    if rule.get('demo'):
        cut['demo'] = True  # 商品を使う所の絵。長回しでも一人称でも相乗りさせず単独のシーンに残す（#197・#229）
    return cut


def _no_repeat(cuts):
    """同じ静止画が続かないように並べ替える（機能カットの中だけ。先頭のフックと最後のCTAは動かさない）"""
    out = []
    rest = list(cuts)
    while rest:
        k = next((i for i, c in enumerate(rest) if not out or c['still'] != out[-1]['still']), 0)
        out.append(rest.pop(k))
    return out


# 最後のカットのまとめに並べる性能の数。★3つまで（#246・オーナー「ラストシーンの説明の文字も見にくい」：5行では字が小さすぎた）
CTA_TOPICS_MAX = 3


def summary_topics(features, cuts):
    """
    まとめに出す性能（#242・#246）。★前のカットの札で見せていない物を先に、残りは features の順で、3つまで。
    カットを外した回（#246）は、外したカットの性能がここへ回る
    """
    shown = {t for c in cuts for t in (c.get('cards') or ([c['card']] if c.get('card') else []))}
    rest = [f for f in features if f not in shown]
    return (rest + [f for f in features if f in shown])[:CTA_TOPICS_MAX]


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
            # ★★最後は「商品写真＋性能のまとめ」（#242・オーナー「わかりやすいのが前提で、おしゃれにデザインしてまとめてトピック。
            #   他の人が作ったアフィリエイト動画も参考に」）。絵にしなかった性能も含め、全部を1行1つで並べる（#240 の札はこれに置き換えた）。
            #   ★まとめなので前のカードと重なってよい（#184 は服のサイズを最後に繰り返した件）。色展開を出す回（panel_bits）は従来どおり
            if not panel_bits:
                panel['topics'] = summary_topics(features, cuts)
    # ★★掃除機を手に持つ絵（holding）も握り方を見る（2026-09-30 RR35 本番：軽量1.6kg のカットで黒いパイプを握っていた・
    #   オーナー「静止画の説明も変」）。掃除機（category=cleaning）の回だけ。持っていない絵（station・selfie）は見ない
    if product.get('category') == 'cleaning':
        for c in cuts:
            if c['still'] == 'holding' and not c.get('grip_parts'):
                c['grip_parts'] = list(STICK_PARTS)
    for c in cuts:  # ★握る部分を埋める（#235）。{handle} のまま外へ出さない
        c['action'] = with_handle(c['action'], product.get('handle'))
        if c.get('grip_parts'):
            c['grip_parts'] = [with_handle(x, product.get('handle')) for x in c['grip_parts']]
    return {'cuts': cuts, 'cards_only': cards_only, 'panel': panel}


LONG_SECONDS = 8                              # Veo の1本の上限（video-scene の MAX_SECONDS）
JA_CHARS_LONG = JA_CHARS_4S * LONG_SECONDS // CUT_SECONDS
# ★シーンの長さは等分しない。セリフが入る一番短い長さにする（オーナー「セリフが長いシーンは1〜2秒長くても大丈夫」#223）。
#   短いシーンは Veo の費用（秒課金）がそのまま減る。長さは本番で作れたことのある 6秒・8秒だけを使う
LONG_STEPS = (6, LONG_SECONDS)


def fit_seconds(line):
    return next(s for s in LONG_STEPS if len(line) <= JA_CHARS_4S * s // CUT_SECONDS)
# ★長回しは動きを小さくする（オーナー「手が4本あったり意味のない描写なら1シーン長くして色んな紹介したらいい」#216）。
#   カットが多いほど Veo の破綻（手の数・別人・商品の変形）が入る機会が増える
LONG_CALM = (" Keep it continuous: she keeps talking to the camera while she shows the product in action, "
             "the product stays the same shape and color and stays in view, and no other person appears.")


# ★スマホで撮った日常の質感（#226・オーナー「人間かと思うくらいわからない」参考動画の分析）。
#   人間に見える理由は画質ではなく「本物の場所・スマホの手持ち・その場の光」。スタジオ感を消す。
#   ★他の人は出さない：背景の人は手の数（3本以上で作り直し）と一人称の顔の判定に引っかかる。
#   静止画もこの質感で作った回だけ使う（product_json の "look": "phone"）。静止画と動画の質感をそろえるため
PHONE_LOOK = (" It looks like a real phone video, not a studio: slight natural handheld movement and only the "
              "natural light of the place itself. No other person appears.")


def says(cut):
    """言うべき語の一覧（通常のカットは1語、長回しは機能ごとに1語）"""
    v = cut.get('must_say')
    return [v] if isinstance(v, str) else list(v or [])


# ★完成の形（#248・オーナー「3〜4カット構成で」「もう少しシーンを長くして16〜18秒に」「全てAI動画で構築」「全編インフルエンサーの声で」）
TARGET_SECONDS = (16, 18)
CUTS_MAX = 4
# 頭の無音を詰める分の見積り（描画は喋り始めの少し前から使う・尾は min_keep で残す）
HEAD_TRIM = 0.3


def est_seconds(cuts):
    """完成の長さの見積り（秒）。各カットは頭の無音だけ詰め、喋りの速さ（SPEECH_SPEED）で縮む"""
    return sum(c['seconds'] - HEAD_TRIM for c in cuts) / SPEECH_SPEED


def fit_shape(cuts, cards_only):
    """
    3〜4カット・16〜18秒に合わせる（#248）。
      1. 4カットを超えたら、絵で見せる主張（must_show）の無い機能のカットから外す（性能は最後のまとめへ回る）
      2. 16秒に届くまで、短いカットから Veo の長さを一段ずつ伸ばす（4→6→8秒）。実演・フックを先に。18秒は超えない
    """
    cuts = list(cuts)
    while len(cuts) > CUTS_MAX:
        k = next((k for k in range(len(cuts) - 2, 0, -1) if not cuts[k].get('must_show')), len(cuts) - 2)
        cards_only.append(cuts.pop(k).get('feature'))
    steps = (CUT_SECONDS,) + LONG_STEPS
    cuts = [dict(c) for c in cuts]
    while est_seconds(cuts) < TARGET_SECONDS[0]:
        order = sorted(range(len(cuts)), key=lambda k: (cuts[k]['seconds'], not cuts[k].get('demo'), cuts[k]['role'] != 'hook', k))
        for k in order:
            nxt = next((x for x in steps if x > cuts[k]['seconds']), None)
            if nxt and est_seconds(cuts[:k] + [dict(cuts[k], seconds=nxt)] + cuts[k + 1:]) <= TARGET_SECONDS[1]:
                cuts[k]['seconds'] = nxt
                break
        else:
            break
    return cuts


def plan_long(product):
    """
    長回しの計画（#216）。通常の計画を作り、同じ静止画の機能を1シーンにまとめる。
    余った1機能はフック→CTA の順に相乗りさせる。セリフが JA_CHARS_LONG を超える組は作らない。
    一人称の絵だけで成り立つ機能は相乗り先の絵で語る（一人称のカットは作らない）。
    """
    base = plan(product)
    cuts = base['cuts']
    if len(cuts) < 3 or cuts[0]['role'] != 'hook' or cuts[-1]['role'] != 'cta':
        return base
    hook, body, cta = cuts[0], cuts[1:-1], cuts[-1]
    groups, order = {}, []
    for c in body:
        if c['still'] not in groups:
            groups[c['still']] = []
            order.append(c['still'])
        groups[c['still']].append(c)

    def scene(primary, extras):
        parts = [primary] + extras
        # ★機能ごとの句を「、」で繋ぐ。句の中の読点は外す（読点が多いと Veo が細切れに間を取る）
        line = '、'.join(p['line'].replace('、', '') for p in parts) if extras else primary['line']
        if len(line) > JA_CHARS_LONG:
            return None
        s = dict(primary, seconds=fit_seconds(line) if extras else primary['seconds'], line=line,
                 action=primary['action'] + (LONG_CALM if extras else ''),
                 must_say=[w for p in parts for w in says(p)],
                 cards=[p['card'] for p in parts if p.get('card')])
        s.pop('card', None)
        return s

    singles, scenes = [], []
    for st in order:
        g = groups[st]
        while len(g) >= 2:
            sc = scene(g[0], [g[1]])
            if not sc:
                break
            scenes.append(sc)
            g = g[2:]
        singles += g
    first, last = scene(hook, []), scene(cta, [])
    for c in singles:
        # ★見せる主張のあるカット（must_show。掃除機の吸い込み等）は相乗りさせず単独で残す。
        #   オーナー「一番肝心な吸い込み描写は絶対いる」（#197）。相乗りは絵で見せられない一人称だけ
        if c.get('must_show') and (c.get('demo') or not is_pov_action(c['action'])):
            scenes.append(scene(c, []))
            continue
        for slot in ('first', 'last'):
            cur = first if slot == 'first' else last
            prim = hook if slot == 'first' else cta
            if len(says(cur)) - len(says(prim)) >= 1:
                continue  # その枠は埋まっている
            merged = scene(prim, [c]) if slot == 'first' else scene(c, [prim])
            if merged:
                if slot == 'last':   # CTA の絵とリンクの一言は CTA 側を使う
                    # ★絵を CTA の物に替えるので、絵の問い（must_show）も CTA の物にする。相乗りした機能の問いを残すと、
                    #   その絵では満たせない問いで必ず作り直しになる（E-037：ゲームの「壁に映像」を自撮りの絵に問うていた）
                    merged = dict(merged, still=cta['still'], still_url=cta['still_url'],
                                  action=cta['action'] + LONG_CALM, role='cta', must_show=cta.get('must_show'))
                if slot == 'first':
                    first = merged
                else:
                    last = merged
                break
        else:
            if not is_pov_action(c['action']):
                scenes.append(scene(c, []) or dict(c))
            else:
                base['cards_only'].append(c['feature'])
    # ★本編は元の計画の並び順を保つ（吸い込む所をフックの直後に出す等・規則表の優先を崩さない）
    scenes.sort(key=lambda s: min((k for k, c in enumerate(body) if c['feature'] == s['feature']), default=99))
    out = fit_shape([first] + scenes + [last], base['cards_only'])
    if base.get('panel'):
        base['panel'] = dict(base['panel'], cut_index=len(out) - 1)
    if cta.get('card') and not last.get('cards'):
        last['cards'] = [cta['card']]
    return {'cuts': out, 'cards_only': base['cards_only'], 'panel': base.get('panel'), 'layout': 'long'}


def is_pov_action(action):
    return str(action or '').startswith('First-person')


# ★規則表の指示文はマリー（女性）で書いてある。ヒロ（男性・#220）の回は代名詞だけを機械で差し替える。
#   規則表を男女で2本持つと必ずずれる（一度決めたら全部で強制する）。目的格の her（to her. / behind her;）は him、他は his
_TO_HE = [(r'\bherself\b', 'himself'), (r'\bShe\b', 'He'), (r'\bshe\b', 'he'), (r'\bHer\b', 'His'),
          (r'\bher\b(?=\s*(?:[.,;:"]|$))', 'him'), (r'\bher\b', 'his')]


def gendered(text, persona):
    if persona != 'hiro' or not text:
        return text
    for pat, rep in _TO_HE:
        text = re.sub(pat, rep, text)
    return text


# ★投稿文（#244）。承認したらコピーして貼るだけにする。作るのは計画と商品情報からの組み立てだけ（LLM を使わない・0円）。
#   ★ステマ規制：#PR は先頭。★優良誤認：性能は features（楽天の説明文から抜いた物）だけ・※の条件は消さない。
#   ★AI の人物なので #AI生成 を付ける（jp-affiliate-compliance 5）。価格は書かない（有利誤認）
X_MAX_WEIGHT = 280            # X の上限（日本語など全角は1字で2と数える）
X_URL_WEIGHT = 23             # X はリンクを長さに関わらず23字と数える


def x_weight(text):
    """X の長さ（全角2・半角1・リンクは23）"""
    urls = re.findall(r'https?://\S+', text)
    body = re.sub(r'https?://\S+', '', text)
    return sum(1 if ord(ch) < 0x1100 else 2 for ch in body) + X_URL_WEIGHT * len(urls)


def post_pack(product, cuts):
    """{'tiktok': 投稿文, 'x': 投稿文}。フックのセリフ・性能のトピック・※の条件・#PR・#AI生成から組む。
    ★フックと同じ性能はトピックに繰り返さず、その※の条件をフックのすぐ下に置く（条件は主張と離さない）"""
    hook_cut = next((c for c in cuts if c.get('role') == 'hook'), cuts[0] if cuts else {})
    hook, hook_words = hook_cut.get('line', ''), says(hook_cut) if hook_cut else []
    head, rows = ['#PR ' + hook], []
    for f in (product.get('features') or []):
        parts = [x.strip() for x in str(f).split('\n') if x.strip()]
        if not parts:
            continue
        notes = [x for x in parts[1:] if x.startswith('※')]
        if any(w and w in parts[0] for w in hook_words):
            head += notes
        else:
            rows.append(['✓' + parts[0]] + notes)
    link = str(product.get('affiliate_url') or '').strip()
    tiktok = '\n'.join(head + [l for r in rows for l in r] + ['気になったらプロフのリンクから', '#AI生成'])
    tail = [link] if link.startswith('https://') else ['リンクはプロフから']
    for n in range(len(rows), -1, -1):
        x = '\n'.join(head + [l for r in rows[:n] for l in r] + tail + ['#AI生成'])
        if x_weight(x) <= X_MAX_WEIGHT:
            break
    return {'tiktok': tiktok, 'x': x}


def render_job(product, plan_, clip_urls, upload_path, clip_ids=None):
    """描画の依頼（{"job":{...}}）を組む。clip_urls は cuts と同じ並び"""
    cuts = plan_['cuts']
    clips = []
    for c, url in zip(cuts, clip_urls):
        # ★台本（line）も渡す。描画側が字幕（文字起こし）と比べ、大きくずれたら止める（#199）
        clip = {'url': url, 'start': 0, 'duration': c['seconds'], 'product_key': product['product_key'], 'line': c['line'],
                # ★尾の無音は詰めずに残す（#248・16〜18秒）。頭だけ詰める
                'min_keep': c['seconds']}
        if says(c):
            clip['must_say'] = says(c)
        clips.append(clip)
    cards = []
    for i, c in enumerate(cuts):
        if i == 0 and c.get('hook_text'):
            # ★冒頭の大見出し（#250）はフックの前半、性能の札は後半へ。同時に出すと最初の画面が文字で埋まる
            hc = c.get('cards') or ([c['card']] if c.get('card') else [])
            cards.append({'text': c['hook_text'], 'cut_index': 0, 'part': [0, 2], 'style': 'hook'})
            cards += [{'text': txt, 'cut_index': 0, 'part': [1, 2], 'style': 'center'} for txt in hc[:1]]
            continue
        # ★札は画面の真ん中に白い大きな字で1機能1行（#252・参考の「V字ローラーで絡みにくい」）
        if c.get('cards'):
            # ★長回しは機能ごとにカードを出し分ける（前半・後半）。秒は描画側がカット番号と part から解く（#216）
            n = len(c['cards'])
            cards += [{'text': txt, 'cut_index': i, 'part': [k, n], 'style': 'center'} for k, txt in enumerate(c['cards'])]
        elif c.get('card'):
            cards.append({'text': c['card'], 'cut_index': i, 'style': 'center'})
    job = {
        'job_id': upload_path.rsplit('/', 1)[-1].rsplit('.', 1)[0],
        'mode': 'A', 'width': 1080, 'height': 1920, 'fps': 30,
        'target_market': product.get('target_market') or 'ja',
        'product_key': product['product_key'],
        'clip_audio': True, 'captions_from_speech': True, 'transition_seconds': 0,
        'speech_speed': SPEECH_SPEED,
        'auto_trim_polite': True,  # ★Veo が足す言い終わりの「です」を描画側で切る（#189）
        'keep_voice': True,  # ★崩れた喋りを読み上げの別の声に替えない（#246・オーナー「マリーじゃないのが喋ってる」）
        # ★検査は止めずに記録する（#230・オーナー「停止という概念がおかしい」）。見つけた問題は LINE の承認依頼に書き、
        #   オーナーが見て承認か作り直しを選ぶ（#191）。block を付けた依頼だけ従来どおり止める
        'quality_gate': product.get('quality_gate') or 'warn',
        'video_qc': product.get('video_qc') or 'warn',   # 出来上がった動画の品質検査（qc_video.py・#225）
        'bgm': product.get('bgm') or 'assets/shared/bgm/duru-roomscene-lofi.mp3',
        'design_tokens': {'text_color_hex': '#ffffff', 'accent_color_hex': '#ff3b5c'},
        'highlight_words': [w for c in cuts for w in says(c)],
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
    job['post_pack'] = post_pack(product, cuts)
    # ★カードが出る瞬間に短い効果音（決定#189）。目を文字へ向けさせる。秒は描画側がカット番号から解く
    job['sfx'] = [dict({'tag': CARD_SFX, 'cut_index': c['cut_index']}, **({'part': c['part']} if 'part' in c else {}))
                  for c in cards]
    return {'job': job}


if __name__ == '__main__':
    print(json.dumps(plan(json.load(open(sys.argv[1], encoding='utf-8'))), ensure_ascii=False, indent=1))
