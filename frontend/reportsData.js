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

// Node/Vitest only — the browser classic-script load skips this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _sumByType, _totalsByCategory, _goalProgress };
}
