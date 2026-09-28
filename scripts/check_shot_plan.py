#!/usr/bin/env python3
"""
shot_plan（商品ごとのカット選び・決定#182）を検証する。
★入力は本物の商品（REDIAL redial-850019）の売り文句と、本番で使った静止画の種類。
使い方: python3 scripts/check_shot_plan.py
"""
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shot_plan  # noqa: E402
import speech_qa  # noqa: E402

fails = []


def expect(cond, msg):
    print(('  OK   ' if cond else '  NG   ') + msg)
    if not cond:
        fails.append(msg)


REDIAL = {'product_key': 'redial-850019', 'genre': 'apparel', 'product_name': 'REDIAL ヴィンテージ加工 ジップパーカー',
          'features': ['大きめフード', '長め袖', 'ダブルジップ', 'ヴィンテージ洗い加工', '2色', 'M〜3L'],
          'image_url': 'https://example/p.jpg',
          'stills': {'selfie': 's', 'mirror': 'm', 'free_hands': 'f', 'hood': 'h'}}

print('=== アパレル（本番の商品）===')
p = shot_plan.plan(REDIAL)
for c in p['cuts']:
    print('     %-8s %-10s %-12s %s' % (c['role'], c['still'], c['feature'], c['line']))
roles = [c['role'] for c in p['cuts']]
expect(roles[0] == 'hook' and roles[-1] == 'cta', '先頭はフック・最後はCTA')
expect(p['cuts'][0]['feature'] == 'ヴィンテージ洗い加工', 'フックは一番「見せられる」機能（色落ち）を前へ出す')
stills = [c['still'] for c in p['cuts']]
expect(len(set(stills)) >= 3, '自撮りだけにしない（撮り方が3種類以上）')
expect(all(a != b for a, b in zip(stills[1:-2], stills[2:-1])), '機能カットで同じ静止画を続けない')
hood = next(c for c in p['cuts'] if c['feature'] == '大きめフード')
expect(hood['still'] == 'hood', 'フードは被った絵を優先（片手の自撮りからは被れない・#181）')
size = next((c for c in p['cuts'] if c['feature'] == 'M〜3L'), None)
expect(size is not None and size['still'] == 'mirror', 'サイズは鏡越しの全身で見せる（パネルの見出しにも使う）')
zipc = next(c for c in p['cuts'] if c['feature'] == 'ダブルジップ')
expect(zipc['still'] == 'free_hands', 'ジップは両手が空いた絵から')
expect(p['panel'] and p['panel']['cut_index'] == len(p['cuts']) - 1 and not p['panel'].get('title'),
       '最後のカットに実画像パネル。大見出し（「2色」）は置かない（#193）')
expect(p['cuts'][-1].get('card') == '2色',
       '色展開は最後のカットの POINT カードへ。前のカードで出したサイズは繰り返さない（#184・#193）')
c2 = shot_plan.plan(dict(REDIAL, features=['大きめフード', 'グレー・ブラックの2色展開', 'M〜3L']))
expect(c2['cuts'][-1].get('card') == 'グレー・ブラックの2色展開', '色名つきの色展開もそのままカードに出す')
expect(all(len(c['line']) <= shot_plan.JA_CHARS_4S * c['seconds'] // 4 for c in p['cuts']), 'セリフは尺に入る長さ')

print('=== 静止画が足りない時は作らない ===')
q = shot_plan.plan(dict(REDIAL, stills={'selfie': 's'}))
expect(all(c['still'] == 'selfie' for c in q['cuts']), '手元に無い静止画のカットは作らない')
expect('ダブルジップ' in q['cards_only'] and '大きめフード' in q['cards_only'], '作れない機能はカードに回す（捨てない）')

print('=== 規則に無い機能はでっち上げない ===')
r = shot_plan.plan(dict(REDIAL, features=['裏起毛', '大きめフード']))
expect('裏起毛' in r['cards_only'] and not any(c['feature'] == '裏起毛' for c in r['cuts']),
       '規則に無い機能は Veo を回さずカードだけ')
expect(r['cuts'][0]['feature'] is None, 'フック向きの機能が無ければ汎用のフック')

print('=== ガジェット（全商品）===')
g = shot_plan.plan({'product_key': 'orage-rr35', 'genre': 'gadget', 'features': ['コードレス', '静音設計', '自動ゴミ回収'],
                    'image_url': 'https://example/g.jpg', 'stills': {'selfie': 's', 'holding': 'h'}})
for c in g['cuts']:
    print('     %-8s %-8s %-10s %s' % (c['role'], c['still'], c['feature'], c['line']))
expect([c['feature'] for c in g['cuts'][1:-1]] == ['コードレス', '静音設計', '自動ゴミ回収'], 'ガジェットの機能を1つずつカットに')
expect(all(c['still'] == 'holding' for c in g['cuts'][1:-1]), 'ガジェットは商品を持った絵から')

print('=== 家電（orage RR35・#196）===')
RR35 = {'product_key': 'orage-rr35', 'genre': 'gadget',
        'features': ['最大約4〜5か月ゴミ捨て不要\n※1日1回の掃除で計測', '強力吸引', 'コードレス', '自動ゴミ回収ステーション', '軽量1.6kg'],
        'image_url': 'https://example/rr35.jpg', 'stills': {'selfie': 's', 'holding': 'h', 'station': 't', 'cleaning': 'c'}}
k = shot_plan.plan(RR35)
for c in k['cuts']:
    print('     %-8s %-8s %-14s %s' % (c['role'], c['still'], (c['feature'] or '').split(chr(10))[0], c['line']))
expect('ゴミ捨て不要' in k['cuts'][0]['line'] and k['cuts'][0]['still'] == 'selfie', 'フックは説明文の一番強い数字を「ゴミ捨て不要」の語で（オーナー指摘）')
expect(k['cuts'][1]['feature'] == '強力吸引' and k['cuts'][1]['still'] == 'cleaning' and bool(k['cuts'][1].get('must_show')),
       '掃除機は吸い込む所を、使っている絵で最初に見せる（オーナー「一番肝心」）')
st = next(c for c in k['cuts'] if c['feature'] == '自動ゴミ回収ステーション')
expect(st['still'] == 'station', '置くだけ系はステーションの絵を優先')
expect([c['still'] for c in k['cuts'][2:-1]] == ['holding', 'station', 'holding'], '持つ絵を続けない（ステーションを挟む）')

print('=== プロジェクター（カベーニ・#211）===')
KABENI = {'product_key': 'kabeni-projector', 'genre': 'gadget',
          'features': ['天井に投影できる\n※投影サイズ 6〜130インチ', 'スマホサイズ・220g', 'アプリ内蔵（YouTube・Netflix・プライムビデオ）',
                       'バッテリー内蔵・連続2.5時間再生', 'Switch・PS4をHDMIでつないでゲーム'],
          'image_url': 'https://example/kabeni.jpg',
          'stills': {'selfie': 's', 'holding': 'h', 'ceiling': 'c', 'gaming': 'g', 'wall': 'w'}}
kb = shot_plan.plan(KABENI)
for c in kb['cuts']:
    print('     %-8s %-8s %-18s %s' % (c['role'], c['still'], (c['feature'] or '').split(chr(10))[0], c['line']))
expect(kb['cuts'][0]['still'] == 'ceiling' and '天井' in kb['cuts'][0]['line'],
       'フックは一番の見せ場（寝ながら天井に映す）')
sz = next(c for c in kb['cuts'] if c['feature'] == 'スマホサイズ・220g')
expect('スマホ' in sz['line'], '「220g」が汎用の軽量の規則に先に当たらない（スマホサイズの規則が勝つ）')
bt = next(c for c in kb['cuts'] if c['feature'].startswith('バッテリー'))
expect('映画' in bt['line'], '「バッテリー内蔵」が汎用の充電式の規則に先に当たらない')
expect(len(kb['cuts']) == 6 and not kb['cards_only'], 'フック＋機能4つ＋CTA。捨てる機能なし')
kst = [c['still'] for c in kb['cuts'][1:-1]]
expect(all(a != b for a, b in zip(kst, kst[1:])), '機能カットで同じ静止画を続けない（アプリは壁に映す絵・%s）' % kst)
expect(not any(w in r['line'] for r in shot_plan.RULES for w in ('4K', 'フルHD', '高画質')),
       '本体の解像度は 854×480。4K・フルHD・高画質は言わせない（優良誤認）')

import re as _re  # noqa: E402
for rule in shot_plan.RULES:
    for key, action in rule['still'].items():
        if _re.search(r'projected|projecting|video (appears|lands|fills)|game image', action):
            expect('lens' in action, '映像が出る絵はレンズの向きを書く（%s・オーナー「写している壁ではない所に映像」#213）' % key)
    if 'must_show' in rule and _re.search(r'projected|image', rule['must_show']) and 'projector' in rule['must_show']:
        expect('lens' in rule['must_show'], 'must_show も映像とレンズの向きを照合する「%s」' % rule['must_show'][:40])

for rule in shot_plan.RULES:
    for key, action in rule['still'].items():
        if action.startswith('First-person'):
            expect('off-camera' in action and 'no face ever appears' in action,
                   '一人称のカットは声を画面外にし、顔を出さない（%s・別人が喋った #215）' % key)

print('=== 長回し（#216）===')
lk = shot_plan.plan_long(dict(KABENI, layout='long'))
for c in lk['cuts']:
    print('     %-8s %-8s %ds %s %s' % (c['role'], c['still'], c['seconds'], c['line'], shot_plan.says(c)))
expect([c['role'] for c in lk['cuts']] == ['hook', 'feature', 'cta'], '6カットを3シーンにまとめる（フック・本編・CTA）')
expect(all(c['seconds'] == shot_plan.LONG_SECONDS and len(c['line']) <= shot_plan.JA_CHARS_LONG for c in lk['cuts']),
       '各シーンは8秒・セリフは尺に入る長さ')
expect(not any(shot_plan.is_pov_action(c['action']) for c in lk['cuts']), '一人称のカットは作らない（別人・手の破綻の元）')
expect(all(shot_plan.LONG_CALM in c['action'] for c in lk['cuts']), '長回しは動きを小さく・別人を出さない指示を付ける')
mid = lk['cuts'][1]
expect(mid['still'] == 'holding' and shot_plan.says(mid) == ['スマホ', '映画'], '同じ静止画の機能を1シーンにまとめる（手のひら：大きさ＋充電式）')
expect(not lk['cards_only'], '5つの機能を全部どこかで言う（捨てない）')
jl = shot_plan.render_job(KABENI, lk, ['u'] * 3, 'preview/x.mp4')['job']
expect([c.get('part') for c in jl['info_cards'] if c['cut_index'] == 1] == [[0, 2], [1, 2]], 'カードは前半・後半に出し分ける')
expect(jl['clips'][1]['must_say'] == ['スマホ', '映画'], '言うべき語は機能ごとに全部渡す')
tw = speech_qa.timed_by_cut([{'text': 'a', 'cut_index': 0, 'part': [1, 2]}], [(0.0, 8.0)])
expect(abs(tw[0]['start'] - 4.15) < 1e-6 and abs(tw[0]['end'] - 7.85) < 1e-6, 'part は窓を等分した区間になる')
lr = shot_plan.plan_long(dict(RR35, layout='long'))
for c in lr['cuts']:
    print('     %-8s %-8s %ds %s' % (c['role'], c['still'], c['seconds'], c['line']))
expect(any(c['still'] == 'cleaning' and c.get('must_show') for c in lr['cuts']),
       '吸い込む所（見せる主張のあるカット）は相乗りさせず単独で残す（#197）')
expect(sum(c['seconds'] for c in lr['cuts']) <= 30, '長回しでも全体は30秒以内')
expect(lr['cuts'][1]['still'] == 'cleaning', '吸い込む所はフックの直後（元の計画の並びを保つ）')
import marie_video  # noqa: E402
lb = marie_video.redo_targets(lk['cuts'], {i: {'video_url': 'v%d' % i} for i in range(3)}, list(range(3)),
                              lambda u, m: (1, 'ok', 'スマホくらいの大きさで持ち歩ける' if u == 'v1' else lk['cuts'][int(u[1:])]['line']))
expect(list(lb) == [1] and '映画' in lb[1], '長回しで2つ目の語を言い落としたら作り直す')

print('=== 規則表そのもの ===')
for rule in shot_plan.RULES + [shot_plan.FALLBACK_HOOK, shot_plan.CTA]:
    lim = shot_plan.JA_CHARS_4S * (shot_plan.HOOK_SECONDS if rule.get('hook') else 4) // 4
    ok = len(rule['line']) <= lim and not any(ch in rule['line'] for ch in '?？「」"\n')
    expect(ok, 'セリフ「%s」は尺内・記号なし' % rule['line'])
    expect(not speech_qa.check_speech([[{'text': rule['line'], 'start': 0, 'end': 1}]], [{}], 'ja'),
           'セリフ「%s」は喋りの検査（です終わり・体験談）を通る' % rule['line'])

for rule in shot_plan.RULES + [shot_plan.CTA]:
    expect(bool(rule.get('must_say')) and rule['must_say'] in rule['line'],
           'セリフ「%s」は言うべき語を持つ（聞こえなければ描く前に作り直す・#193）' % rule['line'])

print('=== 描画の依頼 ===')
job = shot_plan.render_job(REDIAL, p, ['u%d' % i for i in range(len(p['cuts']))], 'preview/x.mp4')['job']
expect([c['cut_index'] for c in job['info_cards']] == [i for i, c in enumerate(p['cuts']) if c.get('card')],
       'カードはカット番号で指定（秒は描画側で解く）')
expect(job['quality_gate'] == 'block', '自動の回は検査で止める（warn にしない）')
expect(job['speech_speed'] == shot_plan.SPEECH_SPEED > 1.0, '喋りは少し速く（#183）')
expect(job.get('auto_trim_polite') is True, 'Veo が足す言い終わりの「です」は描画側で切る（#189）')
expect(not any('すっぽり' in r['line'] for r in shot_plan.RULES), '崩れて読まれた語（すっぽり）を規則表に置かない')
expect([x['cut_index'] for x in job['sfx']] == [c['cut_index'] for c in job['info_cards']],
       'カードが出るカットごとに効果音を1つ（#189）')
import render_video  # noqa: E402
expect(shot_plan.CARD_SFX in render_video.SFX_TAGS and
       os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'shared', 'sfx',
                                   shot_plan.CARD_SFX + '.mp3')), 'カードの効果音は描画側が鳴らせる物')
tsfx = speech_qa.timed_by_cut([{'tag': 'pop', 'cut_index': 1}], speech_qa.part_windows([5.63, 3.55], 0.0))
expect(abs(tsfx[0]['start'] - 5.78) < 1e-6, '効果音もカット番号から秒へ直る（カードと同じ秒）')

print('=== 画と台詞の照合（#185）===')
import marie_video  # noqa: E402
for rule in shot_plan.RULES:
    if 'must_show' in rule:
        ok = 0 < len(rule['must_show']) <= 200 and not any(ch in rule['must_show'] for ch in '"「」\n')
        expect(ok, 'must_show「%s」は1文・記号なし（video-scene が弾かない形）' % rule['must_show'][:40])
for feat in ('大きめフード', '長め袖', 'ダブルジップ'):
    c = next(c for c in p['cuts'] if c['feature'] == feat)
    expect(bool(c.get('must_show')), '%s のカットは映っているべき物を持つ' % feat)
cuts = p['cuts']
ids = list(range(len(cuts)))
sleeve = next(k for k, c in enumerate(cuts) if c['feature'] == '長め袖')
calls = []


def fake_verify(url, must_show):
    calls.append((url, must_show))
    k = int(url[1:])
    return (0, 'bare fingers', 'x') if k == sleeve else (1, 'ok', cuts[k]['line'])


got = {i: {'video_url': 'v%d' % i} for i in ids}
got[0] = {'video_url': None}
bad = marie_video.redo_targets(cuts, got, ids, fake_verify)
expect(set(bad) == {0, sleeve}, '動画なし（フィルタ）と絵のずれ（袖）の両方を作り直しに回す')
expect('bare fingers' in bad[sleeve], '作り直しの理由に「実際に映っていた物」を残す')
expect(sorted(u for u, _ in calls) == sorted('v%d' % k for k in ids if k),
       '動画のあるカットは全部照合する（喋りの言い終わりも見るため・#189）')
expect(all((m is None) == (not cuts[int(u[1:])].get('must_show')) for u, m in calls),
       'must_show の無いカット（フック・CTA）は絵の問いを渡さない')
expect(marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                                lambda u, m: (1, 'ok', cuts[int(u[1:])]['line'])) == {}, '全部映っていてセリフ通りなら作り直さない')
pol = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                               lambda u, m: (1, 'ok', '下からも開くからね、座っても楽です。' if u == 'v3' else cuts[int(u[1:])]['line']))
expect(list(pol) == [3] and '丁寧語' in pol[3], '言い終わりが「です」のカットは作り直しに回す（#189）')
zk = next(k for k, c in enumerate(cuts) if c['feature'] == 'ダブルジップ')
dev = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                               lambda u, m: (1, 'ok', '下からも開くから座ったら' if u == 'v%d' % zk else cuts[int(u[1:])]['line']))
expect(list(dev) == [zk] and '抜け感' in dev[zk], 'セリフを言い換えて言うべき語が無いカットは作り直しに回す（#193・実例）')

lk = next(k for k, c in enumerate(cuts) if c['feature'] == 'M〜3L')
fil = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                               lambda u, m: (1, 'ok', 'うん、ね、これね、ね、サイズ大きめでね、シルエットかわいいよね。あ' if u == 'v%d' % lk
                                             else cuts[int(u[1:])]['line']))
expect(list(fil) == [lk] and '言い淀み' in fil[lk], '言い淀みで伸びた喋りは作り直しに回す（#197・実例の形）')
ok_real = ['下からも開くからね、抜け感出せる', 'フードが大きいからね、頭まで隠れる', 'ので コードないから ね サッと使える']
expect(all(len(speech_qa._norm(t, 'ja')) <= marie_video.SAID_MAX_RATIO * 13 for t in ok_real), '実際に通った喋りは止めない')
expect(speech_qa.ends_polite('気になったらね、リンクから見てみてください。', 'ja'), '「ください」終わりも丁寧語として作り直す')

print('=== 生成クリップの顔（#215）===')
expect(speech_qa.ends_polite('最大約5ヶ月でゴミ捨て不要ですはぁー', 'ja'), '「です」の後ろに「はぁー」が付いても丁寧語として作り直す（実例）')
expect(speech_qa.ends_polite('最大約5ヶ月でゴミ捨て不要です。はーい', 'ja'), '「です。はーい」も丁寧語')
expect(not speech_qa.ends_polite('ゲームも大画面で、テンション上がる', 'ja'), '普通の言い切りは止めない')
calls_f = []
def fake_face(u, pov):
    calls_f.append((u, pov))
    return '一人称のカットに顔が映っている（2.0秒）' if u == 'v2' else None
okv = lambda u, m: (1, 'ok', cuts[int(u[1:])]['line'])
ff = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids, okv, face=fake_face)
expect(list(ff) == [2] and '顔' in ff[2], '顔の判定に落ちたカットは作り直しに回す')
expect(len(calls_f) == len(ids), '動画のあるカットは全部、顔も見る')
expect(marie_video.is_pov({'action': 'First-person view ...'}) and not marie_video.is_pov({'action': 'She holds ...'}),
       '一人称のカットは action の書き出しで見分ける（規則表の書き方と一致）')

print('=== 顔の基準は人物ごと（#218）===')
import face_score  # noqa: E402
expect(face_score.master_urls() == face_score.MASTERS['marie'], '指定なしはマリーの基準')
expect(face_score.master_urls('hiro') == face_score.MASTERS['hiro'] and face_score.MASTERS['hiro'] != face_score.MASTERS['marie'],
       'ヒロは別の基準')
try:
    face_score.master_urls('anna')
    expect(False, '知らない人物は止める')
except SystemExit:
    expect(True, '知らない人物は止める（別人の基準で通さない）')
_seen_p = []
_orig_rs, _orig_fp = face_score.reference_set, marie_video.face_problem
face_score.reference_set = lambda p=None: (_seen_p.append(p) or [('m', None)])
marie_video.face_problem = lambda u, pov, refs, who='marie': None
_real_mfc = marie_video.make_face_check
_real_mfc('hiro')('v0', False)
_real_mfc(None)('v0', False)
face_score.reference_set, marie_video.face_problem = _orig_rs, _orig_fp
expect(_seen_p == ['hiro', 'marie'], 'product_json の persona の基準で判定する（無ければマリー）')
print('=== 誰が紹介するか（商品を使う人の性別・#220）===')
expect(marie_video.persona_of({'target': 'women'}) == 'marie', '女性用はマリー')
expect(marie_video.persona_of({'target': 'men'}) == 'hiro', '男性用はヒロ')
expect(marie_video.persona_of({'target': 'men', 'persona': 'marie'}) == 'marie', 'persona を書けばそちらが優先（男女兼用はここで決める）')
expect(marie_video.persona_of({}) == 'marie', 'どちらも無ければマリー（既存の依頼は変わらない）')
expect(marie_video.persona_of({'target': 'unisex', 'genre': 'gadget'}) == 'hiro', '兼用のガジェット・家電はヒロ（#221）')
expect(marie_video.persona_of({'target': 'unisex', 'genre': 'apparel'}) == 'marie', 'それ以外の兼用はマリー（#221）')
expect(marie_video.persona_of({'target': 'unisex', 'genre': 'gadget', 'category': 'cleaning'}) == 'marie', '掃除機はガジェットでもマリー（#222）')
expect(marie_video.persona_of({'target': 'unisex', 'genre': 'gadget', 'category': 'kitchen'}) == 'marie', 'キッチン用品もマリー（#222）')
expect(marie_video.persona_of({'target': 'men', 'category': 'kitchen'}) == 'hiro', '男性用と明示した物は家事の道具でもヒロ（兼用だけの規則）')
try:
    marie_video.persona_of({'target': 'kids'})
    expect(False, '知らない target は止める')
except SystemExit:
    expect(True, '知らない target は止める')
print('=== ヒロの回は代名詞を男性に（#221）===')
g = shot_plan.gendered
expect(g("She holds it next to her face; the station is behind her.", 'hiro') == "He holds it next to his face; the station is behind him.",
       'She→He・所有の her→his・目的格の her→him')
expect(g("She is filming herself. Her voice is heard off-camera.", 'hiro') == "He is filming himself. His voice is heard off-camera.",
       'herself→himself・文頭の Her→His')
expect(g("She holds it.", 'marie') == "She holds it.", 'マリーの回は変えない')
expect(g(g("She holds her phone.", 'hiro'), 'hiro') == "He holds his phone.", '2回掛けても同じ（使い回しの照合がずれない）')
_all = []
for _r in shot_plan.RULES:
    for _a in list((_r.get('still') or {}).values()) + [_r.get('must_show') or '']:
        _all.append(g(_a, 'hiro'))
_all += [g(shot_plan.LONG_CALM, 'hiro'), marie_video.situation_text({'action': 'x', 'persona': 'hiro'})]
expect(len(_all) > 20 and not any(re.search(r'\b(she|her|herself|hers)\b', t, re.I) for t in _all),
       '規則表の全ての指示文（%d本）から、ヒロの回は女性の代名詞が消える' % len(_all))
expect(set(marie_video.TARGET_PERSONA.values()) <= set(face_score.MASTERS), '担当の名前は全部、顔の基準がある')

print('=== 語尾の「ね」（#217）===')
nek = next(k for k, c in enumerate(cuts) if c['feature'] == '大きめフード')
ne = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                              lambda u, m: (1, 'ok', 'フードがね、大きいからね、頭まで隠れるね' if u == 'v%d' % nek else cuts[int(u[1:])]['line']))
expect(list(ne) == [nek] and '「ね」' in ne[nek], '台本に無い「ね」を2回以上足したカットは作り直す')
one = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                               lambda u, m: (1, 'ok', 'フードが大きいからね、頭まで隠れる' if u == 'v%d' % nek else cuts[int(u[1:])]['line']))
expect(one == {}, '「ね」1回までは自然な喋りとして通す')
expect(marie_video.situation_text(cuts[0]).endswith(marie_video.NO_NE) and 'ne (ね)' in marie_video.NO_NE,
       'Veo へ渡す場面の説明に「ね を足さない」を必ず付ける（使い回しの照合も同じ文）')

print('=== 合格済みカットの使い回し（#198）===')
marie_video.make_face_check = lambda persona=None: (lambda u, pov: None)  # 顔の判定は上で単体に確かめた。ここは通信しない
_q = []
_orig_req = marie_video._req
marie_video._req = lambda url, key, body=None, method=None: (_q.append(url) or (200, [{'id': 77}]))
still = 'https://x.supabase.co/storage/v1/object/public/images/scene/gadget/1790490103321-293fa7e9.jpg'
c0 = dict(k['cuts'][2], still_url=still)
expect(marie_video.find_reusable('https://x.supabase.co', 'k', RR35, c0) == 77, '同じ商品・同じ動きの前のクリップを拾う')
import urllib.parse as _up  # noqa: E402
qs = _up.parse_qs(_up.urlparse(_q[-1]).query)
expect(qs['product_key'] == ['eq.orage-rr35'] and qs['situation'] == ['eq.' + marie_video.situation_text(c0)[:500]], '商品と動きの指示で絞る（Veo へ渡した文と同じ）')
expect(qs['created_at'] == ['gte.2026-09-27T06:21:43Z'], '静止画ができた後の物だけ（ファイル名の時刻・差し替えた静止画の前の物は拾わない）')
expect(qs['status'] == ['neq.rejected'] and qs['video_url'] == ['not.is.null'], '却下・動画なしは拾わない')
expect(marie_video.find_reusable('https://x.supabase.co', 'k', RR35, dict(c0, still_url='https://x/hoodie/master.jpg')) is None,
       '作成時刻の読めない静止画は使い回さない（取り違えるより作る）')
marie_video._req = lambda url, key, body=None, method=None: (200, [])
expect(marie_video.find_reusable('https://x.supabase.co', 'k', RR35, c0) is None, '無ければ作る')
marie_video._req = _orig_req

# 通しで：コードレス・ステーション・CTA は使い回して合格、フックは使い回したが言い方が古い → 数えずに新しく作る
import json as _j0  # noqa: E402
import tempfile as _t0  # noqa: E402
_keep = {n: getattr(marie_video, n) for n in ('_base_and_key', 'find_reusable', 'start_cut', 'wait_all', 'verify_cut', 'START_GAP_SEC')}
RR35_S = dict(RR35, stills={kk: 'https://x/scene/gadget/1790490103321-293fa7e9.jpg' for kk in RR35['stills']})
kp = shot_plan.plan(RR35_S)['cuts']
old = {0: 900, 2: 902, 3: 903, 5: 905}          # フック・コードレス・ステーション・CTA に前のクリップがある
said_of = {900: 'ゴミ捨てって最大約5ヶ月いらないって'}  # 前のフックは古い言い方
new_ids = iter(range(1000, 1100))
started_cuts = []
marie_video._base_and_key = lambda: ('https://x.supabase.co', 'k')
marie_video.START_GAP_SEC = 0
marie_video.find_reusable = lambda b, kk, p, c: old.get(kp.index(next(x for x in kp if x['action'] == c['action'] and x['line'] == c['line'])))
new_line = {}
def _start(b, kk, p, c):
    started_cuts.append(c['line'])
    i = next(new_ids)
    new_line[i] = c['line']
    return i
marie_video.start_cut = _start
marie_video.wait_all = lambda b, kk, ids: {i: {'video_url': 'u%d' % i} for i in ids}
def _verify(b, kk, url, ms):
    i = int(url[1:])
    if i in said_of:
        return 1, 'ok', said_of[i]
    line = next((c['line'] for n, c in enumerate(kp) if old.get(n) == i), None)
    return 1, 'ok', line or new_line[i]
marie_video.verify_cut = _verify
with _t0.TemporaryDirectory() as td:
    pj, oj = os.path.join(td, 'p.json'), os.path.join(td, 'j.json')
    _j0.dump(RR35_S, open(pj, 'w'))
    sys.argv = ['marie_video.py', pj, oj]
    try:
        marie_video.main()
        jb = _j0.load(open(oj))['job']
    except SystemExit as e:
        jb = None
        print('     止まった: %s' % e)
for n, v in _keep.items():
    setattr(marie_video, n, v)
expect(jb is not None and jb['review']['clip_ids'][2:4] == [902, 903] and jb['review']['clip_ids'][5] == 905,
       '合格した前のクリップはそのまま描画に使う')
expect(kp[0]['line'] in started_cuts and kp[1]['line'] in started_cuts and kp[2]['line'] not in started_cuts,
       'Veo を起動するのは、前が無いカットと、前の言い方が古いカットだけ')

print('=== 手元のクリップで通す試験の口（reuse_ids）===')
import json as _json  # noqa: E402
import tempfile  # noqa: E402
_orig = {k: getattr(marie_video, k) for k in ('_base_and_key', 'start_cut', 'wait_all', 'verify_cut')}
started = []
marie_video._base_and_key = lambda: ('https://x.supabase.co', 'k')
marie_video.start_cut = lambda *a: started.append(a) or 999
marie_video.wait_all = lambda base, key, ids: {i: {'video_url': 'u%d' % i} for i in ids}
# ★どのカットも言うべき語を言った体（#193 の照合を通す）
marie_video.verify_cut = lambda base, key, url, ms: (1, 'ok', p['cuts'][int(url[1:]) - 100]['line'])
with tempfile.TemporaryDirectory() as td:
    pj, oj = os.path.join(td, 'p.json'), os.path.join(td, 'j.json')
    _json.dump(dict(REDIAL, reuse_ids=list(range(100, 100 + len(p['cuts'])))), open(pj, 'w'))
    sys.argv = ['marie_video.py', pj, oj]
    marie_video.main()
    job = _json.load(open(oj))['job']
    expect(not started, 'reuse_ids の回は Veo を1本も起動しない')
    expect(len(job['clips']) == len(p['cuts']), '描画の依頼まで作る（カット数ぶんのクリップ）')
    expect(job.get('review', {}).get('clip_ids') == list(range(100, 100 + len(p['cuts']))),
           '完成後に LINE で承認を求める素材番号を依頼に載せる（#191）')
    _json.dump(dict(REDIAL, reuse_ids=[1, 2]), open(pj, 'w'))
    try:
        marie_video.main()
        expect(False, '本数が合わない reuse_ids は止める')
    except SystemExit:
        expect(True, '本数が合わない reuse_ids は止める')
for k, v in _orig.items():
    setattr(marie_video, k, v)

print('=== カット番号 → 秒 ===')
wins = speech_qa.part_windows([5.63, 3.55, 4.25], 0.0)
tc = speech_qa.timed_by_cut([{'text': 'a', 'cut_index': 1}, {'text': 'b', 'start': 1, 'end': 2},
                             {'text': 'c', 'cut_index': 9}], wins)
expect(abs(tc[0]['start'] - 5.78) < 1e-6 and abs(tc[0]['end'] - 9.03) < 1e-6, '2カット目の中へ収める')
expect(tc[1] == {'text': 'b', 'start': 1, 'end': 2}, '秒指定はそのまま')
expect(len(tc) == 2, '範囲外のカット番号は捨てる')

print('=== シーンの長さはセリフに合わせる（#223）===')
expect(shot_plan.fit_seconds('あ' * 27) == 6 and shot_plan.fit_seconds('あ' * 28) == 8, '27文字までは6秒、28文字からは8秒（4.5文字/秒）')
expect(shot_plan.fit_seconds('あ' * shot_plan.JA_CHARS_LONG) == shot_plan.LONG_SECONDS, '上限の文字数は8秒に入る')
_rr = shot_plan.plan_long(dict(RR35, layout='long'))
_pair = [c for c in _rr['cuts'] if len(shot_plan.says(c)) == 2 and c['role'] == 'feature']
expect(_pair and all(c['seconds'] == 6 for c in _pair) and all(len(c['line']) <= 27 for c in _pair),
       'RR35 の2機能のシーン（26文字）は6秒に縮む')
expect(all(c['seconds'] in (4, 6, 8) for c in _rr['cuts']), '長さは作れたことのある 4・6・8秒だけ')
print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
