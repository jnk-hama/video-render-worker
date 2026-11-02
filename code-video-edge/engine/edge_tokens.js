// UGREEN v2「一本の線」の共有デザイン変数・イージング・受け渡し位置（#333）。
// edge.html と styleguide_edge.html が同じ物を読む＝一度決めて全部で使う（CLAUDE.md「Decide it once」）。
// 時刻は timing.json（window.TIMELINE）からだけ読む。ここに秒数は書かない。
window.EDGE = (() => {
  // 6色まで。実物から採った色（ledger R1：公式店の写真はすべて明るい灰の地で撮られている→地を写真の背景に合わせる）
  const C = {
    ground: "#F5F6F8",   // 公式店の写真（asp1・asp2）の背景そのもの＝写真が継ぎ目なく溶ける
    grid: "#E8EAEF",     // 方眼（地から一段）
    ink: "#1E2027",      // 製図線・主な文字（箱の黒 #272827 をわずかに冷たく）15:1
    graphite: "#5A5F6E", // 補助の文字・注記 5.9:1
    lav: "#AEAFC5",      // 本体のラベンダーグレー（面の塗りだけ・文字には使わない）
    bronze: "#7C5E2E",   // 箱の「MagFlow Air」の金 #B59669 を明るい地で 4.5:1 を超える濃さへ（要の数字だけ）5.6:1
  };
  const FONT = '"Noto Sans JP", sans-serif';
  const LINE_W = 4;                       // THE LINE の太さ（スマホで消えない最小）
  const SAFE = { x0: 64, x1: 900, y0: 170, y1: 1440 };   // 大事な文字の置き場（右の操作列・下の説明文・左上の LIVE 印を避ける）
  // r8（#352）：下端 1520→1440。TikTok の公式は「安全な範囲は説明文の長さで変わる」（ads.tiktok.com）・第三者の解説の下の余白は多くが 440〜484px。うちの投稿文は長い

  // イージング（直線は使わない）。入場はゆっくり識別できる／退場は速く
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const E = {
    outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(x))),          // 入場（素早く寄って、ゆっくり止まる）
    outQuart: (x) => 1 - Math.pow(1 - clamp(x), 4),                           // ペン先が線を引く
    inCubic: (x) => Math.pow(clamp(x), 3),                                    // 退場（速く抜ける）
    inOutCubic: (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },   // カメラ
    // 着地のばね。ω と ζ を固定＝毎回同じ。ζ 0.55（行き過ぎ 12.6%）→ 0.8（1.5%）：弾むイージングは Opus 5.5 の指示文の多くで禁止（#334・test_motionkit.mjs が 2% 以下を確かめる）
    spring: (x, w = 13, z = 0.8) => { if (x <= 0) return 0; const wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x)); },
    // 予備動作（逆へ少し引いてから出る）
    anticip: (x, k = 0.12) => { x = clamp(x); return x < 0.25 ? -k * Math.sin((x / 0.25) * Math.PI / 2) : -k + (1 + k) * (1 - Math.pow(1 - (x - 0.25) / 0.75, 3)); },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  // 静止ショットの呼吸（凍結させない）。周期 2.6 秒・振幅は呼ぶ側で
  const breathe = (t, amp = 4, ph = 0) => Math.sin((t / 2.6) * Math.PI * 2 + ph) * amp;

  // THE LINE の受け渡し位置（storyboard.md 第3版の表と同じ）。切れ目のフレームで前後の場面がこの値を使う
  const H = {
    floor: { x0: 120, x1: 960, y: 1300 },           // S1→S2・S2→S3・S4→S5（床＝コピーの下線＝目盛りの溝）
    L: 840,                                         // 床の線の長さ＝巻き上げても長さ一定（輪の半径 L/2π）
  };
  // 実写真の上の測った位置（写真の画素）。線がこの実物の上に着地する
  const PHOTO = {
    s1: { w: 1550, h: 980, battery: { x0: 480, x1: 1510, y0: 127, y1: 175 } },   // 公式 asp1：本体を真横から（厚みの面）
    s4: { w: 804, h: 600, coil: { cx: 244.0, cy: 389.2, rx: 83.9, ry: 43.4, rot: -6.1 } },   // 公式 asp3：本体上面の磁石の輪（楕円で当てはめ・閾値40）
  };
  return { C, FONT, LINE_W, SAFE, E, clamp, lerp, breathe, H, PHOTO };
})();
