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

print('=== 無音を詰めた回はカットごとに起こす（run 36227562528）===')
# 本番: カットの間は 0.35秒。Whisper は次のカットの1語目の開始を前の無音へはみ出させ、
# 1本で起こして時刻で振ると「…被れちゃうんだよね袖」「楽です気」になった
PARTS = {'a.wav': [{'text': 'フード', 'start': 0.10, 'end': 0.50}, {'text': 'だよね', 'start': 2.9, 'end': 3.16}],
         'b.wav': [{'text': '袖', 'start': 0.00, 'end': 0.30}, {'text': '長め', 'start': 0.30, 'end': 0.70}]}
tp = speech_qa.transcribe_parts(['a.wav', 'b.wav'], [(0.0, 3.41), (3.41, 7.64)], 'ja',
                                transcribe_fn=lambda p, lang: PARTS[p])
expect([speech_qa.part_text(p, 'ja') for p in tp] == ['フードだよね', '袖長め'], 'カットの1語目は必ずそのカット')
expect(abs(tp[1][0]['start'] - 3.41) < 1e-6, '時刻は完成品の時間軸へずらす')
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'render_video.py'), encoding='utf-8').read()
expect('speech_qa.transcribe_parts(part_audio' in src, 'render_video.py がカットごとの起こしを使っている（配線）')

print('=== 台本と字幕の一致度（#199）===')
good = [('見て！この色落ち、えぐいくらいヴィンテージ感ある', '見てます。この色落ちね、えぐいくらいヴィンテージ感ある'),
        ('サイズ大きめで、シルエットかわいい', 'サイズ大きめでね、シルエット可愛い'),
        ('コードないから、サッと使える', 'ので コードないから ね サッと使える')]
bad = [('片手で持てる軽さ、ガチで楽', 'うん、ね、これね、ね、片手で持てる軽さね、マジで楽だよね。あ'),
       ('下からも開くから、抜け感出せる', '下からも開くから座ったら'),
       ('大きめフードで、こなれ感出る', '大きさなのです')]
expect(all(speech_qa.script_match(a, b, 'ja') >= speech_qa.SCRIPT_MATCH_MIN for a, b in good), '実際に通った言い回しは止めない（ね・可愛い・前置き）')
expect(all(speech_qa.script_match(a, b, 'ja') < speech_qa.SCRIPT_MATCH_MIN for a, b in bad), '言い淀み・言い換え・聞き違いは止める')
expect(speech_qa.script_match(None, 'なんでも', 'ja') == 1.0, '台本の無い回は比べない（従来どおり）')
iss = speech_qa.check_speech([[{'text': '下からも開くから座ったら', 'start': 0, 'end': 1}]],
                             [{'line': '下からも開くから、抜け感出せる'}], 'ja')
expect(any('台本と大きく違う' in t for t in iss), '描画側の検査でも止める（字幕に焼く前）')

print('=== 喋りの検査（本物の不具合を拾えるか）===')
clips = [{}, {}, {}, {}, {'must_say': ['色落ち加工']}, {'must_say': ['リンク']}]
issues = speech_qa.check_speech(parts, clips, 'ja')
for s in issues:
    print('     ' + s)
expect(any('カット2' in s and 'のです' in s for s in issues), '「大きさなのです」を止める')
expect(any('カット5' in s and 'のです' in s for s in issues), '「こなれ感出るのです」を止める')
expect(any('カット5' in s and '色落ち加工' in s for s in issues), '「色打ち加工」を「色落ち加工が言えていない」と止める')
expect(not any('カット6' in s and '丁寧語' not in s for s in issues), '言えている「リンク」は止めない')
# ★この実録の CTA は「見てみてください」で、当時は通っていた。タメ口の子の敬語終わりとして止める（#197）
expect(any('カット6' in s and 'ください' in s for s in issues), '「見てみてください」を止める')
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

print('=== 無音を詰める範囲（決定#179）===')
# marie-ja-v2 の袖のカット: 喋りは 0.04〜2.52秒（クリップ頭基準）、クリップは 2.9秒
sw = speech_qa.speech_window([{'text': '萌', 'start': 0.04, 'end': 0.2}, {'text': 'です', 'start': 2.3, 'end': 2.52}], 0.0, 2.9)
expect(abs(sw[0] - 0.0) < 1e-6 and abs(sw[1] - 2.77) < 1e-6, '喋り始めの0.1秒前（頭は0で止まる）〜喋り終わり0.25秒後')
sw2 = speech_qa.speech_window([{'text': 'a', 'start': 1.0, 'end': 1.5}, {'text': 'b', 'start': 3.0, 'end': 3.4}], 0.5, 6.0)
expect(abs(sw2[0] - 1.4) < 1e-6 and abs(sw2[1] - 2.75) < 1e-6, '頭の無音も詰める（元の開始 0.5秒からの相対で数える）')
expect(speech_qa.speech_window([], 0.0, 6.0) == (0.0, 6.0), '喋っていないカットは詰めない（映像だけのカットを消さない）')
expect(speech_qa.speech_window([{'text': 'a', 'start': 2.0, 'end': 2.3}], 0.0, 6.0) == (0.0, 6.0),
       '短くなりすぎる時（1秒未満）は詰めない')

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

print('=== 同じ読みの漢字の取り違え（決定#180・run 36225782849 の h3）===')
# 本番の文字起こしは「袖長めで指先まで隠れるのでガチで漏れる」。語は1〜2文字ずつに割れて届く
H3 = W("""
0.10 0.40 袖
0.40 0.70 長
0.70 0.90 め
0.90 1.00 で
1.00 1.30 指
1.30 1.50 先
1.50 1.70 まで
1.70 2.00 隠
2.00 2.20 れる
2.20 2.40 ので
2.40 2.70 ガチ
2.70 2.80 で
2.80 3.00 漏
3.00 3.30 れる
""")
h3_caps = speech_qa.captions_from_words([H3], 'ja', group_words)
h3_text = ''.join(c['text'] for c in h3_caps)
print('     ' + ' | '.join(c['text'] for c in h3_caps))
expect('盛れる' in h3_text and '漏れる' not in h3_text, '字幕は「ガチで盛れる」（語が「漏｜れる」に割れていても直る）')
expect(speech_qa.part_text(H3, 'ja').endswith('漏れる'), '検査が見る文字起こしは直さない（音の誤りを隠さない）')
pc = speech_qa.captions_from_words([W("""
0.0 0.5 サイズ大きめでね、
0.5 1.2 シルエットかわいい。
""")], 'ja', group_words)
print('     ' + ' | '.join(c['text'] for c in pc))
expect(all('。' not in c['text'] and not c['text'].endswith('、') for c in pc),
       '字幕に句点を出さず、末尾の読点も落とす（run 36227979886）')
expect(speech_qa.captions_from_words([[{'text': '漏れる', 'start': 0, 'end': 1}]], 'en', group_words)[0]['text'] == '漏れる',
       '英語の回には掛けない')

en_caps = speech_qa.captions_from_words([EN4], 'en', group_words)
expect(' '.join(c['text'] for c in en_caps) == 'This vintage wash gives it so much care.',
       '英語の字幕は空白で繋ぐ')

print('=== 言い終わりの丁寧語を切る（#189）===')
W = lambda *xs: [{'text': t, 'start': a, 'end': b} for t, a, b in xs]  # noqa: E731
w2, cut = speech_qa.strip_polite_end(W(('座っても', 0.0, 0.8), ('楽', 0.8, 1.0), ('です', 1.0, 1.4)), 'ja')
expect(cut and speech_qa.part_text(w2, 'ja') == '座っても楽' and w2[-1]['end'] == 1.0, '別の語の「です」は語ごと外す')
w2, cut = speech_qa.strip_polite_end(W(('座っても', 0.0, 0.8), ('楽です。', 0.8, 1.4)), 'ja')
expect(cut and speech_qa.part_text(w2, 'ja') == '座っても楽' and abs(w2[-1]['end'] - 1.0) < 1e-9,
       '繋がった「楽です」は文字数の割合で切る（1/3）')
w2, cut = speech_qa.strip_polite_end(W(('かわいい', 0.0, 0.6), ('ですね', 0.6, 1.0)), 'ja')
expect(cut and speech_qa.part_text(w2, 'ja') == 'かわいい', '「ですね」も外す（長い方から当てる）')
w2, cut = speech_qa.strip_polite_end(W(('フード', 0.0, 0.5), ('大きい', 0.5, 1.0)), 'ja')
expect(not cut and len(w2) == 2, '丁寧語が無ければ何もしない')
w2, cut = speech_qa.strip_polite_end(W(('です', 0.0, 0.4)), 'ja')
expect(not cut, '喋りが丁寧語だけなら外さない（カットを消さない）')
w2, cut = speech_qa.strip_polite_end(W(('頭まですっぽり', 0.0, 1.0)), 'ja')
expect(not cut, '文中の「です」は切らない')
kept = W(('座っても', 0.0, 0.8), ('楽', 0.8, 1.0))
expect(speech_qa.polite_cut_ok(W(('座っても', 0, .8), ('楽', .8, 1.0)), kept, 'ja'), '丁寧語が消え最後の語が残れば合格')
expect(not speech_qa.polite_cut_ok(W(('座っても', 0, .8), ('楽しいです', .8, 1.3)), kept, 'ja'), '丁寧語が残れば不合格')
expect(not speech_qa.polite_cut_ok(W(('下からも開くからね', 0, 1.0), ('座っても', 1.0, 1.6)), kept, 'ja'),
       '最後の語まで消えた（言いかけ）は不合格（run 36276637562 の「座っても」）')
expect(not speech_qa.polite_cut_ok([], kept, 'ja'), '何も聞こえなければ不合格')
cands = speech_qa.polite_cut_candidates(W(('座っても', 0.0, 0.8), ('楽', 0.8, 1.2)))
expect(len(cands) == speech_qa.POLITE_TRIES and cands[0] == 1.2 and all(x > y for x, y in zip(cands, cands[1:]))
       and min(cands) > 0.8, '切り位置の候補は手前へ下がっていき、最後の語の頭は越えない')
expect(not speech_qa.check_speech([speech_qa.strip_polite_end(W(('座っても', 0, .8), ('楽です', .8, 1.4)), 'ja')[0]],
                                  [{}], 'ja'), '切った後は喋りの検査を通る')

print('=== 崩れた喋り・幻聴・無音は字幕にも声にも使わない（#238・RR35 本番 2026-09-30）===')
_clips = [{'line': '最大約5か月、ゴミ捨て不要'}, {'line': '細かいゴミも、どんどん吸い込む'},
          {'line': 'コードないからサッと使える、片手で持てる軽さガチで楽'}, {'line': 'ただ置くだけで、あとは勝手にやってくれる'},
          {}]
_parts = [W(('最大約5ヶ月ね', 0, 1), ('ゴミ捨て不要不要タイタイル', 1, 2.5)),   # 本番の実物（一致度 0.69）
          W(('細かいゴミもね', 0, 1), ('どんどん吸い込む', 1, 2)),
          W(('ご視聴ありがとうございました', 0, 2)),                         # 本番の実物（声の無い静止画に幻聴）
          [],                                                              # 声なし
          W(('なんでも', 0, 1))]                                           # 台本の無いカットは見ない
_bad = dict(speech_qa.bad_speech(_parts, _clips, 'ja'))
expect(0 in _bad and '台本と大きく違う' in _bad[0], '「ゴミ捨て不要不要タイタイル」（一致度 0.69）は使わない')
expect(2 in _bad and '幻聴' in _bad[2], '「ご視聴ありがとうございました」は幻聴として使わない')
expect(3 in _bad and '声なし' in _bad[3], '声の無いカットも台本の読み上げを当てる対象')
expect(1 not in _bad and 4 not in _bad, '台本どおりの喋り（「ね」入りでも一致度が高い）と台本の無いカットはそのまま')
expect(speech_qa.is_hallucination('チャンネル登録お願いします', 'ja') and not speech_qa.is_hallucination('どんどん吸い込む', 'ja'),
       '幻聴の決まり文句だけを拾う')

print()
if fails:
    print('不合格 %d 件' % len(fails))
    sys.exit(1)
print('合格')
