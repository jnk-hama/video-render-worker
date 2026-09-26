#!/usr/bin/env python3
"""
speech_qa（喋った内容からの字幕と、喋りの検査）を検証する（決定#177）。

★入力は**本物の文字起こし**（E-033 の再点検で完成品から取った large-v3 の語と時刻）。
  自分で都合よく組んだ語を渡すと、検査が通っても本物を読めていない（E-021 の形）。
★実物の speech_qa / tts を読み込む。写しを持たない。

使い方: python3 scripts/check_speech_qa.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speech_qa  # noqa: E402
from tts import group_words  # noqa: E402


def W(spec):
    """'start end text' の並びを語のリストへ。"""
    out = []
    for line in spec.strip().splitlines():
        s, e, t = line.split(None, 2)
        out.append({'text': t, 'start': float(s), 'end': float(e)})
    return out


# marie-redial-ja-v2（run 36209133203 / large-v3）
JA = W("""
0.00 0.38 それ
0.38 0.66 彼
0.66 0.88 氏
0.88 0.92 の
0.92 1.18 って
1.18 1.38 そう
1.38 1.70 よ
1.70 1.84 く
1.84 1.96 聞
1.96 2.14 か
2.14 2.26 れる
2.26 2.44 や
2.44 2.62 つ
2.62 2.68 ね
3.14 3.54 頭
3.54 3.84 ま
3.84 4.16 です
4.16 4.60 っぽ
4.60 4.74 り
4.74 4.88 入
4.88 5.16 る
5.16 5.32 大
5.32 5.52 き
5.52 5.64 さ
5.64 5.74 な
5.74 5.86 の
5.86 6.14 です
6.14 6.36 萌
6.36 6.46 え
6.46 6.70 袖
6.70 6.82 で
6.82 7.12 指
7.12 7.46 先
7.46 7.74 まで
7.74 8.08 可愛
8.08 8.40 い
8.40 8.62 です
10.08 10.48 ジ
10.48 10.64 ップ
10.64 10.80 開
10.80 11.00 ける
11.00 11.14 と
11.14 11.34 抜
11.34 11.42 け
11.42 11.54 感
11.54 11.68 出
11.68 11.86 る
11.86 11.94 の
11.94 12.14 ね
12.14 12.82 色
12.82 13.00 打
13.00 13.14 ち
13.14 13.18 加
13.18 13.46 工
13.46 13.70 で
13.70 14.16 こ
14.16 14.26 な
14.26 14.48 れ
14.48 14.64 感
14.64 14.82 出
14.82 14.98 る
14.98 15.08 の
15.08 15.32 です
15.32 15.82 リ
15.82 16.00 ン
16.00 16.02 ク
16.02 16.26 から
16.26 16.66 見て
16.66 16.80 み
16.80 17.08 て
17.08 17.66 ください
""")
# 依頼の尺（3.1/3.6/…）と、実際に出来たパートの尺（1コマ長い）。重なり 0.3
# ★文字起こしは実際のパートで組んだ動画から取ったので、振り分けは実尺で見る
JA_DURS = [3.1, 3.6, 2.9, 3.6, 3.5, 2.9]
REAL_DURS = [3.133333, 3.633333, 2.933333, 3.633333, 3.5, 2.933333]

# marie-redial-en-v1 の4カット目（run 36209134894 / large-v3）
EN4 = W("""
9.54 9.92 This
9.92 10.54 vintage
10.54 10.98 wash
10.98 11.46 gives
11.46 11.64 it
11.64 11.96 so
11.96 12.30 much
12.30 12.58 care.
""")

fails = []


def expect(cond, msg):
    print(('  OK   ' if cond else '  NG   ') + msg)
    if not cond:
        fails.append(msg)


print('=== パートの位置（xfade と同じ数え方）===')
win = speech_qa.part_windows(JA_DURS, 0.3)
expect(abs(win[1][0] - 2.8) < 1e-6 and abs(win[5][0] - 15.2) < 1e-6,
       '2本目は2.8秒・6本目は15.2秒から（先頭k本の合計 - k*0.3）')

print('=== 語の振り分け ===')
real_win = speech_qa.part_windows(REAL_DURS, 0.3)
parts = speech_qa.words_by_part(JA, real_win)
texts = [speech_qa.part_text(p, 'ja') for p in parts]
for i, t in enumerate(texts):
    print('     カット%d: %s' % (i + 1, t))
expect(texts[0].startswith('それ彼氏の') and texts[0].endswith('やつね'), 'カット1＝フック')
expect(texts[4].startswith('色打ち加工'), 'カット5＝色落ちのカット（崩れた発音のまま）')
expect(texts[5] == 'リンクから見てみてください', 'カット6＝CTA')
expect(sum(len(p) for p in parts) == len(JA), '語を1つも捨てていない')

print('=== 本番の実尺（run 36211844791）でも境目の語が前のカットへ落ちない ===')
# ★本番のパートは 3.133/3.633/… と指定より1コマ長い。すると次のカットの開始が
#   6.167 / 15.333 になり、Whisper が20〜30ms早めに置いた「萌」(6.14)「リ」(15.32) が
#   前のカットに入って「リンクが聞き取れない」と誤って止めた（実際に起きた）
rp = speech_qa.words_by_part(JA, real_win)
rt = [speech_qa.part_text(p, 'ja') for p in rp]
expect(rt[2].startswith('萌え袖') and not rt[1].endswith('萌'), '「萌」は3カット目')
expect(rt[5] == 'リンクから見てみてください', '「リ」は6カット目')

print('=== 喋りの検査（本物の不具合を拾えるか）===')
clips = [{}, {}, {}, {}, {'must_say': ['色落ち加工']}, {'must_say': ['リンク']}]
issues = speech_qa.check_speech(parts, clips, 'ja')
for s in issues:
    print('     ' + s)
expect(any('カット2' in s and 'のです' in s for s in issues), '「大きさなのです」を止める')
expect(any('カット5' in s and 'のです' in s for s in issues), '「こなれ感出るのです」を止める')
expect(any('カット5' in s and '色落ち加工' in s for s in issues), '「色打ち加工」を「色落ち加工が言えていない」と止める')
expect(not any('カット6' in s for s in issues), '言えている「リンク」は止めない')
expect(not any('カット4' in s for s in issues), '問題の無いカットは止めない')

en_issues = speech_qa.check_speech([EN4], [{'must_say': ['character']}], 'en')
expect(len(en_issues) == 1 and 'care' in en_issues[0], '英語: character が care になったのを止める')
expect(speech_qa.check_speech([EN4], [{'must_say': [['character', 'vintage wash']]}], 'en') == [],
       '英語: 言い換えの候補のどれかが言えていれば通す')

print('=== 架空の体験談（決定#178）も口から出たら止める ===')
hook_issues = speech_qa.check_speech([parts[0]], [{}], 'ja')
expect(any('よく聞かれ' in s for s in hook_issues), '「それ彼氏のってそうよく聞かれるやつね」を止める')
en_hook = W("""
0.30 0.84 Okay,
0.92 1.22 everyone
1.22 1.50 keeps
1.50 1.92 asking
1.92 2.32 where
2.32 2.46 I
2.46 2.66 got
2.66 2.90 this
2.90 3.20 hoodie.
""")
expect(len(speech_qa.check_speech([en_hook], [{}], 'en')) == 1, '英語「Everyone keeps asking where I got this hoodie」を止める')
ok_hooks = ['見てこの色落ちヴィンテージっぽくていい感じじゃない', 'これサイズ大きめだから彼氏の借りたみたいにゆるっと着れるやつ']
expect(all(speech_qa.check_speech([[{'text': t, 'start': 0, 'end': 1}]], [{}], 'ja') == [] for t in ok_hooks),
       '言い回しで回避したフックは通す')

print('=== 言い終わりの丁寧語（本番 run 36218880881 の実際の喋り）===')
one = lambda t: [[{'text': t, 'start': 0, 'end': 1}]]
expect(any('言い終わり' in s for s in speech_qa.check_speech(one('袖長めでね指先までちゃんと隠れる感じで可愛くないです'), [{}], 'ja')),
       '「可愛くないです」（問いかけが否定に変わる）を止める')
expect(any('言い終わり' in s for s in speech_qa.check_speech(one('これサイズ大きめだからさ、彼氏の借りたみたいにゆるっと着れるやつです。'), [{}], 'ja')),
       '「着れるやつです。」を止める')
expect(speech_qa.check_speech(one('頭まですっぽり入る大きさ'), [{}], 'ja') == [],
       '文中の「です」（頭まですっぽり）は止めない')

print('=== 喋った内容からの字幕 ===')
caps = speech_qa.captions_from_words(parts, 'ja', group_words)
for c in caps:
    print('     %.2f-%.2f %s' % (c['start'], c['end'], c['text']))
expect(all(' ' not in c['text'] for c in caps), '日本語の字幕に空白が入らない')
bounds = [w[0] for w in real_win[1:]]
cross = [c for c in caps for b in bounds if c['start'] < b - 0.15 < c['end'] - 0.3]
expect(not cross, 'カットをまたぐ字幕が無い')
expect(''.join(c['text'] for c in caps) == ''.join(texts), '字幕の文字＝喋った文字（足しも引きもしない）')
expect(all(c['start'] <= c['end'] for c in caps)
       and all(caps[i]['start'] <= caps[i + 1]['start'] for i in range(len(caps) - 1)),
       '時刻が壊れていない')
expect(all(len(c.get('word_cs') or []) >= 1 for c in caps), 'カラオケ用の語ごとの持ち時間がある')
expect([c['text'] for c in caps[:2]] == ['それ彼氏のってそうよく', '聞かれるやつね'],
       '長いカットは文節で割る（「そうよ｜く」「こな｜れ感」と語の途中で割らない）')
expect(all(len(c['text']) <= speech_qa.JA_MAX_CHARS for c in caps), '1枚は JA_MAX_CHARS 以下')

en_caps = speech_qa.captions_from_words([EN4], 'en', group_words)
expect(' '.join(c['text'] for c in en_caps) == 'This vintage wash gives it so much care.',
       '英語の字幕は空白で繋ぐ')

print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
