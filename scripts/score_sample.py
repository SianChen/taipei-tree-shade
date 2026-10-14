"""Hit rate per class from a filled-in checklist.csv.

A hit = 判讀結果 matches 資料預期 (the data says the spot is empty and Street View agrees).
Rows marked 無法判斷 or left blank are reported but left out of the rate.

Usage: python3 scripts/score_sample.py [data/sample/checklist.csv]
"""
import csv
import sys
from collections import Counter, defaultdict


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'data/sample/checklist.csv'
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    tally = defaultdict(Counter)
    for r in rows:
        result = r['判讀結果'].strip()
        if not result:
            tally[r['類別']]['未填'] += 1
        elif result == '無法判斷':
            tally[r['類別']]['無法判斷'] += 1
        else:
            tally[r['類別']]['命中' if result == r['資料預期'] else '不符'] += 1
    for cls, c in tally.items():
        judged = c['命中'] + c['不符']
        rate = f'{c["命中"] / judged:.0%}' if judged else '—'
        print(f'{cls:5} 命中率 {rate:>4}  命中 {c["命中"]}  不符 {c["不符"]}  無法判斷 {c["無法判斷"]}  未填 {c["未填"]}')


if __name__ == '__main__':
    main()
