// Reports: Chart.js wiring, range/data plumbing and the report renderers
// (overview, month, year, categories, tags, trend, forecast, top).
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
    const fmt = (iso) => {
      const [y, m, d] = iso.split('-');
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(_locale());
    };
    return `${fmt(appState.reports.range.from)} – ${fmt(appState.reports.range.to)} · ${txCount} ${noun}`;
  }
  return `${_rangeStepperLabel()} · ${txCount} ${noun}`;
}

function updatePickerUI() {
  document.querySelectorAll('#rangeKindTabs button').forEach((b) => {
    const active = b.dataset.kind === appState.reports.range.kind;
    b.setAttribute('aria-selected', String(active));
    b.classList.toggle('is-active', active);
  });
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
    document.getElementById('rangeStepperLabel').textContent = _rangeStepperLabel();
  }
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
  appState.reports.current = id;
  try {
    localStorage.setItem(REPORT_STORAGE_KEY, id);
  } catch (e) {}
  document.body.setAttribute('data-report', id);
  if (id === 'trend') {
    await _ensureTrendDefaultRange();
  }
  const locks = { month: 'month', year: 'year' };
  setRangeLock(locks[id] || null);
  if (appState.reports.rangeLock && appState.reports.range.kind !== appState.reports.rangeLock) {
    appState.reports.range.kind = appState.reports.rangeLock;
    applyRange({ skipRender: true });
  }
  updatePickerUI();
  document.getElementById('reportTitle').textContent = reportTitle(id);

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
  appState.reports.txPool = txs;
  document.getElementById('reportRangeLabel').textContent = _rangeSubtitle(txs.length);

  if (id === 'overview') await renderReportOverview(body, txs);
  else if (id === 'month') renderReportMonth(body, txs);
  else if (id === 'year') await renderReportYear(body, txs);
  else if (id === 'categories') renderReportCategories(body, txs);
  else if (id === 'tags') renderReportTags(body, txs);
  else if (id === 'trend') await renderReportTrend(body, txs);
  else if (id === 'forecast') await renderReportForecast(body, txs);
  else if (id === 'top') renderReportTop(body, txs);
}

// ── REPORTS — SHARED HELPERS ──────────────────────────────────────────────────

// _sumByType() and _totalsByCategory() live in reportsData.js (loaded before
// this file).

function _catRowMarkup(catId, amount, max, opts = {}) {
  const cat = getCatById(catId);
  if (!cat) return '';
  const pct = max > 0 ? (amount / max) * 100 : 0;
  const drill = opts.drillDown
    ? `role="button" tabindex="0" onclick="drillDownCategory(${catId})" onkeydown="handleRowActivate(event, () => drillDownCategory(${catId}))"`
    : '';
  return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(cat.name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${cat.color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
}

function _txRowMarkup(t) {
  const cat = getCatById(t.category_id);
  const dateLbl = (() => {
    const [y, m, d] = t.date.split('-');
    return `${d}.${m}.${y}`;
  })();
  const tagsHtml = (t.tags || [])
    .map((tag) => `<span class="t-tag">${_escText(tag)}</span>`)
    .join('');
  return `<div class="report-tx-row" role="button" tabindex="0"
          onclick="editTransaction(${t.id})"
          onkeydown="handleRowActivate(event, () => editTransaction(${t.id}))">
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="report-tx-main">
            <div class="report-tx-desc">${_escText(t.desc || cat.name)}</div>
            <div class="t-tags">${tagsHtml}</div>
            <div class="report-tx-meta">${dateLbl}</div>
          </div>
          <div class="report-tx-amount ${t.type === 'out' ? 'negative' : 'positive'}">${fmtCurrency(Math.abs(t.amount))}</div>
        </div>`;
}

function _emptyState(msg) {
  return `<p class="empty-state-hint center">${msg}</p>`;
}

// ── REPORTS — OVERVIEW ────────────────────────────────────────────────────────

async function renderReportOverview(body, txs) {
  const totals = _sumByType(txs);
  const balance = totals.in - totals.out;
  const cats = _totalsByCategory(txs, 'out').slice(0, 3);
  const tags = _totalsByTag(txs, 'out').slice(0, 3);
  const topTx = [...txs]
    .filter((t) => t.type === 'out')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  const maxCat = cats[0]?.amount || 1;
  const maxTag = tags[0]?.amount || 1;

  body.innerHTML = `
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${balance >= 0 ? 'positive' : 'negative'}">${fmtCurrency(Math.abs(balance))}</div></div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.topCategories')}</h3>
            <div id="overviewCats">${cats.length ? cats.map((c) => _catRowMarkup(c.catId, c.amount, maxCat, { drillDown: true })).join('') : _emptyState(tr('reports.noExpenses'))}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.topTags')}</h3>
            <div id="overviewTags">${tags.length ? tags.map((t2) => _tagRowMarkup(t2.name, t2.amount, maxTag, { drillDown: true })).join('') : _emptyState(tr('reports.noTaggedExpenses'))}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">${tr('reports.top')}</h3>
            <div id="overviewTop">${topTx.length ? topTx.map(_txRowMarkup).join('') : _emptyState(tr('reports.noExpenses'))}</div>
          </div>

        `;
}

// ── REPORTS — MONTH ───────────────────────────────────────────────────────────

function renderReportMonth(body, txs) {
  const a = appState.reports.range.anchor;
  const days = _daysInMonth(a.y, a.m);
  const labels = Array.from({ length: days }, (_, i) => i + 1);
  const byDay = {};
  txs.forEach((t) => {
    const d = new Date(t.date).getDate();
    if (!byDay[d]) byDay[d] = { out: 0, in: 0 };
    byDay[d][t.type] += t.amount;
  });
  const outData = labels.map((d) => byDay[d]?.out || 0);
  const inData = labels.map((d) => byDay[d]?.in || 0);
  const totals = _sumByType(txs);

  body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="monthChart" role="img" aria-labelledby="reportTitle" aria-describedby="monthChartSummary"></canvas></div>
            <p id="monthChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.monthSummary', { month: appState.calendar.months[a.m], year: a.y, income: fmtCurrency(totals.in), expenses: fmtCurrency(totals.out) })}</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtCurrency(Math.abs(totals.in - totals.out))}</div></div>
          </div>
        `;

  const c = getChartColors();
  chartInsts.month = new Chart(document.getElementById('monthChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: tr('reports.expenses'),
          data: outData,
          backgroundColor: cssColor('--accent', 0.7),
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: tr('reports.income'),
          data: inData,
          backgroundColor: cssColor('--green', 0.7),
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
        y: {
          ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
          grid: { color: c.grid },
        },
      },
    },
  });
}

// ── REPORTS — YEAR ────────────────────────────────────────────────────────────

async function renderReportYear(body, txs) {
  const a = appState.reports.range.anchor;
  const aggregate = (pool) =>
    Array.from({ length: 12 }, (_, m) => {
      const tx = pool.filter((t) => new Date(t.date).getMonth() === m);
      return {
        out: tx.filter((t) => t.type === 'out').reduce((s, t) => s + t.amount, 0),
        in: tx.filter((t) => t.type === 'in').reduce((s, t) => s + t.amount, 0),
      };
    });
  const monthly = aggregate(txs);
  const prevTxs = await _loadYearTxs(a.y - 1);
  const hasPrev = prevTxs.length > 0;
  const prevMonthly = hasPrev ? aggregate(prevTxs) : null;
  const totals = _sumByType(txs);

  body.innerHTML = `
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="yearChart" role="img" aria-labelledby="reportTitle" aria-describedby="yearChartSummary"></canvas></div>
            <p id="yearChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.yearSummary', { year: a.y, income: fmtCurrency(totals.in), expenses: fmtCurrency(totals.out) })}</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">${tr('reports.income')}</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.expenses')}</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">${tr('reports.balance')}</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtCurrency(Math.abs(totals.in - totals.out))}</div></div>
          </div>
        `;

  const c = getChartColors();
  const datasets = [
    {
      label: tr('reports.expensesYear', { year: a.y }),
      data: monthly.map((m) => m.out),
      borderColor: cssColor('--accent'),
      backgroundColor: cssColor('--accent', 0.1),
      tension: 0.4,
      fill: true,
      pointRadius: 3,
    },
    {
      label: tr('reports.incomeYear', { year: a.y }),
      data: monthly.map((m) => m.in),
      borderColor: cssColor('--green'),
      backgroundColor: cssColor('--green', 0.1),
      tension: 0.4,
      fill: true,
      pointRadius: 3,
    },
  ];
  if (prevMonthly) {
    datasets.push({
      label: tr('reports.expensesYear', { year: a.y - 1 }),
      data: prevMonthly.map((m) => m.out),
      borderColor: cssColor('--accent', 0.5),
      borderDash: [5, 4],
      backgroundColor: 'transparent',
      tension: 0.4,
      fill: false,
      pointRadius: 0,
    });
  }
  chartInsts.year = new Chart(document.getElementById('yearChart'), {
    type: 'line',
    data: { labels: appState.calendar.monthsShort, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
      scales: {
        x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
        y: {
          ticks: { color: c.text, font: { size: 10 }, callback: (v) => fmtCurrency(v) },
          grid: { color: c.grid },
        },
      },
    },
  });
}

// ── REPORTS — CATEGORIES ──────────────────────────────────────────────────────

function renderReportCategories(body, txs) {
  const sorted = _totalsByCategory(txs, 'out');
  if (!sorted.length) {
    body.innerHTML = _emptyState(tr('reports.noExpenses'));
    return;
  }
  const total = sorted.reduce((s, c) => s + c.amount, 0);
  const max = sorted[0].amount;

  body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="categoriesDonut" role="img" aria-label="${_escAttr(tr('reports.expensesPerCategory'))}"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">${tr('reports.expensesTotal')}</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((c) => _catRowMarkup(c.catId, c.amount, max, { drillDown: true })).join('')}
          </div>
        `;

  chartInsts.categories = new Chart(document.getElementById('categoriesDonut'), {
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

async function drillDownCategory(catId, fromIso, toIso) {
  appState.reports.searchExitTarget = 'charts';
  appState.nav.categoryFilterId = catId;
  const from = fromIso || appState.reports.range.from;
  const to = toIso || appState.reports.range.to;
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
  return `<div class="cat-row" ${drill}>
          <div class="cat-icon" style="--cat-color:${color}">#</div>
          <div class="cat-info">
            <div class="cat-name">${_escText(name)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
}

function renderReportTags(body, txs) {
  const sorted = _totalsByTag(txs, 'out');
  if (!sorted.length) {
    body.innerHTML = _emptyState(tr('reports.noTagExpenses'));
    return;
  }
  const total = sorted.reduce((s, t) => s + t.amount, 0);
  const max = sorted[0].amount;

  body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="tagsDonut" role="img" aria-label="${_escAttr(tr('reports.expensesPerTag'))}"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">${tr('reports.expensesTotal')}</div>
              </div>
            </div>
          </div>
          <div class="report-section">
            ${sorted.map((t) => _tagRowMarkup(t.name, t.amount, max, { drillDown: true })).join('')}
          </div>
        `;

  chartInsts.tags = new Chart(document.getElementById('tagsDonut'), {
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

  body.querySelectorAll('[data-tag-drill]').forEach((el) => {
    const name = el.dataset.tagDrill;
    el.addEventListener('click', () => drillDownTag(name));
    el.addEventListener('keydown', (ev) => handleRowActivate(ev, () => drillDownTag(name)));
  });
}

async function drillDownTag(name, fromIso, toIso) {
  appState.reports.searchExitTarget = 'charts';
  appState.nav.tagFilterName = name;
  const from = fromIso || appState.reports.range.from;
  const to = toIso || appState.reports.range.to;
  appState.ledger.all = await loadRangeTxs(from, to);
  document.body.classList.add('searching');
  await _setSearchPanelActive(true);
  applySearch();
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
    for (const r of _totalsByCategory(txs, 'out')) {
      if (appState.ledger.categories.find((c) => c.id === r.catId)) return `cat:${r.catId}`;
    }
  } else {
    const top = _totalsByTag(txs, 'out')[0];
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
    if (sums.has(key)) sums.set(key, sums.get(key) + t.amount);
  }
  return {
    entity,
    label: entity.kind === 'tag' ? `#${entity.name}` : entity.name,
    color: entity.color,
    data: bucketKeys.map((k) => sums.get(k) || 0),
  };
}

function _trendPeakLabel(key) {
  const [y, m] = key.split('-');
  return `${appState.calendar.months[parseInt(m, 10) - 1]} ${y}`;
}

function _trendChipMarkup(id, name, color, selected) {
  const sel = selected ? 'is-selected' : '';
  return `<button type="button" class="trend-chip ${sel}" data-trend-id="${_escAttr(id)}">
          <span class="dot" style="background:${color}"></span>${_escText(name)}
        </button>`;
}

function _trendPickerOptions(txs, kind, selectedId, filter) {
  const options = [];
  if (kind === 'category') {
    const ranked = _totalsByCategory(txs, 'out');
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
    for (const r of _totalsByTag(txs, 'out')) {
      options.push({ id: `tag:${r.name}`, label: `#${r.name}`, color: _tagLineColor(r.name) });
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
    stats.peak && stats.peak.value > 0
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

function setTrendKind(kind) {
  if (kind !== 'category' && kind !== 'tag') return;
  if (appState.trend.kind === kind) return;
  appState.trend.kind = kind;
  appState.trend.selection = [];
  appState.trend.pickerOpen = false;
  appState.trend.pickerFilter = '';
  _persistTrendState();
  renderReport();
}

function selectTrendEntity(id) {
  appState.trend.selection = [id];
  appState.trend.pickerOpen = false;
  appState.trend.pickerFilter = '';
  _persistTrendState();
  renderReport();
}

function toggleTrendPicker(open) {
  appState.trend.pickerOpen = open === undefined ? !appState.trend.pickerOpen : !!open;
  const activeRow = document.getElementById('trendActiveRow');
  const picker = document.getElementById('trendPickerOpen');
  if (activeRow) activeRow.hidden = appState.trend.pickerOpen;
  if (picker) picker.hidden = !appState.trend.pickerOpen;
  if (appState.trend.pickerOpen && picker) {
    const input = picker.querySelector('input');
    if (input) input.focus();
  }
}

function filterTrendChips(value) {
  appState.trend.pickerFilter = value;
  const container = document.getElementById('trendPickerChips');
  if (!container) return;
  const selectedId = appState.trend.selection[0] || null;
  const options = _trendPickerOptions(
    appState.reports.txPool || [],
    appState.trend.kind,
    selectedId,
    value,
  );
  container.innerHTML = options
    .map((o) => _trendChipMarkup(o.id, o.label, o.color, selectedId && o.id === selectedId))
    .join('');
  _bindTrendChipHandlers(container);
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
              <select aria-label="${_escAttr(tr('reports.fromYear'))}" onchange="setTrendYear('from', +this.value)">${yearOptions(appState.trend.yearFrom || today)}</select>
            </label>
            <label class="range-custom-field">
              <span>${tr('reports.rangeTo')}</span>
              <select aria-label="${_escAttr(tr('reports.toYear'))}" onchange="setTrendYear('to', +this.value)">${yearOptions(appState.trend.yearTo || today)}</select>
            </label>
          </div>`;

  const options = _trendPickerOptions(
    txs,
    appState.trend.kind,
    selected && selected.id,
    appState.trend.pickerFilter,
  );
  const chipsMarkup = options
    .map((o) => _trendChipMarkup(o.id, o.label, o.color, selected && o.id === selected.id))
    .join('');
  const searchPlaceholder =
    appState.trend.kind === 'category' ? tr('reports.searchCategory') : tr('reports.searchTag');

  const segmentedMarkup = `<div class="segmented" role="tablist" aria-label="${_escAttr(tr('reports.trendSelect'))}">
            <button type="button" role="tab" aria-selected="${appState.trend.kind === 'category'}" class="${appState.trend.kind === 'category' ? 'is-active' : ''}" onclick="setTrendKind('category')">${tr('reports.kindCategories')}</button>
            <button type="button" role="tab" aria-selected="${appState.trend.kind === 'tag'}" class="${appState.trend.kind === 'tag' ? 'is-active' : ''}" onclick="setTrendKind('tag')">${tr('reports.kindTags')}</button>
          </div>`;

  const activeMarkup = selected
    ? `<div class="trend-active-row" id="trendActiveRow"${appState.trend.pickerOpen ? ' hidden' : ''}>
              <div class="trend-active-info">
                <span class="trend-active-dot" style="background:${selected.color}"></span>
                <div class="trend-active-text">
                  <div class="trend-active-label">${_escText(selected.kind === 'tag' ? `#${selected.name}` : selected.name)}</div>
                  <span class="trend-active-sub">${tr('reports.largestItem')}</span>
                </div>
              </div>
              <button type="button" class="trend-switch-btn" onclick="toggleTrendPicker(true)">${tr('reports.switch')}</button>
            </div>`
    : '';

  const pickerOpenMarkup = `<div class="trend-picker-open" id="trendPickerOpen"${appState.trend.pickerOpen || !selected ? '' : ' hidden'}>
            <div class="search-wrap">
              <svg class="ui-icon" aria-hidden="true"><use href="#icon-search" /></svg>
              <input type="search" placeholder="${searchPlaceholder}" value="${_escAttr(appState.trend.pickerFilter)}" oninput="filterTrendChips(this.value)" autocomplete="off" />
            </div>
            <div class="tag-picker-chips" id="trendPickerChips">${chipsMarkup}</div>
          </div>`;

  if (!selected) {
    body.innerHTML = `
            ${yearPickerMarkup}
            <div class="report-section">${segmentedMarkup}${pickerOpenMarkup}</div>
            <div class="report-section">${_emptyState(appState.trend.kind === 'category' ? tr('reports.noCategoriesInRange') : tr('reports.noTagsInRange'))}</div>
          `;
    _bindTrendChipHandlers(body);
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
          <div class="report-section">${segmentedMarkup}${activeMarkup}${pickerOpenMarkup}</div>
          <div class="report-section">
            <div class="report-canvas-wrap"><canvas id="trendChart" role="img" aria-labelledby="reportTitle" aria-describedby="trendChartSummary"></canvas></div>
            <p id="trendChartSummary" class="visually-hidden" aria-live="polite">${tr('reports.trendSummary', { label: _escText(series.label), mean: fmtCurrency(stats?.mean || 0) })}</p>
          </div>
          ${_trendStatsMarkup(stats)}
        `;
  _bindTrendChipHandlers(body);

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
      borderColor: series.color,
      borderDash: [4, 3],
      backgroundColor: 'transparent',
      tension: 0,
      pointRadius: 0,
      borderWidth: 1.5,
      fill: false,
    });
  }

  chartInsts.trend = new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: { labels: bucketLabels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
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
          grid: { color: c.grid },
        },
      },
    },
  });
}

function _bindTrendChipHandlers(scope) {
  scope.querySelectorAll('[data-trend-id]').forEach((el) => {
    el.addEventListener('click', () => selectTrendEntity(el.dataset.trendId));
    el.addEventListener('keydown', (ev) =>
      handleRowActivate(ev, () => selectTrendEntity(el.dataset.trendId)),
    );
  });
}

// ── REPORTS — FORECAST ────────────────────────────────────────────────────────

async function renderReportForecast(body, rangeTxs) {
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
    kind === 'custom'
      ? (() => {
          const fmt = (iso) => {
            const [y, m, d] = iso.split('-');
            return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(_locale());
          };
          return `${fmt(rangeFromIso)} – ${fmt(rangeToIso)}`;
        })()
      : _rangeStepperLabel();

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
                    onclick="drillDownCategory(${r.catId}, '${rangeFromIso}', '${rangeToIso}')"
                    onkeydown="handleRowActivate(event, () => drillDownCategory(${r.catId}, '${rangeFromIso}', '${rangeToIso}'))">
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
  const top = txs
    .filter((t) => t.type === 'out')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
  if (!top.length) {
    body.innerHTML = _emptyState(tr('reports.noExpenses'));
    return;
  }
  body.innerHTML = `<div class="report-section">${top.map(_txRowMarkup).join('')}</div>`;
}
