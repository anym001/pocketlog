      // ── ICON-MARKUP ───────────────────────────────────────────────────────────────
      // Für Glyphen, die dynamisch via JS getauscht werden (FAB-Toggle Plus/✕,
      // Tag-Pill-Remove). Statische Glyphen sitzen direkt im HTML-Markup.
      const ICON_SVG = {
        plus: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-plus"/></svg>',
        close: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-close"/></svg>',
      };

      // ── API-BASIS ─────────────────────────────────────────────────────────────────
      // Standardmäßig same-origin ("/api"). Über die Settings kann eine vollständige
      // Basis-URL gesetzt werden (z.B. https://pocketlog.deinedomain.de). Das Suffix
      // /api wird hier ergänzt.
      const API_BASE_KEY = 'pocketlog.apiBase';
      function readApiBase() {
        const raw = (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '');
        return raw ? raw + '/api' : '/api';
      }
      let API = readApiBase();

      let currentMonth = new Date().getMonth();
      let currentYear = new Date().getFullYear();
      let currentType = 'out';
      let currentTags = [];

      // ── REPORTS-STATE ─────────────────────────────────────────────────────────────
      // Welche Auswertung gerade aktiv ist (Quelle der Wahrheit für panel-charts).
      // Persistiert in localStorage, damit ein Reload den letzten Stand zeigt.
      const REPORT_STORAGE_KEY = 'pocketlog.report';
      const REPORT_IDS = ['overview', 'month', 'year', 'categories', 'tags', 'forecast', 'top'];
      const REPORT_TITLES = {
        overview: 'Übersicht',
        month: 'Monatsverlauf',
        year: 'Jahresverlauf',
        categories: 'Kategorien-Analyse',
        tags: 'Tag-Analyse',
        forecast: 'Durchschnitt und Prognose',
        top: 'Größte Ausgaben',
      };
      let currentReport = (() => {
        const v = localStorage.getItem(REPORT_STORAGE_KEY);
        return REPORT_IDS.includes(v) ? v : 'overview';
      })();
      const _today = new Date();
      let reportRange = {
        kind: 'month',
        anchor: {
          y: _today.getFullYear(),
          m: _today.getMonth(),
          q: Math.floor(_today.getMonth() / 3),
        },
        from: '',
        to: '',
      };
      // Optionaler Lock: 'month' oder 'year' erzwingt den Picker-Modus für Reports,
      // die nur in dieser Granularität sinnvoll sind. null = frei wählbar.
      let _rangeLock = null;
      // Chart.js-Instanzen pro Report, getrennt damit destroy() keine fremde Instanz trifft.
      const chartInsts = { month: null, year: null, categories: null, tags: null, sparkline: null };
      // Pro-Jahr-Cache der Transaktionen. Bei jedem write geleert.
      const _txCacheByYear = new Map();
      function invalidateReportCache() {
        _txCacheByYear.clear();
      }
      // Beim Drill-Down aus der Kategorien-Analyse merken, wohin „Abbrechen" zurückspringt.
      let _searchExitTarget = null;
      // Letzte vom aktiven Report geladene Transaktionen — wird von editTransaction
      // konsultiert, damit ein Klick auf eine Top-Liste die echte Buchung findet
      // (nicht nur die des aktuellen Monats aus der Transaktions-View).
      let _reportTxPool = null;

      let transactions = []; // wird per API geladen
      let categories = []; // wird per API geladen
      let availableTags = []; // distinkte Tags des Users (alphabetisch sortiert)
      const tagCounts = new Map(); // tag-name (case-folded) → Anzahl Verwendungen

      // ── API HELPER ────────────────────────────────────────────────────────────────
      async function api(method, path, body) {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(API + path, opts);
        if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}`);
        if (method !== 'GET') invalidateReportCache();
        if (res.status === 204) return null;
        return res.json();
      }

      // ── FORMATTING ────────────────────────────────────────────────────────────────
      const fmtCurrency = (n) =>
        new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);
      const fmtSignedCurrency = (n) =>
        new Intl.NumberFormat('de-DE', {
          style: 'currency',
          currency: 'EUR',
          signDisplay: 'always',
        }).format(n);
      const MONTHS = [
        'Januar',
        'Februar',
        'März',
        'April',
        'Mai',
        'Juni',
        'Juli',
        'August',
        'September',
        'Oktober',
        'November',
        'Dezember',
      ];
      const MONTHS_SHORT = [
        'Jan',
        'Feb',
        'Mär',
        'Apr',
        'Mai',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Okt',
        'Nov',
        'Dez',
      ];

      // ── TOAST + CONFIRM (replaces native alert/confirm) ──────────────────────────
      function toast(message, type = 'info') {
        const host = document.getElementById('toastHost');
        if (!host) return;
        const el = document.createElement('div');
        el.className = 'toast' + (type === 'error' ? ' error' : '');
        el.textContent = message;
        if (type === 'error') el.setAttribute('role', 'alert');
        host.appendChild(el);
        const dwell = type === 'error' ? 5000 : 3200;
        setTimeout(() => {
          el.classList.add('leaving');
          el.addEventListener('animationend', () => el.remove(), { once: true });
        }, dwell);
      }

      function confirmAction({
        title,
        message = '',
        confirmLabel = 'Bestätigen',
        cancelLabel = 'Abbrechen',
        destructive = true,
      }) {
        return new Promise((resolve) => {
          const prevFocus = document.activeElement;
          const overlay = document.createElement('div');
          overlay.className = 'modal-overlay open';
          overlay.style.alignItems = 'center';

          const modal = document.createElement('div');
          modal.className = 'modal confirm-modal';
          modal.setAttribute('role', 'alertdialog');
          modal.setAttribute('aria-modal', 'true');
          modal.setAttribute('aria-labelledby', 'confirmTitle');

          const h = document.createElement('h2');
          h.id = 'confirmTitle';
          h.textContent = title;
          modal.appendChild(h);

          if (message) {
            const p = document.createElement('p');
            p.className = 'confirm-msg';
            p.textContent = message;
            modal.appendChild(p);
          }

          const yes = document.createElement('button');
          yes.className = 'submit-btn confirm-yes';
          yes.type = 'button';
          yes.textContent = confirmLabel;
          if (destructive)
            yes.style.cssText =
              'background:transparent;color:var(--accent);border:1px solid var(--accent)';
          modal.appendChild(yes);

          const no = document.createElement('button');
          no.className = 'confirm-cancel';
          no.type = 'button';
          no.textContent = cancelLabel;
          modal.appendChild(no);

          overlay.appendChild(modal);

          // Cycle Tab between yes/no — the alert-dialog has no other focusable
          // controls, so a manual trap is simpler than reusing trapFocusIn().
          const onKey = (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              (document.activeElement === yes ? no : yes).focus();
            }
          };

          const close = (result) => {
            overlay.removeEventListener('keydown', onKey);
            overlay.remove();
            // Only release scroll-lock if no other modal is still open.
            const stillOpen = document.querySelector('.modal-overlay.open');
            if (!stillOpen) document.body.style.overflow = '';
            if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
              prevFocus.focus();
            }
            resolve(result);
          };
          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
          });
          overlay.addEventListener('keydown', onKey);
          document.body.appendChild(overlay);
          document.body.style.overflow = 'hidden';
          yes.addEventListener('click', () => close(true));
          no.addEventListener('click', () => close(false));
          setTimeout(() => no.focus(), 50);
        });
      }

      // ── NAVIGATION ────────────────────────────────────────────────────────────────
      let _activePanel = 'transactions';
      let _searchQuery = '';
      let _allTransactions = null;
      // Exact category filter set when the user taps the "more" icon on a
      // category row. Mutually exclusive with text search — typing in the
      // search input clears it (`onSearch`).
      let _categoryFilterId = null;
      // Exact tag filter set when the user drills down from the tag analysis.
      // Mutually exclusive with text search and category filter.
      let _tagFilterName = null;

      function _resetSearch() {
        _searchQuery = '';
        _categoryFilterId = null;
        _tagFilterName = null;
        _allTransactions = null;
        _searchExitTarget = null;
        document.body.classList.remove('searching');
        document.getElementById('searchInput').value = '';
        const fab = document.querySelector('.fab');
        if (fab) {
          fab.innerHTML = ICON_SVG.plus;
          fab.classList.remove('search-exit');
          fab.setAttribute('aria-label', 'Neue Buchung');
          fab.onclick = () => openModal();
        }
      }

      function showPanel(id) {
        if (_searchQuery || _categoryFilterId != null || _tagFilterName != null) _resetSearch();
        _activePanel = id;
        document.body.classList.toggle('in-report', id === 'charts');
        if (id !== 'charts') _reportTxPool = null;
        document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
        document.getElementById('panel-' + id).classList.add('active');
        document.querySelectorAll('.drawer-nav-item[data-panel]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.panel === id);
        });
        if (id === 'charts') renderReport();
        if (id === 'categories') renderCategoryView();
        closeDrawer();
      }

      // Wird aus dem Drawer-Subpanel „Auswertungen" aufgerufen. Setzt den aktiven
      // Report (inkl. Lock-Mode bei Monat-/Jahresverlauf) und schaltet auf das
      // Charts-Panel.
      function openReport(id) {
        if (!REPORT_IDS.includes(id)) id = 'overview';
        currentReport = id;
        try {
          localStorage.setItem(REPORT_STORAGE_KEY, id);
        } catch (e) {}
        if (id === 'month' && reportRange.kind !== 'month') setRangeKind('month', { skipRender: true });
        if (id === 'year' && reportRange.kind !== 'year') setRangeKind('year', { skipRender: true });
        showPanel('charts');
      }

      const _drawerStack = [];
      const _drawerSubs = ['dpReports', 'dpSettings', 'dpCats', 'dpTags', 'dpImport', 'dpDisplay', 'dpAdmin', 'dpInfo'];

      function drawerNav(panelId) {
        const current = _drawerStack.length ? _drawerStack[_drawerStack.length - 1] : 'dpMain';
        document.getElementById(current).dataset.state = 'left';
        document.getElementById(panelId).dataset.state = 'active';
        _drawerStack.push(panelId);
        document.getElementById('drawer').classList.add('sub-active');
        if (panelId === 'dpCats') renderCategories();
        if (panelId === 'dpTags') renderTagList();
        if (panelId === 'dpImport') loadApiBaseInput();
        if (panelId === 'dpDisplay') syncDefaultViewRadios();
        if (panelId === 'dpInfo') renderInfoPanel();
      }

      function drawerBack() {
        if (!_drawerStack.length) return;
        const current = _drawerStack.pop();
        const prev = _drawerStack.length ? _drawerStack[_drawerStack.length - 1] : 'dpMain';
        document.getElementById(current).dataset.state = 'right';
        document.getElementById(prev).dataset.state = 'active';
        if (!_drawerStack.length) document.getElementById('drawer').classList.remove('sub-active');
      }

      function _drawerResetPanels() {
        document.getElementById('dpMain').dataset.state = 'active';
        _drawerSubs.forEach((id) => {
          document.getElementById(id).dataset.state = 'right';
        });
        _drawerStack.length = 0;
        document.getElementById('drawer').classList.remove('sub-active');
      }

      // ≥768px: drawer is a persistent sidebar — open/close become no-ops
      // so a stray call (e.g. from showPanel) doesn't trap focus or lock
      // body scroll. Keep this in sync with the @media breakpoint in
      // styles.css (see "ADAPTIVE LAYOUT" block).
      const _mqTablet = window.matchMedia('(min-width: 768px)');

      // Apple-Mail style sidebar toggle (tablet only). The collapsed
      // class lives on <html> because the inline restore in index.html
      // runs before <body> exists; CSS targets html.sidebar-collapsed.
      // The aria-pressed sync mirrors the visual state for screen readers
      // — the icon swap (arrows-in ↔ arrows-out) is purely CSS-driven.
      function _syncSidebarTogglePressed(collapsed) {
        const btn = document.querySelector('.sidebar-toggle-btn');
        if (btn) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      }

      function toggleSidebar() {
        const collapsed = document.documentElement.classList.toggle(
          'sidebar-collapsed'
        );
        _syncSidebarTogglePressed(collapsed);
        try {
          localStorage.setItem(
            'pocketlog.sidebarCollapsed',
            collapsed ? '1' : '0'
          );
        } catch (e) {}
      }

      // app.js is loaded with `defer`, so the DOM is ready — sync the
      // aria-pressed attribute with the class state set by the inline
      // head boot script.
      _syncSidebarTogglePressed(
        document.documentElement.classList.contains('sidebar-collapsed')
      );

      function openDrawer() {
        if (_mqTablet.matches) return;
        rememberModalFocus('drawer');
        document.getElementById('drawer').classList.add('open');
        document.getElementById('drawerOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        trapFocusIn(document.getElementById('drawer'), 'drawer');
      }

      function closeDrawer() {
        if (_mqTablet.matches) return;
        document.getElementById('drawer').classList.remove('open');
        document.getElementById('drawerOverlay').classList.remove('open');
        document.body.style.overflow = '';
        releaseFocusTrap('drawer');
        restoreModalFocus('drawer');
        // _drawerStack and sub-panel data-state are deliberately kept:
        // re-opening the drawer should land back on the last sub-panel
        // the user was on (e.g. Auswertungen), not always reset to the
        // top level. _drawerResetPanels is reserved for explicit resets.
      }

      // Rotate / resize crossing the tablet breakpoint while a mobile
      // overlay is open would leave the body scroll-locked. Reset state
      // when we enter sidebar mode.
      _mqTablet.addEventListener('change', (e) => {
        if (!e.matches) return;
        document.getElementById('drawer').classList.remove('open');
        document.getElementById('drawerOverlay').classList.remove('open');
        releaseFocusTrap('drawer');
        // Only release the scroll lock if no modal is still open.
        if (!document.querySelector('.modal-overlay.open')) {
          document.body.style.overflow = '';
        }
      });

      // Keyboard activation for elements that are interactive but cannot be
      // a <button> (e.g. row contains a nested action button). Mirrors native
      // button semantics: Enter and Space trigger the click; Space is
      // prevented from scrolling. The `!e.repeat` guard avoids re-firing
      // while the key is held. `.is-key-active` gives the keyboard press
      // the same visual feedback that mouse `:active` does.
      function handleRowActivate(e, fn) {
        if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && !e.repeat) {
          e.preventDefault();
          const el = e.currentTarget;
          el.classList.add('is-key-active');
          setTimeout(() => el.classList.remove('is-key-active'), 150);
          fn();
        }
      }

      // ── MODAL FOCUS MANAGEMENT ────────────────────────────────────────────────────
      // Each modal stores the element that had focus before it opened, so the
      // matching close() can restore it. Keyed by modal id to support nesting
      // (tag picker opens from inside the booking modal).
      const _modalPrevFocus = new Map();
      const _modalTrapTeardown = new Map();

      function rememberModalFocus(key) {
        _modalPrevFocus.set(key, document.activeElement);
      }

      function restoreModalFocus(key) {
        const el = _modalPrevFocus.get(key);
        _modalPrevFocus.delete(key);
        if (el && document.contains(el) && typeof el.focus === 'function') {
          el.focus();
        }
      }

      // Wraps Tab cycling inside the given root element. Returns nothing; call
      // releaseFocusTrap(key) to remove the listener when the modal closes.
      function trapFocusIn(rootEl, key) {
        const handler = (e) => {
          if (e.key !== 'Tab') return;
          const focusable = rootEl.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          const visible = Array.from(focusable).filter((el) => el.offsetParent !== null);
          if (!visible.length) return;
          const first = visible[0];
          const last = visible[visible.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };
        rootEl.addEventListener('keydown', handler);
        _modalTrapTeardown.set(key, () => rootEl.removeEventListener('keydown', handler));
      }

      function releaseFocusTrap(key) {
        const fn = _modalTrapTeardown.get(key);
        if (fn) fn();
        _modalTrapTeardown.delete(key);
      }

      function changeMonth(d) {
        currentMonth += d;
        if (currentMonth > 11) {
          currentMonth = 0;
          currentYear++;
        }
        if (currentMonth < 0) {
          currentMonth = 11;
          currentYear--;
        }
        loadAndRender();
      }
      // ── LOAD & RENDER ─────────────────────────────────────────────────────────────
      function normalizeTx(t) {
        return { ...t, amount: Number(t.amount), tags: t.tags || [] };
      }

      async function loadAndRender() {
        document.getElementById('monthLabel').textContent =
          `${MONTHS[currentMonth]} ${currentYear}`;
        try {
          const raw = await api(
            'GET',
            `/transactions?year=${currentYear}&month=${currentMonth + 1}`
          );
          transactions = raw.map(normalizeTx);
        } catch (e) {
          console.error('Fehler beim Laden:', e);
          transactions = [];
        }
        renderAll();
        if (_searchQuery) {
          try {
            const all = await api('GET', '/transactions');
            _allTransactions = all.map(normalizeTx);
          } catch (e) {
            _allTransactions = [];
          }
          applySearch();
        }
      }

      function renderAll() {
        document.getElementById('monthLabel').textContent =
          `${MONTHS[currentMonth]} ${currentYear}`;
        const out = transactions.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0);
        const inc = transactions.filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0);
        document.getElementById('totalOut').textContent = fmtSignedCurrency(-out);
        document.getElementById('totalIn').textContent = fmtSignedCurrency(inc);
        applySearch();
        if (_activePanel === 'categories') renderCategoryView();
      }

      function applySearch() {
        const q = _searchQuery;
        const catFilter = _categoryFilterId;
        const tagFilter = _tagFilterName;
        if (!q && catFilter == null && tagFilter == null) {
          renderTransactions(transactions);
          return;
        }
        // The drill-down from the monthly view leaves `_allTransactions` unset,
        // so we naturally fall back to the month-scoped `transactions` pool.
        // When the drill-down comes from a report, `_allTransactions` holds the
        // report range — same logic, just a wider pool.
        const pool = _allTransactions ?? transactions;
        const filtered = pool.filter((t) => {
          if (catFilter != null) return t.category_id === catFilter;
          if (tagFilter != null) return Array.isArray(t.tags) && t.tags.includes(tagFilter);
          if ((t.desc || '').toLowerCase().includes(q)) return true;
          const cat = getCatById(t.category_id);
          if (cat.name.toLowerCase().includes(q)) return true;
          if (t.tags && t.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
          return false;
        });
        renderTransactions(filtered, document.getElementById('searchResultsList'));
      }

      async function _setSearchPanelActive(active) {
        const fab = document.querySelector('.fab');
        if (active) {
          document.body.classList.add('searching');
          document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
          document.getElementById('panel-search').classList.add('active');
          fab.innerHTML = ICON_SVG.close;
          fab.classList.add('search-exit');
          fab.setAttribute('aria-label', 'Suche beenden');
          fab.onclick = clearSearch;
          // Only load the global pool for text search — category drill-down
          // stays month-scoped via the already-loaded `transactions`.
          if (_searchQuery && !_allTransactions) {
            try {
              const raw = await api('GET', '/transactions');
              _allTransactions = raw.map(normalizeTx);
            } catch (e) {
              _allTransactions = [];
            }
          }
          applySearch();
        } else {
          _allTransactions = null;
          document.body.classList.remove('searching');
          document.getElementById('panel-search').classList.remove('active');
          document.getElementById('panel-' + _activePanel).classList.add('active');
          fab.innerHTML = ICON_SVG.plus;
          fab.classList.remove('search-exit');
          fab.setAttribute('aria-label', 'Neue Buchung');
          fab.onclick = () => openModal();
        }
      }

      async function onSearch(val) {
        // Typing in the search input cancels any active drill-down filter
        // so the panel switches back to plain text-match behaviour.
        if (_categoryFilterId != null) _categoryFilterId = null;
        if (_tagFilterName != null) _tagFilterName = null;
        const wasEmpty = !_searchQuery;
        _searchQuery = val.trim().toLowerCase();
        if (_searchQuery && wasEmpty) await _setSearchPanelActive(true);
        else if (!_searchQuery && !wasEmpty) _setSearchPanelActive(false);
        else applySearch();
      }

      function clearSearch() {
        const wasActive = !!_searchQuery || _categoryFilterId != null || _tagFilterName != null;
        const exitTo = _searchExitTarget;
        _searchExitTarget = null;
        _resetSearch();
        if (wasActive) _setSearchPanelActive(false);
        if (exitTo) showPanel(exitTo);
      }

      function getCatById(id) {
        return (
          categories.find((c) => c.id === Number(id)) || {
            name: 'Sonstiges',
            icon: 'package',
            color: '#9e9b96',
          }
        );
      }

      function getMonthTxs() {
        return transactions.filter((t) => {
          const d = new Date(t.date + 'T12:00:00');
          return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
        });
      }

      function renderTransactions(txs, el = document.getElementById('transactionList')) {
        if (!txs.length) {
          el.innerHTML = _searchQuery
            ? `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-search"/></svg><p>Keine Buchungen passen zu „${_searchQuery}“.<br>Andere Schreibweise versuchen.</p></div>`
            : `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-inbox-empty"/></svg><p>Keine Buchungen in diesem Monat.<br>Tippe auf <strong>+</strong> um eine hinzuzufügen.</p></div>`;
          return;
        }
        // Group by date
        const groups = {};
        txs.forEach((t) => {
          (groups[t.date] = groups[t.date] || []).push(t);
        });
        el.innerHTML = Object.entries(groups)
          .map(([date, list]) => {
            const d = new Date(date + 'T12:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const dDay = new Date(date + 'T00:00:00');
            const label =
              dDay.getTime() === today.getTime()
                ? 'Heute'
                : dDay.getTime() === today.getTime() - 86400000
                  ? 'Gestern'
                  : d.toLocaleDateString('de-DE', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    });
            return (
              `<div class="section-title">${label}</div>` +
              list
                .map((t) => {
                  const cat = getCatById(t.category_id);
                  const tagsHtml = (t.tags || [])
                    .map((tg) => `<span class="t-tag">${tg}</span>`)
                    .join('');
                  const note = (t.desc || '').trim();
                  return `<div class="tx-row" data-id="${t.id}">
        <button class="tx-action" type="button" aria-label="Buchung löschen">Löschen</button>
        <div class="transaction">
          <div class="t-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <span class="visually-hidden">${cat.name}</span>
          <div class="t-info">
            <div class="t-note">${note}</div>
            <div class="t-tags">${tagsHtml}</div>
          </div>
          <div class="t-amount ${t.type}">${fmtSignedCurrency(t.type === 'out' ? -Math.abs(t.amount) : Math.abs(t.amount))}</div>
        </div>
      </div>`;
                })
                .join('')
            );
          })
          .join('');
        attachSwipeHandlers(el);
      }

      function renderCategoryView() {
        const el = document.getElementById('categoryViewList');
        if (!el) return;

        if (!categories.length) {
          el.innerHTML = `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#icon-inbox-empty"/></svg><p>Keine Kategorien vorhanden.<br>Erstelle Kategorien in den Einstellungen.</p></div>`;
          return;
        }

        // Net amount per category from current month's transactions
        const totals = {};
        transactions.forEach((t) => {
          const key = t.category_id ?? 0;
          if (!totals[key]) totals[key] = 0;
          totals[key] += t.type === 'out' ? -t.amount : t.amount;
        });

        // All categories, sorted alphabetically — zero if no transactions this month
        const rows = categories
          .map((cat) => ({ id: cat.id, name: cat.name, icon: cat.icon, color: cat.color, net: totals[cat.id] ?? 0 }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        el.innerHTML = rows
          .map(
            (r) => `
    <div class="cat-view-row" role="button" tabindex="0"
      aria-label="Kategorie „${r.name}“ bearbeiten"
      onclick="openModalForCategory(${r.id})"
      onkeydown="handleRowActivate(event, () => openModalForCategory(${r.id}))">
      <span class="cat-view-icon" style="--cat-color:${r.color}">${catIconSvg(r.icon)}</span>
      <span class="cat-view-name">${r.name}</span>
      <span class="cat-view-amount ${r.net > 0 ? 'positive' : r.net < 0 ? 'negative' : ''}">${fmtCurrency(r.net)}</span>
      <button
        type="button"
        class="cat-view-more"
        aria-label="Buchungen in „${r.name}“ ansehen"
        onclick="event.stopPropagation(); showTransactionsForCategory(${r.id})"
      ><svg class="ui-icon" aria-hidden="true"><use href="#icon-more-vertical"/></svg></button>
    </div>
  `
          )
          .join('');
      }

      function openModalForCategory(catId) {
        openModal(null);
        document.getElementById('inputCat').value = catId;
      }

      async function showTransactionsForCategory(catId) {
        const cat = getCatById(catId);
        // Reuses the search-results panel as the host UI, but the actual
        // filter is exact-by-id (applySearch checks _categoryFilterId
        // before the substring search path).
        _categoryFilterId = catId;
        _searchQuery = '';
        document.getElementById('searchInput').value = cat.name;
        await _setSearchPanelActive(true);
      }

      // ── SWIPE-TO-DELETE ───────────────────────────────────────────────────────────
      const SWIPE_ACTION_WIDTH = 88;
      const SWIPE_OPEN_THRESHOLD = 40; // Pixel, ab denen die Action offen einrastet
      const TAP_TOLERANCE = 6; // Pixel-Slop, unter dem ein Pointer-Down als Tap zählt

      function closeAllSwipes(except) {
        document.querySelectorAll('.tx-row.swiped').forEach((r) => {
          if (r !== except) r.classList.remove('swiped');
        });
      }

      function attachSwipeHandlers(container) {
        container.querySelectorAll('.tx-row').forEach((row) => {
          const inner = row.querySelector('.transaction');
          const action = row.querySelector('.tx-action');
          let startX = 0,
            startY = 0,
            dx = 0,
            dragging = false,
            committedAxis = null, // 'x' once we've decided the gesture is a swipe
            openOnStart = false;

          inner.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            startX = e.clientX;
            startY = e.clientY;
            dx = 0;
            dragging = true;
            committedAxis = null;
            openOnStart = row.classList.contains('swiped');
            row.classList.add('dragging');
            try {
              inner.setPointerCapture(e.pointerId);
            } catch (_) {}
          });

          inner.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const rawDx = e.clientX - startX;
            const rawDy = e.clientY - startY;
            // Discriminate axis only once the finger has moved past a small
            // slop, so a vertical scroll never briefly shifts the card and
            // reveals the red delete action behind it. Once committed to a
            // direction, stay there for the rest of the gesture.
            if (committedAxis == null) {
              const ax = Math.abs(rawDx);
              const ay = Math.abs(rawDy);
              if (ax < 8 && ay < 8) return; // still in slop
              if (ay >= ax) {
                // Vertical intent — release the gesture and let the page scroll.
                endDrag(true);
                return;
              }
              committedAxis = 'x';
            }
            let delta = rawDx;
            if (openOnStart) delta -= SWIPE_ACTION_WIDTH;
            dx = Math.min(0, Math.max(-SWIPE_ACTION_WIDTH, delta));
            inner.style.transform = `translateX(${dx}px)`;
          });

          function endDrag(cancelled) {
            if (!dragging) return;
            dragging = false;
            row.classList.remove('dragging');
            inner.style.transform = '';

            if (cancelled) {
              // Wurde vom Browser abgebrochen (z.B. vertikaler Scroll): Status nicht ändern
              return;
            }

            const movedFar = dx < -SWIPE_OPEN_THRESHOLD;
            if (movedFar) {
              closeAllSwipes(row);
              row.classList.add('swiped');
            } else if (Math.abs(dx) < TAP_TOLERANCE) {
              // Tap
              if (openOnStart) {
                row.classList.remove('swiped');
              } else {
                closeAllSwipes();
                editTransaction(Number(row.dataset.id));
              }
            } else {
              row.classList.remove('swiped');
            }
          }

          inner.addEventListener('pointerup', () => endDrag(false));
          inner.addEventListener('pointercancel', () => endDrag(true));

          const deleteRow = async () => {
            const id = Number(row.dataset.id);
            const ok = await confirmAction({
              title: 'Buchung wirklich löschen?',
              confirmLabel: 'Löschen',
            });
            if (!ok) {
              row.classList.remove('swiped');
              return;
            }
            try {
              await api('DELETE', `/transactions/${id}`);
              await loadAndRender();
            } catch (err) {
              if (!navigator.onLine && window.PocketLogOutbox) {
                await window.PocketLogOutbox.enqueue({
                  method: 'DELETE',
                  path: `/transactions/${id}`,
                });
                row.classList.remove('swiped');
                // Optimistisch entfernen, Sync übernimmt der SW
                transactions = transactions.filter((t) => t.id !== id);
                renderAll();
                updateSyncBadge();
                return;
              }
              toast('Fehler beim Löschen: ' + err.message, 'error');
              row.classList.remove('swiped');
            }
          };

          action.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteRow();
          });
        });
      }

      // Beim Tippen außerhalb einer offenen Zeile diese wieder schließen.
      // Einmaliger globaler Listener (nicht pro Render neu registrieren).
      document.addEventListener(
        'pointerdown',
        (e) => {
          if (!e.target.closest('.tx-row')) closeAllSwipes();
        },
        { capture: true }
      );

      // ── CHARTS ────────────────────────────────────────────────────────────────────
      function getChartColors() {
        // Read the effective theme from data-dark — same source CSS uses.
        const dark = document.documentElement.getAttribute('data-dark') === 'true';
        return {
          grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          text: dark ? '#a09d98' : '#6b6760',
        };
      }

      // Liest einen CSS-Custom-Property-Wert aus dem aktiven Theme. Wenn `alpha` < 1
       // wird der Hex-Wert nach rgba() konvertiert, damit Chart.js eine transparente
      // Variante zeichnen kann. Nur Hex-Tokens (#RRGGBB) werden unterstützt — alle
      // Reports-Akzente sind als Hex hinterlegt.
      function cssColor(name, alpha = 1) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (alpha >= 1 || !v.startsWith('#')) return v;
        const n = parseInt(v.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
      }

      // ── REPORTS — RANGE & DATA ────────────────────────────────────────────────────

      function _iso(y, m, d) {
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      function _daysInMonth(y, m) {
        return new Date(y, m + 1, 0).getDate();
      }
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
        // custom: from/to bleiben wie zuletzt eingegeben.
        return { from: reportRange.from, to: reportRange.to };
      }

      function applyRange(opts = {}) {
        const r = computeRange(reportRange.kind, reportRange.anchor);
        if (reportRange.kind !== 'custom') {
          reportRange.from = r.from;
          reportRange.to = r.to;
        }
        updatePickerUI();
        if (!opts.skipRender && _activePanel === 'charts') renderReport();
      }

      function setRangeKind(kind, opts = {}) {
        if (_rangeLock && kind !== _rangeLock) return;
        if (!['month', 'quarter', 'year', 'custom'].includes(kind)) return;
        reportRange.kind = kind;
        if (kind === 'custom' && (!reportRange.from || !reportRange.to)) {
          // Beim Wechsel auf „Eigen" mit den aktuellen Monatsgrenzen vorbelegen.
          const r = computeRange('month', reportRange.anchor);
          reportRange.from = r.from;
          reportRange.to = r.to;
        }
        applyRange(opts);
      }

      function shiftRange(delta) {
        const a = reportRange.anchor;
        if (reportRange.kind === 'month') {
          let m = a.m + delta, y = a.y;
          while (m < 0) { m += 12; y--; }
          while (m > 11) { m -= 12; y++; }
          a.m = m; a.y = y; a.q = Math.floor(m / 3);
        } else if (reportRange.kind === 'quarter') {
          let q = a.q + delta, y = a.y;
          while (q < 0) { q += 4; y--; }
          while (q > 3) { q -= 4; y++; }
          a.q = q; a.y = y; a.m = q * 3;
        } else if (reportRange.kind === 'year') {
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
          toast('Bis-Datum muss nach Von-Datum liegen.');
          return;
        }
        reportRange.from = from;
        reportRange.to = to;
        renderReport();
      }

      function setRangeLock(kind) {
        _rangeLock = kind;
        const tabs = document.querySelectorAll('#rangeKindTabs button');
        tabs.forEach((b) => {
          const allowed = !kind || b.dataset.kind === kind;
          b.disabled = !allowed;
          b.setAttribute('aria-disabled', String(!allowed));
        });
      }

      function _rangeStepperLabel() {
        const a = reportRange.anchor;
        if (reportRange.kind === 'month') return `${MONTHS[a.m]} ${a.y}`;
        if (reportRange.kind === 'quarter') return `Q${a.q + 1} ${a.y}`;
        if (reportRange.kind === 'year') return `${a.y}`;
        return '';
      }

      function _rangeSubtitle(txCount) {
        const noun = txCount === 1 ? 'Buchung' : 'Buchungen';
        if (reportRange.kind === 'custom') {
          const fmt = (iso) => {
            const [y, m, d] = iso.split('-');
            return `${d}.${m}.${y}`;
          };
          return `${fmt(reportRange.from)} – ${fmt(reportRange.to)} · ${txCount} ${noun}`;
        }
        return `${_rangeStepperLabel()} · ${txCount} ${noun}`;
      }

      function updatePickerUI() {
        document.querySelectorAll('#rangeKindTabs button').forEach((b) => {
          const active = b.dataset.kind === reportRange.kind;
          b.setAttribute('aria-selected', String(active));
          b.classList.toggle('is-active', active);
        });
        const stepper = document.getElementById('rangeStepper');
        const custom = document.getElementById('rangeCustom');
        if (reportRange.kind === 'custom') {
          stepper.hidden = true;
          custom.hidden = false;
          document.getElementById('rangeFrom').value = reportRange.from || '';
          document.getElementById('rangeTo').value = reportRange.to || '';
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

      async function renderReport(id = currentReport) {
        if (!REPORT_IDS.includes(id)) id = 'overview';
        currentReport = id;
        try {
          localStorage.setItem(REPORT_STORAGE_KEY, id);
        } catch (e) {}
        const locks = { month: 'month', year: 'year' };
        setRangeLock(locks[id] || null);
        if (_rangeLock && reportRange.kind !== _rangeLock) {
          reportRange.kind = _rangeLock;
          applyRange({ skipRender: true });
        }
        updatePickerUI();
        document.getElementById('reportTitle').textContent = REPORT_TITLES[id];

        Object.keys(chartInsts).forEach((k) => {
          if (chartInsts[k]) {
            chartInsts[k].destroy();
            chartInsts[k] = null;
          }
        });

        const body = document.getElementById('reportBody');
        body.innerHTML = '';

        const txs = await loadRangeTxs(reportRange.from, reportRange.to);
        _reportTxPool = txs;
        document.getElementById('reportRangeLabel').textContent = _rangeSubtitle(txs.length);

        if (id === 'overview') await renderReportOverview(body, txs);
        else if (id === 'month') renderReportMonth(body, txs);
        else if (id === 'year') await renderReportYear(body, txs);
        else if (id === 'categories') renderReportCategories(body, txs);
        else if (id === 'tags') renderReportTags(body, txs);
        else if (id === 'forecast') await renderReportForecast(body);
        else if (id === 'top') renderReportTop(body, txs);
      }

      // ── REPORTS — SHARED HELPERS ──────────────────────────────────────────────────

      function _sumByType(txs) {
        let out = 0, inn = 0;
        for (const t of txs) {
          if (t.type === 'out') out += t.amount;
          else inn += t.amount;
        }
        return { out, in: inn };
      }

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
            <div class="cat-name">${cat.name}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${cat.color}"></div></div>
          </div>
          <div class="cat-amount">${fmtCurrency(-Math.abs(amount))}</div>
        </div>`;
      }

      function _txRowMarkup(t) {
        const cat = getCatById(t.category_id);
        const sign = t.type === 'out' ? -t.amount : t.amount;
        const dateLbl = (() => {
          const [y, m, d] = t.date.split('-');
          return `${d}.${m}.${y}`;
        })();
        return `<div class="report-tx-row" role="button" tabindex="0"
          onclick="editTransaction(${t.id})"
          onkeydown="handleRowActivate(event, () => editTransaction(${t.id}))">
          <div class="cat-icon" style="--cat-color:${cat.color}">${catIconSvg(cat.icon)}</div>
          <div class="report-tx-main">
            <div class="report-tx-desc">${t.desc || cat.name}</div>
            <div class="report-tx-meta">${cat.name} · ${dateLbl}</div>
          </div>
          <div class="report-tx-amount ${t.type === 'out' ? 'negative' : 'positive'}">${fmtSignedCurrency(sign)}</div>
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
        const topTx = [...txs]
          .filter((t) => t.type === 'out')
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 3);
        const maxCat = cats[0]?.amount || 1;

        body.innerHTML = `
          <div class="report-kpis">
            <div class="summary-card"><div class="label">Einnahmen</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">Ausgaben</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">Bilanz</div><div class="amount ${balance >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(balance)}</div></div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Vorjahr im Verlauf</h3>
            <div class="report-sparkline-wrap"><canvas id="overviewSparkline" role="img" aria-label="Bilanz Vorjahr pro Monat"></canvas></div>
            <p class="report-sparkline-caption" id="sparklineCaption"></p>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Top-Kategorien</h3>
            <div id="overviewCats">${cats.length ? cats.map((c) => _catRowMarkup(c.catId, c.amount, maxCat, { drillDown: true })).join('') : _emptyState('Keine Ausgaben im Zeitraum.')}</div>
          </div>

          <div class="report-section">
            <h3 class="report-section-title">Größte Ausgaben</h3>
            <div id="overviewTop">${topTx.length ? topTx.map(_txRowMarkup).join('') : _emptyState('Keine Ausgaben im Zeitraum.')}</div>
          </div>

          <div class="report-tiles">
            <button type="button" class="report-tile" onclick="openReport('categories')">Kategorien-Analyse</button>
            <button type="button" class="report-tile" onclick="openReport('year')">Jahresverlauf</button>
            <button type="button" class="report-tile" onclick="openReport('forecast')">Prognose</button>
          </div>
        `;

        // Sparkline: Vorjahr des Range-Endjahres.
        const endYear = parseInt(reportRange.to.slice(0, 4), 10);
        const prevYear = endYear - 1;
        const prevTxs = await _loadYearTxs(prevYear);
        const monthly = Array.from({ length: 12 }, (_, m) => {
          const tx = prevTxs.filter((t) => new Date(t.date).getMonth() === m);
          const out = tx.filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0);
          const inn = tx.filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0);
          return inn - out;
        });
        const c = getChartColors();
        const canvas = document.getElementById('overviewSparkline');
        chartInsts.sparkline = new Chart(canvas, {
          type: 'line',
          data: {
            labels: MONTHS_SHORT,
            datasets: [{
              data: monthly,
              borderColor: cssColor('--accent'),
              backgroundColor: cssColor('--accent', 0.1),
              tension: 0.35,
              fill: true,
              pointRadius: 0,
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 } }, grid: { display: false } },
              y: { display: false },
            },
          },
        });
        document.getElementById('sparklineCaption').textContent =
          `Monatliche Bilanz ${prevYear}`;
      }

      // ── REPORTS — MONTH ───────────────────────────────────────────────────────────

      function renderReportMonth(body, txs) {
        const a = reportRange.anchor;
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
            <p id="monthChartSummary" class="visually-hidden" aria-live="polite">${MONTHS[a.m]} ${a.y}: Einnahmen ${fmtCurrency(totals.in)}, Ausgaben ${fmtCurrency(totals.out)}.</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">Einnahmen</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">Ausgaben</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">Bilanz</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(totals.in - totals.out)}</div></div>
          </div>
        `;

        const c = getChartColors();
        chartInsts.month = new Chart(document.getElementById('monthChart'), {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: 'Ausgaben', data: outData, backgroundColor: cssColor('--accent', 0.7), borderRadius: 4, borderSkipped: false },
              { label: 'Einnahmen', data: inData, backgroundColor: cssColor('--green', 0.7), borderRadius: 4, borderSkipped: false },
            ],
          },
          options: {
            responsive: true,
            plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
              y: { ticks: { color: c.text, font: { size: 10 }, callback: (v) => v + '€' }, grid: { color: c.grid } },
            },
          },
        });
      }

      // ── REPORTS — YEAR ────────────────────────────────────────────────────────────

      async function renderReportYear(body, txs) {
        const a = reportRange.anchor;
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
            <p id="yearChartSummary" class="visually-hidden" aria-live="polite">Jahr ${a.y}: Einnahmen ${fmtCurrency(totals.in)}, Ausgaben ${fmtCurrency(totals.out)}.</p>
          </div>
          <div class="report-kpis">
            <div class="summary-card"><div class="label">Einnahmen</div><div class="amount positive">${fmtCurrency(totals.in)}</div></div>
            <div class="summary-card"><div class="label">Ausgaben</div><div class="amount negative">${fmtCurrency(totals.out)}</div></div>
            <div class="summary-card"><div class="label">Bilanz</div><div class="amount ${totals.in - totals.out >= 0 ? 'positive' : 'negative'}">${fmtSignedCurrency(totals.in - totals.out)}</div></div>
          </div>
        `;

        const c = getChartColors();
        const datasets = [
          { label: `Ausgaben ${a.y}`, data: monthly.map((m) => m.out), borderColor: cssColor('--accent'), backgroundColor: cssColor('--accent', 0.1), tension: 0.4, fill: true, pointRadius: 3 },
          { label: `Einnahmen ${a.y}`, data: monthly.map((m) => m.in), borderColor: cssColor('--green'), backgroundColor: cssColor('--green', 0.1), tension: 0.4, fill: true, pointRadius: 3 },
        ];
        if (prevMonthly) {
          datasets.push({
            label: `Ausgaben ${a.y - 1}`,
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
          data: { labels: MONTHS_SHORT, datasets },
          options: {
            responsive: true,
            plugins: { legend: { labels: { color: c.text, font: { family: 'DM Sans', size: 11 } } } },
            scales: {
              x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid } },
              y: { ticks: { color: c.text, font: { size: 10 }, callback: (v) => v + '€' }, grid: { color: c.grid } },
            },
          },
        });
      }

      // ── REPORTS — CATEGORIES ──────────────────────────────────────────────────────

      function renderReportCategories(body, txs) {
        const sorted = _totalsByCategory(txs, 'out');
        if (!sorted.length) {
          body.innerHTML = _emptyState('Keine Ausgaben im Zeitraum.');
          return;
        }
        const total = sorted.reduce((s, c) => s + c.amount, 0);
        const max = sorted[0].amount;

        body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="categoriesDonut" role="img" aria-label="Ausgaben pro Kategorie"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">Ausgaben gesamt</div>
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
            datasets: [{
              data: sorted.map((c) => c.amount),
              backgroundColor: sorted.map((c) => getCatById(c.catId)?.color || cssColor('--accent')),
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '64%',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } } },
          },
        });
      }

      async function drillDownCategory(catId, fromIso, toIso) {
        _searchExitTarget = 'charts';
        _categoryFilterId = catId;
        const from = fromIso || reportRange.from;
        const to = toIso || reportRange.to;
        _allTransactions = await loadRangeTxs(from, to);
        document.body.classList.add('searching');
        await _setSearchPanelActive(true);
        applySearch();
      }

      // ── REPORTS — TAGS ────────────────────────────────────────────────────────────

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

      function _escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function _escText(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function _tagRowMarkup(name, amount, max, opts = {}) {
        const color = _tagColor(name);
        const pct = max > 0 ? (amount / max) * 100 : 0;
        const attrName = _escAttr(name);
        const drill = opts.drillDown
          ? `role="button" tabindex="0" data-tag-drill="${attrName}"`
          : '';
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
          body.innerHTML = _emptyState('Keine getaggten Ausgaben im Zeitraum.');
          return;
        }
        const total = sorted.reduce((s, t) => s + t.amount, 0);
        const max = sorted[0].amount;

        body.innerHTML = `
          <div class="report-section">
            <div class="donut-wrap">
              <canvas id="tagsDonut" role="img" aria-label="Ausgaben pro Tag"></canvas>
              <div class="donut-center">
                <div class="donut-center-value">${fmtCurrency(total)}</div>
                <div class="donut-center-label">Ausgaben gesamt</div>
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
            datasets: [{
              data: sorted.map((t) => t.amount),
              backgroundColor: sorted.map((t) => _tagColor(t.name)),
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '64%',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed)}` } } },
          },
        });

        body.querySelectorAll('[data-tag-drill]').forEach((el) => {
          const name = el.dataset.tagDrill;
          el.addEventListener('click', () => drillDownTag(name));
          el.addEventListener('keydown', (ev) => handleRowActivate(ev, () => drillDownTag(name)));
        });
      }

      async function drillDownTag(name, fromIso, toIso) {
        _searchExitTarget = 'charts';
        _tagFilterName = name;
        const from = fromIso || reportRange.from;
        const to = toIso || reportRange.to;
        _allTransactions = await loadRangeTxs(from, to);
        document.body.classList.add('searching');
        await _setSearchPanelActive(true);
        applySearch();
      }

      // ── REPORTS — FORECAST ────────────────────────────────────────────────────────

      async function renderReportForecast(body) {
        const a = reportRange.anchor;
        // Zielmonat = Monat des Range-Starts (auch bei Quartal/Jahr/Custom).
        const targetY = parseInt(reportRange.from.slice(0, 4), 10);
        const targetM = parseInt(reportRange.from.slice(5, 7), 10) - 1;

        // Historie: 6 Monate vor dem Zielmonat.
        const histStart = new Date(targetY, targetM - 6, 1);
        const histEnd = new Date(targetY, targetM, 0);
        const histTxs = await loadRangeTxs(
          _iso(histStart.getFullYear(), histStart.getMonth(), 1),
          _iso(histEnd.getFullYear(), histEnd.getMonth(), histEnd.getDate())
        );

        if (histTxs.length === 0 || (histEnd - histStart) / (1000 * 60 * 60 * 24) < 28) {
          body.innerHTML = _emptyState('Noch nicht genug Daten für eine Prognose. Mindestens vier Wochen Buchungen werden benötigt.');
          return;
        }

        // Aktueller Zielmonat-Pool.
        const monthFrom = _iso(targetY, targetM, 1);
        const monthTo = _iso(targetY, targetM, _daysInMonth(targetY, targetM));
        const monthTxs = await loadRangeTxs(monthFrom, monthTo);
        const monthOut = monthTxs.filter((t) => t.type === 'out').reduce((s, t) => s + t.amount, 0);

        // Tage-Abrechnung: wenn der Zielmonat in der Zukunft liegt, daysPassed = daysTotal.
        const today = new Date();
        const daysTotal = _daysInMonth(targetY, targetM);
        let daysPassed;
        if (today.getFullYear() < targetY || (today.getFullYear() === targetY && today.getMonth() < targetM)) {
          daysPassed = 0;
        } else if (today.getFullYear() > targetY || (today.getFullYear() === targetY && today.getMonth() > targetM)) {
          daysPassed = daysTotal;
        } else {
          daysPassed = today.getDate();
        }

        // Per-Kategorie Ø der Historie.
        const histByCat = {};
        for (const t of histTxs) {
          if (t.type !== 'out') continue;
          histByCat[t.category_id] = (histByCat[t.category_id] || 0) + t.amount;
        }
        const avgOut = Object.values(histByCat).reduce((s, v) => s + v, 0) / 6;
        const projected = daysPassed > 0 ? (monthOut * daysTotal) / daysPassed : avgOut;

        // Aktuelle Ausgaben pro Kategorie im Zielmonat.
        const curByCat = {};
        for (const t of monthTxs) {
          if (t.type !== 'out') continue;
          curByCat[t.category_id] = (curByCat[t.category_id] || 0) + t.amount;
        }

        const rows = Object.entries(histByCat)
          .map(([id, sum6]) => ({ catId: parseInt(id, 10), avg: sum6 / 6, current: curByCat[id] || 0 }))
          .sort((a, b) => b.avg - a.avg);

        const statusFor = (cur, avg) => {
          if (avg <= 0) return { label: '', cls: '' };
          const ratio = cur / avg;
          if (ratio < 0.9) return { label: 'unter Ø', cls: 'is-ok' };
          if (ratio < 1.1) return { label: 'auf Ø', cls: 'is-neutral' };
          return { label: 'über Ø', cls: 'is-warn' };
        };

        const monthLabel = `${MONTHS[targetM]} ${targetY}`;
        body.innerHTML = `
          <div class="report-section">
            <div class="forecast-card">
              <div class="forecast-card-label">Voraussichtliche Monats-Ausgaben</div>
              <div class="forecast-card-value">${fmtCurrency(projected)}</div>
              <div class="forecast-card-hint">${monthLabel} · Tag ${daysPassed} von ${daysTotal} · Basis: letzte 6 Monate</div>
            </div>
          </div>
          <div class="report-section">
            <h3 class="report-section-title">Pro Kategorie</h3>
            <table class="forecast-table">
              <thead><tr><th>Kategorie</th><th class="num">Ø Monat</th><th class="num">Aktuell</th><th class="num">Status</th></tr></thead>
              <tbody>
                ${rows.map((r) => {
                  const cat = getCatById(r.catId);
                  if (!cat) return '';
                  const s = statusFor(r.current, r.avg);
                  return `<tr class="is-clickable" role="button" tabindex="0"
                    onclick="drillDownCategory(${r.catId}, '${monthFrom}', '${monthTo}')"
                    onkeydown="handleRowActivate(event, () => drillDownCategory(${r.catId}, '${monthFrom}', '${monthTo}'))">
                    <td><span class="forecast-cat-name"><span class="forecast-cat-dot" style="background:${cat.color}"></span>${cat.name}</span></td>
                    <td class="num">${fmtCurrency(r.avg)}</td>
                    <td class="num">${fmtCurrency(r.current)}</td>
                    <td class="num"><span class="forecast-status ${s.cls}">${s.label}</span></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;
      }

      // ── REPORTS — TOP EXPENSES ────────────────────────────────────────────────────

      function renderReportTop(body, txs) {
        const top = txs.filter((t) => t.type === 'out').sort((a, b) => b.amount - a.amount).slice(0, 10);
        if (!top.length) {
          body.innerHTML = _emptyState('Keine Ausgaben im Zeitraum.');
          return;
        }
        body.innerHTML = `<div class="report-section">${top.map(_txRowMarkup).join('')}</div>`;
      }

      // ── MODAL ─────────────────────────────────────────────────────────────────────
      function openModal(tx) {
        rememberModalFocus('booking');
        currentTags = tx?.tags ? [...tx.tags] : [];
        document.getElementById('inputAmount').value =
          tx?.amount != null ? Number(tx.amount).toFixed(2) : '';
        document.getElementById('inputDesc').value = tx?.desc || '';
        document.getElementById('inputDate').value =
          tx?.date || new Date().toISOString().split('T')[0];
        const catSel = document.getElementById('inputCat');
        catSel.innerHTML = categories
          .map((c) => `<option value="${c.id}">${c.name}</option>`)
          .join('');
        if (tx) catSel.value = tx.category_id;
        setType(tx?.type || 'out', document.querySelector('.type-btn.out'));
        renderTagPills();
        renderTagSuggestions();
        document.querySelector('.modal h2').textContent = tx
          ? 'Buchung bearbeiten'
          : 'Neue Buchung';
        document.getElementById('deleteBtn').style.display = tx ? 'block' : 'none';
        document.getElementById('modalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('inputAmount').focus(), 300);
        document.getElementById('modalOverlay').dataset.editId = tx?.id || '';
        trapFocusIn(document.querySelector('#modalOverlay .modal'), 'booking');
      }
      function closeModal() {
        document.getElementById('modalOverlay').classList.remove('open');
        document.body.style.overflow = '';
        releaseFocusTrap('booking');
        restoreModalFocus('booking');
      }
      function closeModalOutside(e) {
        if (e.target === document.getElementById('modalOverlay')) closeModal();
      }
      function editTransaction(id) {
        const num = Number(id);
        const pools = [_allTransactions, _reportTxPool, transactions];
        for (const p of pools) {
          if (!p) continue;
          const t = p.find((t) => t.id === num);
          if (t) return openModal(t);
        }
        // Falls die TX in keinem Pool liegt (etwa weil sie gerade per Sync entfernt
        // wurde): kein stilles Öffnen der Neuanlage — Hinweis geben.
        toast('Buchung wurde nicht gefunden.');
      }

      async function deleteCurrentTransaction() {
        const editId = document.getElementById('modalOverlay').dataset.editId;
        if (!editId) return;
        if (!(await confirmAction({ title: 'Buchung wirklich löschen?', confirmLabel: 'Löschen' })))
          return;
        try {
          await api('DELETE', `/transactions/${editId}`);
          closeModal();
          await loadAndRender();
        } catch (e) {
          if (!navigator.onLine && window.PocketLogOutbox) {
            await window.PocketLogOutbox.enqueue({
              method: 'DELETE',
              path: `/transactions/${editId}`,
            });
            closeModal();
            updateSyncBadge();
            return;
          }
          toast('Fehler beim Löschen: ' + e.message, 'error');
        }
      }

      function setType(type, btn) {
        currentType = type;
        document.querySelectorAll('.type-btn').forEach((b) => b.classList.remove('active'));
        document.querySelector('.type-btn.' + type).classList.add('active');
        document.getElementById('submitBtn').className =
          'submit-btn' + (type === 'in' ? ' green' : '');
        document.getElementById('submitBtn').textContent =
          type === 'out' ? 'Ausgabe speichern' : 'Einnahme speichern';
      }

      // The amount field is type="text" so iOS shows the decimal keypad
      // (which uses a comma on de_DE), so we accept both `,` and `.` as
      // the decimal separator here. Used by both the on-blur normalize
      // and by the save handler.
      function parseAmount(raw) {
        if (raw == null) return NaN;
        return parseFloat(String(raw).trim().replace(',', '.'));
      }

      function normalizeAmountInput() {
        const inp = document.getElementById('inputAmount');
        const n = parseAmount(inp.value);
        if (!isNaN(n)) inp.value = n.toFixed(2);
      }

      function removeTag(t) {
        currentTags = currentTags.filter((x) => x !== t);
        renderTagPills();
        renderTagSuggestions();
      }
      function renderTagPills() {
        const wrap = document.getElementById('tagsWrap');
        const btn = document.getElementById('tagPickerBtn');
        wrap.innerHTML = currentTags
          .map(
            (t) =>
              `<span class="tag-pill">${t}<button type="button" onclick="removeTag('${t.replace(/'/g, "\\'")}')" aria-label="Tag „${t}“ entfernen">${ICON_SVG.close}</button></span>`
          )
          .join('');
        wrap.appendChild(btn);
      }

      async function addTransaction() {
        const amount = parseAmount(document.getElementById('inputAmount').value);
        const desc = document.getElementById('inputDesc').value.trim();
        const cat = parseInt(document.getElementById('inputCat').value);
        const date = document.getElementById('inputDate').value;
        if (!amount || !date) {
          toast('Betrag und Datum sind Pflichtfelder.', 'error');
          return;
        }
        const body = {
          amount,
          desc,
          category_id: cat || null,
          date,
          type: currentType,
          tags: currentTags,
        };
        const editId = document.getElementById('modalOverlay').dataset.editId;
        const method = editId ? 'PUT' : 'POST';
        const path = editId ? `/transactions/${editId}` : '/transactions';
        try {
          await api(method, path, body);
          mergeIntoAvailableTags(currentTags);
          closeModal();
          await Promise.all([loadAndRender(), loadTags()]);
        } catch (e) {
          if (!navigator.onLine && window.PocketLogOutbox) {
            await window.PocketLogOutbox.enqueue({ method, path, body });
            mergeIntoAvailableTags(currentTags);
            closeModal();
            updateSyncBadge();
            return;
          }
          toast('Fehler beim Speichern: ' + e.message, 'error');
        }
      }

      function mergeIntoAvailableTags(tags) {
        if (!Array.isArray(tags) || !tags.length) return;
        const lower = new Set(availableTags.map((t) => t.toLowerCase()));
        let changed = false;
        for (const t of tags) {
          const v = (t || '').trim();
          if (!v) continue;
          const key = v.toLowerCase();
          tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
          if (!lower.has(key)) {
            availableTags.push(v);
            lower.add(key);
            changed = true;
          }
        }
        if (changed) {
          availableTags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          renderTagList();
        }
      }

      // ── CATEGORIES ────────────────────────────────────────────────────────────────
      const CAT_CREATE_COLORS = ['#D97757', '#6b7aa1', '#788C5D', '#c47ab0', '#e0a44a', '#87867F'];

      async function loadCategories() {
        try {
          categories = await api('GET', '/categories');
        } catch (e) {
          categories = [];
        }
      }

      async function loadTags() {
        try {
          const tags = await api('GET', '/tags');
          const list = Array.isArray(tags) ? tags : [];
          availableTags = list.map((t) => (typeof t === 'string' ? t : t.name));
          tagCounts.clear();
          for (const t of list) {
            if (typeof t === 'string') continue;
            tagCounts.set(t.name.toLowerCase(), Number(t.count) || 0);
          }
        } catch (e) {
          availableTags = [];
          tagCounts.clear();
        }
        renderTagList();
      }

      function renderTagSuggestions() {
        const box = document.getElementById('tagSuggestions');
        if (!box) return;
        const selected = new Set(currentTags.map((x) => x.toLowerCase()));
        const remaining = availableTags.filter((t) => !selected.has(t.toLowerCase()));
        // Pick the 10 most-used (last 30 days), then render alphabetically
        // so users can scan the row without re-learning order each open.
        remaining.sort((a, b) => {
          const ca = tagCounts.get(a.toLowerCase()) || 0;
          const cb = tagCounts.get(b.toLowerCase()) || 0;
          if (cb !== ca) return cb - ca;
          return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
        const top = remaining.slice(0, 10);
        top.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        box.innerHTML = top
          .map(
            (t) =>
              `<button type="button" class="tag-suggestion" onclick="addTagFromSuggestion('${t.replace(/'/g, "\\'")}')">+ ${t}</button>`
          )
          .join('');
      }

      function addTagFromSuggestion(t) {
        if (!t) return;
        if (!currentTags.includes(t)) currentTags.push(t);
        renderTagPills();
        renderTagSuggestions();
      }

      // ── TAG PICKER MODAL ──────────────────────────────────────────────────────────
      // Staging state: changes apply to `currentTags` only on „Fertig".
      let pickerSelection = [];

      function openTagPicker() {
        rememberModalFocus('tagPicker');
        pickerSelection = [...currentTags];
        document.getElementById('tagPickerFilter').value = '';
        document.getElementById('tagPickerNew').value = '';
        const chips = document.getElementById('tagPickerChips');
        chips.style.minHeight = '';
        renderTagPickerChips();
        document.getElementById('tagPickerOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        // Lock chip-area height to the unfiltered render so the modal
        // doesn't snap shut while the user is narrowing the filter.
        requestAnimationFrame(() => {
          chips.style.minHeight = chips.offsetHeight + 'px';
        });
        trapFocusIn(document.querySelector('#tagPickerOverlay .modal'), 'tagPicker');
      }
      function closeTagPicker() {
        document.getElementById('tagPickerOverlay').classList.remove('open');
        document.getElementById('tagPickerChips').style.minHeight = '';
        // Booking modal is the parent here — keep scroll-lock if it's still open.
        if (!document.getElementById('modalOverlay').classList.contains('open')) {
          document.body.style.overflow = '';
        }
        pickerSelection = [];
        releaseFocusTrap('tagPicker');
        restoreModalFocus('tagPicker');
      }
      function closeTagPickerOutside(e) {
        if (e.target === document.getElementById('tagPickerOverlay')) closeTagPicker();
      }
      function commitTagPicker() {
        currentTags = [...pickerSelection];
        closeTagPicker();
        renderTagPills();
        renderTagSuggestions();
      }
      function renderTagPickerChips() {
        const box = document.getElementById('tagPickerChips');
        if (!box) return;
        const q = (document.getElementById('tagPickerFilter').value || '')
          .trim()
          .toLowerCase();
        const filtered = q
          ? availableTags.filter((t) => t.toLowerCase().includes(q))
          : availableTags;
        const selected = new Set(pickerSelection.map((x) => x.toLowerCase()));
        box.innerHTML = filtered
          .map((t) => {
            const isSel = selected.has(t.toLowerCase());
            const safe = t.replace(/'/g, "\\'");
            return `<button type="button" class="tag-picker-chip${isSel ? ' selected' : ''}" onclick="togglePickerTag('${safe}')">${t}</button>`;
          })
          .join('');
      }
      function togglePickerTag(t) {
        const i = pickerSelection.findIndex((x) => x.toLowerCase() === t.toLowerCase());
        if (i >= 0) pickerSelection.splice(i, 1);
        else pickerSelection.push(t);
        renderTagPickerChips();
      }
      function handleTagPickerNew(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addTagFromPicker();
        }
      }
      function addTagFromPicker() {
        const inp = document.getElementById('tagPickerNew');
        const val = inp.value.trim();
        if (!val) return;
        const key = val.toLowerCase();
        const existing = availableTags.find((t) => t.toLowerCase() === key);
        const name = existing || val;
        if (!existing) {
          availableTags.push(name);
          availableTags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }
        if (!pickerSelection.some((x) => x.toLowerCase() === key)) {
          pickerSelection.push(name);
        }
        inp.value = '';
        renderTagPickerChips();
      }

      function renderCategories() {
        const box = document.getElementById('catList');
        if (!box) return;
        if (!categories.length) {
          box.innerHTML =
            '<p class="empty-state-hint">Noch keine Kategorien vorhanden.</p>';
          return;
        }
        const sorted = [...categories].sort((a, b) =>
          a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
        );
        box.innerHTML = sorted
          .map(
            (c) => `
    <div class="tag-pill cat-pill-edit" role="button" tabindex="0"
      aria-label="Kategorie „${c.name}“ bearbeiten"
      style="border-color:color-mix(in oklab, ${c.color} 40%, transparent)"
      onclick="openCatModal(${c.id})"
      onkeydown="handleRowActivate(event, () => openCatModal(${c.id}))"><span class="cat-pill-glyph" style="color:${c.color}">${catIconSvg(c.icon)}</span>${c.name}</div>
  `
          )
          .join('');
      }

      const CAT_COLOR_PRESETS = [
        { hex: '#D97757', name: 'Terracotta' },
        { hex: '#6b7aa1', name: 'Blau' },
        { hex: '#788C5D', name: 'Olive' },
        { hex: '#c47ab0', name: 'Mauve' },
        { hex: '#e0a44a', name: 'Senf' },
        { hex: '#87867F', name: 'Grau' },
        { hex: '#B85C3E', name: 'Rost' },
        { hex: '#8a6a4a', name: 'Kakao' },
        { hex: '#a45ab0', name: 'Violett' },
        { hex: '#6a8a8a', name: 'Petrol' },
      ];

      // Picker catalogue. IDs map 1:1 to <symbol id="cat-…"> entries in the
      // Phosphor sprite (frontend/icons/categories/sprite.svg). Order inside
      // a group is the order the picker renders.
      const CAT_ICON_GROUPS = [
        {
          title: 'Haus & Haushalt',
          ids: ['house', 'buildings', 'door', 'bed', 'armchair', 'couch',
            'chair', 'television', 'lightbulb', 'fan', 'oven', 'plug',
            'key', 'wrench', 'hammer', 'paint-brush', 'broom', 'fire'],
        },
        {
          title: 'Kleidung & Pflege',
          ids: ['t-shirt', 'dress', 'hoodie', 'pants', 'sneaker',
            'eyeglasses', 'watch', 'backpack', 'handbag', 'baby',
            'coat-hanger', 'washing-machine', 'scissors', 'shower',
            'drop', 'toilet-paper'],
        },
        {
          title: 'Lebensmittel & Getränke',
          ids: ['shopping-cart', 'basket', 'bag', 'bag-simple', 'bread',
            'egg', 'carrot', 'fish', 'orange', 'avocado', 'pepper',
            'hamburger', 'pizza', 'cookie', 'cake', 'ice-cream',
            'bowl-food', 'bowl-steam', 'coffee', 'beer-stein', 'wine',
            'martini', 'fork-knife', 'knife'],
        },
        {
          title: 'Mobilität',
          ids: ['car', 'taxi', 'bus', 'truck', 'motorcycle', 'scooter',
            'bicycle', 'train', 'train-regional', 'airplane', 'boat',
            'gas-pump', 'map-pin', 'road-horizon'],
        },
        {
          title: 'Freizeit',
          ids: ['film-strip', 'camera', 'game-controller', 'dice-five',
            'music-note', 'guitar', 'headphones', 'microphone',
            'palette', 'confetti', 'book', 'books', 'gift', 'ticket',
            'soccer-ball', 'basketball', 'tennis-ball', 'tree-palm'],
        },
        {
          title: 'Gesundheit',
          ids: ['pill', 'first-aid-kit', 'bandaids', 'heartbeat',
            'stethoscope', 'syringe', 'hospital', 'brain', 'virus',
            'mask-happy', 'tooth', 'dog', 'cat'],
        },
        {
          title: 'Büro & Bildung',
          ids: ['briefcase', 'graduation-cap', 'chalkboard', 'book-open',
            'pencil', 'envelope', 'calendar', 'clipboard', 'calculator',
            'laptop', 'folder', 'files', 'magnifying-glass',
            'newspaper-clipping', 'paperclip'],
        },
        {
          title: 'Finanzen',
          ids: ['wallet', 'credit-card', 'bank', 'vault', 'coins', 'coin',
            'coin-vertical', 'piggy-bank', 'currency-eur',
            'currency-dollar', 'hand-coins', 'receipt', 'invoice',
            'money', 'trend-up', 'trend-down', 'chart-line', 'percent'],
        },
        {
          title: 'Sonstiges',
          ids: ['package', 'star', 'heart', 'sparkle', 'magic-wand',
            'globe', 'bell', 'alarm', 'sun', 'moon', 'cloud', 'snowflake',
            'umbrella', 'mountains', 'tree', 'plant', 'leaf',
            'flower-tulip', 'butterfly', 'smiley', 'anchor', 'tag',
            'question'],
        },
      ];
      const CAT_ICON_FALLBACK = 'package';
      const CAT_ICON_VALID = new Set(CAT_ICON_GROUPS.flatMap((g) => g.ids));

      // Renders one sprite glyph. Unknown IDs (e.g. legacy emoji glyphs that
      // somehow survived migration) gracefully fall back to the box icon
      // rather than referencing a missing symbol.
      function catIconSvg(id) {
        const safe = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
        return `<svg class="cat-glyph" aria-hidden="true"><use href="#cat-${safe}"/></svg>`;
      }

      // Fetch the sprite once at boot and inject it inline so document-local
      // <use href="#cat-…"> references resolve everywhere (transaction rows,
      // category breakdown, picker). The file is cache-first via the SW.
      async function loadCategoryIconSprite() {
        if (document.getElementById('cat-icon-sprite')) return;
        try {
          const res = await fetch('/icons/categories/sprite.svg');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          // Strip the XML prolog if present — invalid as inline HTML.
          const cleaned = text.replace(/<\?xml[^?]*\?>/, '').trim();
          const host = document.createElement('div');
          host.id = 'cat-icon-sprite';
          host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
          host.setAttribute('aria-hidden', 'true');
          host.innerHTML = cleaned;
          document.body.insertBefore(host, document.body.firstChild);
        } catch (e) {
          console.warn('Category icon sprite failed to load:', e);
        }
      }

      let editingCatId = null;
      let editingCatColor = '#9e9b96';
      let editingCatIcon = CAT_ICON_FALLBACK;

      function openCatModal(id) {
        rememberModalFocus('cat');
        const deleteBtn = document.getElementById('catDeleteBtn');
        const title = document.getElementById('catModalTitle');
        if (id) {
          const c = categories.find((x) => x.id === id);
          if (!c) return;
          editingCatId = c.id;
          editingCatColor = c.color || '#9e9b96';
          editingCatIcon = CAT_ICON_VALID.has(c.icon) ? c.icon : CAT_ICON_FALLBACK;
          document.getElementById('catEditName').value = c.name || '';
          title.textContent = 'Kategorie bearbeiten';
          deleteBtn.style.display = '';
        } else {
          editingCatId = null;
          editingCatColor = CAT_CREATE_COLORS[categories.length % CAT_CREATE_COLORS.length];
          editingCatIcon = CAT_ICON_FALLBACK;
          document.getElementById('catEditName').value = '';
          title.textContent = 'Neue Kategorie';
          deleteBtn.style.display = 'none';
        }
        renderCatColorSwatches();
        renderCatIconPreview();
        document.getElementById('catModalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('catEditName').focus(), 200);
        trapFocusIn(document.querySelector('#catModalOverlay .modal'), 'cat');
      }

      function renderCatIconPreview() {
        const el = document.getElementById('catEditIconPreview');
        if (!el) return;
        el.style.color = editingCatColor;
        el.innerHTML = catIconSvg(editingCatIcon);
      }

      function renderCatColorSwatches() {
        const presets = [...CAT_COLOR_PRESETS];
        const hasCurrent = presets.some(
          (p) => p.hex.toLowerCase() === editingCatColor.toLowerCase()
        );
        if (!hasCurrent) presets.push({ hex: editingCatColor, name: 'Eigene Farbe' });
        const box = document.getElementById('catEditColors');
        box.innerHTML =
          presets
            .map((p) => {
              const isActive = p.hex.toLowerCase() === editingCatColor.toLowerCase();
              return `<button type="button" class="color-swatch${isActive ? ' active' : ''}" style="background:${p.hex}" aria-label="Farbe ${p.name} wählen" aria-pressed="${isActive}" onclick="pickCatColor('${p.hex}')"></button>`;
            })
            .join('') +
          `<label class="color-swatch-custom" title="Eigene Farbe">
     <input type="color" value="${editingCatColor}" onchange="pickCatColor(this.value)" aria-label="Eigene Farbe wählen">
   </label>`;
      }

      function pickCatColor(c) {
        editingCatColor = c;
        renderCatColorSwatches();
        renderCatIconPreview();
      }

      function closeCatModal() {
        document.getElementById('catModalOverlay').classList.remove('open');
        document.body.style.overflow = '';
        editingCatId = null;
        releaseFocusTrap('cat');
        restoreModalFocus('cat');
      }
      function closeCatModalOutside(e) {
        if (e.target === document.getElementById('catModalOverlay')) closeCatModal();
      }

      // ── ICON PICKER ───────────────────────────────────────────────────────────────
      function openIconPicker() {
        rememberModalFocus('iconPicker');
        renderIconPicker();
        const overlay = document.getElementById('iconPickerOverlay');
        overlay.classList.add('open');
        // Body scroll-lock already set by the cat modal; keep it.
        // Always open scrolled to the top — the browser otherwise keeps
        // whatever scrollTop the modal-body had on the previous open.
        overlay.querySelector('.modal-body').scrollTop = 0;
        trapFocusIn(overlay.querySelector('.modal'), 'iconPicker');
      }

      function closeIconPicker() {
        document.getElementById('iconPickerOverlay').classList.remove('open');
        releaseFocusTrap('iconPicker');
        restoreModalFocus('iconPicker');
      }

      function closeIconPickerOutside(e) {
        if (e.target === document.getElementById('iconPickerOverlay')) closeIconPicker();
      }

      function renderIconPicker() {
        const host = document.getElementById('iconPickerSections');
        host.innerHTML = CAT_ICON_GROUPS.map((g) => {
          const cells = g.ids.map((id) => {
            const active = id === editingCatIcon ? ' active' : '';
            const pressed = active ? 'true' : 'false';
            return `<button type="button" class="icon-picker-cell${active}"
              aria-pressed="${pressed}" aria-label="${id}"
              onclick="pickIcon('${id}')">${catIconSvg(id)}</button>`;
          }).join('');
          return `<section class="icon-picker-section">
            <h3 class="icon-picker-section-title">${g.title}</h3>
            <div class="icon-picker-grid">${cells}</div>
          </section>`;
        }).join('');
      }

      function pickIcon(id) {
        editingCatIcon = CAT_ICON_VALID.has(id) ? id : CAT_ICON_FALLBACK;
        renderCatIconPreview();
        closeIconPicker();
      }

      async function saveCategoryEdit() {
        const name = document.getElementById('catEditName').value.trim();
        const icon = CAT_ICON_VALID.has(editingCatIcon)
          ? editingCatIcon
          : CAT_ICON_FALLBACK;
        if (!name) {
          toast('Name ist ein Pflichtfeld.', 'error');
          return;
        }
        if (!/^#[0-9a-fA-F]{6}$/.test(editingCatColor)) {
          toast(
            'Die Farbe ist ungültig. Ein gültiger Hex-Wert wird benötigt, z. B. #D97757.',
            'error'
          );
          return;
        }
        try {
          if (editingCatId) {
            await api('PUT', `/categories/${editingCatId}`, { name, icon, color: editingCatColor });
          } else {
            await api('POST', '/categories', { name, icon, color: editingCatColor });
          }
          closeCatModal();
          await loadCategories();
          renderCategories();
          await loadAndRender();
        } catch (e) {
          if (e.message && e.message.includes('409')) {
            toast('Eine Kategorie mit diesem Namen existiert bereits.', 'error');
          } else {
            toast('Fehler beim Speichern: ' + e.message, 'error');
          }
        }
      }

      async function deleteCategoryEdit() {
        if (!editingCatId) return;
        const ok = await confirmAction({
          title: 'Kategorie wirklich löschen?',
          confirmLabel: 'Löschen',
        });
        if (!ok) return;
        try {
          await api('DELETE', `/categories/${editingCatId}`);
          closeCatModal();
          await loadCategories();
          renderCategories();
          await loadAndRender();
        } catch (e) {
          if (e.message && e.message.includes('409')) {
            toast(
              'Kategorie wird noch in Buchungen verwendet und kann nicht gelöscht werden.',
              'error'
            );
          } else {
            toast('Fehler beim Löschen: ' + e.message, 'error');
          }
        }
      }

      // ── TAGS (Einstellungen) ──────────────────────────────────────────────────────
      let editingTagName = null;

      function renderTagList() {
        const box = document.getElementById('tagList');
        if (!box) return;
        if (!availableTags.length) {
          box.innerHTML =
            '<p class="empty-state-hint">Noch keine Tags vorhanden.</p>';
          return;
        }
        box.innerHTML = availableTags
          .map((t) => {
            const safe = t.replace(/"/g, '&quot;');
            return `<div class="tag-pill cat-pill-edit" data-tag="${safe}">${t}</div>`;
          })
          .join('');
        box.querySelectorAll('[data-tag]').forEach((el) => {
          el.addEventListener('click', () => openTagModal(el.dataset.tag));
        });
      }

      function openTagModal(name) {
        rememberModalFocus('tag');
        const deleteBtn = document.getElementById('tagDeleteBtn');
        const title = document.getElementById('tagModalTitle');
        if (name) {
          editingTagName = name;
          document.getElementById('tagEditName').value = name;
          title.textContent = 'Tag bearbeiten';
          deleteBtn.style.display = '';
        } else {
          editingTagName = null;
          document.getElementById('tagEditName').value = '';
          title.textContent = 'Neuer Tag';
          deleteBtn.style.display = 'none';
        }
        document.getElementById('tagModalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => document.getElementById('tagEditName').focus(), 200);
        trapFocusIn(document.querySelector('#tagModalOverlay .modal'), 'tag');
      }

      function closeTagModal() {
        document.getElementById('tagModalOverlay').classList.remove('open');
        document.body.style.overflow = '';
        editingTagName = null;
        releaseFocusTrap('tag');
        restoreModalFocus('tag');
      }
      function closeTagModalOutside(e) {
        if (e.target === document.getElementById('tagModalOverlay')) closeTagModal();
      }

      async function saveTagEdit() {
        const newName = document.getElementById('tagEditName').value.trim();
        if (!newName) {
          toast('Name ist ein Pflichtfeld.', 'error');
          return;
        }
        if (editingTagName && newName === editingTagName) {
          closeTagModal();
          return;
        }
        try {
          if (editingTagName) {
            await api('PUT', `/tags/${encodeURIComponent(editingTagName)}`, { new_name: newName });
          } else {
            await api('POST', '/tags', { name: newName });
          }
          closeTagModal();
          await loadTags();
          renderTagList();
          await loadAndRender();
        } catch (e) {
          if (e.message && e.message.includes('409')) {
            toast('Ein Tag mit diesem Namen existiert bereits.', 'error');
          } else {
            toast('Fehler beim Speichern: ' + e.message, 'error');
          }
        }
      }

      async function deleteTagEdit() {
        if (!editingTagName) return;
        const ok = await confirmAction({
          title: 'Tag wirklich löschen?',
          message: 'Der Tag wird aus allen Buchungen entfernt.',
          confirmLabel: 'Löschen',
        });
        if (!ok) return;
        try {
          await api('DELETE', `/tags/${encodeURIComponent(editingTagName)}`);
          closeTagModal();
          await loadTags();
          renderTagList();
          await loadAndRender();
        } catch (e) {
          toast('Fehler beim Löschen: ' + e.message, 'error');
        }
      }

      // ── SYNC (Service-Worker-Outbox) ──────────────────────────────────────────────
      // Online-Schreibvorgänge laufen direkt; offline landen sie in der IndexedDB-
      // Outbox (frontend/db.js) und werden bei wieder hergestellter Verbindung
      // vom Service Worker bzw. diesem Aufruf nachgespielt.
      function setSyncBadge(n) {
        const badge = document.getElementById('syncBadge');
        if (!badge) return;
        if (n > 0) {
          badge.textContent = n > 99 ? '99+' : String(n);
          badge.hidden = false;
        } else {
          badge.textContent = '';
          badge.hidden = true;
        }
      }

      function setSyncAria(status) {
        const btn = document.getElementById('syncBtn');
        if (btn) btn.setAttribute('aria-label', `Synchronisieren – ${status}`);
        // The dedicated live region announces the change actively; the
        // aria-label above gives a stable description on focus.
        const live = document.getElementById('syncAriaLive');
        if (live) live.textContent = status;
      }

      async function syncNow() {
        const btn = document.getElementById('syncBtn');
        const dot = document.getElementById('syncDot');

        btn.classList.remove('error');
        dot.classList.remove('error');
        dot.classList.add('syncing');
        setSyncAria('Wird synchronisiert…');

        let flushed = 0;
        let networkErr = navigator.onLine === false;

        if (!networkErr && window.PocketLogOutbox) {
          try {
            flushed = await window.PocketLogOutbox.drain(API);
          } catch (e) {
            networkErr = true;
            console.error('Sync (drain) fehlgeschlagen:', e);
          }
        }

        if (!networkErr) {
          try {
            const r = await fetch(API + '/health', { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
          } catch (e) {
            networkErr = true;
            console.error('Sync (health) fehlgeschlagen:', e);
          }
        }

        const remaining = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
        dot.classList.remove('syncing');

        if (networkErr) {
          btn.classList.add('error');
          dot.classList.add('error');
          setSyncBadge(remaining);
          const msg = 'Offline – Änderungen werden gespeichert…';
          setSyncAria(msg);
          toast(msg, 'error');
          return;
        }
        if (remaining > 0) {
          btn.classList.add('error');
          dot.classList.add('error');
          setSyncBadge(remaining);
          const msg = 'Synchronisation fehlgeschlagen – Verbindung prüfen';
          setSyncAria(msg);
          toast(msg, 'error');
          return;
        }

        setSyncBadge(0);
        setSyncAria('Gespeichert');
        if (flushed > 0) await loadTags();
        await loadAndRender();
      }

      function loadApiBaseInput() {
        document.getElementById('cfg-api').value = localStorage.getItem(API_BASE_KEY) || '';
      }

      function saveDefaultView(view) {
        localStorage.setItem('pocketlog.defaultView', view);
        pushSettings({ default_view: view });
      }

      function loadDefaultView() {
        return localStorage.getItem('pocketlog.defaultView') || 'transactions';
      }

      function syncDefaultViewRadios() {
        const val = loadDefaultView();
        document.querySelectorAll('input[name="defaultView"]').forEach((r) => {
          r.checked = r.value === val;
        });
      }

      // ── THEME ─────────────────────────────────────────────────────────────────────
      const THEME_KEY = 'pocketlog.theme';

      function applyTheme(theme) {
        const html = document.documentElement;
        if (theme === 'dark' || theme === 'light') {
          html.setAttribute('data-theme', theme);
        } else {
          html.removeAttribute('data-theme');
        }
        // Re-resolve data-dark so CSS picks up the change.
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = theme === 'dark' || (theme !== 'light' && prefersDark);
        html.setAttribute('data-dark', isDark ? 'true' : 'false');
      }

      // Follow live OS-theme changes while the user is in 'system' mode.
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', (e) => {
          const manual = localStorage.getItem(THEME_KEY);
          if (manual === 'dark' || manual === 'light') return;
          document.documentElement.setAttribute('data-dark', e.matches ? 'true' : 'false');
          if (_activePanel === 'charts') renderReport();
        });

      function saveTheme(theme) {
        localStorage.setItem(THEME_KEY, theme);
        applyTheme(theme);
        pushSettings({ theme });
        if (_activePanel === 'charts') renderReport();
      }

      function loadTheme() {
        return localStorage.getItem(THEME_KEY) || 'system';
      }

      function syncThemeRadios() {
        const val = loadTheme();
        document.querySelectorAll('input[name="appTheme"]').forEach((r) => {
          r.checked = r.value === val;
        });
      }

      // ── SETTINGS-BACKUP (Server) ──────────────────────────────────────────────────
      // localStorage rendert sofort — diese Helpers gleichen das mit der DB ab,
      // damit das Theme + die Startansicht eine iOS-localStorage-Eviction überleben.
      // PUT geht durchs api()-Helper, im Offline-Fall fängt der SW-Outbox alles ab.
      function pushSettings(patch) {
        api('PUT', '/settings', patch).catch(() => {});
      }

      async function reconcileSettingsFromServer() {
        let s;
        try {
          s = await api('GET', '/settings');
        } catch (_) {
          return; // offline / nicht erreichbar → localStorage gilt
        }
        if (!s || s.offline) return;
        if (s.theme && s.theme !== loadTheme()) {
          localStorage.setItem(THEME_KEY, s.theme);
          applyTheme(s.theme);
          syncThemeRadios();
        }
        if (s.default_view && s.default_view !== loadDefaultView()) {
          // Panel-Switch mitten in der Session wäre disruptiv — nur die
          // Persistenz nachziehen, beim nächsten Start greift der Wert.
          localStorage.setItem('pocketlog.defaultView', s.default_view);
          syncDefaultViewRadios();
        }
      }

      async function saveApiBase() {
        const raw = document.getElementById('cfg-api').value.trim().replace(/\/+$/, '');
        if (raw && !/^https?:\/\//i.test(raw)) {
          showApiStatus('URL muss mit http:// oder https:// beginnen.', 'err');
          return;
        }
        if (raw) localStorage.setItem(API_BASE_KEY, raw);
        else localStorage.removeItem(API_BASE_KEY);
        API = readApiBase();
        try {
          const r = await fetch(API + '/health');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          showApiStatus('Verbunden – ' + (raw || 'same-origin'), 'ok');
          await loadCategories();
          await loadAndRender();
        } catch (e) {
          showApiStatus('Erreichbarkeit konnte nicht geprüft werden: ' + e.message, 'err');
        }
      }

      function showApiStatus(msg, kind) {
        const el = document.getElementById('apiStatus');
        el.textContent = msg;
        el.className = 'status-msg ' + (kind === 'ok' ? 'ok' : 'err');
        setTimeout(() => {
          if (el.textContent === msg) el.textContent = '';
        }, 5000);
      }

      async function updateSyncBadge() {
        const btn = document.getElementById('syncBtn');
        const dot = document.getElementById('syncDot');
        if (!window.PocketLogOutbox) {
          btn.classList.remove('error');
          dot.classList.remove('error');
          setSyncBadge(0);
          setSyncAria('Gespeichert');
          return;
        }
        const pending = await window.PocketLogOutbox.count();
        if (pending > 0) {
          setSyncBadge(pending);
          setSyncAria('Änderungen werden gespeichert…');
        } else {
          btn.classList.remove('error');
          dot.classList.remove('error');
          setSyncBadge(0);
          setSyncAria('Gespeichert');
        }
      }

      window.addEventListener('online', () => syncNow());

      // Desktop / Magic-Keyboard shortcuts. Cmd (macOS / iPad) and Ctrl
      // (Windows / Linux) are treated alike. Arrow keys for month
      // navigation are intentionally bare keys — they only fire when no
      // input is focused, no modal is open, and no mobile drawer is open.
      document.addEventListener('keydown', (e) => {
        const mod = e.metaKey || e.ctrlKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const inField =
          ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;
        const modalOpen = !!document.querySelector('.modal-overlay.open');
        const drawerOpenMobile =
          document.getElementById('drawer').classList.contains('open') &&
          !_mqTablet.matches;

        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
          e.preventDefault();
          openModal();
          return;
        }
        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          const s = document.getElementById('searchInput');
          if (s) s.focus();
          return;
        }
        if (!modalOpen && !drawerOpenMobile && !inField) {
          if (e.key === 'ArrowLeft') {
            changeMonth(-1);
            return;
          }
          if (e.key === 'ArrowRight') {
            changeMonth(1);
            return;
          }
        }
      });

      // Escape closes the topmost open modal/drawer. Order matters: confirm
      // dialog overrides everything, then nested tag picker, then the
      // individual modals, then the drawer.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const confirmOverlay = Array.from(
          document.querySelectorAll('.modal-overlay.open')
        ).find((o) => o.querySelector('.confirm-modal'));
        if (confirmOverlay) {
          confirmOverlay.querySelector('.confirm-cancel')?.click();
          return;
        }
        if (document.getElementById('tagPickerOverlay').classList.contains('open')) {
          closeTagPicker();
          return;
        }
        if (document.getElementById('tagModalOverlay').classList.contains('open')) {
          closeTagModal();
          return;
        }
        if (document.getElementById('catModalOverlay').classList.contains('open')) {
          closeCatModal();
          return;
        }
        if (document.getElementById('modalOverlay').classList.contains('open')) {
          closeModal();
          return;
        }
        if (document.getElementById('drawer').classList.contains('open')) {
          closeDrawer();
        }
      });

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          if (ev.data?.type === 'SYNC_DONE') {
            loadTags();
            loadAndRender();
          }
        });
      }

      // ── EXPORT / IMPORT ───────────────────────────────────────────────────────────
      async function exportCSV() {
        window.location.href = API + '/export/csv';
      }

      async function importCSV(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const status = document.getElementById('importStatus');
        status.textContent = 'Wird importiert…';
        status.className = 'status-msg';
        const fd = new FormData();
        fd.append('file', file);
        try {
          const res = await fetch(API + '/import/csv', { method: 'POST', body: fd });
          if (!res.ok) {
            const txt = await res.text();
            throw new Error('HTTP ' + res.status + ' – ' + txt.slice(0, 200));
          }
          const r = await res.json();
          const parts = [`${r.imported} Buchungen importiert`];
          if (r.skipped) parts.push(`${r.skipped} übersprungen`);
          if (r.errors && r.errors.length) {
            parts.push(`${r.errors.length} Fehler (Details in der Browser-Console)`);
            console.warn('CSV-Import: Fehlerhafte Zeilen', r.errors);
          }
          status.textContent = parts.join(' · ');
          status.className = 'status-msg ' + (r.imported > 0 ? 'ok' : 'err');
          await loadCategories();
          await loadTags();
          await loadAndRender();
        } catch (e) {
          status.textContent = 'Import fehlgeschlagen – Verbindung prüfen';
          status.className = 'status-msg err';
        } finally {
          ev.target.value = ''; // gleichen File-Reimport erlauben
        }
      }

      // ── ADMIN / DATA RESET ────────────────────────────────────────────────────────
      function openResetModal() {
        document.getElementById('resetModalOverlay').classList.add('open');
        document.body.style.overflow = 'hidden';
      }
      function closeResetModal() {
        document.getElementById('resetModalOverlay').classList.remove('open');
        // Drawer is the parent surface here — keep scroll-lock if it's still open.
        if (!document.getElementById('drawer').classList.contains('open')) {
          document.body.style.overflow = '';
        }
      }
      function closeResetModalOutside(e) {
        if (e.target === document.getElementById('resetModalOverlay')) closeResetModal();
      }

      async function _runReset(path, successMsg) {
        try {
          await api('DELETE', path);
          closeResetModal();
          closeDrawer();
          // Categories repopulate with defaults on next GET when wiped.
          await loadCategories();
          await loadTags();
          await loadAndRender();
          toast(successMsg, 'ok');
        } catch (e) {
          toast('Löschen fehlgeschlagen: ' + e.message, 'error');
        }
      }

      async function resetTransactionsOnly() {
        await _runReset('/admin/transactions', 'Alle Buchungen gelöscht.');
      }

      async function resetAllData() {
        await _runReset('/admin/all-data', 'Alle Daten gelöscht.');
      }

      // ── INFO PANEL ────────────────────────────────────────────────────────────────
      // Beste-Aufwand-Erkennung. UA-Strings sind notorisch unzuverlässig —
      // diese Werte sind ausschließlich für Debug-Anzeige gedacht, niemals
      // als Logik-Schalter.
      function _detectPlatform() {
        const ua = navigator.userAgent || '';
        const touch = navigator.maxTouchPoints || 0;
        const fmt = (a, b, c) => `${a}.${b}${c ? '.' + c : ''}`;
        let m;
        // Apple deckelt OS-Versionen mittlerweile in allen Browser-UAs ein
        // (macOS auf 10_15_7 seit Safari 14, iPadOS gibt im Desktop-Spoof
        // gar nichts mehr aus, und seit iOS 26 friert auch der iPhone-UA
        // auf „18_x" ein). Daher überall nur den Plattformnamen.
        if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'iPad';
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/Android/.test(ua)) {
          const v = ua.match(/Android (\d+(?:\.\d+)*)/);
          // Modell steht hinter dem zweiten Semikolon und vor ' Build/' bzw. ')'.
          const mm = ua.match(/Android[^;]*;[^;]*;\s*([^;)]+?)(?:\s+Build|\))/)
                  || ua.match(/;\s*([^;)]+)\s+Build\//);
          const model = mm ? mm[1].trim() : '';
          return `Android${v ? ' ' + v[1] : ''}${model ? ' · ' + model : ''}`;
        }
        if (/Macintosh/.test(ua)) return 'Mac';
        if (/Windows NT/.test(ua)) {
          m = ua.match(/Windows NT (\d+\.\d+)/);
          const map = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
          return m ? `Windows ${map[m[1]] || m[1]}` : 'Windows';
        }
        if (/CrOS/.test(ua)) return 'ChromeOS';
        if (/Linux/.test(ua)) return 'Linux';
        return 'Unbekannt';
      }

      function _detectBrowser() {
        const ua = navigator.userAgent || '';
        let m;
        // iOS-Alternativbrowser sind alle WebKit, lassen sich aber am
        // herstellerspezifischen Token erkennen — wichtig vor dem Safari-Match.
        if ((m = ua.match(/CriOS\/(\d+(?:\.\d+)?)/))) return 'Chrome iOS ' + m[1];
        if ((m = ua.match(/FxiOS\/(\d+(?:\.\d+)?)/))) return 'Firefox iOS ' + m[1];
        if ((m = ua.match(/EdgiOS\/(\d+(?:\.\d+)?)/))) return 'Edge iOS ' + m[1];
        if ((m = ua.match(/Edg\/(\d+(?:\.\d+)?)/))) return 'Edge ' + m[1];
        if ((m = ua.match(/OPR\/(\d+(?:\.\d+)?)/))) return 'Opera ' + m[1];
        if ((m = ua.match(/Firefox\/(\d+(?:\.\d+)?)/))) return 'Firefox ' + m[1];
        if (/Chrome\//.test(ua) && !/Edg|OPR/.test(ua)) {
          m = ua.match(/Chrome\/(\d+(?:\.\d+)?)/);
          return m ? 'Chrome ' + m[1] : 'Chrome';
        }
        if (/Safari\//.test(ua) && (m = ua.match(/Version\/(\d+(?:\.\d+)?)/))) {
          return 'Safari ' + m[1];
        }
        return '–';
      }

      function _detectDisplayMode() {
        if (window.matchMedia('(display-mode: standalone)').matches) return 'PWA (standalone)';
        if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'PWA (minimal-ui)';
        if (window.matchMedia('(display-mode: fullscreen)').matches) return 'Vollbild';
        // iOS-Safari nutzt die nicht-standardisierte navigator.standalone-Flag
        // statt display-mode, bis heute.
        if (navigator.standalone === true) return 'PWA (Home-Bildschirm)';
        return 'Browser-Tab';
      }

      function _detectPointer() {
        const coarse = window.matchMedia('(pointer: coarse)').matches;
        const fine = window.matchMedia('(pointer: fine)').matches;
        const hover = window.matchMedia('(hover: hover)').matches;
        const parts = [];
        if (coarse && fine) parts.push('Touch + Maus');
        else if (coarse) parts.push('Touch');
        else if (fine) parts.push('Maus/Trackpad');
        else parts.push('Unbekannt');
        const touchPts = navigator.maxTouchPoints || 0;
        if (touchPts > 0) parts.push(`max ${touchPts} Touch-Punkte`);
        if (!hover) parts.push('kein Hover');
        return parts.join(' · ');
      }

      // Jede renderInfoPanel-Invocation bekommt eine Sequenznummer; async
      // Antworten (Backend-Version, Health-Probe) überschreiben das DOM nur
      // dann, wenn sie noch zum aktuellen Durchgang gehören. Verhindert,
      // dass eine alte, langsame Antwort einen neueren Stand überschreibt,
      // wenn der User das Panel schnell zweimal öffnet.
      let _infoPanelSeq = 0;

      async function renderInfoPanel() {
        const mySeq = ++_infoPanelSeq;
        const set = (id, value) => {
          if (mySeq !== _infoPanelSeq) return;
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };

        const dpr = window.devicePixelRatio || 1;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sw = window.screen ? window.screen.width : 0;
        const sh = window.screen ? window.screen.height : 0;
        // Browser-Zoom näherungsweise aus outerWidth/innerWidth. Auf macOS
        // Safari/Firefox zählt das Fenster-Chrome minimal mit, daher runden.
        // visualViewport.scale fängt Pinch-Zoom auf Touch-Geräten ein.
        const zoomRatio = window.outerWidth && vw ? window.outerWidth / vw : 1;
        const zoomPct = Math.round(zoomRatio * 100);
        const pinch = window.visualViewport ? window.visualViewport.scale : 1;
        const zoomParts = [`${zoomPct}%`];
        if (pinch && Math.abs(pinch - 1) > 0.01) {
          zoomParts.push(`Pinch ${Math.round(pinch * 100) / 100}×`);
        }

        set('infoBackendVersion', 'Wird geladen…');
        set('infoSwVersion', '–');
        set('infoOnline', navigator.onLine ? 'Prüfe Backend…' : 'Offline');
        set('infoPlatform', _detectPlatform());
        set('infoBrowser', _detectBrowser());
        set('infoDisplayMode', _detectDisplayMode());
        set('infoPointer', _detectPointer());
        set('infoViewport', `${vw} × ${vh} px`);
        set('infoScreen', sw && sh ? `${sw} × ${sh} px` : '–');
        set('infoDpr', `${Math.round(dpr * 100) / 100}×`);
        set('infoZoom', zoomParts.join(' · '));
        set('infoPhysical', `${Math.round(vw * dpr)} × ${Math.round(vh * dpr)} px`);
        set('infoLang', navigator.language || '–');
        set('infoUserAgent', navigator.userAgent || '–');

        // Service-Worker-Status + Cache-Version
        if ('serviceWorker' in navigator) {
          try {
            const reg = await navigator.serviceWorker.getRegistration();
            if (!reg) {
              set('infoSwState', 'Nicht registriert');
            } else {
              const sw = reg.active || reg.waiting || reg.installing;
              const state = sw ? sw.state : 'unbekannt';
              const controlled = navigator.serviceWorker.controller ? ' · steuert' : '';
              set('infoSwState', `${state}${controlled}`);
            }
          } catch (e) {
            set('infoSwState', 'Fehler');
          }
          try {
            const keys = await caches.keys();
            const shellKey = keys.find((k) => k.startsWith('pocketlog-shell-'));
            set('infoSwVersion', shellKey ? shellKey.replace('pocketlog-shell-', '') : '–');
          } catch (e) {
            set('infoSwVersion', '–');
          }
        } else {
          set('infoSwState', 'Nicht unterstützt');
        }

        // Outbox-Stand
        try {
          const pending = window.PocketLogOutbox ? await window.PocketLogOutbox.count() : 0;
          set('infoOutbox', String(pending));
        } catch (e) {
          set('infoOutbox', '–');
        }

        // Backend-Health-Probe – ehrlicher als navigator.onLine, das nur
        // sagt, ob irgendein Netzwerk-Interface da ist. Läuft nur beim
        // Öffnen des Panels (kein Polling) und nur wenn der Browser
        // überhaupt online meldet — sonst wäre der Fetch sicher umsonst.
        if (navigator.onLine) {
          try {
            const res = await fetch(API + '/health', { cache: 'no-store' });
            set('infoOnline', res.ok ? 'Online · Backend erreichbar' : `Online · HTTP ${res.status}`);
          } catch (e) {
            set('infoOnline', 'Online · Backend unerreichbar');
          }
        }

        // Backend-Version – ohne api()-Helper, da /api/version öffentlich ist
        // und keinen Auth-Header braucht. Direkter Fetch vermeidet außerdem,
        // dass die SW-Outbox bei Offline-Zustand eine Schreib-Operation queued.
        try {
          const res = await fetch(API + '/version', { headers: { Accept: 'application/json' } });
          if (res.ok) {
            const data = await res.json();
            set('infoBackendVersion', data.version || '–');
          } else {
            set('infoBackendVersion', 'HTTP ' + res.status);
          }
        } catch (e) {
          set('infoBackendVersion', 'Offline');
        }
      }

      // ── INIT ──────────────────────────────────────────────────────────────────────
      async function init() {
        applyTheme(loadTheme());
        syncThemeRadios();
        applyRange({ skipRender: true });
        if ('serviceWorker' in navigator) {
          try {
            await navigator.serviceWorker.register('/sw.js');
          } catch (e) {
            console.warn('SW registration failed:', e);
          }
        }
        // Inject the category icon sprite before the first list render so
        // <use href="#cat-…"> resolves on the very first paint.
        await loadCategoryIconSprite();
        await loadCategories();
        await loadTags();
        await loadAndRender();
        showPanel(loadDefaultView());
        updateSyncBadge();
        // Server-Backup im Hintergrund — überschreibt localStorage nur,
        // falls der Server eine andere (aktuellere oder überlebende) Version hält.
        reconcileSettingsFromServer();
      }
      init();
