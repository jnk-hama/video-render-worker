#!/usr/bin/env python3
"""
フック差し替え工場（決定#177・2026-09-26）。1つの依頼を「フック違いの N 本」へ展開する。

【なぜ】売れているアフィリエイターは、当たった1本の**冒頭だけ**を変えて3〜5本出す
（オーナー承認 2026-09-26）。本編のカットは使い回すので、増えるのは
フック1カットの生成費（約$0.3）だけ。描画は GitHub Actions なので0円。

【依頼の形】job.hook_variants = [clip, clip, ...]（clips[0] と同じ形）
  → 出力は 1 + len(hook_variants) 本。
     -h1 … 元の clips[0]（そのまま）
     -h2〜 … clips[0] を hook_variants の各要素に差し替えたもの
  job_id と upload.path に -hN を付ける（別々に保存し、上書きしない）。

★captions_from_speech を必須にする。字幕を手で渡す回にフックだけ差し替えると、
  1枚目の字幕が古いフックの言葉のまま残る（喋りと字幕の食い違い＝E-033 の再演）。
★hook_variants が無い依頼は**1本のまま素通り**（従来の依頼を変えない）。
"""

import copy
import json
import re
import sys

MAX_VARIANTS = 5


def _suffix_path(path, tag):
    m = re.match(r'^(.*?)(\.[A-Za-z0-9]+)?$', path)
    return '%s-%s%s' % (m.group(1), tag, m.group(2) or '')


def expand(payload):
    """@return [(id, payload_dict)]。payload は {"job": {...}} でも平置きでもよい。"""
    wrapped = isinstance(payload.get('job'), dict)
    job = payload['job'] if wrapped else payload
    variants = job.get('hook_variants') or []
    base_id = str(job.get('job_id') or '')
    if not variants:
        return [(base_id, payload)]
    if not isinstance(variants, list) or not all(isinstance(v, dict) and v.get('url')
                                                 for v in variants):
        raise SystemExit('hook_variants は clip（url を持つ辞書）の配列です')
    if len(variants) > MAX_VARIANTS:
        raise SystemExit('hook_variants は %d 本までです（%d 本）' % (MAX_VARIANTS, len(variants)))
    if not job.get('captions_from_speech'):
        raise SystemExit('hook_variants には captions_from_speech: true が要ります'
                         '（手書きの字幕だと1枚目が古いフックの言葉のまま残る）')
    clips = job.get('clips') or []
    if not clips:
        raise SystemExit('clips が空です')
    out = []
    for k, hook in enumerate([clips[0]] + variants, start=1):
        j = copy.deepcopy(job)
        j.pop('hook_variants', None)
        j['clips'] = [copy.deepcopy(hook)] + copy.deepcopy(clips[1:])
        tag = 'h%d' % k
        j['job_id'] = '%s-%s' % (base_id, tag)
        up = j.get('upload') or {}
        if up.get('path'):
            up['path'] = _suffix_path(str(up['path']), tag)
        out.append((j['job_id'], {'job': j} if wrapped else j))
    return out


if __name__ == '__main__':
    # 使い方: expand_hooks.py payload.json  → GITHUB_OUTPUT 用に items=<JSON> を1行出す
    items = [{'id': i, 'payload': json.dumps(p, ensure_ascii=False)}
             for i, p in expand(json.load(open(sys.argv[1])))]
    print('items=%s' % json.dumps(items, ensure_ascii=False))
    print('count=%d' % len(items))
