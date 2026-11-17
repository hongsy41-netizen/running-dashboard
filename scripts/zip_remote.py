#!/usr/bin/env python3
"""원격 ZIP에서 필요한 엔트리만 Range 요청으로 꺼낸다.

Strava 아카이브(2.6GB)를 통째로 받지 않고, central directory를 읽어
특정 파일(.fit.gz / .gpx)만 부분 다운로드한다.

  python3 scripts/zip_remote.py list <url> [필터]
  python3 scripts/zip_remote.py extract <url> <엔트리이름> <출력경로>
"""
import sys, io, gzip, zlib, json, struct, urllib.request

UA = 'running-dashboard/1.0'


def fetch(url, start=None, end=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    if start is not None:
        req.add_header('Range', f'bytes={start}-{end if end is not None else ""}')
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read(), r.headers.get('Content-Range'), r.status


def total_size(url):
    body, crange, status = fetch(url, 0, 0)
    if crange and '/' in crange:
        return int(crange.split('/')[-1])
    return None


def central_directory(url, size):
    tail_len = min(size, 70000)
    tail, _, _ = fetch(url, size - tail_len, size - 1)
    idx = tail.rfind(b'PK\x05\x06')
    if idx < 0:
        raise RuntimeError('EOCD not found')
    (_sig, _disk, _cddisk, _n_disk, n_total, cd_size, cd_off, _clen) = struct.unpack_from('<IHHHHIIH', tail, idx)
    cd, _, _ = fetch(url, cd_off, cd_off + cd_size - 1)
    entries = []
    p = 0
    while p + 46 <= len(cd) and cd[p:p + 4] == b'PK\x01\x02':
        (sig, _vm, _vn, _fl, method, _t, _d, _crc, csize, usize,
         nlen, elen, clen, _diskno, _iattr, _eattr, loff) = struct.unpack_from('<IHHHHHHIIIHHHHHII', cd, p)
        name = cd[p + 46:p + 46 + nlen].decode('utf-8', 'replace')
        entries.append({'name': name, 'method': method, 'csize': csize,
                        'usize': usize, 'loff': loff})
        p += 46 + nlen + elen + clen
    return entries


def extract(url, entry):
    head, _, _ = fetch(url, entry['loff'], entry['loff'] + 29)
    if head[:4] != b'PK\x03\x04':
        raise RuntimeError('bad local header')
    nlen, elen = struct.unpack_from('<HH', head, 26)
    start = entry['loff'] + 30 + nlen + elen
    raw, _, _ = fetch(url, start, start + entry['csize'] - 1)
    if entry['method'] == 0:
        data = raw
    elif entry['method'] == 8:
        data = zlib.decompress(raw, -15)
    else:
        raise RuntimeError('unsupported method %s' % entry['method'])
    if entry['name'].lower().endswith('.gz'):
        data = gzip.decompress(data)
    return data


def main():
    cmd = sys.argv[1]
    url = sys.argv[2]
    size = total_size(url)
    entries = central_directory(url, size)
    if cmd == 'list':
        pat = sys.argv[3] if len(sys.argv) > 3 else ''
        hits = [e for e in entries if pat in e['name']]
        print(json.dumps({'size': size, 'entries': len(entries), 'hits': len(hits),
                          'sample': [e['name'] for e in hits[:5]]}))
        return
    name = sys.argv[3]
    entry = next(e for e in entries if e['name'] == name)
    data = extract(url, entry)
    with open(sys.argv[4], 'wb') as fh:
        fh.write(data)
    print(json.dumps({'name': name, 'bytes': len(data)}))


if __name__ == '__main__':
    main()
