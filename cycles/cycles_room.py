# cycles_room.py — 同じリビング（room3d.js と同じ寸法・配置）を Blender の Cycles で描く（光の跳ね返りを本当に計算する＝実物らしさ）。#337
#   python cycles_room.py --mode day|night --cam x,y,z --look x,y,z --fov 58 --out f.png [--samples 64] [--frames frames.json --dir out/]
#   座標は room3d.js（three.js：y が上・奥が −z）のまま受け取り、Blender（z が上）へ直す。乱数は種を固定＝毎回同じ絵（決定論）
import argparse, json, math, os, sys
# この絵に要る素材（Poly Haven・CC0）。描く側（video-render-worker の cycles-room）はこれを読んで1回だけ取る＝素材の一覧はここ1か所
NEEDS = {"models": ["coffee_table_round_01", "potted_plant_01", "hanging_picture_frame_01", "wooden_display_shelves_01", "ceramic_vase_01", "potted_plant_04",
                    "throw_pillows_01", "side_table_01", "ceramic_vase_02", "standing_picture_frame_01", "wicker_basket_02"],
         "textures": ["wood_floor", "white_stucco", "polar_fleece", "curly_teddy_natural"], "hdris": ["garden_nook"]}
if "--print-needs" in sys.argv: print(json.dumps(NEEDS)); sys.exit(0)
import bpy, bmesh
from mathutils import Vector

ap = argparse.ArgumentParser()
ap.add_argument("--mode", default="day"); ap.add_argument("--cam", default="1.075,1.03,-0.925"); ap.add_argument("--look", default="-1.8,0.62,-3.7")
ap.add_argument("--fov", type=float, default=58); ap.add_argument("--out", default="room.png"); ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--frames", default=""); ap.add_argument("--dir", default=""); ap.add_argument("--res", type=float, default=1.0); ap.add_argument("--shard", default="0/1"); ap.add_argument("--assets", default="")
A = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
B = lambda x, y, z: Vector((x, -z, y))   # three → Blender
RW, RD, RH, X0, ZB = 7.2, 4.8, 2.5, -3.6, -4.8
WIN = dict(x0=-2.9, x1=-0.5, y0=0.35, y1=2.3)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

def hexc(h, a=1.0):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c) + (a,)

def mat(name, color, rough=0.5, metal=0.0, sheen=0.0, transmission=0.0, emission=None, estr=0.0, bump=None, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = hexc(color); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
    p.inputs["Sheen Weight"].default_value = sheen; p.inputs["Transmission Weight"].default_value = transmission; p.inputs["Alpha"].default_value = alpha
    if emission: p.inputs["Emission Color"].default_value = hexc(emission); p.inputs["Emission Strength"].default_value = estr
    if bump:   # 細かな凹凸（布・漆喰）：ノイズ→バンプ
        n = nt.nodes.new("ShaderNodeTexNoise"); n.inputs["Scale"].default_value = bump[0]; n.inputs["Detail"].default_value = 8
        b = nt.nodes.new("ShaderNodeBump"); b.inputs["Strength"].default_value = bump[1]; nt.links.new(n.outputs["Fac"], b.inputs["Height"]); nt.links.new(b.outputs["Normal"], p.inputs["Normal"])
    return m

def wood(name, scale=1.0):
    # 明るいオークの床：レンガ模様を板（長さ 1.2m × 幅 0.18m）に使い、板ごとに色を少し変え、木目は伸ばしたノイズ
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]; L = nt.links.new
    tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); L(tc.outputs["Object"], mp.inputs["Vector"]); mp.inputs["Scale"].default_value = (scale, scale, scale)
    br = nt.nodes.new("ShaderNodeTexBrick"); br.inputs["Scale"].default_value = 1; br.inputs["Brick Width"].default_value = 1.2; br.inputs["Row Height"].default_value = 0.18
    br.inputs["Mortar Size"].default_value = 0.0025; br.offset = 0.37; br.inputs["Color1"].default_value = hexc("#E9CFA6"); br.inputs["Color2"].default_value = hexc("#DDBE92"); br.inputs["Mortar"].default_value = hexc("#8C7457")
    L(mp.outputs["Vector"], br.inputs["Vector"])
    gm = nt.nodes.new("ShaderNodeMapping"); gm.inputs["Scale"].default_value = (2.0, 40.0, 1.0); L(mp.outputs["Vector"], gm.inputs["Vector"])
    gn = nt.nodes.new("ShaderNodeTexNoise"); gn.inputs["Scale"].default_value = 3; gn.inputs["Detail"].default_value = 10; L(gm.outputs["Vector"], gn.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"; mix.inputs["Factor"].default_value = 0.25
    L(br.outputs["Color"], mix.inputs["A"]); L(gn.outputs["Color"], mix.inputs["B"]); L(mix.outputs["Result"], p.inputs["Base Color"])
    rr = nt.nodes.new("ShaderNodeMapRange"); rr.inputs["To Min"].default_value = 0.32; rr.inputs["To Max"].default_value = 0.5; L(gn.outputs["Fac"], rr.inputs["Value"]); L(rr.outputs["Result"], p.inputs["Roughness"])
    bm = nt.nodes.new("ShaderNodeBump"); bm.inputs["Strength"].default_value = 0.25; bm.invert = True; L(br.outputs["Fac"], bm.inputs["Height"]); L(bm.outputs["Normal"], p.inputs["Normal"])
    p.inputs["Specular IOR Level"].default_value = 0.45
    return m

AS = A.assets   # Poly Haven（CC0）の素材の置き場（cg-assets-fetch・Release「cg-assets」）。無ければ手続きの材質と形で描く

def asset_mat(tid, metres=2.0, hsv=None, sheen=0.0):
    # 写真から作った PBR の画像（色・粗さ・法線・高さ）で材質を組む。.blend は新しい Blender の保存で 4.2 では読めないため画像から直接
    d = f"{AS}/textures/{tid}/textures"
    if not (AS and os.path.isdir(d)): return None
    fs = {f.rsplit("_2k", 1)[0][len(tid) + 1:]: f"{d}/{f}" for f in os.listdir(d)}
    m = bpy.data.materials.new(tid); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]; L = nt.links.new
    tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1 / metres,) * 3; L(tc.outputs["UV"], mp.inputs["Vector"])
    def img(key, color):
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = bpy.data.images.load(fs[key]); n.image.colorspace_settings.name = "sRGB" if color else "Non-Color"; L(mp.outputs["Vector"], n.inputs["Vector"]); return n
    col = img("diff", True).outputs["Color"]
    if hsv:   # 彩度と明るさだけ直す（木目・織り目のむらは写真のまま）＝茶色を避けて明るいオーク・生成りに（#336）
        hv = nt.nodes.new("ShaderNodeHueSaturation"); hv.inputs["Saturation"].default_value = hsv[0]; hv.inputs["Value"].default_value = hsv[1]; L(col, hv.inputs["Color"]); col = hv.outputs["Color"]
    L(col, p.inputs["Base Color"])
    if "rough" in fs: L(img("rough", False).outputs["Color"], p.inputs["Roughness"])
    if "nor_gl" in fs:
        nm = nt.nodes.new("ShaderNodeNormalMap"); L(img("nor_gl", False).outputs["Color"], nm.inputs["Color"]); L(nm.outputs["Normal"], p.inputs["Normal"])
    p.inputs["Sheen Weight"].default_value = sheen
    return m

def asset(aid, at, rot=0.0, face=None, scale=1.0):
    # 家具の .blend を取り込み、空の親にまとめて床（z=0）に置く。at＝three 座標の (x, z)、rot＝向き（ラジアン）
    p = f"{AS}/models/{aid}/{aid}.blend"
    if not (AS and os.path.exists(p)): return None
    with bpy.data.libraries.load(p, link=False) as (src, dst): dst.objects = list(src.objects)
    objs = [o for o in dst.objects if o and o.type in ("MESH", "EMPTY")]
    root = bpy.data.objects.new(aid, None); sc.collection.objects.link(root)
    for o in objs:
        sc.collection.objects.link(o)
        if o.parent is None: o.parent = root
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == "MESH" for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))); hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    for o in objs:
        if o.parent is root: o.location -= Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    root.scale = (scale,) * 3; root.rotation_euler.z = rot; root.location = B(at[0], at[2] if len(at) > 2 else 0, at[1])
    print("asset", aid, "size(m)", tuple(round(v * scale, 2) for v in (hi - lo)), flush=True)
    return root

def uvm(o, metres=1.0):
    # 自分で作った形に「メートル単位」の UV を貼る（箱投影）＝写真の材質の縮尺が実物どおりになる
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT"); bpy.ops.uv.cube_project(cube_size=metres, scale_to_bounds=False); bpy.ops.object.mode_set(mode="OBJECT"); o.select_set(False)

def box(name, c, size, m, bevel=0.0, seg=3, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c, rotation=rot); o = bpy.context.object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel: md = o.modifiers.new("b", "BEVEL"); md.width = bevel; md.segments = seg; bpy.ops.object.shade_smooth()
    o.data.materials.append(m)
    if AS: uvm(o)   # 写真の材質を実寸で貼る
    return o

def cyl(name, c, r, h, m, r2=None, verts=48):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r if r2 is None else r2, depth=h, location=c); o = bpy.context.object; o.name = name
    bpy.ops.object.shade_smooth(); o.data.materials.append(m); return o

# ---------- 材質 ----------
M = dict(
    floor=wood("floor"), wall=mat("wall", "#F6F0E6", 0.9, bump=(60, 0.05)), white=mat("white", "#F5F3EF", 0.35),
    sofa=mat("sofa", "#E9E2D6", 0.95, sheen=0.4, bump=(400, 0.12)), cushA=mat("cushA", "#E88E6A", 0.95, sheen=0.5, bump=(400, 0.12)),
    cushB=mat("cushB", "#EFC97A", 0.95, sheen=0.5, bump=(400, 0.12)), throw=mat("throw", "#D5E0DA", 0.95, sheen=0.5, bump=(300, 0.15)),
    rug=mat("rug", "#F1EBE0", 1.0, sheen=0.6, bump=(250, 0.35)), ash=wood("ash", 3.0), brass=mat("brass", "#D6B06A", 0.28, 1.0),
    black=mat("black", "#18191C", 0.2), leaf=mat("leaf", "#4C7A42", 0.5, sheen=0.1), pot=mat("pot", "#EEEAE4", 0.45),
    shade=mat("shade", "#FFFFFF", 0.9, transmission=0.0, emission="#FFD7A0", estr=0.0), curtain=None, book=mat("book", "#E88E6A", 0.6),
)
cur = bpy.data.materials.new("curtain"); cur.use_nodes = True; nt = cur.node_tree; nt.nodes.remove(nt.nodes["Principled BSDF"])
tr = nt.nodes.new("ShaderNodeBsdfTranslucent"); tr.inputs["Color"].default_value = hexc("#FFF8EE"); df = nt.nodes.new("ShaderNodeBsdfDiffuse"); df.inputs["Color"].default_value = hexc("#FFFFFF")
tp = nt.nodes.new("ShaderNodeBsdfTransparent"); mx1 = nt.nodes.new("ShaderNodeMixShader"); mx1.inputs["Fac"].default_value = 0.5; mx2 = nt.nodes.new("ShaderNodeMixShader"); mx2.inputs["Fac"].default_value = 0.12
nt.links.new(df.outputs[0], mx1.inputs[1]); nt.links.new(tr.outputs[0], mx1.inputs[2]); nt.links.new(mx1.outputs[0], mx2.inputs[1]); nt.links.new(tp.outputs[0], mx2.inputs[2]); nt.links.new(mx2.outputs[0], nt.nodes["Material Output"].inputs["Surface"])
M["curtain"] = cur
# 本物の材質（Poly Haven の写真から作った PBR・CC0）：床＝オークのフローリング、壁＝漆喰、ソファ＝毛足の短いフリース、ラグ＝カーリーのボア
if AS:
    for k, tid, metres, tint, sh in [("floor", "wood_floor", 2.0, (0.55, 1.65), 0), ("wall", "white_stucco", 1.5, (0.6, 1.12), 0), ("sofa", "polar_fleece", 0.5, (0.22, 1.12), 0.5), ("rug", "curly_teddy_natural", 0.6, (0.55, 1.05), 0.6)]:
        mm = asset_mat(tid, metres, tint, sh)
        if mm: M[k] = mm

# ---------- 部屋 ----------
fl = box("floor", B(0, -0.01, ZB + RD / 2), (RW, RD, 0.02), M["floor"])
box("ceil", B(0, RH + 0.05, ZB + RD / 2), (RW + 0.4, RD + 0.4, 0.1), M["wall"])
def wb(x0, x1, y0, y1): box("bw", B((x0 + x1) / 2, (y0 + y1) / 2, ZB - 0.07), (x1 - x0, 0.14, y1 - y0), M["wall"])
wb(X0 - 0.2, WIN["x0"], 0, RH); wb(WIN["x1"], -X0 + 0.2, 0, RH); wb(WIN["x0"], WIN["x1"], 0, WIN["y0"]); wb(WIN["x0"], WIN["x1"], WIN["y1"], RH)
box("lw", B(X0 - 0.07, RH / 2, ZB + RD / 2), (0.14, RD + 0.4, RH), M["wall"]); box("rw", B(-X0 + 0.07, RH / 2, ZB + RD / 2), (0.14, RD + 0.4, RH), M["wall"])
box("front", B(0, RH / 2, 0.6), (RW + 0.4, 0.14, RH), M["wall"])   # 手前の壁（画面には映らない・光を部屋に閉じ込める）
box("skirt", B(0, 0.03, ZB + 0.01), (RW, 0.015, 0.06), M["white"]); box("skirtL", B(X0 + 0.01, 0.03, ZB + RD / 2), (0.015, RD, 0.06), M["white"])
fr, wcx, wcy = 0.05, (WIN["x0"] + WIN["x1"]) / 2, (WIN["y0"] + WIN["y1"]) / 2
for (w, h, x, y) in [(WIN["x1"] - WIN["x0"], fr, wcx, WIN["y0"]), (WIN["x1"] - WIN["x0"], fr, wcx, WIN["y1"]), (fr, WIN["y1"] - WIN["y0"], WIN["x0"], wcy), (fr, WIN["y1"] - WIN["y0"], WIN["x1"], wcy), (fr * 0.7, WIN["y1"] - WIN["y0"], wcx, wcy)]:
    box("frame", B(x, y, ZB - 0.02), (w, 0.08, h), M["white"])
bpy.ops.mesh.primitive_plane_add(size=1, location=B(wcx, 1.2, ZB - 0.03)); g = bpy.context.object; g.scale = (WIN["x1"] - WIN["x0"], 1, WIN["y1"] - WIN["y0"]); g.rotation_euler = (math.pi / 2, 0, 0)
# 建築用のガラス：影の光線は素通し（ガラスで太陽が遮られない）、目に見える所は薄い反射＋透過（Light Path の定番の工夫）
glass = bpy.data.materials.new("glass"); glass.use_nodes = True; gt = glass.node_tree; gp = gt.nodes["Principled BSDF"]
gp.inputs["Transmission Weight"].default_value = 1; gp.inputs["Roughness"].default_value = 0.0; gp.inputs["IOR"].default_value = 1.05
lp = gt.nodes.new("ShaderNodeLightPath"); gtr = gt.nodes.new("ShaderNodeBsdfTransparent"); gmx = gt.nodes.new("ShaderNodeMixShader")
gt.links.new(lp.outputs["Is Shadow Ray"], gmx.inputs["Fac"]); gt.links.new(gp.outputs[0], gmx.inputs[1]); gt.links.new(gtr.outputs[0], gmx.inputs[2]); gt.links.new(gmx.outputs[0], gt.nodes["Material Output"].inputs["Surface"])
g.data.materials.append(glass)
# 窓の「光の入口」（portal）：空の光を窓から狙って取る＝室内のざらつきが減る（Blender の手引き）
bpy.ops.object.light_add(type="AREA", location=B((WIN["x0"] + WIN["x1"]) / 2, (WIN["y0"] + WIN["y1"]) / 2, ZB + 0.03)); portal = bpy.context.object
portal.data.shape = "RECTANGLE"; portal.data.size = WIN["x1"] - WIN["x0"]; portal.data.size_y = WIN["y1"] - WIN["y0"]; portal.data.cycles.is_portal = True
portal.rotation_mode = "QUATERNION"; portal.rotation_quaternion = Vector((0, -1, 0)).to_track_quat("-Z", "Y")   # 部屋の内側（Blender の −y→+y の逆＝手前）を向く
# 外：遠くの庭（柔らかい緑と空の帯を描いた大きな板・ぼけた背景として見える）。太陽は遮らない
bpy.ops.mesh.primitive_plane_add(size=1, location=B(wcx, 2.0, ZB - 7)); ext = bpy.context.object; ext.scale = (26, 12, 1); ext.rotation_euler = (math.pi / 2, 0, 0); ext.visible_shadow = False
em = bpy.data.materials.new("outside"); em.use_nodes = True; et = em.node_tree; et.nodes.remove(et.nodes["Principled BSDF"])
eo = et.nodes["Material Output"]; ee = et.nodes.new("ShaderNodeEmission"); ee.inputs["Strength"].default_value = 2.2
etc = et.nodes.new("ShaderNodeTexCoord"); esep = et.nodes.new("ShaderNodeSeparateXYZ"); et.links.new(etc.outputs["Generated"], esep.inputs[0])
enz = et.nodes.new("ShaderNodeTexNoise"); enz.inputs["Scale"].default_value = 6; enz.inputs["Detail"].default_value = 2; et.links.new(etc.outputs["Generated"], enz.inputs["Vector"])
gr = et.nodes.new("ShaderNodeValToRGB"); gr.color_ramp.elements[0].color = hexc("#7FA36A"); gr.color_ramp.elements[1].color = hexc("#B9D29A"); et.links.new(enz.outputs["Fac"], gr.inputs["Fac"])
skyc = et.nodes.new("ShaderNodeValToRGB"); skyc.color_ramp.elements[0].position = 0.52; skyc.color_ramp.elements[0].color = (0, 0, 0, 1); skyc.color_ramp.elements[1].position = 0.6; skyc.color_ramp.elements[1].color = (1, 1, 1, 1)
mixo = et.nodes.new("ShaderNodeMix"); mixo.data_type = "RGBA"; mixo.inputs["B"].default_value = hexc("#EAF2FA")
et.links.new(esep.outputs["Y"], skyc.inputs["Fac"]); et.links.new(skyc.outputs["Color"], mixo.inputs["Factor"]); et.links.new(gr.outputs["Color"], mixo.inputs["A"])
et.links.new(mixo.outputs["Result"], ee.inputs["Color"]); et.links.new(ee.outputs[0], eo.inputs["Surface"]); ext.data.materials.append(em)
if AS: ext.hide_render = True   # 本物の庭の全天球写真（HDRI）を窓の外に見せる
# 薄いカーテン（ひだ＝波の変形）
for xc in (WIN["x0"] + 0.25, WIN["x1"] - 0.15):
    bpy.ops.mesh.primitive_plane_add(size=1, location=B(xc, 1.2, ZB + 0.12)); c = bpy.context.object; c.scale = (0.9, 2.15, 1); c.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(scale=True, rotation=True); sd = c.modifiers.new("s", "SUBSURF"); sd.levels = 0; sd.subdivision_type = "SIMPLE"
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.subdivide(number_cuts=60); bpy.ops.object.mode_set(mode="OBJECT")
    for v in c.data.vertices: v.co.y += 0.07 * math.sin(v.co.x * 24) + 0.025 * math.sin(v.co.x * 61)
    bpy.ops.object.shade_smooth(); c.data.materials.append(M["curtain"])

# ---------- 家具 ----------
SX, SZ = X0 + 0.55, -2.7
box("sofaBase", B(SX, 0.2, SZ), (0.95, 2.3, 0.22), M["sofa"], 0.04)
for dz in (-0.53, 0.53):
    box("seat", B(SX + 0.08, 0.39, SZ + dz), (0.72, 1.02, 0.16), M["sofa"], 0.06, 4); box("back", B(SX - 0.33, 0.68, SZ + dz), (0.24, 1.02, 0.5), M["sofa"], 0.09, 4)
for dz in (-1.08, 1.08): box("arm", B(SX, 0.42, SZ + dz), (0.95, 0.18, 0.42), M["sofa"], 0.07, 4)
for (x, y, z, ry, m) in [(SX - 0.13, 0.6, SZ - 0.62, 0.25, M["cushA"]), (SX - 0.13, 0.6, SZ + 0.55, -0.2, M["cushB"]), (SX - 0.1, 0.58, SZ + 0.05, 0.05, M["throw"])]:
    box("cushion", B(x, y, z), (0.15, 0.4, 0.4), m, 0.07, 4, rot=(0, -0.3, -ry))
for dz in (-1, 1):
    for dx in (-0.38, 0.38): cyl("foot", B(SX + dx, 0.045, SZ + dz * 1.05), 0.02, 0.09, M["brass"], 0.015)
box("rug", B(-1.75, 0.008, SZ), (2.0, 2.6, 0.016), M["rug"], 0.006)
cyl("tableTop", B(-1.65, 0.4, SZ), 0.45, 0.04, M["white"])
for i in range(4):
    a = i * math.pi / 2 + 0.6; cyl("leg", B(-1.65 + 0.3 * math.cos(a), 0.19, SZ + 0.3 * math.sin(a)), 0.022, 0.38, M["ash"], 0.018)
cyl("cup", B(-1.55, 0.465, SZ - 0.12), 0.05, 0.09, M["white"], 0.04); box("bookT", B(-1.78, 0.44, SZ + 0.12), (0.22, 0.3, 0.04), M["book"], 0.004)
# 観葉植物
PX, PZ = -0.05, ZB + 0.45
cyl("pot", B(PX, 0.21, PZ), 0.2, 0.42, M["pot"], 0.15)
import random; R = random.Random(21)
for i in range(40):
    h, a, rr = 0.45 + R.random() * 0.95, R.random() * math.tau, 0.05 + R.random() * 0.32
    tip = B(PX + rr * math.cos(a), 0.4 + h, PZ + rr * math.sin(a)); base = B(PX + 0.03 * math.cos(a), 0.4, PZ + 0.03 * math.sin(a))
    bm_ = bmesh.new(); pts = []
    for k in range(13):   # 葉：先の細い楕円（長さ 0.36）
        s = k / 12; w = 0.12 * math.sin(math.pi * s) ** 0.9; pts.append((w, s * 0.36));
    vs = [bm_.verts.new((x, y, 0)) for x, y in pts] + [bm_.verts.new((-x, y, 0)) for x, y in reversed(pts[1:-1])]
    bm_.faces.new(vs); me = bpy.data.meshes.new("leaf"); bm_.to_mesh(me); lf = bpy.data.objects.new("leaf", me); sc.collection.objects.link(lf)
    lf.location = tip; lf.rotation_euler = (-0.6 - R.random() * 0.7 + math.pi / 2, (R.random() - 0.5) * 0.6, -a + math.pi / 2); lf.scale = [0.8 + R.random() * 0.6] * 3
    lf.data.materials.append(M["leaf"]); sol = lf.modifiers.new("t", "SOLIDIFY"); sol.thickness = 0.003
    d = tip - base; st = cyl("stem", base + d / 2, 0.005, d.length, M["leaf"], 0.004, 8); st.rotation_mode = "QUATERNION"; st.rotation_quaternion = d.to_track_quat("Z", "Y")
# フロアランプ
LX, LZ = X0 + 0.45, SZ - 1.45
cyl("lampBase", B(LX, 0.01, LZ), 0.16, 0.02, M["brass"]); cyl("lampPole", B(LX, 0.74, LZ), 0.012, 1.45, M["brass"])
sh = cyl("lampShade", B(LX, 1.55, LZ), 0.24, 0.3, M["shade"], 0.16); sh.modifiers.new("s", "SOLIDIFY").thickness = 0.004
bpy.ops.object.mode_set(mode="EDIT"); bm2 = bmesh.from_edit_mesh(sh.data)
for f in [f for f in bm2.faces if abs(f.normal.z) > 0.9]: bm2.faces.remove(f)   # 笠の上下は開いている
bmesh.update_edit_mesh(sh.data); bpy.ops.object.mode_set(mode="OBJECT")
# 壁の絵
box("artFrame", B(X0 + 0.02, 1.45, SZ), (0.03, 0.9, 0.62), M["white"], 0.005)
art = mat("art", "#F4EFE6", 0.8); box("artIn", B(X0 + 0.04, 1.45, SZ), (0.005, 0.76, 0.5), art)
cyl("artSun", B(X0 + 0.045, 1.5, SZ - 0.05), 0.12, 0.004, M["cushA"]).rotation_euler = (0, math.pi / 2, 0)
box("artHill", B(X0 + 0.045, 1.33, SZ), (0.004, 0.46, 0.08), mat("hill", "#9DB8A8", 0.8))
# 右手前のサイドボード
BX, BZ = 1.35, -1.5
box("board", B(BX + 0.25, 0.37, BZ), (0.42, 1.5, 0.5), M["white"], 0.015)
for i, m in enumerate([M["cushA"], M["white"], M["throw"]]): box("bk", B(BX + 0.22, 0.64 + i * 0.036, BZ + 0.25), (0.26, 0.2, 0.035), m, 0.004)
cyl("vase", B(BX + 0.25, 0.75, BZ - 0.4), 0.06, 0.26, mat("vase", "#E9EEF0", 0.05, transmission=0.9), 0.08)

# 本物の家具（Poly Haven・CC0）に置き換える：ローテーブル・観葉植物・壁の絵・棚と小物・照明・クッション・かご
if AS:
    for o in [o for o in sc.objects if o.name.split(".")[0] in ("tableTop", "leg", "pot", "leaf", "stem", "artFrame", "artIn", "artSun", "artHill", "board", "bk", "vase", "cup", "bookT", "cushion")]:
        bpy.data.objects.remove(o, do_unlink=True)
    asset("coffee_table_round_01", (-1.65, SZ), scale=0.74)
    pl = asset("potted_plant_01", (-1.05, ZB + 0.6), rot=0.6, scale=1.15)
    for o in (pl.children if pl else []):   # 鉢は白い陶器に（素焼きの茶色を避ける・#336）
        if o.name.startswith("potted_plant_01_pot"): o.data.materials.clear(); o.data.materials.append(M["pot"])
    asset("hanging_picture_frame_01", (X0 + 0.03, SZ, 1.05), rot=math.pi / 2)
    asset("wooden_display_shelves_01", (0.75, ZB + 0.2))
    asset("ceramic_vase_01", (0.55, ZB + 0.2, 1.56)); asset("potted_plant_04", (0.98, ZB + 0.22, 1.56), scale=1.2)
    asset("throw_pillows_01", (SX - 0.12, SZ - 0.15, 0.47), rot=math.pi / 2, scale=0.95)
    asset("side_table_01", (X0 + 0.45, SZ + 1.5), rot=math.pi / 2, scale=0.9)
    asset("ceramic_vase_02", (X0 + 0.45, SZ + 1.55, 0.495)); asset("standing_picture_frame_01", (X0 + 0.4, SZ + 1.35, 0.495), rot=math.pi / 2 + 0.3)
    asset("wicker_basket_02", (X0 + 1.05, SZ + 1.55), rot=0.4)
    cyl("cup", B(-1.5, 0.375, SZ - 0.12), 0.045, 0.09, M["white"], 0.04); box("bookT", B(-1.82, 0.355, SZ + 0.1), (0.22, 0.3, 0.035), M["book"], 0.004, rot=(0, 0, 0.3))

# ---------- 光 ----------
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True; wn = w.node_tree; bg = wn.nodes["Background"]
sky = wn.nodes.new("ShaderNodeTexSky"); sky.sky_type = "NISHITA"; sky.sun_disc = False; sky.sun_elevation = math.radians(19); sky.sun_rotation = math.radians(200); sky.altitude = 100
wn.links.new(sky.outputs["Color"], bg.inputs["Color"])
if AS:   # 空と庭は本物の全天球写真（garden_nook・CC0）。窓の外に映り、空の光として部屋にも入る
    env = wn.nodes.new("ShaderNodeTexEnvironment"); env.image = bpy.data.images.load(f"{AS}/hdris/garden_nook.hdr")
    em_ = wn.nodes.new("ShaderNodeMapping"); tco = wn.nodes.new("ShaderNodeTexCoord"); em_.inputs["Rotation"].default_value = (0, 0, math.radians(150))
    wn.links.new(tco.outputs["Generated"], em_.inputs["Vector"]); wn.links.new(em_.outputs["Vector"], env.inputs["Vector"]); wn.links.new(env.outputs["Color"], bg.inputs["Color"])
sun_d = Vector((3.2, -8.3, -3.0)).normalized()   # room3d.js の太陽の向き（three：(-4.2,3,-10.5)→(-1,0,-2.2)）を Blender へ
bpy.ops.object.light_add(type="SUN"); sun = bpy.context.object; sun.rotation_mode = "QUATERNION"; sun.rotation_quaternion = (-sun_d).to_track_quat("Z", "Y")
sun.data.angle = math.radians(1.2); sun.data.color = (1.0, 0.86, 0.68)
bpy.ops.object.light_add(type="POINT", location=B(LX, 1.5, LZ)); lamp = bpy.context.object; lamp.data.shadow_soft_size = 0.08; lamp.data.color = (1.0, 0.72, 0.42)
if A.mode == "night":
    bg.inputs["Strength"].default_value = 0.0; sky.sun_elevation = math.radians(-8)
    wn.links.remove(bg.inputs["Color"].links[0]); bg.inputs["Color"].default_value = hexc("#1B2440"); bg.inputs["Strength"].default_value = 0.35
    sun.data.energy = 0.08; sun.data.color = (0.6, 0.7, 1.0); lamp.data.energy = 28; M["shade"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 1.2
    gr.color_ramp.elements[0].color = hexc("#0B1220"); gr.color_ramp.elements[1].color = hexc("#162238"); mixo.inputs["B"].default_value = hexc("#1E2B48"); ee.inputs["Strength"].default_value = 0.5   # 窓の外は夜
else:
    bg.inputs["Strength"].default_value = 0.55; sun.data.energy = 6.5; lamp.data.energy = 0

# ---------- カメラ・描画 ----------
cd = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cd); sc.collection.objects.link(cam); sc.camera = cam
cd.sensor_fit = "VERTICAL"; cd.clip_start = 0.05
cd.dof.use_dof = True; cd.dof.aperture_fstop = 1.4   # 写真の被写界深度：外の緑と手前がぼける
def aim(c, l, fov):
    # 建築写真の撮り方：カメラは水平のまま、見下ろす分はレンズのシフトで（縦の線がまっすぐ＝CG らしさが消える）
    d = B(*l) - B(*c); flat = Vector((d.x, d.y, 0)); pitch = math.atan2(d.z, flat.length)
    cam.location = B(*c); cam.rotation_mode = "QUATERNION"; cam.rotation_quaternion = flat.to_track_quat("-Z", "Y")
    cd.angle_y = math.radians(fov); cd.shift_y = math.tan(pitch) / (2 * math.tan(math.radians(fov) / 2)); cd.shift_x = 0
    cd.dof.focus_distance = d.length * 0.62
sc.render.engine = "CYCLES"; cy = sc.cycles; cy.device = "CPU"; cy.samples = A.samples; cy.use_denoising = True; cy.denoiser = "OPENIMAGEDENOISE"
cy.seed = 21; cy.use_animated_seed = False; cy.max_bounces = 6; cy.diffuse_bounces = 4; cy.glossy_bounces = 3; cy.transmission_bounces = 6; cy.caustics_reflective = False; cy.caustics_refractive = False
cy.adaptive_threshold = 0.02; sc.render.use_persistent_data = True   # 何コマも描く時は場面の組み立てを1回だけ
sc.render.resolution_x, sc.render.resolution_y = int(1080 * A.res), int(1920 * A.res); sc.render.resolution_percentage = 100
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"; sc.view_settings.exposure = (0.75 if AS else 0.45) if A.mode == "day" else -0.6
sc.render.image_settings.file_format = "PNG"; sc.render.threads_mode = "AUTO"
# レンズの癖（合成ノード）：明るい所のにじみ（窓・ランプ）と、ごく弱い歪みと色ずれ。粒子と周辺減光は画面側（humid.html）で足す
sc.use_nodes = True; ct = sc.node_tree; ct.nodes.clear()
rl = ct.nodes.new("CompositorNodeRLayers"); gl = ct.nodes.new("CompositorNodeGlare"); gl.glare_type = "FOG_GLOW"; gl.quality = "HIGH"; gl.mix = -0.9; gl.threshold = 1.2; gl.size = 8
ld = ct.nodes.new("CompositorNodeLensdist"); ld.inputs["Distortion"].default_value = -0.012; ld.use_fit = True; ld.inputs["Dispersion"].default_value = 0.008
co = ct.nodes.new("CompositorNodeComposite"); ct.links.new(rl.outputs["Image"], gl.inputs["Image"]); ct.links.new(gl.outputs["Image"], ld.inputs["Image"]); ct.links.new(ld.outputs["Image"], co.inputs["Image"])
k_, n_ = map(int, A.shard.split("/"))   # matrix の k 台目／n 台：k, k+n, k+2n… のコマだけ描く
jobs = json.load(open(A.frames))[k_::n_] if A.frames else [{"cam": [float(v) for v in A.cam.split(",")], "look": [float(v) for v in A.look.split(",")], "fov": A.fov, "out": A.out}]
for j in jobs:   # 1つの起動で何コマも（場面を毎回組み直さない）
    aim(j["cam"], j["look"], j.get("fov", A.fov)); sc.render.filepath = os.path.join(A.dir, j["out"]) if A.dir else j["out"]
    bpy.ops.render.render(write_still=True); print("wrote", sc.render.filepath, flush=True)
