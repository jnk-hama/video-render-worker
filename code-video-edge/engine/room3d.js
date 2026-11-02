// room3d.js — コードで作るリアルなリビング（three.js）。時刻は外から渡す（ROOM.render(t, p)）＝タイマー・乱数なし（乱数は種つき）。
//   作り方は awesome-opus5-5-videos の指示文から（#334）：物理ベースの材質＋ACES の色・窓の面光源・柔らかい影・光の筋と埃・
//   にじみ（bloom）・周辺減光と粒子。「AI の予告編」に見える派手な粒子は使わない（threeaus ほか）。商品そのものは 3D にしない（#068）。
//   描画は CPU（SwiftShader）なので重い：同じコマ（1/60秒）はもう一度描かない。
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// 種つきの乱数（mulberry32）：毎回同じ部屋になる
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const cv = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); return c; };
const tex = (c, rep = [1, 1], srgb = true) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...rep); t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };

// 部屋の寸法（m）：21畳 ≒ 7.2 × 4.8。奥の壁 z=−4.8、左の壁 x=−3.6、天井 2.5
const RW = 7.2, RD = 4.8, RH = 2.5, X0 = -3.6, ZB = -4.8;
const WIN = { x0: -2.9, x1: -0.5, y0: 0.35, y1: 2.3 };   // 奥の壁の掃き出し窓

export function createRoom(canvas, W = 1080, H = 1920) {
  const R = rng(21);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  RectAreaLightUniformsLib.init();
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;

  // ---------- 材質（手続きで描いたテクスチャ） ----------
  // 床：明るいオーク（白っぽく・茶色に寄せない）。板 0.18m・継ぎ目・木目
  const floorC = cv(2048, 2048, (g, w, h) => {
    const pw = h / 22;   // 1枚＝4m/22 ≒ 0.18m
    for (let r = 0; r < 22; r++) {
      let x = -R() * 600;
      while (x < w) {
        const L = 500 + R() * 700, l = 76 + R() * 7, hue = 33 + R() * 5;
        g.fillStyle = `hsl(${hue} 46% ${l}%)`; g.fillRect(x, r * pw, L, pw);
        for (let k = 0; k < 26; k++) {   // 木目：ゆるく波打つ細い線
          const y = r * pw + R() * pw, a = 0.04 + R() * 0.07;
          g.strokeStyle = `hsla(30 40% 45% / ${a})`; g.lineWidth = 0.6 + R() * 1.4; g.beginPath(); g.moveTo(x, y);
          for (let s = 0; s <= L; s += 40) g.lineTo(x + s, y + Math.sin(s / (90 + R() * 60) + k) * 2.2);
          g.stroke();
        }
        g.fillStyle = "rgba(90,70,50,0.35)"; g.fillRect(x, r * pw, 2, pw);   // 板の端
        x += L;
      }
      g.fillStyle = "rgba(90,70,50,0.28)"; g.fillRect(0, r * pw, w, 1.5);
    }
  });
  const floorMat = new THREE.MeshStandardMaterial({ map: tex(floorC, [RW / 4, RD / 4]), roughness: 0.5, metalness: 0, envMapIntensity: 0.8 });
  // 壁：白い漆喰（ごく弱いむら）
  const wallC = cv(512, 512, (g, w, h) => { g.fillStyle = "#F7F1E8"; g.fillRect(0, 0, w, h); for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(${R() < 0.5 ? "255,255,255" : "200,190,180"},${0.05 + R() * 0.06})`; g.fillRect(R() * w, R() * h, 2 + R() * 3, 2 + R() * 3); } });
  const wallMat = new THREE.MeshStandardMaterial({ map: tex(wallC, [4, 2]), roughness: 0.95 });
  // 布：細かい織り目（凹凸）
  const weave = tex(cv(256, 256, (g, w, h) => { for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const v = 120 + ((x + y) % 4 ? 30 : -20) + R() * 60; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 2, 2); } }), [6, 6], false);
  const fabric = (hex, rough = 0.92) => new THREE.MeshStandardMaterial({ color: hex, roughness: rough, bumpMap: weave, bumpScale: 0.6, envMapIntensity: 0.6 });
  const sofaMat = fabric("#ECE6DC"), cushionA = fabric("#F2A07B"), cushionB = fabric("#F6D58E"), throwMat = fabric("#DCE6E0");
  const rugMat = new THREE.MeshStandardMaterial({ map: tex(cv(1024, 1024, (g, w, h) => {
    g.fillStyle = "#F4F0E8"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 30000; i++) { const v = R(); g.fillStyle = `rgba(${v < 0.5 ? "255,255,255" : "205,195,180"},0.18)`; g.fillRect(R() * w, R() * h, 3, 3); }
    g.strokeStyle = "rgba(232,150,110,0.55)"; g.lineWidth = 10; g.strokeRect(60, 60, w - 120, h - 120); g.lineWidth = 4; g.strokeRect(95, 95, w - 190, h - 190);
  })), roughness: 1, bumpMap: weave, bumpScale: 1 });
  const ash = new THREE.MeshStandardMaterial({ map: tex(floorC, [0.5, 0.5]), roughness: 0.45 });
  const white = new THREE.MeshStandardMaterial({ color: "#F7F5F2", roughness: 0.35 });
  const brass = new THREE.MeshStandardMaterial({ color: "#D8B470", roughness: 0.3, metalness: 1 });
  const black = new THREE.MeshStandardMaterial({ color: "#1A1C20", roughness: 0.25, metalness: 0.2 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#4F7F45", roughness: 0.55, side: THREE.DoubleSide }), stemMat = new THREE.MeshStandardMaterial({ color: "#5E7A3E", roughness: 0.7 });

  const add = (geo, mat, x, y, z, { cast = true, recv = true, ry = 0 } = {}) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = cast; m.receiveShadow = recv; scene.add(m); return m; };
  const box = (w, h, d, r = 0.02) => (r ? new RoundedBoxGeometry(w, h, d, 4, r) : new THREE.BoxGeometry(w, h, d));

  // ---------- 部屋 ----------
  const fl = add(new THREE.PlaneGeometry(RW, RD), floorMat, 0, 0, ZB + RD / 2, { cast: false }); fl.rotation.x = -Math.PI / 2;
  const ceil = add(new THREE.PlaneGeometry(RW, RD), wallMat, 0, RH, ZB + RD / 2, { cast: false }); ceil.rotation.x = Math.PI / 2;
  // 奥の壁（窓の穴を残して4枚）
  const wb = (x0, x1, y0, y1) => add(new THREE.BoxGeometry(x1 - x0, y1 - y0, 0.12), wallMat, (x0 + x1) / 2, (y0 + y1) / 2, ZB - 0.06);
  wb(X0, WIN.x0, 0, RH); wb(WIN.x1, -X0, 0, RH); wb(WIN.x0, WIN.x1, 0, WIN.y0); wb(WIN.x0, WIN.x1, WIN.y1, RH);
  const lw = add(new THREE.PlaneGeometry(RD, RH), wallMat, X0, RH / 2, ZB + RD / 2, { cast: false }); lw.rotation.y = Math.PI / 2;
  const rw = add(new THREE.PlaneGeometry(RD, RH), wallMat, -X0, RH / 2, ZB + RD / 2, { cast: false }); rw.rotation.y = -Math.PI / 2;
  add(new THREE.BoxGeometry(RW, 0.06, 0.015), white, 0, 0.03, ZB + 0.008);   // 幅木
  const sk = add(new THREE.BoxGeometry(RD, 0.06, 0.015), white, X0 + 0.008, 0.03, ZB + RD / 2); sk.rotation.y = Math.PI / 2;
  // 窓枠と桟（白いアルミ）
  const fr = 0.05, wcx = (WIN.x0 + WIN.x1) / 2, wcy = (WIN.y0 + WIN.y1) / 2;
  for (const [w, h, x, y] of [[WIN.x1 - WIN.x0, fr, wcx, WIN.y0], [WIN.x1 - WIN.x0, fr, wcx, WIN.y1], [fr, WIN.y1 - WIN.y0, WIN.x0, wcy], [fr, WIN.y1 - WIN.y0, WIN.x1, wcy], [fr * 0.7, WIN.y1 - WIN.y0, wcx, wcy]])
    add(new THREE.BoxGeometry(w, h, 0.08), white, x, y, ZB - 0.02);
  // 窓の外：空と木々（ぼかした絵・自ら光る）。昼と夜で絵を替える
  const outDay = tex(cv(512, 512, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#DDEBF5"); sky.addColorStop(0.55, "#F6F1E4"); sky.addColorStop(1, "#E9EED8"); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.filter = "blur(18px)"; for (let i = 0; i < 40; i++) { g.fillStyle = `hsla(${95 + R() * 30} 35% ${55 + R() * 20}% / 0.55)`; g.beginPath(); g.arc(R() * w, h * (0.45 + R() * 0.6), 30 + R() * 70, 0, 7); g.fill(); }
  }), [1, 1]);
  const outNight = tex(cv(512, 512, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#0E1730"); sky.addColorStop(1, "#1C2747"); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.filter = "blur(10px)"; g.fillStyle = "rgba(255,236,200,0.9)"; g.beginPath(); g.arc(w * 0.7, h * 0.22, 16, 0, 7); g.fill();
    g.filter = "blur(16px)"; for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(10,16,28,0.8)`; g.beginPath(); g.arc(R() * w, h * (0.7 + R() * 0.4), 40 + R() * 60, 0, 7); g.fill(); }
  }), [1, 1]);
  const outMat = new THREE.MeshBasicMaterial({ map: outDay, toneMapped: true });
  add(new THREE.PlaneGeometry(4.5, 3.4), outMat, wcx, 1.4, ZB - 1.2, { cast: false, recv: false });
  // 薄いカーテン（ひだ・逆光で明るい）
  const curG = new THREE.PlaneGeometry(0.9, 2.15, 60, 1); { const p = curG.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, 0.05 * Math.sin(p.getX(i) * 28) + 0.02 * Math.sin(p.getX(i) * 71)); curG.computeVertexNormals(); }
  const curMat = new THREE.MeshStandardMaterial({ color: "#FFFFFF", roughness: 0.9, transparent: true, opacity: 0.72, side: THREE.DoubleSide, emissive: "#FFF4E2", emissiveIntensity: 0.35 });
  add(curG, curMat, WIN.x0 + 0.25, 1.2, ZB + 0.12, { cast: false });
  add(curG, curMat, WIN.x1 - 0.15, 1.2, ZB + 0.12, { cast: false });

  // ---------- 家具 ----------
  // ソファ（左の壁沿い・右を向く）：台・座面2つ・背もたれ2つ・肘掛け2つ
  const SX = X0 + 0.55, SZ = -2.7;
  add(box(0.95, 0.22, 2.3, 0.04), sofaMat, SX, 0.2, SZ);
  for (const dz of [-0.53, 0.53]) { add(box(0.72, 0.16, 1.02, 0.06), sofaMat, SX + 0.08, 0.39, SZ + dz); add(box(0.24, 0.5, 1.02, 0.09), sofaMat, SX - 0.33, 0.68, SZ + dz); }
  for (const dz of [-1.08, 1.08]) add(box(0.95, 0.42, 0.18, 0.07), sofaMat, SX, 0.42, SZ + dz);
  for (const [x, y, z, ry, m] of [[SX - 0.13, 0.62, SZ - 0.62, 0.25, cushionA], [SX - 0.13, 0.62, SZ + 0.55, -0.2, cushionB], [SX - 0.1, 0.6, SZ + 0.05, 0.05, throwMat]])
    { const c = add(box(0.15, 0.4, 0.4, 0.07), m, x, y - 0.02, z, { ry }); c.rotation.z = -0.3; }
  for (const dz of [-1, 1]) for (const dx of [-0.38, 0.38]) add(new THREE.CylinderGeometry(0.02, 0.015, 0.09), brass, SX + dx, 0.045, SZ + dz * 1.05);
  // ラグとローテーブル（白い天板・明るい木の脚）
  const rug = add(new THREE.PlaneGeometry(2.0, 2.6), rugMat, -1.75, 0.006, SZ, { cast: false }); rug.rotation.x = -Math.PI / 2;
  add(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 64), white, -1.65, 0.4, SZ);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.6; add(new THREE.CylinderGeometry(0.022, 0.018, 0.38), ash, -1.65 + 0.3 * Math.cos(a), 0.19, SZ + 0.3 * Math.sin(a)); }
  add(new THREE.CylinderGeometry(0.05, 0.04, 0.09, 32), white, -1.55, 0.465, SZ - 0.12);   // カップ
  add(box(0.22, 0.04, 0.3, 0.005), cushionA, -1.78, 0.44, SZ + 0.12);                     // 本
  // 観葉植物（白い鉢・大きな葉）：窓の右
  const PX = -0.05, PZ = ZB + 0.45;
  add(new THREE.CylinderGeometry(0.2, 0.15, 0.42, 48), white, PX, 0.21, PZ);
  const leafShape = new THREE.Shape(); leafShape.moveTo(0, 0); leafShape.bezierCurveTo(0.12, 0.06, 0.13, 0.28, 0, 0.36); leafShape.bezierCurveTo(-0.13, 0.28, -0.12, 0.06, 0, 0);
  const leafG = new THREE.ShapeGeometry(leafShape, 12);
  for (let i = 0; i < 40; i++) {
    const h = 0.45 + R() * 0.95, a = R() * Math.PI * 2, rr = 0.05 + R() * 0.32;
    const base = new THREE.Vector3(PX + 0.03 * Math.cos(a), 0.4, PZ + 0.03 * Math.sin(a)), tip = new THREE.Vector3(PX + rr * Math.cos(a), 0.4 + h, PZ + rr * Math.sin(a));
    const len = base.distanceTo(tip), stem = add(new THREE.CylinderGeometry(0.004, 0.006, len), stemMat, (base.x + tip.x) / 2, (base.y + tip.y) / 2, (base.z + tip.z) / 2, { cast: false });   // 茎は鉢から葉へ細く傾ける
    stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(base).normalize());
    const l = add(leafG, leafMat, tip.x, tip.y, tip.z); l.rotation.set(-0.6 - R() * 0.7, a, (R() - 0.5) * 0.6); l.scale.setScalar(0.8 + R() * 0.6);
  }
  // フロアランプ（真鍮・白い笠）：ソファの奥
  const LX = X0 + 0.45, LZ = SZ - 1.45;
  add(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 48), brass, LX, 0.01, LZ);
  add(new THREE.CylinderGeometry(0.012, 0.012, 1.45), brass, LX, 0.74, LZ);
  const shadeMat = new THREE.MeshStandardMaterial({ color: "#FFFFFF", roughness: 0.9, side: THREE.DoubleSide, emissive: "#FFD7A0", emissiveIntensity: 0 });
  add(new THREE.CylinderGeometry(0.16, 0.24, 0.3, 48, 1, true), shadeMat, LX, 1.55, LZ, { cast: false });
  // 右手前のサイドボード（白・明るい木の脚）と上の花瓶・本・小さな額＝手前に物があると奥行きが出る
  const BX = 1.35, BZ = -1.5;
  add(box(0.42, 0.5, 1.5, 0.015), white, BX + 0.25, 0.37, BZ);
  for (const dz of [-0.65, 0.65]) for (const dx of [0.08, 0.42]) add(new THREE.CylinderGeometry(0.015, 0.012, 0.12), ash, BX + dx, 0.06, BZ + dz);
  add(new THREE.CylinderGeometry(0.06, 0.08, 0.26, 32), new THREE.MeshPhysicalMaterial({ color: "#E9EEF0", roughness: 0.1, transmission: 0.6, thickness: 0.2 }), BX + 0.25, 0.75, BZ - 0.4);
  for (let i = 0; i < 5; i++) { const st = add(new THREE.CylinderGeometry(0.003, 0.003, 0.35), stemMat, BX + 0.25 + (i - 2) * 0.012, 0.95, BZ - 0.4, { cast: false }); st.rotation.z = (i - 2) * 0.12;
    add(new THREE.SphereGeometry(0.035, 16, 12), cushionB, BX + 0.25 + (i - 2) * 0.034, 1.12 - Math.abs(i - 2) * 0.02, BZ - 0.4); }
  for (let i = 0; i < 3; i++) add(box(0.26, 0.035, 0.2, 0.004), [cushionA, white, throwMat][i], BX + 0.22, 0.64 + i * 0.036, BZ + 0.25);
  // 壁の絵（左の壁・ソファの上）
  const art = add(box(0.03, 0.62, 0.9, 0.005), white, X0 + 0.02, 1.45, SZ, { cast: false });
  const artIn = new THREE.MeshStandardMaterial({ map: tex(cv(256, 384, (g, w, h) => { g.fillStyle = "#F4EFE6"; g.fillRect(0, 0, w, h); g.fillStyle = "#F2A07B"; g.beginPath(); g.arc(w * 0.42, h * 0.45, 70, 0, 7); g.fill(); g.fillStyle = "#9DB8A8"; g.fillRect(w * 0.2, h * 0.62, w * 0.6, h * 0.16); })), roughness: 0.8 });
  const ai = add(new THREE.PlaneGeometry(0.76, 0.5), artIn, X0 + 0.04, 1.45, SZ, { cast: false }); ai.rotation.y = Math.PI / 2;
  // 床に落ちる接地の影（家具の下の柔らかい暗がり＝ AO の代わり）
  const blobT = tex(cv(128, 128, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); r.addColorStop(0, "rgba(0,0,0,0.55)"); r.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = r; g.fillRect(0, 0, w, h); }), [1, 1], false);
  const blob = (x, z, w, d, o = 0.6) => { const m = add(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: blobT, transparent: true, opacity: o, depthWrite: false }), x, 0.012, z, { cast: false, recv: false }); m.rotation.x = -Math.PI / 2; };
  blob(SX, SZ, 1.4, 2.8, 0.7); blob(-1.65, SZ, 1.0, 1.0, 0.35); blob(PX, PZ, 0.7, 0.7, 0.6);
  // 壁と床の角の暗がり（ごく弱く）
  const cornerT = tex(cv(4, 128, (g, w, h) => { const r = g.createLinearGradient(0, 0, 0, h); r.addColorStop(0, "rgba(0,0,0,0.22)"); r.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = r; g.fillRect(0, 0, w, h); }), [1, 1], false);
  const corner = (x, z, len, ry) => { const m = add(new THREE.PlaneGeometry(len, 0.5), new THREE.MeshBasicMaterial({ map: cornerT, transparent: true, depthWrite: false }), x, 0.013, z, { cast: false, recv: false }); m.rotation.set(-Math.PI / 2, 0, ry); };
  corner(0, ZB + 0.25, RW, 0); corner(X0 + 0.25, ZB + RD / 2, RD, -Math.PI / 2);

  // ---------- 光 ----------
  const sun = new THREE.DirectionalLight("#FFD39C", 4.2); sun.position.set(-4.2, 3.0, -10.5); sun.target.position.set(-1.0, 0, -2.2); scene.add(sun.target);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 6; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 25 }); scene.add(sun);
  const sky = new THREE.RectAreaLight("#EAF2FF", 4, WIN.x1 - WIN.x0, WIN.y1 - WIN.y0); sky.position.set(wcx, wcy, ZB + 0.02); sky.lookAt(wcx, wcy, 0); scene.add(sky);
  const fill = new THREE.HemisphereLight("#FFF6EA", "#F0D9B8", 0.35); scene.add(fill);
  // 日だまりの照り返し（床から上へ向けた面光源）＝光が部屋に回る感じの代わり（GI を計算しない）
  const bounce = new THREE.RectAreaLight("#FFD8A8", 1.4, 1.8, 2.4); bounce.position.set(-1.2, 0.05, -2.6); bounce.lookAt(-1.2, 3, -2.6); scene.add(bounce);
  const lamp = new THREE.PointLight("#FFC27A", 0, 8, 2); lamp.position.set(LX, 1.5, LZ); lamp.castShadow = true; lamp.shadow.mapSize.set(1024, 1024); lamp.shadow.radius = 8; lamp.shadow.bias = -0.002; scene.add(lamp);
  const moon = new THREE.DirectionalLight("#9DB4E8", 0); moon.position.set(-2.5, 5, -10); moon.target.position.set(-1.6, 0, -2.5); scene.add(moon.target); scene.add(moon);

  // 光の筋：窓の形を太陽の向きに床まで押し出した柱（加算・奥ほど薄い）＝作り物の体積光
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0.04 }, uT: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: "attribute float k; varying float vk; varying vec3 vp; void main(){ vk=k; vp=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }",
    fragmentShader: "uniform float uO,uT; varying float vk; varying vec3 vp; void main(){ float s=0.75+0.25*sin(vp.x*7.+vp.y*3.+uT*0.4)*sin(vp.z*5.-uT*0.3); gl_FragColor=vec4(vec3(1.,.9,.75)*uO*(1.-vk)*s,1.); }",
  });
  {
    const dir = new THREE.Vector3().subVectors(sun.target.position, sun.position).normalize();
    const top = [[WIN.x0, WIN.y1], [WIN.x1, WIN.y1], [WIN.x1, WIN.y0], [WIN.x0, WIN.y0]].map(([x, y]) => new THREE.Vector3(x, y, ZB));
    const bot = top.map((p) => p.clone().addScaledVector(dir, (p.y - 0.01) / -dir.y));
    const pos = [], ks = [], idx = [];
    [...top, ...bot].forEach((p, i) => { pos.push(p.x, p.y, p.z); ks.push(i < 4 ? 0 : 0.85); });
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]]) idx.push(a, b, b + 4, a, b + 4, a + 4);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("k", new THREE.Float32BufferAttribute(ks, 1)); g.setIndex(idx);
    var beam = new THREE.Mesh(g, beamMat); scene.add(beam);
  }
  // 光の中の埃（ごく少なく・小さく）
  const dustN = 160, dustP = new Float32Array(dustN * 3), dustSeed = [];
  for (let i = 0; i < dustN; i++) dustSeed.push([R(), R(), R(), R()]);
  const dustG = new THREE.BufferGeometry(); dustG.setAttribute("position", new THREE.BufferAttribute(dustP, 3));
  const dot = tex(cv(32, 32, (g, w, h) => { const r = g.createRadialGradient(16, 16, 0, 16, 16, 16); r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = r; g.fillRect(0, 0, w, h); }), [1, 1], false);
  const dustM = new THREE.PointsMaterial({ size: 0.012, map: dot, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, color: "#FFF1D6" });
  scene.add(new THREE.Points(dustG, dustM));
  // 湿り（S2）：加湿器（画面の左手前の外）から部屋へ流れる柔らかいもや。板（スプライト）を時刻だけで動かす
  const puffT = tex(cv(128, 128, (g, w, h) => { const P = rng(7); for (let i = 0; i < 26; i++) { const x = 64 + (P() - 0.5) * 50, y = 64 + (P() - 0.5) * 50, r = 18 + P() * 30, gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, "rgba(255,255,255,0.16)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, w, h); } }), [1, 1], false);
  const puffs = [], mistCol = new THREE.Color(1.7, 1.7, 1.7);   // 光を受けた白い湯気（そのままだと灰色に沈む）
  for (let i = 0; i < 70; i++) { const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffT, transparent: true, depthWrite: false, opacity: 0, color: mistCol })); m.userData = [R(), R(), R(), R()]; scene.add(m); puffs.push(m); }

  // 湿りの粒：加湿器から部屋じゅうへ扇状に流れる細かな粒（光を受けて小さく光る）。もやより「湿り」が伝わる
  const dropN = 900, dropP = new Float32Array(dropN * 3), dropS = [];
  for (let i = 0; i < dropN; i++) dropS.push([R(), R(), R(), R()]);
  const dropG = new THREE.BufferGeometry(); dropG.setAttribute("position", new THREE.BufferAttribute(dropP, 3));
  const dropM = new THREE.PointsMaterial({ size: 0.013, map: dot, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(1.4, 1.45, 1.5) });
  scene.add(new THREE.Points(dropG, dropM));

  // ---------- 仕上げ：にじみ・周辺減光・粒子（種つき） ----------
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  const camera = new THREE.PerspectiveCamera(58, W / H, 0.05, 50);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W / 2, H / 2), 0.35, 0.55, 0.9); composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uSeed: { value: 0 }, uVig: { value: 0.32 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }",
    fragmentShader: "uniform sampler2D tDiffuse; uniform float uSeed,uVig; varying vec2 vUv; float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233))+uSeed)*43758.5453); }"
      + "void main(){ vec4 c=texture2D(tDiffuse,vUv); vec2 d=vUv-.5; d.x*=.75; c.rgb*=1.-uVig*dot(d,d)*2.2; c.rgb+=(h(vUv*1000.)-.5)*0.018; gl_FragColor=c; }",
  });
  composer.addPass(grade);

  let last = null;
  // p：{ cam:[x,y,z], look:[x,y,z], fov, night 0..1, mist 0..1（湿りが広がる量）, mistT（湿りの時刻）, exposure }
  function render(t, p) {
    const key = t + JSON.stringify(p);   // 呼ぶ側はコマ（1/60秒）に丸めた時刻 t で p を作る＝8枚のサブフレームで描き直さない
    if (key === last) return; last = key;
    const n = p.night || 0;
    camera.position.set(...p.cam); camera.lookAt(...p.look); camera.fov = p.fov || 58; camera.updateProjectionMatrix();
    renderer.toneMappingExposure = p.exposure ?? 1;
    sun.intensity = 4.2 * (1 - n); sky.intensity = 1.5 * (1 - n) + 0.6 * n;
    bloom.threshold = n > 0.5 ? 0.9 : 1.6;   // 昼は白い壁がにじまないように高く（夜はランプの笠だけがにじむ） sky.color.set(n > 0.5 ? "#6F86C8" : "#EAF2FF");
    fill.intensity = 0.1 * (1 - n) + 0.05 * n; scene.environmentIntensity = 0.22 * (1 - n) + 0.08 * n;
    bounce.intensity = 1.4 * (1 - n); lamp.intensity = 2.6 * n; moon.intensity = 0.5 * n; shadeMat.emissiveIntensity = 0.55 * n; bloom.strength = 0.25 + 0.05 * n;
    curMat.emissiveIntensity = 0.35 * (1 - n); curMat.opacity = 0.72 - 0.15 * n;
    outMat.map = n > 0.5 ? outNight : outDay; outMat.color.setScalar(n > 0.5 ? 0.9 : 1.15);
    beamMat.uniforms.uO.value = 0.04 * (1 - n); beamMat.uniforms.uT.value = t;
    for (let i = 0; i < dustN; i++) {   // 埃：光の筋の中をゆっくり漂う
      const [a, b, c, d] = dustSeed[i];
      dustP[i * 3] = WIN.x0 + (WIN.x1 - WIN.x0) * a + 0.05 * Math.sin(t * 0.3 + d * 9);
      dustP[i * 3 + 1] = 0.2 + 2.0 * ((b + t * 0.012 * (0.5 + c)) % 1);
      dustP[i * 3 + 2] = ZB + 0.3 + 2.6 * c + 0.05 * Math.cos(t * 0.25 + a * 9);
    }
    dustG.attributes.position.needsUpdate = true; dustM.opacity = 0.8 * (1 - n);
    // 湿り：左の壁ぎわ（x −3.3, z −0.9）から部屋の奥と右へ扇状に流れ、広がりながら薄くなる
    const mt = p.mistT ?? 0, mo = p.mist || 0;
    puffs.forEach((s, i) => {
      const [a, b, c, d] = s.userData, life = 3.2, u = ((mt * (0.8 + 0.4 * c)) / life + a) % 1, ang = -0.2 + 1.5 * b;   // 扇の向き（奥〜右）
      const dist = 0.3 + 5.5 * u, x = -3.3 + Math.cos(ang) * dist * 0.75, z = -0.9 - Math.sin(ang) * dist * 0.7;
      s.position.set(x, dist / 5.8 > (p.reach ?? 1) ? -10 : 0.55 + 0.9 * u + 0.25 * d, z); s.scale.setScalar(0.35 + 1.5 * u);
      s.material.opacity = 0;   // もやは「霧」に見えた（r6 の試し）＝使わない。湿りは粒で見せる
      s.material.rotation = d * 6 + mt * 0.2 * (c - 0.5);
    });
    for (let i = 0; i < dropN; i++) {   // 粒：0〜1 の寿命で扇の向きへ進み、少し上がって消える（時刻だけで決まる）
      const [a, b, c, d] = dropS[i], u = ((mt * (0.35 + 0.25 * c)) + a) % 1, ang = -0.25 + 1.6 * b, dist = 0.2 + 6.2 * u * (0.6 + 0.4 * d);
      dropP[i * 3] = -3.3 + Math.cos(ang) * dist * 0.8 + 0.08 * Math.sin(mt * 1.3 + d * 20);
      dropP[i * 3 + 1] = 0.7 + 0.9 * u * c + 0.12 * Math.sin(mt * 0.9 + a * 30);
      dropP[i * 3 + 2] = -0.9 - Math.sin(ang) * dist * 0.75;
      if (dist / 6.4 > (p.reach ?? 1)) dropP[i * 3 + 1] = -10;   // まだ届いていない粒は床の下へ（湿りが手前から奥へ広がって見える）
    }
    dropG.attributes.position.needsUpdate = true; dropM.opacity = 0.6 * mo;
    grade.uniforms.uSeed.value = Math.round(t * 60) % 997;
    composer.render();
    const gl = renderer.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);   // 描き終わるまで待つ（点検が seek を続けて呼ぶと描画が溜まり、撮影が 30秒で切れた）
  }
  const px1 = new Uint8Array(4);
  return { render, THREE };
}
