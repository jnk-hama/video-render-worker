// motionkit.js — Opus 5.5 の動画の指示文 683件（awesome-opus5-5-videos・#334）から取った技法を、seek(t) の純関数にした部品。
// どれも「同じ t なら同じ値」（乱数・時計・前のコマの状態を使わない）。型（edge.html など）から読み込んで使う。
// 出典の文は写さず考え方だけ（#225）。各関数の上に、どの型の技法かを書く。
(function (root) {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

  // 臨界減衰のばね s(t) = 1 − (1 + w t) e^(−w t)。目標を絶対に越えない（w は 12〜40：大きいほど速く着く）
  const cd = (t, w = 20) => (t <= 0 ? 0 : 1 - (1 + w * t) * Math.exp(-w * t));

  // 目標が何度も変わる値＝「変わるたびのばね」の和。前のコマの状態を持たないので、どの順で seek しても同じ
  //   changes: [[時刻, 新しい目標], ...]（時刻の順）
  const springSum = (t, x0, changes, w = 20) => {
    let v = x0, prev = x0;
    for (const [ti, g] of changes) { v += (g - prev) * cd(t - ti, w); prev = g; }
    return v;
  };

  // 画面のすべての角を覆う半径（洪水が角に届かず、1コマで画面の半分が変わるのを防ぐ）
  const coverR = (cx, cy, W = 1080, H = 1920) => Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.04;

  // 円を「面積で」緩める：r = R √e(u)。半径で緩めると出だしの数コマが跳ぶ（閉じるアイリスの落とし穴）
  const areaR = (u, R, ease) => R * Math.sqrt(ease(clamp(u)));

  // 鉛筆のふるえ（line boil）：位相は1秒に8回だけ変わる。値は時刻の段と点の番号から作る（乱数を使わない）
  const hash = (a, b) => { const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return h - Math.floor(h); };
  const boil = (t, i, amp) => (hash(Math.floor(t * 8), i) - 0.5) * 2 * amp;

  // 線分を細かく分けて、各点をふるわせた SVG パス（製図の手描き線）。端は留める（寸法線の端が浮かない）
  const boilSeg = (x0, y0, x1, y1, t, amp = 1.2, n = 10, seed = 0) => {
    const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    let d = "";
    for (let k = 0; k <= n; k++) {
      const u = k / n, o = k === 0 || k === n ? 0 : boil(t, seed * 31 + k, amp);
      d += `${k ? "L" : "M"}${(x0 + (x1 - x0) * u + nx * o).toFixed(2)} ${(y0 + (y1 - y0) * u + ny * o).toFixed(2)} `;
    }
    return d;
  };

  // 溜め（山場の前に少し縮んでから弾ける）：hit の pre 秒前から縮み、hit で戻り切る
  const windup = (t, hit, pre = 0.3, depth = 0.03) => {
    if (t < hit - pre || t >= hit) return 0;
    const u = (t - (hit - pre)) / pre; return -depth * Math.sin(Math.PI * u);
  };

  // 「感じる長さ」と「弾み」で決めるばね（Anime.js〔MIT〕の Spring・元は Apple の SwiftUI の決め方・#354）。
  //   dur＝落ち着いて見えるまでの秒・bounce＝0 で行き過ぎ無し（cd と同じ形）、0.3 で約 1 割弾む。負は粘る。
  //   ω0 = 2π/dur、減衰比 ζ = 1 − bounce（bounce < 0 は 1/(1 + bounce)）。閉じた式なので seek の順に依らない
  const springBD = (t, dur = 0.6, bounce = 0) => {
    if (t <= 0) return 0;
    const w = (2 * Math.PI) / dur, z = bounce >= 0 ? 1 - bounce : 1 / (1 + bounce);
    if (z < 1) { const wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t)); }
    if (z === 1) return 1 - (1 + w * t) * Math.exp(-w * t);
    const r = w * Math.sqrt(z * z - 1), a = -z * w + r, b = -z * w - r;   // 粘る側（2つの指数の和・初速 0）
    return 1 - (b * Math.exp(a * t) - a * Math.exp(b * t)) / (b - a);
  };

  // ずらし（Anime.js の stagger・#354）：i 番目の遅れ（秒）。from＝"first"|"center"|"last"|番号、grid＝[列, 行] なら起点からの距離で
  //   ease は遅れの付き方（0〜1 → 0〜1）。乱数は使わない（ばらつきが要る時は hash で）
  const stagger = (i, n, each, { from = "first", grid = null, ease = (u) => u } = {}) => {
    const f = from === "center" ? (n - 1) / 2 : from === "last" ? n - 1 : from === "first" ? 0 : from;
    let d, dmax;
    if (grid) {
      const [c, r] = grid, fx = from === "center" ? (c - 1) / 2 : f % c, fy = from === "center" ? (r - 1) / 2 : Math.floor(f / c);
      const dist = (k) => Math.hypot((k % c) - fx, Math.floor(k / c) - fy);
      d = dist(i); dmax = Math.max(...Array.from({ length: n }, (_, k) => dist(k)));
    } else { d = Math.abs(i - f); dmax = Math.max(f, n - 1 - f); }
    return dmax ? ease(d / dmax) * dmax * each : 0;
  };

  // 先に焼いた物理（factory/physbake.mjs・#354）を時刻 t で読む。tr = { hz, t0, s: [[状態…], …] }
  //   コマの間は直線で補い、4 つ目からの回転（四元数）は向きを揃えて足して正規化する。t0 より前は null（まだ落とされていない）
  const phys = (tr, t) => {
    const u = (t - tr.t0) * tr.hz;
    if (u < 0) return null;
    const i = Math.min(Math.floor(u), tr.s.length - 1), j = Math.min(i + 1, tr.s.length - 1), a = tr.s[i], b = tr.s[j], k = Math.min(u - i, 1);
    if (a.length < 7) return a.map((v, q) => v + (b[q] - v) * k);
    const sg = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] < 0 ? -1 : 1, out = a.map((v, q) => v + ((q >= 3 ? sg : 1) * b[q] - v) * k);
    const L = Math.hypot(out[3], out[4], out[5], out[6]) || 1; for (let q = 3; q < 7; q++) out[q] /= L;
    return out;
  };

  root.MK = { clamp, cd, springSum, coverR, areaR, boil, boilSeg, windup, springBD, stagger, phys };
})(typeof window !== "undefined" ? window : globalThis);
