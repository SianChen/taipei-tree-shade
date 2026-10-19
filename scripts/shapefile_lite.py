"""Minimal reader for polygon shapefiles (.shp + .dbf), read straight out of a zip archive.

Supports shape type 5 (Polygon) only, which is all the village boundary and zoning files use.
"""
import struct
import zipfile


def read_dbf(data, encoding):
    n_records, header_len, record_len = struct.unpack('<IHH', data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\0', 1)[0].decode(encoding)
        fields.append((name, data[pos + 16]))
        pos += 32
    records = []
    for i in range(n_records):
        rec = data[header_len + i * record_len: header_len + (i + 1) * record_len]
        values, off = {}, 1  # byte 0 is the deletion flag
        for name, length in fields:
            values[name] = rec[off:off + length].decode(encoding, 'replace').strip()
            off += length
        records.append(None if rec[:1] == b'*' else values)
    return records


def read_shp_polygons(data):
    """Yield each record's rings as lists of (x, y), or None for a null shape."""
    pos = 100
    while pos < len(data):
        content_len = struct.unpack('>i', data[pos + 4:pos + 8])[0] * 2
        content = data[pos + 8: pos + 8 + content_len]
        pos += 8 + content_len
        shape_type = struct.unpack('<i', content[:4])[0]
        if shape_type == 0:
            yield None
            continue
        if shape_type != 5:
            raise ValueError(f'unsupported shape type {shape_type}')
        n_parts, n_points = struct.unpack('<ii', content[36:44])
        parts = list(struct.unpack(f'<{n_parts}i', content[44:44 + 4 * n_parts]))
        pts_off = 44 + 4 * n_parts
        coords = struct.unpack(f'<{2 * n_points}d', content[pts_off:pts_off + 16 * n_points])
        points = list(zip(coords[0::2], coords[1::2]))
        yield [points[a:b] for a, b in zip(parts, parts[1:] + [n_points])]


def member_name(info, encoding):
    """The zip member's name. Names not flagged as UTF-8 come back from zipfile as cp437; re-read them in `encoding`."""
    if info.flag_bits & 0x800:
        return info.filename
    return info.filename.encode('cp437').decode(encoding, 'replace')


def read_zip(path, stem, encoding=None):
    """Return [(attributes, rings)] for the shapefile `stem` inside the zip at `path`.

    encoding: the DBF text and member-name encoding, for files without a .cpg (e.g. 'cp950' for Big5).
    """
    with zipfile.ZipFile(path) as z:
        names = {}
        for info in z.infolist():
            name = member_name(info, encoding or 'utf-8')
            if name.rsplit('.', 1)[0] == stem:
                names[name.rsplit('.', 1)[-1].lower()] = info.filename
        if encoding is None:
            encoding = 'utf-8'
            if 'cpg' in names:
                encoding = z.read(names['cpg']).decode('ascii').strip() or encoding
        records = read_dbf(z.read(names['dbf']), encoding)
        shapes = list(read_shp_polygons(z.read(names['shp'])))
    return [(attrs, rings) for attrs, rings in zip(records, shapes) if attrs is not None]
