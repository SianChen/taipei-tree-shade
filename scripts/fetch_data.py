"""Download the raw datasets into data/raw and record where each came from in manifest.json.

Usage: python3 scripts/fetch_data.py [--raw data/raw] [--force]
"""
import argparse
import hashlib
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCES = {
    'street_trees.csv': {
        'url': 'https://tppkl.blob.core.windows.net/blobfs/TaipeiTree.csv',
        'dataset': 'https://data.gov.tw/dataset/128274',
        'note': '臺北市行道樹及公園樹木分布圖：行道樹（活動頁提供）',
    },
    'park_trees.csv': {
        'url': 'https://tppkl.blob.core.windows.net/blobfs/TaipeiParkTree.csv',
        'dataset': 'https://data.gov.tw/dataset/128274',
        'note': '臺北市行道樹及公園樹木分布圖：公園樹木（活動頁提供）',
    },
    'street_trees_2024-11-21.csv': {
        'url': 'https://web.archive.org/web/20241121065019id_/https://tppkl.blob.core.windows.net/blobfs/TaipeiTree.csv',
        'dataset': 'https://data.gov.tw/dataset/128274',
        'note': '同一個官方行道樹檔案的 2024-11-21 舊版，由 Wayback Machine 存檔（非活動頁提供）',
    },
    'tree_pits_nco.geojson': {
        'url': 'https://data.taipei/api/dataset/693705fa-4604-4207-bd50-8a9ce9fcfbc6/resource/3e2b359b-8dae-46e4-a747-5912d8743d0e/download',
        'dataset': 'https://data.gov.tw/dataset/134908',
        'note': '臺北市人行道固定設施物＿樹穴，新工處（活動頁提供）',
    },
    'sidewalks.json': {
        'url': 'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=b11d6142-1d71-41d5-a843-7b7cfcea61ef',
        'dataset': 'https://data.taipei/dataset/detail?id=715d3a83-8445-4496-b6bf-b0900538b7e7',
        'note': '臺北市人行道範圍圖（活動頁提供）',
    },
    'villages_moi.zip': {
        'url': 'https://www.tgos.tw/tgos/VirtualDir/Product/a04697c8-64db-450a-a105-3eb471c45abd/'
               '%E6%9D%91(%E9%87%8C)%E7%95%8C(TWD97%E7%B6%93%E7%B7%AF%E5%BA%A6).zip',
        'dataset': 'https://data.gov.tw/dataset/7438',
        'note': '內政部國土測繪中心 村(里)界圖（TWD97 經緯度，SHP），全國；非活動頁提供',
    },
    'village_population_by_age.csv': {
        'url': 'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=c8f5b53d-ef3d-4321-ae8e-58cd2a5ee73c',
        'dataset': 'https://data.taipei/dataset/detail?id=a6394e3f-3514-4542-87bd-de4310a40db3',
        'note': '臺北市各里人口數按年齡分，112 年迄今每月（活動頁 #6 提供）',
    },
}


def download(url, dest):
    req = urllib.request.Request(url, headers={'User-Agent': 'puma-hackathon-tree-equity/0.1'})
    with urllib.request.urlopen(req, timeout=300) as resp, open(dest, 'wb') as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', default='data/raw')
    ap.add_argument('--force', action='store_true', help='download again even if the file exists')
    args = ap.parse_args()
    raw = Path(args.raw)
    raw.mkdir(parents=True, exist_ok=True)
    manifest_path = raw / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}

    for name, src in SOURCES.items():
        dest = raw / name
        if dest.exists() and not args.force:
            print(f'skip  {name} (exists)')
            continue
        print(f'fetch {name} ...', flush=True)
        download(src['url'], dest)
        manifest[name] = {
            **src,
            'downloaded_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'bytes': dest.stat().st_size,
            'sha256': sha256(dest),
        }
        print(f'      {dest.stat().st_size:,} bytes')

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
