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

// --- Trend math (spending trend chart) -----------------------------------
// Pure calendar-bucketing and aggregation helpers lifted out of the
// renderReportTrend render path. They take ISO date strings, granularity and
// plain transaction lists as arguments and return plain values — no app
// state, no DOM, no I18N — which is what makes the calendar edge cases
// (quarter/year axis walking, year-over-year stats) unit-testable in
// isolation (frontend/unit/trends.test.js). The render function and the
// impure helpers that read app globals (_trendEntityFromId, _bucketLabel,
// _pickDefaultTrendEntity) stay in app.js and call these as globals.

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

// Stabile Hue wie _tagColor, aber mit klemmender Helligkeit, damit
// Light- und Dark-Mode beide Kontrast zur Chart-Linie haben.
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
  // Schwelle bewusst niedrig (≥3 Monate), damit das laufende Jahr ab Q2
  // sichtbar wird — der renderReportTrend-Callsite kappt toIso auf heute,
  // also rechnet jeder Jahresmittelwert nur über tatsächlich verfügbare
  // Monate (Projektion auf Monatsbasis statt Verwässerung durch Nullen).
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
    _goalProgress,
    _bucketKey,
    _bucketAxis,
    _movingAverage,
    _tagLineColor,
    _trendMatchesEntity,
    _monthlyTotals,
    _trendStats,
  };
}
