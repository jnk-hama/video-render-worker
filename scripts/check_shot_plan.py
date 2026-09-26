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
    return (0, 'bare fingers', 'x') if url == 'v%d' % sleeve else (1, 'ok', 'ふつうのセリフ')


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
                                lambda u, m: (1, 'ok', 'サイズ大きめで、シルエットかわいい')) == {}, '全部映っていて喋りも普通なら作り直さない')
pol = marie_video.redo_targets(cuts, {i: {'video_url': 'v%d' % i} for i in ids}, ids,
                               lambda u, m: (1, 'ok', '下からも開くからね、座っても楽です。' if u == 'v3' else 'ふつう'))
expect(list(pol) == [3] and '丁寧語' in pol[3], '言い終わりが「です」のカットは作り直しに回す（#189）')

print('=== 手元のクリップで通す試験の口（reuse_ids）===')
import json as _json  # noqa: E402
import tempfile  # noqa: E402
_orig = {k: getattr(marie_video, k) for k in ('_base_and_key', 'start_cut', 'wait_all', 'verify_cut')}
started = []
marie_video._base_and_key = lambda: ('https://x.supabase.co', 'k')
marie_video.start_cut = lambda *a: started.append(a) or 999
marie_video.wait_all = lambda base, key, ids: {i: {'video_url': 'u%d' % i} for i in ids}
marie_video.verify_cut = lambda base, key, url, ms: (1, 'ok', 'ふつう')
with tempfile.TemporaryDirectory() as td:
    pj, oj = os.path.join(td, 'p.json'), os.path.join(td, 'j.json')
    _json.dump(dict(REDIAL, reuse_ids=list(range(100, 100 + len(p['cuts'])))), open(pj, 'w'))
    sys.argv = ['marie_video.py', pj, oj]
    marie_video.main()
    job = _json.load(open(oj))['job']
    expect(not started, 'reuse_ids の回は Veo を1本も起動しない')
    expect(len(job['clips']) == len(p['cuts']), '描画の依頼まで作る（カット数ぶんのクリップ）')
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

print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
