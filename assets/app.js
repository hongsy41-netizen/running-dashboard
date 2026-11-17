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

const state = {
  acts: [],
  meta: {},
  heatYear: null,
  monthYear: null,
  listYear: 'all',
  search: '',
  shown: PAGE_SIZE,
  polyCache: new Map(),
  charts: {},
  map: null,
  mapLayer: null,
};

/* ── 작은 도우미들 ─────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

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

  renderHeader();
  renderKpis();
  renderHeatmapTabs();
  renderHeatmap(state.heatYear);
  renderMonthlyYearOptions();
  renderMonthly(state.monthYear);
  renderYearly();
  renderWeekday();
  renderHour();
  renderRecords();
  renderGear();
  renderListYears();
  renderList();

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
    s.style.width = '14px'; s.style.flex = '0 0 14px'; s.style.marginRight = '4px';
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
      const lvl = m === 0 ? 0 : m < HEAT_LEVELS[0] ? 1 : m < HEAT_LEVELS[1] ? 2 : m < HEAT_LEVELS[2] ? 3 : m < HEAT_LEVELS[3] ? 4 : 5;
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
    x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#8b95a7', font: CHART_FONT } },
    y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#8b95a7', font: CHART_FONT }, beginAtZero: true },
  }, extra);
}
const TOOLTIP = {
  backgroundColor: '#0a0d13',
  borderColor: '#232a36',
  borderWidth: 1,
  titleColor: '#fff',
  bodyColor: '#b6c0d1',
  padding: 10,
  cornerRadius: 9,
  titleFont: CHART_FONT,
  bodyFont: CHART_FONT,
};
function drawChart(id, cfg) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(canvas, Object.assign({ options: { responsive: true, maintainAspectRatio: false } }, cfg));
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
          borderColor: '#22d3a6', backgroundColor: '#22d3a6', borderWidth: 2.5,
          pointRadius: 3, pointHoverRadius: 5, tension: .35, spanGaps: true,
          yAxisID: 'y1', order: 1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#9aa6b8', boxWidth: 10, boxHeight: 10, font: CHART_FONT } },
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
        y: { position: 'left', title: { display: true, text: 'km', color: '#6b7688', font: CHART_FONT },
             grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#8b95a7', font: CHART_FONT }, beginAtZero: true },
        y1: { position: 'right', reverse: true, title: { display: true, text: "페이스 (분/km)", color: '#22d3a6', font: CHART_FONT },
              grid: { display: false }, ticks: { color: '#22d3a6', font: CHART_FONT }, beginAtZero: false },
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
          backgroundColor: 'rgba(91,141,239,.7)', hoverBackgroundColor: '#5b8def', borderRadius: 6, order: 2 },
        { type: 'line', label: '평균 페이스', data: years.map((y) => {
            const r = byYear.get(y); const p = paceSec(r.m * 1000, r.s); return p ? +(p / 60).toFixed(2) : null;
          }), borderColor: '#22d3a6', borderWidth: 2.5, pointRadius: 3, tension: .35, yAxisID: 'y1', order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#9aa6b8', boxWidth: 10, boxHeight: 10, font: CHART_FONT } },
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
        y1: { position: 'right', reverse: true, grid: { display: false }, ticks: { color: '#22d3a6', font: CHART_FONT } },
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
        backgroundColor: dist.map((_, i) => (i >= 5 ? 'rgba(252,82,0,.8)' : 'rgba(91,141,239,.7)')),
        borderRadius: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: '요일별 누적 거리', align: 'start', color: '#8b95a7', font: Object.assign({ size: 12 }, CHART_FONT) },
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
        backgroundColor: 'rgba(34,211,166,.65)', hoverBackgroundColor: '#22d3a6', borderRadius: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: '시간대별 러닝 횟수', align: 'start', color: '#8b95a7', font: Object.assign({ size: 12 }, CHART_FONT) },
        tooltip: Object.assign({}, TOOLTIP, { callbacks: {
          label: (c) => `${c.parsed.y}회 · ${dist[c.dataIndex].toFixed(0)} km` } }),
      },
      scales: baseScales(),
    },
  });
}

/* ── 개인 기록 ─────────────────────────────────────────────── */
function renderRecords() {
  const acts = state.acts.filter((a) => num(a.dist) > 0);
  const longest = acts.reduce((b, a) => (km(a.dist) > km(b && b.dist ? b.dist : 0) ? a : b), null);
  const longestT = acts.reduce((b, a) => (num(a.mv) > num(b && b.mv ? b.mv : 0) ? a : b), null);
  const fast = acts.filter((a) => km(a.dist) >= 5 && a.pace).sort((a, b) => a.pace - b.pace)[0];

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
    ['⚡', '최고 평균 페이스', fast ? fmtPace(1000, fast.pace) : '—', fast ? `${fast.p.date} · ${fmtKm(fast.dist)} km` : '5km 이상 기준'],
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
  $('#loadMore').addEventListener('click', () => { state.shown += PAGE_SIZE; renderList(); });
}

function filteredActs() {
  return state.acts.filter((a) => {
    if (state.listYear !== 'all' && String(a.year) !== String(state.listYear)) return false;
    if (state.search) {
      const hay = `${a.name || ''} ${a.sport || ''} ${a.gear || ''}`.toLowerCase();
      if (!hay.includes(state.search)) return false;
    }
    return true;
  });
}

function renderList() {
  const list = filteredActs();
  const box = $('#activityList');
  box.innerHTML = '';
  $('#listCount').textContent = `${list.length.toLocaleString('ko-KR')}개 활동 · 최근 순`;
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
         <span class="a-meta">${a.p.year}년 · ${a.gear || (a.el ? `고도 ${Math.round(a.el)}m` : '—')}</span></span>
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
    const start = L.circleMarker(poly[0], { radius: 5, color: '#22d3a6', fillColor: '#22d3a6', fillOpacity: 1 }).addTo(state.map);
    const end = L.circleMarker(poly[poly.length - 1], { radius: 5, color: '#5b8def', fillColor: '#5b8def', fillOpacity: 1 }).addTo(state.map);
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
  if (!a.p || !a.p.year) return null;
  const y = a.p.year;
  let store = state.polyCache.get(y);
  if (!store) {
    try {
      const res = await fetch(POLY_URL(y), { cache: 'force-cache' });
      store = res.ok ? await res.json() : {};
    } catch { store = {}; }
    state.polyCache.set(y, store);
  }
  const s = store[a.id];
  return s ? decodePolyline(s) : null;
}

function setupMap() {
  if (state.map) return;
  state.map = L.map('modalMap', { zoomControl: true, attributionControl: true, scrollWheelZoom: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, attribution: '지도 © Esri, HERE, Garmin, OpenStreetMap contributors',
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
