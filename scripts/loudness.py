#!/usr/bin/env python3
"""
音量をそろえる（決定#177・2026-09-26）。

【なぜ要るか（E-033）】
描画に**ラウドネス正規化もリミッターも無かった**。Veo の各クリップの音量が
そのまま出て、カットが替わるたびに音量が跳ねていた（実測: 日本版 5.1 LU 差、
英語版は True Peak +0.1 dBTP ＝ 0 を超えて歪みうる）。

【やり方】2段。どちらも**音量を掛けるだけ**で、時間軸は1サンプルも動かさない
（口と声・字幕の同期を壊さない）。
  1. パートごと: 喋りの各カットを同じ大きさ（VOICE_LUFS）へ。カット間の段差を消す
  2. 仕上げ   : 完成品を FINAL_LUFS / FINAL_TP へ（loudnorm の2パス・linear）

★数字はここにしか書かない（一度決めたら全部で強制する）。
★-14 LUFS は配信で広く使われる目安で、TikTok 公式の数値ではない（推測）。
"""

import json
import re
import subprocess

VOICE_LUFS = -16.0
FINAL_LUFS = -14.0
FINAL_TP = -1.5
FINAL_LRA = 11.0
# これより静かなパートは「喋っていない」とみなして持ち上げない（無音を増幅しない）
SILENT_BELOW_LUFS = -50.0
# 1パートに掛ける補正の上限。測り違いで爆音にしないための蓋
MAX_GAIN_DB = 20.0


def measure_lufs(path):
    """統合ラウドネス（LUFS）を返す。測れなければ None。"""
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-i', path,
         '-af', 'ebur128', '-f', 'null', '-'],
        capture_output=True, text=True)
    # ebur128 は最後に Summary を出す。その中の I: が統合値
    m = re.findall(r'^\s+I:\s+(-?[\d.]+|-inf)\s+LUFS', r.stderr, re.M)
    if not m or m[-1] == '-inf':
        return None
    return float(m[-1])


def part_gain_db(lufs, target=VOICE_LUFS):
    """
    パートに掛ける補正量（dB）。掛けない時は 0。

    ★無音・ほぼ無音のパートは持ち上げない（ノイズを増幅するだけ）。
    ★上限を付ける。測り違いで +40dB 掛けるような事故を起こさない。
    """
    if lufs is None or lufs < SILENT_BELOW_LUFS:
        return 0.0
    g = target - lufs
    return max(-MAX_GAIN_DB, min(MAX_GAIN_DB, g))


def level_part(src, dest, target=VOICE_LUFS):
    """
    1パートを target へ寄せて dest へ書く（WAV）。掛けた dB を返す。

    ★volume フィルタは音量を掛けるだけ。長さもサンプル位置も変わらない。
    """
    lufs = measure_lufs(src)
    g = part_gain_db(lufs, target)
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
         '-af', 'volume=%.2fdB' % g,
         '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', dest],
        check=True)
    return lufs, g


def _loudnorm_measure(path):
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-vn',
         '-af', 'loudnorm=I=%.1f:TP=%.1f:LRA=%.1f:print_format=json'
         % (FINAL_LUFS, FINAL_TP, FINAL_LRA),
         '-f', 'null', '-'],
        capture_output=True, text=True)
    # 出力の最後の {...} が測定結果
    m = re.findall(r'\{[^{}]*"input_i"[^{}]*\}', r.stderr, re.S)
    if not m:
        return None
    d = json.loads(m[-1])
    if d.get('input_i') in (None, '-inf'):
        return None
    return d


def finalize(src, dest):
    """
    完成品の音声を FINAL_LUFS / FINAL_TP へ（2パス）。映像はコピーで触らない。

    @return 測定値の dict（入力の I / TP）。音声が無い・測れない時は None で、
            その場合 dest は作らない（呼び出し側は src をそのまま使う）。

    ★linear=true: 目標まで一律に音量を掛ける。足りない時だけ loudnorm が
      動的処理へ切り替える（その場合もピークは FINAL_TP を超えない）。
    ★loudnorm は内部で 192kHz にするので、出力の -ar を明示して戻す。
    """
    m = _loudnorm_measure(src)
    if not m:
        return None
    af = ('loudnorm=I=%.1f:TP=%.1f:LRA=%.1f:measured_I=%s:measured_TP=%s:'
          'measured_LRA=%s:measured_thresh=%s:offset=%s:linear=true'
          % (FINAL_LUFS, FINAL_TP, FINAL_LRA, m['input_i'], m['input_tp'],
             m['input_lra'], m['input_thresh'], m['target_offset']))
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', src,
         '-map', '0:v?', '-map', '0:a', '-c:v', 'copy',
         '-af', af, '-ar', '44100', '-c:a', 'aac', '-b:a', '96k',
         '-movflags', '+faststart', dest],
        check=True)
    return {'input_i': float(m['input_i']), 'input_tp': float(m['input_tp'])}


def has_audio(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a',
         '-show_entries', 'stream=index', '-of', 'csv=p=0', path],
        capture_output=True, text=True).stdout.strip()
    return bool(out)
