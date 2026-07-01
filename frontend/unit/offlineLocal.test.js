// Unit tests for the offline optimistic-update helpers added so a queued
// (HTTP 202) write to categories / goals / budgets / tags shows immediately
// instead of reloading the stale API cache. Mirrors booking.js's _applyTxLocally
// and the sw.test.js vm approach: each feature module only declares functions at
// load, so we evaluate it in a vm context and call the helper directly.
//
// The helpers call cross-module render functions (renderAll, renderCategories,
// …). We append no-op declarations of those names — in a non-module vm script
// the last function declaration wins, so the real DOM-touching versions are
// shadowed — and provide the few globals a file touches at load time.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const DIR = dirname(fileURLToPath(import.meta.url));

function load(file, exportNames, { stubs = [], globals = {}, appState }) {
  const stubSrc = stubs.map((n) => `function ${n}(){}`).join(';');
  const src =
    readFileSync(join(DIR, '..', file), 'utf8') +
    `\n;${stubSrc}\n;globalThis.__exports = { ${exportNames.join(', ')} };`;
  const sandbox = { appState, ...globals };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__exports;
}

describe('_applyCatLocally (categories.js)', () => {
  let appState, apply;
  beforeEach(() => {
    appState = {
      nav: { activePanel: 'transactions' },
      catEdit: {}, // categories.js seeds catEdit.icon at load
      ledger: {
        categories: [
          { id: 1, name: 'Food', icon: 'cart', color: '#111111' },
          { id: 2, name: 'Rent', icon: 'house', color: '#222222' },
        ],
      },
    };
    ({ _applyCatLocally: apply } = load('categories.js', ['_applyCatLocally'], {
      stubs: ['renderCategories', 'renderAll'],
      appState,
    }));
  });

  it('PUT updates the matching category', () => {
    apply('PUT', 2, { name: 'Housing', icon: 'home', color: '#333333' });
    const c = appState.ledger.categories.find((x) => x.id === 2);
    expect(c).toMatchObject({ name: 'Housing', icon: 'home', color: '#333333' });
    expect(appState.ledger.categories).toHaveLength(2);
  });

  it('POST appends a provisional (negative-id) category', () => {
    apply('POST', null, { name: 'Travel', icon: 'plane', color: '#444444' });
    expect(appState.ledger.categories).toHaveLength(3);
    const added = appState.ledger.categories[2];
    expect(added.name).toBe('Travel');
    expect(added.id).toBeLessThan(0);
  });

  it('DELETE removes the matching category', () => {
    apply('DELETE', 1);
    expect(appState.ledger.categories.map((c) => c.id)).toEqual([2]);
  });
});

describe('_applyGoalLocally (goals.js)', () => {
  let appState, apply;
  beforeEach(() => {
    appState = {
      nav: { activePanel: 'transactions' },
      goals: {
        list: [
          { id: 1, name: 'Car', direction: 'save_up', category_id: 5, target_amount: '100.00' },
        ],
      },
    };
    ({ _applyGoalLocally: apply } = load('goals.js', ['_applyGoalLocally'], { appState }));
  });

  it('PUT updates the matching goal', () => {
    apply('PUT', 1, { name: 'New Car', target_amount: '200.00' });
    expect(appState.goals.list[0]).toMatchObject({ name: 'New Car', target_amount: '200.00' });
  });

  it('POST appends a provisional goal', () => {
    apply('POST', null, { name: 'Holiday', category_id: 7 });
    expect(appState.goals.list).toHaveLength(2);
    expect(appState.goals.list[1].id).toBeLessThan(0);
  });

  it('DELETE removes the matching goal', () => {
    apply('DELETE', 1);
    expect(appState.goals.list).toHaveLength(0);
  });
});

describe('_applyBudgetLocally (budgets.js)', () => {
  let appState, apply;
  beforeEach(() => {
    appState = {
      nav: { activePanel: 'transactions' },
      budgets: { list: [{ id: 1, category_id: 5, amount: '50.00', frequency: 'monthly' }] },
    };
    ({ _applyBudgetLocally: apply } = load('budgets.js', ['_applyBudgetLocally'], { appState }));
  });

  it('PUT updates the matching budget', () => {
    apply('PUT', 1, { category_id: 5, amount: '75.00', frequency: 'monthly' });
    expect(appState.budgets.list[0].amount).toBe('75.00');
  });

  it('POST appends a provisional budget', () => {
    apply('POST', null, { category_id: 9, amount: '20.00', frequency: 'yearly' });
    expect(appState.budgets.list).toHaveLength(2);
    expect(appState.budgets.list[1].id).toBeLessThan(0);
  });

  it('DELETE removes the matching budget', () => {
    apply('DELETE', 1);
    expect(appState.budgets.list).toHaveLength(0);
  });
});

describe('_applyTagLocally (settings.js)', () => {
  let appState, apply;
  beforeEach(() => {
    appState = {
      ledger: {
        availableTags: ['amazon', 'rewe'],
        transactions: [{ id: 1, tags: ['Amazon', 'Rewe'] }],
        all: [{ id: 1, tags: ['Amazon', 'Rewe'] }],
      },
      reports: { txPool: null },
    };
    ({ _applyTagLocally: apply } = load('settings.js', ['_applyTagLocally'], {
      stubs: ['renderTagList', 'renderAll'],
      // settings.js wires theme/online/SW listeners at load — give it just
      // enough (matchMedia, addEventListener, localStorage) to not throw.
      globals: {
        window: {
          addEventListener() {},
          matchMedia: () => ({ matches: false, addEventListener() {} }),
        },
        navigator: {},
        document: {
          getElementById: () => null,
          addEventListener() {},
          documentElement: { setAttribute() {} },
        },
        localStorage: { getItem: () => null, setItem() {} },
      },
      appState,
    }));
  });

  it('POST adds a new tag (canonical casing), case-insensitively deduped', () => {
    apply('POST', null, 'Lidl');
    expect(appState.ledger.availableTags).toContain('Lidl');
    apply('POST', null, 'lidl'); // dup ignored
    expect(appState.ledger.availableTags.filter((t) => t.toLowerCase() === 'lidl')).toHaveLength(1);
  });

  it('PUT renames the tag in the list and across transaction pools', () => {
    apply('PUT', 'Amazon', 'Amazon DE');
    expect(appState.ledger.availableTags).toContain('Amazon DE');
    expect(appState.ledger.availableTags).not.toContain('amazon');
    expect(appState.ledger.transactions[0].tags).toEqual(['Amazon DE', 'Rewe']);
    expect(appState.ledger.all[0].tags).toEqual(['Amazon DE', 'Rewe']);
  });

  it('DELETE removes the tag from the list and from every transaction', () => {
    apply('DELETE', 'Amazon');
    expect(appState.ledger.availableTags).not.toContain('amazon');
    expect(appState.ledger.transactions[0].tags).toEqual(['Rewe']);
    expect(appState.ledger.all[0].tags).toEqual(['Rewe']);
  });
});

// Offline READ fallback (ledger.js): when the per-month GET misses the cache
// offline, the month view is rebuilt from the cached full history filtered
// client-side, so any month ever synced stays browsable offline. And the
// full-history cache warm is throttled so rapid month stepping online doesn't
// refetch the whole history each time.
describe('ledger.js offline month fallback', () => {
  const FULL = [
    {
      id: 1,
      amount: '10.00',
      desc: 'jun',
      category_id: 2,
      date: '2026-06-10',
      type: 'out',
      tags: [],
    },
    {
      id: 2,
      amount: '20.00',
      desc: 'may',
      category_id: 2,
      date: '2026-05-11',
      type: 'in',
      tags: ['x'],
    },
    {
      id: 3,
      amount: '30.00',
      desc: 'jun2',
      category_id: 3,
      date: '2026-06-30',
      type: 'out',
      tags: [],
    },
  ];

  function loadLedger(appState, api) {
    return load('ledger.js', ['_monthFromFullHistory', '_txInViewMonth', '_warmFullHistoryCache'], {
      stubs: [
        'renderAll',
        'applySearch',
        'renderTransactions',
        'closeAllSwipes',
        'renderCategoryView',
      ],
      globals: { document: { addEventListener() {} }, api },
      appState,
    });
  }

  it('_monthFromFullHistory returns only the displayed month, normalized', async () => {
    const appState = { view: { year: 2026, month: 5 }, ledger: { fullHistoryWarmedAt: 0 } }; // month 5 → June
    const mod = loadLedger(appState, async () => FULL);
    const rows = await mod._monthFromFullHistory();
    expect(rows.map((r) => r.id).sort()).toEqual([1, 3]);
    // normalizeTx coerces amount to Number.
    expect(rows.every((r) => typeof r.amount === 'number')).toBe(true);
  });

  it('_monthFromFullHistory returns [] when the full history is not cached', async () => {
    const appState = { view: { year: 2026, month: 5 }, ledger: { fullHistoryWarmedAt: 0 } };
    const mod = loadLedger(appState, async () => {
      throw Object.assign(new Error('offline'), { status: undefined });
    });
    expect(await mod._monthFromFullHistory()).toEqual([]);
  });

  it('_warmFullHistoryCache skips the refetch inside the throttle window', async () => {
    let calls = 0;
    const appState = {
      view: { year: 2026, month: 5 },
      ledger: { fullHistoryWarmedAt: Date.now() },
    };
    const mod = loadLedger(appState, async () => {
      calls++;
      return FULL;
    });
    mod._warmFullHistoryCache();
    expect(calls).toBe(0); // warmed just now → throttled
  });

  it('_warmFullHistoryCache refetches once the throttle window has passed', async () => {
    let calls = 0;
    const appState = { view: { year: 2026, month: 5 }, ledger: { fullHistoryWarmedAt: 0 } };
    const mod = loadLedger(appState, async () => {
      calls++;
      return FULL;
    });
    mod._warmFullHistoryCache();
    expect(calls).toBe(1);
    expect(appState.ledger.fullHistoryWarmedAt).toBeGreaterThan(0);
  });
});
