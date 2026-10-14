"""Shared helpers: TWD97 TM2 (EPSG:3826) to WGS84, a grid index for nearest-point lookups, CSV loading."""
import csv
import math
from collections import defaultdict

# TWD97 TM2 zone 121: GRS80 ellipsoid, central meridian 121E, scale 0.9999, false easting 250 km.
_A = 6378137.0
_F = 1 / 298.257222101
_K0 = 0.9999
_LON0 = math.radians(121)
_FE = 250000.0
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_E1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))


def twd97_to_wgs84(x, y):
    """Inverse transverse Mercator (Snyder 1987, eqs. 8-18 to 8-25). Returns (lon, lat) in degrees.

    TWD97 and WGS84 differ by well under a metre, so no datum shift is applied.
    """
    mu = y / _K0 / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    phi1 = (mu
            + (3 * _E1 / 2 - 27 * _E1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * _E1 ** 2 / 16 - 55 * _E1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * _E1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * _E1 ** 4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1 = _EP2 * c * c
    t1 = t * t
    n1 = _A / math.sqrt(1 - _E2 * s * s)
    r1 = _A * (1 - _E2) / (1 - _E2 * s * s) ** 1.5
    d = (x - _FE) / (n1 * _K0)
    lat = phi1 - (n1 * t / r1) * (
        d ** 2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * _EP2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * _EP2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = _LON0 + (
        d
        - (1 + 2 * t1 + c1) * d ** 3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * _EP2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    return math.degrees(lon), math.degrees(lat)


class PointIndex:
    """Buckets points into square cells so a nearest-point lookup only scans the cells around it."""

    def __init__(self, items, cell=10.0):
        """items: iterable of (x, y, payload) in metres."""
        self.cell = cell
        self.buckets = defaultdict(list)
        for x, y, payload in items:
            self.buckets[(int(x // cell), int(y // cell))].append((x, y, payload))

    def nearest(self, x, y, max_dist):
        """Return (distance, payload) of the closest point within max_dist, else (inf, None)."""
        k = int(math.ceil(max_dist / self.cell))
        gx, gy = int(x // self.cell), int(y // self.cell)
        best, hit = math.inf, None
        for i in range(gx - k, gx + k + 1):
            for j in range(gy - k, gy + k + 1):
                for px, py, payload in self.buckets.get((i, j), ()):
                    d = math.hypot(x - px, y - py)
                    if d < best:
                        best, hit = d, payload
        return (best, hit) if best <= max_dist else (math.inf, None)


def load_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def tree_xy(row):
    """(x, y) from a tree row's TWD97 columns, or None when they are blank or malformed."""
    try:
        return float(row['TWD97X']), float(row['TWD97Y'])
    except (KeyError, ValueError):
        return None
