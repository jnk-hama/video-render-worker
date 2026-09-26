#!/usr/bin/env python3
"""
pip の版固定（constraints.txt・決定#188）が外れていないかを見る。
  1. ワークフローの pip install が全部 -c constraints.txt を付けている
  2. そこで入れるパッケージが全部 constraints.txt に版つきで載っている
  3. Actions の uses: が全部コミットSHA（40桁）で固定されている（タグは付け替えられる・Shai-Hulud）
★ワークフローが1件も読めない・pip install が0件なら不合格（空振りを合格にしない・E-021）。
使い方: python3 scripts/check_pins.py
"""
import glob
import re
import sys

pins = {}
for line in open('constraints.txt', encoding='utf-8'):
    m = re.match(r'([A-Za-z0-9_.\-]+)==(\S+)', line.strip())
    if m:
        pins[re.sub(r'[-_.]+', '-', m.group(1).lower())] = m.group(2)

fails = []
installs = 0
for path in sorted(glob.glob('.github/workflows/*.yml')):
    text = open(path, encoding='utf-8').read().replace('\\\n', ' ')
    for m in re.finditer(r'pip install ([^\n]*)', text):
        installs += 1
        args = m.group(1).split()
        if '-c' not in args or args[args.index('-c') + 1] != 'constraints.txt':
            fails.append('%s: -c constraints.txt が無い: pip install %s' % (path, m.group(1)[:80]))
            continue
        skip = False
        for a in args:
            if skip:
                skip = False
                continue
            if a == '-c':
                skip = True
                continue
            if a.startswith('-'):
                continue
            name = re.sub(r'[-_.]+', '-', re.split(r'[<>=\[]', a)[0].lower())
            if name not in pins:
                fails.append('%s: %s の版が constraints.txt に無い' % (path, a))

uses = 0
for path in sorted(glob.glob('.github/workflows/*.yml')):
    for m in re.finditer(r'uses:\s*(\S+)', open(path, encoding='utf-8').read()):
        uses += 1
        ref = m.group(1)
        if not ref.startswith('./') and not re.search(r'@[0-9a-f]{40}$', ref):
            fails.append('%s: %s がSHAで固定されていない' % (path, ref))

print('pin: %d件 / pip install: %d箇所 / uses: %d箇所' % (len(pins), installs, uses))
if not pins or not installs or not uses:
    print('★constraints.txt かワークフローを読めていません。検査になっていません')
    sys.exit(1)
for f in fails:
    print('  NG   ' + f)
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格（全ての pip install が固定した版を使う）')
