// stagekit.js — 型（humid.html など）が共通に使う舞台の道具。時刻は SK.T だけ（タイマー・乱数なし）。
//   字はマスクの中を下から入り（outExpo）、上へ速く抜ける（inCubic）。写真は .prod の層＝重なりの点検で「商品」側。
//   edge.html（UGREEN）は同じ道具を自前で持っている（v4 で確定済みの型なので触らない）。新しい型はこちらを使う。
(function (root) {
  const { E, clamp } = root.EDGE;
  const NS = "http://www.w3.org/2000/svg";
  const SK = { T: 0, U: [], AFTER_FONTS: [], NS };
  const $ = (id) => document.getElementById(id);
  SK.$ = $;
  SK.f2 = (v) => v.toFixed(2);
  SK.el = (tag, attrs = {}, html = "", parent = $("ui")) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html) e.innerHTML = html; parent.appendChild(e); return e; };
  SK.sv = (tag, attrs = {}, parent = $("over")) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent.appendChild(e); return e; };
  SK.ln = (style, html, parent) => SK.el("div", { class: "ln", style }, `<span class="in">${html}</span>`, parent);
  SK.reveal = (e, tin, tout, d = 0.55, dout = 0.22) => {
    const a = E.outExpo((SK.T - tin) / d), o = E.inCubic((SK.T - tout) / dout);
    e.firstElementChild.style.transform = `translateY(${((1 - a) * 115 - o * 115).toFixed(2)}%)`;
    e.style.visibility = SK.T < tin || SK.T > tout + dout ? "hidden" : "visible";
  };
  SK.fade = (e, tin, tout, d = 0.3) => { e.style.opacity = (clamp((SK.T - tin) / d) * (1 - clamp((SK.T - tout) / 0.2))).toFixed(3); };
  SK.note = (text, y, tin, tout, cls = "note") => { const e = SK.el("div", { class: cls, style: `top:${y}px` }, text); SK.U.push(() => SK.fade(e, tin, tout)); return e; };
  SK.photo = (dir, src, x, y, w, h, cls = "plate", origin = "50% 50%") =>
    SK.el("div", { class: cls, style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:0` }, `<img src="${dir}${src}" style="transform-origin:${origin}">`, $("prodlayer"));
  // 文字の層（#ui）の中で文字より上・PR とクレジットより下に置く覆い（洪水・走査線の切り替え）。class="scrim"＝重なりの点検の対象外
  SK.coverLayer = () => { const s = document.createElementNS(NS, "svg"); for (const [k, v] of Object.entries({ class: "scrim", width: 1080, height: 1920, viewBox: "0 0 1080 1920", style: "position:absolute;left:0;top:0;z-index:2;pointer-events:none" })) s.setAttribute(k, v); $("ui").appendChild(s); return s; };
  SK.circ = (cx, cy, r) => `M${(cx - r).toFixed(2)} ${cy.toFixed(2)} a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0 a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0Z`;
  // 時刻を進める・用意ができたら READY（字形を先に読み込む：隠れている字は読み込みを起こさないため）
  SK.boot = (weights = [300, 400, 500, 700]) => {
    root.seek = (t) => { SK.T = t; for (const f of SK.U) f(); };
    root.READY = (async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
      const text = $("ui").textContent + "0123456789.mlhLdB畳";
      for (const w of weights) await document.fonts.load(`${w} 40px "Noto Sans JP"`, text);
      SK.AFTER_FONTS.forEach((f) => f());
      root.seek(0); return true;
    })();
  };
  root.SK = SK;
})(window);
