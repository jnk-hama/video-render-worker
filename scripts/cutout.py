#!/usr/bin/env python3
"""
商品画像から背景を抜く。**学習モデルを使わない決定論的な処理**。

★★2026-09-01、アフィリエイト商品動画のために作った。

【なぜ colorkey では駄目か（実測）】
ffmpeg の colorkey は「その色の画素を全部消す」。商品の中に白い部分が
あると **そこも一緒に消えて穴が開く**。実測で、商品中央の白いラベルの
残存率は **0%** だった。中身が抜けた商品画像は使えない。

【この実装の考え方：縁から色を辿る（領域成長）】
背景は必ず画像の縁に接している。縁から始めて、**隣の画素と色が近い限り
広げていく**。商品の輪郭では色が急に変わるのでそこで止まる。
  ・商品の中の白 … 縁と繋がっていないので残る
  ・薄いグラデ背景 … 少しずつ変わるので辿れる
  ・柔らかい影 … 同上。連続的に暗くなるので辿れる

【止まらなくなる事故を防ぐ】
隣との差だけで進むと、градが長い画像で商品まで侵食しうる。
そこで「縁の色から離れすぎたら止める」上限も併用する（二重の条件）。
"""

import os
import subprocess
import sys
from collections import deque

# 隣の画素との差の許容量（0-255）。これ以下なら同じ背景とみなす
NEIGHBOR_TOLERANCE = 18

# 縁の色からの距離の上限。これを超えたら背景とみなさない
GLOBAL_TOLERANCE = 78

"""
★★影を通すための第2条件（2026-09-01、実際に抜いて足した）。

【何が起きたか】
グレー背景＋商品の下の柔らかい影、という実写に近い画像で抜いたところ、
**影が白い塊として残った**。暗い背景に乗せると楕円形のシミになる。

【なぜ残るか】
影は背景を暗くしたものなので、縁の色(241,241,241)からの距離が大きい。
上の GLOBAL_TOLERANCE=78 では届かず、そこで領域成長が止まる。
かといって閾値を上げると、色の濃い商品まで飲み込む。

【どう直したか】
影は「背景色を一律に暗くした色」という性質を持つ。
つまり画素の色が bg×k（0<k<=1）で近似できるなら影とみなせる。
明るさの差ではなく **色の比率** を見るので、
  ・グレー背景の上の灰色の影 … 比率が保たれる → 背景として通す
  ・濃紺の商品            … 比率が崩れる   → 商品として残す
を区別できる。
"""
"""
★下限を 0.35 → 0.06 へ下げた（2026-09-01、実測して判断）。

【なぜ下げたか】
影の核を測ったら k=0.21〜0.34 で、0.35 の下限に弾かれていた。
一方 bg×k とのズレは **0〜1**（完全に中性）で、影の判定自体は
正しく効いていた。**下限だけが邪魔をしていた。**

【下げても黒い商品が消えない理由】
黒い商品を守っているのは、この下限ではなく **隣接画素の許容量** である。
商品の輪郭では1画素で70以上跳ねるので、NEIGHBOR_TOLERANCE=18 の
領域成長はそこで必ず止まる。影は連続的に変わるので通る。
**「硬い輪郭か、滑らかな諧調か」で分けるのが本質**で、
明るさの下限で分けようとしたのが誤りだった。

★ただし輪郭がぼけた商品（ピンぼけ・半透明）は漏れうる。
  そのため kept_ratio による異常検知を残してある。
"""
SHADOW_MIN_SCALE = 0.06
SHADOW_TOLERANCE = 26     # bg×k からのズレの許容量

# 縁をなじませる幅（px）。0だとギザギザが目立つ
FEATHER = 2


def read_rgb(path):
    """画像を (幅, 高さ, bytes) で読む。ffprobe/ffmpeg だけで済ませる。"""
    dim = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path],
        capture_output=True, text=True).stdout.strip().split('x')
    w, h = int(dim[0]), int(dim[1])
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-pix_fmt', 'rgb24',
         '-f', 'rawvideo', '-'], capture_output=True).stdout
    return w, h, raw


def border_color(w, h, raw):
    """
    縁の色を代表値で決める。平均ではなく中央値を使う。

    ★平均だと、縁に商品が少しでも掛かっている画像で値が引きずられる。
      中央値なら、縁の多数派＝背景の色が残る。
    """
    px = []
    for x in range(0, w, 3):
        for y in (0, h - 1):
            i = (y * w + x) * 3
            px.append((raw[i], raw[i + 1], raw[i + 2]))
    for y in range(0, h, 3):
        for x in (0, w - 1):
            i = (y * w + x) * 3
            px.append((raw[i], raw[i + 1], raw[i + 2]))
    px.sort()
    return px[len(px) // 2]


def looks_like_shadow(c, bg):
    """
    その色が「背景色を暗くしたもの」か。影を通すために使う。

    ★明るさではなく色の比率で見る。詳しくは SHADOW_MIN_SCALE の上の説明。
    """
    bsum = bg[0] + bg[1] + bg[2]
    if bsum <= 0:
        return False
    k = (c[0] + c[1] + c[2]) / float(bsum)
    if k < SHADOW_MIN_SCALE or k > 1.05:
        return False
    return (abs(c[0] - bg[0] * k) + abs(c[1] - bg[1] * k)
            + abs(c[2] - bg[2] * k)) <= SHADOW_TOLERANCE


def build_alpha(w, h, raw, bg):
    """
    縁から領域成長で背景を塗り、alpha（0=透明 / 255=不透明）を返す。
    """
    alpha = bytearray([255]) * (w * h)
    seen = bytearray(w * h)
    q = deque()

    def push(x, y):
        i = y * w + x
        if seen[i]:
            return
        j = i * 3
        c = (raw[j], raw[j + 1], raw[j + 2])
        d = abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2])
        if d > GLOBAL_TOLERANCE and not looks_like_shadow(c, bg):
            return
        seen[i] = 1
        alpha[i] = 0
        q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        x, y = q.popleft()
        j0 = (y * w + x) * 3
        c0 = (raw[j0], raw[j0 + 1], raw[j0 + 2])
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            i = ny * w + nx
            if seen[i]:
                continue
            j = i * 3
            # 隣との差が小さく、かつ縁の色から離れすぎていないこと
            near = (abs(raw[j] - c0[0]) + abs(raw[j + 1] - c0[1])
                    + abs(raw[j + 2] - c0[2]))
            if near > NEIGHBOR_TOLERANCE:
                continue
            cn = (raw[j], raw[j + 1], raw[j + 2])
            far = (abs(cn[0] - bg[0]) + abs(cn[1] - bg[1])
                   + abs(cn[2] - bg[2]))
            if far > GLOBAL_TOLERANCE and not looks_like_shadow(cn, bg):
                continue
            seen[i] = 1
            alpha[i] = 0
            q.append((nx, ny))
    return alpha


def cutout_rembg(src, dest, session=None):
    """
    U2-Net（ONNX Runtime・**CPU**）で抜く。使えなければ None。

    ★★2026-09-01、こちらを本線にした。**実測で決めた。**

    【なぜ自前の領域成長では駄目だったか】
    白い商品が白い背景に置かれている画像（EC写真では普通にある）で、
    背景と商品本体の色差が **765中わずか3〜5** しかなかった。
    色情報だけでは原理的に分離できない。許容量を18→2まで詰めても、
    本体の中身が抜けるか背景ごと残るかの二択だった。調整では解けない。

    【GPUは要らない】
    onnxruntime の CPUExecutionProvider で動く。実測 **0.86秒/枚**。
    モデルは176MBを初回に1度落とすだけ。
    「GPU推論に依存しない」「運用費用は0円」のどちらにも触れない。
    """
    try:
        from rembg import remove, new_session
    except Exception as e:
        log('rembg を読み込めません（自前の方式へ降ります）: %s' % e)
        return None
    try:
        if session is None:
            session = new_session('u2net')
        with open(src, 'rb') as f:
            data = remove(f.read(), session=session)
        with open(dest, 'wb') as f:
            f.write(data)
    except Exception as e:
        log('rembg で抜けませんでした（自前の方式へ降ります）: %s' % e)
        return None
    if not os.path.exists(dest) or os.path.getsize(dest) < 1024:
        return None
    return {'method': 'rembg', 'usable': True}


def cutout(src, dest, session=None):
    """
    @return {?dict} 抜いた結果の統計。抜けなければ None

    ★まず rembg。使えない時だけ自前の領域成長へ降りる。
      自前の方式は白背景の画像では今も有効で、依存が無い分だけ確実に動く。
    """
    r = cutout_rembg(src, dest, session)
    if r:
        return r
    w, h, raw = read_rgb(src)
    if len(raw) < w * h * 3:
        return None
    bg = border_color(w, h, raw)
    alpha = build_alpha(w, h, raw, bg)

    kept = sum(1 for v in alpha if v)
    ratio = kept / float(w * h)
    """
    ★抜けすぎ・抜けなさすぎを検出する。
      商品が画面の1%未満しか残らない → 背景と商品の色が近すぎて溶けた
      95%以上残る → 背景を1画素も抜けていない
      どちらも使えないので、呼び出し側へ知らせる。
    """
    ok = 0.01 < ratio < 0.95

    rgba = bytearray(w * h * 4)
    for i in range(w * h):
        rgba[i * 4:i * 4 + 3] = raw[i * 3:i * 3 + 3]
        rgba[i * 4 + 3] = alpha[i]
    tmp = dest + '.raw'
    with open(tmp, 'wb') as f:
        f.write(bytes(rgba))
    vf = 'format=rgba'
    if FEATHER > 0:
        # alphaだけを軽くぼかして縁をなじませる
        vf = ('format=rgba,split[a][b];[a]alphaextract,boxblur=%d:1[m];'
              '[b][m]alphamerge' % FEATHER)
    subprocess.run(
        ['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
         '-s', '%dx%d' % (w, h), '-i', tmp, '-filter_complex', vf, dest],
        check=False)
    os.remove(tmp)
    return {'width': w, 'height': h, 'bg': bg,
            'kept_ratio': ratio, 'usable': ok}


if __name__ == '__main__':
    r = cutout(sys.argv[1], sys.argv[2])
    print(r)
