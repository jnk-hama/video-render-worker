// 物理を先に焼く（#354）：node factory/physbake.mjs <spec.json> <out.json>（作業場所で走らせる＝node_modules に matter-js・@dimforge/rapier3d-compat）
//   型は seek(t) で好きな順にコマを描くので、物理を描きながら進めると順番で絵が変わる。だから先に「固定の刻み」で最後まで計算して
//   コマごとの位置と向きの表にし、型は MK.phys(表, t) で読むだけにする。同じ spec なら毎回同じ表（乱数なし・刻み固定）。
//   engine: "rapier3d"（3D の剛体・Apache-2.0）／"matter2d"（2D の剛体・MIT）。
//   spec = { engine, dur, step: 1/480, sample: 240, gravity, ground, bodies: [{ id, t, shape, ... }] }
//     3D：単位は自由（型の側で 1 単位＝何 px かを決める）。ground={ z } の平らな床。shape "disc"（r・h。円柱の軸は体の y）
//     2D：単位は px・y は下向き。ground={ y } の床・walls=[{ x, y, w, h, angle }] の止まった壁。shape "circle"（r）／"box"（w・h）
//   out = { [id]: { t0, hz, s: [[x,y,z,qx,qy,qz,qw] or [x,y,角度], …], land, rest } }
//     land＝初めて床か他の物に触れた時刻・rest＝それ以後に止まった時刻（秒・spec の 0 から）。音を当てる時刻・検査に使う
import fs from "node:fs";

export async function bake(spec) {
  const step = spec.step || 1 / 480, every = Math.max(1, Math.round(1 / (spec.sample || 240) / step)), N = Math.ceil(spec.dur / step);
  const out = {}, live = [];
  const rec = (b, k, st, touching, speed) => {
    const o = out[b.id];
    if (touching && o.land == null) o.land = +(k * step).toFixed(4);
    if (o.land != null && speed < (spec.restSpeed ?? 0.02) && o.rest == null) o.rest = +(k * step).toFixed(4);
    if (o.land != null && speed >= (spec.restSpeed ?? 0.02) * 3) o.rest = null;   // 止まったと見えた後にまた動いたら取り消す
    if ((k - Math.round(b.t / step)) % every === 0) o.s.push(st.map((v) => +v.toFixed(5)));
  };
  if (spec.engine === "rapier3d") {
    const R = (await import("@dimforge/rapier3d-compat")).default;
    await R.init();
    const world = new R.World({ x: 0, y: 0, z: 0, ...spec.gravity });
    world.timestep = step;
    const g = spec.ground;
    world.createCollider(R.ColliderDesc.cuboid(1e3, 1e3, 1).setTranslation(0, 0, g.z - 1).setFriction(g.friction ?? 0.7).setRestitution(g.restitution ?? 0.2));
    for (let k = 0; k <= N; k++) {
      for (const b of spec.bodies) if (Math.round(b.t / step) === k) {
        const d = R.RigidBodyDesc.dynamic().setTranslation(...b.pos).setRotation(b.rot).setLinvel(...(b.vel || [0, 0, 0])).setAngvel({ x: 0, y: 0, z: 0, ...(b.ang ? { x: b.ang[0], y: b.ang[1], z: b.ang[2] } : {}) }).setLinearDamping(b.linDamp ?? 0).setAngularDamping(b.angDamp ?? 0);   // 空気の抵抗（無ければ 0）
        const body = world.createRigidBody(d.setCcdEnabled(true));
        if (b.shape !== "disc") throw new Error(`3D の形 ${b.shape} は未対応`);
        world.createCollider(R.ColliderDesc.cylinder(b.h / 2, b.r).setDensity(b.density ?? 1).setFriction(b.friction ?? 0.6).setRestitution(b.restitution ?? 0.3), body);
        live.push([b, body]); out[b.id] = { t0: b.t, hz: 1 / (step * every), s: [], land: null, rest: null };
      }
      for (const [b, body] of live) {
        const p = body.translation(), q = body.rotation(), v = body.linvel(), w = body.angvel();
        const az = 2 * (q.y * q.z + q.w * q.x);   // 体の y 軸（円柱の軸）の z 成分＝回転行列の 2 列目の 3 行目
        const bottom = p.z - Math.abs(az) * b.h / 2 - Math.sqrt(Math.max(0, 1 - az * az)) * b.r;   // 円柱の一番低い点
        let touch = bottom <= g.z + 1e-3;
        if (!touch) for (const [b2, o2] of live) if (o2 !== body) { const p2 = o2.translation(); if (Math.hypot(p.x - p2.x, p.y - p2.y, p.z - p2.z) < b.r + b2.r + 1e-3) touch = true; }
        rec(b, k, [p.x, p.y, p.z, q.x, q.y, q.z, q.w], touch, Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z) * b.r);
      }
      world.step();
    }
  } else if (spec.engine === "matter2d") {
    const M = (await import("matter-js")).default;
    M.Common._seed = spec.seed || 0;
    const eng = M.Engine.create({ gravity: { x: 0, y: 1, scale: 0, ...spec.gravity } }), g = spec.ground;
    M.Composite.add(eng.world, M.Bodies.rectangle(spec.ground.x ?? 540, g.y + 500, g.w ?? 4000, 1000, { isStatic: true, friction: g.friction ?? 0.6, restitution: g.restitution ?? 0.2 }));
    for (const w of spec.walls || []) M.Composite.add(eng.world, M.Bodies.rectangle(w.x, w.y, w.w, w.h, { isStatic: true, angle: w.angle || 0, friction: w.friction ?? 0.1, restitution: w.restitution ?? 0.3 }));   // 受け皿の壁など（中心・幅・高さ）
    for (let k = 0; k <= N; k++) {
      for (const b of spec.bodies) if (Math.round(b.t / step) === k) {
        const o = { restitution: b.restitution ?? 0.3, friction: b.friction ?? 0.4, frictionAir: b.air ?? 0.01, angle: b.angle || 0, density: b.density ?? 0.001 };
        const body = b.shape === "circle" ? M.Bodies.circle(b.pos[0], b.pos[1], b.r, o) : M.Bodies.rectangle(b.pos[0], b.pos[1], b.w, b.h, o);
        M.Body.setVelocity(body, { x: (b.vel?.[0] || 0) / 60, y: (b.vel?.[1] || 0) / 60 });   // matter の速さは「1/60 秒あたりの px」（Body._baseDelta・刻みの長さに依らない）
        M.Body.setAngularVelocity(body, (b.ang || 0) / 60);
        M.Composite.add(eng.world, body); live.push([b, body]); out[b.id] = { t0: b.t, hz: 1 / (step * every), s: [], land: null, rest: null };
      }
      const pairs = eng.pairs.list.filter((p) => p.isActive);
      for (const [b, body] of live) {
        const touch = pairs.some((p) => p.bodyA === body || p.bodyB === body);
        rec(b, k, [body.position.x, body.position.y, body.angle], touch, (Math.hypot(body.velocity.x, body.velocity.y) + Math.abs(body.angularVelocity) * (b.r || b.w / 2)) * 60);   // px/秒
      }
      M.Engine.update(eng, step * 1000);
    }
  } else throw new Error(`engine は rapier3d か matter2d: ${spec.engine}`);
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [specPath, outPath] = process.argv.slice(2);
  const out = await bake(JSON.parse(fs.readFileSync(specPath, "utf8")));
  fs.writeFileSync(outPath, JSON.stringify(out));
  for (const [id, o] of Object.entries(out)) console.log(`${id}: ${o.s.length} コマ（${o.hz}Hz）・触れた ${o.land ?? "無し"}秒・止まった ${o.rest ?? "無し"}秒`);
}
