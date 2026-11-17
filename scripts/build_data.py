#!/usr/bin/env python3
"""Strava 아카이브(activities.csv) + polyline 원본 → 대시보드용 데이터 파일 생성.

  python3 scripts/build_data.py archive_out/activities.csv raw/polylines_raw.json data

결과
  data/activities.json          활동 요약(전체 러닝) + meta
  data/polylines/<연도>.json     활동 id → 인코딩 polyline
"""
import csv, json, os, sys, datetime, collections

RUN_TYPES = {'Run', 'Trail Run', 'Virtual Run'}
KST = datetime.timezone(datetime.timedelta(hours=9))


def parse_dt(s):
    s = (s or '').strip()
    if not s:
        return None
    for fmt in ('%b %d, %Y, %I:%M:%S %p', '%b %d, %Y, %H:%M:%S', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.datetime.strptime(s, fmt).replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
    return None


def fnum(v):
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else 'archive_out/activities.csv'
    poly_path = sys.argv[2] if len(sys.argv) > 2 else 'raw/polylines_raw.json'
    outdir = sys.argv[3] if len(sys.argv) > 3 else 'data'

    rows = list(csv.reader(open(csv_path, encoding='utf-8')))
    hdr = rows[0]
    # 같은 이름 컬럼이 두 번 나오므로(km 표기 / 원시값) 원시값 쪽을 쓴다
    col = {}
    for i, h in enumerate(hdr):
        col[h] = i          # 나중(원시값) 인덱스가 남는다
    # 'Distance'(km, 사람이 읽는 값)는 6번, 원시 미터는 17번
    i_id = col['Activity ID']
    i_date = col['Activity Date']
    i_name = col['Activity Name']
    i_type = col['Activity Type']
    i_desc = col['Activity Description']
    i_mv = 16                    # Moving Time (초)
    i_dist = 17                  # Distance (m)
    i_el = col['Elevation Gain']
    i_hr = col['Average Heart Rate']
    i_mxhr = col['Max Heart Rate']
    i_cad = col['Average Cadence']
    i_cal = col['Calories']
    i_gear = col['Gear']
    i_file = col['Filename']
    i_tag = col['Tag']

    raw_polys = {}
    if os.path.exists(poly_path):
        raw_polys = json.load(open(poly_path))

    acts, polys_by_year = [], collections.defaultdict(dict)
    for r in rows[1:]:
        if len(r) <= i_dist:
            continue
        sport = (r[i_type] or '').strip()
        if sport not in RUN_TYPES:
            continue
        dt = parse_dt(r[i_date])
        if not dt:
            continue
        local = dt.astimezone(KST)
        dist = fnum(r[i_dist])
        if dist is None:
            dist = (fnum(r[6]) or 0) * 1000
        fname = (r[i_file] or '').strip()
        base = os.path.basename(fname)
        for suf in ('.gz', '.gpx', '.fit'):
            if base.lower().endswith(suf):
                base = base[: -len(suf)]
        poly = raw_polys.get(base)

        a = {
            'id': r[i_id].strip(),
            'd': local.isoformat(timespec='seconds'),
            'dist': round(dist),
            'mv': int(fnum(r[i_mv]) or 0),
            'el': round(fnum(r[i_el]) or 0),
            'sport': sport,
            'name': (r[i_name] or '').strip() or '러닝',
        }
        gear = (r[i_gear] or '').strip()
        if gear:
            a['gear'] = gear
        hr = fnum(r[i_hr]); mx = fnum(r[i_mxhr]); cad = fnum(r[i_cad]); cal = fnum(r[i_cal])
        if hr: a['hr'] = round(hr, 1)
        if mx: a['mxhr'] = round(mx, 1)
        if cad: a['cad'] = round(cad)
        if cal: a['cal'] = round(cal)
        desc = (r[i_desc] or '').strip()
        if desc:
            a['desc'] = desc[:400]
        tag = (r[i_tag] or '').strip()
        if tag:
            a['tag'] = tag
        acts.append(a)
        if poly:
            polys_by_year[local.year][a['id']] = poly

    acts.sort(key=lambda x: x['d'], reverse=True)
    total_m = sum(a['dist'] for a in acts)
    total_s = sum(a['mv'] for a in acts)

    os.makedirs(outdir, exist_ok=True)
    os.makedirs(os.path.join(outdir, 'polylines'), exist_ok=True)
    meta = {
        'athlete': '서율아빠 동작',
        'athleteUrl': 'https://www.strava.com/dashboard',
        'source': 'Strava 전체 기록 내보내기(archive)',
        'generated_at': datetime.datetime.now(KST).isoformat(timespec='seconds'),
        'count': len(acts),
        'withPolyline': sum(len(v) for v in polys_by_year.values()),
        'totalKm': round(total_m / 1000, 1),
        'totalHours': round(total_s / 3600, 1),
        'years': sorted({int(a['d'][:4]) for a in acts}),
        'timezone': 'Asia/Seoul',
    }
    with open(os.path.join(outdir, 'activities.json'), 'w') as fh:
        json.dump({'meta': meta, 'activities': acts}, fh, ensure_ascii=False, separators=(',', ':'))

    for y, d in polys_by_year.items():
        with open(os.path.join(outdir, 'polylines', f'{y}.json'), 'w') as fh:
            json.dump(d, fh, separators=(',', ':'))

    print(json.dumps(meta, ensure_ascii=False, indent=1))
    for y in sorted(polys_by_year):
        print(y, 'polylines', len(polys_by_year[y]))


if __name__ == '__main__':
    main()
