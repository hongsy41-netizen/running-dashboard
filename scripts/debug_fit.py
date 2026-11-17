#!/usr/bin/env python3
"""FIT 파싱 실패 원인 진단용 — 아카이브를 스트리밍하며 .fit.gz 몇 개를 자세히 본다."""
import sys, os, gzip, json, struct, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stream_archive import Reader, SIG_LOCAL, SIG_DD


def parse_debug(fit):
    info = {'len': len(fit)}
    if len(fit) < 14:
        info['err'] = 'too short'
        return None, info
    if fit[8:12] != b'.FIT':
        info['err'] = 'no .FIT magic: %r' % fit[8:12]
        return None, info
    hdr = fit[0]
    info['hdr'] = hdr
    info['proto'] = fit[1]
    info['profile'] = struct.unpack('<H', fit[2:4])[0]
    info['data_size'] = struct.unpack('<I', fit[4:8])[0]
    pos = hdr
    n = len(fit)
    defs = {}
    pts = 0
    msgs = 0
    try:
        while pos < n:
            h = fit[pos]
            pos += 1
            if h & 0x40:
                local = h & 0x0F
                pos += 1
                arch = fit[pos]; pos += 1
                endian = 'little' if arch == 0 else 'big'
                gnum = int.from_bytes(fit[pos:pos + 2], endian); pos += 2
                nf = fit[pos]; pos += 1
                fields = []
                for _ in range(nf):
                    fields.append((fit[pos], fit[pos + 1])); pos += 3
                if h & 0x20:
                    dn = fit[pos]; pos += 1
                    pos += dn * 3
                defs[local] = (gnum, fields)
                continue
            local = (h >> 5) & 0x03 if h & 0x80 else h & 0x0F
            d = defs.get(local)
            if not d:
                info['err'] = 'unknown local %s at %d (hdr=%02x)' % (local, pos - 1, h)
                break
            gnum, fields = d
            need = sum(f[1] for f in fields)
            payload = fit[pos:pos + need]
            pos += need
            msgs += 1
            if gnum == 20:
                off = 0
                lat = lng = None
                for fnum, size in fields:
                    if fnum == 0 and size == 4:
                        lat = int.from_bytes(payload[off:off + 4], 'little', signed=True)
                    elif fnum == 1 and size == 4:
                        lng = int.from_bytes(payload[off:off + 4], 'little', signed=True)
                    off += size
                if lat is not None and lng is not None:
                    pts += 1
    except Exception as e:
        info['err'] = '%s at %d' % (e, pos)
    info['msgs'] = msgs
    info['pts'] = pts
    info['defs'] = {k: v[0] for k, v in defs.items()}
    return pts, info


def main():
    r = Reader(sys.stdin.buffer)
    shown = 0
    ok = bad = 0
    total = 0
    while True:
        sig = r.read(4)
        if len(sig) < 4 or sig != SIG_LOCAL:
            break
        fixed = r.read(26)
        (_v, flags, method, _t, _d, _c, csize, usize, nlen, elen) = struct.unpack('<HHHHHIIIHH', fixed)
        name = r.read(nlen).decode('utf-8', 'replace')
        r.read(elen)
        want = name.startswith('activities/') and name.lower().endswith('.fit.gz')
        if (flags & 0x08) or csize == 0:
            d = zlib.decompressobj(-15)
            buf = []
            while not d.eof:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                out = d.decompress(chunk)
                if want and out:
                    buf.append(out)
                if d.eof:
                    r.unread(d.unused_data)
            data = b''.join(buf)
            dd = r.read(4)
            if dd != SIG_DD:
                r.unread(dd); r.read(12)
            else:
                r.read(12)
        else:
            if method == 8:
                left = csize
                buf = []
                d = zlib.decompressobj(-15)
                while left > 0:
                    chunk = r.read(min(1 << 16, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    if want:
                        buf.append(d.decompress(chunk))
                data = b''.join(buf)
            else:
                r.read(csize)
                continue
        if not want:
            continue
        total += 1
        try:
            raw = gzip.decompress(data)
        except Exception as e:
            bad += 1
            if shown < 6:
                print('GZIP FAIL', name, e); shown += 1
            continue
        pts, info = parse_debug(raw)
        if pts and pts >= 2:
            ok += 1
        else:
            bad += 1
            if shown < 6:
                print('FIT FAIL', name, json.dumps(info, ensure_ascii=False)[:400]); shown += 1
    print(json.dumps({'total': total, 'ok': ok, 'bad': bad}))


if __name__ == '__main__':
    main()
