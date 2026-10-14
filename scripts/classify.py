"""Classify every tree pit and find street trees that disappeared since the 2024-11 snapshot.

Tree pit classes (pit centroid against tree points, distances in metres):
  has_tree  a current street tree within 3 m
  A         empty now, but a 2024-11 street tree stood within 1.5 m (removed and not replanted)
  park      empty of street trees, but a park tree is within 1.5 m (covered by the park dataset)
  B         empty, a current street tree within 15 m (gap on a planted street)
  C         empty, no street tree within 15 m (unverified: may be a data coverage gap)

Disappeared tree: TreeID in the 2024-11 snapshot but not in the current file, with no current
street or park tree within 5 m (so re-numbered or re-surveyed trees are not counted).

Usage: python3 scripts/classify.py [--raw data/raw] [--out data/processed]
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import PointIndex, load_csv, tree_xy, twd97_to_wgs84  # noqa: E402

HAS_TREE_M = 3.0
OLD_TREE_M = 1.5
PARK_TREE_M = 1.5
GAP_M = 15.0
DISAPPEARED_M = 5.0
ROAD_LOOKUP_M = 30.0


def ring_area(ring):
    return abs(sum(ring[i][0] * ring[i - 1][1] - ring[i - 1][0] * ring[i][1] for i in range(len(ring)))) / 2


def polygon_area(geom):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    return sum(ring_area(p[0]) - sum(ring_area(h) for h in p[1:]) for p in polys)


def index_trees(rows, payload=lambda r: r):
    return PointIndex((*xy, payload(r)) for r in rows if (xy := tree_xy(r)))


def point(x, y, props):
    lon, lat = twd97_to_wgs84(x, y)
    return {'type': 'Feature', 'properties': props,
            'geometry': {'type': 'Point', 'coordinates': [round(lon, 7), round(lat, 7)]}}


def road_of(row):
    return ' '.join(v for v in (row.get('Region'), row.get('RegionRemark')) if v)


def classify_pits(pits, now_idx, old_idx, park_idx, road_idx):
    features, counts, by_district = [], Counter(), Counter()
    for f in pits:
        p, geom = f['properties'], f['geometry']
        if p.get('Name') != '樹穴' or not geom:
            continue
        x, y = p['X_3826'], p['Y_3826']
        d_now, _ = now_idx.nearest(x, y, GAP_M)
        if d_now <= HAS_TREE_M:
            cls = 'has_tree'
        elif old_idx.nearest(x, y, OLD_TREE_M)[1] is not None:
            cls = 'A'
        elif park_idx.nearest(x, y, PARK_TREE_M)[1] is not None:
            cls = 'park'
        elif d_now <= GAP_M:
            cls = 'B'
        else:
            cls = 'C'
        counts[cls] += 1
        if cls in ('A', 'B', 'C'):
            by_district[(cls, p.get('Town_N'))] += 1
            _, road = road_idx.nearest(x, y, ROAD_LOOKUP_M)
            features.append(point(x, y, {
                'id': p['OBJECTID'],
                'class': cls,
                'district': p.get('Town_N'),
                'road': road or '',
                'area_m2': round(polygon_area(geom), 2),
                'nearest_tree_m': None if d_now == float('inf') else round(d_now, 1),
            }))
    return features, counts, by_district


def find_disappeared(old_rows, now_rows, now_idx, park_idx):
    now_ids = {r['TreeID'] for r in now_rows}
    features, by_district = [], Counter()
    for r in old_rows:
        xy = tree_xy(r)
        if r['TreeID'] in now_ids or not xy:
            continue
        if now_idx.nearest(*xy, DISAPPEARED_M)[1] is not None or park_idx.nearest(*xy, DISAPPEARED_M)[1] is not None:
            continue
        by_district[r['Dist']] += 1
        features.append(point(*xy, {
            'tree_id': r['TreeID'],
            'district': r['Dist'],
            'road': road_of(r),
            'species': r['TreeType'],
            'diameter_cm': r['Diameter'],
            'height_m': r['TreeHeight'],
            'survey_date': r['SurveyDate'],
        }))
    return features, by_district


def write_geojson(path, features):
    path.write_text(json.dumps({'type': 'FeatureCollection', 'features': features}, ensure_ascii=False),
                    encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', default='data/raw')
    ap.add_argument('--out', default='data/processed')
    args = ap.parse_args()
    raw, out = Path(args.raw), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    now_rows = load_csv(raw / 'street_trees.csv')
    old_rows = load_csv(raw / 'street_trees_2024-11-21.csv')
    park_rows = load_csv(raw / 'park_trees.csv')
    pits = json.loads((raw / 'tree_pits_nco.geojson').read_text(encoding='utf-8'))['features']

    now_idx = index_trees(now_rows, payload=lambda r: True)
    old_idx = index_trees(old_rows, payload=lambda r: True)
    park_idx = index_trees(park_rows, payload=lambda r: True)
    road_idx = index_trees(now_rows + old_rows, payload=road_of)

    pit_features, pit_counts, pit_by_district = classify_pits(pits, now_idx, old_idx, park_idx, road_idx)
    gone_features, gone_by_district = find_disappeared(old_rows, now_rows, now_idx, park_idx)

    write_geojson(out / 'pit_candidates.geojson', pit_features)
    write_geojson(out / 'disappeared_trees.geojson', gone_features)
    manifest_path = raw / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
    summary = {
        'downloaded_at': {name: m.get('downloaded_at') for name, m in manifest.items()},
        'thresholds_m': {'has_tree': HAS_TREE_M, 'old_tree': OLD_TREE_M, 'park_tree': PARK_TREE_M,
                         'gap': GAP_M, 'disappeared': DISAPPEARED_M},
        'inputs': {'street_trees_now': len(now_rows), 'street_trees_2024_11': len(old_rows),
                   'park_trees': len(park_rows), 'tree_pits': sum(pit_counts.values())},
        'pit_classes': dict(pit_counts),
        'pit_candidates_by_district': {
            cls: dict(Counter({d: n for (c, d), n in pit_by_district.items() if c == cls}).most_common())
            for cls in ('A', 'B', 'C')},
        'disappeared_trees': len(gone_features),
        'disappeared_by_district': dict(gone_by_district.most_common()),
    }
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
