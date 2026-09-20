#!/usr/bin/env python3
"""
生成された動画クリップを採点する。顔の一貫性と手の破綻をまとめて見る。

★★2026-09-01、AI動画サービスの比較検証のために作った。

【なぜ要るか】
無料枠は1日2本程度しか出せない。1本を人が見て「良さそう」と言うだけでは、
サービスAとサービスBのどちらが良いかを後から比較できない。
**同じ物差しで数字を残す**ためにこれを通す。

【何を出すか】
1. 顔  … 全フレームのうち、アンナと判定できたフレームの割合
         （マスター7方向との最大コサイン類似度 >= 0.42）
2. 手  … 手が検出できたフレームのうち、破綻していない割合
3. 顔の揺れ … フレーム間で類似度がどれだけ動くか。
         **平均が高くても揺れが大きいと、途中で別人になる**。
         静止画では見えず動画でだけ出る問題なので、必ず見る。
"""

import os
import subprocess
import sys

SAMPLE_FPS = 1.5     # 1秒に何フレーム採るか。全フレームは重い


def sample_frames(video, work, fps=SAMPLE_FPS):
    os.makedirs(work, exist_ok=True)
    subprocess.run(
        ['ffmpeg', '-y', '-v', 'error', '-i', video,
         '-vf', 'fps=%.2f' % fps, os.path.join(work, 'f_%04d.png')],
        check=False)
    return sorted(os.path.join(work, f) for f in os.listdir(work)
                  if f.startswith('f_'))


def verify(video, work=None):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import face_score
    import hand_score

    work = work or (video + '.frames')
    frames = sample_frames(video, work)
    if not frames:
        return None
    refs = face_score.reference_set()

    face_hits, face_seen, scores = 0, 0, []
    hand_ok, hand_seen = 0, 0
    hand_error = None
    for p in frames:
        f = face_score.score(p, refs)
        if f:
            face_seen += 1
            scores.append(f['best'])
            if f['passed']:
                face_hits += 1
        """
        ★★手の判定で落ちても、顔の判定まで道連れにしない（2026-09-20）。

        実測: mediapipe が libGLESv2.so.2 を dlopen できず OSError で落ち、
        **顔の結果まで一緒に消えた**。顔の同一性がこの採点の本体であり、
        手が測れないことより顔が測れないことの方が痛い。

        ★ただし**黙って続けない。** 失敗を hand_error に残して出力に出す。
          「0%」と「測れなかった」は別物である（0件を成功にしないのと同じ）。
        """
        if hand_error is None:
            try:
                h = hand_score.check_hand(p)
            except Exception as e:
                hand_error = '%s: %s' % (type(e).__name__, str(e)[:120])
                h = None
            if h and h['hands'] >= 1:
                hand_seen += 1
                if h['fingers_ok']:
                    hand_ok += 1

    for p in frames:
        os.remove(p)
    os.rmdir(work)

    if not scores:
        return {'frames': len(frames), 'face_rate': 0.0,
                'face_mean': 0.0, 'face_min': 0.0, 'face_swing': 0.0,
                'hand_rate': (hand_ok / hand_seen) if hand_seen else 0.0,
                'hand_error': hand_error,
                'note': '顔を1フレームも検出できず'}

    mean = sum(scores) / len(scores)
    return {
        'frames': len(frames),
        'face_detected': face_seen,
        'face_rate': face_hits / float(face_seen),
        'face_mean': mean,
        'face_min': min(scores),
        # ★揺れ。最大-最小。大きいと途中で顔が変わっている
        'face_swing': max(scores) - min(scores),
        'hand_detected': hand_seen,
        'hand_rate': (hand_ok / hand_seen) if hand_seen else None,
        'hand_error': hand_error,
    }


if __name__ == '__main__':
    print('%-30s %-7s %-8s %-8s %-8s %s'
          % ('動画', 'フレーム', '顔合格率', '類似度平均', '揺れ', '手の正常率'))
    for v in sys.argv[1:]:
        r = verify(v)
        if not r:
            print('%-30s 読めず' % os.path.basename(v))
            continue
        hr = '―' if r.get('hand_rate') is None else '%.0f%%' % (r['hand_rate'] * 100)
        if r.get('hand_error'):
            hr = '測れず'
        print('%-30s %-7d %-8s %-8.3f %-8.3f %s'
              % (os.path.basename(v), r['frames'],
                 '%.0f%%' % (r['face_rate'] * 100),
                 r['face_mean'], r['face_swing'], hr))
        if r['face_swing'] > 0.25:
            print('%-30s   ★揺れが大きい。途中で顔が変わっている可能性' % '')
        # ★測れなかったことを黙らせない
        if r.get('hand_error'):
            print('%-30s   ★手の判定が動きませんでした: %s' % ('', r['hand_error']))
