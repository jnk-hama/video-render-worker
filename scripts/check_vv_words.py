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


def q(phrases, pre=0.1, d=0.1, pause=None):
    """読み「ヨナカニ/ゴミ」の形から audio_query を作る（1音 d 秒・pause は文節の後の間）"""
    import re
    aps = []
    for k, p in enumerate(phrases):
        ms = re.findall(r'.[ャュョァィゥェォヮ]?', p)
        aps.append({'moras': [{'text': m, 'consonant_length': 0.0, 'vowel_length': d} for m in ms],
                    'pause_mora': {'vowel_length': pause[k]} if pause and pause.get(k) else None})
    return {'prePhonemeLength': pre, 'accent_phrases': aps}


print('語の時刻（速さ 1.0）')
w = tts._vv_words('夜中に、光る。', q(['ヨナカニ', 'ヒカル'], pause={0: 0.3}), 1.0)
expect([x['text'] for x in w] == ['夜中に', '光る'], '文節ごとに台本の字が入る: %s' % w)
expect(abs(w[0]['start'] - 0.1) < 1e-6 and abs(w[0]['end'] - 0.5) < 1e-6, '1つ目は頭の無音の後から最後の音まで（0.1〜0.5・句読点の間は含めない）')
expect(abs(w[1]['start'] - 0.8) < 1e-6 and abs(w[1]['end'] - 1.1) < 1e-6, '2つ目は間の後から最後の音まで（0.8〜1.1）')
f = tts._vv_words('夜中に、光る。', q(['ヨナカニ', 'ヒカル'], pause={0: 0.3}), 1.25)
expect(abs(f[-1]['end'] - 1.1 / 1.25) < 1e-6, '速さ 1.25 なら全体が 1/1.25（最後の語の終わりが 0.88 秒）')

print('2026-10-27 Actions の実走で出た読み（音の数の等分では文節をまたいだ）')
w = tts._vv_words('夜中にゴミ捨てへ行くの、正直しんどくない？',
                  q(['ヨナカニ', 'ゴミステエ', 'イク', 'ノ', 'ショオジキ', 'シンドクナイ']), 1.0)
expect([x['text'] for x in w] == ['夜中に', 'ゴミ捨てへ', '行く', 'の', '正直', 'しんどくない'], '「へ」を「エ」と読んでも合う: %s' % [x['text'] for x in w])
w = tts._vv_words('正確な値段はプロフに載せといたよ。', q(['セエカクナ', 'ネダンワ', 'プロフニ', 'ノセトイタヨ']), 1.0)
expect([x['text'] for x in w] == ['正確な', '値段は', 'プロフに', '載せといたよ'], '「は」を「ワ」と読んでも合う: %s' % [x['text'] for x in w])
w = tts._vv_words('きょう、あさ', q(['キョオ', 'アサ']), 1.0)
expect([x['text'] for x in w] == ['きょう', 'あさ'], '小さい字は前の字と1音・「う」を「オ」と読んでも合う: %s' % w)
w = tts._vv_words('4.74点', q(['ヨンテンナナジュウヨンテン']), 1.0)
expect(''.join(x['text'] for x in w) == '4.74点', '数字だけの文も字を捨てない: %s' % w)
expect(tts._vv_words('', q(['ア']), 1.0) == [] and tts._vv_words('あ', {'accent_phrases': []}, 1.0) == [], '空なら空を返す')

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
