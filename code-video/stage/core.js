// コード製動画の共通の土台（3つの型が使う）。window.PRODUCT（設計書）と window.TIMELINE（時刻表）だけで絵が決まる。
// 型（editorial / pop / paper）は THEME と KINDS（カットの種類ごとの部品）だけを持ち、CORE.start(THEME, KINDS) を呼ぶ。
const P = window.PRODUCT, TL = window.TIMELINE, B = TL.beats, END = TL.end, DIR = `p/${P.product_key}/`;
const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const outC = (x) => 1 - Math.pow(1 - clamp(x), 3);
const inOutC = (x) => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
function sp(t, w = 12, z = 1) { if (t <= 0) return 0; if (z >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t)); }
let T = 0;
const el = (tag, attrs = {}, html = "", parent = $("ui")) => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); e.innerHTML = html; parent.appendChild(e); return e; };
// 文字を1字ずつ span に（タグはそのまま残す）
function kinWrap(e) { const tmp = document.createElement("div"); tmp.innerHTML = e.innerHTML; const out = [];
  tmp.childNodes.forEach((n) => { if (n.nodeType === 3) [...n.textContent].forEach((ch) => out.push(`<span>${ch}</span>`)); else out.push(n.outerHTML); }); e.innerHTML = out.join(""); return e; }
// 1字ずつ立ち上がる。style=calm（誌面）/ pop（弾む）
function kin(e, tin, tout, stag = 0.035, style = "calm") { const kids = [...e.children], o = outC((T - tout) / 0.25);
  kids.forEach((k, i) => { if (style === "pop") { const a = sp(T - tin - i * stag, 14, 0.55); k.style.opacity = clamp(a * 1.6) * (1 - o); k.style.transform = `translateY(${(1 - clamp(a, -1, 2)) * 70 - o * 40}px) scale(${lerp(0.6, 1, a)})`; }
    else { const a = sp(T - tin - i * stag, 11, 0.85); k.style.opacity = clamp(a * 1.3) * (1 - o); k.style.transform = `translateY(${(1 - clamp(a)) * 60 - o * 30}px)`; } });
  e.style.visibility = T < tin - 0.01 || o >= 0.999 ? "hidden" : "visible"; }
function fadeUp(e, tin, tout, dy = 22, w = 11, z = 1) { const a = sp(T - tin, w, z), o = outC((T - tout) / 0.25); e.style.opacity = clamp(a * 1.2) * (1 - o); e.style.transform = `translateY(${(1 - a) * dy}px)`; }
function sweepAt(e, t0, dur, peak) { const p = clamp((T - t0) / dur); e.style.opacity = (p <= 0 || p >= 1) ? 0 : Math.sin(p * Math.PI) * peak; e.style.backgroundPosition = `${lerp(100, 0, inOutC(p))}% 0`; }
const OUT = (i) => (i + 1 < B.length ? B[i + 1].t0 : 999) - 0.22;
function setText(e, s) { if (e.textContent !== s) e.textContent = s; }

// ---- 本体（世界の単位＝切り抜きの画素/4） ----
const HERO = { w: 0, h: 0 }, F0 = P.hero.focus;
function buildHero(wid, hei) {
  HERO.w = wid; HERO.h = hei; const W = $("world");
  const altW = P.hero.alt_size ? P.hero.alt_size[0] : wid, altH = P.hero.alt_size ? P.hero.alt_size[1] : hei, ax = P.hero.alt_at ? P.hero.alt_at[0] : wid * 0.5, ay = P.hero.alt_at ? P.hero.alt_at[1] : -hei * 0.1;
  W.innerHTML = `${P.hero.alt ? `<div id="altG" class="m" style="left:${ax}px;top:${ay}px;width:${altW}px;height:${altH}px;transform-origin:0 0;opacity:0">
      <div class="shadow" style="left:${altW * .08}px;top:${altH * .93}px;width:${altW * .85}px;height:${altH * .12}px"></div>
      ${THEME.refl ? `<img class="refl" src="${DIR}${P.hero.alt}" style="left:0;top:${altH}px;width:${altW}px;height:${altH}px">` : ""}<img src="${DIR}${P.hero.alt}" style="left:0;top:0;width:${altW}px;height:${altH}px">
      <div class="sweep" id="swAlt" style="-webkit-mask:url(${DIR}${P.hero.alt}) center/100% 100% no-repeat; mask:url(${DIR}${P.hero.alt}) center/100% 100% no-repeat"></div></div>` : ""}
    <div id="heroG" class="m" style="left:0;top:0;width:${wid}px;height:${hei}px">
      <div class="shadow" id="sh" style="left:${wid * .06}px;top:${hei * .925}px;width:${wid * .9}px;height:${hei * .14}px"></div>
      ${THEME.refl ? `<img class="refl" id="refl" src="${DIR}${P.hero.cutout}" style="left:0;top:${hei}px;width:${wid}px;height:${hei}px">` : ""}
      <img src="${DIR}${P.hero.cutout}" style="left:0;top:0;width:${wid}px;height:${hei}px">
      <div class="sweep" id="sw" style="-webkit-mask:url(${DIR}${P.hero.cutout}) center/100% 100% no-repeat; mask:url(${DIR}${P.hero.cutout}) center/100% 100% no-repeat"></div></div>`;
}
const fitZ = (px) => px / HERO.w;
const toScreen = (cam, Pt) => { const x = (Pt[0] - cam.F[0]) * cam.z, y = (Pt[1] - cam.F[1]) * cam.z, r = (cam.r || 0) * Math.PI / 180;
  return [cam.A[0] + x * Math.cos(r) - y * Math.sin(r), cam.A[1] + x * Math.sin(r) + y * Math.cos(r)]; };

const K = [], U = [], BRF = [], MARKS = [];   // カメラのキー・毎コマの関数・実写の駒・めくりの時刻
// キーの間は ease（時刻差が小さいキーは即座に切り替え＝ハードカット）
function camAt(t) {
  let i = 0; while (i < K.length - 2 && t >= K[i + 1].t) i++;
  const a = K[i], b = K[i + 1], d = b.t - a.t, x = d < 0.05 ? 1 : (t - a.t) / d, u = d < 0.05 ? 1 : (a.ease === "in" ? inOutC(x) : a.ease === "lin" ? clamp(x) : inOutC(x) * 0.5 + clamp(x) * 0.5);
  // mv（カメラの振り方）：pan=先に向きを変えてから寄る／pull=引きを少し先に／roll=移動中だけ傾ける
  const m = a.mv, fk = m && m.kind === "pan" ? inOutC(x / 0.8) : u, zk = !m ? u : m.kind === "pan" ? inOutC((x - 0.25) / 0.75) : m.kind === "pull" ? inOutC(x * 1.1) : u;
  return { F: [lerp(a.F[0], b.F[0], fk), lerp(a.F[1], b.F[1], fk)], A: [lerp(a.A[0], b.A[0], fk), lerp(a.A[1], b.A[1], fk)], z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), zk)),
    r: lerp(a.r || 0, b.r || 0, u) + (m && m.roll ? m.roll * Math.sin(Math.PI * clamp(x)) : 0), show: a.show === undefined ? 1 : a.show };
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let THEME = {};
const CORE = {
  start(theme, kinds) {
    THEME = theme;
    const gctx = $("grain").getContext("2d"), gimg = gctx.createImageData(540, 960);
    const grain = (seed) => { const r = mulberry32(seed * 7919 + 17), d = gimg.data, [b0, rg] = THEME.grain || [215, 40]; for (let i = 0; i < d.length; i += 4) { const v = b0 + Math.floor(r() * rg); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } gctx.putImageData(gimg, 0, 0); };
    window.seek = function (t) {
      T = t; grain(Math.floor(t * 12));
      let cam = camAt(t); const W = $("world"); if (THEME.cam) cam = THEME.cam(t, cam);
      W.style.display = cam.show ? "block" : "none";
      W.style.transform = `translate(${cam.A[0]}px, ${cam.A[1]}px) rotate(${cam.r}deg) scale(${cam.z}) translate(${-cam.F[0]}px, ${-cam.F[1]}px)`;
      if (THEME.motionBlur) { const c0 = camAt(Math.max(0, t - 1 / 120)), a = toScreen(cam, F0.body), b = toScreen(c0, F0.body);
        const v = Math.hypot(a[0] - b[0], a[1] - b[1]) * 120 + Math.abs(Math.log(cam.z / c0.z)) * 120 * 900, mb = clamp(v / 800, 0, 6); W.style.filter = mb > 0.3 ? `blur(${mb / cam.z}px)` : "none"; }
      if ($("table")) { const base = toScreen(cam, [F0.body[0], F0.base_y]); $("table").style.top = (cam.show ? base[1] - 30 : 1500) + "px"; }
      if ($("refl")) { $("refl").style.opacity = cam.r ? 0 : 0.16; $("sh").style.opacity = cam.r ? 0 : 1; }
      if (THEME.wipe && $("wipe")) { let w = 2; const marks = B.slice(1).map((b) => b.t0).concat(MARKS);
        marks.forEach((m, k) => { const u = (t - (m - 0.24)) / 0.48; if (u > 0 && u < 1) w = k % 2 ? inOutC(u) * 2 - 1 : 1 - inOutC(u) * 2; });
        $("wipe").style.display = Math.abs(w) >= 1.5 ? "none" : "block"; $("wipe").style.transform = `translateX(${w * 1300}px) skewX(-12deg)`; }
      if (THEME.onSeek) THEME.onSeek(t, cam);
      U.forEach((f) => f(t, cam));
    };
    window.READY = (async () => {
      const im = new Image(); im.src = `${DIR}${P.hero.cutout}`; await im.decode();
      buildHero(im.naturalWidth / 4, im.naturalHeight / 4);
      P.beats.forEach((b, i) => { if (!kinds[b.kind]) throw new Error(`この型（${P.template}）に無いカット: ${b.kind}`); kinds[b.kind](b, i, B[i]); });
      K.sort((a, b) => a.t - b.t);
      await Promise.all([...document.images].map((i) => i.decode().catch(() => 0))); await Promise.all(BRF.map((i) => i.decode().catch(() => 0)));
      await document.fonts.ready; window.seek(0);
    })();
  },
};
// 実写の駒を読み込む（時刻で選んで canvas に描く・事前に全部デコード）
function loadBroll(dir, n) { const fr = []; for (let k = 1; k <= n; k++) { const im = new Image(); im.src = `${DIR}${dir}/f_${String(k).padStart(3, "0")}.jpg`; fr.push(im); BRF.push(im); } return fr; }
