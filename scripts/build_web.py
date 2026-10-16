"""Slim the processed layers into web/data for the map, plus a meta.json of headline numbers.

Usage: python3 scripts/build_web.py [--processed data/processed] [--raw data/raw] [--web web]
"""
import argparse
import json
import subprocess
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


# Only the properties the map reads; coordinates rounded to ~1 m (5 decimals) for boundaries
# and ~0.1 m (6 decimals) for points, which together cut the gzipped download by about a fifth.
VILLAGE_PROPS = ['code', 'district', 'village', 'population', 'low_density', 'elderly_pct', 'street_trees',
                 'shade_m2_per_person', 'shade_score', 'shade_rank_from_bottom', 'shade_rank_ties',
                 'pits_A', 'pits_B', 'pits_C', 'disappeared']


def round_coords(coords, digits):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], digits), round(coords[1], digits)]
    return [round_coords(c, digits) for c in coords]


def slim(features, keep, digits):
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature',
         'geometry': {'type': f['geometry']['type'], 'coordinates': round_coords(f['geometry']['coordinates'], digits)},
         'properties': {short: f['properties'].get(long) for short, long in keep.items()}}
        for f in features]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--processed', default='data/processed')
    ap.add_argument('--raw', default='data/raw')
    ap.add_argument('--web', default='web')
    args = ap.parse_args()
    processed, out = Path(args.processed), Path(args.web) / 'data'
    out.mkdir(parents=True, exist_ok=True)

    villages = load(processed / 'villages.geojson')
    pits = load(processed / 'pit_candidates.geojson')['features']
    gone = load(processed / 'disappeared_trees.geojson')['features']
    summary = load(processed / 'summary.json')

    # Villages ship as TopoJSON (scripts/build_topo.mjs); the GeoJSON in between stays in data/processed.
    staged = processed / 'villages_web.geojson'
    dump(staged, slim(villages['features'], {k: k for k in VILLAGE_PROPS}, 5))
    subprocess.run(['node', str(Path(__file__).with_name('build_topo.mjs')), str(staged),
                    str(out / 'villages.topo.json')], check=True)
    dump(out / 'pits.geojson', slim(pits, {
        'c': 'class', 'district': 'district', 'road': 'road', 'area': 'area_m2', 'near': 'nearest_tree_m'}, 6))
    dump(out / 'gone.geojson', slim(gone, {
        'district': 'district', 'road': 'road', 'species': 'species',
        'dbh': 'diameter_cm', 'height': 'height_m', 'surveyed': 'survey_date'}, 6))

    downloaded = summary.get('downloaded_at', {})
    vmeta = villages.get('meta', {})
    dump(out / 'meta.json', {
        'trees_downloaded': (downloaded.get('street_trees.csv') or '')[:10],
        'population_month': vmeta.get('population_month'),
        'villages_scored': vmeta.get('villages_scored'),
        'boundary_buffer_m': vmeta.get('boundary_buffer_m'),
        'low_density_per_ha': vmeta.get('low_density_per_ha'),
        'crown_m_per_dbh_cm': vmeta.get('crown_m_per_dbh_cm'),
        'villages_total': len(villages['features']),
        'pit_classes': summary['pit_classes'],
        'disappeared_trees': summary['disappeared_trees'],
        'street_trees_now': summary['inputs']['street_trees_now'],
        'street_trees_2024_11': summary['inputs']['street_trees_2024_11'],
    })
    for p in sorted(out.iterdir()):
        print(f'{p}  {p.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
