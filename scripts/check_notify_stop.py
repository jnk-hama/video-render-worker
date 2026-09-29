#!/usr/bin/env python3
"""notify_stop.py の検査（決定#228）。止まった理由を実際のログの形から拾えるか、工程に本当に配線されているかを見る。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify_stop  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = ran = 0


def expect(name, cond):
    global fails, ran
    ran += 1
    print('  %s %s' % ('OK  ' if cond else '★NG ', name))
    fails += 0 if cond else 1


# 9/29 のカベーニの実際のログ（抜粋・原文）
LOG = """2026-09-29T07:32:50.0167383Z /home/runner/.local/lib/python3.12/site-packages/insightface/utils/face_align.py:23: FutureWarning: `estimate` is deprecated
2026-09-29T07:32:50.0172562Z   tform.estimate(lmk, dst)
2026-09-29T07:32:54.0691147Z 描画の前で止めました: カット1 本人（marie）ではない顔（5.5秒・類似度 0.28）
2026-09-29T07:32:54.0692832Z   照合 OK: The image on the ceiling is directly above the projector
2026-09-29T07:32:54.0694219Z   顔 NG: 本人（marie）ではない顔（5.5秒・類似度 0.28）
"""
r = notify_stop.reason_from(LOG)
expect('止めた理由の行を拾う', '描画の前で止めました' in r)
expect('警告の雑音（FutureWarning・tform）は送らない', 'FutureWarning' not in r and 'tform' not in r)
expect('時刻の頭は外す', '2026-09-29T' not in r)
r429 = notify_stop.reason_from('Veo を起動できません（hook・最大約4〜5か月ゴミ捨て不要・HTTP 502）: HTTP 429 {\n  "status": "RESOURCE_EXHAUSTED"\n')
expect('枠切れ（429）の理由を拾う', 'HTTP 429' in r429)
expect('ログが空でも黙らない（Actions のログを見るよう書く）', 'ログ' in notify_stop.reason_from(''))
expect('長いログでも 8 行まで', len(notify_stop.reason_from('\n'.join('作り直します %d' % i for i in range(50))).splitlines()) == 8)

mv = open(os.path.join(ROOT, '.github/workflows/marie-video.yml'), encoding='utf-8').read()
rv = open(os.path.join(ROOT, '.github/workflows/render-video.yml'), encoding='utf-8').read()
expect('marie-video は止まったら（failure()）notify_stop を呼ぶ', 'failure()' in mv and 'scripts/notify_stop.py' in mv)
expect('marie-video は本番のログを run.log に残す', 'tee run.log' in mv)
expect('render-video は止まったら notify_stop を呼ぶ（マリーの依頼だけ）', 'failure()' in rv and 'scripts/notify_stop.py "描画で停止"' in rv and "j.get('review')" in rv)
expect('render-video は描画と品質検査のログを render.log に残す', 'tee render.log' in rv and 'tee -a render.log' in rv)

print()
if ran < 10 or fails:
    print('不合格 %d 件（%d 件中）' % (fails, ran))
    sys.exit(1)
print('合格（%d 件）' % ran)
