#!/usr/bin/env python3
"""
Turns OpenStreetMap data for Tsim Sha Tsui into the Kowloon map (src/sim/kowloon-data.ts).

Map data (c) OpenStreetMap contributors, under the Open Database Licence
(https://www.openstreetmap.org/copyright). Fetched 2026-11-20 from the OSM API in 16 tiles:

  for la in 22.292 22.296 22.300 22.304; do for lo in 114.163 114.167 114.171 114.175; do
    curl -o t_${la}_${lo}.json "https://api.openstreetmap.org/api/0.6/map.json?bbox=$lo,$la,$(($lo+0.004)),$(($la+0.004))"
  done; done

Usage: osm2map.py <folder with t_*.json> <out.ts> [preview.png]

The real ground (1,400 m square, from 114.1642 E, 22.3043 N) is drawn 0.73 times its size onto
the 1,024 m game map, north up. Everything is rasterised at 1 m and then taken to the 4 m cells
by majority: the sea from the coastline, the park's lawns, woods, lakes and pools, every road at
its width (lanes x 3.3 m), the paths, and every building as one to a few rectangles with its
storeys. The client also gets the roads and paths as lines, to draw them smoothly.
"""
import glob, json, math, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC, OUT = sys.argv[1], sys.argv[2]
PREVIEW = sys.argv[3] if len(sys.argv) > 3 else None
LON0, LAT0, SPAN = 114.1642, 22.3043, 1400.0
K = 1024 / SPAN
MX, MY = 102990 * K, 110770 * K
N = 256
F = 1024  # fine raster, 1 m

nodes, ways, rels = {}, {}, {}
for f in sorted(glob.glob(SRC + '/t_*.json')):
    for e in json.load(open(f))['elements']:
        if e['type'] == 'node': nodes[e['id']] = (e['lat'], e['lon'], e.get('tags', {}))
        elif e['type'] == 'way': ways[e['id']] = (e['nodes'], e.get('tags', {}))
        else: rels[e['id']] = (e['members'], e.get('tags', {}))

def P(n):
    la, lo, _ = nodes[n]
    return ((lo - LON0) * MX, (LAT0 - la) * MY)
def pts(nl): return [P(n) for n in nl if n in nodes]
def layer(t):
    try: return int(str(t.get('layer', '0')).split(';')[0])
    except ValueError: return 0
def name(t):
    n = t.get('name:en') or t.get('name') or ''
    return n
def inside(p, m=0): return -m <= p[0] < F + m and -m <= p[1] < F + m

def canvas(): 
    im = Image.new('L', (F, F), 0)
    return im, ImageDraw.Draw(im)
def polys(pred):
    """Closed outlines (outer, inner) of ways and multipolygons matching pred."""
    out = []
    for wid, (nl, t) in ways.items():
        if pred(t) and len(nl) > 3 and nl[0] == nl[-1]: out.append((pts(nl), False, t, wid))
    for rid, (mem, t) in rels.items():
        if pred(t) and t.get('type') == 'multipolygon':
            for m in mem:
                if m['type'] == 'way' and m['ref'] in ways and ways[m['ref']][0][0] == ways[m['ref']][0][-1]:
                    out.append((pts(ways[m['ref']][0]), m.get('role') == 'inner', t, m['ref']))
    return out
def fill(pred, grow=0):
    im, d = canvas()
    ps = polys(pred)
    for p, inner, _, _ in ps:
        if not inner and len(p) > 2: d.polygon(p, fill=255)
    for p, inner, _, _ in ps:
        if inner and len(p) > 2: d.polygon(p, fill=0)
    a = np.array(im) > 0
    return ndimage.binary_dilation(a, iterations=grow) if grow else a

# ---- the sea, from the coastline
im, d = canvas()
for wid, (nl, t) in ways.items():
    if t.get('natural') == 'coastline': d.line(pts(nl), fill=255, width=2)
for la, lo in [(22.2930, 114.1660), (22.2925, 114.1740), (22.2960, 114.1780), (22.2990, 114.1648)]:
    x, y = (lo - LON0) * MX, (LAT0 - la) * MY
    if 0 <= x < F and 0 <= y < F: ImageDraw.floodfill(im, (int(x), int(y)), 128)
a = np.array(im)
sea = (a == 128)
sea |= (a == 255) & ndimage.binary_dilation(sea, iterations=2)

# ---- ground
green = fill(lambda t: t.get('leisure') in ('park', 'garden', 'playground', 'pitch', 'track', 'common')
             or t.get('landuse') in ('grass', 'recreation_ground', 'village_green', 'flowerbed')
             or t.get('natural') in ('grassland', 'scrub'))
wood = fill(lambda t: t.get('natural') == 'wood' or t.get('landuse') == 'forest')
pond = fill(lambda t: (t.get('natural') == 'water' or t.get('leisure') == 'swimming_pool' and False)
            and t.get('water') != 'reflecting_pool' and layer(t) >= 0)
pool = fill(lambda t: t.get('leisure') == 'swimming_pool' and layer(t) >= 0 and t.get('indoor') != 'yes'
            and t.get('covered') != 'yes')
pitch = fill(lambda t: t.get('leisure') in ('pitch', 'track'))
earth = fill(lambda t: t.get('landuse') in ('construction', 'brownfield'))

# ---- roads, at their widths
ROAD = {'motorway': 3, 'trunk': 3, 'primary': 3, 'secondary': 3, 'tertiary': 2, 'unclassified': 2,
        'residential': 2, 'living_street': 1, 'service': 1, 'motorway_link': 1, 'trunk_link': 1,
        'primary_link': 1, 'secondary_link': 1, 'tertiary_link': 1}
MAIN = ('motorway', 'trunk', 'primary', 'secondary')
roads, paths = [], []
for wid, (nl, t) in ways.items():
    h = t.get('highway')
    if not h or t.get('area') == 'yes' or t.get('tunnel') not in (None, 'no') or t.get('bridge') or layer(t) != 0:
        continue
    if t.get('indoor') == 'yes' or t.get('level') not in (None, '0'): continue
    p = pts(nl)
    if len(p) < 2 or not any(inside(q, 20) for q in p): continue
    if h in ROAD:
        if h == 'service' and t.get('service') in ('parking_aisle', 'drive-through', 'emergency_access'): continue
        try: lanes = int(str(t.get('lanes', '')).split(';')[0])
        except ValueError: lanes = 1 if t.get('oneway') == 'yes' or h == 'service' else 2
        lanes = max(1, min(lanes, 6))
        if h == 'service': lanes = min(lanes, 2)
        roads.append(dict(p=p, w=lanes * 3.3 * K + 0.6, main=1 if h in MAIN else 0, lanes=lanes,
                          oneway=t.get('oneway') == 'yes', name=name(t)))
    elif h in ('footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track'):
        if t.get('footway') in ('sidewalk', 'crossing', 'traffic_island'): continue
        w = 5.0 if h == 'pedestrian' else 2.4 if h in ('footway', 'cycleway') else 1.8
        paths.append(dict(p=p, w=w * K + 0.4, steps=h == 'steps'))

def strokes(items, extra=0.0):
    im, d = canvas()
    for r in items:
        d.line(r['p'], fill=255, width=max(1, int(round(r['w'] + extra))), joint='curve')
        r0 = (r['w'] + extra) / 2
        for q in (r['p'][0], r['p'][-1]):
            d.ellipse([q[0] - r0, q[1] - r0, q[0] + r0, q[1] + r0], fill=255)
    return np.array(im) > 0
carriage = strokes(roads)
pathmask = strokes(paths)
plazas = fill(lambda t: t.get('highway') == 'pedestrian' and t.get('area') == 'yes' or t.get('area:highway') in ('footway', 'pedestrian')
              or t.get('amenity') == 'parking' and layer(t) >= 0 or t.get('place') == 'square')

# ---- buildings
def storeys(t):
    for k in ('building:levels',):
        try: return float(str(t[k]).split(';')[0])
        except (KeyError, ValueError): pass
    try: return float(str(t['height']).split()[0]) / 3.4
    except (KeyError, ValueError): return None
blds = []
for p, inner, t, wid in polys(lambda t: t.get('building') and t.get('building') not in ('roof', 'construction', 'canopy', 'no')
                                 and layer(t) >= 0 and t.get('location') != 'underground'):
    if inner or len(p) < 3 or not any(inside(q) for q in p): continue
    blds.append(dict(p=p, t=t, lv=storeys(t), id=wid, name=name(t)))
# Buildings without storeys take the median of their neighbours, else a guess by kind.
known = [(np.mean([q[0] for q in b['p']]), np.mean([q[1] for q in b['p']]), b['lv']) for b in blds if b['lv']]
kx = np.array([k[0] for k in known]); ky = np.array([k[1] for k in known]); kl = np.array([k[2] for k in known])
GUESS = {'residential': 14, 'apartments': 16, 'hotel': 18, 'commercial': 14, 'office': 20, 'retail': 4,
         'school': 6, 'college': 8, 'civic': 4, 'church': 2, 'train_station': 3, 'service': 2, 'kiosk': 1,
         'transportation': 3, 'hospital': 8, 'public': 5, 'garage': 2, 'industrial': 4, 'shed': 1, 'hut': 1}
for b in blds:
    if b['lv']: continue
    cx = np.mean([q[0] for q in b['p']]); cy = np.mean([q[1] for q in b['p']])
    dd = (kx - cx) ** 2 + (ky - cy) ** 2
    near = kl[dd < 35 ** 2]
    g = GUESS.get(b['t'].get('building'))
    b['lv'] = g if g is not None else (float(np.median(near)) if len(near) >= 3 else 8)

def style(b):
    t, nm, lv = b['t'], b['name'].lower(), b['lv']
    k = t.get('building')
    hist = t.get('historic') or t.get('heritage')
    if 'mosque' in nm or t.get('religion') == 'muslim': return 9
    if 'clock tower' in nm: return 8
    if 'space museum' in nm or 'planetarium' in nm: return 7
    if 'church' in nm or k in ('church', 'chapel', 'cathedral'): return 12
    if hist or '1881' in nm or 'heritage' in nm or 'signal tower' in nm or 'marine police' in nm: return 6
    if t.get('leisure') in ('sports_centre', 'swimming_pool') or 'sports centre' in nm or 'swimming pool' in nm: return 10
    if k in ('kiosk', 'shelter', 'toilets', 'pavilion') or t.get('amenity') in ('toilets', 'shelter') or lv <= 1.2: return 11
    if k == 'hotel' or t.get('tourism') == 'hotel': return 4
    if k == 'office' or (k == 'commercial' and lv >= 16): return 2
    if k in ('retail', 'mall', 'supermarket') or t.get('shop') == 'mall' or (k == 'commercial' and lv <= 8): return 3
    if k in ('civic', 'public', 'school', 'college', 'university', 'hospital', 'train_station', 'transportation',
             'government', 'museum', 'service', 'fire_station', 'police') or t.get('tourism') == 'museum': return 5
    return 1

def floors(lv):
    """Storeys on the map: as many as the real ones up to 20, half of each above, at most 40."""
    lv = max(1.0, lv)
    f = lv if lv <= 20 else 20 + (lv - 20) * 0.5
    return int(max(1, min(40, round(f))))

def cellmask(p):
    im, d = canvas()
    d.polygon(p, fill=255)
    a = np.array(im, dtype=np.float32) / 255
    return a.reshape(N, 4, N, 4).mean(axis=(1, 3))

def majority(a):
    return a.reshape(N, 4, N, 4).mean(axis=(1, 3))

seaC = majority(sea) > 0.5
roadC = majority(carriage) > 0.45
taken = seaC | roadC
# Tallest first: where two outlines meet on a cell, the taller has it.
order = sorted(range(len(blds)), key=lambda i: -blds[i]['lv'])
owner = -np.ones((N, N), dtype=np.int32)
for i in order:
    m = cellmask(blds[i]['p']) > 0.5
    m &= ~taken & (owner < 0)
    owner[m] = i
COVER, MAXP, MINA, BUDGET = 0.8, 3, 4, 1250
rects = []
for i in order:
    m = owner == i
    cnt = int(m.sum())
    if cnt == 0: continue
    b = blds[i]
    pieces = []
    left = m.copy()
    while left.any():
        # The biggest rectangle left (histogram method).
        best = (0, 0, 0, 0, 0)
        hgt = np.zeros(N, dtype=np.int32)
        for y in range(N):
            hgt = np.where(left[y], hgt + 1, 0)
            stack = []
            for x in range(N + 1):
                hh = hgt[x] if x < N else 0
                start = x
                while stack and stack[-1][1] >= hh:
                    s, sh = stack.pop()
                    area = sh * (x - s)
                    if area > best[0]: best = (area, s, y - sh + 1, x - s, sh)
                    start = s
                stack.append((start, hh))
        area, x0, y0, w, h = best
        if area < 2 and pieces: break
        if area == 0: break
        pieces.append((x0, y0, w, h))
        left[y0:y0 + h, x0:x0 + w] = False
        if sum(p[2] * p[3] for p in pieces) >= COVER * cnt or len(pieces) >= MAXP: break
    for (x0, y0, w, h) in pieces:
        if w * h < MINA and len(pieces) > 1: continue
        rects.append((int(x0), int(y0), int(w), int(h), floors(b['lv']), style(b), i))
print('buildings', len(blds), 'rects', len(rects))
# Neighbours of a kind and a height that share a whole side are one building on the map: the
# map holds 1,024 structures, the armies' own among them.
def merge_pass(rs, tol):
    changed = True
    while changed:
        changed = False
        by = {}
        for k, r in enumerate(rs): by.setdefault((r[0], r[1]), []).append(k)
        dead = set()
        for k, a in enumerate(rs):
            if k in dead: continue
            for k2, b in enumerate(rs):
                if k2 == k or k2 in dead or a[5] != b[5] or abs(a[4] - b[4]) > tol: continue
                if a[1] == b[1] and a[3] == b[3] and a[0] + a[2] == b[0] and a[2] + b[2] <= 16:
                    m = (a[0], a[1], a[2] + b[2], a[3])
                elif a[0] == b[0] and a[2] == b[2] and a[1] + a[3] == b[1] and a[3] + b[3] <= 16:
                    m = (a[0], a[1], a[2], a[3] + b[3])
                else: continue
                fl = round((a[4] * a[2] * a[3] + b[4] * b[2] * b[3]) / (a[2] * a[3] + b[2] * b[3]))
                a = rs[k] = (*m, fl, a[5], a[6])
                dead.add(k2); changed = True
        rs = [r for k, r in enumerate(rs) if k not in dead]
    return rs
for tol in (0, 2, 4, 6, 9, 14):
    if len(rects) <= BUDGET: break
    rects = merge_pass(rects, tol)
    print('merged at', tol, len(rects))
if len(rects) > BUDGET:
    rects.sort(key=lambda r: -r[2] * r[3])
    rects = rects[:BUDGET]


# ---- the cells
WATER, POND, POOL, ROADC, PAVE, PATH, GRASS, WOOD, EARTH, PITCH, BUILT = range(11)
cells = np.full((N, N), PAVE, dtype=np.uint8)
g = majority(green) > 0.5
cells[g] = GRASS
cells[majority(pitch) > 0.5] = PITCH
cells[(majority(wood) > 0.5)] = WOOD
cells[majority(earth) > 0.5] = EARTH
cells[(majority(pathmask) > 0.3) & (g | (majority(wood) > 0.5))] = PATH
cells[majority(plazas) > 0.5] = PAVE
cells[majority(pond) > 0.5] = POND
cells[majority(pool) > 0.5] = POOL
cells[roadC] = ROADC
cells[seaC] = WATER
for (x0, y0, w, h, *_rest) in rects:
    blk = cells[y0:y0 + h, x0:x0 + w]
    blk[(blk != WATER) & (blk != ROADC)] = BUILT
# A one-cell sliver of sea is a dock edge: land.
cells[(cells == WATER) & (ndimage.binary_opening(cells == WATER, iterations=1) == 0)] = PAVE
# Specks of land left in the sea along a pier's edge are sea.
for _ in range(2):
    wet = (cells == WATER).astype(np.int32)
    around = ndimage.convolve(wet, np.ones((3, 3), dtype=np.int32), mode='nearest') - wet
    cells[(cells == PAVE) & (around >= 5)] = WATER

def rle(a):
    flat = a.flatten()
    out, i = [], 0
    while i < len(flat):
        j = i
        while j < len(flat) and flat[j] == flat[i] and j - i < 4095: j += 1
        out.append(chr(97 + int(flat[i])) + (str(j - i) if j - i > 1 else ''))
        i = j
    return ''.join(out)

def simplify(p, tol):
    if len(p) < 3: return p
    a, b = np.array(p[0]), np.array(p[-1])
    ab = b - a; L = np.hypot(*ab) or 1e-9
    dmax, k = 0, 0
    for i in range(1, len(p) - 1):
        q = np.array(p[i]) - a
        dd = abs(ab[0] * q[1] - ab[1] * q[0]) / L
        if dd > dmax: dmax, k = dd, i
    if dmax > tol: return simplify(p[:k + 1], tol)[:-1] + simplify(p[k:], tol)
    return [p[0], p[-1]]
def clipped(p):
    return [q for q in p] if any(inside(q, 30) for q in p) else None
def enc(items, kind):
    out = []
    for r in items:
        p = simplify(r['p'], 0.4)
        p = clipped(p)
        if not p: continue
        flat = [int(round(c * 10)) for q in p for c in q]
        if kind == 'road': out.append([int(round(r['w'] * 10)), r['main'] + (2 if r['oneway'] else 0), r['lanes']] + flat)
        else: out.append([int(round(r['w'] * 10)), 1 if r.get('steps') else 0, 0] + flat)
    return out

def nodepts(pred):
    out = []
    for nid, (la, lo, t) in nodes.items():
        if pred(t):
            q = ((lo - LON0) * MX, (LAT0 - la) * MY)
            if inside(q): out += [int(round(q[0] * 10)), int(round(q[1] * 10))]
    return out
trees = nodepts(lambda t: t.get('natural') == 'tree')
for wid, (nl, t) in ways.items():
    if t.get('natural') == 'tree_row':
        p = pts(nl)
        for a0, b0 in zip(p, p[1:]):
            L = math.hypot(b0[0] - a0[0], b0[1] - a0[1])
            for s in np.arange(0, L, 7):
                q = (a0[0] + (b0[0] - a0[0]) * s / L, a0[1] + (b0[1] - a0[1]) * s / L)
                if inside(q): trees += [int(q[0] * 10), int(q[1] * 10)]
stops = nodepts(lambda t: t.get('highway') == 'bus_stop')
mtr = nodepts(lambda t: t.get('railway') == 'subway_entrance')
crossings = []
for wid, (nl, t) in ways.items():
    if t.get('footway') == 'crossing' and t.get('highway') == 'footway' and layer(t) == 0:
        p = pts(nl)
        if len(p) >= 2 and inside(p[0]): crossings += [int(round(c * 10)) for c in (*p[0], *p[-1])]
fountains = nodepts(lambda t: t.get('amenity') == 'fountain')

with open(OUT, 'w') as o:
    o.write('// Generated by tools/kowloon/osm2map.py from OpenStreetMap data. Do not edit.\n')
    o.write('// Map data (c) OpenStreetMap contributors, Open Database Licence: openstreetmap.org/copyright\n')
    o.write('/* eslint-disable */\n')
    o.write('/** Cell kinds, 256 x 256 run-length coded: a letter per kind, then the run if longer than one. */\n')
    o.write('export const HK_CELLS = %s;\n' % json.dumps(rle(cells)))
    o.write('/** Buildings: x, y, w, h (cells), storeys, style, and again. */\n')
    o.write('export const HK_BUILDINGS: readonly number[] = %s;\n' % json.dumps([v for r in rects for v in r[:6]], separators=(',', ':')))
    o.write('/** Roads as lines: width (dm), kind (1 main, 2 one way), lanes, then x, z (dm) of each point. */\n')
    o.write('export const HK_ROADS: readonly (readonly number[])[] = %s;\n' % json.dumps(enc(roads, 'road'), separators=(',', ':')))
    o.write('/** Paths as lines: width (dm), 1 for steps, 0, then the points. */\n')
    o.write('export const HK_PATHS: readonly (readonly number[])[] = %s;\n' % json.dumps(enc(paths, 'path'), separators=(',', ':')))
    for nm, v in (('HK_TREES', trees), ('HK_STOPS', stops), ('HK_MTR', mtr), ('HK_CROSSINGS', crossings), ('HK_FOUNTAINS', fountains)):
        o.write('export const %s: readonly number[] = %s;\n' % (nm, json.dumps(v, separators=(',', ':'))))
print('cells', {k: int((cells == v).sum()) for k, v in zip('WATER POND POOL ROAD PAVE PATH GRASS WOOD EARTH PITCH BUILT'.split(), range(11))})
import collections
print('styles', collections.Counter(r[5] for r in rects), 'max floors', max(r[4] for r in rects))
print('roads', len(roads), 'paths', len(paths), 'trees', len(trees) // 2, 'stops', len(stops) // 2, 'mtr', len(mtr) // 2)

if PREVIEW:
    pal = np.array([(70, 110, 160), (80, 130, 190), (60, 200, 220), (70, 70, 75), (175, 170, 160), (200, 185, 150),
                    (130, 170, 100), (60, 105, 55), (150, 120, 90), (110, 160, 90), (0, 0, 0)], dtype=np.uint8)
    img = pal[cells]
    for (x0, y0, w, h, fl, st, _) in rects:
        c = [(200, 200, 200), (205, 170, 140), (120, 150, 190), (200, 120, 120), (190, 150, 200), (170, 170, 170),
             (230, 220, 170), (240, 240, 240), (180, 90, 60), (250, 250, 250), (150, 200, 210), (190, 60, 50), (220, 200, 200)][st]
        sh = max(0.35, 1 - fl / 45)
        img[y0:y0 + h, x0:x0 + w] = [int(v * sh) for v in c]
        img[y0:y0 + h, x0] = [int(v * sh * 0.7) for v in c]
        img[y0, x0:x0 + w] = [int(v * sh * 0.7) for v in c]
    Image.fromarray(img).resize((1024, 1024), Image.NEAREST).save(PREVIEW)
