# 同梱素材の使い分け（部門をまたいで混ぜない）

★★2026-09-04、決定#079。**ここを間違えると、日本語の商品紹介に
英語圏部門のAIモデル映像が出る**。実際に一度そうなりかけた（下記）。

| ファイル | どの部門のものか | 用途 |
|---|---|---|
| `b-beach-sunset.mp4` / `b-pool-yellow.mp4` | **Aライン（英語圏）** | AIモデル「アンナ」系の検証用。日本語部門では使わない |
| `neutral-gradient.mp4` | **共通** | 素材が1本も取れなかった時の逃げ場。暗いグラデーションだけで、
どんな題材にも不適切にならない。ffmpegで生成（第三者の権利なし） |
| `bgm/*.mp3` | 共通 | CC0 |
| `sfx/*.mp3` | 共通 | ffmpegで生成（第三者の権利なし）。`sfx/README.md` に生成コマンド |
| `fonts/Anton-Regular.ttf` | Aライン（英語） | 描画側が文字種で自動選択 |
| `fonts/DelaGothicOne-Regular.ttf` | Bライン（日本語） | 同上 |
| `influencer/anna/*` | Aライン | 顔の一貫性の基準画像 |
| `demo/nova-pulse.png` | 共通（検証用） | 架空のガジェット。実商品として出さない |

## 踏んだ失敗

決定#069でJSON2Videoを外した時、Pexelsが素材を返さなかった場合の
フォールバックを `assets/b-beach-sunset.mp4` にした。これは
**Aライン（英語圏・水着のモデル映像）** で、日本語の商品紹介動画に
出てくると内容と全く噛み合わない。TikTokの審査に出す動画でこれが
起きれば、内容の不一致として不利にもなる。

→ `neutral-gradient.mp4` に変更した。素材が無い回は「暗い背景に字幕」
   という形になり、少なくとも**題材と矛盾しない**。

## 生成コマンド（neutral-gradient.mp4）

```bash
ffmpeg -y -f lavfi -i "gradients=s=1080x1920:c0=0x0b0b12:c1=0x1b1230:x0=200:y0=200:x1=900:y1=1700:d=12:speed=0.06,format=yuv420p" \
  -t 12 -r 30 -vf "noise=alls=6:allf=t+u,eq=brightness=-0.02" \
  -c:v libx264 -preset veryfast -crf 26 assets/neutral-gradient.mp4
```
