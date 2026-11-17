#!/usr/bin/env python3
"""스트리밍 ZIP 리더 — Strava 아카이브(2.6GB)를 저장하지 않고 필요한 것만 뽑는다.

- activities.csv 추출
- activities/*.gpx → 단순화한 인코딩 polyline으로 변환해 JSON 저장
- 엔트리 목록(manifest) 기록

사용: curl -sS URL | python3 stream_archive.py archive_out polylines_raw.json
"""
import sys, os, re, json, struct, zlib, gzip

SIG_LOCAL = b'PK\x03\x04'
SIG_DD = b'PK\x07\x08'


class Reader:
    def __init__(self, f):
        self.f = f
        self.buf = b''

    def read(self, n):
        if n <= 0:
            return b''
        if self.buf:
            if len(self.buf) >= n:
                d, self.buf = self.buf[:n], self.buf[n:]
                return d
            d, self.buf = self.buf, b''
            return d + self.f.read(n - len(d))
        return self.f.read(n)

    def unread(self, b):
        if b:
            self.buf = b + self.buf

    def read_until_eof(self, chunk=1 << 20):
        while True:
            d = self.f.read(chunk)
            if not d:
                return
            yield d


def simplify(points, tol=8e-5):
    """Douglas-Peucker (경위도 평면 근사)."""
    if len(points) < 3:
        return points
    # 최대 편차가 큰 점을 기준으로 재귀 분할
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points):
    out = []
    prev_lat = prev_lng = 0
    for lat, lng in points:
        ilat = int(round(lat * 1e5))
        ilng = int(round(lng * 1e5))
        for delta in (ilat - prev_lat, ilng - prev_lng):
            v = ~(delta << 1) if delta < 0 else (delta << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lng = ilat, ilng
    return ''.join(out)


TRKPT = re.compile(rb'<trkpt[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"')

SEMI = 180.0 / (1 << 31)


def fit_to_polyline(fit):
    """FIT 파일에서 record(20) 메시지의 위·경도만 뽑아 polyline으로."""
    n = len(fit)
    if n < 14 or fit[8:12] != b'.FIT':
        return None
    pos = fit[0]
    defs = {}
    pts = []
    try:
        while pos < n:
            h = fit[pos]
            pos += 1
            if h & 0x40:                      # definition message
                local = h & 0x0F
                pos += 1                       # reserved
                arch = fit[pos]
                pos += 1
                endian = 'little' if arch == 0 else 'big'
                gnum = int.from_bytes(fit[pos:pos + 2], endian)
                pos += 2
                nf = fit[pos]
                pos += 1
                fields = []
                for _ in range(nf):
                    fields.append((fit[pos], fit[pos + 1]))
                    pos += 3
                devneed = 0
                if h & 0x20:                   # developer fields (필드마다 3바이트 정의)
                    dn = fit[pos]
                    pos += 1
                    for _ in range(dn):
                        devneed += fit[pos + 1]
                        pos += 3
                defs[local] = (gnum, fields, devneed)
                continue
            local = (h >> 5) & 0x03 if h & 0x80 else h & 0x0F
            d = defs.get(local)
            if not d:
                break
            gnum, fields, devneed = d
            need = sum(f[1] for f in fields) + devneed
            payload = fit[pos:pos + need]
            pos += need
            if gnum == 20 and len(pts) < 30000:
                off = 0
                lat = lng = None
                for fnum, size in fields:
                    if fnum == 0 and size == 4:
                        v = int.from_bytes(payload[off:off + 4], 'little', signed=True)
                        if v != 0x7FFFFFFF:
                            lat = v * SEMI
                    elif fnum == 1 and size == 4:
                        v = int.from_bytes(payload[off:off + 4], 'little', signed=True)
                        if v != 0x7FFFFFFF:
                            lng = v * SEMI
                    off += size
                if lat is not None and lng is not None and abs(lat) <= 90 and abs(lng) <= 180 and (lat or lng):
                    pts.append((lat, lng))
    except (IndexError, ValueError):
        pass
    if len(pts) < 2:
        return None
    pts = simplify(pts, 8e-5)
    if len(pts) > 800:
        step = len(pts) // 800 + 1
        pts = pts[::step]
    return encode_polyline(pts)


def gpx_to_polyline(data):
    pts = [(float(a), float(b)) for a, b in TRKPT.findall(data)]
    if len(pts) < 2:
        return None
    pts = simplify(pts, 8e-5)
    if len(pts) > 800:
        step = len(pts) // 800 + 1
        pts = pts[::step]
    return encode_polyline(pts)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else 'archive_out'
    poly_path = sys.argv[2] if len(sys.argv) > 2 else 'polylines_raw.json'
    os.makedirs(outdir, exist_ok=True)
    r = Reader(sys.stdin.buffer)
    polys = {}
    manifest = []
    n_entries = 0
    total = 0

    while True:
        sig = r.read(4)
        if len(sig) < 4:
            break
        if sig == b'PK\x01\x02':      # central directory 시작 → 끝
            break
        if sig != SIG_LOCAL:
            r.unread(sig)
            break
        fixed = r.read(26)
        if len(fixed) < 26:
            break
        (_ver, flags, method, _t, _d, _crc, csize, usize, nlen, elen) = struct.unpack('<HHHHHIIIHH', fixed)
        name = r.read(nlen).decode('utf-8', 'replace')
        extra = r.read(elen)
        n_entries += 1

        low = name.lower()
        want_gpx = name.startswith('activities/') and low.endswith('.gpx')
        want_fit = name.startswith('activities/') and low.endswith(('.fit.gz', '.fit'))
        want_csv = name.endswith('activities.csv')
        interesting = want_gpx or want_fit or want_csv

        if (flags & 0x08) or csize == 0:
            # 크기를 모르는 경우: deflate 스트림이 끝날 때까지 읽는다
            if method != 8:
                continue
            d = zlib.decompressobj(-15)
            chunks = []
            while not d.eof:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                out = d.decompress(chunk)
                if interesting:
                    chunks.append(out)
                total += len(chunk)
                if d.eof:
                    r.unread(d.unused_data)
            data = b''.join(chunks)
            dd = r.read(4)
            if dd != SIG_DD:
                r.unread(dd)
                r.read(12)
            else:
                r.read(12)
        else:
            if method == 0:
                data = r.read(csize)
                total += csize
            elif method == 8:
                buf = []
                left = csize
                d = zlib.decompressobj(-15)
                while left > 0:
                    chunk = r.read(min(1 << 16, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    total += len(chunk)
                    if interesting:
                        buf.append(d.decompress(chunk))
                data = b''.join(buf)
            else:
                r.read(csize)
                total += csize
                continue

        if want_csv:
            p = os.path.join(outdir, 'activities.csv')
            with open(p, 'wb') as fh:
                fh.write(data)
            print(f'[csv] {name} {len(data)} bytes', file=sys.stderr, flush=True)
        elif want_gpx or want_fit:
            base = os.path.basename(name)
            for suf in ('.gz', '.gpx', '.fit'):
                if base.lower().endswith(suf):
                    base = base[: -len(suf)]
            raw = data
            if low.endswith('.gz'):
                try:
                    raw = gzip.decompress(data)
                except Exception:
                    raw = b''
            enc = gpx_to_polyline(raw) if want_gpx else fit_to_polyline(raw)
            if enc:
                polys[base] = enc
        else:
            manifest.append(f'{name}\t{len(data)}')

        if n_entries % 200 == 0:
            print(f'[..] {n_entries} entries, {total/1e6:.0f} MB read, {len(polys)} gpx', file=sys.stderr, flush=True)

    with open(poly_path, 'w') as fh:
        json.dump(polys, fh, separators=(',', ':'))
    with open(os.path.join(outdir, 'manifest.txt'), 'w') as fh:
        fh.write('\n'.join(manifest))
    print(json.dumps({'entries': n_entries, 'mb': round(total / 1e6, 1), 'polylines': len(polys)}))


if __name__ == '__main__':
    main()
