"""Build the village (里) layer: street-tree shade per person, elderly share, and candidate counts.

Canopy is an estimate. Crown diameter is taken as CROWN_M_PER_DBH_CM x trunk diameter, clamped to
[MIN_CROWN_M, MAX_CROWN_M]. The shade score ranks villages, and a linear factor does not change
that ranking, so the exact factor matters less than it looks.

Village boundaries mostly run down road centre lines, so a street tree counts for every village it
is inside or within BOUNDARY_BUFFER_M of: people on both sides of a road walk under the same trees.
Trees on a boundary are therefore counted more than once across villages. 25 m reaches the
sidewalks of a 40 m arterial road; the villages with the least shade stay the same from 15 to 30 m.

Villages below LOW_DENSITY_PER_HA residents per hectare get no score or rank. At 5 that is only the
eight mountain villages of Yangmingshan and Maokong, whose shade comes from forest. A higher cut-off
also dropped campus and airport villages (NTU's 學府里, 精忠里) and Shezidao (富洲里), where people
live with few or no street trees, which the map should show.

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


def add_trees(locator, rows, key, share_boundary):
    medians, overall = species_medians(rows)
    missed = 0
    for r in rows:
        xy = tree_xy(r)
        lonlat = xy and twd97_to_wgs84(*xy)
        if not lonlat:
            missed += 1
            continue
        if share_boundary:
            hits = locator.locate_near(*lonlat)
        else:
            hits = [v] if (v := locator.locate(*lonlat)) else []
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


def percentile_ranks(values):
    """0 = lowest, 100 = highest; ties share the average rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = 100 * ((i + j) / 2) / max(len(values) - 1, 1)
        i = j + 1
    return ranks


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

    missed_street = add_trees(locator, load_csv(raw / 'street_trees.csv'), 'street', share_boundary=True)
    missed_park = add_trees(locator, load_csv(raw / 'park_trees.csv'), 'park', share_boundary=False)
    pits = json.loads((processed / 'pit_candidates.geojson').read_text(encoding='utf-8'))['features']
    add_points(locator, pits, lambda f: f"pits_{f['properties']['class']}")
    gone = json.loads((processed / 'disappeared_trees.geojson').read_text(encoding='utf-8'))['features']
    add_points(locator, gone, lambda f: 'disappeared')

    pop, pop_month = load_population(raw / 'village_population_by_age.csv')
    for v in villages:
        total, elderly = pop.get(v['code'], (0, 0))
        v['population'] = total
        v['elderly_pct'] = round(100 * elderly / total, 1) if total else None
        v['shade_m2_per_person'] = round(v['street_canopy_m2'] / total, 2) if total else None
        v['street_canopy_pct'] = round(100 * v['street_canopy_m2'] / v['area_m2'], 2)
        v['density_per_ha'] = round(total / (v['area_m2'] / 1e4), 1)
        v['low_density'] = v['density_per_ha'] < LOW_DENSITY_PER_HA
    scored = [v for v in villages if v['shade_m2_per_person'] is not None and not v['low_density']]
    for v, score in zip(scored, percentile_ranks([v['shade_m2_per_person'] for v in scored])):
        v['shade_score'] = round(score)
    values = [v['shade_m2_per_person'] for v in scored]
    for v in scored:
        # Competition ranking: villages with the same value share a rank.
        v['shade_rank_from_bottom'] = 1 + sum(x < v['shade_m2_per_person'] for x in values)
        v['shade_rank_ties'] = values.count(v['shade_m2_per_person'])

    features = []
    for v in villages:
        props = {k: v.get(k) for k in (
            'code', 'district', 'village', 'population', 'density_per_ha', 'low_density',
            'elderly_pct', 'street_trees', 'park_trees',
            'shade_m2_per_person', 'street_canopy_pct', 'shade_score', 'shade_rank_from_bottom', 'shade_rank_ties',
            'pits_A', 'pits_B', 'pits_C', 'disappeared')}
        props['area_ha'] = round(v['area_m2'] / 1e4, 1)
        props['street_canopy_m2'] = round(v['street_canopy_m2'])
        coords = [[[round(x, 6), round(y, 6)] for x, y in r] for r in v['rings']]
        features.append({'type': 'Feature', 'properties': props,
                         'geometry': {'type': 'Polygon', 'coordinates': coords}})
    out = processed / 'villages.geojson'
    out.write_text(json.dumps({'type': 'FeatureCollection', 'features': features,
                               'meta': {'population_month': pop_month, 'villages_scored': len(scored),
                                        'boundary_buffer_m': BOUNDARY_BUFFER_M,
                                        'low_density_per_ha': LOW_DENSITY_PER_HA,
                                        'crown_m_per_dbh_cm': CROWN_M_PER_DBH_CM}},
                              ensure_ascii=False), encoding='utf-8')

    print(f'villages {len(villages)}, scored {len(scored)}, population month {pop_month}')
    print(f'trees outside any village: street {missed_street}, park {missed_park}')
    ranked = sorted(scored, key=lambda v: v['shade_m2_per_person'])
    for label, vs in (('least shade per person', ranked[:10]), ('most shade per person', ranked[-5:])):
        print(label)
        for v in vs:
            print(f"  {v['district']}{v['village']}: {v['shade_m2_per_person']} m2/person, "
                  f"{v['street_trees']} street trees, pop {v['population']}, 65+ {v['elderly_pct']}%")


if __name__ == '__main__':
    main()
