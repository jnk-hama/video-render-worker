// 誰に刺さる動画か（オーナー「全動画どんな人に刺さるのかを意識して欲しい」・#283）。
// 設計書の target.who を最初のカットで札にして出す（全テンプレ共通）
(() => {
  if (!P.target || !P.target.who) return;
  const css = document.createElement("style");
  // 置き場所は PR の右（下は TikTok の説明文が重なる・ルックブックは下に見出しがある）
  css.textContent = `.tg { position:absolute; left:150px; top:166px; display:flex; align-items:center; gap:10px; padding:8px 20px 8px 10px; border-radius:30px;
    background:rgba(255,253,248,.95); box-shadow:0 8px 20px rgba(40,30,20,.12); font:900 30px/1.2 "Noto Sans JP"; color:#1C1A17; opacity:0; z-index:6; }
  .tg .ic { width:36px; height:36px; border-radius:50%; background:var(--tg-acc, #9A6438); display:grid; place-items:center; flex:none; }`;
  document.head.appendChild(css);
  const tg = el("div", { class: "tg" }, `<span class="ic"><svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="#fff"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="#fff"/></svg></span><span>${P.target.who}</span>`);
  U.push((t) => { const a = sp(t - 0.55, 11, 0.85), o = outC((t - OUT(0)) / 0.25); tg.style.opacity = clamp(a * 1.3) * (1 - o); tg.style.transform = `translateY(${(1 - clamp(a)) * 30}px)`; });
})();
