// Pure aggregation helpers for the reports/goals views.
//
// Like utils.js, this is loaded as a classic script *before* app.js, so the
// declarations are globals the render functions call directly (call sites
// unchanged). The functions take their data as arguments and return plain
// values — no app state, no DOM, no I18N — which is what makes them safe to
// unit-test in isolation (frontend/unit/reportsData.test.js). The
// module.exports guard at the bottom is a no-op in the browser.

// Sum a list of transactions into { out, in } totals (numbers).
function _sumByType(txs) {
  let out = 0,
    inn = 0;
  for (const t of txs) {
    if (t.type === 'out') out += t.amount;
    else inn += t.amount;
  }
  return { out, in: inn };
}

// Total amount per category for a single type, as a list sorted by amount
// descending: [{ catId, amount }, …].
function _totalsByCategory(txs, type = 'out') {
  const totals = {};
  for (const t of txs) {
    if (t.type !== type) continue;
    totals[t.category_id] = (totals[t.category_id] || 0) + t.amount;
  }
  return Object.entries(totals)
    .map(([id, amt]) => ({ catId: parseInt(id, 10), amount: amt }))
    .sort((a, b) => b.amount - a.amount);
}

// Stable hue per tag — same name always maps to the same color. Avoids
// a per-tag color setting while keeping the donut visually distinct.
function _tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(h) % 360}deg 58% 52%)`;
}

// Sum amounts per tag for the given type. A transaction with multiple
// tags contributes its full amount to each tag (tags are categorical
// labels, not splits) — mirrors how Top-Kategorien aggregates.
function _totalsByTag(txs, type = 'out') {
  const totals = {};
  for (const t of txs) {
    if (t.type !== type) continue;
    if (!Array.isArray(t.tags) || !t.tags.length) continue;
    for (const tag of t.tags) {
      totals[tag] = (totals[tag] || 0) + t.amount;
    }
  }
  return Object.entries(totals)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
}

// Derived goal progress over a pool of transactions. Money is summed in
// integer cents (Math.round) so the percentages and remaining/current
// figures never drift through float — mirroring the backend's money rule.
// Never mutates its inputs; returns a fresh summary object.
function _goalProgress(goal, pool) {
  const wantType = goal.direction === 'pay_down' ? 'out' : 'in';
  let matchedCents = 0;
  for (const t of pool) {
    if (t.category_id !== goal.category_id) continue;
    if (t.type !== wantType) continue;
    if (t.date < goal.start_date) continue;
    matchedCents += Math.round(t.amount * 100);
  }
  const initialCents = Math.round(Number(goal.initial_amount) * 100);
  const targetCents = Math.round(Number(goal.target_amount) * 100);
  if (goal.direction === 'pay_down') {
    // % = how much of the intended pay-off (initial → target) is done.
    // "Done" means reaching the target (Restziel), not necessarily 0.
    const spanCents = initialCents - targetCents; // amount to repay
    const remainingCents = initialCents - matchedCents;
    const pct = spanCents > 0 ? (matchedCents / spanCents) * 100 : 100;
    return {
      pct: Math.max(0, Math.min(100, pct)),
      rawPct: Math.max(0, pct),
      primaryCents: Math.max(0, remainingCents),
      targetCents,
      paidCents: matchedCents,
      complete: remainingCents <= targetCents,
    };
  }
  // Savings: "Bereits gespart" (initial) counts as progress, so the
  // percentage is the absolute current/target — matching the
  // "{current} von {target}" primary line.
  const currentCents = initialCents + matchedCents;
  const pct = targetCents > 0 ? (currentCents / targetCents) * 100 : 100;
  return {
    pct: Math.max(0, Math.min(100, pct)),
    rawPct: Math.max(0, pct),
    primaryCents: currentCents,
    targetCents,
    complete: currentCents >= targetCents,
  };
}

// Calendar-aligned period bounds for a budget frequency, given a reference
// year + zero-based month. Returns ISO date strings { from, to } (inclusive)
// matching the GET /api/transactions?from=&to= contract. No rollover: each
// period is a clean calendar slice (month / quarter / year). Pure — used by
// _budgetUsage and the render path.
function _budgetPeriod(frequency, year, month) {
  let startMonth, endMonth;
  if (frequency === 'yearly') {
    startMonth = 0;
    endMonth = 11;
  } else if (frequency === 'quarterly') {
    startMonth = Math.floor(month / 3) * 3;
    endMonth = startMonth + 2;
  } else {
    // monthly (default)
    startMonth = month;
    endMonth = month;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${year}-${pad(startMonth + 1)}-01`;
  // Last day of endMonth: day 0 of the following month.
  const last = new Date(year, endMonth + 1, 0).getDate();
  const to = `${year}-${pad(endMonth + 1)}-${pad(last)}`;
  return { from, to };
}

// Derived budget consumption over a pool of transactions for one period.
// Sums the category's `out` rows dated within [periodFrom, periodTo] in
// integer cents (Math.round) so the bar percentage and remaining figure
// never drift through float — mirroring the backend's money rule. Never
// mutates its inputs; returns a fresh summary object.
function _budgetUsage(budget, pool, periodFrom, periodTo) {
  let spentCents = 0;
  for (const t of pool) {
    if (t.category_id !== budget.category_id) continue;
    if (t.type !== 'out') continue;
    if (t.date < periodFrom || t.date > periodTo) continue;
    spentCents += Math.round(t.amount * 100);
  }
  const limitCents = Math.round(Number(budget.amount) * 100);
  const pct = limitCents > 0 ? (spentCents / limitCents) * 100 : 100;
  return {
    spentCents,
    limitCents,
    pct: Math.max(0, Math.min(100, pct)),
    rawPct: Math.max(0, pct),
    remainingCents: limitCents - spentCents,
    over: spentCents > limitCents,
  };
}

// --- Trend math (spending trend chart) -----------------------------------
// Pure calendar-bucketing and aggregation helpers lifted out of the
// renderReportTrend render path. They take ISO date strings, granularity and
// plain transaction lists as arguments and return plain values — no app
// state, no DOM, no I18N — which is what makes the calendar edge cases
// (quarter/year axis walking, year-over-year stats) unit-testable in
// isolation (frontend/unit/trends.test.js). The render function and the
// impure helpers that read app globals (_trendEntityFromId, _bucketLabel,
// _pickDefaultTrendEntity) stay in app.js and call these as globals.

// Number of calendar months spanned by [fromIso, toIso] inclusive.
function _monthSpan(fromIso, toIso) {
  const fy = parseInt(fromIso.slice(0, 4), 10);
  const fm = parseInt(fromIso.slice(5, 7), 10);
  const ty = parseInt(toIso.slice(0, 4), 10);
  const tm = parseInt(toIso.slice(5, 7), 10);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

// Pick the chart granularity from the span length: months under two years,
// quarters up to five, years beyond.
function _autoGranularity(fromIso, toIso) {
  const months = _monthSpan(fromIso, toIso);
  if (months < 24) return 'month';
  if (months <= 60) return 'quarter';
  return 'year';
}

// Calendar bucket key for a date at the given granularity: "2026" (year),
// "2026-Q2" (quarter) or "2026-04" (month).
function _bucketKey(iso, granularity) {
  const y = iso.slice(0, 4);
  const m = parseInt(iso.slice(5, 7), 10);
  if (granularity === 'year') return y;
  if (granularity === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Ordered list of bucket keys spanning [fromIso, toIso] inclusive at the
// given granularity — the chart's x-axis. Walks the calendar so empty
// buckets in the middle are still represented.
function _bucketAxis(fromIso, toIso, granularity) {
  const fy = parseInt(fromIso.slice(0, 4), 10);
  const fm = parseInt(fromIso.slice(5, 7), 10);
  const ty = parseInt(toIso.slice(0, 4), 10);
  const tm = parseInt(toIso.slice(5, 7), 10);
  const keys = [];
  if (granularity === 'year') {
    for (let y = fy; y <= ty; y++) keys.push(String(y));
    return keys;
  }
  if (granularity === 'quarter') {
    let y = fy;
    let q = Math.floor((fm - 1) / 3);
    const endQ = Math.floor((tm - 1) / 3);
    while (y < ty || (y === ty && q <= endQ)) {
      keys.push(`${y}-Q${q + 1}`);
      q++;
      if (q > 3) {
        q = 0;
        y++;
      }
    }
    return keys;
  }
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return keys;
}

// Centred moving average over a numeric series (chart smoothing). window<=1
// is a no-op copy.
function _movingAverage(values, window) {
  if (window <= 1) return values.slice();
  const result = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += values[j];
    result.push(sum / (end - start + 1));
  }
  return result;
}

// Stable hue like _tagColor, but with clamped lightness so both light
// and dark mode keep contrast against the chart line.
function _tagLineColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(h) % 360}deg 55% 50%)`;
}

// Does a transaction belong to the trend entity (a category or a tag)? Only
// spending ('out') counts towards a trend line.
function _trendMatchesEntity(t, entity) {
  if (t.type !== 'out') return false;
  if (entity.kind === 'category') return t.category_id === entity.catId;
  return Array.isArray(t.tags) && t.tags.includes(entity.name);
}

// Sum the entity's spending into a per-calendar-month map (YYYY-MM → amount),
// the input to _trendStats.
function _monthlyTotals(txs, entity) {
  const sums = new Map();
  for (const t of txs) {
    if (!_trendMatchesEntity(t, entity)) continue;
    const key = t.date.slice(0, 7);
    sums.set(key, (sums.get(key) || 0) + t.amount);
  }
  return sums;
}

// Mean / peak / year-over-year stats over a monthly map for the [fromIso,
// toIso] span. Returns null for an empty span.
function _trendStats(monthlyMap, fromIso, toIso) {
  const months = _bucketAxis(fromIso, toIso, 'month');
  if (!months.length) return null;
  let total = 0;
  let peak = null;
  for (const k of months) {
    const v = monthlyMap.get(k) || 0;
    total += v;
    if (peak === null || v > peak.value) peak = { key: k, value: v };
  }
  const mean = total / months.length;
  const yearGroups = new Map();
  for (const k of months) {
    const y = k.slice(0, 4);
    if (!yearGroups.has(y)) yearGroups.set(y, []);
    yearGroups.get(y).push(monthlyMap.get(k) || 0);
  }
  // Threshold deliberately low (≥3 months) so the running year shows up
  // from Q2 on — the renderReportTrend call site caps toIso at today, so
  // every yearly average is computed only over months that actually have
  // data (per-month projection instead of dilution by zeros).
  const years = Array.from(yearGroups.entries()).filter(([, list]) => list.length >= 3);
  let yoy = null;
  if (years.length >= 2) {
    const first = years[0];
    const last = years[years.length - 1];
    if (first[0] !== last[0]) {
      const firstMean = first[1].reduce((s, v) => s + v, 0) / first[1].length;
      const lastMean = last[1].reduce((s, v) => s + v, 0) / last[1].length;
      const pct = firstMean > 0 ? ((lastMean - firstMean) / firstMean) * 100 : null;
      yoy = { firstYear: first[0], lastYear: last[0], firstMean, lastMean, pct };
    }
  }
  return { mean, peak, yoy, monthCount: months.length };
}

// Node/Vitest only — the browser classic-script load skips this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _sumByType,
    _totalsByCategory,
    _tagColor,
    _totalsByTag,
    _goalProgress,
    _budgetPeriod,
    _budgetUsage,
    _monthSpan,
    _autoGranularity,
    _bucketKey,
    _bucketAxis,
    _movingAverage,
    _tagLineColor,
    _trendMatchesEntity,
    _monthlyTotals,
    _trendStats,
  };
}
