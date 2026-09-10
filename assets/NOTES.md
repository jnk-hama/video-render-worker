# 同梱素材の置き場所（部門で分ける）

★★2026-09-04、決定#082。**注意ではなく構造で分ける。**

```
assets/
  shared/   両部門で使う      bgm/ sfx/ demo/ neutral-gradient.mp4
  en/       Aライン専用       fonts/(Anton) clips/(b-*.mp4) influencer/(anna)
  ja/       Bライン専用       fonts/(Dela Gothic One)
```

## 守られ方（実測で確認済み）

依頼に `target_market: "ja" | "en"` を入れる。描画側は次のように振る舞う。

| 状況 | 挙動 |
|---|---|
| `ja` の依頼が `assets/en/…` を指した | **描かずに停止** |
| `en` の依頼が `assets/ja/…` を指した | **描かずに停止** |
| 本文が日本語なのに `target_market: "en"` | **描かずに停止** |
| 値が `ja` / `en` 以外 | **描かずに停止** |
| 未指定 | 本文の文字種から推定し、警告を出して続行（下記） |

★「使わずに次のクリップへ」ではなく**止める**。黙って別の映像に
  差し替わる方が危険で、出来上がった動画を見るまで誰も気づかない。

## 未指定をまだエラーにしていない理由

英語圏部門（GAS）は `clasp push` が済むまで古いコードのままで、
このフラグを送らない。ここで落とすと、描画側を更新した瞬間に
**Aラインが全部止まる**。デプロイの順番で壊れる設計は既に2度踏んでいる
（#076 のcron認証、#079 のYAMLパース）。

**切り替え条件**：GAS（`36_Render.js`）と Supabase（`handleWaitingRender`）の
**両方が送っていることを実走で確認できたら**、`resolve_market()` の
「指定なし」分岐を `SystemExit` に変える。

## 踏んだ失敗（消さずに残す）

決定#069でJSON2Videoを外した時、Pexelsが素材を返さなかった場合の
フォールバックを `assets/b-beach-sunset.mp4` にした。これは
**Aライン（英語圏・水着のモデル映像）** で、日本語の商品紹介動画に
出てくると内容と全く噛み合わない。TikTokの審査に出す動画でこれが
起きれば、内容の不一致として不利にもなる。

→ `shared/neutral-gradient.mp4` に変更し、さらに置き場所自体を分けた。

## neutral-gradient.mp4 の作り方

```bash
ffmpeg -y -f lavfi -i "gradients=s=1080x1920:c0=0x0b0b12:c1=0x1b1230:x0=200:y0=200:x1=900:y1=1700:d=12:speed=0.06,format=yuv420p" \
  -t 12 -r 30 -vf "noise=alls=6:allf=t+u,eq=brightness=-0.02" \
  -c:v libx264 -preset veryfast -crf 26 assets/shared/neutral-gradient.mp4
```

## preview-motion.mp4 の作り方（**確認用。本番では使わない**）

★★2026-09-10 追加。オーナー指摘「背景は真っ暗です」。

`neutral-gradient.mp4` は**逃げ場の映像**で、実測 YAVG 24.7/255 と暗い。
その上に運鏡（push_in / orbit）が掛かると完成動画は YAVG 6.8〜16.3 まで
落ちて、ほぼ黒い画面になる。テロップの出方や尺を目で確かめたい時に
背景が黒いと、**読みやすさの判断ができない**。

そこで確認用に明るい動く背景を1本置く（実測 YAVG 58.5）。

```bash
ffmpeg -y \
 -f lavfi -i "gradients=s=540x960:c0=0x14203f:c1=0x2f6f8f:c2=0x7a3f7d:c3=0x1d3557:nb_colors=4:seed=11:duration=12:speed=0.006:rate=30" \
 -f lavfi -i "gradients=s=540x960:c0=0x000000:c1=0x2a4a6a:c2=0x000000:c3=0x5a3a70:nb_colors=4:seed=29:duration=12:speed=0.012:rate=30" \
 -filter_complex "[0][1]blend=all_mode=screen:all_opacity=0.5,gblur=sigma=30,eq=saturation=0.9:brightness=0.02,scale=1080:1920,vignette=angle=PI/5,format=yuv420p[v]" \
 -map "[v]" -t 12 -c:v libx264 -crf 21 assets/shared/preview-motion.mp4
```

★半分の解像度で作ってから拡大している。ぼかしを掛けるので細部は要らず、
  この方が速く小さい（1.6MB）。
★`vignette` は周辺を落とすため。字幕は下寄りに出るので、そこが締まって
  白文字が読める。

★★**本番の背景はPexelsの実写**（process-job が選んで渡す）。これは
  実写が用意できない確認の回だけに使う。合成のグラデーションで
  「本番の見え方」を判断しないこと。

効果音の作り方は `shared/sfx/README.md`。
