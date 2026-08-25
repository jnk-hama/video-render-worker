# video-render-worker

縦型ショート動画を組み立てる装置。**単体では何もしない。**
LINE bot（Google Apps Script 側）から呼ばれて動く。

なぜ分けてあるか：GAS は Python も FFmpeg も動かせず、実行も6分で切れる。
描画だけをここへ出すと、GitHub Actions の無料枠で処理できる。

```
GAS ──(repository_dispatch)──> ここ ──(Release へ MP4)──> GAS が回収
```

GAS は完了を待たない（待てない）。頼んで、次のサイクルで取りに行く。

## 中身

| ファイル | 役割 |
|---|---|
| `.github/workflows/render-video.yml` | 受け口。ffmpeg を入れて描画し、Release へ上げる |
| `scripts/render_video.py` | 描画本体。クリップを 9:16 に揃えて連結する |
| `scripts/tts.py` | 読み上げ音声（モードA）。発声時刻から字幕を作る |

## モード

- **A** … 読み上げ音声＋発声に合わせて単語ごとにポップする字幕
- **B** … 音声も字幕も無し。ハイテンポなカット割りのみ

## GAS 側に入れる設定（2つだけ）

Apps Script → プロジェクトの設定 → スクリプト プロパティ

| キー | 値 |
|---|---|
| `GITHUB_REPO` | `jnk-hama/video-render-worker` |
| `GITHUB_TOKEN` | 下記の PAT |

### PAT（Fine-grained）

https://github.com/settings/personal-access-tokens/new

- Repository access … **このリポジトリだけ**を選ぶ
- Permissions … **Contents: Read and write** のみ

`Contents: write` が要るのは2つの理由による。
`POST /repos/{owner}/{repo}/dispatches` がこの権限を要求すること、
そして GAS が Release から MP4 を取りに来ること。

## 動くか確かめる（GAS を触らずに試せる）

Actions → render-video → Run workflow → `payload_json` に貼る:

```json
{"job":{"job_id":"test-1","mode":"B","width":1080,"height":1920,"fps":30,
"clips":[{"url":"https://cdn.pixabay.com/video/2023/10/22/185843-877653537_tiny.mp4"},
         {"url":"https://cdn.pixabay.com/video/2023/10/22/185843-877653537_tiny.mp4"}]}}
```

数分後、Releases に `render-test-1` として MP4 が出れば通っている。

## 送信の形（重要）

`client_payload` は **最上位プロパティを10個までしか受け付けない**。
超えると 422 が返り、ワークフローは起動すらしない。
そのため `{"job": {...}}` と1個に畳んで送る。

以前は平置きで送っており、モードAは
`job_id / account / mode / width / height / fps / clip_seconds / clips /
narration / captions` でちょうど10個。**上限に張り付いていた。**
`render_video.py` は `voice` / `seed` / `font_size` も読む作りなのに、
どれか1つ足した瞬間に全部の描画が止まる状態だった。

畳んだので今は 1/10。残り9枠は将来のために空けてある。

（受け口は入れ子・平置きの両方を読むので、GAS 側が古いままでも動く）

## public か private か

- **public** … Actions は無制限
- **private** … 2,000分/月。1本あたり1〜3分なので 8本/日 なら収まる

ここに秘密は入っていないので public で問題ない。
ただし出来上がった MP4 は誰でも取得できる状態になる。
どうせ X へ公開投稿するものなので実害は無いが、承知の上で選ぶこと。

## 保守

Release は1本ごとに1つ増える。2アカウント×4本/日 なら月およそ240個。
ワークフローの最後に、3日より古い `render-*` を消す掃除を入れてある
（GAS の待ちは30分で打ち切られるので、3日より古いものは誰も取りに来ない）。
`render-` で始まらない Release は触らない。
