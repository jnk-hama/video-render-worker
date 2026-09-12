#!/usr/bin/env python3
"""
1本の動画に使う画で、**服が変わっていないか**を機械で見る（決定#148）。

★★2026-09-12、オーナー指摘。
  「色々服が変わってるのは不自然です。1本の動画で服装は統一」

  生成した3枚は、ベージュのニット／グレーのスウェット／白Tシャツと
  毎回違う服だった。同じ人が同じ日に喋っているはずの動画で服が3回変わると、
  **別々の日に撮った切り貼りに見える。**

【なぜ機械で見るか】
指示文に「同じ服にしろ」と書いても、守ったかどうかは別の話である。
顔は face_score.py で見ているのに、服は目視で見逃していた。
**同じ失敗を繰り返さないために、数で残す。**

【どう測るか — 顔の位置から胴体を切る】
服そのものを認識するのは難しい。だが「顔の下に胴体がある」ことは確かなので、
顔の枠を基準に胴体の帯を切り出し、**色の分布**を比べる。

  帯の位置 … 顔の下端から、顔の高さの 0.6〜2.2 倍の範囲
  帯の幅   … 顔の幅の 2.4 倍（肩幅のおおよそ）
  比べ方   … HSVの色相・彩度の2次元ヒストグラムの交差（0〜1）

★背景も少し混じる。だから**絶対値では判断しない**。同じ服なら高く、
  違う服なら低い、という**相対の差**を見る。閾値は実測で決める。
★これは「服が違う」を疑うための道具であって、証明ではない。
  引っ掛かったら人が見る。
"""

import os
import subprocess
import sys

# ★実測で決める。まずは仮の値を置き、--calibrate で測り直す
PASS_THRESHOLD = 0.55

# 顔の枠から胴体の帯を取る比率
BAND_TOP = 0.6      # 顔の下端から顔の高さの何倍下から
BAND_BOTTOM = 2.2   # 何倍下まで
BAND_WIDTH = 2.4    # 顔の幅の何倍


def _read_rgb(path, w=None, h=None):
    """画像を (幅, 高さ, bytes) で読む。ffmpegだけで済ませる（face_scoreと同じ）"""
    if w is None or h is None:
        dim = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path],
            capture_output=True, text=True).stdout.strip().split('x')
        w, h = int(dim[0]), int(dim[1])
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-pix_fmt', 'rgb24',
         '-f', 'rawvideo', '-'], capture_output=True).stdout
    return w, h, raw


def _face_box(path):
    """顔の枠を返す (x1,y1,x2,y2)。顔が無ければ None"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import face_score
    faces = face_score._analyzer().get(_bgr(path))
    if not faces:
        return None
    # ★一番大きい顔を使う。後ろに写り込んだ人に引っ張られないため
    f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    return [float(v) for v in f.bbox]


def _bgr(path):
    """insightface が食べる BGR の numpy 配列にする"""
    import numpy as np
    w, h, raw = _read_rgb(path)
    a = np.frombuffer(raw, dtype=np.uint8)[:w * h * 3].reshape(h, w, 3)
    return a[:, :, ::-1].copy()


def torso_histogram(path, bins=12):
    """
    胴体の帯の色分布を返す。顔が見つからなければ None。

    ★色相と彩度だけ見る。明るさは光の当たり方で動くので入れない。
    """
    import numpy as np
    box = _face_box(path)
    if box is None:
        return None
    x1, y1, x2, y2 = box
    fw, fh = x2 - x1, y2 - y1
    cx = (x1 + x2) / 2.0
    w, h, raw = _read_rgb(path)
    bx1 = int(max(0, cx - fw * BAND_WIDTH / 2))
    bx2 = int(min(w, cx + fw * BAND_WIDTH / 2))
    by1 = int(min(h - 1, y2 + fh * BAND_TOP))
    by2 = int(min(h, y2 + fh * BAND_BOTTOM))
    if bx2 - bx1 < 8 or by2 - by1 < 8:
        return None
    a = np.frombuffer(raw, dtype=np.uint8)[:w * h * 3].reshape(h, w, 3)
    band = a[by1:by2, bx1:bx2, :].astype(np.float32) / 255.0

    mx = band.max(axis=2)
    mn = band.min(axis=2)
    d = mx - mn
    sat = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0.0)
    hue = np.zeros_like(mx)
    r, g, b = band[:, :, 0], band[:, :, 1], band[:, :, 2]
    nz = d > 1e-6
    with np.errstate(invalid='ignore'):
        hr = np.where((mx == r) & nz, ((g - b) / np.maximum(d, 1e-6)) % 6, 0)
        hg = np.where((mx == g) & nz, (b - r) / np.maximum(d, 1e-6) + 2, 0)
        hb = np.where((mx == b) & nz, (r - g) / np.maximum(d, 1e-6) + 4, 0)
    hue = (hr + hg + hb) / 6.0
    hist, _, _ = np.histogram2d(
        hue.ravel(), sat.ravel(), bins=[bins, bins], range=[[0, 1], [0, 1]])
    total = hist.sum()
    return (hist / total) if total > 0 else None


def similarity(a, b):
    """2つのヒストグラムの交差（0〜1）。同じ服なら高い"""
    import numpy as np
    if a is None or b is None:
        return None
    return float(np.minimum(a, b).sum())


def compare(paths):
    """
    @return {dict} pairs（総当たりの類似度）と worst（最小値）
    ★**最小値で判断する。** 平均だと、1枚だけ違う服でも埋もれる。
    """
    hists = [(p, torso_histogram(p)) for p in paths]
    usable = [(p, h) for p, h in hists if h is not None]
    pairs = []
    for i in range(len(usable)):
        for j in range(i + 1, len(usable)):
            s = similarity(usable[i][1], usable[j][1])
            pairs.append((os.path.basename(usable[i][0]),
                          os.path.basename(usable[j][0]), s))
    worst = min((s for _, _, s in pairs), default=None)
    return {
        'pairs': pairs,
        'worst': worst,
        'passed': worst is not None and worst >= PASS_THRESHOLD,
        'skipped': [os.path.basename(p) for p, h in hists if h is None],
    }


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    r = compare(args)
    for a, b, s in r['pairs']:
        print('  %-12s %-12s %.3f' % (a, b, s))
    if r['skipped']:
        print('  顔が見つからず飛ばした: %s' % ', '.join(r['skipped']))
    if r['worst'] is None:
        print('比べられる組がありません')
        sys.exit(0)
    print('最小 %.3f / 閾値 %.2f → %s'
          % (r['worst'], PASS_THRESHOLD,
             '服は揃っている' if r['passed'] else '★服が変わっている疑い'))
    sys.exit(0 if r['passed'] else 1)
