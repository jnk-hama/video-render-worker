# cycles_alpaca.py — アルパカ プラス ストーブ（TS-77NC）を 3DCG で描く（Blender 4.2 Cycles・#366 の例外）
#   5人会議 works/alpaca-stove/MEETING.md：白い撮影台（紙の背景）の製品撮影／真上から光の輪（360°）／タンクの寄り／揺れて消火／分解図（カメラを回さず部品だけ浮く）
#   ★#068 の例外の4条件：形・寸法・色は販売ページに合わせる（幅35×奥行35×高さ42cm・サンドベージュ×ブラックガード・asp0/10/16）／
#     画面に「※3DCG」／性能を描き足さない（光の輪・揺れと消火の動きは「イメージ」と画面に書く）／送る前に目で見る
#   ★販売ページの写真は使わない（材質は手続きで作る）＝公開リポジトリの Actions で描いてよい
#   使い方：python cycles_alpaca.py --jobs jobs.json --dir out/ [--shard k/N] [--samples 48] [--res 1.0] [--only 0,30,60] [--proj-only]
#     出力：k_####.jpg（絵）・m_####.png（商品の形）・p_####.json（画面の点と本体の箱）
#   乱数は使わない＝同じ jobs なら同じ絵
import argparse, json, math, os, sys
import bpy, bmesh
from mathutils import Vector, Euler
from bpy_extras.object_utils import world_to_camera_view

ap = argparse.ArgumentParser()
ap.add_argument("--jobs", required=True); ap.add_argument("--dir", default="out"); ap.add_argument("--shard", default="0/1")
ap.add_argument("--samples", type=int, default=48); ap.add_argument("--res", type=float, default=1.0); ap.add_argument("--only", default=""); ap.add_argument("--proj-only", action="store_true")
A = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
J = json.load(open(A.jobs)); EV, SC = J["events"], J["scenes"]
os.makedirs(A.dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
clamp = lambda x, a=0.0, b=1.0: max(a, min(b, x))
lerp = lambda a, b, u: a + (b - a) * u
ioc = lambda x: (lambda x: 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2)(clamp(x))
ios = lambda x: 0.5 - 0.5 * math.cos(math.pi * clamp(x))
oc = lambda x: 1 - (1 - clamp(x)) ** 3
def spring(t, d=0.8, b=0.12):
    if t <= 0: return 0.0
    w = 2 * math.pi / d; z = 1 - b; wd = w * math.sqrt(1 - z * z)
    return 1 - math.exp(-z * w * t) * (math.cos(wd * t) + z * w / wd * math.sin(wd * t))
def srgb(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c) + (1.0,)

# =====================================================================
# 材質（手続き）
# =====================================================================
def node(nt, kind, **inp):
    n = nt.nodes.new(kind)
    for k, v in inp.items():
        if k in n.inputs: n.inputs[k].default_value = v
        else: setattr(n, k, v)
    return n
def plain(name, color, rough=0.5, metal=0.0, coat=0.0, emission=None, estr=0.0, transmission=0.0, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(color); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat; p.inputs["Transmission Weight"].default_value = transmission; p.inputs["Alpha"].default_value = alpha
    if emission: p.inputs["Emission Color"].default_value = srgb(emission); p.inputs["Emission Strength"].default_value = estr
    return m
def paper():
    """撮影台の紙（暖かい白・少しの繊維のむら）。真っ白にしない＝本体の白い所と分かれる"""
    m = bpy.data.materials.new("paper"); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]
    tc = node(nt, "ShaderNodeTexCoord"); nz = node(nt, "ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 40; nz.inputs["Detail"].default_value = 6; nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    cr = node(nt, "ShaderNodeValToRGB"); cr.color_ramp.elements[0].color = srgb("#D9D0C2"); cr.color_ramp.elements[1].color = srgb("#E2DACD"); nt.links.new(nz.outputs["Fac"], cr.inputs[0])   # 白く飛んだ（13%・試し描き）
    nt.links.new(cr.outputs[0], p.inputs["Base Color"]); p.inputs["Roughness"].default_value = 0.92; return m
def perforated():
    """燃焼筒のパンチング金属（asp10 ③）：円柱の角度と高さで丸い穴を並べ、穴の所は奥の光（G）が見える"""
    m = bpy.data.materials.new("perf"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, "ShaderNodeOutputMaterial"); tc = node(nt, "ShaderNodeTexCoord"); sep = node(nt, "ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Object"], sep.inputs[0])
    at = node(nt, "ShaderNodeMath", operation="ARCTAN2"); nt.links.new(sep.outputs["Y"], at.inputs[0]); nt.links.new(sep.outputs["X"], at.inputs[1])
    cmb = node(nt, "ShaderNodeCombineXYZ"); mu = node(nt, "ShaderNodeMath", operation="MULTIPLY"); mu.inputs[1].default_value = 0.055
    nt.links.new(at.outputs[0], mu.inputs[0]); nt.links.new(mu.outputs[0], cmb.inputs[0]); nt.links.new(sep.outputs["Z"], cmb.inputs[1])
    br = node(nt, "ShaderNodeTexVoronoi", feature="F1"); br.inputs["Scale"].default_value = 160; br.inputs["Randomness"].default_value = 0.0; nt.links.new(cmb.outputs[0], br.inputs["Vector"])
    hole = node(nt, "ShaderNodeMath", operation="LESS_THAN"); hole.inputs[1].default_value = 0.30; nt.links.new(br.outputs["Distance"], hole.inputs[0])
    met = node(nt, "ShaderNodeBsdfPrincipled"); met.inputs["Base Color"].default_value = srgb("#C9CACC"); met.inputs["Metallic"].default_value = 1.0; met.inputs["Roughness"].default_value = 0.32
    em = node(nt, "ShaderNodeEmission"); em.inputs["Color"].default_value = srgb("#FF7A2A"); GLOW.append(em.inputs["Strength"])
    dark = node(nt, "ShaderNodeBsdfDiffuse"); dark.inputs["Color"].default_value = srgb("#1A1512")
    add = node(nt, "ShaderNodeAddShader"); nt.links.new(dark.outputs[0], add.inputs[0]); nt.links.new(em.outputs[0], add.inputs[1])
    mix = node(nt, "ShaderNodeMixShader"); nt.links.new(hole.outputs[0], mix.inputs[0]); nt.links.new(met.outputs[0], mix.inputs[1]); nt.links.new(add.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"]); return m
def light_ring():
    """S2 の床の光の輪（CG・※「光の輪はイメージ」）：中心からの距離で帯を作り、R（輪の半径）と K（強さ）を毎コマ変える"""
    m = bpy.data.materials.new("ring"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); m.blend_method = "BLEND"
    out = node(nt, "ShaderNodeOutputMaterial"); tc = node(nt, "ShaderNodeTexCoord"); vl = node(nt, "ShaderNodeVectorMath", operation="LENGTH"); nt.links.new(tc.outputs["Object"], vl.inputs[0])
    R = node(nt, "ShaderNodeValue"); K = node(nt, "ShaderNodeValue")
    d = node(nt, "ShaderNodeMath", operation="SUBTRACT"); nt.links.new(vl.outputs["Value"], d.inputs[0]); nt.links.new(R.outputs[0], d.inputs[1])
    ab = node(nt, "ShaderNodeMath", operation="ABSOLUTE"); nt.links.new(d.outputs[0], ab.inputs[0])
    band = node(nt, "ShaderNodeMapRange"); band.inputs["From Min"].default_value = 0.0; band.inputs["From Max"].default_value = 0.09; band.inputs["To Min"].default_value = 1.0; band.inputs["To Max"].default_value = 0.0
    nt.links.new(ab.outputs[0], band.inputs["Value"])
    inner = node(nt, "ShaderNodeMapRange"); inner.inputs["From Min"].default_value = 0.0; inner.inputs["To Min"].default_value = 0.35; inner.inputs["To Max"].default_value = 0.0
    nt.links.new(vl.outputs["Value"], inner.inputs["Value"]); nt.links.new(R.outputs[0], inner.inputs["From Max"])   # 輪の内側は薄く暖かい（光が届いた所）
    sm = node(nt, "ShaderNodeMath", operation="ADD"); nt.links.new(band.outputs[0], sm.inputs[0]); nt.links.new(inner.outputs[0], sm.inputs[1])
    a = node(nt, "ShaderNodeMath", operation="MULTIPLY", use_clamp=True); nt.links.new(sm.outputs[0], a.inputs[0]); nt.links.new(K.outputs[0], a.inputs[1])
    em = node(nt, "ShaderNodeEmission"); em.inputs["Color"].default_value = srgb("#FF9A4A"); em.inputs["Strength"].default_value = 2.2
    tr = node(nt, "ShaderNodeBsdfTransparent"); mx = node(nt, "ShaderNodeMixShader")
    nt.links.new(a.outputs[0], mx.inputs[0]); nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(em.outputs[0], mx.inputs[2]); nt.links.new(mx.outputs[0], out.inputs["Surface"])
    return m, R, K

GLOW = []   # 燃焼の光の強さ（材質の入力）。state(t) で毎コマ入れる
M_BLACK = plain("black", "#1C1B1A", 0.38, metal=0.2, coat=0.25)      # ガード・上板・受け皿（黒の粉体塗装）
M_SAND = plain("sand", "#B39672", 0.36, coat=0.25)   # 薄くて白に見えた（試し描き）＝asp0 のサンドベージュへ濃く                   # タンク（サンドベージュ・asp0）
M_CHROME = plain("chrome", "#DADBDD", 0.12, metal=1.0)
M_GLASS = plain("glass", "#FFFFFF", 0.02, transmission=1.0); M_GLASS.node_tree.nodes["Principled BSDF"].inputs["IOR"].default_value = 1.0   # 屈折させない（薄い外筒でも燃焼筒の光が丸く曲がった）。映り込みは残る
M_GAUGE = plain("gauge", "#F4F2EE", 0.3)
M_RED = plain("red", "#C23A2B", 0.4)

# =====================================================================
# 形（単位 m）。外形 幅35×奥行35×高さ42cm（本文 358行）。下から受け皿・タンク・燃焼部・燃焼筒・ガード・上板（asp10・asp16）
# =====================================================================
stove = bpy.data.objects.new("stove", None); sc.collection.objects.link(stove)
GROUP = {k: bpy.data.objects.new(f"g_{k}", None) for k in ("burner", "chimney", "guard", "top")}   # 分解図で浮く組
for g in GROUP.values(): sc.collection.objects.link(g); g.parent = stove
PARTS = []
def own(ob, parent=stove, idx=1):
    ob.parent = parent; ob.pass_index = idx; PARTS.append(ob); return ob
def lathe(name, prof, mat, steps=96, close=True, sub=1):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new((r, 0, z)) for r, z in prof]; es = [bm.edges.new((vs[i], vs[i + 1])) for i in range(len(vs) - 1)]
    if close: es.append(bm.edges.new((vs[-1], vs[0])))
    bmesh.ops.spin(bm, geom=vs + es, cent=(0, 0, 0), axis=(0, 0, 1), angle=2 * math.pi, steps=steps, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)   # 面の向きを外へ。逆のままだとガラスの外筒が厚いレンズになり、燃焼筒の光が卵の形に曲がった（試し描き）
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); ob.data.materials.append(mat)
    for p in ob.data.polygons: p.use_smooth = True
    if sub: md = ob.modifiers.new("sub", "SUBSURF"); md.levels = 1; md.render_levels = sub
    return ob
def box(name, size, loc, mat, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot); ob = bpy.context.object; ob.name = name; ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel: md = ob.modifiers.new("bv", "BEVEL"); md.width = bevel; md.segments = 4
    ob.data.materials.append(mat); return ob
def cyl(name, r, h, loc, mat, rot=(0, 0, 0), verts=64):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, rotation=rot, vertices=verts); ob = bpy.context.object; ob.name = name; ob.data.materials.append(mat)
    for p in ob.data.polygons: p.use_smooth = True
    return ob
def wire(name, pts, rad, mat, cyclic=False):
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = rad; cu.bevel_resolution = 3; cu.fill_mode = "FULL"
    sp = cu.splines.new("POLY"); sp.points.add(len(pts) - 1)
    for i, (x, y, z) in enumerate(pts): sp.points[i].co = (x, y, z, 1)
    sp.use_cyclic_u = cyclic; ob = bpy.data.objects.new(name, cu); sc.collection.objects.link(ob); ob.data.materials.append(mat); return ob
def ring_pts(r, z, n=96): return [(r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), z) for k in range(n)]
FRONT = -math.pi / 2   # 正面（-Y）の角度

# ---------- 受け皿（黒・縁が少し立つ）とタンク（サンドベージュ・上の縁は黒）----------
own(lathe("tray", [(0, 0), (0.172, 0), (0.176, 0.004), (0.177, 0.012), (0.171, 0.012), (0.168, 0.006), (0, 0.006)], M_BLACK))
own(lathe("tank", [(0, 0.008), (0.140, 0.008), (0.147, 0.014), (0.149, 0.030), (0.149, 0.100), (0.146, 0.108), (0.140, 0.112), (0, 0.112)], M_SAND))
own(lathe("deck", [(0.090, 0.110), (0.153, 0.110), (0.156, 0.114), (0.156, 0.121), (0.150, 0.123), (0.090, 0.121)], M_BLACK))   # ガードの台の輪（asp16 の黒い縁）
def tri(name, w, h, th, loc, mat):   # 正面の三角の印（asp0 のテントの形）。四角は黒い札に見えた（試し描き）
    me = bpy.data.meshes.new(name); bm = bmesh.new(); v = [bm.verts.new(p) for p in ((-w / 2, 0, 0), (w / 2, 0, 0), (0, 0, h))]; f = bm.faces.new(v)
    ex = bmesh.ops.extrude_face_region(bm, geom=[f]); bmesh.ops.translate(bm, vec=(0, -th, 0), verts=[x for x in ex["geom"] if isinstance(x, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free(); ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); ob.data.materials.append(mat); ob.location = loc; return ob
own(tri("emblem", 0.030, 0.026, 0.0015, (0, -0.1485, 0.046), M_BLACK))
GA = math.radians(-125); CA = math.radians(-58)   # 油量計・給油口の向き（正面から左・右）
own(cyl("gauge_bezel", 0.019, 0.010, (0.123 * math.cos(GA), 0.123 * math.sin(GA), 0.116), M_CHROME))
own(cyl("gauge_face", 0.016, 0.011, (0.123 * math.cos(GA), 0.123 * math.sin(GA), 0.117), M_GAUGE))
own(box("gauge_needle", (0.012, 0.0015, 0.0008), (0.123 * math.cos(GA) + 0.003, 0.123 * math.sin(GA), 0.1228), M_RED))
cap = own(lathe("cap", [(0, 0.112), (0.021, 0.112), (0.022, 0.120), (0.018, 0.128), (0, 0.129)], M_CHROME, steps=48)); cap.location = (0.123 * math.cos(CA), 0.123 * math.sin(CA), 0)
# ---------- 燃焼部（黒の胴・つまみ箱＝耐震自動消火とつまみ）----------
own(lathe("burner", [(0, 0.120), (0.072, 0.120), (0.074, 0.128), (0.074, 0.168), (0.066, 0.176), (0, 0.176)], M_BLACK), GROUP["burner"])
own(lathe("btrim", [(0.060, 0.176), (0.078, 0.176), (0.078, 0.181), (0.060, 0.181)], M_CHROME, sub=0), GROUP["burner"])
kb = own(box("knobbox", (0.058, 0.050, 0.046), (0, -0.092, 0.150), M_BLACK, bevel=0.008), GROUP["burner"])
KNOB = own(cyl("knob", 0.018, 0.026, (-0.006, -0.128, 0.150), M_BLACK, rot=(math.radians(90), 0, 0)), GROUP["burner"])
for k in range(12):   # つまみの刻み
    a = 2 * math.pi * k / 12; own(box(f"kr{k}", (0.003, 0.026, 0.004), (-0.006 + 0.018 * math.cos(a), -0.128, 0.150 + 0.018 * math.sin(a)), M_BLACK, rot=(0, -a, 0)), GROUP["burner"])
own(box("lever", (0.010, 0.020, 0.012), (0.020, -0.120, 0.163), M_CHROME, bevel=0.002), GROUP["burner"])
# ---------- 燃焼筒（パンチング金属＋ガラスの外筒＋上の輪＋取っ手のばね・asp10 ②③④）----------
M_PERF = perforated()
own(lathe("mesh_in", [(0.058, 0.181), (0.058, 0.330), (0.056, 0.330), (0.056, 0.181)], M_PERF, sub=0, steps=128), GROUP["chimney"])   # 燃焼筒は写真（asp16）では上の輪の近くまで高い＝低いと光が玉に見えた
own(lathe("glass", [(0.070, 0.185), (0.070, 0.328), (0.067, 0.328), (0.067, 0.185)], M_GLASS, sub=0, steps=128), GROUP["chimney"])
own(lathe("ch_top", [(0.040, 0.328), (0.074, 0.328), (0.074, 0.342), (0.070, 0.346), (0.040, 0.346)], M_CHROME, sub=0), GROUP["chimney"])
own(lathe("ch_bot", [(0.050, 0.180), (0.076, 0.180), (0.076, 0.188), (0.050, 0.188)], M_CHROME, sub=0), GROUP["chimney"])
glow_core = own(cyl("glow_core", 0.0555, 0.146, (0, 0, 0.256), plain("core", "#000000", 1.0, emission="#FF6A1F", estr=0.0)), GROUP["chimney"])
GLOW.append(glow_core.data.materials[0].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"])
hel = [(0.079 + 0.04 * k / 160, 0.008 * math.cos(k * 2 * math.pi / 20), 0.322 + 0.008 * math.sin(k * 2 * math.pi / 20)) for k in range(161)]
own(wire("spring", hel, 0.0012, M_CHROME), GROUP["chimney"])
FL = bpy.data.objects.new("flame_light", bpy.data.lights.new("fl", "POINT")); sc.collection.objects.link(FL); FL.parent = GROUP["chimney"]
FL.location = (0, 0, 0.256); FL.data.color = (1.0, 0.55, 0.25); FL.data.shadow_soft_size = 0.05
# ---------- ガード（黒の格子：縦の棒 24本・輪3本・asp0／asp16）----------
NR, GZ0, GZ1 = 24, 0.123, 0.386
for k in range(NR):
    a = 2 * math.pi * (k + 0.5) / NR
    own(wire(f"rod{k}", [(0.150 * math.cos(a), 0.150 * math.sin(a), GZ0), (0.153 * math.cos(a), 0.153 * math.sin(a), 0.25), (0.146 * math.cos(a), 0.146 * math.sin(a), GZ1)], 0.0026, M_BLACK), GROUP["guard"])
for z, r in ((GZ0 + 0.004, 0.151), (0.250, 0.154), (GZ1 - 0.004, 0.147)):
    own(wire(f"gring{z:.3f}", ring_pts(r, z), 0.0034, M_BLACK, cyclic=True), GROUP["guard"])
# ---------- 上板（黒・外の輪と溝の並び・asp10 ⑥）と持ち手 ----------
own(lathe("top", [(0, 0.392), (0.150, 0.392), (0.156, 0.396), (0.156, 0.404), (0.150, 0.408), (0.120, 0.410), (0, 0.412)], M_BLACK), GROUP["top"])
for k in range(16):
    a = 2 * math.pi * k / 16
    own(box(f"slot{k}", (0.026, 0.004, 0.003), (0.118 * math.cos(a), 0.118 * math.sin(a), 0.4115), plain("slot", "#0B0B0B", 0.9), rot=(0, 0, a + math.pi / 2)), GROUP["top"])
for s in (-1, 1):   # 横の持ち手（細い針金の輪）
    own(wire(f"handle{s}", [(s * 0.150, -0.035, 0.360), (s * 0.168, -0.030, 0.378), (s * 0.172, 0, 0.384), (s * 0.168, 0.030, 0.378), (s * 0.150, 0.035, 0.360)], 0.0028, M_BLACK), GROUP["top"])
stove.rotation_euler = Euler((0, 0, math.radians(-18)))   # つまみ箱を正面やや右へ（asp0 の見え方）

# =====================================================================
# 白い撮影台（紙の背景・床から壁へ曲がる）・床の光の輪（S2）
# =====================================================================
def cyclorama():
    me = bpy.data.meshes.new("cyc"); bm = bmesh.new(); W = 6.0   # 床（y<0.8）から半径 0.8m の曲がりで壁（y=1.6）へ
    pts = [(0, -4.0, 0.0), (0, 0.8, 0.0)] + [(0, 0.8 + 0.8 * math.sin(math.radians(90 * k / 24)), 0.8 - 0.8 * math.cos(math.radians(90 * k / 24))) for k in range(1, 25)] + [(0, 1.6, 4.0)]
    rows = [[bm.verts.new((x, y, z)) for (_, y, z) in pts] for x in (-W / 2, W / 2)]
    for i in range(len(pts) - 1): bm.faces.new((rows[0][i], rows[1][i], rows[1][i + 1], rows[0][i + 1]))
    bm.to_mesh(me); bm.free(); ob = bpy.data.objects.new("cyc", me); sc.collection.objects.link(ob); ob.data.materials.append(paper())
    for p in ob.data.polygons: p.use_smooth = True
    return ob
cyclorama()
M_RING, RING_R, RING_K = light_ring()
bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0, 0, 0.0008)); ringp = bpy.context.object; ringp.data.materials.append(M_RING); ringp.visible_shadow = False

# ---------- 光：大きな柔らかい主光（左上）・補い（右）・上・縁（後ろ）----------
LIGHT = float(os.environ.get("ALPACA_LIGHT", "0.10"))
def area(name, size, loc, rot, energy, color):
    l = bpy.data.lights.new(name, "AREA"); l.size = size[0]; l.size_y = size[1]; l.shape = "RECTANGLE"; l.energy = energy * LIGHT; l.color = color
    o = bpy.data.objects.new(name, l); o.location = loc; o.rotation_euler = Euler(rot); sc.collection.objects.link(o); o.visible_camera = False; return o
area("key", (1.4, 1.4), (-1.3, -1.1, 1.6), (math.radians(50), 0, math.radians(-50)), 1500, (1.0, 0.95, 0.88))
area("fill", (1.6, 1.2), (1.5, -1.0, 0.8), (math.radians(70), 0, math.radians(55)), 450, (0.92, 0.95, 1.0))
area("top", (1.2, 1.2), (0, 0.1, 2.2), (0, 0, 0), 600, (1.0, 0.97, 0.92))
area("rim", (0.8, 0.5), (0.4, 1.0, 0.9), (math.radians(-60), 0, math.radians(180)), 520, (1.0, 0.93, 0.85))
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = srgb("#DCD3C6"); w.node_tree.nodes["Background"].inputs[1].default_value = 0.25

# ---------- 描く設定 ----------
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = A.samples; sc.cycles.use_denoising = True; sc.cycles.seed = 7
sc.cycles.max_bounces = 8; sc.cycles.glossy_bounces = 4; sc.cycles.transmission_bounces = 8; sc.cycles.transparent_max_bounces = 12
sc.render.resolution_x = int(1080 * A.res); sc.render.resolution_y = int(1920 * A.res); sc.render.resolution_percentage = 100
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"; sc.view_settings.exposure = float(os.environ.get("ALPACA_EXPOSURE", "-0.6"))
sc.render.image_settings.file_format = "JPEG"; sc.render.image_settings.quality = 92
sc.render.use_motion_blur = True; sc.render.motion_blur_shutter = 0.5; sc.render.fps = int(J["fps"])
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.sensor_width = 36; cam.data.dof.use_dof = True
vl = sc.view_layers[0]; vl.use_pass_object_index = True
sc.use_nodes = True; ct = sc.node_tree; ct.nodes.clear()
rl = ct.nodes.new("CompositorNodeRLayers"); co = ct.nodes.new("CompositorNodeComposite"); ct.links.new(rl.outputs["Image"], co.inputs["Image"])
idm = ct.nodes.new("CompositorNodeIDMask"); idm.index = 1; ct.links.new(rl.outputs["IndexOB"], idm.inputs["ID value"])
fo = ct.nodes.new("CompositorNodeOutputFile"); fo.base_path = A.dir; fo.format.file_format = "PNG"; fo.format.color_mode = "BW"; fo.file_slots[0].path = "m_"
ct.links.new(idm.outputs["Alpha"], fo.inputs[0])

# =====================================================================
# 時刻 → 状態（火・輪・揺れ・分解・カメラ）。時刻の源は jobs.json（timing.json の写し）だけ
# =====================================================================
def frame(pos, P, lens, sx=540, sy=640, fstop=4.0, near=0.0, roll=0.0):
    """点 P が画面の (sx, sy) に来るようにカメラを向ける（字は下の帯＝本体は上へ）"""
    pos, P = Vector(pos), Vector(P); f = (P - pos).normalized()
    up0 = Vector((0, 1, 0)) if abs(f.z) > 0.98 else Vector((0, 0, 1))
    r = f.cross(up0).normalized(); u = r.cross(f)
    tv = 18 / lens; th = tv * 1080 / 1920; dx = (sx - 540) / 540; dy = (sy - 960) / 960
    d = (f - r * dx * th + u * dy * tv).normalized()
    cam.location = pos; cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    if roll: cam.rotation_euler.rotate_axis("Z", roll)
    cam.data.lens = lens; cam.data.dof.focus_distance = max(0.05, (P - pos).length - near); cam.data.dof.aperture_fstop = fstop
def around(ang, r, h, P, lens, **kw):
    a = math.radians(ang); frame((P[0] + r * math.sin(a), P[1] - r * math.cos(a), h), P, lens, **kw)
S = lambda k: SC[k]
LIFT = {"burner": 0.03, "chimney": 0.09, "guard": 0.17, "top": 0.26}   # 分解図で浮く高さ（上の組ほど高く・重ならない間）
def state(t):
    s1, s2, s3, s4, s5, s6, s7 = (S(f"S{i}") for i in range(1, 8))
    # 火：点火で灯り、揺れの後の「消火」で消え、S6 の頭で灯り直す。ゆらぎは正弦波の和（乱数なし）
    on = oc((t - EV["ignite"]) / 0.6) * (1 - ioc((t - EV["off"]) / 0.5)) + oc((t - (s6[0] + 0.1)) / 0.6) * (1 if t >= s6[0] else 0)
    fl = 1 + 0.06 * math.sin(t * 13) + 0.04 * math.sin(t * 23 + 1.3)
    for g in GLOW: g.default_value = 9.0 * on * fl
    FL.data.energy = 14.0 * on * fl
    # 床の光の輪（S2）
    u = (t - EV["ring"]) / 2.4; RING_R.outputs[0].default_value = 0.20 + 0.45 * oc(u)   # 速く大きいと画面の外へ出た
    RING_K.outputs[0].default_value = (clamp((t - EV["ring"]) / 0.3) * (1 - clamp((t - (s3[0] - 0.4)) / 0.4))) if s2[0] <= t < s3[0] + 0.05 else 0.0
    # 揺れ（S4・「揺れ」で 0.9秒・小さく減る揺れ。動きはイメージ＝※）
    k = t - EV["shake"]; amp = 0.006 * math.exp(-2.6 * k) if 0 <= k < 1.6 else 0.0
    stove.location = (amp * math.sin(k * 2 * math.pi * 7), amp * 0.6 * math.sin(k * 2 * math.pi * 5 + 1), 0)
    # 分解図（S5）：上の組から順に浮き、場面の終わりで戻る
    for i, (name, h) in enumerate(LIFT.items()):
        a = spring(t - (EV["explode"] + 0.12 * (3 - i)), 0.9, 0.12) if s5[0] <= t < s6[0] else 0.0
        b = ioc((t - (s6[0] - 0.75)) / 0.6) if s5[0] <= t < s6[0] else 0.0
        GROUP[name].location = (0, 0, h * a * (1 - b))
    # カメラ（字は下の帯＝本体は画面の上側。回り込みはかまどさんで使ったので少なく）
    C = (0, 0, 0.21)
    if t < s2[0]:   # S1：低い正面斜めから、ゆっくり寄る（寸法の線が引ける静かな構図）
        u = ios(t / s2[0]); around(lerp(-24, -20, u), lerp(1.80, 1.62, u), 0.30, C, 60, sx=540, sy=640, fstop=5.6, near=0.12)
    elif t < s3[0]:   # S2：高い斜め（約65°）から、燃焼筒の光と床の光の輪（360°）を一緒に。真上は上板しか見えず輪も画面の外へ出た（試し描き）
        u = ios((t - s2[0]) / (s3[0] - s2[0])); a = math.radians(lerp(-8, 8, u))
        frame((0.92 * math.sin(a), -0.92 * math.cos(a), 1.30), (0, 0, 0.12), 50, sx=540, sy=600, fstop=6.3, near=0.0)   # 約53°：上板だけでなく燃焼筒の光も見える
    elif t < s4[0]:   # S3：高い角度から見下ろしてタンクの上（油量計・給油口）。手前の床が下の字の地になる（水平に寄ると本体が字の帯にかかった）
        u = ios((t - s3[0]) / (s4[0] - s3[0])); P = stove.matrix_world @ Vector((0.0, -0.09, 0.12))
        frame((lerp(-0.14, -0.04, u), -0.52, 0.80), P, 38, sx=650, sy=640, fstop=5.6, near=0.0)   # 60mm では格子が左上の PR の札まで来た
    elif t < s5[0]:   # S4：高い角度から、つまみ箱（耐震自動消火）
        u = ios((t - s4[0]) / (s5[0] - s4[0])); P = stove.matrix_world @ Vector((0, -0.10, 0.16))
        frame((lerp(0.16, 0.10, u), -0.62, 0.86), P, 38, sx=650, sy=640, fstop=5.6, near=0.0)
    elif t < s6[0]:   # S5：分解図。横から動かさず（ごく僅かに寄る）、部品だけが浮く。上板が上で切れた＝引いて下を狙う
        u = ios((t - s5[0]) / (s6[0] - s5[0])); frame((0.0, lerp(-2.75, -2.65, u), 0.45), (0, 0, 0.35), 60, sx=540, sy=660, fstop=8.0)   # 上板と札が上の見出しの帯に入った＝浮く高さを下げ、本体を下へ
    elif t < s7[0]:   # S6：少し上から（評価）。火が灯り直す
        u = ios((t - s6[0]) / (s7[0] - s6[0])); around(lerp(14, 10, u), 1.85, 0.66, C, 60, sx=540, sy=640, fstop=5.6, near=0.12)
    else:   # S7：締め。正面へゆっくり
        u = ios((t - s7[0]) / (J["end"] - s7[0])); around(lerp(-10, -2, u), lerp(1.92, 1.78, u), 0.36, C, 60, sx=540, sy=640, fstop=5.6, near=0.12)

PTS = {"center": lambda: stove.matrix_world @ Vector((0, 0, 0.21)), "top": lambda: GROUP["top"].matrix_world @ Vector((0.13, 0, 0.405)),
       "guard": lambda: GROUP["guard"].matrix_world @ Vector((0.15, 0, 0.30)), "chimney": lambda: GROUP["chimney"].matrix_world @ Vector((0.070, 0, 0.27)),
       "tank": lambda: stove.matrix_world @ Vector((0.149, 0, 0.06)), "gauge": lambda: stove.matrix_world @ Vector((0.123 * math.cos(GA), 0.123 * math.sin(GA), 0.12)),
       "cap": lambda: stove.matrix_world @ Vector((0.123 * math.cos(CA), 0.123 * math.sin(CA), 0.128)), "knob": lambda: KNOB.matrix_world.translation,
       "base": lambda: stove.matrix_world @ Vector((0, 0, 0)), "right": lambda: stove.matrix_world @ Vector((0.177, 0, 0.0)), "left": lambda: stove.matrix_world @ Vector((-0.177, 0, 0.0)),
       "topc": lambda: stove.matrix_world @ Vector((0, 0, 0.42))}
def proj():
    bpy.context.view_layer.update(); out = {}
    for k_, f in PTS.items():
        v = world_to_camera_view(sc, cam, f()); out[k_] = [round(v.x * 1080, 2), round((1 - v.y) * 1920, 2), round(v.z, 4)]
    xs, ys = [], []
    for o in PARTS:
        for c in o.bound_box:
            v = world_to_camera_view(sc, cam, o.matrix_world @ Vector(c))
            if v.z > 0: xs.append(v.x * 1080); ys.append((1 - v.y) * 1920)
    out["box"] = [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))] if xs else None
    return out

ANIM = lambda: [cam, stove] + list(GROUP.values())
k, n = map(int, A.shard.split("/")); only = {int(x) for x in A.only.split(",") if x}
for fr in J["frames"]:
    i, t = fr["i"], fr["t"]
    if (only and i not in only) or (not only and i % n != k): continue
    if A.proj_only:
        state(t); allp = locals().setdefault("ALLP", {}); allp[i] = proj(); continue
    for dt, f in ((-0.5 / J["fps"], -1), (0.0, 0), (0.5 / J["fps"], 1)):
        state(t + dt)
        for ob in ANIM(): ob.keyframe_insert("location", frame=100 + f); ob.keyframe_insert("rotation_euler", frame=100 + f)
        cam.data.keyframe_insert("lens", frame=100 + f)
    sc.frame_set(100); state(t)
    fo.file_slots[0].path = f"m_{i:04d}_"; sc.render.filepath = os.path.join(A.dir, f"k_{i:04d}.jpg")
    bpy.ops.render.render(write_still=True)
    m = [x for x in os.listdir(A.dir) if x.startswith(f"m_{i:04d}_")]
    if m: os.replace(os.path.join(A.dir, m[0]), os.path.join(A.dir, f"m_{i:04d}.png"))
    json.dump(proj(), open(os.path.join(A.dir, f"p_{i:04d}.json"), "w"))
    for ob in ANIM(): ob.animation_data_clear()
    cam.data.animation_data_clear()
    print("wrote", i, round(t, 3), flush=True)

if A.proj_only: json.dump(ALLP, open(os.path.join(A.dir, "proj_all.json"), "w")); print("proj", len(ALLP))
