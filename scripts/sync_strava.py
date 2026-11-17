#!/usr/bin/env python3
"""Strava 기록을 주기적으로 새로 받아 data/activities.json 을 갱신한다.

두 가지 경로를 지원하며, 있는 시크릿에 따라 자동으로 고른다.

1) 공식 API (권장) — 저장소 시크릿 3개가 모두 있을 때
     STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
   * Strava는 2026년부터 무료 계정의 API 사용을 제한하고 있어, 계정이
     유료(Subscription)일 때 동작한다.

2) 웹 세션 쿠키 — 시크릿 STRAVA_COOKIE 가 있을 때
     값은 브라우저 개발자도구에서 복사한 `_strava4_session=...` 문자열.
   * 웹 트레이닝 로그 JSON 엔드포인트를 X-Requested-With 헤더로 호출한다.
   * 세션 쿠키는 만료되므로(수 주~수 개월) 만료되면 새 값으로 교체해야 한다.

민감정보는 절대 코드/커밋에 남기지 않는다. 이 스크립트는 환경변수만 읽는다.
"""
import json, os, sys, datetime, urllib.request, urllib.parse, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'activities.json')
POLY_DIR = os.path.join(ROOT, 'data', 'polylines')
RUN_TYPES = {'Run', 'Trail Run', 'Virtual Run'}
KST = datetime.timezone(datetime.timedelta(hours=9))
UA = 'running-dashboard-sync/1.0'


def http(url, data=None, headers=None, method=None):
    h = {'User-Agent': UA, 'Accept': 'application/json'}
    h.update(headers or {})
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        h['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


# ── 1) 공식 API ────────────────────────────────────────────────
def fetch_api():
    cid = os.environ['STRAVA_CLIENT_ID']
    sec = os.environ['STRAVA_CLIENT_SECRET']
    ref = os.environ['STRAVA_REFRESH_TOKEN']
    tok = http('https://www.strava.com/oauth/token',
               {'client_id': cid, 'client_secret': sec,
                'refresh_token': ref, 'grant_type': 'refresh_token'}, method='POST')
    access = tok['access_token']

    gears = {}
    try:
        athlete = http('https://www.strava.com/api/v3/athlete',
                       headers={'Authorization': f'Bearer {access}'})
        for s in athlete.get('shoes', []) or []:
            gears[str(s['id'])] = s.get('name') or str(s['id'])
    except Exception as e:
        print('gear lookup skipped:', e, file=sys.stderr)

    out = []
    page = 1
    while True:
        batch = http(
            'https://www.strava.com/api/v3/athlete/activities?per_page=200&page=%d' % page,
            headers={'Authorization': f'Bearer {access}'})
        if not batch:
            break
        for a in batch:
            sport = a.get('sport_type') or a.get('type') or ''
            if sport not in RUN_TYPES:
                continue
            start = a.get('start_date_local') or a.get('start_date')
            dt = datetime.datetime.fromisoformat(start.replace('Z', '+00:00'))
            rec = {
                'id': str(a['id']),
                'd': dt.astimezone(KST).isoformat(timespec='seconds'),
                'dist': round(a.get('distance') or 0),
                'mv': int(a.get('moving_time') or 0),
                'el': round(a.get('total_elevation_gain') or 0),
                'sport': sport,
                'name': a.get('name') or '러닝',
            }
            if a.get('average_heartrate'):
                rec['hr'] = round(a['average_heartrate'], 1)
            if a.get('max_heartrate'):
                rec['mxhr'] = round(a['max_heartrate'], 1)
            if a.get('average_cadence'):
                rec['cad'] = round(a['average_cadence'] * 2)   # strides/min → spm
            if a.get('gear_id') and a['gear_id'] in gears:
                rec['gear'] = gears[a['gear_id']]
            if a.get('description'):
                rec['desc'] = a['description'][:400]
            poly = ((a.get('map') or {}).get('summary_polyline') or '').strip()
            out.append((rec, poly or None))
        page += 1
        if len(batch) < 200 or page > 40:
            break
        time.sleep(0.4)
    return out


# ── 2) 웹 세션 쿠키 ───────────────────────────────────────────
def fetch_web():
    cookie = os.environ['STRAVA_COOKIE'].strip()
    out = []
    for page in range(1, 200):
        url = ('https://www.strava.com/athlete/training_activities?' +
               urllib.parse.urlencode({
                   'keywords': '', 'sport_type': 'Run', 'tags': '',
                   'commute': '', 'private_activities': '', 'trainer': '',
                   'gear': '', 'new_activity_only': 'false',
                   'page': page, 'per_page': 20,
               }))
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': cookie,
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode())
        models = payload.get('models') or []
        if not models:
            break
        for m in models:
            sport = m.get('sport_type') or 'Run'
            if sport not in RUN_TYPES:
                continue
            ts = m.get('start_date_local_raw') or m.get('start_time_local_raw')
            if not ts:
                continue
            dt = datetime.datetime.fromtimestamp(int(ts), KST)
            rec = {
                'id': str(m.get('id_str') or m.get('id')),
                'd': dt.isoformat(timespec='seconds'),
                'dist': round(m.get('distance_raw') or 0),
                'mv': int(m.get('moving_time_raw') or 0),
                'el': round(m.get('elevation_gain_raw') or 0),
                'sport': sport,
                'name': m.get('name') or '러닝',
            }
            if m.get('description'):
                rec['desc'] = m['description'][:400]
            out.append((rec, None))
        if len(models) < 20:
            break
        time.sleep(0.5)
    return out


def main():
    if all(os.environ.get(k) for k in ('STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN')):
        mode, fetched = 'api', fetch_api()
    elif os.environ.get('STRAVA_COOKIE'):
        mode, fetched = 'web', fetch_web()
    else:
        print('동기화 건너뜀: STRAVA_* 시크릿이 설정되어 있지 않습니다.')
        return 0

    existing = {'meta': {}, 'activities': []}
    if os.path.exists(DATA):
        existing = json.load(open(DATA, encoding='utf-8'))
    by_id = {a['id']: a for a in existing.get('activities', [])}
    before = len(by_id)
    os.makedirs(POLY_DIR, exist_ok=True)
    poly_cache = {}
    added = 0

    for rec, poly in fetched:
        if rec['id'] not in by_id:
            added += 1
        by_id[rec['id']] = {**by_id.get(rec['id'], {}), **rec}
        if poly:
            y = rec['d'][:4]
            if y not in poly_cache:
                p = os.path.join(POLY_DIR, f'{y}.json')
                poly_cache[y] = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
            poly_cache[y][rec['id']] = poly

    acts = sorted(by_id.values(), key=lambda x: x['d'], reverse=True)
    meta = {
        'athlete': existing.get('meta', {}).get('athlete', '서율아빠 동작'),
        'athleteUrl': 'https://www.strava.com/dashboard',
        'source': f'Strava {mode} 동기화',
        'generated_at': datetime.datetime.now(KST).isoformat(timespec='seconds'),
        'count': len(acts),
        'totalKm': round(sum(a.get('dist', 0) for a in acts) / 1000, 1),
        'totalHours': round(sum(a.get('mv', 0) for a in acts) / 3600, 1),
        'years': sorted({int(a['d'][:4]) for a in acts}),
        'timezone': 'Asia/Seoul',
    }
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    json.dump({'meta': meta, 'activities': acts}, open(DATA, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    for y, d in poly_cache.items():
        json.dump(d, open(os.path.join(POLY_DIR, f'{y}.json'), 'w', encoding='utf-8'),
                  separators=(',', ':'))
    print(f'{mode} 동기화 완료: {before} → {len(acts)}개 (신규 {added}개)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
