// motionkit.js と edge_tokens.js のばねの検査（#334）：node factory/test_motionkit.mjs
//   落ちたら止まる（exit 1）。何も読まずに合格しないよう、検査した数を最後に出す
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const dir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ctx = { console }; ctx.window = ctx; vm.createContext(ctx);
// 部品はリポジトリでは engine/ の直下、作業場（~/.motion-work）では stage/ の下にある
const src = (f) => [path.join(dir, f), path.join(dir, "stage", f)].find((p) => fs.existsSync(p)) || (() => { throw new Error(`${f} が見つからない`); })();
for (const f of ["motionkit.js", "edge_tokens.js"]) vm.runInContext(fs.readFileSync(src(f), "utf8"), ctx);
const { MK, EDGE } = ctx; let n = 0; const fail = [];
const ok = (cond, msg) => { n++; if (!cond) fail.push(msg); };
const ts = Array.from({ length: 3001 }, (_, i) => i / 1000);

// 1) 臨界減衰のばねは目標（1）を越えない・0 から始まる・1秒で着く
for (const w of [12, 20, 40]) {
  const mx = Math.max(...ts.map((t) => MK.cd(t, w)));
  ok(mx <= 1 + 1e-12, `cd(w=${w}) が目標を越えた: ${mx}`); ok(MK.cd(0, w) === 0 && MK.cd(-1, w) === 0, `cd(w=${w}) が0から始まらない`);
  ok(MK.cd(1, w) > 0.999, `cd(w=${w}) が1秒で着かない: ${MK.cd(1, w)}`);
}
// 2) 着地のばね（edge_tokens の E.spring）の行き過ぎは 2% 以下（弾むイージングは多くの指示文で禁止・v3 までは約13%）
const over = Math.max(...ts.map((t) => EDGE.E.spring(t))) - 1;
ok(over <= 0.02, `E.spring の行き過ぎ ${(over * 100).toFixed(1)}% > 2%`);
console.log(`E.spring の行き過ぎ ${(over * 100).toFixed(2)}%`);
// 3) ばねの和：変わる前は x0、最後は最後の目標、どの順で呼んでも同じ値
const ch = [[0.2, 100], [0.6, 40], [1.1, 70]];
ok(MK.springSum(0.1, 0, ch) === 0, "springSum が変わる前に動いた"); ok(Math.abs(MK.springSum(5, 0, ch) - 70) < 1e-6, "springSum が最後の目標に着かない");
const a = [0.9, 0.3, 1.5].map((t) => MK.springSum(t, 0, ch)), b = [1.5, 0.3, 0.9].map((t) => MK.springSum(t, 0, ch)).reverse();
ok(a.every((v, i) => v === [b[2], b[1], b[0]][i] || v === b[i]), "springSum が呼ぶ順で変わった");
// 4) 面積で緩める：面積（r²）が ease に比例する
const R = 1000, e = (u) => u; ok([0.25, 0.5, 0.75].every((u) => Math.abs((MK.areaR(u, R, e) / R) ** 2 - u) < 1e-9), "areaR の面積が ease に比例しない");
// 5) 洪水の半径は4つの角すべてを覆う
for (const [cx, cy] of [[540, 960], [0, 0], [116, 870], [1080, 1920]]) {
  const r = MK.coverR(cx, cy); ok([[0, 0], [1080, 0], [0, 1920], [1080, 1920]].every(([x, y]) => Math.hypot(x - cx, y - cy) < r), `coverR(${cx},${cy}) が角を覆わない`);
}
// 6) 鉛筆のふるえ：同じ時刻なら同じ値・1/8秒の間は変わらない・1秒に8回だけ変わる
ok(MK.boil(1.23, 4, 2) === MK.boil(1.23, 4, 2), "boil が同じ時刻で違う値");
ok(MK.boil(1.001, 3, 2) === MK.boil(1.124, 3, 2), "boil が 1/8 秒の中で変わった");
const steps = new Set(ts.slice(0, 1000).map((t) => MK.boil(t, 1, 2))).size; ok(steps === 8, `boil の段が1秒に ${steps}（8 のはず）`);
ok(ts.every((t) => Math.abs(MK.boil(t, 7, 2)) <= 2), "boil が振幅を越えた");
// 7) 溜め：hit の前だけ負、hit とその後は 0
ok(MK.windup(0.9, 1.0) < 0 && MK.windup(1.0, 1.0) === 0 && MK.windup(0.5, 1.0) === 0, "windup の時間がずれた");
// 8) 感じる長さと弾みのばね（#354）：弾み 0 は cd と同じ・弾むほど行き過ぎる・粘る側は越えない・どれも最後は 1
ok(ts.every((t) => Math.abs(MK.springBD(t, 0.5, 0) - MK.cd(t, (2 * Math.PI) / 0.5)) < 1e-12), "springBD(弾み0) が cd と違う");
const os = (b) => Math.max(...ts.map((t) => MK.springBD(t, 0.6, b))) - 1;
ok(os(0.15) > 0 && os(0.3) > os(0.15) && os(-0.3) <= 1e-12, `springBD の行き過ぎの順がおかしい: ${os(0.15)} ${os(0.3)} ${os(-0.3)}`);
ok([0, 0.3, -0.3].every((b) => Math.abs(MK.springBD(3, 0.6, b) - 1) < 1e-3 && MK.springBD(0, 0.6, b) === 0), "springBD が 0 から始まって 1 に着かない");
// 9) ずらし：最初・真ん中・最後から。格子は起点からの距離
ok([0, 1, 2, 3].map((i) => MK.stagger(i, 4, 0.1)).join() === [0, 0.1, 0.2, 0.3].map((x) => MK.stagger(Math.round(x * 10), 4, 0.1)).join() && Math.abs(MK.stagger(3, 4, 0.1) - 0.3) < 1e-12, "stagger(first) の遅れが違う");
ok(MK.stagger(2, 5, 0.1, { from: "center" }) === 0 && Math.abs(MK.stagger(0, 5, 0.1, { from: "center" }) - 0.2) < 1e-12 && MK.stagger(4, 5, 0.1, { from: "last" }) === 0, "stagger(center/last) が違う");
ok(MK.stagger(4, 9, 0.1, { from: "center", grid: [3, 3] }) === 0 && Math.abs(MK.stagger(0, 9, 0.1, { from: "center", grid: [3, 3] }) - MK.stagger(8, 9, 0.1, { from: "center", grid: [3, 3] })) < 1e-12, "stagger(格子) が中心から対称でない");
// 10) 焼いた物理の読み出し：前は null・サンプルの上は一致・間は補う・四元数は長さ 1
const tr2 = { hz: 10, t0: 1, s: [[0, 0, 0], [10, 20, 1]] }, tr3 = { hz: 10, t0: 0, s: [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 1, 0]] };
ok(MK.phys(tr2, 0.9) === null && MK.phys(tr2, 1).join() === "0,0,0" && MK.phys(tr2, 1.05).every((v, q) => Math.abs(v - [5, 10, 0.5][q]) < 1e-9) && MK.phys(tr2, 9).join() === "10,20,1", "phys(2D) の読み出しが違う");
const q = MK.phys(tr3, 0.05); ok(Math.abs(Math.hypot(q[3], q[4], q[5], q[6]) - 1) < 1e-12 && Math.abs(q[5] - q[6]) < 1e-12, "phys(3D) の回転の補いが違う");

console.log(`motionkit 検査 ${n}件` + (fail.length ? `・不合格 ${fail.length}\n- ` + fail.join("\n- ") : "・すべて合格"));
process.exit(fail.length ? 1 : 0);
