// 物理を先に焼く道具の検査（#354）：node factory/test_physbake.mjs（作業場所で）。落ちたら止まる（exit 1）
//   ① 同じ spec を2回焼いて1バイトも違わない ② 円板は床の上に寝て止まる ③ 2D の玉は床の上で止まる ④ 後から入れた物は t0 まで現れない
import { bake } from "./physbake.mjs";
let n = 0; const fail = [];
const ok = (c, m) => { n++; if (!c) fail.push(m); };
const s3 = { engine: "rapier3d", dur: 2, gravity: { z: -30 }, ground: { z: 0 }, bodies: [
  { id: "a", t: 0, shape: "disc", r: 0.48, h: 0.08, pos: [0, 0, 3], rot: { x: 0.70, y: 0.08, z: 0, w: 0.70 }, ang: [2, -1, 0.5] },
  { id: "b", t: 0.3, shape: "disc", r: 0.48, h: 0.08, pos: [1.5, 0, 3], rot: { x: 0.7071, y: 0, z: 0, w: 0.7071 } }] };
const A = await bake(s3), B = await bake(s3);
ok(JSON.stringify(A) === JSON.stringify(B), "3D：同じ spec で2回焼いて表が違う（決定論でない）");
for (const id of ["a", "b"]) {
  const f = A[id].s.at(-1), q = { x: f[3], y: f[4], z: f[5], w: f[6] }, az = 2 * (q.y * q.z + q.w * q.x);
  ok(Math.abs(Math.abs(az) - 1) < 0.01, `3D ${id}：円板が寝ていない（軸の z 成分 ${az.toFixed(3)}）`);
  ok(Math.abs(f[2] - 0.04) < 0.01, `3D ${id}：床の上に乗っていない（z ${f[2]}）`);
  ok(A[id].land != null && A[id].rest != null && A[id].rest > A[id].land, `3D ${id}：触れた・止まった時刻が取れない ${A[id].land} ${A[id].rest}`);
}
ok(A.b.t0 === 0.3 && A.b.s.length < A.a.s.length, "3D：後から入れた物の始まりが違う");
const s2 = { engine: "matter2d", dur: 2, gravity: { y: 1, scale: 0.002 }, ground: { y: 1000 }, bodies: [{ id: "c", t: 0, shape: "circle", r: 40, pos: [540, 300], ang: 3 }] };
const C = await bake(s2), D = await bake(s2);
ok(JSON.stringify(C) === JSON.stringify(D), "2D：同じ spec で2回焼いて表が違う");
ok(Math.abs(C.c.s.at(-1)[1] - 960) < 2 && C.c.land != null, `2D：玉が床（y 960）に乗っていない ${C.c.s.at(-1)[1]}`);
console.log(`physbake 検査 ${n}件` + (fail.length ? `・不合格 ${fail.length}\n- ` + fail.join("\n- ") : "・すべて合格"));
process.exit(fail.length ? 1 : 0);
