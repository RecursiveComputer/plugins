"""Blockout of a set from its layout spec: the spatial source of truth for every plate and move.

  blender -b --python blockout.py -- LAYOUT.json CAMERA OUT_DIR [--pano 4096] [--persp 1920x1080]

LAYOUT.json (metres; x east, y north, z up) lists boxes (ground, wall, led, roof, column,
furniture), trees (trunk + canopy ellipsoid), the sun, and named cameras {at, look, hfov_deg}.
Writes, for CAMERA:
  pano-clay.png      equirectangular 2:1 clay render (the structure a generator must follow)
  pano-dist.exr      per-pixel distance from the camera along each ray (metres)
  pano-id.png        per-pixel object kind (see KINDS) for masks and checks
  persp-clay.png     the camera's perspective view (the structure a hero plate must follow)
  persp-dist.exr     its per-pixel depth (Cycles Z: distance along the view axis) and persp-index.exr
  camera.json        position, look-at and FOV, in the same frame
Everything is plain geometry; generators only paint it.
"""
import bpy, json, math, os, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
layout_path, cam_name, out = argv[0], argv[1], argv[2]
pano_w = int(argv[argv.index('--pano') + 1]) if '--pano' in argv else 4096
persp = argv[argv.index('--persp') + 1] if '--persp' in argv else '1920x1080'
os.makedirs(out, exist_ok=True)
L = json.load(open(layout_path))
KINDS = {'sky': 0, 'ground': 1, 'wall': 2, 'led': 3, 'roof': 4, 'column': 5, 'furniture': 6, 'trunk': 7, 'canopy': 8}
CLAY = {'ground': (0.62, 0.58, 0.52), 'wall': (0.72, 0.56, 0.40), 'led': (1, 1, 1), 'roof': (0.8, 0.8, 0.78),
        'column': (0.2, 0.2, 0.2), 'furniture': (0.55, 0.42, 0.3), 'trunk': (0.25, 0.18, 0.12), 'canopy': (0.45, 0.55, 0.25)}

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 32
sc.cycles.use_denoising = True
sc.view_settings.view_transform = 'Standard'


def material(kind):
    m = bpy.data.materials.new(kind); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*CLAY[kind], 1)
    if kind == 'led':
        b.inputs['Emission'].default_value = (1, 1, 1, 1)
        b.inputs['Emission Strength'].default_value = 0.9
    b.inputs['Roughness'].default_value = 0.9
    return m


MATS = {k: material(k) for k in CLAY}


def tag(obj, kind):
    obj.pass_index = KINDS[kind]
    obj.data.materials.append(MATS[kind])


for bx in L['boxes']:
    mn, mx = Vector(bx['min']), Vector(bx['max'])
    bpy.ops.mesh.primitive_cube_add(size=1, location=(mn + mx) / 2)
    o = bpy.context.object; o.scale = mx - mn; o.name = bx['id']; tag(o, bx['kind'])
for t in L.get('trees', []):
    x, y = t['at']
    bpy.ops.mesh.primitive_cylinder_add(radius=t['trunk_radius'], depth=t['trunk_height'], location=(x, y, t['trunk_height'] / 2))
    tag(bpy.context.object, 'trunk')
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(x, y, t['trunk_height'] + t['canopy_height'] * 0.35))
    c = bpy.context.object; c.scale = (t['canopy_radius'], t['canopy_radius'], t['canopy_height'] / 2); tag(c, 'canopy')

# Sun and sky.
s = L['sun']; az, el = math.radians(s['azimuth_deg']), math.radians(s['elevation_deg'])
bpy.ops.object.light_add(type='SUN')
sun = bpy.context.object; sun.data.energy = s.get('strength', 4.0); sun.data.angle = math.radians(1.0)
d = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))  # direction TO the sun
sun.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
world = bpy.data.worlds.new('sky'); sc.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.7, 0.9, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8

# Camera.
C = L['cameras'][cam_name]
bpy.ops.object.camera_add(location=C['at'])
cam = bpy.context.object; sc.camera = cam
look = Vector(C['look']) - Vector(C['at'])
cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler()

# Passes: distance (Z is ray length for panoramic cameras in Cycles) and object index.
vl = sc.view_layers[0]; vl.use_pass_z = True; vl.use_pass_object_index = True
sc.use_nodes = True
nt = sc.node_tree; nt.nodes.clear()
rl = nt.nodes.new('CompositorNodeRLayers')
comp = nt.nodes.new('CompositorNodeComposite'); nt.links.new(rl.outputs['Image'], comp.inputs['Image'])
fo = nt.nodes.new('CompositorNodeOutputFile'); fo.base_path = out
fo.format.file_format = 'OPEN_EXR'; fo.format.color_depth = '32'
fo.file_slots.clear(); fo.file_slots.new('dist'); fo.file_slots.new('index')
nt.links.new(rl.outputs['Depth'], fo.inputs['dist']); nt.links.new(rl.outputs['IndexOB'], fo.inputs['index'])

# 1) Equirectangular panorama.
cam.data.type = 'PANO'
try:
    cam.data.panorama_type = 'EQUIRECTANGULAR'
except Exception:
    cam.data.cycles.panorama_type = 'EQUIRECTANGULAR'
sc.render.resolution_x, sc.render.resolution_y = pano_w, pano_w // 2
sc.render.filepath = os.path.join(out, 'pano-clay.png')
bpy.ops.render.render(write_still=True)
for f in os.listdir(out):
    if f.startswith('dist') and f.endswith('.exr'): os.replace(os.path.join(out, f), os.path.join(out, 'pano-dist.exr'))
    if f.startswith('index') and f.endswith('.exr'): os.replace(os.path.join(out, f), os.path.join(out, 'pano-index.exr'))

# 2) Perspective view from the same camera.
cam.data.type = 'PERSP'
w, h = (int(v) for v in persp.split('x'))
sc.render.resolution_x, sc.render.resolution_y = w, h
cam.data.sensor_fit = 'HORIZONTAL'; cam.data.angle = math.radians(C.get('hfov_deg', 60))
sc.render.filepath = os.path.join(out, 'persp-clay.png')
bpy.ops.render.render(write_still=True)
for f in os.listdir(out):
    if f.startswith('dist') and f.endswith('.exr'): os.replace(os.path.join(out, f), os.path.join(out, 'persp-dist.exr'))
    if f.startswith('index') and f.endswith('.exr'): os.replace(os.path.join(out, f), os.path.join(out, 'persp-index.exr'))
json.dump({'name': cam_name, 'at': C['at'], 'look': C['look'], 'hfov_deg': C.get('hfov_deg', 60), 'pano': [pano_w, pano_w // 2], 'kinds': KINDS},
          open(os.path.join(out, 'camera.json'), 'w'), indent=1)
print('blockout written to', out)
