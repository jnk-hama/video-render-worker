#!/usr/bin/env python3
"""
生成画像が「アンナ本人か」を数値で判定する。

★★2026-09-01、AIインフルエンサーの一貫性検証のために作った。

【なぜ目視で判定しないか】
「同じ顔に見えるか」は人によって割れる。25枚を毎回人が見るのも続かない。
InsightFace の埋め込みのコサイン類似度なら、同じ入力から必ず同じ数字が出る。

【合格ラインを 0.42 にした根拠（実測）】
マスター画像はアンナ7方向の1枚絵。**同一人物であることが確定している**ので、
7枚の相互類似度を測れば「本人でもこれだけ落ちる」下限が分かる。

  7枚の相互類似度（21通り）: 最小 0.343 / 中央値 0.485 / 最大 0.650

角度差が大きいほど下がる。横顔と正面は 0.372 しかない。
つまり **1枚とだけ比べる方式は誤り**で、本人ですら不合格になる。

そこで **7枚すべてと比べて最大値を取る**。各ビューが他6枚に対して出す
最大類似度の最小値は **0.428**（見上げの構図）。
本人の最も不利な角度がこの値なので、これを下回れば別人と判断できる。

★この数字はマスター画像を差し替えたら測り直すこと。
  scripts/face_score.py --calibrate で再計算できる。
"""

import os
import subprocess
import sys

PASS_THRESHOLD = 0.42
# ★★2026-09-12（決定#147）、en/ → shared/ へ移した。
#
# 【なぜ】オーナー指示「前に生成したAIインフルエンサーを使えばいい」（日本市場）。
#   ところが決定#082の構造では、ja の依頼が assets/en/... を指すと
#   **描かずに停止する**。置き場所のせいで使えなかった。
# ★そもそも彼女は**日本人に見える**。Aライン専用に置いたのが誤りだった。
#   #082が防ぎたかったのは「水着のモデル映像が日本語の商品紹介に混ざる」
#   ような**内容の食い違い**であって、日本人の人物像はどちらでも使える。
#   → shared/ が正しい置き場所。#082の構造自体は変えていない。
REF_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'assets', 'shared', 'influencer', 'anna')

_app = None


def _analyzer():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis
        _app = FaceAnalysis(name='buffalo_l',
                            providers=['CPUExecutionProvider'])
        _app.prepare(ctx_id=-1, det_size=(640, 640))
    return _app


def embeddings(path):
    """
    画像から顔の埋め込みを全部返す。顔が無ければ空。

    ★ffmpegで読む。OpenCVを足すと依存が増えるうえ、
      描画側で既にffmpegを使っているので揃えた方がよい。
    """
    import numpy as np
    dim = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path],
        capture_output=True, text=True).stdout.strip().split('x')
    w, h = int(dim[0]), int(dim[1])
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-pix_fmt', 'bgr24',
         '-f', 'rawvideo', '-'], capture_output=True).stdout
    if len(raw) < w * h * 3:
        return []
    img = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3).copy()
    return [f.normed_embedding for f in _analyzer().get(img)]


def reference_set():
    """マスターの7方向を読み込む。1枚ではなく全部使う（上の説明を参照）。"""
    out = []
    for fn in sorted(os.listdir(REF_DIR)):
        if fn.startswith('_') or not fn.lower().endswith(('.jpg', '.png')):
            continue
        for e in embeddings(os.path.join(REF_DIR, fn)):
            out.append((fn, e))
    return out


def score(path, refs=None):
    """
    @return {?dict} 顔が無ければ None
      best      … 7枚に対する最大類似度
      matched   … どのビューと最も近かったか
      passed    … 合格したか
    """
    import numpy as np
    refs = refs or reference_set()
    es = embeddings(path)
    if not es:
        return None
    best, who = -1.0, ''
    for e in es:
        for fn, r in refs:
            s = float(np.dot(np.array(e), np.array(r)))
            if s > best:
                best, who = s, fn
    return {'best': best, 'matched': who,
            'passed': best >= PASS_THRESHOLD, 'faces': len(es)}


def calibrate():
    """マスター7枚の相互類似度から合格ラインを引き直す。"""
    import numpy as np
    refs = reference_set()
    n = len(refs)
    floor = 1.0
    print('マスター %d枚の相互類似度' % n)
    for i in range(n):
        best = max(float(np.dot(np.array(refs[i][1]), np.array(refs[j][1])))
                   for j in range(n) if j != i)
        floor = min(floor, best)
        print('  %-16s 他への最大 %.3f' % (refs[i][0], best))
    print()
    print('合格ラインの根拠: 最も不利なビューでも %.3f 出る' % floor)
    print('→ PASS_THRESHOLD は %.2f 前後が妥当' % (floor - 0.01))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--calibrate':
        calibrate()
        raise SystemExit
    refs = reference_set()
    print('%-40s %-7s %-16s %s' % ('画像', '類似度', '最も近いビュー', '判定'))
    for p in sys.argv[1:]:
        r = score(p, refs)
        if not r:
            print('%-40s %s' % (os.path.basename(p), '顔を検出できず'))
            continue
        print('%-40s %-7.3f %-16s %s'
              % (os.path.basename(p), r['best'], r['matched'],
                 '合格' if r['passed'] else '不合格'))
