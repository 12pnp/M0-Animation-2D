# Redraws the Godot editor icons the editor uses (Godot 4.7.2-stable, commit
# ed1daf0bf001b61586d9930840f2f1394092c079, editor/icons/, MIT) as Lucide-style outlines: one
# path, viewBox 0 0 24 24, a 2px currentColor stroke (E4-PLAN step 13a). Each drawing is made
# after the original named in its comment; public/vendor/icons/godot/MANIFEST.md lists them.
# Run: python3 scripts/godot-icons.py public/vendor/icons/godot
import math, os, sys
out = sys.argv[1]
f = lambda v: ('%.2f' % v).rstrip('0').rstrip('.') if abs(v) > 1e-9 else '0'
def circle(x, y, r): return f'M{f(x-r)} {f(y)}a{f(r)} {f(r)} 0 1 0 {f(2*r)} 0a{f(r)} {f(r)} 0 1 0 {f(-2*r)} 0'
def seg(a, b, ra=0, rb=0):
    dx, dy = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dy); ux, uy = dx/l, dy/l
    return f'M{f(a[0]+ux*ra)} {f(a[1]+uy*ra)}L{f(b[0]-ux*rb)} {f(b[1]-uy*rb)}'
def head(tip, dirx, diry, size=3.5, spread=math.radians(40)):
    l = math.hypot(dirx, diry); dx, dy = dirx/l, diry/l; a = math.atan2(dy, dx)
    p = lambda s: (tip[0] - size*math.cos(a+s), tip[1] - size*math.sin(a+s))
    p1, p2 = p(spread), p(-spread)
    return f'M{f(p1[0])} {f(p1[1])}L{f(tip[0])} {f(tip[1])}L{f(p2[0])} {f(p2[1])}'
icons = {}
# ChainIK3D: two bones in a chain, root to tip.
A, B, C = (5, 19), (9, 9), (19, 5)
icons['constraint-ik'] = circle(*A, 2) + circle(*B, 2) + circle(*C, 2) + seg(A, B, 2, 2) + seg(B, C, 2, 2)
# RemoteTransform2D: an arc over a ring standing on a half-disc.
icons['constraint-transform'] = 'M4 10a8 8 0 0 1 16 0' + circle(12, 12.5, 2) + 'M7 21a5 5 0 0 1 10 0z'
# PathFollow2D: a curve from its start point to an arrow.
icons['constraint-path'] = circle(5, 19, 2) + 'M6.41 17.59C9 15 7.5 11.5 12 11.5S15.5 7.5 19 4' + head((19, 4), 1, -1.1)
# SpringBoneSimulator3D: a bone between two swings.
P, Q = (8.5, 15.5), (15.5, 8.5)
icons['constraint-physics'] = circle(*P, 2) + circle(*Q, 2) + seg(P, Q, 2, 2) + 'M3 12a9 9 0 0 1 9-9M21 12a9 9 0 0 1-9 9'
# HSlider: a track with its knob, ticks above.
icons['constraint-slider'] = 'M3 16h5' + circle(10, 16, 2) + 'M12 16h9M4 6v3M12 6v3M20 6v3'
# MeshInstance2D: a quad with its vertices and one diagonal.
V = [(5, 5), (19, 5), (19, 19), (5, 19)]
icons['mesh'] = ''.join(circle(*v, 2) for v in V) + ''.join(seg(V[i], V[(i+1) % 4], 2, 2) for i in range(4)) + seg(V[0], V[2], 2, 2)
# CollisionPolygon2D: a notched polygon outline.
icons['bounding-box'] = 'M3 3h18l-9 9 9 9H3z'
# KeyTrackPosition: a point with four arrowheads.
icons['key-translate'] = circle(12, 12, 2) + 'M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3'
# KeyTrackRotation: a point inside a turning arrow.
a0, a1, r = math.radians(-60), math.radians(240), 8
s0 = (12 + r*math.cos(a0), 12 + r*math.sin(a0)); s1 = (12 + r*math.cos(a1), 12 + r*math.sin(a1))
# (arc from 300° clockwise to 240°: the tangent at the end, clockwise in y-down, is (-sin, cos))
icons['key-rotate'] = circle(12, 12, 2) + f'M{f(s0[0])} {f(s0[1])}A8 8 0 1 1 {f(s1[0])} {f(s1[1])}' + head(s1, -math.sin(a1), math.cos(a1))
# KeyTrackScale: a point with two arrows outward.
icons['key-scale'] = circle(12, 12, 2) + seg((12, 12), (20, 4), 2.8, 0) + 'M15 4h5v5' + seg((12, 12), (4, 20), 2.8, 0) + 'M4 15v5h5'
# KeyTrackBlendShape: a round and a square bracket.
icons['key-deform'] = 'M9 4H8a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h1M15 4h5v16h-5'
# The curves (CurveLinear, CurveConstant as a step, CurveIn, CurveOut, CurveInOut).
icons['curve-linear'] = 'M4 20L20 4'
icons['curve-stepped'] = 'M4 18h8V6h8'
icons['curve-ease-in'] = 'M4 20Q20 20 20 4'
icons['curve-ease-out'] = 'M4 20Q4 4 20 4'
icons['curve-ease-in-out'] = 'M4 20C14 20 10 4 20 4'
os.makedirs(out, exist_ok=True)
for name, d in icons.items():
    open(f'{out}/{name}.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="{d}"/></svg>\n')
print(len(icons))
