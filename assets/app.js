/* ─────────────────────────────────────────────────────────────
   서율아빠의 러닝 대시보드
   data/activities.json 을 읽어 모든 화면을 브라우저에서 그립니다.
   (빌드 도구 없음 · 정적 GitHub Pages)
   ───────────────────────────────────────────────────────────── */
(() => {
'use strict';

const DATA_URL = 'data/activities.json';
const POLY_URL = (year) => `data/polylines/${year}.json`;
const PAGE_SIZE = 25;
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];   // 0 = 월요일
const HEAT_LEVELS = [4, 8, 12, 18, 25];                        // km 기준 색 구간
const MONTHS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
const ESRI_LIGHT = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = '지도 © Esri, HERE, Garmin, OpenStreetMap contributors';
const MIN_PACE = 180;                                          // 3분/km 미만은 이상치로 제외
const GOAL_DEFAULT = { year: 3000, week: 60 };                  // km
const GOAL_KEY = { year: 'running-dashboard.goalYearKm', week: 'running-dashboard.goalWeekKm' };
const PR_BRACKETS = [
  { key: '5k',   label: '5K',   min: 4950,  target: 5000 },
  { key: '10k',  label: '10K',  min: 9900,  target: 10000 },
  { key: 'half', label: '하프', min: 21000, target: 21097.5 },
  { key: 'full', label: '풀',   min: 42000, target: 42195 },
];
const LIST_DISTS = [
  { key: 'all',  label: '전체 거리',  test: () => true },
  { key: '10',   label: '10km+',      test: (a) => km(a.dist) >= 10 },
  { key: 'half', label: '하프 21km+', test: (a) => km(a.dist) >= 21 },
  { key: 'full', label: '풀 42km+',   test: (a) => km(a.dist) >= 42 },
];
const LIST_SORTS = [
  { key: 'recent',  label: '최신순',       fn: (a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0) },
  { key: 'longest', label: '최장 거리순',   fn: (a, b) => num(b.dist) - num(a.dist) },
  { key: 'fastest', label: '빠른 페이스순', fn: (a, b) => (a.pace || 1e9) - (b.pace || 1e9) },
];

const state = {
  acts: [],
  meta: {},
  heatYear: null,
  monthYear: null,
  listYear: 'all',
  listDist: 'all',
  listSort: 'recent',
  search: '',
  shown: PAGE_SIZE,
  hrYear: null,
  polyCache: new Map(),
  charts: {},
  map: null,
  mapLayer: null,
};

// 종합 코스 지도 상태
const routeState = { key: null, map: null, layer: null, canvas: null, bounds: null, pts: [], stats: new Map(), token: 0 };

/* ── 작은 도우미들 ─────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function km(m) { return num(m) / 1000; }
function fmtKm(m) {
  const v = km(m);
  if (v >= 1000) return Math.round(v).toLocaleString('ko-KR');
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(2).replace(/\.?0+$/, '');
}
function fmtDuration(sec) {                       // 1:24:07
  sec = Math.round(num(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
               : `${m}:${String(s).padStart(2,'0')}`;
}
function fmtTotal(sec) {                          // 512시간 30분
  sec = Math.round(num(sec));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h.toLocaleString('ko-KR')}시간 ${m}분` : `${m}분`;
}
function fmtPace(meters, sec, allowZero = false) { // 5'32"/km
  const k = km(meters);
  if (!k || k < (allowZero ? 0.05 : 0.2) || !sec) return '—';
  const p = Math.round(sec / k);
  const m = Math.floor(p / 60), s = p % 60;
  return `${m}'${String(s).padStart(2,'0')}"`;
}
function paceSec(meters, sec) { const k = km(meters); return k > 0.2 && sec > 0 ? sec / k : null; }
function parseDate(iso) {                          // "2026-11-17T05:17:45+09:00"
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], date: `${m[1]}-${m[2]}-${m[3]}` };
}
const wkIdx = (d) => (new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).getUTCDay() + 6) % 7; // 월=0
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function daysBetween(a, b) {                        // b - a (일)
  const A = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const B = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((B - A) / 86400000);
}
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ── 데이터 준비 ───────────────────────────────────────────── */
async function boot() {
  let json;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    json = await res.json();
  } catch (err) {
    $('#kpi').innerHTML = `<div class="empty-state">데이터를 불러오지 못했어요 (${err.message}).</div>`;
    return;
  }
  state.meta = json.meta || {};
  state.acts = (json.activities || [])
    .map((a) => {
      const p = parseDate(a.d) || {};
      const wd = p.date ? wkIdx(new Date(p.y, p.mo - 1, p.d)) : 0;
      return Object.assign({}, a, {
        p, year: p.y, month: p.mo, weekday: wd, hour: p.h,
        pace: paceSec(a.dist, a.mv),
      });
    })
    .filter((a) => a.year)
    .sort((a, b) => (a.d < b.d ? 1 : -1));

  const errors = [];
  const safe = (name, fn) => {
    try { fn(); } catch (e) { errors.push(`${name}: ${e && e.message || e}`); console.error(name, e); }
  };
  safe('header', renderHeader);
  safe('kpis', renderKpis);
  safe('goals', renderGoals);
  safe('prs', renderPrBoard);
  safe('route', () => { renderRoutePanel().catch((e) => console.error('route', e)); });
  safe('heatTabs', renderHeatmapTabs);
  safe('heatmap', () => renderHeatmap(state.heatYear));
  safe('monthlyYears', renderMonthlyYearOptions);
  safe('monthly', () => renderMonthly(state.monthYear));
  safe('yearly', renderYearly);
  safe('weekday', renderWeekday);
  safe('hour', renderHour);
  safe('hrYears', renderHrYears);
  safe('hr', () => renderHr(state.hrYear));
  safe('records', renderRecords);
  safe('gear', renderGear);
  safe('listYears', renderListYears);
  safe('list', renderList);
  document.body.dataset.renderErrors = errors.join(' | ') || '';

  if (state.meta.athleteUrl) $('#stravaLink').href = state.meta.athleteUrl;
}

function renderHeader() {
  const n = state.acts.length;
  const when = state.meta.generated_at
    ? new Date(state.meta.generated_at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
  $('#lastUpdated').textContent = `기록 ${n.toLocaleString('ko-KR')}개 · ${when} 동기화`;
}

/* ── KPI ───────────────────────────────────────────────────── */
function renderKpis() {
  const acts = state.acts;
  const totalM = acts.reduce((s, a) => s + num(a.dist), 0);
  const totalS = acts.reduce((s, a) => s + num(a.mv), 0);
  const runs = acts.filter((a) => num(a.dist) > 0).length;
  const now = new Date();
  const yNow = now.getFullYear(), mNow = now.getMonth() + 1;

  const yearActs = acts.filter((a) => a.year === yNow);
  const monthActs = yearActs.filter((a) => a.month === mNow);
  const yearM = yearActs.reduce((s, a) => s + num(a.dist), 0);
  const prevYearM = acts.filter((a) => a.year === yNow - 1).reduce((s, a) => s + num(a.dist), 0);
  const best = acts.reduce((b, a) => (num(a.dist) > num(b && b.dist) ? a : b), null);
  const yoy = prevYearM > 0 ? Math.round(((yearM - prevYearM) / prevYearM) * 100) : null;

  const cards = [
    { label: '누적 거리', value: fmtKm(totalM), unit: 'km', foot: `${fmtTotal(totalS)} 동안` },
    { label: '러닝 횟수', value: runs.toLocaleString('ko-KR'), unit: '회', foot: `전체 활동 ${acts.length.toLocaleString('ko-KR')}개` },
    { label: '총 시간', value: fmtTotal(totalS), unit: '', foot: `평균 ${fmtDuration(totalS / Math.max(runs, 1))} / 회` },
    { label: '평균 페이스', value: fmtPace(totalM, totalS), unit: '/km', foot: '누적 거리 ÷ 누적 시간' },
    { label: '최장 거리', value: best ? fmtKm(best.dist) : '—', unit: 'km', foot: best ? `${best.p.date} · ${best.name}` : '' },
    { label: `${yNow}년`, value: fmtKm(yearM), unit: 'km', foot: yoy == null ? `${yearActs.length}회` : `작년 대비 ${yoy > 0 ? '+' : ''}${yoy}%` },
    { label: `${mNow}월`, value: fmtKm(monthActs.reduce((s, a) => s + num(a.dist), 0)), unit: 'km', foot: `${monthActs.length}회 달림` },
  ];

  const box = $('#kpi');
  box.innerHTML = '';
  cards.forEach((c) => {
    box.appendChild(el('div', 'kpi',
      `<div class="label">${c.label}</div>
       <div class="value">${c.value}${c.unit ? `<small>${c.unit}</small>` : ''}</div>
       <div class="foot">${c.foot}</div>`));
  });
}

/* ── 목표 달성률 ───────────────────────────────────────────── */
function readGoal(kind) {
  try {
    const v = Math.round(Number(localStorage.getItem(GOAL_KEY[kind])));
    if (isFinite(v) && v > 0) return v;
  } catch { /* 저장소를 못 쓰는 환경 */ }
  return GOAL_DEFAULT[kind];
}
function writeGoal(kind, v) {
  try { localStorage.setItem(GOAL_KEY[kind], String(v)); } catch { /* 무시 */ }
}
const fmtKm1 = (m) => (num(m) / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1 });

function goalFoot(doneM, goalKm, daysLeft, extra) {
  const needKm = Math.max(0, goalKm - num(doneM) / 1000);
  if (needKm <= 0) return `목표 달성 🎉 · ${extra}`;
  const per = needKm / Math.max(1, daysLeft);
  const when = daysLeft > 0
    ? `남은 ${daysLeft}일 · 하루 ${per.toFixed(1)} km씩`
    : `오늘이 마지막 날 · ${needKm.toFixed(1)} km`;
  return `${extra} · ${when}`;
}

function renderGoals() {
  const grid = $('#goalGrid');
  if (!grid) return;
  const now = new Date();
  const y = now.getFullYear();
  const dow = wkIdx(now);
  const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6);
  const wsKey = ymd(ws), weKey = ymd(we);

  const yearActs = state.acts.filter((a) => a.year === y);
  const yearM = yearActs.reduce((s, a) => s + num(a.dist), 0);
  const weekActs = state.acts.filter((a) => a.p.date >= wsKey && a.p.date <= weKey);
  const weekM = weekActs.reduce((s, a) => s + num(a.dist), 0);
  const daysLeftYear = Math.max(0, daysBetween(now, new Date(y, 11, 31)) + 1);
  const daysLeftWeek = Math.max(0, 6 - dow);

  grid.innerHTML = '';
  grid.appendChild(goalBlock({
    kind: 'year',
    label: `${y}년 목표`,
    doneM: yearM,
    goalKm: readGoal('year'),
    foot: goalFoot(yearM, readGoal('year'), daysLeftYear, `${yearActs.length}회 달림`),
    step: 100,
  }));
  grid.appendChild(goalBlock({
    kind: 'week',
    label: '이번 주 목표',
    doneM: weekM,
    goalKm: readGoal('week'),
    foot: goalFoot(weekM, readGoal('week'), daysLeftWeek,
      `${ws.getMonth() + 1}.${ws.getDate()} ~ ${we.getMonth() + 1}.${we.getDate()} · ${weekActs.length}회`),
    step: 5,
  }));
}

function goalBlock(o) {
  const wrap = el('div', 'goal');
  const pct = o.goalKm > 0 ? (num(o.doneM) / (o.goalKm * 1000)) * 100 : 0;
  const width = Math.max(pct > 0 ? 2 : 0, Math.min(100, pct));
  const pctText = pct >= 100 ? '달성 🎉' : `${pct.toFixed(1)}%`;
  wrap.innerHTML =
    `<div class="goal-head">
       <span class="goal-label">${o.label}</span>
       <button class="goal-edit-btn" type="button">목표 ${o.goalKm.toLocaleString('ko-KR')} km 수정</button>
     </div>
     <div class="goal-main">
       <b>${fmtKm1(o.doneM)}</b><span class="goal-of">/ ${o.goalKm.toLocaleString('ko-KR')} km</span>
       <span class="goal-pct${pct >= 100 ? ' done' : ''}">${pctText}</span>
     </div>
     <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(100, pct))}"><i style="width:${width.toFixed(1)}%"></i></div>
     <div class="goal-foot">${o.foot}</div>`;
  wrap.querySelector('.goal-edit-btn').addEventListener('click', () => openGoalEditor(wrap, o));
  return wrap;
}

function openGoalEditor(wrap, o) {
  if (wrap.querySelector('.goal-edit')) return;
  const btn = wrap.querySelector('.goal-edit-btn');
  btn.hidden = true;
  const form = el('div', 'goal-edit');
  form.innerHTML = `<label for="goalInput-${o.kind}">목표</label>
    <input id="goalInput-${o.kind}" type="number" inputmode="numeric" min="1" max="200000" step="${o.step || 10}" value="${o.goalKm}">
    <span>km</span>
    <button type="button" class="goal-save">저장</button>
    <button type="button" class="goal-cancel">취소</button>`;
  wrap.appendChild(form);
  const input = form.querySelector('input');
  const close = () => { form.remove(); btn.hidden = false; };
  const save = () => {
    const v = Math.round(Number(input.value));
    if (!isFinite(v) || v <= 0) { input.focus(); return; }
    writeGoal(o.kind, v);
    renderGoals();
  };
  form.querySelector('.goal-save').addEventListener('click', save);
  form.querySelector('.goal-cancel').addEventListener('click', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') close();
  });
  input.focus();
  input.select();
}

/* ── 거리별 개인 기록(PR) ─────────────────────────────────── */
function renderPrBoard() {
  const grid = $('#prGrid');
  if (!grid) return;
  grid.innerHTML = '';
  PR_BRACKETS.forEach((b) => {
    const pool = state.acts.filter((a) => num(a.dist) >= b.min && a.pace && a.pace >= MIN_PACE);
    const best = pool.reduce((x, a) => (!x || a.pace < x.pace ? a : x), null);
    if (!best) {
      grid.appendChild(el('div', 'pr-card empty',
        `<span class="pr-top"><span class="pr-label">${b.label}</span></span>
         <span class="pr-time">—</span><span class="pr-unit">해당 기록 없음</span>`));
      return;
    }
    const est = Math.round(best.pace * (b.target / 1000));
    const card = el('button', 'pr-card',
      `<span class="pr-top"><span class="pr-label">${b.label}</span><span class="pr-count">${pool.length.toLocaleString('ko-KR')}개 중 최고</span></span>
       <span class="pr-time">${fmtDuration(est)}</span>
       <span class="pr-unit">${(b.target / 1000).toFixed(2)} km 환산 시간</span>
       <span class="pr-pace">${fmtPace(1000, best.pace)}/km</span>
       <span class="pr-actual">실제 ${fmtKm(best.dist)} km · ${fmtDuration(best.mv)}</span>
       <span class="pr-meta">${best.p.date.replace(/-/g, '.')} · ${esc(best.name || '러닝')}</span>`);
    card.type = 'button';
    card.title = `${best.name || '러닝'} 상세 보기`;
    card.addEventListener('click', () => openModal(best));
    grid.appendChild(card);
  });
}

/* ── 종합 코스 지도 ───────────────────────────────────────── */
function initRouteMap() {
  if (routeState.map) return;
  const host = $('#routeMap');
  if (!host || typeof L === 'undefined') return;
  routeState.map = L.map('routeMap', { zoomControl: true, attributionControl: true, scrollWheelZoom: true, maxZoom: 16 });
  // 라이트 테마에 맞는 밝은 지도 타일 (Esri Light Gray Canvas · 키 불필요)
  L.tileLayer(ESRI_LIGHT, { maxZoom: 16, maxNativeZoom: 13, attribution: ESRI_ATTR }).addTo(routeState.map);
  routeState.map.setView([37.55, 126.95], 11);
  routeState.canvas = L.canvas({ padding: 0.4 });
  routeState.layer = L.layerGroup().addTo(routeState.map);
}

async function renderRoutePanel() {
  const box = $('#routeYears');
  if (!box || typeof L === 'undefined') return;
  const years = [...new Set(state.acts.map((a) => a.year))].sort((a, b) => b - a);
  if (!years.length) return;
  const total = num(state.meta.withPolyline);
  const tabs = [{ key: 'all', label: `전체 연도${total ? ` (${total.toLocaleString('ko-KR')}개)` : ''}` }]
    .concat(years.map((y) => ({ key: y, label: String(y) })));

  box.innerHTML = '';
  tabs.forEach((t) => {
    const b = el('button', null, t.label);
    b.setAttribute('role', 'tab');
    b.dataset.key = String(t.key);
    b.setAttribute('aria-selected', 'false');
    b.addEventListener('click', () => selectRouteYear(t.key));
    box.appendChild(b);
  });
  await selectRouteYear(years[0]);   // 기본: 최근 연도부터 가볍게
}

function selectRouteYear(key) {
  const box = $('#routeYears');
  if (box) [...box.children].forEach((c) => c.setAttribute('aria-selected', String(c.dataset.key === String(key))));
  return drawRouteView(key).catch((e) => {
    console.error('route', e);
    const st = $('#routeStatus');
    if (st) { st.hidden = false; st.textContent = '경로를 그리지 못했어요'; }
  });
}

async function drawRouteView(key) {
  const token = ++routeState.token;
  initRouteMap();
  if (!routeState.map) return;
  routeState.key = key;
  routeState.stats.clear();
  routeState.layer.clearLayers();
  routeState.bounds = L.latLngBounds([]);
  routeState.pts = [];

  const status = $('#routeStatus');
  if (status) { status.hidden = false; status.textContent = '불러오는 중…'; }

  const years = key === 'all'
    ? [...new Set(state.acts.map((a) => a.year))].sort((a, b) => a - b)
    : [key];

  let done = 0;
  for (const y of years) {
    const store = await loadPolyStore(y);
    if (token !== routeState.token) return;      // 다른 연도를 골랐으면 중단
    drawRouteYear(store, y);
    done++;
    if (status) {
      status.textContent = key === 'all'
        ? `${done}/${years.length}년 · ${routeCount().toLocaleString('ko-KR')}개 코스`
        : `${y}년 경로 ${routeCount().toLocaleString('ko-KR')}개`;
    }
    updateRouteSummary();
    if (years.length > 1) await raf();           // 화면이 멈추지 않게 한 해씩
  }
  if (token !== routeState.token) return;
  const focus = computeFocusBounds(routeState.pts);
  if (focus) routeState.map.fitBounds(focus, { padding: [22, 22] });
  else if (routeState.bounds && routeState.bounds.isValid()) routeState.map.fitBounds(routeState.bounds, { padding: [22, 22] });
  if (status) status.hidden = true;
  updateRouteSummary();
  setTimeout(() => routeState.map && routeState.map.invalidateSize(), 80);
}

function drawRouteYear(store, year) {
  const byId = new Map();
  state.acts.forEach((a) => { if (a.year === year) byId.set(String(a.id), a); });
  let n = 0, m = 0;
  Object.keys(store || {}).forEach((id) => {
    const pts = decodePolyline(store[id]);
    if (pts.length < 2) return;
    const line = L.polyline(pts, {
      renderer: routeState.canvas, color: '#fc5200', weight: 1.6, opacity: 0.17,
      interactive: false, lineCap: 'round', lineJoin: 'round',
    }).addTo(routeState.layer);
    routeState.bounds.extend(line.getBounds());
    for (let i = 0; i < pts.length; i++) routeState.pts.push(pts[i]);
    n++;
    const a = byId.get(String(id));
    if (a) m += num(a.dist);
  });
  routeState.stats.set(year, { n, m });
}

function routeCount() { let n = 0; routeState.stats.forEach((s) => { n += s.n; }); return n; }
function routeDistM() { let m = 0; routeState.stats.forEach((s) => { m += s.m; }); return m; }

// 가장 많이 뛴 지역에 맞춰 지도 열기 (여행지 기록 몇 개가 화면을 통째로 잡아먹지 않도록)
function computeFocusBounds(pts) {
  if (!pts || pts.length < 2) return null;
  const lats = pts.map((p) => p[0]).sort((a, b) => a - b);
  const lngs = pts.map((p) => p[1]).sort((a, b) => a - b);
  const mid = (arr) => arr[Math.floor(arr.length / 2)];
  const cLat = mid(lats), cLng = mid(lngs);
  const dist = pts.map((p) => Math.hypot((p[0] - cLat) * 111, (p[1] - cLng) * 88)).sort((a, b) => a - b);
  const radius = Math.max(7, dist[Math.floor(dist.length * 0.85)] || 7);   // km
  const dLat = radius / 111, dLng = radius / 88;
  return L.latLngBounds([cLat - dLat, cLng - dLng], [cLat + dLat, cLng + dLng]);
}

function updateRouteSummary() {
  const box = $('#routeSummary');
  if (!box) return;
  const years = [...routeState.stats.keys()].sort((a, b) => a - b);
  const label = routeState.key === 'all'
    ? `전체 ${years.length}년 (${years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0]})`
    : `${routeState.key}년`;
  box.innerHTML =
    `<span><b>${label}</b></span>
     <span>코스 <b>${routeCount().toLocaleString('ko-KR')}</b>개</span>
     <span>합계 <b>${fmtKm(routeDistM())}</b> km</span>
     <span class="rs-legend"><i></i><i></i><i></i>겹칠수록 진하게</span>`;
}

/* ── 히트맵 ───────────────────────────────────────────────── */
function renderHeatmapTabs() {
  const years = [...new Set(state.acts.map((a) => a.year))].sort((a, b) => b - a);
  state.heatYear = years[0] || new Date().getFullYear();
  const box = $('#heatmapYears');
  box.innerHTML = '';
  years.forEach((y) => {
    const b = el('button', null, String(y));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(y === state.heatYear));
    b.addEventListener('click', () => {
      state.heatYear = y;
      [...box.children].forEach((c) => c.setAttribute('aria-selected', String(c.textContent === String(y))));
      renderHeatmap(y);
    });
    box.appendChild(b);
  });
}

function renderHeatmap(year) {
  const host = $('#heatmap');
  host.innerHTML = '';
  const acts = state.acts.filter((a) => a.year === year);
  const byDate = new Map();
  acts.forEach((a) => {
    const cur = byDate.get(a.p.date) || { m: 0, n: 0, pace: null, runs: [] };
    cur.m += num(a.dist); cur.n += 1;
    if (a.pace) { cur.pace = cur.pace ? (cur.pace + a.pace) / 2 : a.pace; }
    cur.runs.push(a);
    byDate.set(a.p.date, cur);
  });

  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const startPad = wkIdx(start);                       // 월요일 기준 앞 빈칸
  const totalDays = Math.round((end - start) / 86400000) + 1;
  const weeks = Math.ceil((startPad + totalDays) / 7);

  // 월 라벨 (3주 이상 떨어진 시작에만 표기해 겹침 방지)
  const monthsRow = el('div', 'hm-months');
  let lastMonth = -1, sinceLabel = 99;
  for (let w = 0; w < weeks; w++) {
    let label = '';
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d - startPad;
      if (idx < 0 || idx >= totalDays) continue;
      const day = new Date(year, 0, 1 + idx);
      if (day.getMonth() !== lastMonth) {
        lastMonth = day.getMonth();
        if (sinceLabel >= 3) { label = MONTHS[day.getMonth()]; sinceLabel = 0; }
        break;
      }
    }
    sinceLabel++;
    const s = el('span', 'hm-month', label);
    s.style.width = '18px'; s.style.flex = '0 0 18px';
    monthsRow.appendChild(s);
  }

  const body = el('div', 'hm-body');
  const labels = el('div', 'hm-daylabels');
  WEEKDAYS.forEach((w, i) => labels.appendChild(el('span', null, i % 2 === 0 ? w : '')));
  body.appendChild(labels);

  const tip = $('#heatTooltip');
  let sum = 0, days = 0, streak = 0, bestStreak = 0, prevHad = false;

  for (let w = 0; w < weeks; w++) {
    const col = el('div', 'hm-week');
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d - startPad;
      if (idx < 0 || idx >= totalDays) { col.appendChild(el('div', 'hm-cell empty')); continue; }
      const day = new Date(year, 0, 1 + idx);
      const key = `${year}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const rec = byDate.get(key);
      const m = rec ? rec.m : 0;
      const mk = m / 1000;   // 색 기준은 km
      const lvl = m === 0 ? 0 : mk < HEAT_LEVELS[0] ? 1 : mk < HEAT_LEVELS[1] ? 2 : mk < HEAT_LEVELS[2] ? 3 : mk < HEAT_LEVELS[3] ? 4 : 5;
      const cell = el('div', `hm-cell lvl${lvl}`);
      cell.setAttribute('data-date', key);
      if (m > 0) {
        sum += m; days++;
        if (prevHad) { streak++; } else { streak = 1; }
        bestStreak = Math.max(bestStreak, streak);
        prevHad = true;
      } else { prevHad = false; streak = 0; }
      cell.addEventListener('mouseenter', (e) => {
        tip.hidden = false;
        tip.innerHTML = rec
          ? `<b>${key}</b> · ${WEEKDAYS[wkIdx(day)]}요일<br><span class="t-dim">${fmtKm(m)} km · ${rec.n}회${rec.pace ? ` · ${fmtPace(1000, rec.pace)}/km` : ''}</span>`
          : `<b>${key}</b> · ${WEEKDAYS[wkIdx(day)]}요일<br><span class="t-dim">쉬어간 날</span>`;
        moveTip(e);
      });
      cell.addEventListener('mousemove', moveTip);
      cell.addEventListener('mouseleave', () => { tip.hidden = true; });
      col.appendChild(cell);
    }
    body.appendChild(col);
  }
  host.appendChild(monthsRow);
  host.appendChild(body);

  $('#heatmapSummary').textContent =
    `${year}년 · ${days}일 달림 · ${fmtKm(sum)} km · 최장 연속 ${bestStreak}일`;
}

function moveTip(e) {
  const tip = $('#heatTooltip');
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${Math.max(6, x)}px`;
  tip.style.top = `${Math.max(6, y)}px`;
}

/* ── 차트 공통 ─────────────────────────────────────────────── */
const CHART_FONT = { family: 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif', size: 11 };
function baseScales(extra = {}) {
  return Object.assign({
    x: { grid: { color: 'rgba(17,24,39,.07)' }, ticks: { color: '#5d6779', font: CHART_FONT } },
    y: { grid: { color: 'rgba(17,24,39,.07)' }, ticks: { color: '#5d6779', font: CHART_FONT }, beginAtZero: true },
  }, extra);
}
const TOOLTIP = {
  backgroundColor: '#ffffff',
  borderColor: '#e3e7ee',
  borderWidth: 1,
  titleColor: '#131a26',
  bodyColor: '#4c5666',
  padding: 10,
  cornerRadius: 9,
  titleFont: CHART_FONT,
  bodyFont: CHART_FONT,
};
function drawChart(id, cfg) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  const conf = Object.assign({ type: 'bar', options: { responsive: true, maintainAspectRatio: false } }, cfg);
  if (!conf.type) conf.type = 'bar';
  state.charts[id] = new Chart(canvas, conf);
}

/* ── 월별 차트 ─────────────────────────────────────────────── */
function renderMonthlyYearOptions() {
  const years = [...new Set(state.acts.map((a) => a.year))].sort((a, b) => b - a);
  const nowY = new Date().getFullYear();
  state.monthYear = years.includes(nowY) ? nowY : years[0];
  const sel = $('#monthlyYear');
  sel.innerHTML = '';
  years.forEach((y) => {
    const o = el('option', null, `${y}년`); o.value = y;
    if (y === state.monthYear) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => { state.monthYear = +sel.value; renderMonthly(state.monthYear); };
}

function renderMonthly(year) {
  const acts = state.acts.filter((a) => a.year === year);
  const dist = new Array(12).fill(0), cnt = new Array(12).fill(0), paceSum = new Array(12).fill(0), paceN = new Array(12).fill(0);
  acts.forEach((a) => {
    const i = a.month - 1;
    dist[i] += km(a.dist); cnt[i] += 1;
    if (a.pace) { paceSum[i] += a.pace * km(a.dist); paceN[i] += km(a.dist); }
  });
  const pace = paceSum.map((s, i) => (paceN[i] ? s / paceN[i] : null));

  drawChart('chartMonthly', {
    data: {
      labels: MONTHS,
      datasets: [
        {
          type: 'bar', label: '거리(km)', data: dist,
          backgroundColor: 'rgba(252,82,0,.75)', hoverBackgroundColor: '#fc5200',
          borderRadius: 6, borderSkipped: false, yAxisID: 'y', order: 2,
        },
        {
          type: 'line', label: '평균 페이스', data: pace.map((p) => (p ? +(p / 60).toFixed(2) : null)),
          borderColor: '#0f9d7c', backgroundColor: '#0f9d7c', borderWidth: 2.5,
          pointRadius: 3, pointHoverRadius: 5, tension: .35, spanGaps: true,
          yAxisID: 'y1', order: 1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#566173', boxWidth: 10, boxHeight: 10, font: CHART_FONT } },
        tooltip: Object.assign({}, TOOLTIP, {
          callbacks: {
            label: (c) => {
              if (c.dataset.label === '평균 페이스') {
                if (c.parsed.y == null) return '평균 페이스 —';
                const s = Math.round(c.parsed.y * 60);
                return `평균 페이스 ${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
              }
              return `거리 ${c.parsed.y.toFixed(1)} km (${cnt[c.dataIndex]}회)`;
            },
          },
        }),
      },
      scales: baseScales({
        y: { position: 'left', title: { display: true, text: 'km', color: '#7c8798', font: CHART_FONT },
             grid: { color: 'rgba(17,24,39,.07)' }, ticks: { color: '#5d6779', font: CHART_FONT }, beginAtZero: true },
        y1: { position: 'right', reverse: true, title: { display: true, text: "페이스 (분/km)", color: '#0f9d7c', font: CHART_FONT },
              grid: { display: false }, ticks: { color: '#0f9d7c', font: CHART_FONT }, beginAtZero: false },
      }),
    },
  });
}

/* ── 연도별 차트 ───────────────────────────────────────────── */
function renderYearly() {
  const byYear = new Map();
  state.acts.forEach((a) => {
    const r = byYear.get(a.year) || { m: 0, n: 0, s: 0 };
    r.m += km(a.dist); r.n += 1; r.s += num(a.mv);
    byYear.set(a.year, r);
  });
  const years = [...byYear.keys()].sort((a, b) => a - b);
  drawChart('chartYearly', {
    data: {
      labels: years.map((y) => `${y}`),
      datasets: [
        { type: 'bar', label: '연간 거리(km)', data: years.map((y) => +byYear.get(y).m.toFixed(1)),
          backgroundColor: 'rgba(59,111,212,.68)', hoverBackgroundColor: '#3b6fd4', borderRadius: 6, order: 2 },
        { type: 'line', label: '평균 페이스', data: years.map((y) => {
            const r = byYear.get(y); const p = paceSec(r.m * 1000, r.s); return p ? +(p / 60).toFixed(2) : null;
          }), borderColor: '#0f9d7c', borderWidth: 2.5, pointRadius: 3, tension: .35, yAxisID: 'y1', order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#566173', boxWidth: 10, boxHeight: 10, font: CHART_FONT } },
        tooltip: Object.assign({}, TOOLTIP, {
          callbacks: {
            label: (c) => {
              if (c.dataset.label === '평균 페이스') {
                if (c.parsed.y == null) return '평균 페이스 —';
                const s = Math.round(c.parsed.y * 60);
                return `평균 페이스 ${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
              }
              const r = byYear.get(+c.label);
              return `거리 ${c.parsed.y} km (${r.n}회)`;
            },
          },
        }),
      },
      scales: baseScales({
        y1: { position: 'right', reverse: true, beginAtZero: false, grid: { display: false },
              ticks: { color: '#0f9d7c', font: CHART_FONT, precision: 1 } },
      }),
    },
  });
}

/* ── 요일 / 시간대 ─────────────────────────────────────────── */
function renderWeekday() {
  const dist = new Array(7).fill(0), cnt = new Array(7).fill(0);
  state.acts.forEach((a) => { dist[a.weekday] += km(a.dist); cnt[a.weekday] += 1; });
  drawChart('chartWeekday', {
    data: {
      labels: WEEKDAYS.map((w) => `${w}요일`),
      datasets: [{ label: '거리(km)', data: dist.map((v) => +v.toFixed(1)),
        backgroundColor: dist.map((_, i) => (i >= 5 ? 'rgba(252,82,0,.8)' : 'rgba(59,111,212,.68)')),
        borderRadius: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: '요일별 누적 거리', align: 'start', color: '#5d6779', font: Object.assign({ size: 12 }, CHART_FONT) },
        tooltip: Object.assign({}, TOOLTIP, { callbacks: {
          label: (c) => `${c.parsed.y} km · ${cnt[c.dataIndex]}회 (평균 ${(dist[c.dataIndex] / Math.max(cnt[c.dataIndex], 1)).toFixed(1)} km)` } }),
      },
      scales: baseScales(),
    },
  });
}

function renderHour() {
  const buckets = [[0,4,'0–4시'],[5,6,'5–6시'],[7,8,'7–8시'],[9,11,'9–11시'],[12,14,'12–14시'],[15,17,'15–17시'],[18,20,'18–20시'],[21,23,'21–23시']];
  const cnt = buckets.map(() => 0), dist = buckets.map(() => 0);
  state.acts.forEach((a) => {
    const i = buckets.findIndex(([s, e]) => a.hour >= s && a.hour <= e);
    if (i >= 0) { cnt[i] += 1; dist[i] += km(a.dist); }
  });
  drawChart('chartHour', {
    data: {
      labels: buckets.map((b) => b[2]),
      datasets: [{ label: '러닝 횟수', data: cnt,
        backgroundColor: 'rgba(15,157,124,.72)', hoverBackgroundColor: '#0f9d7c', borderRadius: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: '시간대별 러닝 횟수', align: 'start', color: '#5d6779', font: Object.assign({ size: 12 }, CHART_FONT) },
        tooltip: Object.assign({}, TOOLTIP, { callbacks: {
          label: (c) => `${c.parsed.y}회 · ${dist[c.dataIndex].toFixed(0)} km` } }),
      },
      scales: baseScales(),
    },
  });
}

/* ── 심박 · 유산소 효율 ───────────────────────────────────── */
function renderHrYears() {
  const years = [...new Set(state.acts.filter((a) => num(a.hr) > 0).map((a) => a.year))].sort((a, b) => b - a);
  const sel = $('#hrYear');
  if (!sel || !years.length) return;
  const nowY = new Date().getFullYear();
  state.hrYear = years.includes(nowY) ? nowY : years[0];
  sel.innerHTML = '';
  years.forEach((y) => {
    const o = el('option', null, `${y}년`);
    o.value = y;
    if (y === state.hrYear) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => { state.hrYear = +sel.value; renderHr(state.hrYear); };
}

function renderHr(year) {
  if (!document.getElementById('chartHr')) return;
  const acts = state.acts.filter((a) => a.year === year && num(a.dist) > 0);
  const withHr = acts.filter((a) => num(a.hr) > 0 && num(a.mv) > 0);   // 심박 없는 활동은 제외
  const hrSum = new Array(12).fill(0), hrN = new Array(12).fill(0);
  const effSum = new Array(12).fill(0), effN = new Array(12).fill(0);
  const paceSum = new Array(12).fill(0), paceN = new Array(12).fill(0);

  withHr.forEach((a) => {
    const i = a.month - 1;
    hrSum[i] += num(a.hr); hrN[i] += 1;
    const eff = num(a.dist) / ((num(a.mv) / 60) * num(a.hr));          // 이동거리(m) ÷ 심박수 = m/beat
    if (isFinite(eff) && eff > 0) { effSum[i] += eff; effN[i] += 1; }
    if (a.pace) { paceSum[i] += a.pace * km(a.dist); paceN[i] += km(a.dist); }
  });

  const avgHr = hrSum.map((s, i) => (hrN[i] ? s / hrN[i] : null));
  const eff = effSum.map((s, i) => (effN[i] ? s / effN[i] : null));
  const pace = paceSum.map((s, i) => (paceN[i] ? s / paceN[i] : null));

  const meanHr = withHr.length ? withHr.reduce((s, a) => s + num(a.hr), 0) / withHr.length : null;
  let bestIdx = -1;
  eff.forEach((v, i) => { if (v != null && (bestIdx < 0 || v > eff[bestIdx])) bestIdx = i; });
  const totM = withHr.reduce((s, a) => s + num(a.dist), 0);
  const totS = withHr.reduce((s, a) => s + num(a.mv), 0);

  const stats = $('#hrStats');
  if (stats) {
    stats.innerHTML =
      `<span>심박 기록 <b>${withHr.length.toLocaleString('ko-KR')}</b> / ${acts.length.toLocaleString('ko-KR')}회 활동</span>` +
      (meanHr ? `<span>연평균 심박 <b>${Math.round(meanHr)}</b> bpm</span>` : '') +
      (totM ? `<span>평균 페이스 <b>${fmtPace(totM, totS)}</b>/km</span>` : '') +
      (bestIdx >= 0 ? `<span>효율 가장 좋은 달 <b>${MONTHS[bestIdx]}</b> · ${eff[bestIdx].toFixed(2)} m/beat</span>` : '');
  }

  drawChart('chartHr', {
    data: {
      labels: MONTHS,
      datasets: [
        {
          type: 'bar', label: '평균 심박(bpm)', data: avgHr.map((v) => (v ? +v.toFixed(0) : null)),
          backgroundColor: 'rgba(214,69,69,.5)', hoverBackgroundColor: 'rgba(214,69,69,.78)',
          borderRadius: 6, borderSkipped: false, yAxisID: 'y', order: 2,
        },
        {
          type: 'line', label: '심박 효율(m/beat)', data: eff.map((v) => (v ? +v.toFixed(3) : null)),
          borderColor: '#0f9d7c', backgroundColor: 'rgba(15,157,124,.10)', borderWidth: 2.5,
          pointRadius: 3, pointHoverRadius: 5, tension: .35, spanGaps: true, fill: true,
          yAxisID: 'y1', order: 1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#566173', boxWidth: 10, boxHeight: 10, font: CHART_FONT } },
        tooltip: Object.assign({}, TOOLTIP, {
          callbacks: {
            label: (c) => {
              if (c.parsed.y == null) return `${c.dataset.label} —`;
              if (c.dataset.label.includes('효율')) return `심박 효율 ${c.parsed.y.toFixed(2)} m/beat`;
              return `평균 심박 ${Math.round(c.parsed.y)} bpm (${hrN[c.dataIndex]}회)`;
            },
            footer: (items) => {
              const i = items[0] ? items[0].dataIndex : -1;
              return i >= 0 && pace[i] ? `평균 페이스 ${fmtPace(1000, pace[i])}/km` : '';
            },
          },
        }),
      },
      scales: {
        x: { grid: { color: 'rgba(17,24,39,.07)' }, ticks: { color: '#5d6779', font: CHART_FONT } },
        y: {
          position: 'left', beginAtZero: false, suggestedMin: 110,
          title: { display: true, text: 'bpm', color: '#b04a4a', font: CHART_FONT },
          grid: { color: 'rgba(17,24,39,.07)' }, ticks: { color: '#5d6779', font: CHART_FONT },
        },
        y1: {
          position: 'right', beginAtZero: false,
          title: { display: true, text: 'm/beat', color: '#0f9d7c', font: CHART_FONT },
          grid: { display: false }, ticks: { color: '#0f9d7c', font: CHART_FONT, precision: 2 },
        },
      },
    },
  });
}

/* ── 개인 기록 ─────────────────────────────────────────────── */
function renderRecords() {
  const acts = state.acts.filter((a) => num(a.dist) > 0);
  const longest = acts.reduce((b, a) => (km(a.dist) > km(b && b.dist ? b.dist : 0) ? a : b), null);
  const longestT = acts.reduce((b, a) => (num(a.mv) > num(b && b.mv ? b.mv : 0) ? a : b), null);
  const fast = acts.filter((a) => km(a.dist) >= 5 && a.pace && a.pace >= 180).sort((a, b) => a.pace - b.pace)[0];
  const fastest5k = fast;

  const byMonth = new Map();
  acts.forEach((a) => {
    const k = `${a.year}-${String(a.month).padStart(2, '0')}`;
    byMonth.set(k, (byMonth.get(k) || 0) + km(a.dist));
  });
  const bestMonth = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];

  // 최장 연속 러닝일
  const days = [...new Set(acts.map((a) => a.p.date))].sort();
  let streak = 0, best = 0, prev = null;
  days.forEach((d) => {
    const t = new Date(d + 'T00:00:00');
    if (prev && (t - prev) === 86400000) streak += 1; else streak = 1;
    best = Math.max(best, streak); prev = t;
  });

  // 최다 주간
  const byWeek = new Map();
  acts.forEach((a) => {
    const dt = new Date(a.p.date + 'T00:00:00');
    const wk = new Date(dt); wk.setDate(dt.getDate() - wkIdx(dt));
    const k = wk.toISOString().slice(0, 10);
    byWeek.set(k, (byWeek.get(k) || 0) + km(a.dist));
  });
  const bestWeek = [...byWeek.entries()].sort((a, b) => b[1] - a[1])[0];

  const rows = [
    ['🏅', '최장 거리', longest ? `${fmtKm(longest.dist)} km` : '—', longest ? `${longest.p.date} · ${longest.name}` : ''],
    ['⏱️', '최장 시간', longestT ? fmtDuration(longestT.mv) : '—', longestT ? `${longestT.p.date} · ${fmtKm(longestT.dist)} km` : ''],
    ['⚡', '최고 평균 페이스', fastest5k ? fmtPace(1000, fastest5k.pace) : '—', fastest5k ? `${fastest5k.p.date} · ${fmtKm(fastest5k.dist)} km` : '5km 이상 기준'],
    ['📅', '최다 월간 거리', bestMonth ? `${bestMonth[1].toFixed(0)} km` : '—', bestMonth ? bestMonth[0].replace('-', '년 ') + '월' : ''],
    ['🔥', '최다 주간 거리', bestWeek ? `${bestWeek[1].toFixed(0)} km` : '—', bestWeek ? `${bestWeek[0]} 주` : ''],
    ['🧱', '최장 연속 러닝', best ? `${best}일` : '—', '쉬지 않고 이어간 날'],
  ];
  const box = $('#records');
  box.innerHTML = '';
  rows.forEach(([icon, label, value, note]) => {
    box.appendChild(el('li', null,
      `<span class="r-label"><span class="r-icon">${icon}</span>${label}</span>
       <span class="r-value">${value}${note ? `<span class="r-note">${note}</span>` : ''}</span>`));
  });
}

/* ── 러닝화 ───────────────────────────────────────────────── */
function renderGear() {
  const withGear = state.acts.filter((a) => a.gear && num(a.dist) > 0);
  if (!withGear.length) {
    const p = $('#gearPanel');
    p.hidden = false;
    $('#gearList').innerHTML = `<p class="empty-state">Strava 활동에 러닝화(기어)가 지정되어 있지 않아 신발별 통계는 아직 없어요. Strava 앱에서 활동마다 신발을 골라 두면 다음 동기화부터 자동으로 채워집니다.</p>`;
    return;
  }
  const map = new Map();
  withGear.forEach((a) => {
    const r = map.get(a.gear) || { m: 0, n: 0 };
    r.m += km(a.dist); r.n += 1; map.set(a.gear, r);
  });
  const arr = [...map.entries()].sort((a, b) => b[1].m - a[1].m);
  const max = arr[0] ? arr[0][1].m : 1;
  $('#gearPanel').hidden = false;
  const box = $('#gearList');
  box.innerHTML = '';
  arr.forEach(([name, r]) => {
    const row = el('div', 'gear-row',
      `<div class="gear-name" title="${name}">${name}</div>
       <div class="gear-bar"><i style="width:${Math.max(3, (r.m / max) * 100).toFixed(1)}%"></i></div>
       <div class="gear-km">${r.m.toFixed(0)} km · ${r.n}회</div>`);
    box.appendChild(row);
  });
}

/* ── 활동 목록 ─────────────────────────────────────────────── */
function renderListYears() {
  const years = [...new Set(state.acts.map((a) => a.year))].sort((a, b) => b - a);
  const sel = $('#listYear');
  sel.innerHTML = `<option value="all">전체 연도</option>` + years.map((y) => `<option value="${y}">${y}년</option>`).join('');
  sel.onchange = () => { state.listYear = sel.value; state.shown = PAGE_SIZE; renderList(); };
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    state.shown = PAGE_SIZE;
    renderList();
  });
  const dist = $('#listDist');
  if (dist) dist.onchange = () => { state.listDist = dist.value; state.shown = PAGE_SIZE; renderList(); };
  const sort = $('#listSort');
  if (sort) sort.onchange = () => { state.listSort = sort.value; state.shown = PAGE_SIZE; renderList(); };
  $('#loadMore').addEventListener('click', () => { state.shown += PAGE_SIZE; renderList(); });
}

function filteredActs() {
  const distRule = (LIST_DISTS.find((d) => d.key === state.listDist) || LIST_DISTS[0]).test;
  const list = state.acts.filter((a) => {
    if (state.listYear !== 'all' && String(a.year) !== String(state.listYear)) return false;
    if (!distRule(a)) return false;
    if (state.search) {
      const hay = `${a.name || ''} ${a.sport || ''} ${a.gear || ''}`.toLowerCase();
      if (!hay.includes(state.search)) return false;
    }
    return true;
  });
  const sortRule = (LIST_SORTS.find((s) => s.key === state.listSort) || LIST_SORTS[0]).fn;
  return list.sort(sortRule);
}

function renderList() {
  const list = filteredActs();
  const box = $('#activityList');
  box.innerHTML = '';
  const sortLabel = (LIST_SORTS.find((s) => s.key === state.listSort) || LIST_SORTS[0]).label;
  const distLabel = (LIST_DISTS.find((d) => d.key === state.listDist) || LIST_DISTS[0]).label;
  const notes = [sortLabel];
  if (state.listDist !== 'all') notes.push(distLabel);
  $('#listCount').textContent = `${list.length.toLocaleString('ko-KR')}개 활동 · ${notes.join(' · ')}`;
  if (!list.length) {
    box.innerHTML = `<div class="empty-state">조건에 맞는 활동이 없어요.</div>`;
    $('#loadMore').hidden = true;
    return;
  }
  list.slice(0, state.shown).forEach((a) => {
    const badge = a.sport && a.sport !== 'Run' ? `<span class="a-badge">${a.sport}</span>` : '';
    const btn = el('button', 'act',
      `<span class="a-date"><b>${a.p.date.slice(5).replace('-', '/')}</b>${WEEKDAYS[a.weekday]} ${String(a.p.h).padStart(2, '0')}:${String(a.p.mi).padStart(2, '0')}</span>
       <span><span class="a-name">${a.name || '러닝'}${badge}</span>
         <span class="a-meta">${a.year}년 · ${a.gear || (a.el ? `고도 ${Math.round(a.el)}m` : '—')}</span></span>
       <span class="a-dist">${fmtKm(a.dist)} km</span>
       <span class="a-pace">${fmtPace(a.dist, a.mv)}/km<br>${fmtDuration(a.mv)}</span>`);
    btn.addEventListener('click', () => openModal(a));
    box.appendChild(btn);
  });
  $('#loadMore').hidden = state.shown >= list.length;
  $('#loadMore').textContent = `더 보기 (${Math.min(state.shown, list.length)} / ${list.length})`;
}

/* ── 상세 모달 · 지도 ──────────────────────────────────────── */
async function openModal(a) {
  const modal = $('#modal');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#modalTitle').textContent = a.name || '러닝';
  $('#modalSub').textContent = `${a.p.date} (${WEEKDAYS[a.weekday]}요일) ${String(a.p.h).padStart(2, '0')}:${String(a.p.mi).padStart(2, '0')} · ${a.sport || 'Run'}`;

  const stats = [
    ['거리', `${fmtKm(a.dist)} km`],
    ['시간', fmtDuration(a.mv)],
    ['평균 페이스', `${fmtPace(a.dist, a.mv)}/km`],
    ['고도 상승', a.el ? `${Math.round(a.el)} m` : '—'],
  ];
  if (a.hr) stats.push(['평균 심박', `${Math.round(a.hr)} bpm`]);
  if (a.mxhr) stats.push(['최대 심박', `${Math.round(a.mxhr)} bpm`]);
  if (a.cad) stats.push(['평균 케이던스', `${Math.round(a.cad)} spm`]);
  if (a.cal) stats.push(['칼로리', `${Math.round(a.cal)} kcal`]);
  if (a.gear) stats.push(['러닝화', a.gear]);

  const dl = $('#modalStats');
  dl.innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#modalStrava').href = `https://www.strava.com/activities/${a.id}`;
  $('#modalDesc').hidden = !a.desc;
  $('#modalDesc').textContent = a.desc || '';

  const mapBox = $('#modalMap');
  const note = $('#mapNote');
  mapBox.hidden = false;
  note.hidden = true;

  const poly = await loadPoly(a);
  setupMap();
  if (state.mapLayer) { state.map.removeLayer(state.mapLayer); state.mapLayer = null; }

  if (poly && poly.length > 1) {
    const layer = L.polyline(poly, { color: '#fc5200', weight: 4, opacity: .95 }).addTo(state.map);
    const start = L.circleMarker(poly[0], { radius: 5, color: '#0f9d7c', fillColor: '#0f9d7c', fillOpacity: 1 }).addTo(state.map);
    const end = L.circleMarker(poly[poly.length - 1], { radius: 5, color: '#3b6fd4', fillColor: '#3b6fd4', fillOpacity: 1 }).addTo(state.map);
    state.mapLayer = L.layerGroup([layer, start, end]).addTo(state.map);
    state.map.fitBounds(layer.getBounds(), { padding: [24, 24] });
  } else if (a.map) {
    // GPS 경로는 없지만 Strava 정적 지도 이미지가 있는 경우
    mapBox.hidden = true;
    note.hidden = false;
    note.innerHTML = `GPS 경로 데이터가 없어 지도를 그릴 수 없어요. <a href="${a.map}" target="_blank" rel="noopener">Strava 지도 이미지 보기 ↗</a>`;
  } else {
    mapBox.hidden = true;
    note.hidden = false;
    note.textContent = '트레드밀·실내 러닝이라 GPS 좌표가 없어요.';
  }
  if (!mapBox.hidden) setTimeout(() => state.map.invalidateSize(), 60);
  modal.querySelector('.modal-close').focus();
}

async function loadPoly(a) {
  const y = a.year || (a.p && a.p.y);
  if (!y) return null;
  const store = await loadPolyStore(y);
  const s = store[a.id];
  return s ? decodePolyline(s) : null;
}

async function loadPolyStore(year) {
  let store = state.polyCache.get(year);
  if (store) return store;
  try {
    const res = await fetch(POLY_URL(year), { cache: 'no-cache' });
    store = res.ok ? await res.json() : {};
  } catch { store = {}; }
  state.polyCache.set(year, store);
  return store;
}

function setupMap() {
  if (state.map) return;
  state.map = L.map('modalMap', { zoomControl: true, attributionControl: true, scrollWheelZoom: true, maxZoom: 14 });
  // 라이트 테마에 맞는 밝은 지도 타일 (Esri Light Gray Canvas · 키 불필요)
  // 국내에는 13레벨보다 자세한 타일이 없어(그 이상은 "Map data not yet available") 13레벨을 확대해 쓴다.
  L.tileLayer(ESRI_LIGHT, {
    maxZoom: 14,
    maxNativeZoom: 13,
    attribution: ESRI_ATTR,
  }).addTo(state.map);
  state.map.setView([37.5665, 126.9780], 12);
}

/* Google polyline 인코딩 해제 (precision 5) */
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0;
  const out = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
});

boot();
})();
