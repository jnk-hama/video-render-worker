#!/usr/bin/env python3
"""
生成画像の「手が破綻していないか」「商品を握れているか」を数値で判定する。

★★2026-09-01、カットB（手元の寄り）の検証のために作った。

【なぜ要るか】
AI生成の手は2026年でも破綻する。指が6本ある動画を自動投稿したら終わりである。
既存の「採点60点の足切り」と同じ思想で、投稿前に機械が捨てる。

【★この採点器にできないこと（最初に書く）】
**指の本数は数えられません。** MediaPipe Hands は必ず21点を返す設計で、
6本指の手にも21点を当てはめてしまう。「指が6本ある画像を弾く」という
当初の要件は、**この方式では原理的に実装できません**。

実測（Geminiの参考動画と自作合成の6枚）でも、正常な握りの
「指の長さ÷手のひら幅」は 0.42〜1.45 に広く散らばり、
良品と破綻を比だけで分けることはできませんでした。
当初 1.45 を上限に置いたところ、**良品をちょうど切っていました**。

したがって本採点器の役割は「粗い足切り」に限定します。
指の本数の検査は、別の手段（人の目、または別モデル）が要ります。
**ここは未解決の課題として残します。**

【できること：粗い足切り】
1. 手が検出できない → 落とす
2. 寄りのカットなのに手が2つ以上ある → 落とす
3. 極端に壊れた形状（比が0.30未満/1.70超）→ 落とす
   ※実測の良品範囲 0.42〜1.45 の外側に余裕を取った値。
     6枚しか測っていないので、パイロットの20枚で引き直すこと。

2. 回り込み … 商品の領域を手が **分断** しているか。
   握っていれば、指が商品の手前に来て商品領域が上下に割れる。
   ただ手前に置いただけなら商品は1つの塊のまま残る。
   **これが「ペラペラの紙」と「握っている」を分ける唯一の機械的な差**。
"""

import os
import subprocess
import sys

POSE_MODEL = '/root/.mp/hand.task'
MODEL_URL = ('https://storage.googleapis.com/mediapipe-models/hand_landmarker/'
             'hand_landmarker/float16/1/hand_landmarker.task')

# 指の付け根→指先 の並び（MediaPipe Hands の21点）
FINGERS = [(1, 4), (5, 8), (9, 12), (13, 16), (17, 20)]


def ensure_model():
    if os.path.exists(POSE_MODEL):
        return True
    os.makedirs(os.path.dirname(POSE_MODEL), exist_ok=True)
    subprocess.run(['curl', '-sSL', '--max-time', '120',
                    '-o', POSE_MODEL, MODEL_URL], check=False)
    return os.path.exists(POSE_MODEL)


def read_bgr(path):
    import numpy as np
    dim = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path],
        capture_output=True, text=True).stdout.strip().split('x')
    w, h = int(dim[0]), int(dim[1])
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-pix_fmt', 'rgb24',
         '-f', 'rawvideo', '-'], capture_output=True).stdout
    if len(raw) < w * h * 3:
        return None, 0, 0
    return np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3).copy(), w, h


def check_hand(path):
    """
    @return {?dict} 手が見つからなければ None
      hands       … 検出された手の数
      fingers_ok  … 極端な破綻が無いか（**本数の検査ではない**）
      reason      … 落ちた理由
    """
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks import python as mpy
    from mediapipe.tasks.python import vision
    if not ensure_model():
        return None
    img, w, h = read_bgr(path)
    if img is None:
        return None
    lmk = vision.HandLandmarker.create_from_options(
        vision.HandLandmarkerOptions(
            base_options=mpy.BaseOptions(model_asset_path=POSE_MODEL),
            running_mode=vision.RunningMode.IMAGE,
            num_hands=2))
    r = lmk.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=img))
    if not r.hand_landmarks:
        return {'hands': 0, 'fingers_ok': False, 'reason': '手を検出できず'}

    n = len(r.hand_landmarks)
    if n != 1:
        return {'hands': n, 'fingers_ok': False,
                'reason': '手が%d個ある（寄りのカットは1個であるべき）' % n}

    p = r.hand_landmarks[0]

    """
    ★指の長さで破綻を見る。
      MediaPipeは破綻した手にも21点を返すので、点の数では判定できない。
      正常な手なら、各指の「付け根→指先」の長さは手のひらの幅に対して
      一定の比の範囲に収まる。極端に短い／長い指があれば破綻とみなす。
    """
    palm = ((p[0].x - p[5].x) ** 2 + (p[0].y - p[5].y) ** 2) ** 0.5
    if palm <= 0:
        return {'hands': 1, 'fingers_ok': False, 'reason': '手のひらを測れず'}
    bad = []
    for i, (a, b) in enumerate(FINGERS):
        ln = ((p[a].x - p[b].x) ** 2 + (p[a].y - p[b].y) ** 2) ** 0.5
        ratio = ln / palm
        # 親指は短い。他の指はこの範囲を外れたら異常
        # ★実測の良品範囲 0.42〜1.45 の外側に余裕を取る。
        #   ここを狭めると良品を切る（実際に1.45で切ってしまった）。
        lo, hi = (0.30, 1.70)
        if not (lo <= ratio <= hi):
            bad.append('%d番目の指の比 %.2f' % (i + 1, ratio))
    return {'hands': 1, 'fingers_ok': not bad,
            'reason': '／'.join(bad) if bad else 'OK'}


def check_wrap(path, product_mask=None):
    """
    商品が手に「分断」されているかを見る。

    ★握っていれば指が商品の手前に来て、商品の領域が2つ以上に割れる。
      手前に置いただけなら1つの塊のまま。ここが機械的に分かる唯一の差。

    @param product_mask 商品領域の白黒マスク。無ければ判定しない
    """
    if not product_mask or not os.path.exists(product_mask):
        return {'wrap': None, 'reason': '商品マスクが無いため未判定'}
    img, w, h = read_bgr(product_mask)
    if img is None:
        return {'wrap': None, 'reason': 'マスクを読めず'}

    # 横方向に走査し、商品領域が何回途切れるかを数える
    breaks = 0
    for y in range(0, h, max(1, h // 60)):
        run, segs = False, 0
        for x in range(0, w, max(1, w // 120)):
            on = img[y][x][0] > 127
            if on and not run:
                segs += 1
            run = on
        if segs >= 2:
            breaks += 1
    return {'wrap': breaks >= 3,
            'reason': '商品が分断された走査行 %d本' % breaks}


if __name__ == '__main__':
    mask = None
    args = sys.argv[1:]
    if '--mask' in args:
        i = args.index('--mask')
        mask = args[i + 1]
        args = args[:i] + args[i + 2:]
    print('%-34s %-6s %-8s %s' % ('画像', '手', '指', '判定理由'))
    for p in args:
        h = check_hand(p)
        if not h:
            print('%-34s %s' % (os.path.basename(p), '読めず'))
            continue
        w = check_wrap(p, mask)
        ok = h['fingers_ok'] and (w['wrap'] is not False)
        print('%-34s %-6d %-8s %s / %s'
              % (os.path.basename(p), h['hands'],
                 '正常' if h['fingers_ok'] else '破綻',
                 h['reason'], w['reason']))
        print('%-34s → %s' % ('', '合格' if ok else '不合格'))
