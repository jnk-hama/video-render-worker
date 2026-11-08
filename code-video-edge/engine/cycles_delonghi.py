# cycles_delonghi.py — デロンギ オイルヒーター（H771015EFSN-BK）を 3DCG で描く（Blender 4.2 Cycles・#366 の例外）
#   5人会議 works/delonghi-oil/MEETING.md：夕方の居間（窓の外は冬の青い夕方・室内は暖かい光）／白いフィンは横の低い光で縞を出す／
#   熱の色（サーモグラフィ風）を別の描き方で描き、型（heat3d.html）が本体から広がる輪で切り替える
#   ★#068 の例外の4条件：形・寸法・色は販売ページに合わせる（幅245・奥行490・高さ630mm・ホワイト+ブラック・フィン10枚・asp0/9/10/11）／
#     画面に「※3DCG」／性能を描き足さない（熱の色は「イメージ」と画面に書く）／送る前に目で見る
#   ★「15ヶ所の穴」は1枚あたりか全体かが本文で確かめられない＝写真（asp9）に見える上の長穴だけを作り、数を絵で言わない
#   ★販売ページの写真は使わない（材質は手続きで作る）＝公開リポジトリの Actions で描いてよい
#   使い方：python cycles_delonghi.py --jobs jobs.json --dir out/ [--shard k/N] [--samples 48] [--res 1.0] [--only 0,30,60] [--proj-only]
#     jobs.json＝{fps, end, events{名前: 秒}, scenes{S1: [t0, t1]…}, frames[{i, t, th}]}（heat3d.html の CYCLES_JOBS が出す）
#     出力：k_####.jpg（絵）・t_####.jpg（熱の色・th のコマだけ）・m_####.png（商品の形）・p_####.json（画面の点と本体の箱）
#   乱数は使わない（ノイズの種も固定）＝同じ jobs なら同じ絵
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
def plain(name, color, rough=0.5, metal=0.0, coat=0.0, emission=None, estr=0.0, transmission=0.0, sheen=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(color); p.inputs["Roughness"].default_value = rough; p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat; p.inputs["Transmission Weight"].default_value = transmission; p.inputs["Sheen Weight"].default_value = sheen
    if emission: p.inputs["Emission Color"].default_value = srgb(emission); p.inputs["Emission Strength"].default_value = estr
    return m
def textured(name, c0, c1, scale, rough, bump=0.15, stretch=(1, 1, 1), brick=None):
    """色むら（ノイズ）＋細かな凹凸。brick＝(幅, 高さ, 目地の色) で床板"""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; p = nt.nodes["Principled BSDF"]
    tc = node(nt, "ShaderNodeTexCoord"); mp = node(nt, "ShaderNodeMapping"); mp.inputs["Scale"].default_value = stretch; nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nz = node(nt, "ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = scale; nz.inputs["Detail"].default_value = 8; nz.inputs["Distortion"].default_value = 1.2; nt.links.new(mp.outputs[0], nz.inputs["Vector"])
    cr = node(nt, "ShaderNodeValToRGB"); cr.color_ramp.elements[0].color = srgb(c0); cr.color_ramp.elements[1].color = srgb(c1); nt.links.new(nz.outputs["Fac"], cr.inputs[0])
    col = cr.outputs[0]
    if brick:
        br = node(nt, "ShaderNodeTexBrick"); br.inputs["Scale"].default_value = 1.0; br.inputs["Brick Width"].default_value = brick[0]; br.inputs["Row Height"].default_value = brick[1]
        br.inputs["Mortar Size"].default_value = 0.002; br.inputs["Mortar"].default_value = srgb(brick[2]); br.inputs["Color1"].default_value = (1, 1, 1, 1); br.inputs["Color2"].default_value = (0.9, 0.88, 0.86, 1)
        nt.links.new(tc.outputs["Object"], br.inputs["Vector"])
        mu = node(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY"); mu.inputs["Factor"].default_value = 1.0
        nt.links.new(col, mu.inputs[6]); nt.links.new(br.outputs["Color"], mu.inputs[7]); col = mu.outputs[2]
    nt.links.new(col, p.inputs["Base Color"]); p.inputs["Roughness"].default_value = rough
    bm = node(nt, "ShaderNodeBump"); bm.inputs["Strength"].default_value = bump; bm.inputs["Distance"].default_value = 0.002; nt.links.new(nz.outputs["Fac"], bm.inputs["Height"]); nt.links.new(bm.outputs["Normal"], p.inputs["Normal"])
    return m
def sky():
    """窓の外：冬の青い夕方（上が深い青・地平に少しの橙）。部屋を照らさない（窓の光は別の面光源）"""
    m = bpy.data.materials.new("sky"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, "ShaderNodeOutputMaterial"); tc = node(nt, "ShaderNodeTexCoord"); sep = node(nt, "ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    cr = node(nt, "ShaderNodeValToRGB"); e = cr.color_ramp.elements
    e[0].position = 0.0; e[0].color = srgb("#C98F6A"); e[1].position = 1.0; e[1].color = srgb("#22386E")
    mid = e.new(0.22); mid.color = srgb("#7F93BE"); mid2 = e.new(0.55); mid2.color = srgb("#3D5895")
    nt.links.new(sep.outputs["Z"], cr.inputs[0])
    em = node(nt, "ShaderNodeEmission"); em.inputs["Strength"].default_value = 1.6; nt.links.new(cr.outputs[0], em.inputs["Color"]); nt.links.new(em.outputs[0], out.inputs["Surface"])
    return m

M_WHITE = plain("paint", "#ECEBE7", 0.35, coat=0.18)   # 白は真っ白にしない（5人会議・3DCG）。粉体塗装の艶
M_DARK = plain("panel", "#2A2421", 0.32, coat=0.35)    # 前の板（黒に近い焦げ茶・asp0）
M_RED = plain("knob", "#A8231D", 0.3, coat=0.4)
M_PIN = plain("pin", "#E2553B", 0.45)                   # タイマーの赤いピン（asp10）
M_BLACK = plain("black", "#1B1A19", 0.5)
M_HOLE = plain("hole", "#0B0B0B", 0.95)
M_GREY = plain("grey", "#BDBAB4", 0.4)

# =====================================================================
# 形（単位 m）。外形 幅245（Y・キャスター込み）×奥行490（X・キャスター込み）×高さ630mm。フィン10枚（asp0）
# =====================================================================
NF, PITCH = 10, 0.040
FW, FZ0, FZ1 = 0.150, 0.085, 0.630      # フィンの幅（Y）・下端・上端
FZC, FH = (FZ0 + FZ1) / 2, FZ1 - FZ0
heater = bpy.data.objects.new("heater", None); sc.collection.objects.link(heater)
PARTS = []
def own(ob, parent=heater, idx=1):
    ob.parent = parent; ob.pass_index = idx; PARTS.append(ob); return ob
def rrect(w, h, rt, rb, n=8):
    """角の丸い長方形（YZ）。上の角は大きく丸い（asp0：フィンの上が丸い）"""
    pts = []
    for cy_, cz_, r, a0 in ((w / 2 - rt, h / 2 - rt, rt, 0), (-w / 2 + rt, h / 2 - rt, rt, 90), (-w / 2 + rb, -h / 2 + rb, rb, 180), (w / 2 - rb, -h / 2 + rb, rb, 270)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n); pts.append((cy_ + r * math.cos(a), cz_ + r * math.sin(a)))
    return pts
def slab(name, pts, thick, mat, bevel=0.0):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new((-thick / 2, y, z)) for y, z in pts]; f = bm.faces.new(vs)
    ex = bmesh.ops.extrude_face_region(bm, geom=[f]); bmesh.ops.translate(bm, vec=(thick, 0, 0), verts=[v for v in ex["geom"] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); ob.data.materials.append(mat)
    if bevel: md = ob.modifiers.new("bv", "BEVEL"); md.width = bevel; md.segments = 4; md.limit_method = "ANGLE"
    for p in ob.data.polygons: p.use_smooth = True
    return ob
def tube(name, pts, rad, mat):
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = rad; cu.bevel_resolution = 4; cu.fill_mode = "FULL"
    sp = cu.splines.new("POLY"); sp.points.add(len(pts) - 1)
    for i, (x, y, z) in enumerate(pts): sp.points[i].co = (x, y, z, 1)
    sp.use_cyclic_u = True; sp.use_smooth = True
    ob = bpy.data.objects.new(name, cu); sc.collection.objects.link(ob); ob.data.materials.append(mat); return ob
def box(name, size, loc, mat, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot); ob = bpy.context.object; ob.name = name; ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel: md = ob.modifiers.new("bv", "BEVEL"); md.width = bevel; md.segments = 5
    ob.data.materials.append(mat); return ob
def cyl(name, r, h, loc, mat, rot=(0, 0, 0), verts=48):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, rotation=rot, vertices=verts); ob = bpy.context.object; ob.name = name; ob.data.materials.append(mat)
    for p in ob.data.polygons: p.use_smooth = True
    return ob

# ---------- フィン：薄い板＋縁の巻き込み（管の輪・本文「エッジを巻き込んだ形」）＋上の長穴（asp9）----------
X0 = -(NF - 1) * PITCH / 2
OUTER = rrect(FW, FH, 0.050, 0.030)
RIM = [(0, y * (FW - 0.024) / FW, FZC + (z) * (FH - 0.024) / FH) for y, z in OUTER]
fin0 = slab("fin0", [(y, FZC + z) for y, z in OUTER], 0.012, M_WHITE, bevel=0.003)
rim0 = tube("rim0", RIM, 0.0125, M_WHITE)
FINS = []
for i in range(NF):
    x = X0 + i * PITCH
    f = fin0 if i == 0 else fin0.copy(); r = rim0 if i == 0 else rim0.copy()
    if i: sc.collection.objects.link(f); sc.collection.objects.link(r)
    f.location = (x, 0, 0); r.location = (x, 0, 0); own(f); own(r); FINS.append(f)
    for s in (-1, 1):   # 上の長穴（両面）＝暗いくぼみ。数は絵で言わない
        h = box(f"slot{i}{s}", (0.003, 0.040, 0.009), (x + s * 0.0062, 0, FZ1 - 0.085), M_HOLE, bevel=0.004); own(h)   # 縁の管の影に入ると黒い三角に見えた（試し描き）＝平らな面の上へ
# 油の通り道（上と下の横の管）：フィンの間に見える
for z in (FZ0 + 0.035, FZ1 - 0.030):
    own(cyl(f"pipe{z:.2f}", 0.020, (NF - 1) * PITCH + 0.02, (0, 0, z), M_WHITE, rot=(0, math.radians(90), 0)))

# ---------- 前の板（-X の端）：白い端の板・焦げ茶の操作の板（赤いつまみ・切り替え）・タイマーの輪・下の黒い箱 ----------
XE = X0 - 0.034
own(slab("endcap", [(y, FZC + z) for y, z in rrect(FW + 0.006, FH + 0.004, 0.050, 0.030)], 0.040, M_WHITE, bevel=0.008)).location = (XE, 0, 0)
XF = XE - 0.020   # 端の板の外の面
panel = own(slab("panel", [(y, z) for y, z in rrect(0.104, 0.215, 0.030, 0.022)], 0.012, M_DARK, bevel=0.003)); panel.location = (XF - 0.004, 0, FZ1 - 0.14)
own(box("logo", (0.004, 0.058, 0.016), (XF - 0.011, 0, FZ1 - 0.058), M_GREY, bevel=0.003))
knob = own(cyl("knob", 0.017, 0.022, (XF - 0.019, 0, FZ1 - 0.122), M_RED, rot=(0, math.radians(90), 0)))
own(box("grip", (0.012, 0.006, 0.030), (XF - 0.032, 0, FZ1 - 0.122), M_RED, bevel=0.002))
for k, y in enumerate((-0.012, 0.012)):
    own(box(f"sw{k}", (0.010, 0.016, 0.026), (XF - 0.014, y, FZ1 - 0.192), M_BLACK, bevel=0.003))
TZ = FZ1 - 0.330   # タイマーの輪の中心（asp0：操作の板の下・白い面）
own(cyl("timer_ring", 0.044, 0.012, (XF - 0.004, 0, TZ), M_WHITE, rot=(0, math.radians(90), 0), verts=96))
dial = own(cyl("dial", 0.033, 0.012, (XF - 0.008, 0, TZ), plain("dial", "#F4F2EE", 0.3, coat=0.2), rot=(0, math.radians(90), 0), verts=96))
own(box("dlogo", (0.002, 0.026, 0.008), (XF - 0.0145, 0, TZ), M_GREY, bevel=0.002))
PINS = []
for k in range(96):   # 24時間×15分＝96本（本文「15分刻み」）
    a = 2 * math.pi * k / 96
    p = own(box(f"pin{k}", (0.006, 0.0016, 0.006), (0, 0, 0), M_PIN, bevel=0.0005)); p["a"] = a; PINS.append(p)
def set_pin(p, inward):   # 外側（OFF）r=29mm → 内側（ON）r=25.5mm（本文「ONはピンを内側に」）
    a = p["a"]; r = lerp(0.0295, 0.0255, inward); p.location = (XF - 0.015, r * math.cos(a), TZ + r * math.sin(a)); p.rotation_euler = Euler((a, 0, 0))
for p in PINS: set_pin(p, 0.0)
own(box("cordbox", (0.040, 0.100, 0.115), (XF - 0.004, 0, FZ0 + 0.075), M_DARK, bevel=0.012))
own(box("plug", (0.024, 0.040, 0.050), (XF - 0.030, 0.050, FZ0 + 0.040), M_WHITE, bevel=0.006))

# ---------- 足とキャスター（折りたたみ式・本文 290行）：前後に1本ずつ。開くと Y 方向に 245mm ----------
FEET = []
for k, x in enumerate((X0 + 0.5 * PITCH, X0 + (NF - 1.5) * PITCH)):
    pv = bpy.data.objects.new(f"foot{k}", None); sc.collection.objects.link(pv); pv.parent = heater; pv.location = (x, 0, 0.052)
    own(box(f"bar{k}", (0.026, 0.205, 0.018), (0, 0, 0), M_WHITE, bevel=0.006), pv)
    own(box(f"stem{k}", (0.020, 0.030, 0.040), (0, 0, 0.022), M_WHITE, bevel=0.005), pv)
    for s in (-1, 1):
        own(box(f"house{k}{s}", (0.030, 0.026, 0.026), (0, s * 0.098, -0.010), M_BLACK, bevel=0.007), pv)
        own(cyl(f"wheel{k}{s}", 0.021, 0.016, (0, s * 0.100, -0.031), M_BLACK, rot=(0, math.radians(90), 0)), pv)
    FEET.append(pv)
def set_feet(open_):   # 閉じる＝バーがフィンの並びに沿う（Z 90°）・開く＝横へ
    for pv in FEET: pv.rotation_euler = Euler((0, 0, math.radians(90 * (1 - open_))))
set_feet(1.0)
heater.rotation_euler = Euler((0, 0, math.radians(55)))   # 前の板（-X の端）を手前左へ（asp0 の見え方）。カメラは部屋の手前（-Y）

# =====================================================================
# 夕方の居間：オークの床・暖かい白の壁・窓（冬の青い夕方）・ソファ・ラグ・床のランプ
# =====================================================================
M_FLOOR = textured("floor", "#A57B52", "#C49A6C", 6, 0.42, 0.12, stretch=(1, 7, 1), brick=(1.2, 0.14, "#5E432C"))
box("floor", (8, 8, 0.02), (0, 1.0, -0.01), M_FLOOR)
M_WALL = textured("wall", "#E3D9CC", "#EDE5DA", 30, 0.9, 0.05)
WY = 1.55   # 奥の壁（本体から 1.5m 後ろ＝ぼけて、字の後ろは静かな面）
WX0, WX1, WZ0, WZ1 = 0.55, 1.75, 0.55, 2.15   # 窓（本体の右奥）
for nm, sz, lc in (("wl", (WX0 + 3.0, 0.12, 3.0), ((WX0 - 3.0) / 2, WY, 1.5)), ("wr", (2.0, 0.12, 3.0), (WX1 + 1.0, WY, 1.5)),
                   ("wb", (WX1 - WX0, 0.12, WZ0), ((WX0 + WX1) / 2, WY, WZ0 / 2)), ("wt", (WX1 - WX0, 0.12, 3.0 - WZ1), ((WX0 + WX1) / 2, WY, (WZ1 + 3.0) / 2))):
    box(nm, sz, lc, M_WALL)
box("lwall", (0.12, 6, 3.0), (-1.9, 0.5, 1.5), M_WALL)
M_FRAME = plain("frame", "#F1EEE9", 0.4)
for nm, sz, lc in (("mul_v", (0.035, 0.05, WZ1 - WZ0), ((WX0 + WX1) / 2, WY - 0.03, (WZ0 + WZ1) / 2)), ("mul_h", (WX1 - WX0, 0.05, 0.035), ((WX0 + WX1) / 2, WY - 0.03, 1.25)),
                   ("sill", (WX1 - WX0 + 0.1, 0.16, 0.035), ((WX0 + WX1) / 2, WY - 0.06, WZ0))):
    box(nm, sz, lc, M_FRAME)
skyp = box("sky", (WX1 - WX0 + 0.6, 0.01, WZ1 - WZ0 + 0.6), ((WX0 + WX1) / 2, WY + 0.4, (WZ0 + WZ1) / 2), sky()); skyp.visible_shadow = False
for k in range(4):   # 窓の外の木立（冬・葉の無い木の幹）＝奥行きの手がかり
    box(f"tree{k}", (0.04 + 0.01 * k, 0.04, 2.2), (WX0 + 0.2 + 0.32 * k, WY + 0.32, 1.0), plain(f"tr{k}", "#1E2433", 0.9)).visible_shadow = False
M_CURT = textured("curtain", "#D9CDBB", "#E6DCCC", 14, 0.85, 0.3, stretch=(30, 1, 1))
box("curtain", (0.32, 0.10, 2.5), (WX1 + 0.18, WY - 0.12, 1.25), M_CURT)
M_FAB = textured("fabric", "#9C8A76", "#AE9C86", 60, 0.95, 0.4)
box("sofa_base", (1.9, 0.85, 0.42), (-1.25, 1.05, 0.21), M_FAB, bevel=0.06)
box("sofa_back", (1.9, 0.22, 0.42), (-1.25, 1.38, 0.62), M_FAB, bevel=0.08)
box("sofa_arm", (0.22, 0.85, 0.24), (-0.36, 1.05, 0.54), M_FAB, bevel=0.07)
box("cushion", (0.42, 0.14, 0.38), (-0.75, 1.22, 0.62), textured("cush", "#B0573A", "#BE6646", 40, 0.95, 0.3), bevel=0.06, rot=(math.radians(-12), 0, math.radians(8)))
box("rug", (2.2, 1.6, 0.012), (-0.3, 0.55, 0.006), textured("rug", "#CFC3B1", "#D9CEBE", 120, 1.0, 0.5))
# 床のランプ（左奥・暖かい光の源として画面に見える）
cyl("lamp_pole", 0.012, 1.45, (-1.55, 1.25, 0.72), plain("brass", "#9A7B4F", 0.35, metal=1.0))
shade = cyl("lamp_shade", 0.19, 0.30, (-1.55, 1.25, 1.50), plain("shade", "#F3E6CF", 0.8, emission="#FFD9A0", estr=2.5, transmission=0.3), verts=64)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.2, location=(-0.95, 1.30, 0.62)); bpy.context.object.data.materials.append(plain("pot", "#5E6B55", 0.6))   # ソファの横の観葉の鉢（大きさの手がかり）

# ---------- 光：ランプ（暖）・窓（冷たい青）・天井の補い（暖）・横の低い光（フィンの縞）・縁の光 ----------
LIGHT = float(os.environ.get("DELONGHI_LIGHT", "0.10"))   # 全体の倍率。試し描きで測って決める（かまどさんは 0.07）
def area(name, size, loc, rot, energy, color, cam=False):
    l = bpy.data.lights.new(name, "AREA"); l.size = size[0]; l.size_y = size[1]; l.shape = "RECTANGLE"; l.energy = energy * LIGHT; l.color = color
    o = bpy.data.objects.new(name, l); o.location = loc; o.rotation_euler = Euler(rot); sc.collection.objects.link(o); o.visible_camera = cam; return o
def point(name, loc, energy, color, soft=0.15):
    l = bpy.data.lights.new(name, "POINT"); l.energy = energy * LIGHT; l.color = color; l.shadow_soft_size = soft
    o = bpy.data.objects.new(name, l); o.location = loc; sc.collection.objects.link(o); return o
point("lamp", (-1.55, 1.25, 1.45), 2600, (1.0, 0.66, 0.38), 0.18)   # 夕方の暖かい光の源（試し描き：部屋が白く平らで夕方に見えなかった）
area("window", (1.2, 1.6), ((WX0 + WX1) / 2, WY - 0.08, (WZ0 + WZ1) / 2), (math.radians(90), 0, math.radians(180)), 900, (0.55, 0.68, 1.0))
area("ceil", (2.0, 2.0), (-0.3, 0.2, 2.6), (0, 0, 0), 330, (1.0, 0.84, 0.66))
RAKE = area("rake", (0.30, 0.9), (0.95, -0.35, 0.38), (math.radians(90), 0, math.radians(70)), 1100, (1.0, 0.80, 0.58))   # 白いフィンは影で形が読める（5人会議・撮影）
area("rim", (0.6, 0.4), (0.3, 0.9, 1.1), (math.radians(-60), 0, math.radians(180)), 300, (0.62, 0.74, 1.0))
area("key", (0.9, 0.9), (-1.0, -1.2, 1.1), (math.radians(62), 0, math.radians(-40)), 420, (1.0, 0.88, 0.76))
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True; BG = w.node_tree.nodes["Background"]; BG.inputs[0].default_value = srgb("#4A5878"); BG.inputs[1].default_value = 0.10

# =====================================================================
# 熱の色（別の描き方）：全部の物の材質を、放射（Emission）の「熱の色」に置き換える（view layer の材質の上書き）
#   熱＝本体（物の番号 1）は H、部屋は「本体からの距離」で輪が広がる（R＝輪の半径・A＝輪の中の暖かさ・B＝部屋の底の暖かさ）
#   ★温度の測定ではない＝画面に「熱の色はイメージ（CG）」
# =====================================================================
def thermal_mat():
    m = bpy.data.materials.new("thermal"); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, "ShaderNodeOutputMaterial"); geo = node(nt, "ShaderNodeNewGeometry"); oi = node(nt, "ShaderNodeObjectInfo")
    V = {k: node(nt, "ShaderNodeValue", label=k) for k in ("R", "A", "B", "H")}
    hc = node(nt, "ShaderNodeCombineXYZ"); hc.inputs[0].default_value = 0.0; hc.inputs[1].default_value = 0.0; hc.inputs[2].default_value = FZC
    dist = node(nt, "ShaderNodeVectorMath", operation="DISTANCE"); nt.links.new(geo.outputs["Position"], dist.inputs[0]); nt.links.new(hc.outputs[0], dist.inputs[1])
    sub = node(nt, "ShaderNodeMath", operation="SUBTRACT"); nt.links.new(V["R"].outputs[0], sub.inputs[0]); nt.links.new(dist.outputs["Value"], sub.inputs[1])
    div = node(nt, "ShaderNodeMath", operation="DIVIDE", use_clamp=True); div.inputs[1].default_value = 2.4; nt.links.new(sub.outputs[0], div.inputs[0])   # 輪の縁をゆるやかに（1.1 では部屋が一色の赤になった）
    sm = node(nt, "ShaderNodeMath", operation="MULTIPLY"); nt.links.new(div.outputs[0], sm.inputs[0]); nt.links.new(V["A"].outputs[0], sm.inputs[1])
    room = node(nt, "ShaderNodeMath", operation="MAXIMUM"); nt.links.new(sm.outputs[0], room.inputs[0]); nt.links.new(V["B"].outputs[0], room.inputs[1])
    isH = node(nt, "ShaderNodeMath", operation="COMPARE"); isH.inputs[1].default_value = 1.0; isH.inputs[2].default_value = 0.1; nt.links.new(oi.outputs["Object Index"], isH.inputs[0])
    mix = node(nt, "ShaderNodeMix", data_type="FLOAT"); nt.links.new(isH.outputs[0], mix.inputs["Factor"]); nt.links.new(room.outputs[0], mix.inputs[2]); nt.links.new(V["H"].outputs[0], mix.inputs[3])
    cr = node(nt, "ShaderNodeValToRGB"); e = cr.color_ramp.elements   # 鉄の弓（ironbow）：黒紫→紫→赤→橙→黄→白
    e[0].position = 0.0; e[0].color = srgb("#0E0A33"); e[1].position = 1.0; e[1].color = srgb("#FFF6DA")
    for pos, col in ((0.18, "#2E1A7A"), (0.36, "#8A1C7C"), (0.52, "#D2343A"), (0.68, "#F2731E"), (0.84, "#FAC335")):
        x = e.new(pos); x.color = srgb(col)
    nt.links.new(mix.outputs[0], cr.inputs[0])
    lw = node(nt, "ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.35   # 形が読めるよう、面の向きで明るさを少し変える
    shd = node(nt, "ShaderNodeMath", operation="MULTIPLY_ADD"); shd.inputs[1].default_value = -0.45; shd.inputs[2].default_value = 1.0; nt.links.new(lw.outputs["Facing"], shd.inputs[0])
    em = node(nt, "ShaderNodeEmission"); nt.links.new(cr.outputs[0], em.inputs["Color"]); nt.links.new(shd.outputs[0], em.inputs["Strength"]); nt.links.new(em.outputs[0], out.inputs["Surface"])
    return m, V
M_TH, TV = thermal_mat()

# ---------- 描く設定 ----------
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = A.samples; sc.cycles.use_denoising = True; sc.cycles.seed = 7
sc.cycles.max_bounces = 8; sc.cycles.glossy_bounces = 4
sc.render.resolution_x = int(1080 * A.res); sc.render.resolution_y = int(1920 * A.res); sc.render.resolution_percentage = 100
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"; sc.view_settings.exposure = float(os.environ.get("DELONGHI_EXPOSURE", "-0.45"))
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
# 時刻 → 状態（カメラ・ピン・足・熱）。時刻の源は jobs.json（timing.json の写し）だけ
# =====================================================================
HC = Vector((0, 0, FZC))
def frame(pos, P, lens, sx=760, sy=1000, fstop=4.0, near=0.0, roll=0.0):
    """点 P が画面の (sx, sy) に来るようにカメラを向ける（字は左の列＝本体は右へ）。ピントは P から near 手前"""
    pos, P = Vector(pos), Vector(P); f = (P - pos).normalized(); r = f.cross(Vector((0, 0, 1))).normalized(); u = r.cross(f)
    tv = 18 / lens; th = tv * 1080 / 1920; dx = (sx - 540) / 540; dy = (sy - 960) / 960
    d = (f - r * dx * th + u * dy * tv).normalized()
    cam.location = pos; cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    if roll: cam.rotation_euler.rotate_axis("Z", roll)
    cam.data.lens = lens; cam.data.dof.focus_distance = max(0.05, (P - pos).length - near); cam.data.dof.aperture_fstop = fstop
def around(ang, r, h, P, lens, **kw):   # 部屋の手前（-Y）から本体を見る位置（ang＝右へ回る度）。1回目は -X から見て左の壁の外に出た（真っ黒）
    a = math.radians(ang); frame((P[0] + r * math.sin(a), P[1] - r * math.cos(a), h), P, lens, **kw)
def wpt(local): return heater.matrix_world @ Vector(local)
S = lambda k: SC[k]
def state(t):
    s1, s2, s3, s4, s5, s6, s7 = (S(f"S{i}") for i in range(1, 8))
    # タイマーのピン：「タイマー」で 8時〜12時（32本・15分ずつ）が順に内側へ（ON）。それ以外は外側
    for k, p in enumerate(PINS):
        on = 0.0
        if 32 <= k < 64: on = oc((t - (EV["timer"] - 0.2 + (k - 32) * 0.035)) / 0.12)
        set_pin(p, on if t >= s4[0] - 0.01 else 0.0)
    # 足：S5 の頭で閉じた形から「折りたたみ」で開く（それ以外は開いた形）
    set_feet(spring(t - (EV["fold"] - 0.25), 0.9, 0.1) if s5[0] <= t < s6[0] else 1.0)
    # 熱の色（熱のコマだけ使う）：本体が先に熱くなり、「部屋ごと」で輪が壁・床・天井へ。S2 は 8℃→20℃ の数え上げに合わせ底上げ
    h = 0.30 + 0.62 * oc((t - EV["heat"]) / 1.2)
    R = 0.25 + 0.9 * ioc((t - EV["heat"]) / 1.0) + 0.9 * ioc((t - (EV["hook2"] - 0.2)) / 1.6) + 2.2 * ioc((t - EV["sanjuu"]) / (EV["nijuu"] + 0.3 - EV["sanjuu"]))   # S1 は本体のまわり・S2 の数え上げで部屋全体へ
    g = ioc((t - EV["hachi"]) / (EV["nijuu"] - EV["hachi"]))
    TV["H"].outputs[0].default_value = h; TV["R"].outputs[0].default_value = R
    TV["A"].outputs[0].default_value = lerp(0.62, 0.74, g); TV["B"].outputs[0].default_value = lerp(0.08, 0.40, g)
    # カメラ（主はゆっくりの横移動。回り込みはかまどさんで使ったので減らす・5人会議）
    if t < s2[0]:   # S1：目の高さより少し低く、本体の正面斜めをゆっくり横へ（右の本体・左は字の列）
        u = ios(t / s2[0]); around(lerp(-12, -4, u), 2.05, 0.62, (0.0, 0.0, 0.36), 50, sx=770, sy=1080, fstop=4.0, near=0.12)
    elif t < s3[0]:   # S2：引いて部屋を見せる（熱が壁・床・天井へ届く）。高い位置から横へ
        u = ios((t - s2[0]) / (s3[0] - s2[0])); around(lerp(-2, 8, u), 3.4, 1.15, (0.25, 0.25, 0.55), 35, sx=800, sy=960, fstop=5.6, near=0.0)   # 本体は左の字の列（x<440）に入れない
    elif t < s4[0]:   # S3：前の端の斜め上から、フィンの並びに沿って見る（縞と上の長穴）。並びは右奥へ消える＝左の字の列に本体を入れない
        u = ios((t - s3[0]) / (s4[0] - s3[0])); P = wpt((X0 + 0.02, 0, FZ1 - 0.12))   # 寄りすぎてフィンが左の列を埋めた（試し描き）＝斜め上から、前の端が x≈470
        frame(wpt((X0 + lerp(-0.03, -0.07, u), -0.80, FZ1 + 0.32)), P, 50, sx=780, sy=980, fstop=5.6, near=0.0)   # フィンの面が見える横寄り・並びは右へ続く
    elif t < s5[0]:   # S4：タイマーの輪へ寄る（ピンが順に内側へ）。端の面（幅15cm）が右に収まる距離
        u = ios((t - s4[0]) / (s5[0] - s4[0])); P = wpt((XF - 0.012, 0, TZ))
        frame(wpt((XF - lerp(0.74, 0.62, u), lerp(-0.22, -0.15, u), TZ + 0.05)), P, 50, sx=790, sy=1000, fstop=4.0, near=0.0)
    elif t < s6[0]:   # S5：床の高さから前の足（キャスターが開く）
        u = ios((t - s5[0]) / (s6[0] - s5[0])); P = wpt((X0 + 0.5 * PITCH, 0, 0.03))   # 足の開き（Z の回り）は斜め上から見ると分かる。床の高さからでは足が下に小さく写った（試し描き）
        frame(wpt((X0 + lerp(0.06, 0.12, u), lerp(-0.80, -0.74, u), 0.32)), P, 50, sx=800, sy=1150, fstop=4.0, near=0.0)   # 横（フィンの面の側）から：開くと足が手前へ向く。前からだと黒い箱が足を隠した
    elif t < s7[0]:   # S6：中くらいに引く（暖まった居間・評価）
        u = ios((t - s6[0]) / (s7[0] - s6[0])); around(lerp(-20, -12, u), 2.3, 0.85, (0.0, 0.0, 0.34), 50, sx=780, sy=1120, fstop=4.0, near=0.1)
    else:   # S7：締め。ゆっくり押し込む
        u = ios((t - s7[0]) / (J["end"] - s7[0])); around(lerp(-6, 2, u), lerp(2.3, 2.0, u), 0.70, (0.0, 0.0, 0.36), 50, sx=770, sy=1080, fstop=4.0, near=0.12)

PTS = {"center": lambda: heater.matrix_world @ Vector((0, 0, FZC)), "fin": lambda: wpt((X0 + 3 * PITCH, 0, FZ1 - 0.085)),
       "top": lambda: wpt((X0 + 3 * PITCH, 0, FZ1)), "timer": lambda: wpt((XF - 0.012, 0, TZ)), "knob": lambda: wpt((XF - 0.03, 0, FZ1 - 0.122)),
       "caster": lambda: FEET[0].matrix_world @ Vector((0, -0.100, -0.031)), "floor": lambda: heater.matrix_world @ Vector((0, 0, 0))}
def proj():
    bpy.context.view_layer.update(); out = {}
    for k, f in PTS.items():
        v = world_to_camera_view(sc, cam, f()); out[k] = [round(v.x * 1080, 2), round((1 - v.y) * 1920, 2), round(v.z, 4)]
    xs, ys = [], []
    for o in PARTS:
        for c in o.bound_box:
            v = world_to_camera_view(sc, cam, o.matrix_world @ Vector(c))
            if v.z > 0: xs.append(v.x * 1080); ys.append((1 - v.y) * 1920)
    out["box"] = [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))] if xs else None
    return out

ANIM = lambda: [cam] + PINS + FEET
def render(path, thermal):
    vl.material_override = M_TH if thermal else None; fo.mute = thermal
    sc.cycles.max_bounces = 0 if thermal else 8; sc.cycles.samples = 8 if thermal else A.samples
    BG.inputs[1].default_value = 0.0 if thermal else 0.10
    # 熱の色は色の変換（AgX）をかけない＝色の表のとおり。AgX のままだと本体の黄が薄いベージュになった（試し描き）
    sc.view_settings.view_transform = "Standard" if thermal else "AgX"; sc.view_settings.look = "None" if thermal else "AgX - Medium High Contrast"
    sc.view_settings.exposure = 0.0 if thermal else float(os.environ.get("DELONGHI_EXPOSURE", "-0.45"))
    sc.render.filepath = path; bpy.ops.render.render(write_still=True)

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
    fo.file_slots[0].path = f"m_{i:04d}_"
    render(os.path.join(A.dir, f"k_{i:04d}.jpg"), False)
    m = [x for x in os.listdir(A.dir) if x.startswith(f"m_{i:04d}_")]
    if m: os.replace(os.path.join(A.dir, m[0]), os.path.join(A.dir, f"m_{i:04d}.png"))
    if fr.get("th"): render(os.path.join(A.dir, f"t_{i:04d}.jpg"), True)
    json.dump(proj(), open(os.path.join(A.dir, f"p_{i:04d}.json"), "w"))
    for ob in ANIM(): ob.animation_data_clear()
    cam.data.animation_data_clear()
    print("wrote", i, round(t, 3), flush=True)

if A.proj_only: json.dump(ALLP, open(os.path.join(A.dir, "proj_all.json"), "w")); print("proj", len(ALLP))
