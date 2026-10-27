#!/usr/bin/env python3
"""
VOICEVOX の文節を字幕の語へ割り当てる口（tts._vv_words・jmas #353）と、声の振り分け・表記の検査。
★本物のエンジンは呼ばない。audio_query の形（文節・1音ずつの長さ・句読点の間）を手で作って時刻の出し方だけを見る。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts  # noqa: E402

fails = []


def expect(cond, msg):
    print('  %s   %s' % ('OK' if cond else 'NG', msg))
    if not cond:
        fails.append(msg)


def mora(n, d=0.1):
    return [{'consonant_length': 0.0, 'vowel_length': d} for _ in range(n)]


# 「夜中に、光る。」= ヨ・ナ・カ・ニ（4音）＋間 0.3 ＋ ヒ・カ・ル（3音）。頭の無音 0.1
query = {'prePhonemeLength': 0.1, 'accent_phrases': [
    {'moras': mora(4), 'pause_mora': {'vowel_length': 0.3}},
    {'moras': mora(3), 'pause_mora': None},
]}

print('語の時刻（速さ 1.0）')
w = tts._vv_words('夜中に、光る。', query, 1.0)
expect([x['text'] for x in w] == ['夜中に', '光る'], '文節ごとに台本の字が入る: %s' % w)
expect(abs(w[0]['start'] - 0.1) < 1e-6 and abs(w[0]['end'] - 0.5) < 1e-6, '1つ目は頭の無音の後から最後の音まで（0.1〜0.5・句読点の間は含めない）')
expect(abs(w[1]['start'] - 0.8) < 1e-6 and abs(w[1]['end'] - 1.1) < 1e-6, '2つ目は間の後から最後の音まで（0.8〜1.1）')

print('速さ 1.25（音の長さはエンジンの値・全体が 1/1.25 になる）')
f = tts._vv_words('夜中に、光る。', query, 1.25)
expect(abs(f[-1]['end'] - 1.1 / 1.25) < 1e-6, '最後の語の終わりが 0.88 秒')

print('小さい字・句読点は音を持たない')
q2 = {'prePhonemeLength': 0.0, 'accent_phrases': [{'moras': mora(2)}, {'moras': mora(2)}]}
w2 = tts._vv_words('きょう、あさ', q2, 1.0)   # キョ・ウ / ア・サ
expect([x['text'] for x in w2] == ['きょう', 'あさ'], '「ょ」で次の文節へずれない: %s' % w2)

print('字が余っても捨てない（読みが台本より短い時）')
q3 = {'prePhonemeLength': 0.0, 'accent_phrases': [{'moras': mora(2)}]}
w3 = tts._vv_words('光る光', q3, 1.0)
expect(''.join(x['text'] for x in w3) == '光る光', '台本の字が全部どこかの語に入る: %s' % w3)
expect(tts._vv_words('', q3, 1.0) == [] and tts._vv_words('あ', {'accent_phrases': []}, 1.0) == [], '空なら空を返す')

print('声の振り分け')
expect(tts._vv_spec('ja-JP-NanamiNeural') == ('WhiteCUL', 'ノーマル'), '日本語の edge-tts の声は VOICEVOX へ')
expect(tts._vv_spec('voicevox:四国めたん/あまあま') == ('四国めたん', 'あまあま'), '話者と型の指定はそのまま')
expect(tts._vv_spec('en-US-AriaNeural', 'Hello') is None, '英語の声は edge-tts のまま')
expect(tts._vv_spec(None, 'こんにちは') == ('WhiteCUL', 'ノーマル') and tts._vv_spec(None, 'Hello') is None, '声の指定が無い時は本文の字で決める')

print('表記（規約の条件）を広告表記の横へ')
import render_video as rv  # noqa: E402
tts.CREDITS[:] = []
expect(rv.with_credits('PR') == 'PR', '使っていない回は変えない')
tts.CREDITS[:] = ['VOICEVOX:WhiteCUL', 'VOICEVOX:WhiteCUL']
expect(rv.with_credits('PR') == 'PR  VOICEVOX:WhiteCUL', '1回だけ足す: %r' % rv.with_credits('PR'))
expect(rv.with_credits(None) == 'VOICEVOX:WhiteCUL', '広告表記が無くても表記は出す')
tts.CREDITS[:] = []

if fails:
    print('\n失敗 %d件' % len(fails))
    sys.exit(1)
print('\n全部 OK')
