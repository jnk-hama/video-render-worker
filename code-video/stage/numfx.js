// 数字の見せ方（オーナー「バロメーターみたいなデザイン他なんかないですか？全部そのデザインだと飽きがきます」→「ランダムに最適解で」）
// 全ての型が使う1つのカット「num」。どの見せ方（motif）にするかは factory/motif.py が数字の種類から選んで設計書に書く。
//   flap=パタパタ（測った値）／magnify=倍率の大写し（2つの比較）／calendar=カレンダー（月数）／cup=計量カップ（容量）／donut=ドーナツ（割合）／figures=人型（サイズ）
// 色と書体は型ごとに :root の --nf-* で決める（ink / acc=線と面 / acc-ink=金などの文字 / mut / num=数字の書体）
(() => {
  const css = document.createElement("style");
  css.textContent = `
  .nf { position:absolute; inset:0; pointer-events:none; }
  .nf-title { position:absolute; left:64px; top:290px; width:952px; font:900 84px/1.2 var(--nf-head, "Noto Sans JP"); color:var(--nf-ink); }
  .nf-num { font-family:var(--nf-num, "Dela Gothic One"); font-weight:var(--nf-num-w, 400);   /* 同梱の太さだけ（Cormorant は 300/500・#270） */ font-feature-settings:"lnum" 1; font-variant-numeric:lining-nums; }
  .nf-sub { position:absolute; left:64px; width:952px; font:900 46px/1.3 "Noto Sans JP"; color:var(--nf-ink); }
  .nf-note { position:absolute; left:64px; top:1700px; width:952px; font:500 26px/1.5 "Noto Sans JP"; color:var(--nf-mut); }
  .nf-mark { font:700 40px/1 "Noto Sans JP"; vertical-align:super; margin-left:4px; }
  .nf-flap { position:absolute; width:128px; height:200px; perspective:900px; }
  .nf-flap .h { position:absolute; left:0; width:128px; height:100px; overflow:hidden; background:var(--nf-ink); color:var(--nf-bg); font:400 136px/200px "Dela Gothic One"; text-align:center; }   /* 書体は型によらず太字（細い書体だと 1 が I に見える） */
  .nf-flap .t { top:0; border-radius:14px 14px 0 0; } .nf-flap .b { top:100px; border-radius:0 0 14px 14px; }
  .nf-flap .b span { display:block; margin-top:-100px; } .nf-flap .fl { transform-origin:50% 100%; z-index:2; }
  .nf-flap::after { content:""; position:absolute; left:0; top:99px; width:128px; height:2px; background:rgba(0,0,0,.6); z-index:3; }
  .nf-stamp { position:absolute; border-radius:50%; border:12px solid var(--nf-acc-ink); color:var(--nf-acc-ink); display:grid; place-items:center; text-align:center; background:var(--nf-bg); }
  .nf-cal { position:absolute; width:460px; height:520px; perspective:1600px; }
  .nf-page { position:absolute; inset:0; border-radius:28px; background:#fff; box-shadow:0 18px 40px rgba(40,30,10,.18); transform-origin:50% 0; backface-visibility:hidden; overflow:hidden; }
  .nf-page .hd { height:110px; background:var(--nf-ink); color:#F6F3EE; font:900 44px/110px "Noto Sans JP"; text-align:center; letter-spacing:.08em; }
  .nf-page .n { font:var(--nf-num-w, 400) 280px/400px var(--nf-num, "Dela Gothic One"); text-align:center; color:var(--nf-ink); }
  .nf-stamp .gold { color:inherit; }   /* 判の中の金文字は判の色に（金は背景に 2.8:1・#277） */
  .nf-ring { position:absolute; top:-26px; width:22px; height:60px; border-radius:11px; background:#8A847A; z-index:30; }`;
  document.head.appendChild(css);
  const fmt = (v) => (Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(v));
  const mark = (b) => (b.mark ? `<span class="nf-mark">${b.mark}</span>` : "");

  const M = {
    // パタパタ：駅の表示板のように桁がめくれて止まる（測った値）
    flap(b, box, t0) {
      const s = fmt(b.value), digits = [...s].filter((c) => /\d/.test(c)).length, tw = Math.min(213, 740 / Math.max(digits, 1));   // 桁が少ないほど大きく（単位まで画面に収まる大きさに下で合わせる）
      let sc = tw / 142, fit = false;
      const row = el("div", { class: "abs", style: `left:64px;top:${860 - 100 * sc}px;transform-origin:0 0;transform:scale(${sc})` }, "", box); let x = 0; const flaps = [];
      [...s].forEach((c) => { if (!/\d/.test(c)) { el("div", { class: "abs", style: `left:${x}px;top:40px;font:400 130px/1 'Dela Gothic One';color:var(--nf-ink)` }, c, row); x += 50; return; }
        flaps.push({ n: +c, e: el("div", { class: "nf-flap", style: `left:${x}px;top:0` }, `<div class="h t"><span></span></div><div class="h b"><span></span></div><div class="h t fl"><span></span></div>`, row) }); x += 142; });
      const unit = el("div", { class: "abs nf-num", style: `left:${64 + x * sc + 16}px;top:${860 + 100 * sc - 110}px;font-size:96px;line-height:1;color:var(--nf-ink);opacity:0` }, `${b.unit || ""}${mark(b)}`, box);
      return (u) => { if (!fit) { fit = true; sc = Math.min(sc, (952 - 16 - unit.offsetWidth) / x);   // 単位が右へはみ出さない（「万個」で実際にはみ出した）
          row.style.transform = `scale(${sc})`; row.style.top = `${860 - 100 * sc}px`; unit.style.left = `${64 + x * sc + 16}px`; unit.style.top = `${860 + 100 * sc - 110}px`; }
        flaps.forEach((f, k) => { const stop = 0.6 + k * 0.28, spins = 6 + k * 2, [top, bot, flip] = f.e.children;
          if (u >= stop) { top.firstChild.textContent = f.n; bot.firstChild.textContent = f.n; flip.style.display = "none"; }
          else { const q = (Math.max(u, 0) / stop) * spins, idx = Math.floor(q), ph = q - idx, cur = (f.n - spins + idx + 100) % 10;
            top.firstChild.textContent = (cur + 1) % 10; bot.firstChild.textContent = cur; flip.firstChild.textContent = cur; flip.style.display = "block"; flip.style.transform = `rotateX(${-ph * 90}deg)`; }
          const a = sp(u, 12, 1); f.e.style.transform = `translateY(${(1 - a) * 60}px)`; f.e.style.opacity = clamp(a * 1.4); });
        unit.style.opacity = clamp(sp(u - 0.6 - flaps.length * 0.28, 12, 1) * 1.3); };
    },
    // 倍率の大写し：小さい数字（前・通常）から大きい数字が迫り、「約◯倍」の判が押される（2つの比較）
    magnify(b, box, t0) {
      const r = Math.round((b.value / b.base) * 10) / 10;
      const bl = el("div", { class: "abs", style: "left:64px;top:470px;font:700 40px/1 'Noto Sans JP';color:var(--nf-mut);opacity:0" }, b.base_label || "", box);
      const ba = el("div", { class: "abs nf-num", style: "left:64px;top:530px;font-size:90px;line-height:1;color:var(--nf-mut);opacity:0" }, `${fmt(b.base)}<span style="font-size:44px"> ${b.unit || ""}</span>`, box);
      const big = el("div", { class: "abs nf-num", style: "left:540px;top:1040px;font-size:190px;line-height:1;white-space:nowrap;color:var(--nf-ink);opacity:0" }, "", box);
      const vl = el("div", { class: "abs", style: "left:64px;top:1200px;width:952px;text-align:center;font:900 48px/1 'Noto Sans JP';color:var(--nf-ink);opacity:0" }, `${b.value_label || ""}`, box);
      const st = el("div", { class: "nf-stamp", style: "left:680px;top:430px;width:320px;height:320px;opacity:0" }, `<div><div style="font:900 42px/1 'Noto Sans JP'">約</div><div class="nf-num" style="font-size:130px;line-height:.95">${r}<span style="font-size:64px">倍</span></div></div>`, box);
      let fitS = 0;
      return (u) => { const a = sp(u - 0.1, 10, 1), g = inOutC((u - 0.6) / 0.9), s = sp(u - 1.7, 16, 0.5);
        bl.style.opacity = ba.style.opacity = clamp(a * 1.3);
        big.innerHTML = `${fmt(Math.round(lerp(b.base, b.value, outC((u - 0.6) / 0.9)) / 100) * 100 || b.value)}<span style="font-size:80px"> ${b.unit || ""}</span>${mark(b)}`;
        if (u >= 1.5) big.innerHTML = `${fmt(b.value)}<span style="font-size:80px"> ${b.unit || ""}</span>${mark(b)}`;
        if (!fitS) fitS = Math.min(1.1, 952 / Math.max(big.offsetWidth, 1));
        big.style.transform = `translate(-50%, -50%) scale(${lerp(0.25, fitS, g)})`; big.style.opacity = clamp(g * 2); vl.style.opacity = clamp((u - 1.4) / 0.3);
        st.style.opacity = clamp(s * 1.3); st.style.transform = `rotate(-12deg) scale(${lerp(2.2, 1, clamp(s, 0, 1.2))})`; };
    },
    // カレンダー：月がめくれていく（時間の長さを体で感じる）
    calendar(b, box, t0) {
      const n = b.months, cal = el("div", { class: "nf-cal", style: "left:110px;top:560px" }, "", box);
      for (let k = n; k >= 1; k--) el("div", { class: "nf-page" }, `<div class="hd">${k}${b.cell_label || ""}</div><div class="n">${k}</div>`, cal);
      [80, 180, 280, 360].forEach((l) => el("div", { class: "nf-ring", style: `left:${l}px` }, "", cal));
      const pages = [...cal.querySelectorAll(".nf-page")].reverse();
      const val = el("div", { class: "abs nf-num", style: "left:64px;top:1170px;font-size:130px;line-height:1;color:var(--nf-ink);opacity:0" }, `${b.num}<span style="font-size:70px">${b.unit || ""}</span>${mark(b)}`, box);
      const st = b.badge ? el("div", { class: "nf-stamp", style: "left:640px;top:880px;width:330px;height:330px;opacity:0" }, `<div style="font:900 50px/1.25 'Noto Sans JP'">${b.badge}</div>`, box) : null;
      const gap = Math.min(0.3, 1.2 / Math.max(n - 1, 1)), end = 0.35 + (n - 1) * gap + 0.3;
      return (u) => { const F = pages.map((p, k) => inOutC((u - 0.35 - k * gap) / 0.32));
        pages.forEach((p, k) => { const f = F[k], shown = (k === 0 || F[k - 1] >= 0.98) && (k === n - 1 || f <= 0.02);
          p.firstChild.style.color = shown ? "" : "transparent";   /* めくれている途中・上の紙に隠れている見出しは出さない（読めない） */ p.style.transform = k < n - 1 ? `rotateX(${f * 178}deg)` : "none"; p.style.zIndex = 20 - k; p.style.opacity = k < n - 1 && f > 0.98 ? 0 : 1; });
        cal.style.opacity = clamp(sp(u, 12, 1) * 1.4); val.style.opacity = clamp(sp(u - end, 12, 1) * 1.3);
        if (st) { const s = sp(u - end - 0.25, 16, 0.5); st.style.opacity = clamp(s * 1.3); st.style.transform = `rotate(-14deg) scale(${lerp(2.2, 1, clamp(s, 0, 1.2))})`; } };
    },
    // 計量カップ：目盛りの中を水位が上がる（量を実物の感覚で）
    cup(b, box, t0) {
      const mx = b.max, step = mx / 6, H = 900, k = 0.8;
      let tk = "", labs = []; for (let m = step; m < mx - step / 2; m += step) { const y = 960 - (m / mx) * H; tk += `<line x1="${135 + (960 - y) * 0.045}" y1="${y}" x2="${200 + (960 - y) * 0.045}" y2="${y}" stroke="var(--nf-ink)" stroke-width="6"/>`; labs.push([215 + (960 - y) * 0.045, y, Math.round(m)]); }
      const yv = 960 - (b.value / mx) * H; tk += `<line x1="${110 + (960 - yv) * 0.045}" y1="${yv}" x2="300" y2="${yv}" stroke="var(--nf-acc)" stroke-width="8" stroke-dasharray="14 10"/>`;
      const id = `nfw${Math.random().toString(36).slice(2, 7)}`;
      const svg = el("div", { class: "abs", style: `left:80px;top:500px;width:${600 * k}px;height:${1000 * k}px;opacity:0` }, `<svg width="${600 * k}" height="${1000 * k}" viewBox="0 0 600 1000">
        <defs><clipPath id="${id}c"><path d="M90,60 L510,60 L470,940 Q468,960 448,960 L152,960 Q132,960 130,940 Z"/></clipPath>
        <linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7FB2CF"/><stop offset="1" stop-color="#3E6E8E"/></linearGradient></defs>
        <g clip-path="url(#${id}c)"><rect x="0" y="0" width="600" height="1000" fill="#fff"/><path class="w" d="" fill="url(#${id}g)"/></g>
        <path d="M90,60 L510,60 L470,940 Q468,960 448,960 L152,960 Q132,960 130,940 Z" fill="none" stroke="var(--nf-ink)" stroke-width="10" stroke-linejoin="round"/>
        <g>${tk}</g></svg>${labs.map(([x, y, m]) => `<div class="abs nf-num" style="left:${x * k}px;top:${y * k - 20}px;font-size:32px;line-height:40px;padding:0 8px;border-radius:8px;background:rgba(255,255,255,.88);color:var(--nf-ink)">${m}</div>`).join("")}`, box);   // 目盛りの数字は白い札（水が上がっても読める・#277）
      const W = svg.querySelector(".w");
      const num = el("div", { class: "abs nf-num", style: "left:600px;top:760px;font-size:140px;line-height:1;color:var(--nf-ink);opacity:0" }, `<span>0</span><span style="font-size:64px">${b.unit}</span>${mark(b)}`, box);
      return (u) => { const f = inOutC((u - 0.3) / 1.6) * (b.value / mx), y = 960 - f * H, wv = Math.sin(u * 6) * 10 * (1 - outC((u - 1.9) / 0.8));
        W.setAttribute("d", `M0,${y} Q150,${y - wv} 300,${y} T600,${y} L600,1000 L0,1000 Z`); svg.style.opacity = clamp(sp(u, 12, 1) * 1.4);
        num.firstChild.textContent = u >= 1.9 ? fmt(b.value) : fmt(Math.round(f * mx / 10) * 10); num.style.opacity = clamp(sp(u - 0.2, 12, 1) * 1.3); };
    },
    // ドーナツ：割合を面積で（一瞬で分かる）
    donut(b, box, t0) {
      const parts = b.parts, cols = ["var(--nf-ink)", "var(--nf-acc)", "var(--nf-mut)"];
      const ring = el("div", { class: "abs", style: "left:190px;top:480px;opacity:0" }, `<svg width="700" height="700" viewBox="0 0 700 700"><circle cx="350" cy="350" r="250" fill="none" stroke="rgba(0,0,0,.08)" stroke-width="110"/>
        ${parts.map((p, k) => `<circle class="d" cx="350" cy="350" r="250" fill="none" stroke="${cols[k % 3]}" stroke-width="110" pathLength="100" stroke-dasharray="0 100" transform="rotate(${-90 + 3.6 * parts.slice(0, k).reduce((a, q) => a + q[1], 0)} 350 350)"/>`).join("")}</svg>`, box);
      const D = ring.querySelectorAll(".d");
      const pc = el("div", { class: "abs", style: "left:190px;top:700px;width:700px;text-align:center" }, `<div class="nf-num" style="font-size:140px;line-height:1;color:var(--nf-ink)"><span>0</span><span style="font-size:64px">%</span></div><div style="font:900 46px/1.3 'Noto Sans JP';color:var(--nf-ink)">${parts[0][0]}</div>`, box);
      const lg = el("div", { class: "abs", style: "left:64px;top:1290px;width:952px;font:900 44px/1.7 'Noto Sans JP';color:var(--nf-ink);opacity:0" },
        parts.map((p, k) => `<span style="display:inline-block;white-space:nowrap;margin-right:34px"><span style="display:inline-block;width:34px;height:34px;background:${cols[k % 3]};border-radius:8px;vertical-align:middle;margin-right:14px"></span>${p[0]} ${p[1]}%</span>`).join("") + mark(b), box);
      return (u) => { ring.style.opacity = clamp(sp(u, 12, 1) * 1.4); pc.style.opacity = clamp(sp(u - 0.2, 12, 1) * 1.4);
        D.forEach((d, k) => { const a = inOutC((u - 0.3 - k * 0.6) / (k ? 0.5 : 1.0)); d.setAttribute("stroke-dasharray", `${parts[k][1] * a} 100`); });
        pc.querySelector(".nf-num span").textContent = Math.round(parts[0][1] * inOutC((u - 0.3) / 1.0)); lg.style.opacity = clamp((u - 1.6) / 0.3); };
    },
    // 人型：小さい順に影が並ぶ（自分のサイズがある）
    figures(b, box, t0) {
      const n = b.sizes.length, cw = 952 / n, base = 1180;
      const figs = b.sizes.map((z, k) => { const s = 0.7 + k * (0.45 / Math.max(n - 1, 1)), w = Math.min(108 * s, cw - 10), h = 300 * (w / 108), l = 64 + k * cw + (cw - w) / 2;
        return el("div", { class: "abs", style: `left:${l}px;top:${base - h}px;width:${w}px;height:${h}px;opacity:0;transform-origin:50% 100%` },
          `<svg viewBox="0 0 108 300" width="${w}" height="${h}"><circle cx="54" cy="34" r="28" fill="var(--nf-ink)"/><path d="M14,80 Q54,62 94,80 L104,190 L84,190 L80,120 L76,300 L58,300 L54,200 L50,300 L32,300 L28,120 L24,190 L4,190 Z" fill="var(--nf-ink)"/></svg>
           <div style="position:absolute;left:${-(cw - w) / 2}px;top:${h + 18}px;width:${cw}px;text-align:center;font:700 40px/1 'Noto Sans JP';color:var(--nf-ink)">${z}</div>`, box); });
      el("div", { class: "abs", style: `left:64px;top:${base}px;width:952px;height:4px;background:var(--nf-ink)` }, "", box);
      return (u) => figs.forEach((f, k) => { const a = sp(u - 0.3 - k * 0.14, 13, 0.7); f.style.opacity = clamp(a * 1.4); f.style.transform = `scaleY(${lerp(0.3, 1, clamp(a, 0, 1.15))})`; });
    },
  };

  // カット「num」：商品は出さず（show:0）、数字だけを1画面で見せる
  window.NUM_KIND = function (b, i, s, opt = {}) {
    if (!M[b.motif]) throw new Error(`数字の見せ方が無い: ${b.motif}`);
    const t0 = s.t0, out = OUT(i) - 0.08, box = el("div", { class: "nf" });
    const ttl = el("div", { class: "nf-title", style: "opacity:0" }, b.label || "", box);
    const sub = b.sub ? el("div", { class: "nf-sub", style: `top:${b.motif === "figures" ? 1320 : 1440}px;opacity:0` }, Array.isArray(b.sub) ? b.sub.join("") : b.sub, box) : null;
    const nt = el("div", { class: "nf-note", style: "opacity:0" }, b.note || "", box);
    const upd = M[b.motif](b, box, t0);
    if (opt.cam !== false) K.push({ t: t0 + 0.28, F: F0.body, A: [540, 2600], z: fitZ(600), r: 0, show: 0, ease: "lin" }, { t: s.t1 - 0.28, F: F0.body, A: [540, 2600], z: fitZ(600), r: 0, show: 0, ease: "in" });
    U.push((t) => { const on = t >= t0 - 0.05 && t < s.t1 + 0.05; box.style.visibility = on ? "visible" : "hidden"; if (!on) return;
      const u = t - t0, o = outC((t - out) / 0.3); box.style.opacity = 1 - o;
      ttl.style.opacity = clamp(sp(u - 0.1, 12, 1) * 1.3); ttl.style.transform = `translateY(${(1 - clamp(sp(u - 0.1, 12, 1))) * 40}px)`;
      if (sub) sub.style.opacity = clamp((u - 1.6) / 0.3); nt.style.opacity = clamp((u - 1.2) / 0.3);
      upd(u); });
  };
})();
