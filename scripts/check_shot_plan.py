#!/usr/bin/env python3
"""
shot_plan（商品ごとのカット選び・決定#182）を検証する。
★入力は本物の商品（REDIAL redial-850019）の売り文句と、本番で使った静止画の種類。
使い方: python3 scripts/check_shot_plan.py
"""
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
expect(p['panel'] and p['panel']['title'] == '2色' and p['panel']['cut_index'] == len(p['cuts']) - 1,
       '色展開は最後の実画像パネルの見出しへ。前のカードで出したサイズは繰り返さない（#184）')
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

print('=== 規則表そのもの ===')
for rule in shot_plan.RULES + [shot_plan.FALLBACK_HOOK, shot_plan.CTA]:
    lim = shot_plan.JA_CHARS_4S * (shot_plan.HOOK_SECONDS if rule.get('hook') else 4) // 4
    ok = len(rule['line']) <= lim and not any(ch in rule['line'] for ch in '?？「」"\n')
    expect(ok, 'セリフ「%s」は尺内・記号なし' % rule['line'])
    expect(not speech_qa.check_speech([[{'text': rule['line'], 'start': 0, 'end': 1}]], [{}], 'ja'),
           'セリフ「%s」は喋りの検査（です終わり・体験談）を通る' % rule['line'])

print('=== 描画の依頼 ===')
job = shot_plan.render_job(REDIAL, p, ['u%d' % i for i in range(len(p['cuts']))], 'preview/x.mp4')['job']
expect([c['cut_index'] for c in job['info_cards']] == [i for i, c in enumerate(p['cuts']) if c.get('card')],
       'カードはカット番号で指定（秒は描画側で解く）')
expect(job['quality_gate'] == 'block', '自動の回は検査で止める（warn にしない）')
expect(job['speech_speed'] == shot_plan.SPEECH_SPEED > 1.0, '喋りは少し速く（#183）')
expect(not any('すっぽり' in r['line'] for r in shot_plan.RULES), '崩れて読まれた語（すっぽり）を規則表に置かない')

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
    calls.append(url)
    return (0, 'bare fingers') if url == 'v%d' % sleeve else (1, 'ok')


got = {i: {'video_url': 'v%d' % i} for i in ids}
got[0] = {'video_url': None}
bad = marie_video.redo_targets(cuts, got, ids, fake_verify)
expect(set(bad) == {0, sleeve}, '動画なし（フィルタ）と絵のずれ（袖）の両方を作り直しに回す')
expect('bare fingers' in bad[sleeve], '作り直しの理由に「実際に映っていた物」を残す')
expect(sorted(calls) == sorted('v%d' % k for k in ids if k and cuts[k].get('must_show')),
       'must_show の無いカット（フック・CTA）は判定しない（判定も有料）')
expect(marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                                lambda u, m: (1, 'ok')) == {}, '全部映っていれば作り直さない')

print('=== カット番号 → 秒 ===')
wins = speech_qa.part_windows([5.63, 3.55, 4.25], 0.0)
tc = speech_qa.timed_by_cut([{'text': 'a', 'cut_index': 1}, {'text': 'b', 'start': 1, 'end': 2},
                             {'text': 'c', 'cut_index': 9}], wins)
expect(abs(tc[0]['start'] - 5.78) < 1e-6 and abs(tc[0]['end'] - 9.03) < 1e-6, '2カット目の中へ収める')
expect(tc[1] == {'text': 'b', 'start': 1, 'end': 2}, '秒指定はそのまま')
expect(len(tc) == 2, '範囲外のカット番号は捨てる')

print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
