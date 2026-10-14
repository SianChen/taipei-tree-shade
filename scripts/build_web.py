"""Slim the processed layers into web/data for the map, plus a meta.json of headline numbers.

Usage: python3 scripts/build_web.py [--processed data/processed] [--raw data/raw] [--web web]
"""
import argparse
import json
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def slim(features, keep):
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': f['geometry'],
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

    dump(out / 'villages.geojson', villages)
    dump(out / 'pits.geojson', slim(pits, {
        'id': 'id', 'c': 'class', 'district': 'district', 'road': 'road',
        'area': 'area_m2', 'near': 'nearest_tree_m'}))
    dump(out / 'gone.geojson', slim(gone, {
        'id': 'tree_id', 'district': 'district', 'road': 'road', 'species': 'species',
        'dbh': 'diameter_cm', 'height': 'height_m', 'surveyed': 'survey_date'}))

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
