# code-video（コード製のモーショングラフィック動画）

jmas-ai-os の決定 #264・#266・#267（量産 M1〜M6）。設計の本体は jmas-ai-os の `samples/motion/FACTORY.md`。
ここは **描画を Actions の無料枠で回すための写し**（手元の作業場と同じ物）。

- 動かし方：Actions の **code-video** を `product_key` を入れて実行（`products/<key>.json` が要る）
- 流れ：素材を取る（Storage の商品画像・Pexels・edge-tts）→ 切り抜き（BiRefNet＋EDSR）→ 見出しごとに描く（60fps・8サブフレーム）
  → 点検12項目（`factory/qc.py`）→ 合格だけ Storage・LINE（承認依頼＋投稿文）・Release `render-marie-code-<key>-<id>`
- 型：`stage/editorial.html`（誌面）・`stage/pop.html`（ポップ）・`stage/paper.html`（紙）。共通の土台は `stage/core.js`

## してはいけないこと
- **商品画像・切り抜き・描いた途中の物をコミットしない**（`stage/p/` は .gitignore。実行時に取ってジョブと一緒に消える）
- 価格・セールを書かない／体験談を作らない／PR と ※ の条件は同じ画面に（#267）

## フォント
`stage/fonts`・`stage/fonts2` は Google Fonts の Dela Gothic One・Noto Sans JP・Shippori Mincho・Cormorant Garamond。
いずれも SIL Open Font License 1.1（https://openfontlicense.org）で、同梱・再配布が認められている。
