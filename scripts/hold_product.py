#!/usr/bin/env python3
"""
モデル映像の手首を追跡し、そこへ切り抜いた商品を重ねる。

★★2026-09-01、「モデルが商品を使っている映像」を作るために書いた。

【なぜ生成AIを使わないか】
「モデルに商品を持たせる」を映像生成で作るとGPUが要る。
CLAUDE.md の絶対ルール「GPU推論に依存しない」に触れる。

一方、**姿勢推定はCPUで動く**（MediaPipe / ONNX Runtime CPU）。
既にある映像の手首を追跡して、そこへ切り抜いた商品を重ねれば、
新しい映像を生成せずに「持っている絵」が作れる。
生成ではなく合成なので、100%決定論的でもある。

【手ブレを消す理由】
姿勢推定の結果はフレームごとに数px揺れる。そのまま使うと商品が
小刻みに震えて、合成だと一目で分かる。移動平均で均す。
"""

import os
import subprocess
import sys

SMOOTH_WINDOW = 7      # 手首座標の移動平均の窓（フレーム）
POSE_MODEL = '/root/.mp/pose.task'

# 手首から見た商品の置き方。商品画像の「握る位置」を手首へ合わせる
GRIP_X_RATIO = 0.50    # 商品画像の横のどこを握るか（0=左端）
GRIP_Y_RATIO = 0.72    # 縦のどこを握るか（1=下端）。持ち手の下寄り


def probe(path):
    o = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height,r_frame_rate',
         '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.strip()
    w, h, rate = o.split(',')[:3]
    num, den = rate.split('/')
    return int(w), int(h), float(num) / float(den)


def track_wrists(src, w, h, fps, start, dur):
    """
    区間内の各フレームの手首位置を返す。

    @return [(x_px, y_px, 可視度), ...] 検出できなかったフレームは None
    """
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks import python as mpy
    from mediapipe.tasks.python import vision

    lmk = vision.PoseLandmarker.create_from_options(
        vision.PoseLandmarkerOptions(
            base_options=mpy.BaseOptions(model_asset_path=POSE_MODEL),
            running_mode=vision.RunningMode.IMAGE))

    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur),
         '-i', src, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    out = []
    for i in range(n):
        fr = np.frombuffer(raw[i * w * h * 3:(i + 1) * w * h * 3],
                           dtype=np.uint8).reshape(h, w, 3).copy()
        r = lmk.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=fr))
        if not r.pose_landmarks:
            out.append(None)
            continue
        p = r.pose_landmarks[0]
        """
        ★左右の手首のうち「よく見えている方」を使う。
          片方が体で隠れる回があり、固定すると商品が消えた位置へ飛ぶ。
        """
        best = max((p[15], p[16]), key=lambda k: k.visibility)
        out.append((best.x * w, best.y * h, best.visibility))
    return out


def smooth(points, window):
    """
    手首座標を移動平均で均す。検出漏れは前後で埋める。

    ★均さないと商品が小刻みに震え、合成だと即座に分かる。
    """
    # 検出漏れを直前の値で埋める
    filled, last = [], None
    for p in points:
        if p is not None:
            last = p
        filled.append(last)
    while filled and filled[0] is None:
        filled.pop(0)
    if not filled:
        return []
    out = []
    half = max(1, window // 2)
    for i in range(len(filled)):
        lo, hi = max(0, i - half), min(len(filled), i + half + 1)
        seg = [q for q in filled[lo:hi] if q]
        out.append((sum(q[0] for q in seg) / len(seg),
                    sum(q[1] for q in seg) / len(seg)))
    return out


def person_mask(frame_path, session):
    """
    そのフレームから人物だけを抜いたRGBAを作る。

    ★★遮蔽のために要る（2026-09-01）。
      商品をただ上に重ねると、体の前に貼り付いて見える。
      **商品を人物の後ろに置き、人物を上から重ね直す**と、
      手や腕が持ち手を隠して「握っている」ように見える。
      合成だと見抜かれる最大の原因が遮蔽の欠如なので、ここが要。
    """
    from rembg import remove
    out = frame_path + '.person.png'
    with open(frame_path, 'rb') as f:
        data = remove(f.read(), session=session)
    with open(out, 'wb') as f:
        f.write(data)
    return out


def compose(src, product, dest, start, dur, scale_ratio=0.30,
            occlude=True, out_dx=0.0):
    """
    @param scale_ratio 商品の高さ ÷ 映像の高さ
    @param occlude     人物マスクで遮蔽するか
    @param out_dx      体の中心から外へずらす量（商品の幅に対する比）
    """
    w, h, fps = probe(src)
    pts = smooth(track_wrists(src, w, h, fps, start, dur), SMOOTH_WINDOW)
    if not pts:
        return None

    pw, ph, _ = probe(product)
    ph2 = int(h * scale_ratio)
    pw2 = max(1, int(pw * ph2 / ph))

    """
    ★overlay の x,y へフレーム番号で引く式を渡す。
      ffmpeg の式に長い配列は書けないので、if(eq(n,0),..,if(eq(n,1),..))
      を積むことになり、数百フレームでは式が壊れる。
      そこで **1フレームずつ書き出して重ねる** 方式にする。
      決定論的で、フレーム数が増えても壊れない。
    """
    work = dest + '.frames'
    os.makedirs(work, exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', str(start),
                    '-t', str(dur), '-i', src,
                    os.path.join(work, 'f_%05d.png')], check=False)

    frames = sorted(f for f in os.listdir(work) if f.startswith('f_'))
    session = None
    if occlude:
        from rembg import new_session
        # ★モデルを明示する。既定(BRIA RMBG-2.0)は商用に有償契約が要る。
        #   詳しくは cutout.py の REMBG_MODEL の説明。
        from cutout import REMBG_MODEL
        session = new_session(REMBG_MODEL)

    for i, fn in enumerate(frames):
        if i >= len(pts):
            break
        cx, cy = pts[i]
        # ★体の中心から外へずらす。真上に置くと胴体と重なって
        #   「服の上に貼った絵」に見える
        side = 1.0 if cx > w / 2 else -1.0
        x = int(cx - pw2 * GRIP_X_RATIO + side * out_dx * pw2)
        y = int(cy - ph2 * GRIP_Y_RATIO)
        fp = os.path.join(work, fn)

        if occlude:
            per = person_mask(fp, session)
            # 背景 → 商品 → 人物 の順に重ねる
            subprocess.run(
                ['ffmpeg', '-y', '-v', 'error', '-i', fp, '-i', product,
                 '-i', per, '-filter_complex',
                 '[1:v]scale=%d:%d[p];[0:v][p]overlay=%d:%d[b];'
                 '[b][2:v]overlay=0:0' % (pw2, ph2, x, y),
                 fp + '.out.png'], check=False)
            os.remove(per)
        else:
            subprocess.run(
                ['ffmpeg', '-y', '-v', 'error', '-i', fp, '-i', product,
                 '-filter_complex',
                 '[1:v]scale=%d:%d[p];[0:v][p]overlay=%d:%d' % (pw2, ph2, x, y),
                 fp + '.out.png'], check=False)
        os.replace(fp + '.out.png', fp)

    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(fps),
                    '-i', os.path.join(work, 'f_%05d.png'),
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                    '-pix_fmt', 'yuv420p', dest], check=False)
    for f in os.listdir(work):
        os.remove(os.path.join(work, f))
    os.rmdir(work)
    return {'frames': len(frames), 'product_px': (pw2, ph2)}


if __name__ == '__main__':
    src, product, dest = sys.argv[1], sys.argv[2], sys.argv[3]
    st = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
    du = float(sys.argv[5]) if len(sys.argv) > 5 else 3.0
    sc = float(sys.argv[6]) if len(sys.argv) > 6 else 0.30
    oc = (sys.argv[7] != '0') if len(sys.argv) > 7 else True
    dx = float(sys.argv[8]) if len(sys.argv) > 8 else 0.0
    print(compose(src, product, dest, st, du, sc, oc, dx))
