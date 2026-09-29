#!/usr/bin/env python3
"""
本番が止まった時に、オーナーの LINE へ理由を1通送る（決定#228）。

  python3 scripts/notify_stop.py <題名> <ログのファイル>

★9/29、2本とも検査で止まったのに何も届かず、オーナーは LINE を待っていた（#227）。止まったら必ず知らせる。
★理由はログの末尾から拾う（止めた理由の行を優先。無ければ最後の数行）。警告の雑音は除く。
★送れなくても工程の結果は変えない（ここで失敗を上書きしない）。送れなかったことはログに残す。
"""
import json
import os
import re
import sys
import urllib.request

KEYS = ('止めました', '起動できません', '作り直します', '使い回せません', '品質検査', '検査で', 'Error', 'error', 'HTTP 429')
NOISE = re.compile(r'FutureWarning|tform\.estimate|^\s*$|INFO:|WARNING:|W0000|inference_feedback|landmark_projection')
MAX_LINES = 8


def reason_from(log_text):
    lines = [re.sub(r'^\S+Z\s', '', l).rstrip() for l in log_text.splitlines()]
    lines = [l for l in lines if not NOISE.search(l)]
    keyed = [l for l in lines if any(k in l for k in KEYS)]
    pick = (keyed or lines)[-MAX_LINES:]
    return '\n'.join(l.strip()[:160] for l in pick) or '（理由をログから読めませんでした。Actions のログを見てください）'


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    title, log_path = sys.argv[1], sys.argv[2]
    try:
        text = open(log_path, encoding='utf-8', errors='replace').read()
    except OSError:
        text = ''
    reason = reason_from(text)
    base = (os.environ.get('SUPABASE_URL') or '').strip().rstrip('/')
    key = (os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or '').strip()
    print('止まった理由（LINE へ送る内容）:\n' + reason)
    if not base or not key:
        print('::warning::SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無いので LINE へ送れません')
        return 0
    req = urllib.request.Request(base + '/functions/v1/video-scene',
                                 data=json.dumps({'action': 'notify_stop', 'title': title, 'reason': reason}).encode(),
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('LINE へ送りました: %s' % r.read().decode()[:200])
    except Exception as e:  # noqa: BLE001 — 送れなかったことを残すだけ。工程の結果は変えない
        body = e.read().decode()[:300] if hasattr(e, 'read') else ''
        print('::warning::LINE へ送れませんでした: %s %s' % (e, body))
    return 0


if __name__ == '__main__':
    sys.exit(main())
