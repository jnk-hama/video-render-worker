# cycles_kamado.py — 長谷園 かまどさん 三合炊きを 3DCG で描く（Blender 4.2 Cycles・#366）
#   オーナー「暗くすることが高級感とは違います。もっと3Dグラフィックやモーショングラフィックを駆使し…まるで映画のようなクオリティで」→「土鍋も3DCG」
#   ★#068 の例外の4条件（DECISIONS #366）：形・寸法・色は販売ページに合わせる（asp2 の図：直径24cm・高さ18cm）／画面に「※3DCG」／性能を描き足さない／送る前に目で見る
#   ★販売ページの写真は使わない（材質は手続きで作る）＝公開リポジトリの Actions で描いてよい
#   使い方：python cycles_kamado.py --jobs jobs.json --dir out/ [--shard k/N] [--samples 48] [--res 1.0] [--only 0,30,60]
#     jobs.json＝{fps, events{名前: 秒}, scenes{S1: [t0, t1]…}, frames[{i, t}]}（kamado3d.html の CYCLES_JOBS が出す）
#     出力：k_####.jpg（絵）・m_####.png（商品の形＝重なりの点検用）・p_####.json（画面の点＝引き出し線と湯気の起点）
#   乱数は使わない（ノイズの種も固定）＝同じ jobs なら同じ絵
import argparse, json, math, os, sys
import bpy, bmesh
from mathutils import Vector, Euler
from bpy_extras.object_utils import world_to_camera_view

ap = argparse.ArgumentParser()
ap.add_argument("--jobs", required=True); ap.add_argument("--dir", default="out"); ap.add_argument("--shard", default="0/1")
ap.add_argument("--samples", type=int, default=48); ap.add_argument("--res", type=float, default=1.0); ap.add_argument("--only", default=""); ap.add_argument("--proj-only", action="store_true")   # 描かずに画面の点と鍋の箱だけ（字の置き場を決める）
A = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
J = json.load(open(A.jobs)); EV, SC = J["events"], J["scenes"]
os.makedirs(A.dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
clamp = lambda x, a=0.0, b=1.0: max(a, min(b, x))
lerp = lambda a, b, u: a + (b - a) * u
ioc = lambda x: (lambda x: 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2)(clamp(x))      # inOutCubic
ios = lambda x: 0.5 - 0.5 * math.cos(math.pi * clamp(x))                                          # inOutSine
oc = lambda x: 1 - (1 - clamp(x)) ** 3                                                             # outCubic
def spring(t, d=0.8, b=0.12):   # 行き過ぎの小さいばね（motionkit の springBD と同じ考え）
    if t <= 0: return 0.0
    w = 2 * math.pi / d; z = 1 - b
    if z >= 1: return 1 - (1 + w * t) * math.exp(-w * t)
    wd = w * math.sqrt(1 - z * z); return 1 - math.exp(-z * w * t) * (math.cos(wd * t) + z * w / wd * math.sin(wd * t))

def srgb(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c) + (1.0,)

# =====================================================================
# 材質（手続きで作る・写真は使わない）
# =====================================================================
def node(nt, kind, **inp):
    n = nt.nodes.new(kind)
    for k, v in inp.items():
        if k in n.inputs: n.inputs[k].default_value = v
        else: setattr(n, k, v)
    return n

def glaze_clay():
    """黒の釉薬（艶・白い粒・柚子肌）と、下の素焼きの帯（伊賀の粗土）。境目は物の高さで分け、手で掛けたゆらぎを付ける（asp2 の境目は少し波打つ）"""
    m = bpy.data.materials.new("glaze_clay"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, "ShaderNodeOutputMaterial"); tc = node(nt, "ShaderNodeTexCoord"); sep = node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    # 釉薬
    g = node(nt, "ShaderNodeBsdfPrincipled"); g.inputs["Roughness"].default_value = 0.16; g.inputs["Specular IOR Level"].default_value = 0.32; g.inputs["Coat Weight"].default_value = 0.12; g.inputs["Coat Roughness"].default_value = 0.05   # 5人会議（3DCG）：艶はあるが鏡にしない
    sp = node(nt, "ShaderNodeTexVoronoi", feature="F1"); sp.inputs["Scale"].default_value = 260; sp.inputs["Randomness"].default_value = 1.0
    nt.links.new(tc.outputs["Object"], sp.inputs["Vector"])
    ramp = node(nt, "ShaderNodeValToRGB"); ramp.color_ramp.elements[0].position = 0.0; ramp.color_ramp.elements[0].color = (0.62, 0.62, 0.6, 1)
    ramp.color_ramp.elements[1].position = 0.055; ramp.color_ramp.elements[1].color = srgb("#0B0C0E"); ramp.color_ramp.interpolation = "CONSTANT"
    nt.links.new(sp.outputs["Distance"], ramp.inputs[0]); nt.links.new(ramp.outputs[0], g.inputs["Base Color"])
    pe = node(nt, "ShaderNodeTexNoise"); pe.inputs["Scale"].default_value = 90; pe.inputs["Detail"].default_value = 3; nt.links.new(tc.outputs["Object"], pe.inputs["Vector"])
    bg = node(nt, "ShaderNodeBump"); bg.inputs["Strength"].default_value = 0.08; bg.inputs["Distance"].default_value = 0.002; nt.links.new(pe.outputs["Fac"], bg.inputs["Height"])
    nt.links.new(bg.outputs["Normal"], g.inputs["Normal"])
    # 素焼き（粗土）：生成りの地＋色むら＋黒い粒＋細かな凹凸
    c = node(nt, "ShaderNodeBsdfPrincipled"); c.inputs["Roughness"].default_value = 0.88
    cn = node(nt, "ShaderNodeTexNoise"); cn.inputs["Scale"].default_value = 40; cn.inputs["Detail"].default_value = 6; nt.links.new(tc.outputs["Object"], cn.inputs["Vector"])
    cr = node(nt, "ShaderNodeValToRGB"); cr.color_ramp.elements[0].color = srgb("#B4A386"); cr.color_ramp.elements[1].color = srgb("#CDBFA4")   # 白く見えた（3周目）＝販売ページの素焼きの生成りへ; nt.links.new(cn.outputs["Fac"], cr.inputs[0])
    gv = node(nt, "ShaderNodeTexVoronoi", feature="F1"); gv.inputs["Scale"].default_value = 380; nt.links.new(tc.outputs["Object"], gv.inputs["Vector"])
    gr = node(nt, "ShaderNodeValToRGB"); gr.color_ramp.elements[0].color = srgb("#6E6252"); gr.color_ramp.elements[1].position = 0.08; gr.color_ramp.elements[1].color = (1, 1, 1, 1); gr.color_ramp.interpolation = "CONSTANT"
    nt.links.new(gv.outputs["Distance"], gr.inputs[0])
    mul = node(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY"); mul.inputs["Factor"].default_value = 1.0
    nt.links.new(cr.outputs[0], mul.inputs[6]); nt.links.new(gr.outputs[0], mul.inputs[7]); nt.links.new(mul.outputs[2], c.inputs["Base Color"])
    cb = node(nt, "ShaderNodeTexNoise"); cb.inputs["Scale"].default_value = 700; cb.inputs["Detail"].default_value = 4; nt.links.new(tc.outputs["Object"], cb.inputs["Vector"])
    bc = node(nt, "ShaderNodeBump"); bc.inputs["Strength"].default_value = 0.8; bc.inputs["Distance"].default_value = 0.0025; nt.links.new(cb.outputs["Fac"], bc.inputs["Height"])
    nt.links.new(bc.outputs["Normal"], c.inputs["Normal"])
    # 境目：物の z が 3.28cm（asp2 の境目）。ゆらぎはノイズで ±2mm
    wob = node(nt, "ShaderNodeTexNoise"); wob.inputs["Scale"].default_value = 6; nt.links.new(tc.outputs["Object"], wob.inputs["Vector"])
    ma = node(nt, "ShaderNodeMath", operation="MULTIPLY_ADD"); ma.inputs[1].default_value = 0.004; ma.inputs[2].default_value = 0.0328 - 0.002
    nt.links.new(wob.outputs["Fac"], ma.inputs[0])
    lt = node(nt, "ShaderNodeMath", operation="GREATER_THAN"); nt.links.new(sep.outputs["Z"], lt.inputs[0]); nt.links.new(ma.outputs[0], lt.inputs[1])
    mix = node(nt, "ShaderNodeMixShader"); nt.links.new(lt.outputs[0], mix.inputs[0]); nt.links.new(c.outputs[0], mix.inputs[1]); nt.links.new(g.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"]); return m

def plain(name, color, rough=0.5, metal=0.0, coat=0.0, emission=None, estr=0.0, transmission=0.0, ior=1.45):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(color); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat; p.inputs["Transmission Weight"].default_value = transmission; p.inputs["IOR"].default_value = ior
    if emission: p.inputs["Emission Color"].default_value = srgb(emission); p.inputs["Emission Strength"].default_value = estr
    return m

def glaze_only():
    m = glaze_clay().copy(); m.name = "glaze"   # 上ふた・中ふた・取っ手は釉薬だけ（物の z が境目より上になるよう、ふたは別の物として作る）
    return m

def flame_mat():
    """青い炎：中が明るく外へ透ける（Emission と Transparent を、炎の高さ方向の位置で混ぜる）"""
    m = bpy.data.materials.new("flame"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); m.blend_method = "BLEND"
    out = node(nt, "ShaderNodeOutputMaterial"); tc = node(nt, "ShaderNodeTexCoord"); sep = node(nt, "ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    em = node(nt, "ShaderNodeEmission"); em.inputs["Color"].default_value = (0.05, 0.22, 1.0, 1); em.inputs["Strength"].default_value = 7
    tr = node(nt, "ShaderNodeBsdfTransparent"); mx = node(nt, "ShaderNodeMixShader")
    pw = node(nt, "ShaderNodeMath", operation="POWER"); pw.inputs[1].default_value = 0.7; nt.links.new(sep.outputs["Z"], pw.inputs[0])
    nt.links.new(pw.outputs[0], mx.inputs[0]); nt.links.new(em.outputs[0], mx.inputs[1]); nt.links.new(tr.outputs[0], mx.inputs[2]); nt.links.new(mx.outputs[0], out.inputs["Surface"])
    return m

def tiles():
    """白い目地のタイル（台所の壁・asp6 の台所の雰囲気）：レンガ模様＋目地の凹凸"""
    m = bpy.data.materials.new("tiles"); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]
    tc = node(nt, "ShaderNodeTexCoord"); br = node(nt, "ShaderNodeTexBrick"); br.inputs["Scale"].default_value = 7.5
    br.inputs["Color1"].default_value = srgb("#D6CFC4"); br.inputs["Color2"].default_value = srgb("#CEC6BA"); br.inputs["Mortar"].default_value = srgb("#B3AA9C")   # 真っ白だとぼけて飛び、釉薬が白を映して銀に見えた
    br.inputs["Mortar Size"].default_value = 0.012; br.inputs["Brick Width"].default_value = 0.6; br.inputs["Row Height"].default_value = 0.3
    nt.links.new(tc.outputs["Object"], br.inputs["Vector"]); nt.links.new(br.outputs["Color"], p.inputs["Base Color"])
    bm = node(nt, "ShaderNodeBump"); bm.inputs["Strength"].default_value = 0.3; nt.links.new(br.outputs["Fac"], bm.inputs["Height"]); nt.links.new(bm.outputs["Normal"], p.inputs["Normal"])
    p.inputs["Roughness"].default_value = 0.55; p.inputs["Coat Weight"].default_value = 0.0; return m   # 艶のあるタイルは光を映して白く飛んだ

def wood():
    m = bpy.data.materials.new("wood"); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]
    tc = node(nt, "ShaderNodeTexCoord"); mp = node(nt, "ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1, 18, 1); nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nz = node(nt, "ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 9; nz.inputs["Detail"].default_value = 8; nz.inputs["Distortion"].default_value = 1.5; nt.links.new(mp.outputs[0], nz.inputs["Vector"])
    cr = node(nt, "ShaderNodeValToRGB"); cr.color_ramp.elements[0].color = srgb("#C9A57C"); cr.color_ramp.elements[1].color = srgb("#E2C6A0"); nt.links.new(nz.outputs["Fac"], cr.inputs[0])
    nt.links.new(cr.outputs[0], p.inputs["Base Color"]); p.inputs["Roughness"].default_value = 0.45; return m

# =====================================================================
# 形（単位は m）。輪郭は asp2（直径24cm＝447px・高さ18cm＝370px）から目で読んだ点 [半径 cm, 高さ cm]
# =====================================================================
BODY_OUT = [(0, 0), (2.23, .05), (4.1, .24), (7.32, .92), (9.2, 1.82), (10.27, 2.79), (10.94, 3.88), (11.47, 5.58), (11.69, 6.8), (11.74, 7.77),
            (11.66, 8.74), (11.6, 9.95), (11.55, 11.17), (11.3, 11.55), (11.0, 11.62)]
BODY_IN = [(10.35, 11.5), (10.4, 10.6), (10.0, 10.45), (10.05, 9.6), (10.6, 8.0), (10.5, 5.6), (9.6, 3.4), (8.0, 2.1), (5.0, 1.3), (0, 1.1)]   # 中ふたの受け（10.45cm）・肉厚の底（約1.1cm）
LID = [(10.75, 10.9), (10.4, 11.3), (9.46, 11.77), (8.39, 12.86), (6.78, 14.08), (5.17, 14.93), (3.57, 15.49), (3.16, 15.65), (3.03, 16.75), (3.7, 17.48),
       (3.7, 17.96), (2.49, 18.1), (1.42, 17.6), (0, 17.45), (0, 16.9), (2.4, 17.1), (2.5, 15.2), (5.0, 14.3), (8.0, 12.35), (10.1, 11.0)]
INNER = [(0, 10.45), (10.1, 10.45), (10.1, 11.0), (2.3, 11.0), (2.3, 12.6), (1.9, 12.8), (0, 12.8)]   # 中ふた（平らな円盤＋真ん中のつまみ・asp27）
cm = lambda p: (p[0] / 100, p[1] / 100)

def lathe(name, prof, mat, steps=128, close=False):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new((r, 0, z)) for r, z in map(cm, prof)]
    es = [bm.edges.new((vs[i], vs[i + 1])) for i in range(len(vs) - 1)]
    if close: es.append(bm.edges.new((vs[-1], vs[0])))
    bmesh.ops.spin(bm, geom=vs + es, cent=(0, 0, 0), axis=(0, 0, 1), angle=2 * math.pi, steps=steps, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); ob.data.materials.append(mat)
    for p in ob.data.polygons: p.use_smooth = True
    md = ob.modifiers.new("sub", "SUBSURF"); md.levels = 1; md.render_levels = 2
    return ob

def box(name, size, loc, mat, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot); ob = bpy.context.object; ob.name = name; ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel: md = ob.modifiers.new("bv", "BEVEL"); md.width = bevel; md.segments = 6
    ob.data.materials.append(mat); return ob

def cyl(name, r, h, loc, mat, verts=64):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, vertices=verts); ob = bpy.context.object; ob.name = name; ob.data.materials.append(mat)
    for p in ob.data.polygons: p.use_smooth = True
    return ob

M_GC = glaze_clay(); M_G = M_GC   # 同じ材質：ふたは境目（3.28cm）より上なので釉薬だけになる
body = lathe("body", BODY_OUT + BODY_IN, M_GC, close=True)
pot = bpy.data.objects.new("pot", None); sc.collection.objects.link(pot)   # 鍋の全体（コンロの上の位置）
body.parent = pot
for sx in (1, -1):   # 取っ手（asp2：半径 11.7→15.0cm・高さ 7.4〜10.3cm・上から見て幅 約9cm）
    h = box(f"handle{sx}", (0.036, 0.085, 0.026), (sx * 0.131, 0, 0.088), M_G, bevel=0.011); h.parent = pot
    for p in h.data.polygons: p.use_smooth = True
lid = lathe("lid", LID, M_G, close=True); lid.parent = pot
hole = cyl("hole", 0.0045, 0.004, (0, 0, 0), plain("hole", "#050505", 0.9)); hole.parent = lid   # 上ふたの蒸気の穴（asp2 の正面・高さ約13cm）
hz = 0.129; hr = 0.0835; hole.location = (0, -hr, hz); hole.rotation_euler = Euler((math.radians(90 - 48), 0, 0))
inner = lathe("inner", INNER, M_G, close=True); inner.parent = pot
for x in (-0.045, 0.045): ih = cyl("ihole", 0.004, 0.003, (x, 0.0, 0.1102), plain("ih", "#050505", 0.9)); ih.parent = inner
rim = lathe("rim", [(10.35, 11.5), (11.0, 11.62), (11.0, 11.66), (10.3, 11.56)], plain("rimclay", "#E3D7C0", 0.85), close=True); rim.parent = pot   # 縁の素焼き（asp27 の生成りの輪）
for ob in (body, lid, inner, rim, hole) + tuple(o for o in sc.objects if o.name.startswith(("handle", "ihole"))): ob.pass_index = 1

# ---------- 台所：白い台・タイルの壁・ガスコンロ（五徳と青い炎）・木のまな板・瓶（ぼけて奥に）----------
GZ = 0.012   # 五徳の上＝鍋の底の高さ
box("counter", (2.4, 1.6, 0.04), (0, 0.15, -0.075), wood())   # 5人会議（撮影）：白い地をやめ、暖かい中間の明るさの木
box("hob", (0.62, 0.52, 0.012), (0, 0.0, -0.05), plain("hob", "#2A2B2E", 0.25, metal=0.6, coat=0.3))
wall = box("wall", (3.0, 0.02, 1.6), (0, 0.9, 0.6), tiles())   # 鍋の 41cm 後ろでは明るすぎた＝90cm へ（ぼけも深くなる）
M_IRON = plain("iron", "#151515", 0.55, metal=0.3)
for k in range(5):   # 五徳：輪と5本の爪
    a = 2 * math.pi * k / 5 + 0.3
    box(f"arm{k}", (0.075, 0.009, 0.012), (math.cos(a) * 0.075, math.sin(a) * 0.075, GZ - 0.006), M_IRON, bevel=0.002, rot=(0, 0, a))
bpy.ops.mesh.primitive_torus_add(major_radius=0.112, minor_radius=0.006, location=(0, 0, -0.03)); bpy.context.object.data.materials.append(M_IRON)
cyl("burner", 0.034, 0.018, (0, 0, -0.035), plain("burner", "#3A3632", 0.35, metal=0.8))
M_FL = flame_mat(); FL = []
for k in range(22):
    a = 2 * math.pi * k / 22
    bpy.ops.mesh.primitive_cone_add(radius1=0.006, radius2=0.0004, depth=0.03, location=(math.cos(a) * 0.036, math.sin(a) * 0.036, -0.012), vertices=16)
    f = bpy.context.object; f.rotation_euler = Euler((0, math.radians(38), a)); f.data.materials.append(M_FL); f.visible_shadow = False; FL.append(f)
fl_light = bpy.data.objects.new("flame_light", bpy.data.lights.new("fl", "POINT")); sc.collection.objects.link(fl_light)
fl_light.location = (0, 0, -0.008); fl_light.data.color = (0.3, 0.5, 1.0); fl_light.data.shadow_soft_size = 0.03
box("board", (0.42, 0.26, 0.022), (0.52, 0.18, -0.044), wood(), bevel=0.004)
M_GLASS = plain("glass", "#FFFFFF", 0.02, transmission=1.0); M_OIL = plain("oil", "#C79A3A", 0.05, transmission=0.9)
for x, h, mt in ((-0.55, 0.24, M_GLASS), (-0.48, 0.30, M_OIL), (-0.40, 0.18, M_GLASS), (0.62, 0.26, M_GLASS)):
    cyl(f"jar{x}", 0.035, h, (x, 0.62, -0.055 + h / 2), mt)
pot.location = (0, 0, GZ)

# ---------- 光：左の窓（朝の柔らかい光）・右の弱い補い・窓の白い板（釉薬に映る＝艶）・空 ----------
LIGHT = float(os.environ.get("KAMADO_LIGHT", "0.07"))   # 光の強さの全体の倍率（1周目は白く飛んだ＝黒い釉薬が銀に見えた。測って決める）
def area(name, size, loc, rot, energy, color):
    l = bpy.data.lights.new(name, "AREA"); l.size = size[0]; l.size_y = size[1]; l.shape = "RECTANGLE"; l.energy = energy * LIGHT; l.color = color
    o = bpy.data.objects.new(name, l); o.location = loc; o.rotation_euler = Euler(rot); sc.collection.objects.link(o); return o
area("window", (1.6, 1.2), (-1.3, -0.4, 0.9), (math.radians(60), 0, math.radians(-62)), 900, (1.0, 0.93, 0.84))
area("fill", (1.2, 1.2), (1.1, -0.9, 0.6), (math.radians(65), 0, math.radians(50)), 160, (0.92, 0.95, 1.0))
area("top", (0.8, 0.8), (0.1, -0.2, 1.4), (0, 0, 0), 120, (1.0, 0.97, 0.92))
win = box("winpanel", (0.02, 1.0, 0.7), (-1.15, -0.5, 0.7), plain("winpanel", "#FFFFFF", 1.0, emission="#FFF4E6", estr=4.0)); win.visible_shadow = False; win.visible_diffuse = False   # 窓の板は釉薬に映るためだけ（部屋を照らすと全体が白く飛んだ）
# 縁の光（リムライト）：鍋の後ろ上から。黒い器は縁に細い光の線が入って形が読める（5人会議・撮影）
rakeL = area("rake", (0.5, 0.12), (-0.62, -0.32, GZ + 0.03), (math.radians(90), 0, math.radians(-62)), 700, (1.0, 0.92, 0.8)); rakeL.visible_camera = False   # 低い横の光＝素焼きの粒を浮かせる
rimL = area("rim", (0.35, 0.2), (0.22, 0.3, 0.42), (math.radians(-55), 0, math.radians(200)), 220, (1.0, 0.9, 0.78)); rimL.visible_camera = False
# 大きさの手がかり：飯碗と箸（5人会議・3DCG）
bowl = lathe("bowl", [(0, 0), (2.4, 0), (2.6, 0.6), (5.6, 4.6), (6.0, 6.2), (5.6, 6.2), (5.2, 4.8), (2.3, 1.2), (0, 1.1)], plain("bowl", "#F1EDE6", 0.12, coat=0.3), close=True)
bowl.location = (0.34, -0.16, -0.055)
for dx in (0, 0.012): box(f"hashi{dx}", (0.21, 0.006, 0.006), (0.33 + dx, -0.27, -0.052), plain("hashi", "#2B1E16", 0.4), bevel=0.002, rot=(0, 0, math.radians(8)))
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = srgb("#B9AE9E"); w.node_tree.nodes["Background"].inputs[1].default_value = 0.12

# ---------- 描く設定：AgX・被写界深度・動きのぶれ・種の固定 ----------
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = A.samples; sc.cycles.use_denoising = True; sc.cycles.seed = 7
sc.cycles.max_bounces = 8; sc.cycles.glossy_bounces = 4; sc.cycles.transparent_max_bounces = 12
sc.render.resolution_x = int(1080 * A.res); sc.render.resolution_y = int(1920 * A.res); sc.render.resolution_percentage = 100
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"; sc.view_settings.exposure = -0.6
sc.render.image_settings.file_format = "JPEG"; sc.render.image_settings.quality = 92
sc.render.use_motion_blur = True; sc.render.motion_blur_shutter = 0.5
sc.render.fps = int(J["fps"])
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.sensor_width = 36; cam.data.dof.use_dof = True
vl = sc.view_layers[0]; vl.use_pass_object_index = True
# 商品の形（点検の重なり用）：物の番号 1 の所だけ白
sc.use_nodes = True; ct = sc.node_tree; ct.nodes.clear()
rl = ct.nodes.new("CompositorNodeRLayers"); co = ct.nodes.new("CompositorNodeComposite"); ct.links.new(rl.outputs["Image"], co.inputs["Image"])
idm = ct.nodes.new("CompositorNodeIDMask"); idm.index = 1; ct.links.new(rl.outputs["IndexOB"], idm.inputs["ID value"])
fo = ct.nodes.new("CompositorNodeOutputFile"); fo.base_path = A.dir; fo.format.file_format = "PNG"; fo.format.color_mode = "BW"; fo.file_slots[0].path = "m_"
ct.links.new(idm.outputs["Alpha"], fo.inputs[0])

# =====================================================================
# 時刻 → 場面の状態（カメラ・ふた・炎）。時刻の源は jobs.json（timing.json の写し）だけ
# =====================================================================
def look(pos, tgt, lens, focus=None, fstop=2.8, roll=0.0, near=0.10):
    # ピントは狙う点（鍋の軸）ではなく、手前の面（軸から約10cm＝鍋の半径）。軸に合わせると f/2.8 で全部ぼけた（3周目）
    cam.location = Vector(pos); d = Vector(tgt) - Vector(pos); q = d.to_track_quat("-Z", "Y"); cam.rotation_euler = q.to_euler()
    cam.rotation_euler.rotate_axis("Z", roll) if roll else None
    cam.data.lens = lens; cam.data.dof.focus_distance = focus if focus else max(0.05, d.length - near); cam.data.dof.aperture_fstop = fstop
def orbit(ang, r, h, tgt, lens, fstop=2.8):
    a = math.radians(ang); look((tgt[0] + r * math.sin(a), tgt[1] - r * math.cos(a), h), tgt, lens, fstop=fstop)
S = lambda k: SC[k]
def state(t):
    s1, s2, s3, s4, s5, s6, s7 = (S(f"S{i}") for i in range(1, 8))
    # 炎：着火で灯り、「止めて」で消え、締めで弱く灯り直す。揺らぎは正弦波の和（乱数なし）
    on = oc((t - EV["ignite"]) / 0.45) * (1 - ioc((t - EV["off"]) / 0.6)) + 0.75 * oc((t - (s7[0] + 0.3)) / 0.8)
    for k, f in enumerate(FL):
        fl = 1 + 0.18 * math.sin(t * 19 + k * 1.7) + 0.1 * math.sin(t * 31 + k * 0.6)
        f.scale = (max(0.01, on), max(0.01, on), max(0.01, on * fl)); f.hide_render = on < 0.02
    fl_light.data.energy = 6.0 * on
    # ふた：S4 で上ふたが上がり、少し遅れて中ふた（分解して二重を見せる）。S6 で上ふたが開く
    up = 0.0; inn = 0.0; tilt = 0.0
    if s4[0] <= t < s5[0]:
        up = 0.085 * spring(t - (s4[0] + 0.25), 0.9, 0.1); inn = 0.042 * spring(t - EV["futa"], 0.9, 0.1); tilt = 0.10 * spring(t - (s4[0] + 0.25), 1.1, 0.1)
    if s6[0] <= t < s7[0]:
        u = oc((t - (s6[0] + 0.15)) / 0.7); up = 0.28 * u; tilt = 0.5 * u
    lid.location = (0, -0.25 * tilt * 0.12, up); lid.rotation_euler = Euler((-tilt * 0.5, 0, 0)); inner.location = (0, 0, inn)
    # カメラ（場面ごと）
    # 構図：鍋はいつも画面の下半分（コンロと炎は下の端）、上は明るい壁＝字と金の線の置き場（5人会議3周目・字を鍋に載せない）
    #   狙う点を鍋の中心より LIFT だけ上に置く＝鍋が下へ下がる
    C = (0, 0, GZ + 0.095)
    up = lambda p, d: (p[0], p[1], p[2] + d)
    if t < s2[0]:   # S1：炎の高さから目の高さへクレーンで上がる（鍋は下半分のまま・着火は鍋の下に見える）
        u = ioc(t / (s2[0] - 0.1)); a = math.radians(lerp(-8, -16, u)); r = lerp(1.05, 1.15, u)
        look((r * math.sin(a), -r * math.cos(a), lerp(0.03, 0.22, u)), up(C, lerp(0.11, 0.10, u)), 85, fstop=lerp(2.4, 3.2, u))
    elif t < s3[0]:   # S2：目の高さでゆっくり回り込む（炎と釉薬の艶）
        u = ios((t - s2[0]) / (s3[0] - s2[0])); orbit(lerp(-16, 10, u), 1.15, GZ + 0.22, up(C, 0.10), 85, 3.2)
    elif t < s4[0]:   # S3：火が消え、少し上から蒸気の穴へ寄る
        u = ios((t - s3[0]) / (s4[0] - s3[0])); a = math.radians(lerp(22, 14, u)); r = lerp(1.10, 0.92, u)
        look((r * math.sin(a), -r * math.cos(a), lerp(0.46, 0.40, u)), (0, -0.03, GZ + 0.125 + 0.11), 85, fstop=3.2, near=0.06)
    elif t < s5[0]:   # S4：少し上から回り込み、上ふた・中ふたが分かれて浮く
        u = ios((t - s4[0]) / (s5[0] - s4[0])); orbit(lerp(-34, -14, u), 1.45, GZ + 0.62, (0, 0, GZ + 0.15 + 0.13), 70, 4.5)
    elif t < s6[0]:   # S5：低い所から少し見上げ、素焼きの帯を大きく（横から低い光が粒を浮かせる）。寄りすぎると被写界深度が1mm になり何も写らなかった（5人会議2・3周目）
        u = ios((t - s5[0]) / (s6[0] - s5[0])); a = math.radians(lerp(-34, -20, u)); r = lerp(0.80, 0.72, u)
        look((r * math.sin(a), -r * math.cos(a), GZ + 0.035), (0, 0, GZ + 0.13), 85, fstop=2.8)
    elif t < s7[0]:   # S6：上ふたが開く所を上から
        u = ioc((t - s6[0]) / 0.9); look((0, lerp(-0.71, -0.51, u), lerp(0.68, 0.82, u)), (0, 0, GZ + 0.11), 85, fstop=3.6, near=0.07)
    else:   # S7：締め。炎が弱く灯り、ゆっくり回る
        u = ios((t - s7[0]) / (J["end"] - s7[0])); orbit(lerp(-24, 18, u), 1.15, GZ + 0.24, up(C, 0.10), 85, 3.2)

# 画面の点（引き出し線・湯気の起点）：絵と同じカメラで写す
PTS = {"hole": lambda: hole.matrix_world.translation, "lid": lambda: lid.matrix_world @ Vector((0.05, -0.07, 0.15)),
       "inner": lambda: inner.matrix_world @ Vector((0.06, -0.05, 0.1102)), "clay": lambda: Vector((0.0, -0.112, GZ + 0.02)), "center": lambda: Vector((0, 0, GZ + 0.09))}
POT = [o for o in sc.objects if o.pass_index == 1]
def proj():
    bpy.context.view_layer.update(); out = {}
    for k, f in PTS.items():
        v = world_to_camera_view(sc, cam, f()); out[k] = [round(v.x * 1080, 2), round((1 - v.y) * 1920, 2), round(v.z, 4)]
    xs, ys = [], []   # 鍋の画面の箱（物の箱の角を写す・字を鍋に載せないため）
    for o in POT:
        for c in o.bound_box:
            v = world_to_camera_view(sc, cam, o.matrix_world @ Vector(c))
            if v.z > 0: xs.append(v.x * 1080); ys.append((1 - v.y) * 1920)
    out["box"] = [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))] if xs else None
    return out

k, n = map(int, A.shard.split("/")); only = {int(x) for x in A.only.split(",") if x}
for fr in J["frames"]:
    i, t = fr["i"], fr["t"]
    if (only and i not in only) or (not only and i % n != k): continue
    if A.proj_only:
        state(t); allp = locals().setdefault("ALLP", {}); allp[i] = proj(); continue
    # 動きのぶれ：Blender は前後のコマの位置から計算する＝その前後の時刻でも状態を置いてキーにする
    for dt, f in ((-0.5 / J["fps"], -1), (0.0, 0), (0.5 / J["fps"], 1)):
        state(t + dt)
        for ob in [cam, lid, inner] + FL: ob.keyframe_insert("location", frame=100 + f); ob.keyframe_insert("rotation_euler", frame=100 + f); ob.keyframe_insert("scale", frame=100 + f)
        cam.data.keyframe_insert("lens", frame=100 + f)
    sc.frame_set(100); state(t)
    fo.file_slots[0].path = f"m_{i:04d}_"; sc.render.filepath = os.path.join(A.dir, f"k_{i:04d}.jpg")
    bpy.ops.render.render(write_still=True)
    m = [x for x in os.listdir(A.dir) if x.startswith(f"m_{i:04d}_")]
    if m: os.replace(os.path.join(A.dir, m[0]), os.path.join(A.dir, f"m_{i:04d}.png"))
    json.dump(proj(), open(os.path.join(A.dir, f"p_{i:04d}.json"), "w"))
    for ob in [cam, lid, inner] + FL: ob.animation_data_clear()
    cam.data.animation_data_clear()
    print("wrote", i, round(t, 3), flush=True)

if A.proj_only: json.dump(ALLP, open(os.path.join(A.dir, "proj_all.json"), "w")); print("proj", len(ALLP))
