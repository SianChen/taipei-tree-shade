"""Draw a fixed random sample from each candidate class for Street View spot checks.

Writes data/sample/checklist.csv (opens in Excel or Google Sheets). Fill in the 判讀結果 column with
有樹 / 無樹 / 無法判斷, then run scripts/score_sample.py to get the hit rate per class.

Usage: python3 scripts/sample.py [--processed data/processed] [--out data/sample] [--n 20] [--seed 20261024]
"""
import argparse
import csv
import json
import random
from pathlib import Path

CLASSES = {
    'A': '2024 年有樹、現在空的樹穴（砍了沒補）',
    'B': '空樹穴，15 m 內有樹（缺株）',
    'C': '空樹穴，15 m 內沒有樹（待確認）',
    'GONE': '2024 年資料有、現在消失的行道樹',
}
# Every class claims the spot has no tree now; Street View confirms or refutes that.
EXPECTED = '無樹'
COLUMNS = ['樣本編號', '類別', '類別說明', '行政區', '路段', '緯度', '經度', '街景連結', '地圖連結',
           '2024 資料', '資料預期', '判讀結果', '街景影像日期', '備註']


def streetview(lat, lon):
    return f'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}'


def gmap(lat, lon):
    return f'https://www.google.com/maps/search/?api=1&query={lat},{lon}'


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))['features']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--processed', default='data/processed')
    ap.add_argument('--out', default='data/sample')
    ap.add_argument('--n', type=int, default=20)
    ap.add_argument('--seed', type=int, default=20261024)
    args = ap.parse_args()
    processed, out = Path(args.processed), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    pits = load(processed / 'pit_candidates.geojson')
    pools = {cls: [f for f in pits if f['properties']['class'] == cls] for cls in ('A', 'B', 'C')}
    pools['GONE'] = load(processed / 'disappeared_trees.geojson')

    rng = random.Random(args.seed)
    rows = []
    for cls, desc in CLASSES.items():
        for i, f in enumerate(rng.sample(pools[cls], min(args.n, len(pools[cls]))), 1):
            p = f['properties']
            lon, lat = f['geometry']['coordinates']
            before = (f"{p['species']}，胸徑 {p['diameter_cm']} cm，調查 {p['survey_date']}"
                      if cls == 'GONE' else '')
            rows.append({
                '樣本編號': f'{cls}-{i:02d}', '類別': cls, '類別說明': desc,
                '行政區': p.get('district') or '', '路段': p.get('road') or '',
                '緯度': lat, '經度': lon,
                '街景連結': streetview(lat, lon), '地圖連結': gmap(lat, lon),
                '2024 資料': before, '資料預期': EXPECTED,
                '判讀結果': '', '街景影像日期': '', '備註': '',
            })

    path = out / 'checklist.csv'
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f'{len(rows)} rows -> {path}')
    for cls in CLASSES:
        print(f'  {cls}: sampled {sum(r["類別"] == cls for r in rows)} of {len(pools[cls])}')


if __name__ == '__main__':
    main()
