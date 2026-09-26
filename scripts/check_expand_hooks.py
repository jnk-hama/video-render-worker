#!/usr/bin/env python3
"""
expand_hooks（フック差し替え工場の展開）を検証する（決定#177）。

使い方: python3 scripts/check_expand_hooks.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from expand_hooks import expand  # noqa: E402

fails = []


def expect(cond, msg):
    print(('  OK   ' if cond else '  NG   ') + msg)
    if not cond:
        fails.append(msg)


def raises(fn):
    try:
        fn()
    except SystemExit:
        return True
    return False


base = {'job': {
    'job_id': 'marie-redial-ja-v3', 'clip_audio': True, 'captions_from_speech': True,
    'clips': [{'url': 'H0'}, {'url': 'B1'}, {'url': 'B2'}],
    'upload': {'bucket': 'videos', 'path': 'preview/marie-redial-ja-v3.mp4'},
}}

print('=== 従来の依頼は素通り ===')
plain = {'job': {'job_id': 'x', 'clips': [{'url': 'a'}]}}
r = expand(plain)
expect(len(r) == 1 and r[0][1] is plain, 'hook_variants が無ければ1本・中身も同じ物')

print('=== 展開 ===')
v = dict(base, job=dict(base['job'], hook_variants=[{'url': 'H1'}, {'url': 'H2'}]))
r = expand(v)
expect([i for i, _ in r] == ['marie-redial-ja-v3-h1', 'marie-redial-ja-v3-h2',
                             'marie-redial-ja-v3-h3'], '元のフック＋差し替え2本＝3本・名前に -hN')
expect([p['job']['clips'][0]['url'] for _, p in r] == ['H0', 'H1', 'H2'], '先頭だけ差し替わる')
expect(all([c['url'] for c in p['job']['clips'][1:]] == ['B1', 'B2'] for _, p in r),
       '本編のカットは全部同じ')
expect([p['job']['upload']['path'] for _, p in r] ==
       ['preview/marie-redial-ja-v3-h1.mp4', 'preview/marie-redial-ja-v3-h2.mp4',
        'preview/marie-redial-ja-v3-h3.mp4'], '保存先が別々（上書きしない）')
expect(all('hook_variants' not in p['job'] for _, p in r), '展開後の依頼に hook_variants を残さない')
expect(v['job']['clips'][0]['url'] == 'H0' and 'hook_variants' in v['job'], '元の依頼を書き換えない')

print('=== 止めるべき依頼 ===')
no_speech = {'job': dict(v['job'], captions_from_speech=False)}
expect(raises(lambda: expand(no_speech)), 'captions_from_speech が無いと止める（字幕が古いフックのまま残る）')
too_many = {'job': dict(v['job'], hook_variants=[{'url': 'h'}] * 6)}
expect(raises(lambda: expand(too_many)), '6本以上は止める')
bad = {'job': dict(v['job'], hook_variants=['H1'])}
expect(raises(lambda: expand(bad)), 'clip の形でないものは止める')

print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
