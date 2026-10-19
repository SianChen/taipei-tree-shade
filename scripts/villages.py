"""Build the village (里) layer: tree shade per person (street and park trees), elderly share, and candidate counts.

Canopy is an estimate. Crown diameter is taken as CROWN_M_PER_DBH_CM x trunk diameter, clamped to
[MIN_CROWN_M, MAX_CROWN_M]. The shade index ranks villages, and a linear factor does not change
that ranking, so the exact factor matters less than it looks.

The map colours ranked villages in SHADE_CLASSES equal-count classes: sorted by shade per person,
each class holds about a sixth of them. Six classes splits the low end finer than the earlier five
while staying few enough to tell apart.

Street trees and park trees both count: shade is shade, whichever office's list a tree is on.
Village boundaries mostly run down road centre lines, so a tree counts for every village it is
inside or within BOUNDARY_BUFFER_M of: people on both sides of a road walk under the same trees.
Trees on a boundary are therefore counted more than once across villages. 25 m reaches the
sidewalks of a 40 m arterial road.

The tree lists only hold trees the city looks after: not forest, school grounds, private gardens or
riverside parks. Villages whose shade mostly comes from forest are therefore left unranked:
- below LOW_DENSITY_PER_HA residents per hectare. At 5 that is only the eight mountain villages of
  Yangmingshan and Maokong. A higher cut-off also dropped campus and airport villages (NTU's 學府里,
  精忠里) and Shezidao (富洲里), where people live with few or no trees, which the map should show.
- at least HILLSIDE_PCT of their area zoned 保護區 (hillside conservation land) in the urban plan.
  Yangmingshan is outside the city plan, which is why the density rule is still needed.

Usage: python3 scripts/villages.py [--raw data/raw] [--processed data/processed]
"""
import argparse
import csv
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_csv, tree_xy, twd97_to_wgs84  # noqa: E402
from shapefile_lite import read_zip  # noqa: E402

VILLAGE_ZIP = 'villages_moi.zip'
VILLAGE_SHP = 'VILLAGE_NLSC_1150817'
CROWN_M_PER_DBH_CM = 0.24
MIN_CROWN_M, MAX_CROWN_M = 1.5, 20.0
MAX_DBH_CM = 200  # larger values in the source are typos
BOUNDARY_BUFFER_M = 25.0
LOW_DENSITY_PER_HA = 5.0
ZONING_ZIP, ZONING_SHP, ZONING_ENCODING = 'zoning_main.zip', '主計圖-面', 'cp950'
HILLSIDE_ZONE = '保護區'
HILLSIDE_PCT = 30.0
SCAN_STEP_M = 5.0  # scan-line spacing for the zone share; finer than any village's width
SHADE_CLASSES = 6
EARTH_R = 6371008.8
M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(25.05))  # Taipei
CELL_DEG = 0.01


def ring_area_m2(ring):
    """Area of a lon/lat ring, projected locally (equirectangular around its mean latitude)."""
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    k = math.cos(lat0)
    pts = [(math.radians(x) * k * EARTH_R, math.radians(y) * EARTH_R) for x, y in ring]
    return abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))) / 2


def inside(x, y, rings):
    """Even-odd test across all rings, so holes are handled."""
    hit = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                hit = not hit
    return hit


def near_edge(x, y, rings, max_m):
    """True when the point is within max_m metres of any ring edge."""
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            ax, ay = (x - x1) * M_PER_DEG_LON, (y - y1) * M_PER_DEG_LAT
            bx, by = (x2 - x1) * M_PER_DEG_LON, (y2 - y1) * M_PER_DEG_LAT
            seg2 = bx * bx + by * by
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, (ax * bx + ay * by) / seg2))
            if math.hypot(ax - t * bx, ay - t * by) <= max_m:
                return True
    return False


class VillageLocator:
    def __init__(self, villages, buffer_m=0.0):
        self.villages = villages
        self.buffer_m = buffer_m
        pad_x, pad_y = buffer_m / M_PER_DEG_LON, buffer_m / M_PER_DEG_LAT
        self.cells = defaultdict(list)
        for i, v in enumerate(villages):
            xs = [p[0] for r in v['rings'] for p in r]
            ys = [p[1] for r in v['rings'] for p in r]
            v['bbox'] = (min(xs) - pad_x, min(ys) - pad_y, max(xs) + pad_x, max(ys) + pad_y)
            x0, y0, x1, y1 = v['bbox']
            for cx in range(int(x0 // CELL_DEG), int(x1 // CELL_DEG) + 1):
                for cy in range(int(y0 // CELL_DEG), int(y1 // CELL_DEG) + 1):
                    self.cells[(cx, cy)].append(i)

    def _candidates(self, lon, lat):
        for i in self.cells.get((int(lon // CELL_DEG), int(lat // CELL_DEG)), ()):
            v = self.villages[i]
            x0, y0, x1, y1 = v['bbox']
            if x0 <= lon <= x1 and y0 <= lat <= y1:
                yield v

    def locate(self, lon, lat):
        """The one village containing the point, or None."""
        return next((v for v in self._candidates(lon, lat) if inside(lon, lat, v['rings'])), None)

    def locate_near(self, lon, lat):
        """Every village containing the point or within buffer_m of it."""
        return [v for v in self._candidates(lon, lat)
                if inside(lon, lat, v['rings']) or near_edge(lon, lat, v['rings'], self.buffer_m)]


def dbh_cm(row, species_median, overall_median):
    try:
        d = float(row['Diameter'])
    except ValueError:
        d = 0
    if d <= 0:
        return species_median.get(row['TreeType'], overall_median)
    return min(d, MAX_DBH_CM)


def crown_area_m2(dbh):
    d = min(max(CROWN_M_PER_DBH_CM * dbh, MIN_CROWN_M), MAX_CROWN_M)
    return math.pi * d * d / 4


def species_medians(rows):
    by = defaultdict(list)
    for r in rows:
        try:
            d = float(r['Diameter'])
        except ValueError:
            continue
        if 0 < d <= MAX_DBH_CM:
            by[r['TreeType']].append(d)
    all_d = [d for ds in by.values() for d in ds]
    return {k: statistics.median(v) for k, v in by.items()}, statistics.median(all_d)


def load_population(path):
    """Latest month, both sexes: {VILLCODE: (total, aged 65+)}."""
    with open(path, encoding='cp950', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['性別'] == '計' and len(r['區域代碼']) == 11]
    latest = max((int(r['年份']), int(r['月份'])) for r in rows)
    pop = {}
    for r in rows:
        if (int(r['年份']), int(r['月份'])) != latest:
            continue
        elderly = sum(int(r[f'{age}歲數量']) for age in range(65, 100)) + int(r['100歲以上'])
        pop[r['區域代碼']] = (int(r['總計']), elderly)
    return pop, f'{latest[0]}/{latest[1]:02d}'


def add_trees(locator, rows, key):
    medians, overall = species_medians(rows)
    missed = 0
    for r in rows:
        xy = tree_xy(r)
        lonlat = xy and twd97_to_wgs84(*xy)
        if not lonlat:
            missed += 1
            continue
        hits = locator.locate_near(*lonlat)
        if not hits:
            missed += 1
        area = crown_area_m2(dbh_cm(r, medians, overall))
        for v in hits:
            v[f'{key}_trees'] += 1
            v[f'{key}_canopy_m2'] += area
    return missed


def add_points(locator, features, key_of):
    for f in features:
        v = locator.locate(*f['geometry']['coordinates'])
        if v:
            v[key_of(f)] += 1


def to_metres(lon, lat):
    return lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT


def load_zones(path, zone):
    """The urban-plan polygons of one zone, as (rings in metres, bbox)."""
    out = []
    for attrs, rings in read_zip(path, ZONING_SHP, ZONING_ENCODING):
        if attrs['使用分區'] != zone:
            continue
        rings = [[to_metres(*twd97_to_wgs84(x, y)) for x, y in r] for r in rings]
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        out.append((rings, (min(xs), min(ys), max(xs), max(ys))))
    return out


def row_spans(rings, y0, n):
    """{row: [(x0, x1), ...]} where the polygon (even-odd over all rings) covers the line y0 + (row + 0.5) * SCAN_STEP_M."""
    crossings = defaultdict(list)
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if y1 == y2:
                continue
            lo, hi = sorted((y1, y2))
            first = max(0, math.ceil((lo - y0) / SCAN_STEP_M - 0.5))
            for i in range(first, min(n, math.ceil((hi - y0) / SCAN_STEP_M - 0.5))):
                y = y0 + (i + 0.5) * SCAN_STEP_M
                if (y1 > y) != (y2 > y):
                    crossings[i].append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    return {i: list(zip(xs[0::2], xs[1::2])) for i, xs in ((i, sorted(xs)) for i, xs in crossings.items())}


def overlap(a, b):
    """Total length shared by two sorted lists of disjoint spans."""
    total, i, j = 0.0, 0, 0
    while i < len(a) and j < len(b):
        total += max(0.0, min(a[i][1], b[j][1]) - max(a[i][0], b[j][0]))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def merge(spans):
    out = []
    for s, e in sorted(spans):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def zone_pct(rings, zones):
    """Percent of the village's area inside the zones, measured along horizontal scan lines."""
    rings = [[to_metres(*p) for p in r] for r in rings]
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    y0, n = min(ys), int((max(ys) - min(ys)) / SCAN_STEP_M) + 1
    zone_rows = defaultdict(list)
    for z_rings, (zx0, zy0, zx1, zy1) in zones:
        if zx1 >= min(xs) and zx0 <= max(xs) and zy1 >= y0 and zy0 <= max(ys):
            for i, spans in row_spans(z_rings, y0, n).items():
                zone_rows[i].extend(spans)
    total = inside = 0.0
    for i, spans in row_spans(rings, y0, n).items():
        total += sum(e - s for s, e in spans)
        inside += overlap(spans, merge(zone_rows.get(i, [])))
    return 100 * inside / total if total else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', default='data/raw')
    ap.add_argument('--processed', default='data/processed')
    args = ap.parse_args()
    raw, processed = Path(args.raw), Path(args.processed)

    villages = []
    for attrs, rings in read_zip(raw / VILLAGE_ZIP, VILLAGE_SHP):
        if attrs['COUNTYNAME'] != '臺北市':
            continue
        villages.append({
            'code': attrs['VILLCODE'], 'district': attrs['TOWNNAME'], 'village': attrs['VILLNAME'],
            'rings': rings, 'area_m2': sum(ring_area_m2(r) for r in rings),
            'street_trees': 0, 'street_canopy_m2': 0.0, 'park_trees': 0, 'park_canopy_m2': 0.0,
            'pits_A': 0, 'pits_B': 0, 'pits_C': 0, 'disappeared': 0,
        })
    locator = VillageLocator(villages, BOUNDARY_BUFFER_M)

    missed_street = add_trees(locator, load_csv(raw / 'street_trees.csv'), 'street')
    missed_park = add_trees(locator, load_csv(raw / 'park_trees.csv'), 'park')
    zones = load_zones(raw / ZONING_ZIP, HILLSIDE_ZONE)
    pits = json.loads((processed / 'pit_candidates.geojson').read_text(encoding='utf-8'))['features']
    add_points(locator, pits, lambda f: f"pits_{f['properties']['class']}")
    gone = json.loads((processed / 'disappeared_trees.geojson').read_text(encoding='utf-8'))['features']
    add_points(locator, gone, lambda f: 'disappeared')

    pop, pop_month = load_population(raw / 'village_population_by_age.csv')
    for v in villages:
        total, elderly = pop.get(v['code'], (0, 0))
        v['population'] = total
        v['elderly_pct'] = round(100 * elderly / total, 1) if total else None
        canopy = v['street_canopy_m2'] + v['park_canopy_m2']
        v['shade_m2_per_person'] = round(canopy / total, 2) if total else None
        v['canopy_pct'] = round(100 * canopy / v['area_m2'], 2)
        v['density_per_ha'] = round(total / (v['area_m2'] / 1e4), 1)
        v['low_density'] = v['density_per_ha'] < LOW_DENSITY_PER_HA
        v['hillside_pct'] = round(zone_pct(v['rings'], zones), 1)
        v['hillside'] = v['hillside_pct'] >= HILLSIDE_PCT
    scored = [v for v in villages
              if v['shade_m2_per_person'] is not None and not v['low_density'] and not v['hillside']]
    values = [v['shade_m2_per_person'] for v in scored]
    ordered = sorted(values)
    # Lower edge of each class above the first; a village on an edge goes up, so equal values share a class.
    breaks = [ordered[math.ceil(k * len(ordered) / SHADE_CLASSES)] for k in range(1, SHADE_CLASSES)]
    for v in scored:
        v['shade_class'] = sum(v['shade_m2_per_person'] >= b for b in breaks)
        # Competition ranking: villages with the same value share a rank.
        v['shade_rank_from_bottom'] = 1 + sum(x < v['shade_m2_per_person'] for x in values)
        v['shade_rank_ties'] = values.count(v['shade_m2_per_person'])

    features = []
    for v in villages:
        props = {k: v.get(k) for k in (
            'code', 'district', 'village', 'population', 'density_per_ha', 'low_density', 'hillside_pct', 'hillside',
            'elderly_pct', 'street_trees', 'park_trees',
            'shade_m2_per_person', 'canopy_pct', 'shade_class', 'shade_rank_from_bottom', 'shade_rank_ties',
            'pits_A', 'pits_B', 'pits_C', 'disappeared')}
        props['area_ha'] = round(v['area_m2'] / 1e4, 1)
        props['street_canopy_m2'] = round(v['street_canopy_m2'])
        props['park_canopy_m2'] = round(v['park_canopy_m2'])
        coords = [[[round(x, 6), round(y, 6)] for x, y in r] for r in v['rings']]
        features.append({'type': 'Feature', 'properties': props,
                         'geometry': {'type': 'Polygon', 'coordinates': coords}})
    out = processed / 'villages.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': features,
                               'meta': {'population_month': pop_month, 'villages_scored': len(scored),
                                        'boundary_buffer_m': BOUNDARY_BUFFER_M,
                                        'low_density_per_ha': LOW_DENSITY_PER_HA,
                                        'hillside_zone_pct': HILLSIDE_PCT,
                                        'shade_breaks_m2': breaks,
                                        'crown_m_per_dbh_cm': CROWN_M_PER_DBH_CM}},
                              ensure_ascii=False), encoding='utf-8')

    print(f'villages {len(villages)}, scored {len(scored)}, population month {pop_month}')
    print(f"unranked: low density {sum(v['low_density'] for v in villages)}, "
          f"hillside {sum(v['hillside'] and not v['low_density'] for v in villages)}")
    print(f'trees outside any village: street {missed_street}, park {missed_park}')
    ranked = sorted(scored, key=lambda v: v['shade_m2_per_person'])
    for label, vs in (('least shade per person', ranked[:10]), ('most shade per person', ranked[-5:])):
        print(label)
        for v in vs:
            print(f"  {v['district']}{v['village']}: {v['shade_m2_per_person']} m2/person, "
                  f"{v['street_trees']} street + {v['park_trees']} park trees, pop {v['population']}, "
                  f"65+ {v['elderly_pct']}%")


if __name__ == '__main__':
    main()
