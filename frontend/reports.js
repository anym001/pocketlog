// Reports: Chart.js wiring, range/data plumbing and the report renderers
// (overview, course, breakdown, trend, detail, forecast, top).
// Classic script — see index.html for load order.

// ── CHARTS ────────────────────────────────────────────────────────────────────
function getChartColors() {
  // Read the effective theme from data-dark — same source CSS uses.
  const dark = document.documentElement.getAttribute('data-dark') === 'true';
  return {
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    text: dark ? '#a09d98' : '#6b6760',
  };
}

// Reads a CSS custom-property value from the active theme. If `alpha` < 1
// the hex value is converted to rgba() so Chart.js can draw a transparent
// variant. Only hex tokens (#RRGGBB) are supported — all report accents
// are stored as hex.
function cssColor(name, alpha = 1) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (alpha >= 1 || !v.startsWith('#')) return v;
  const n = parseInt(v.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ── REPORTS — RANGE & DATA ────────────────────────────────────────────────────
// _iso() and _daysInMonth() live in utils.js (loaded before this file).

function computeRange(kind, a) {
  if (kind === 'month') {
    const last = _daysInMonth(a.y, a.m);
    return { from: _iso(a.y, a.m, 1), to: _iso(a.y, a.m, last) };
  }
  if (kind === 'quarter') {
    const startM = a.q * 3;
    const endM = startM + 2;
    const last = _daysInMonth(a.y, endM);
    return { from: _iso(a.y, startM, 1), to: _iso(a.y, endM, last) };
  }
  if (kind === 'year') {
    return { from: _iso(a.y, 0, 1), to: _iso(a.y, 11, 31) };
  }
  // custom: from/to stay as last entered.
  return { from: appState.reports.range.from, to: appState.reports.range.to };
}

function applyRange(opts = {}) {
  const r = computeRange(appState.reports.range.kind, appState.reports.range.anchor);
  if (appState.reports.range.kind !== 'custom') {
    appState.reports.range.from = r.from;
    appState.reports.range.to = r.to;
  }
  updatePickerUI();
  if (!opts.skipRender && appState.nav.activePanel === 'charts') renderReport();
}

function setRangeKind(kind, opts = {}) {
  if (appState.reports.rangeLock && kind !== appState.reports.rangeLock) return;
  if (!['month', 'quarter', 'year', 'custom'].includes(kind)) return;
  appState.reports.range.kind = kind;
  if (kind === 'custom' && (!appState.reports.range.from || !appState.reports.range.to)) {
    // When switching to "custom", prefill with the current month bounds.
    const r = computeRange('month', appState.reports.range.anchor);
    appState.reports.range.from = r.from;
    appState.reports.range.to = r.to;
  }
  applyRange(opts);
}

function shiftRange(delta) {
  const a = appState.reports.range.anchor;
  if (appState.reports.range.kind === 'month') {
    let m = a.m + delta,
      y = a.y;
    while (m < 0) {
      m += 12;
      y--;
    }
    while (m > 11) {
      m -= 12;
      y++;
    }
    a.m = m;
    a.y = y;
    a.q = Math.floor(m / 3);
  } else if (appState.reports.range.kind === 'quarter') {
    let q = a.q + delta,
      y = a.y;
    while (q < 0) {
      q += 4;
      y--;
    }
    while (q > 3) {
      q -= 4;
      y++;
    }
    a.q = q;
    a.y = y;
    a.m = q * 3;
  } else if (appState.reports.range.kind === 'year') {
    a.y += delta;
  } else {
    return; // Custom hat keinen Stepper
  }
  applyRange();
}

function onCustomRangeChange() {
  const from = document.getElementById('rangeFrom').value;
  const to = document.getElementById('rangeTo').value;
  if (!from || !to) return;
  if (from > to) {
    toast(tr('reports.endAfterStart'));
    return;
  }
  appState.reports.range.from = from;
  appState.reports.range.to = to;
  renderReport();
}

function setRangeLock(kind) {
  appState.reports.rangeLock = kind;
  const tabs = document.querySelectorAll('#rangeKindTabs button');
  tabs.forEach((b) => {
    const allowed = !kind || b.dataset.kind === kind;
    b.disabled = !allowed;
    b.setAttribute('aria-disabled', String(!allowed));
  });
}

function _rangeStepperLabel() {
  const a = appState.reports.range.anchor;
  if (appState.reports.range.kind === 'month') return `${appState.calendar.months[a.m]} ${a.y}`;
  if (appState.reports.range.kind === 'quarter') return `Q${a.q + 1} ${a.y}`;
  if (appState.reports.range.kind === 'year') return `${a.y}`;
  return '';
}

function _rangeSubtitle(txCount) {
  const noun = txCount === 1 ? tr('tx.countOne') : tr('tx.countOther');
  if (appState.reports.range.kind === 'custom') {
    return `${fmtDate(appState.reports.range.from)} – ${fmtDate(appState.reports.range.to)} · ${txCount} ${noun}`;
  }
  return `${_rangeStepperLabel()} · ${txCount} ${noun}`;
}

// The trend ignores the shared period: its subtitle names its own year range.
function _trendSubtitle(txCount) {
  const noun = txCount === 1 ? tr('tx.countOne') : tr('tx.countOther');
  const { yearFrom, yearTo } = appState.trend;
  const years = yearFrom === yearTo ? `${yearFrom}` : `${yearFrom} – ${yearTo}`;
  return `${years} · ${txCount} ${noun}`;
}

function updatePickerUI() {
  document.querySelectorAll('#rangeKindTabs button').forEach((b) => {
    const active = b.dataset.kind === appState.reports.range.kind;
    b.setAttribute('aria-selected', String(active));
    b.classList.toggle('is-active', active);
  });
  // The stepper-label popover only makes sense for month/year — close it if the
  // kind changed to one without it (quarter/custom).
  if (!_rangePickerActive() && appState.reports.pickerOpen) toggleRangePicker(false);
  const stepper = document.getElementById('rangeStepper');
  const custom = document.getElementById('rangeCustom');
  if (appState.reports.range.kind === 'custom') {
    stepper.hidden = true;
    custom.hidden = false;
    document.getElementById('rangeFrom').value = appState.reports.range.from || '';
    document.getElementById('rangeTo').value = appState.reports.range.to || '';
  } else {
    stepper.hidden = false;
    custom.hidden = true;
    document.getElementById('rangeStepperLabelText').textContent = _rangeStepperLabel();
    document
      .getElementById('rangeStepperLabel')
      .classList.toggle('is-interactive', _rangePickerActive());
  }
}

// ── REPORTS — RANGE PICKER POPOVER ────────────────────────────────────────────
// The stepper label opens a popover to jump further than the ±1 arrows: a month
// grid (kind 'month') or a 12-year grid (kind 'year'). Reuses the .month-picker
// styling and the shared modal-focus helpers. Quarter/custom have no popover.

function _rangePickerActive() {
  const k = appState.reports.range.kind;
  return k === 'month' || k === 'year';
}

function _rangePickerCloseOnOutside(e) {
  const pop = document.getElementById('rangePicker');
  const label = document.getElementById('rangeStepperLabel');
  if (!pop || pop.contains(e.target) || (label && label.contains(e.target))) return;
  toggleRangePicker(false);
}

function _rangePickerCloseOnEsc(e) {
  if (e.key === 'Escape') toggleRangePicker(false);
}

function toggleRangePicker(open) {
  const next = open === undefined ? !appState.reports.pickerOpen : !!open;
  if (next && !_rangePickerActive()) return;
  const pop = document.getElementById('rangePicker');
  const label = document.getElementById('rangeStepperLabel');
  if (!pop) return;
  appState.reports.pickerOpen = next;
  pop.hidden = !next;
  if (label) label.setAttribute('aria-expanded', String(next));
  if (next) {
    appState.reports.pickerYear = appState.reports.range.anchor.y;
    rememberModalFocus('rangePicker');
    renderRangePicker();
    trapFocusIn(pop, 'rangePicker');
    // Defer so the opening click doesn't immediately close it again.
    setTimeout(() => {
      document.addEventListener('pointerdown', _rangePickerCloseOnOutside);
      document.addEventListener('keydown', _rangePickerCloseOnEsc);
      const cur = pop.querySelector('.mp-month.is-current') || pop.querySelector('.mp-month');
      if (cur) cur.focus();
    }, 0);
  } else {
    releaseFocusTrap('rangePicker');
    document.removeEventListener('pointerdown', _rangePickerCloseOnOutside);
    document.removeEventListener('keydown', _rangePickerCloseOnEsc);
    restoreModalFocus('rangePicker');
  }
}

function renderRangePicker() {
  const grid = document.getElementById('rangePickerGrid');
  const yearLabel = document.getElementById('rangePickerYearLabel');
  const today = new Date();
  const a = appState.reports.range.anchor;
  if (appState.reports.range.kind === 'year') {
    // 12-year grid, paged in decade-aligned blocks.
    const base = Math.floor(appState.reports.pickerYear / 12) * 12;
    yearLabel.textContent = `${base}–${base + 11}`;
    grid.innerHTML = Array.from({ length: 12 }, (_, i) => base + i)
      .map((y) => {
        const cls = ['mp-month'];
        if (y === a.y) cls.push('is-current');
        if (y === today.getFullYear()) cls.push('is-today');
        return `<button type="button" class="${cls.join(' ')}" data-action="pickRangeYear" data-args="[${y}]"${
          y === a.y ? ' aria-current="true"' : ''
        }>${y}</button>`;
      })
      .join('');
  } else {
    const year = appState.reports.pickerYear;
    yearLabel.textContent = String(year);
    grid.innerHTML = appState.calendar.monthsShort
      .map((name, m) => {
        const isCurrent = m === a.m && year === a.y;
        const isToday = m === today.getMonth() && year === today.getFullYear();
        const cls = ['mp-month'];
        if (isCurrent) cls.push('is-current');
        if (isToday) cls.push('is-today');
        return `<button type="button" class="${cls.join(' ')}" data-action="pickRangeMonth" data-args="[${m}]"${
          isCurrent ? ' aria-current="true"' : ''
        }>${_escText(name)}</button>`;
      })
      .join('');
  }
}

function stepRangePicker(d) {
  appState.reports.pickerYear += appState.reports.range.kind === 'year' ? d * 12 : d;
  renderRangePicker();
}

function pickRangeMonth(m) {
  const a = appState.reports.range.anchor;
  a.m = m;
  a.y = appState.reports.pickerYear;
  a.q = Math.floor(m / 3);
  toggleRangePicker(false);
  applyRange();
}

function pickRangeYear(y) {
  appState.reports.range.anchor.y = y;
  toggleRangePicker(false);
  applyRange();
}

function rangePickerToday() {
  const now = new Date();
  const a = appState.reports.range.anchor;
  a.y = now.getFullYear();
  if (appState.reports.range.kind !== 'year') {
    a.m = now.getMonth();
    a.q = Math.floor(a.m / 3);
  }
  toggleRangePicker(false);
  applyRange();
}

async function _loadYearTxs(year) {
  if (_txCacheByYear.has(year)) return _txCacheByYear.get(year);
  try {
    const raw = await api('GET', `/transactions?year=${year}`);
    const txs = raw.map(normalizeTx);
    _txCacheByYear.set(year, txs);
    return txs;
  } catch (e) {
    return [];
  }
}

async function loadRangeTxs(from, to) {
  if (!from || !to) return [];
  const y1 = parseInt(from.slice(0, 4), 10);
  const y2 = parseInt(to.slice(0, 4), 10);
  const years = [];
  for (let y = y1; y <= y2; y++) years.push(y);
  const pools = await Promise.all(years.map(_loadYearTxs));
  const all = pools.flat();
  return all.filter((t) => t.date >= from && t.date <= to);
}

// ── REPORTS — RENDER DISPATCH ─────────────────────────────────────────────────

async function renderReport(id = appState.reports.current) {
  if (!REPORT_IDS.includes(id)) id = 'overview';
  const gen = ++appState.reports.renderGen;
  appState.reports.current = id;
  try {
    localStorage.setItem(REPORT_STORAGE_KEY, id);
  } catch (e) {}
  document.body.setAttribute('data-report', id);
  if (id === 'trend') {
    await _ensureTrendDefaultRange();
    if (_staleRender(gen)) return;
  }
  // No report pins the period any more — "course" adapts its granularity to
  // whatever the picker is set to, so the picker stays fully free everywhere.
  setRangeLock(null);
  updatePickerUI();
  document.getElementById('reportTitle').textContent = reportTitle(id);
  // A drill-down into the detail report offers the way back to its origin.
  const returnTo = id === 'detail' ? appState.reports.detail.returnTo : null;
  document.getElementById('reportBack').hidden = !returnTo;
  if (returnTo) document.getElementById('reportBackLabel').textContent = reportTitle(returnTo);

  Object.keys(chartInsts).forEach((k) => {
    if (chartInsts[k]) {
      chartInsts[k].destroy();
      chartInsts[k] = null;
    }
  });

  const body = document.getElementById('reportBody');
  body.innerHTML = '';

  // Trend uses its own private year range and never touches appState.reports.range.
  const rangeFrom =
    id === 'trend' ? `${appState.trend.yearFrom}-01-01` : appState.reports.range.from;
  const rangeTo = id === 'trend' ? `${appState.trend.yearTo}-12-31` : appState.reports.range.to;
  const txs = await loadRangeTxs(rangeFrom, rangeTo);
  // A newer render (another report or period picked while this one loaded)
  // owns the body now; drawing this one would overwrite it.
  if (_staleRender(gen)) return;
  appState.reports.txPool = txs;
  document.getElementById('reportRangeLabel').textContent =
    id === 'trend' ? _trendSubtitle(txs.length) : _rangeSubtitle(txs.length);

  if (id === 'overview') await renderReportOverview(body, txs);
  else if (id === 'course') await renderReportCourse(body, txs);
  else if (id === 'breakdown') renderReportBreakdown(body, txs);
  else if (id === 'trend') await renderReportTrend(body, txs);
  else if (id === 'detail') renderReportDetail(body, txs);
  else if (id === 'forecast') await renderReportForecast(body, txs);
  else if (id === 'top') renderReportTop(body, txs);
}

// True once a newer renderReport started. A renderer that awaits more data
// captures appState.reports.renderGen on entry and checks this after every
// await, before it touches the body or the chart instances.
function _staleRender(gen) {
  return gen !== appState.reports.renderGen;
}

// ── REPORTS — SHARED HELPERS ──────────────────────────────────────────────────

// _sumByType() and _totalsByCategory() live in reportsData.js (loaded before
// this file).

function _catRowMarkup(catId, amount, max, opts = {}) {
  const cat = getCatById(catId);
  if (!cat) return '';
  const pct = max > 0 ? (amount / max) * 100 : 0;
  const drill = opts.drillDown
    ? `role="button" tabindex="0" data-action="openDetail" data-args='["cat:${catId}"]'`
    : '';
  const amtClass = opts.positive ? 'cat-amount is-positive' : 'cat-amount';
  return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(cat.name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${cat.color}"></div></div>
          </div>
          <div class="${amtClass}">${fmtCurrency(Math.abs(amount))}</div>
        </div>`;
}

function _txRowMarkup(t) {
  const cat = getCatById(t.category_id);
  const dateLbl = fmtDate(t.date);
  const tagsHtml = (t.tags || [])
    .map((tag) => `<span class="t-tag">${_escText(tag)}</span>`)
    .join('');
  return `<div class="report-tx-row" role="button" tabindex="0"
          data-action="editTransaction" data-args="[${t.id}]">
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="report-tx-main">
            <div class="report-tx-desc">${_escText(txTitle(t, cat))}</div>
            <div class="t-tags">${tagsHtml}</div>
            <div class="report-tx-meta">${dateLbl}</div>
          </div>
          <div class="report-tx-amount ${t.type === 'out' ? 'negative' : 'positive'}">${fmtSignedCurrency(t.amount, t.type)}</div>
        </div>`;
}

function _emptyState(msg) {
  return `<p class="empty-state-hint center">${msg}</p>`;
}

// ── REPORTS — OVERVIEW ────────────────────────────────────────────────────────

async function renderReportOverview(body, txs) {
  const totals = _sumByType(txs);
  const balance = totals.in - totals.out;
  // Two-sided snapshot: top spending and top income categories side by side,
  // plus the largest transactions of either direction (colour-coded by
  // _txRowMarkup). Tags live in the dedicated tag analysis, not here.
  const topOut = _totalsByCategory(txs, 'out').slice(0, 3);
  const topIn = _totalsByCategory(txs, 'in').slice(0, 3);
  const topTx = [...txs].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const maxOut = topOut[0]?.amount || 1;
  const maxIn = topIn[0]?.amount || 1;

  body.innerHTML = `
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${balance >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(balance, _netDirection(balance))}</div></div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.topExpenses')}</h3>
            <div id="overviewExpenses">${topOut.length ? topOut.map((c) => _catRowMarkup(c.catId, c.amount, maxOut, { drillDown: true })).join('') : _emptyState(tr('reports.noExpenses'))}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.topIncome')}</h3>
            <div id="overviewIncome">${topIn.length ? topIn.map((c) => _catRowMarkup(c.catId, c.amount, maxIn, { drillDown: true, positive: true })).join('') : _emptyState(tr('reports.noIncome'))}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.top')}</h3>
            <div id="overviewTop">${topTx.length ? topTx.map(_txRowMarkup).join('') : _emptyState(tr('reports.noTransactions'))}</div>
          </div>

        `;
}

// ── REPORTS — COURSE (over time) ──────────────────────────────────────────────
// One report that follows the period picker: a single month draws cumulative
// lines, any wider range (quarter / year / custom) a monthly in/out line. Merges
// the former month- and year-trend reports so there is one "Verlauf" instead of
// two near-identical ones locked to their granularity.

async function renderReportCourse(body, txs) {
  if (appState.reports.range.kind === 'month') _renderCourseDaily(body, txs);
  else await _renderCourseMonthly(body, txs);
}

function _courseKpisMarkup(totals) {
  return `<div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(totals.in - totals.out, _netDirection(totals.in - totals.out))}</div></div>
          </div>`;
}

function _courseChartScales(c) {
  return {
    x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
    y: {
      ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
      grid: { color: c.grid },
    },
  };
}

// Month range: running totals of expenses and income across the days. One
// month of sparse daily bars (a single salary spike set the scale, labels had
// to rotate) said little; the cumulative lines show how the month builds up
// and where income and spending stand on any day. Expenses solid, income
// dashed — the two direction colours sit too close for colour-blind readers
// to carry identity alone.
function _renderCourseDaily(body, txs) {
  const a = appState.reports.range.anchor;
  const totals = _sumByType(txs);

  body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="courseChart" role="img" aria-labelledby="reportTitle" aria-describedby="courseChartSummary"></canvas></div>
            <p id="courseChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.monthSummary', { month: appState.calendar.months[a.m], year: a.y, income: fmtCurrency(totals.in), expenses: fmtCurrency(totals.out) })}</p>
          </div>
          ${_courseKpisMarkup(totals)}
        `;
  chartInsts.course = _cumulativeChart(document.getElementById('courseChart'), txs, a, {
    out: true,
    in: true,
  });
}

// Running expense/income lines across the days of the anchor month (shared by
// "Verlauf" and the detail report). `dirs` picks the lines to draw.
function _cumulativeChart(canvas, txs, a, dirs) {
  const days = _daysInMonth(a.y, a.m);
  const labels = Array.from({ length: days }, (_, i) => i + 1);
  const now = new Date();
  const thisMonth = a.y === now.getFullYear() && a.m === now.getMonth();
  const isFuture = a.y > now.getFullYear() || (a.y === now.getFullYear() && a.m > now.getMonth());
  const lastDay = isFuture ? 0 : thisMonth ? now.getDate() : days;
  const cum = _cumulativeByDay(txs, days, lastDay);

  const c = getChartColors();
  const line = (label, data, color, dash) => ({
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderDash: dash,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHitRadius: 12,
    tension: 0,
    spanGaps: false,
  });
  const datasets = [];
  if (dirs.out) datasets.push(line(tr('reports.expenses'), cum.out, cssColor('--accent'), []));
  if (dirs.in) datasets.push(line(tr('reports.income'), cum.in, cssColor('--green'), [6, 4]));
  const scales = _courseChartScales(c);
  scales.x.ticks = { ...scales.x.ticks, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 };
  scales.y.beginAtZero = true;
  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        // One line needs no legend: the report names what it shows.
        legend: {
          display: datasets.length > 1,
          labels: {
            color: c.text,
            font: { family: 'DM Sans', size: 11 },
            usePointStyle: true,
            pointStyle: 'line',
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? fmtDate(_iso(a.y, a.m, Number(items[0].label))) : ''),
            label: (ctx) => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}`,
          },
        },
      },
      scales,
    },
  });
}

async function _renderCourseMonthly(body, txs) {
  const gen = appState.reports.renderGen;
  const bucketKeys = _bucketAxis(appState.reports.range.from, appState.reports.range.to, 'month');
  const labels = bucketKeys.map((k) => _bucketLabel(k, 'month'));
  const slots = new Map(bucketKeys.map((k) => [k, { out: 0, in: 0 }]));
  for (const t of txs) {
    const key = t.date.slice(0, 7);
    if (slots.has(key)) slots.get(key)[t.type] += t.amount;
  }
  const monthly = bucketKeys.map((k) => slots.get(k));
  const totals = _sumByType(txs);

  // Prev-year comparison only for the year view: the picker sits on a single
  // calendar year, so the 12 buckets line up month-for-month with last year.
  const isYear = appState.reports.range.kind === 'year';
  let prevOut = null;
  if (isYear) {
    const y = appState.reports.range.anchor.y;
    const prevTxs = await _loadYearTxs(y - 1);
    if (_staleRender(gen)) return;
    if (prevTxs.length) {
      prevOut = Array.from({ length: 12 }, () => 0);
      for (const t of prevTxs) {
        // Month from the ISO string: new Date('YYYY-MM-01') parses as UTC
        // and lands in the previous month west of Greenwich.
        if (t.type === 'out') prevOut[Number(t.date.slice(5, 7)) - 1] += t.amount;
      }
    }
  }

  body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="courseChart" role="img" aria-labelledby="reportTitle" aria-describedby="courseChartSummary"></canvas></div>
            <p id="courseChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.courseSummary', { income: fmtCurrency(totals.in), expenses: fmtCurrency(totals.out) })}</p>
          </div>
          ${_courseKpisMarkup(totals)}
        `;

  const c = getChartColors();
  const datasets = [
    {
      label: tr('reports.expenses'),
      data: monthly.map((m) => m.out),
      borderColor: cssColor('--accent'),
      backgroundColor: cssColor('--accent', 0.1),
      tension: 0.4,
      fill: true,
      pointRadius: 3,
    },
    {
      label: tr('reports.income'),
      data: monthly.map((m) => m.in),
      borderColor: cssColor('--green'),
      backgroundColor: cssColor('--green', 0.1),
      tension: 0.4,
      fill: true,
      pointRadius: 3,
    },
  ];
  if (prevOut) {
    datasets.push({
      label: tr('reports.expensesYear', { year: appState.reports.range.anchor.y - 1 }),
      data: prevOut,
      borderColor: cssColor('--accent', 0.5),
      borderDash: [5, 4],
      backgroundColor: 'transparent',
      tension: 0.4,
      fill: false,
      pointRadius: 0,
    });
  }
  chartInsts.course = new Chart(document.getElementById('courseChart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
      scales: _courseChartScales(c),
    },
  });
}

// ── REPORTS — CATEGORIES ──────────────────────────────────────────────────────

// Expenses/income toggle shared by the category and tag breakdown donuts. A
// donut is parts-of-a-whole, so it shows one direction at a time; this flips
// appState.reports.breakdownDir and re-renders the current report.
function _breakdownSegmentedMarkup() {
  const dir = appState.reports.breakdownDir;
  return `<div class="segmented" role="tablist" aria-label="${_escAttr(tr('reports.breakdownSelect'))}">
            <button type="button" role="tab" aria-selected="${dir === 'out'}" class="${dir === 'out' ? 'is-active' : ''}" data-action="setBreakdownDir" data-args='["out"]'>${tr('reports.expenses')}</button>
            <button type="button" role="tab" aria-selected="${dir === 'in'}" class="${dir === 'in' ? 'is-active' : ''}" data-action="setBreakdownDir" data-args='["in"]'>${tr('reports.income')}</button>
          </div>`;
}

function setBreakdownDir(dir) {
  if (dir !== 'out' && dir !== 'in') return;
  if (appState.reports.breakdownDir === dir) return;
  appState.reports.breakdownDir = dir;
  renderReport();
}

// Entity toggle (categories/tags) for the breakdown, mirroring the trend's
// selector; sits next to the direction toggle in one control row.
function _breakdownKindSegmentedMarkup() {
  const kind = appState.reports.breakdownKind;
  return `<div class="segmented" role="tablist" aria-label="${_escAttr(tr('reports.trendSelect'))}">
            <button type="button" role="tab" aria-selected="${kind === 'category'}" class="${kind === 'category' ? 'is-active' : ''}" data-action="setBreakdownKind" data-args='["category"]'>${tr('reports.kindCategories')}</button>
            <button type="button" role="tab" aria-selected="${kind === 'tag'}" class="${kind === 'tag' ? 'is-active' : ''}" data-action="setBreakdownKind" data-args='["tag"]'>${tr('reports.kindTags')}</button>
          </div>`;
}

function setBreakdownKind(kind) {
  if (kind !== 'category' && kind !== 'tag') return;
  if (appState.reports.breakdownKind === kind) return;
  appState.reports.breakdownKind = kind;
  renderReport();
}

// "Aufteilung": one donut report with an entity toggle (categories/tags) and a
// direction toggle (expenses/income). Merges the former category- and tag-
// analysis reports into a single, consistent breakdown.
function renderReportBreakdown(body, txs) {
  const controls = `<div class="report-section breakdown-controls">${_breakdownKindSegmentedMarkup()}${_breakdownSegmentedMarkup()}</div>`;
  if (appState.reports.breakdownKind === 'tag') _breakdownTags(body, txs, controls);
  else _breakdownCategories(body, txs, controls);
}

function _breakdownCategories(body, txs, controls) {
  const dir = appState.reports.breakdownDir;
  const segmented = controls;
  const sorted = _totalsByCategory(txs, dir);
  if (!sorted.length) {
    body.innerHTML = `${segmented}<div class="report-section">${_emptyState(
      tr(dir === 'out' ? 'reports.noExpenses' : 'reports.noIncome'),
    )}</div>`;
    return;
  }
  const total = sorted.reduce((s, c) => s + c.amount, 0);
  const max = sorted[0].amount;
  const donutLabel = tr(
    dir === 'out' ? 'reports.expensesPerCategory' : 'reports.incomePerCategory',
  );
  const totalLabel = tr(dir === 'out' ? 'reports.expensesTotal' : 'reports.incomeTotal');

  body.innerHTML = `
          ${segmented}
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="categoriesDonut" role="img" aria-label="${_escAttr(donutLabel)}"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">${totalLabel}</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((c) => _catRowMarkup(c.catId, c.amount, max, { drillDown: true, positive: dir === 'in' })).join('')}
          </div>
        `;

  chartInsts.breakdown = new Chart(document.getElementById('categoriesDonut'), {
    type: 'doughnut',
    data: {
      labels: sorted.map((c) => getCatById(c.catId)?.name || ''),
      datasets: [
        {
          data: sorted.map((c) => c.amount),
          backgroundColor: sorted.map((c) => getCatById(c.catId)?.color || cssColor('--accent')),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } },
      },
    },
  });
}

// The ledger search filtered to one category or tag over the report range —
// the detail report's "show in the ledger" link, where bulk actions live.
async function drillDownCategory(catId) {
  appState.reports.searchExitTarget = 'charts';
  appState.nav.categoryFilterId = catId;
  const { from, to } = appState.reports.range;
  appState.ledger.all = await loadRangeTxs(from, to);
  document.body.classList.add('searching');
  await _setSearchPanelActive(true);
  applySearch();
}

// ── REPORTS — TAGS ────────────────────────────────────────────────────────────

// _tagColor() and _totalsByTag() live in reportsData.js, _escAttr() and
// _escText() in utils.js (both loaded before this file).

function _tagRowMarkup(name, amount, max, opts = {}) {
  const color = _tagColor(name);
  const pct = max > 0 ? (amount / max) * 100 : 0;
  const attrName = _escAttr(name);
  const drill = opts.drillDown ? `role="button" tabindex="0" data-tag-drill="${attrName}"` : '';
  const amtClass = opts.positive ? 'cat-amount is-positive' : 'cat-amount';
  return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${color}">#</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${color}"></div></div>
          </div>
          <div class="${amtClass}">${fmtCurrency(Math.abs(amount))}</div>
        </div>`;
}

function _breakdownTags(body, txs, controls) {
  const dir = appState.reports.breakdownDir;
  const segmented = controls;
  const sorted = _totalsByTag(txs, dir);
  if (!sorted.length) {
    body.innerHTML = `${segmented}<div class="report-section">${_emptyState(
      tr(dir === 'out' ? 'reports.noTagExpenses' : 'reports.noTagIncome'),
    )}</div>`;
    return;
  }
  const total = sorted.reduce((s, t) => s + t.amount, 0);
  const max = sorted[0].amount;
  const donutLabel = tr(dir === 'out' ? 'reports.expensesPerTag' : 'reports.incomePerTag');
  const totalLabel = tr(dir === 'out' ? 'reports.expensesTotal' : 'reports.incomeTotal');

  body.innerHTML = `
          ${segmented}
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="tagsDonut" role="img" aria-label="${_escAttr(donutLabel)}"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">${totalLabel}</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((t) => _tagRowMarkup(t.name, t.amount, max, { drillDown: true, positive: dir === 'in' })).join('')}
          </div>
        `;

  chartInsts.breakdown = new Chart(document.getElementById('tagsDonut'), {
    type: 'doughnut',
    data: {
      labels: sorted.map((t) => t.name),
      datasets: [
        {
          data: sorted.map((t) => t.amount),
          backgroundColor: sorted.map((t) => _tagColor(t.name)),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } },
      },
    },
  });

  _bindTagDrill(body);
}

// Tag rows carry their name in data-tag-drill (bound here rather than through
// data-args: a tag name may hold any character). A tap opens the tag's detail.
function _bindTagDrill(scope) {
  scope.querySelectorAll('[data-tag-drill]').forEach((el) => {
    const id = `tag:${el.dataset.tagDrill}`;
    el.addEventListener('click', () => openDetail(id));
    el.addEventListener('keydown', (ev) => handleRowActivate(ev, () => openDetail(id)));
  });
}

async function drillDownTag(name) {
  appState.reports.searchExitTarget = 'charts';
  appState.nav.tagFilterName = name;
  const { from, to } = appState.reports.range;
  appState.ledger.all = await loadRangeTxs(from, to);
  document.body.classList.add('searching');
  await _setSearchPanelActive(true);
  applySearch();
}

// ── REPORTS — ENTITY PICKER ───────────────────────────────────────────────────
// One category-or-tag picker shared by the trend and the detail report: a
// Kategorien|Tags toggle, the active entity with "Wechseln", and a searchable
// chip list. `key` names the owner; its state object carries kind, selection
// (['cat:42'] / ['tag:Urlaub']), pickerOpen and pickerFilter. Element ids are
// `${key}ActiveRow`, `${key}PickerOpen` and `${key}PickerChips`.
const _ENTITY_PICKERS = {
  trend: {
    state: () => appState.trend,
    persist: () => _persistTrendState(),
    selectLabel: 'reports.trendSelect',
    sub: 'reports.largestItem',
  },
  detail: {
    state: () => appState.reports.detail,
    persist: () => _persistDetailState(),
    selectLabel: 'reports.detailSelect',
    sub: null,
  },
};

function _entityChipMarkup(id, name, color, selected) {
  const sel = selected ? 'is-selected' : '';
  return `<button type="button" class="trend-chip ${sel}" data-entity-id="${_escAttr(id)}">
          <span class="dot" style="background:${color}"></span>${_escText(name)}
        </button>`;
}

function _entityPickerMarkup(key, txs, selected) {
  const cfg = _ENTITY_PICKERS[key];
  const st = cfg.state();
  const options = _trendPickerOptions(txs, st.kind, selected && selected.id, st.pickerFilter);
  const chips = options
    .map((o) => _entityChipMarkup(o.id, o.label, o.color, selected && o.id === selected.id))
    .join('');
  const isCat = st.kind === 'category';
  const searchPlaceholder = isCat ? tr('reports.searchCategory') : tr('reports.searchTag');
  // Empty-state copy for .tag-picker-chips:empty::after, which reads data-empty.
  const emptyLabel = isCat ? tr('reports.searchNoneCategory') : tr('reports.searchNoneTag');

  const segmented = `<div class="segmented" role="tablist" aria-label="${_escAttr(tr(cfg.selectLabel))}">
            <button type="button" role="tab" aria-selected="${isCat}" class="${isCat ? 'is-active' : ''}" data-action="setEntityKind" data-args='["${key}", "category"]'>${tr('reports.kindCategories')}</button>
            <button type="button" role="tab" aria-selected="${!isCat}" class="${!isCat ? 'is-active' : ''}" data-action="setEntityKind" data-args='["${key}", "tag"]'>${tr('reports.kindTags')}</button>
          </div>`;

  const active = selected
    ? `<div class="trend-active-row" id="${key}ActiveRow"${st.pickerOpen ? ' hidden' : ''}>
              <div class="trend-active-info">
                <span class="trend-active-dot" style="background:${selected.color}"></span>
                <div class="trend-active-text">
                  <div class="trend-active-label">${_escText(selected.name)}</div>
                  ${cfg.sub ? `<span class="trend-active-sub">${tr(cfg.sub)}</span>` : ''}
                </div>
              </div>
              <button type="button" class="trend-switch-btn" data-action="toggleEntityPicker" data-args='["${key}", true]'>${tr('reports.switch')}</button>
            </div>`
    : '';

  const open = `<div class="trend-picker-open" id="${key}PickerOpen"${st.pickerOpen || !selected ? '' : ' hidden'}>
            <div class="search-wrap">
              <svg class="ui-icon" aria-hidden="true"><use href="#icon-search" /></svg>
              <input type="search" placeholder="${searchPlaceholder}" value="${_escAttr(st.pickerFilter)}" data-action-input="filterEntityChips" data-args='["${key}", "@value"]' autocomplete="off" />
            </div>
            <div class="tag-picker-chips" id="${key}PickerChips" data-empty="${_escAttr(emptyLabel)}">${chips}</div>
          </div>`;

  return { segmented, active, open };
}

function setEntityKind(key, kind) {
  const cfg = _ENTITY_PICKERS[key];
  if (!cfg || (kind !== 'category' && kind !== 'tag')) return;
  const st = cfg.state();
  if (st.kind === kind) return;
  st.kind = kind;
  st.selection = [];
  st.pickerOpen = false;
  st.pickerFilter = '';
  cfg.persist();
  renderReport();
}

function selectEntity(key, id) {
  const cfg = _ENTITY_PICKERS[key];
  if (!cfg) return;
  const st = cfg.state();
  st.selection = [id];
  st.pickerOpen = false;
  st.pickerFilter = '';
  cfg.persist();
  renderReport();
}

function toggleEntityPicker(key, open) {
  const cfg = _ENTITY_PICKERS[key];
  if (!cfg) return;
  const st = cfg.state();
  st.pickerOpen = open === undefined ? !st.pickerOpen : !!open;
  const activeRow = document.getElementById(`${key}ActiveRow`);
  const picker = document.getElementById(`${key}PickerOpen`);
  if (activeRow) activeRow.hidden = st.pickerOpen;
  if (picker) picker.hidden = !st.pickerOpen;
  if (st.pickerOpen && picker) {
    const input = picker.querySelector('input');
    if (input) input.focus();
  }
}

function filterEntityChips(key, value) {
  const cfg = _ENTITY_PICKERS[key];
  if (!cfg) return;
  const st = cfg.state();
  st.pickerFilter = value;
  const container = document.getElementById(`${key}PickerChips`);
  if (!container) return;
  const selectedId = st.selection[0] || null;
  const options = _trendPickerOptions(appState.reports.txPool || [], st.kind, selectedId, value);
  container.innerHTML = options
    .map((o) => _entityChipMarkup(o.id, o.label, o.color, selectedId && o.id === selectedId))
    .join('');
  _bindEntityChips(container, key);
}

// Chips carry their id in data-entity-id (bound here rather than through
// data-args: a tag name may hold any character).
function _bindEntityChips(scope, key) {
  scope.querySelectorAll('[data-entity-id]').forEach((el) => {
    const pick = () => selectEntity(key, el.dataset.entityId);
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (ev) => handleRowActivate(ev, pick));
  });
}

// ── REPORTS — DETAIL ──────────────────────────────────────────────────────────
// "Detailanalyse": one category or tag over the shared period — totals, its
// course, the breakdown one level down and every booking. The drill-down
// target of the other reports; the ledger search (with bulk actions) is one
// link further.

function _persistDetailState() {
  const d = appState.reports.detail;
  try {
    localStorage.setItem(
      DETAIL_STORAGE_KEY,
      JSON.stringify({ kind: d.kind, selection: d.selection, sort: d.sort }),
    );
  } catch (e) {}
}

// Opens the detail report for an entity id ('cat:42' / 'tag:Urlaub') over the
// current period. From another report it remembers that report for the back
// link; inside the detail report (a breakdown row) the origin stays.
function openDetail(id) {
  if (!_trendEntityFromId(id)) return;
  const d = appState.reports.detail;
  if (appState.reports.current !== 'detail') d.returnTo = appState.reports.current;
  d.kind = id.startsWith('cat:') ? 'category' : 'tag';
  d.selection = [id];
  d.pickerOpen = false;
  d.pickerFilter = '';
  _persistDetailState();
  renderReport('detail');
  _scrollReportTop();
}

function detailBack() {
  const to = appState.reports.detail.returnTo;
  appState.reports.detail.returnTo = null;
  renderReport(REPORT_IDS.includes(to) ? to : 'overview');
  _scrollReportTop();
}

function _scrollReportTop() {
  const panel = document.getElementById('panel-charts');
  if (panel) panel.scrollIntoView({ block: 'start' });
}

// A tap on a trend month: that month becomes the period, then the detail.
function _drillTrendMonth(id, bucketKey) {
  _narrowToMonth(bucketKey, { skipRender: true });
  openDetail(id);
}

function setDetailSort(mode) {
  if (mode !== 'date' && mode !== 'amount') return;
  const d = appState.reports.detail;
  if (d.sort === mode) return;
  d.sort = mode;
  _persistDetailState();
  const list = document.getElementById('detailTxList');
  if (list && d.summaryTxs)
    list.innerHTML = _sortDetailTxs(d.summaryTxs, mode).map(_txRowMarkup).join('');
  document.querySelectorAll('#detailSort button').forEach((b) => {
    const on = b.dataset.sort === mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function detailToLedger() {
  const entity = _trendEntityFromId(appState.reports.detail.selection[0]);
  if (!entity) return;
  if (entity.kind === 'category') drillDownCategory(entity.catId);
  else drillDownTag(entity.name);
}

function _detailKpisMarkup(sum) {
  const card = (label, value, cls) =>
    `<div class="summary-card"><div class="label">${label}</div><div class="amount ${cls}">${value}</div></div>`;
  const cards = [];
  if (sum.out > 0) cards.push(card(tr('reports.expenses'), fmtCurrency(sum.out), 'negative'));
  if (sum.in > 0) cards.push(card(tr('reports.income'), fmtCurrency(sum.in), 'positive'));
  if (sum.out > 0 && sum.in > 0) {
    const bal = sum.in - sum.out;
    cards.push(
      card(
        tr('reports.balance'),
        fmtSignedCurrency(bal, _netDirection(bal)),
        bal >= 0 ? 'positive' : 'negative',
      ),
    );
  }
  cards.push(
    card(tr(sum.dir === 'in' ? 'reports.avgPerIn' : 'reports.avgPerOut'), fmtCurrency(sum.avg), ''),
  );
  const quad = cards.length === 4 ? ' is-quad' : '';
  return `<div class="report-kpis${quad}">${cards.join('')}</div>`;
}

function _detailInnerMarkup(sum, entity) {
  if (!sum.inner.length) return '';
  const max = sum.inner[0].amount;
  const positive = sum.dir === 'in';
  const rows = sum.inner
    .map((r) => {
      if (r.kind === 'category')
        return _catRowMarkup(r.catId, r.amount, max, { drillDown: true, positive });
      if (r.kind === 'tag')
        return _tagRowMarkup(r.name, r.amount, max, { drillDown: true, positive });
      // Untagged remainder: same row, no drill target.
      const pct = max > 0 ? (r.amount / max) * 100 : 0;
      return `<div class="cat-row is-untagged">
          <div class="cat-icon">#</div>
          <div class="cat-info">
            <div class="cat-name">${tr('reports.untagged')}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%"></div></div>
          </div>
          <div class="${positive ? 'cat-amount is-positive' : 'cat-amount'}">${fmtCurrency(r.amount)}</div>
        </div>`;
    })
    .join('');
  const titleKey =
    entity.kind === 'category'
      ? positive
        ? 'reports.incomeByTag'
        : 'reports.expensesByTag'
      : positive
        ? 'reports.incomeByCategory'
        : 'reports.expensesByCategory';
  return `<div class="report-section">
            <h3 class="report-section-title">${tr(titleKey)}</h3>
            ${rows}
          </div>`;
}

function _detailListMarkup(sum) {
  const sort = appState.reports.detail.sort;
  const btn = (mode, key) =>
    `<button type="button" data-sort="${mode}" aria-pressed="${sort === mode}" class="${sort === mode ? 'is-active' : ''}" data-action="setDetailSort" data-args='["${mode}"]'>${tr(key)}</button>`;
  return `<div class="report-section">
            <div class="report-section-head">
              <h3 class="report-section-title">${tr('reports.detailBookings')}</h3>
              <div class="segmented is-compact" id="detailSort" role="group" aria-label="${_escAttr(tr('reports.sortBy'))}">${btn('date', 'reports.sortDate')}${btn('amount', 'reports.sortAmount')}</div>
            </div>
            <div id="detailTxList">${_sortDetailTxs(sum.txs, sort).map(_txRowMarkup).join('')}</div>
            <button type="button" class="report-link" data-action="detailToLedger">
              <span>${tr('reports.showInLedger')}</span>
              <svg class="ui-icon" aria-hidden="true"><use href="#icon-chevron-right" /></svg>
            </button>
          </div>`;
}

function renderReportDetail(body, txs) {
  const d = appState.reports.detail;
  let selected = d.selection[0] ? _trendEntityFromId(d.selection[0]) : null;
  if (selected && selected.kind !== d.kind) selected = null;
  if (!selected) {
    // First open (or the entity is gone): the period's largest one.
    const def = _pickDefaultTrendEntity(txs, d.kind);
    d.selection = def ? [def] : [];
    if (def) _persistDetailState();
    selected = def ? _trendEntityFromId(def) : null;
  }
  const picker = _entityPickerMarkup('detail', txs, selected);
  const controls = `<div class="report-section">${picker.segmented}${picker.active}${picker.open}</div>`;
  const sum = selected ? _detailSummary(txs, selected) : null;
  d.summaryTxs = sum ? sum.txs : null;
  // The subtitle counts the entity's bookings, not the whole period's.
  document.getElementById('reportRangeLabel').textContent = _rangeSubtitle(sum ? sum.count : 0);

  if (!sum || !sum.count) {
    body.innerHTML = `${controls}<div class="report-section">${_emptyState(tr('reports.noTransactions'))}</div>`;
    _bindEntityChips(body, 'detail');
    return;
  }

  const range = appState.reports.range;
  const daily = range.kind === 'month';
  const summary = tr('reports.detailSummary', {
    label: _escText(selected.name),
    income: fmtCurrency(sum.in),
    expenses: fmtCurrency(sum.out),
  });
  body.innerHTML = `
          ${controls}
          ${_detailKpisMarkup(sum)}
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="detailChart" role="img" aria-labelledby="reportTitle" aria-describedby="detailChartSummary"></canvas></div>
            <p id="detailChartSummary" class="visually-hidden">${summary}</p>
          </div>
          ${_detailInnerMarkup(sum, selected)}
          ${_detailListMarkup(sum)}
        `;
  _bindEntityChips(body, 'detail');
  _bindTagDrill(body);

  const canvas = document.getElementById('detailChart');
  const dirs = { out: sum.out > 0, in: sum.in > 0 };
  if (daily) {
    chartInsts.detail = _cumulativeChart(canvas, sum.txs, range.anchor, dirs);
    return;
  }
  // Wider periods: one bar pair per month. Expenses filled, income outlined —
  // the two direction colours sit too close for colour-blind readers to carry
  // identity alone. A tap on a month narrows the period to it.
  const bucketKeys = _bucketAxis(range.from, range.to, 'month');
  const monthly = _monthlyInOut(sum.txs, bucketKeys);
  const c = getChartColors();
  const datasets = [];
  if (dirs.out) {
    datasets.push({
      label: tr('reports.expenses'),
      data: monthly.out,
      backgroundColor: cssColor('--accent'),
      borderColor: cssColor('--accent'),
      borderWidth: 0,
      borderRadius: 4,
      maxBarThickness: 28,
    });
  }
  if (dirs.in) {
    datasets.push({
      label: tr('reports.income'),
      data: monthly.in,
      backgroundColor: cssColor('--green', 0.12),
      borderColor: cssColor('--green'),
      borderWidth: 2,
      borderRadius: 4,
      maxBarThickness: 28,
    });
  }
  const scales = _courseChartScales(c);
  scales.x.ticks = { ...scales.x.ticks, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 };
  scales.x.grid = { display: false };
  scales.y.beginAtZero = true;
  chartInsts.detail = new Chart(canvas, {
    type: 'bar',
    data: { labels: bucketKeys.map((k) => _bucketLabel(k, 'month')), datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      onClick: (_evt, items) => {
        // Deferred for the same reason as the trend's onClick.
        if (items.length) {
          const key = bucketKeys[items[0].index];
          setTimeout(() => _narrowToMonth(key), 0);
        }
      },
      onHover: (evt, items) => {
        evt.native.target.style.cursor = items.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: c.text, font: { family: 'DM Sans', size: 11 } },
        },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? _trendPeakLabel(bucketKeys[items[0].dataIndex]) : ''),
            label: (ctx) => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}`,
          },
        },
      },
      scales,
    },
  });
}

// Makes the month of a chart bucket ('YYYY-MM') the report period — a tap on
// a month in the detail bars, or the first step of a trend drill-down.
function _narrowToMonth(bucketKey, opts = {}) {
  const [y, m] = bucketKey.split('-').map((v) => parseInt(v, 10));
  const a = appState.reports.range.anchor;
  a.y = y;
  a.m = m - 1;
  a.q = Math.floor(a.m / 3);
  setRangeKind('month', opts);
}

// ── REPORTS — TREND ───────────────────────────────────────────────────────────

function _persistTrendState() {
  try {
    localStorage.setItem(
      TREND_STORAGE_KEY,
      JSON.stringify({ kind: appState.trend.kind, selection: appState.trend.selection }),
    );
  } catch (e) {}
}

function _persistTrendRange() {
  try {
    localStorage.setItem(
      TREND_RANGE_KEY,
      JSON.stringify({ yearFrom: appState.trend.yearFrom, yearTo: appState.trend.yearTo }),
    );
  } catch (e) {}
}

async function _findEarliestTxDate() {
  if (appState.trend.earliestTxDate) return appState.trend.earliestTxDate;
  const today = new Date();
  let year = today.getFullYear();
  let earliest = null;
  let consecutiveEmpty = 0;
  const floor = year - 20;
  while (consecutiveEmpty < 2 && year >= floor) {
    const yearTxs = await _loadYearTxs(year);
    if (!yearTxs.length) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
      for (const t of yearTxs) {
        if (!earliest || t.date < earliest) earliest = t.date;
      }
    }
    year--;
  }
  if (!earliest) {
    // No booking yet — default one year back so the picker shows a sensible range.
    const fallback = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    earliest = _iso(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  }
  appState.trend.earliestTxDate = earliest;
  return earliest;
}

async function _ensureTrendDefaultRange() {
  // Always resolve appState.trend.earliestTxDate — the year picker in the
  // render needs minYear even when the range comes from localStorage.
  const earliest = await _findEarliestTxDate();
  if (appState.trend.yearFrom && appState.trend.yearTo) return;
  const today = new Date();
  appState.trend.yearFrom = parseInt(earliest.slice(0, 4), 10);
  appState.trend.yearTo = today.getFullYear();
  _persistTrendRange();
}

// Trend math (_monthSpan, _autoGranularity, _bucketKey, _bucketAxis,
// _movingAverage, _tagLineColor, _trendMatchesEntity, _monthlyTotals,
// _trendStats) lives in reportsData.js (loaded before this file). The impure
// trend helpers that remain below — _bucketLabel, _trendEntityFromId,
// _pickDefaultTrendEntity, _trendSeries —
// read app globals (appState.calendar.monthsShort, categories) and so stay here.

function _bucketLabel(key, granularity) {
  if (granularity === 'year') return key;
  if (granularity === 'quarter') {
    const [y, q] = key.split('-');
    return `${q} ${y}`;
  }
  const [y, m] = key.split('-');
  return `${appState.calendar.monthsShort[parseInt(m, 10) - 1]} ${y.slice(2)}`;
}

function _trendEntityFromId(id) {
  if (!id) return null;
  if (id.startsWith('cat:')) {
    const catId = parseInt(id.slice(4), 10);
    const cat = appState.ledger.categories.find((c) => c.id === catId);
    if (!cat) return null;
    return { kind: 'category', id, catId, name: cat.name, color: cat.color };
  }
  if (id.startsWith('tag:')) {
    const name = id.slice(4);
    return { kind: 'tag', id, name, color: _tagLineColor(name) };
  }
  return null;
}

function _pickDefaultTrendEntity(txs, kind) {
  if (kind === 'category') {
    for (const r of _totalsByCategory(txs, 'all')) {
      if (appState.ledger.categories.find((c) => c.id === r.catId)) return `cat:${r.catId}`;
    }
  } else {
    const top = _totalsByTag(txs, 'all')[0];
    if (top) return `tag:${top.name}`;
  }
  return null;
}

function _trendSeries(txs, entityId, granularity, bucketKeys) {
  const entity = _trendEntityFromId(entityId);
  if (!entity) return null;
  const sums = new Map(bucketKeys.map((k) => [k, 0]));
  for (const t of txs) {
    if (!_trendMatchesEntity(t, entity)) continue;
    const key = _bucketKey(t.date, granularity);
    if (sums.has(key)) sums.set(key, sums.get(key) + _signedTrendAmount(t));
  }
  return {
    entity,
    label: entity.name,
    color: entity.color,
    data: bucketKeys.map((k) => sums.get(k) || 0),
  };
}

function _trendPeakLabel(key) {
  const [y, m] = key.split('-');
  return `${appState.calendar.months[parseInt(m, 10) - 1]} ${y}`;
}

function _trendPickerOptions(txs, kind, selectedId, filter) {
  const options = [];
  if (kind === 'category') {
    const ranked = _totalsByCategory(txs, 'all');
    const seen = new Set();
    for (const r of ranked) {
      const cat = appState.ledger.categories.find((c) => c.id === r.catId);
      if (!cat) continue;
      seen.add(r.catId);
      options.push({ id: `cat:${r.catId}`, label: cat.name, color: cat.color });
    }
    const rest = appState.ledger.categories
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, _locale()));
    for (const c of rest) {
      options.push({ id: `cat:${c.id}`, label: c.name, color: c.color });
    }
  } else {
    for (const r of _totalsByTag(txs, 'all')) {
      options.push({ id: `tag:${r.name}`, label: r.name, color: _tagLineColor(r.name) });
    }
  }
  // With a search query: all matches from the full set, no top-N cap.
  const q = (filter || '').trim().toLowerCase();
  if (q) {
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }
  // Without a query: top 10 by sum. If the active selection falls outside
  // the top 10, replace the last slot with it — otherwise the selection
  // visible in the active row wouldn't show up in the expanded picker.
  const TOP_N = 10;
  const limited = options.slice(0, TOP_N);
  if (selectedId && !limited.some((o) => o.id === selectedId)) {
    const selectedOpt = options.find((o) => o.id === selectedId);
    if (selectedOpt) {
      limited.pop();
      limited.push(selectedOpt);
    }
  }
  return limited;
}

function _trendStatsMarkup(stats) {
  if (!stats || stats.monthCount === 0) return '';
  const meanCard = `<div class="stat-card">
          <div class="trend-stat-label">${tr('reports.trendMean')}</div>
          <div class="trend-stat-value">${fmtCurrency(stats.mean)}</div>
          <div class="trend-stat-sub">${tr('reports.perMonth')}</div>
        </div>`;
  const peakCard =
    stats.peak && stats.peak.value !== 0
      ? `<div class="stat-card">
              <div class="trend-stat-label">${tr('reports.trendPeak')}</div>
              <div class="trend-stat-value">${fmtCurrency(stats.peak.value)}</div>
              <div class="trend-stat-sub">${_trendPeakLabel(stats.peak.key)}</div>
            </div>`
      : '';
  const yoyCard =
    stats.yoy && stats.yoy.pct !== null
      ? `<div class="stat-card wide">
              <div class="trend-stat-label">${tr('reports.trendYoy')}</div>
              <div class="trend-stat-value">${stats.yoy.firstYear} → ${stats.yoy.lastYear}
                <span class="trend-stat-delta">${stats.yoy.pct >= 0 ? '+' : ''}${stats.yoy.pct.toFixed(0)} %</span>
              </div>
              <div class="trend-stat-sub">${tr('forecast.perMonth', { from: fmtCurrency(stats.yoy.firstMean), to: fmtCurrency(stats.yoy.lastMean) })}</div>
            </div>`
      : '';
  return `<div class="trend-stats">${meanCard}${peakCard}${yoyCard}</div>`;
}

async function setTrendYear(field, value) {
  const today = new Date().getFullYear();
  const minYear = appState.trend.earliestTxDate
    ? parseInt(appState.trend.earliestTxDate.slice(0, 4), 10)
    : today - 20;
  value = Math.round(Math.max(minYear, Math.min(today, value)));
  if (field === 'from') {
    appState.trend.yearFrom = value;
    if (appState.trend.yearTo < appState.trend.yearFrom)
      appState.trend.yearTo = appState.trend.yearFrom;
  } else {
    appState.trend.yearTo = value;
    if (appState.trend.yearFrom > appState.trend.yearTo)
      appState.trend.yearFrom = appState.trend.yearTo;
  }
  _persistTrendRange();
  await renderReport('trend');
}

async function renderReportTrend(body, txs) {
  // On first open or after a category deletion: re-seed the selection
  let selected = appState.trend.selection[0]
    ? _trendEntityFromId(appState.trend.selection[0])
    : null;
  if (selected && selected.kind !== appState.trend.kind) selected = null;
  if (!selected) {
    const def = _pickDefaultTrendEntity(txs, appState.trend.kind);
    if (def) {
      appState.trend.selection = [def];
      _persistTrendState();
      selected = _trendEntityFromId(def);
    } else {
      appState.trend.selection = [];
    }
  }

  const today = new Date().getFullYear();
  const minYear = appState.trend.earliestTxDate
    ? parseInt(appState.trend.earliestTxDate.slice(0, 4), 10)
    : today - 20;
  const yearOptions = (selectedYear) => {
    let html = '';
    for (let y = minYear; y <= today; y++) {
      html += `<option value="${y}"${y === selectedYear ? ' selected' : ''}>${y}</option>`;
    }
    return html;
  };

  const yearPickerMarkup = `<div class="range-custom trend-year-picker">
            <label class="range-custom-field">
              <span>${tr('reports.rangeFrom')}</span>
              <span class="select-wrap"><select aria-label="${_escAttr(tr('reports.fromYear'))}" data-action-change="setTrendYear" data-args='["from", "@value#"]'>${yearOptions(appState.trend.yearFrom || today)}</select><svg class="ui-icon select-chevron" aria-hidden="true"><use href="#icon-chevron-down" /></svg></span>
            </label>
            <label class="range-custom-field">
              <span>${tr('reports.rangeTo')}</span>
              <span class="select-wrap"><select aria-label="${_escAttr(tr('reports.toYear'))}" data-action-change="setTrendYear" data-args='["to", "@value#"]'>${yearOptions(appState.trend.yearTo || today)}</select><svg class="ui-icon select-chevron" aria-hidden="true"><use href="#icon-chevron-down" /></svg></span>
            </label>
          </div>`;

  const picker = _entityPickerMarkup('trend', txs, selected);

  if (!selected) {
    body.innerHTML = `
            ${yearPickerMarkup}
            <div class="report-section">${picker.segmented}${picker.open}</div>
            <div class="report-section">${_emptyState(appState.trend.kind === 'category' ? tr('reports.noCategoriesInRange') : tr('reports.noTagsInRange'))}</div>
          `;
    _bindEntityChips(body, 'trend');
    return;
  }

  // Granularity fixed to month — the legend scales via autoSkip/maxTicksLimit.
  // For toIso > today, cap at the current month so neither the chart line
  // crashes to zero nor the running yearly average gets diluted by future
  // zero months.
  const granularity = 'month';
  const todayDate = new Date();
  const todayIso = _iso(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
  const trendFromIso = `${appState.trend.yearFrom}-01-01`;
  const trendToIso = `${appState.trend.yearTo}-12-31`;
  const effectiveTo = trendToIso > todayIso ? todayIso : trendToIso;
  const bucketKeys = _bucketAxis(trendFromIso, effectiveTo, granularity);
  const bucketLabels = bucketKeys.map((k) => _bucketLabel(k, granularity));
  const series = _trendSeries(txs, selected.id, granularity, bucketKeys);
  const monthlyMap = _monthlyTotals(txs, selected);
  const stats = _trendStats(monthlyMap, trendFromIso, effectiveTo);

  body.innerHTML = `
          ${yearPickerMarkup}
          <div class="report-section">${picker.segmented}${picker.active}${picker.open}</div>
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="trendChart" role="img" aria-labelledby="reportTitle" aria-describedby="trendChartSummary"></canvas></div>
            <p id="trendChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.trendSummary', { label: _escText(series.label), mean: fmtCurrency(stats?.mean || 0) })}</p>
          </div>
          ${_trendStatsMarkup(stats)}
        `;
  _bindEntityChips(body, 'trend');

  const c = getChartColors();
  const datasets = [
    {
      label: series.label,
      data: series.data,
      borderColor: series.color,
      backgroundColor: 'transparent',
      tension: 0.25,
      pointRadius: 3,
      borderWidth: 2.5,
      fill: false,
    },
  ];
  // The smoothing window grows with the time span so the second line still
  // smooths across multiple years instead of sitting 1:1 on the raw line.
  const maWindow = bucketKeys.length > 60 ? 12 : bucketKeys.length > 24 ? 6 : 3;
  if (bucketKeys.length >= maWindow * 2) {
    const smoothed = _movingAverage(series.data, maWindow);
    datasets.push({
      label: tr('reports.smoothing', { label: series.label }),
      data: smoothed,
      // Solid and translucent: dashed lines mean "income" in the course
      // and detail charts (DESIGN_CONVENTIONS.md → Charts).
      borderColor: _colorWithAlpha(series.color, 0.45),
      backgroundColor: 'transparent',
      tension: 0,
      pointRadius: 0,
      borderWidth: 2,
      fill: false,
    });
  }

  chartInsts.trend = new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: { labels: bucketLabels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      // A tap on a month opens the entity's detail for that month.
      onClick: (_evt, items) => {
        // Deferred: the navigation destroys this chart, and Chart.js keeps
        // handling the event after onClick returns.
        if (items.length) {
          const key = bucketKeys[items[0].index];
          setTimeout(() => _drillTrendMonth(selected.id, key), 0);
        }
      },
      onHover: (evt, items) => {
        evt.native.target.style.cursor = items.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: c.text,
            font: { size: 10 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
          },
          grid: { color: c.grid },
        },
        y: {
          ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
          // Emphasise the zero baseline: the net-flow line sits above it for
          // income, below it for spending, so the divider must read clearly.
          grid: { color: (ctx) => (ctx.tick.value === 0 ? c.text : c.grid) },
        },
      },
    },
  });
}

// ── REPORTS — FORECAST ────────────────────────────────────────────────────────

async function renderReportForecast(body, rangeTxs) {
  const gen = appState.reports.renderGen;
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const msDay = 86400000;

  // History: the last 12 complete months before the current month.
  // Anchor deliberately "today", not the target month — that way the
  // forecast is based on the most recent real data even when the user
  // looks into the future.
  const histEndDate = new Date(todayY, todayM, 0);
  const histStartDate = new Date(todayY, todayM - 12, 1);
  const histStartIso = _iso(histStartDate.getFullYear(), histStartDate.getMonth(), 1);
  const histEndIso = _iso(histEndDate.getFullYear(), histEndDate.getMonth(), histEndDate.getDate());
  const histTxs = await loadRangeTxs(histStartIso, histEndIso);
  if (_staleRender(gen)) return;
  const histOut = histTxs.filter((t) => t.type === 'out');

  if (histOut.length === 0) {
    body.innerHTML = _emptyState(tr('forecast.notEnough'));
    return;
  }

  const histDays = Math.round((histEndDate - histStartDate) / msDay) + 1;
  const dailyAvg = histOut.reduce((s, t) => s + t.amount, 0) / histDays;

  // Selected period from the time picker.
  const rangeFromIso = appState.reports.range.from;
  const rangeToIso = appState.reports.range.to;
  const rangeFromDate = new Date(rangeFromIso + 'T00:00:00');
  const rangeToDate = new Date(rangeToIso + 'T00:00:00');
  const daysTotal = Math.round((rangeToDate - rangeFromDate) / msDay) + 1;
  const todayStartOfDay = new Date(todayY, todayM, today.getDate());
  let daysPassed;
  if (todayStartOfDay < rangeFromDate) {
    daysPassed = 0;
  } else if (todayStartOfDay >= rangeToDate) {
    daysPassed = daysTotal;
  } else {
    daysPassed = Math.round((todayStartOfDay - rangeFromDate) / msDay) + 1;
  }
  if (daysPassed > daysTotal) daysPassed = daysTotal;

  const rangeOut = (rangeTxs || []).filter((t) => t.type === 'out');
  const rangeSum = rangeOut.reduce((s, t) => s + t.amount, 0);

  // Prognose: vergangene Tage = Ist, restliche Tage = Tagesdurchschnitt.
  let projected;
  if (daysPassed === 0) {
    projected = dailyAvg * daysTotal;
  } else if (daysPassed >= daysTotal) {
    projected = rangeSum;
  } else {
    projected = rangeSum + dailyAvg * (daysTotal - daysPassed);
  }

  // Per category: average scaled to the range length, status pace-adjusted.
  const histByCat = {};
  for (const t of histOut) {
    histByCat[t.category_id] = (histByCat[t.category_id] || 0) + t.amount;
  }
  const curByCat = {};
  for (const t of rangeOut) {
    curByCat[t.category_id] = (curByCat[t.category_id] || 0) + t.amount;
  }
  const rows = Object.entries(histByCat)
    .map(([id, sum]) => ({
      catId: parseInt(id, 10),
      avg: (sum / histDays) * daysTotal,
      current: curByCat[id] || 0,
    }))
    .sort((a, b) => b.avg - a.avg);

  const statusFor = (cur, avg) => {
    if (avg <= 0 || daysPassed === 0) return { label: '', cls: '' };
    const pace = (cur / daysPassed) * daysTotal;
    const ratio = pace / avg;
    if (ratio < 0.9) return { label: tr('forecast.statusUnder'), cls: 'is-ok' };
    if (ratio < 1.1) return { label: tr('forecast.statusOn'), cls: 'is-neutral' };
    return { label: tr('forecast.statusOver'), cls: 'is-warn' };
  };

  // Labels scale with the time-picker kind.
  const kind = appState.reports.range.kind;
  const cardLabel =
    kind === 'month'
      ? tr('forecast.projMonth')
      : kind === 'quarter'
        ? tr('forecast.projQuarter')
        : kind === 'year'
          ? tr('forecast.projYear')
          : tr('forecast.proj');
  const avgColLabel =
    kind === 'month'
      ? tr('forecast.avgMonth')
      : kind === 'quarter'
        ? tr('forecast.avgQuarter')
        : kind === 'year'
          ? tr('forecast.avgYear')
          : tr('forecast.avgPeriod');
  const periodLabel =
    kind === 'custom' ? `${fmtDate(rangeFromIso)} – ${fmtDate(rangeToIso)}` : _rangeStepperLabel();

  body.innerHTML = `
          <div class="report-section">
            <div class="forecast-card">
              <div class="forecast-card-label">${cardLabel}</div>
              <div class="forecast-card-value">${fmtCurrency(projected)}</div>
              <div class="forecast-card-hint">${periodLabel} · ${tr('forecast.basis', { day: daysPassed, total: daysTotal })}</div>
            </div>
          </div>
          <div class="report-section">
            <h3 class="report-section-title">${tr('forecast.perCategory')}</h3>
            <table class="forecast-table">
              <thead><tr><th>${tr('forecast.colCategory')}</th><th class="num">${avgColLabel}</th><th class="num">${tr('forecast.colCurrent')}</th><th class="num">${tr('forecast.colStatus')}</th></tr></thead>
              <tbody>
                ${rows
                  .map((r) => {
                    const cat = getCatById(r.catId);
                    if (!cat) return '';
                    const s = statusFor(r.current, r.avg);
                    return `<tr class="is-clickable" role="button" tabindex="0"
                    data-action="openDetail" data-args='["cat:${r.catId}"]'>
                    <td><span class="forecast-cat-name"><span class="forecast-cat-dot" style="background:${cat.color}"></span>${_escText(cat.name)}</span></td>
                    <td class="num">${fmtCurrency(r.avg)}</td>
                    <td class="num">${fmtCurrency(r.current)}</td>
                    <td class="num"><span class="forecast-status ${s.cls}">${s.label}</span></td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        `;
}

// ── REPORTS — TOP EXPENSES ────────────────────────────────────────────────────

function renderReportTop(body, txs) {
  // Largest transactions of either direction, colour-coded by _txRowMarkup.
  const top = [...txs].sort((a, b) => b.amount - a.amount).slice(0, 10);
  if (!top.length) {
    body.innerHTML = _emptyState(tr('reports.noTransactions'));
    return;
  }
  body.innerHTML = `<div class="report-section">${top.map(_txRowMarkup).join('')}</div>`;
}
