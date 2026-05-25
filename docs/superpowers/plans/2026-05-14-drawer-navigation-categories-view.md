# Drawer-Navigation & Kategorienansicht – Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bottom-Tabs entfernen, Drawer-Navigation mit 4 Einträgen einführen, neue Kategorienansicht mit monatlichen Summen pro Kategorie, Bilanz-Karte entfernen, Default-View-Einstellung.

**Architecture:** Alle Änderungen in `frontend/index.html` (eine Datei). Bestehender Panel-Mechanismus (`.panel` / `.panel.active`) wird erweitert. `showPanel()` wird neu geschrieben, da der `btn`-Parameter wegfällt. Aktiver Zustand wird über `data-panel`-Attribut auf Drawer-Nav-Items gesteuert.

**Tech Stack:** Vanilla HTML/CSS/JS, keine externen Abhängigkeiten.

---

### Task 1: Bottom-Nav HTML + CSS entfernen

**Files:**
- Modify: `frontend/index.html` (CSS ~L372–403, HTML ~L1343–1347)

- [ ] **Schritt 1: CSS-Block `.nav` und `.nav-tab` entfernen**

Ersetze den Block:
```css
/* ====== NAV TABS (segmented control) ====== */
.nav {
  display: flex;
  padding: 4px;
  gap: 2px;
  margin: 6px 20px 12px;
  background: var(--glass-thin);
  -webkit-backdrop-filter: var(--blur-thin);
  backdrop-filter: var(--blur-thin);
  border: 0.5px solid var(--hairline-soft);
  border-radius: var(--r-pill);
  box-shadow: inset 0 0.5px 0 var(--hairline);
}
.nav-tab {
  flex: 1;
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  cursor: pointer;
  border-radius: var(--r-pill);
  transition: all 0.3s var(--ease-spring);
  font-family: var(--font-body);
  background: transparent;
  border: none;
  letter-spacing: -0.01em;
}
.nav-tab.active {
  color: var(--text);
  background: var(--glass-thick);
  box-shadow: var(--shadow-soft);
}
```

durch nichts (komplett löschen).

- [ ] **Schritt 2: HTML-Block Bottom-Nav entfernen**

Lösche:
```html
<!-- NAV TABS -->
<div class="nav">
  <button class="nav-tab active" onclick="showPanel('transactions',this)">Buchungen</button>
  <button class="nav-tab" onclick="showPanel('charts',this)">Auswertung</button>
</div>
```

- [ ] **Schritt 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(nav): remove bottom tab navigation"
```

---

### Task 2: Bilanz-Karte HTML + JS entfernen

**Files:**
- Modify: `frontend/index.html` (HTML ~L1336–1340, JS `renderAll()` ~L1567–1579)

- [ ] **Schritt 1: Summary-Karte „Bilanz" aus HTML entfernen**

Lösche die dritte `summary-card`:
```html
<div class="summary-card full">
  <div class="label">Bilanz</div>
  <div class="amount" id="balance">€0,00</div>
  <div class="balance-bar"><div class="balance-bar-fill" id="balanceBar" style="width:50%"></div></div>
</div>
```

- [ ] **Schritt 2: `renderAll()` bereinigen**

Ersetze die aktuelle `renderAll()`:
```js
function renderAll() {
  document.getElementById('monthLabel').textContent = `${MONTHS[currentMonth]} ${currentYear}`;
  const out = transactions.filter(t=>t.type==='out').reduce((a,t)=>a+t.amount,0);
  const inc = transactions.filter(t=>t.type==='in').reduce((a,t)=>a+t.amount,0);
  const bal = inc - out;
  document.getElementById('totalOut').textContent = fmtCurrency(out);
  document.getElementById('totalIn').textContent  = fmtCurrency(inc);
  document.getElementById('balance').textContent  = fmtCurrency(bal);
  document.getElementById('balance').className    = 'amount ' + (bal>=0?'positive':'negative');
  const pct = inc > 0 ? Math.min(100, (out/inc)*100) : (out>0?100:0);
  document.getElementById('balanceBar').style.width = pct + '%';
  renderTransactions(transactions);
}
```

durch:
```js
function renderAll() {
  document.getElementById('monthLabel').textContent = `${MONTHS[currentMonth]} ${currentYear}`;
  const out = transactions.filter(t=>t.type==='out').reduce((a,t)=>a+t.amount,0);
  const inc = transactions.filter(t=>t.type==='in').reduce((a,t)=>a+t.amount,0);
  document.getElementById('totalOut').textContent = fmtCurrency(out);
  document.getElementById('totalIn').textContent  = fmtCurrency(inc);
  renderTransactions(transactions);
  if (document.getElementById('panel-categories').classList.contains('active')) {
    renderCategoryView();
  }
}
```

- [ ] **Schritt 3: `.balance-bar`-CSS-Block entfernen**

Suche und lösche den CSS-Block (ca. L356–368):
```css
.balance-bar {
  ...
}
.balance-bar-fill {
  ...
}
```

- [ ] **Schritt 4: Commit**

```bash
git add frontend/index.html
git commit -m "feat(ui): remove balance card and clean up renderAll"
```

---

### Task 3: Drawer-Nav-Items + CSS für aktiven Zustand

**Files:**
- Modify: `frontend/index.html` (CSS nach `.drawer-nav-item`, HTML `dpMain`)

- [ ] **Schritt 1: CSS für aktives Drawer-Nav-Item ergänzen**

Direkt nach dem Block `.drawer-nav-item:active { background: var(--glass-thin); }` einfügen:
```css
.drawer-nav-item.active {
  color: var(--accent);
  font-weight: 600;
}
```

- [ ] **Schritt 2: Drawer-Hauptpanel HTML ersetzen**

Das aktuelle `dpMain`-Panel:
```html
<!-- Panel 0: Hauptmenü -->
<div class="drawer-panel" id="dpMain" data-state="active">
  <nav class="drawer-nav">
    <button class="drawer-nav-item" onclick="drawerNav('dpSettings')">
      Einstellungen
      <span class="drawer-nav-chevron">›</span>
    </button>
  </nav>
</div>
```

ersetzen durch:
```html
<!-- Panel 0: Hauptmenü -->
<div class="drawer-panel" id="dpMain" data-state="active">
  <nav class="drawer-nav">
    <button class="drawer-nav-item active" data-panel="categories" onclick="showPanel('categories')">
      Kategorien
    </button>
    <button class="drawer-nav-item" data-panel="transactions" onclick="showPanel('transactions')">
      Transaktionen
    </button>
    <button class="drawer-nav-item" data-panel="charts" onclick="showPanel('charts')">
      Auswertungen
    </button>
    <button class="drawer-nav-item" onclick="drawerNav('dpSettings')">
      Einstellungen
      <span class="drawer-nav-chevron">›</span>
    </button>
  </nav>
</div>
```

Hinweis: Das erste Item (Kategorien oder Transaktionen) bekommt initial `class="drawer-nav-item active"` – dies wird in Task 6 dynamisch gesetzt.

- [ ] **Schritt 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(drawer): add main nav items for Kategorien, Transaktionen, Auswertungen"
```

---

### Task 4: `showPanel()` neu schreiben

**Files:**
- Modify: `frontend/index.html` (JS `showPanel()` ~L1494–1500)

- [ ] **Schritt 1: `showPanel()` ersetzen**

Ersetze:
```js
function showPanel(id, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  btn.classList.add('active');
  if (id === 'charts') renderCharts();
}
```

durch:
```js
let _activePanel = 'transactions';

function showPanel(id) {
  _activePanel = id;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.querySelectorAll('.drawer-nav-item[data-panel]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === id);
  });
  if (id === 'charts') renderCharts();
  if (id === 'categories') renderCategoryView();
  closeDrawer();
}
```

- [ ] **Schritt 2: Commit**

```bash
git add frontend/index.html
git commit -m "feat(nav): rewrite showPanel to work with drawer nav"
```

---

### Task 5: `panel-categories` HTML einfügen

**Files:**
- Modify: `frontend/index.html` (nach `panel-charts`, ca. L1375)

- [ ] **Schritt 1: Neues Panel einfügen**

Nach dem schließenden `</div>` des `panel-charts`-Blocks einfügen:
```html
<!-- CATEGORIES PANEL -->
<div class="panel" id="panel-categories">
  <div id="categoryViewList"></div>
</div>
```

- [ ] **Schritt 2: CSS für Kategorienzeilen ergänzen**

Im CSS-Bereich (z.B. nach `.panel.active`) einfügen:
```css
/* ====== CATEGORY VIEW ====== */
.cat-view-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 0.5px solid var(--hairline-soft);
}
.cat-view-row:last-child { border-bottom: none; }
.cat-view-icon {
  font-size: 22px;
  width: 32px;
  text-align: center;
  flex-shrink: 0;
}
.cat-view-name {
  flex: 1;
  font-size: 15px;
  color: var(--text);
}
.cat-view-amount {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cat-view-amount.negative { color: var(--accent); }
.cat-view-amount.positive { color: var(--green); }
```

- [ ] **Schritt 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(categories): add panel-categories HTML and CSS"
```

---

### Task 6: `renderCategoryView()` implementieren

**Files:**
- Modify: `frontend/index.html` (JS, nach `renderTransactions()`)

- [ ] **Schritt 1: Funktion einfügen**

Nach der schließenden `}` von `renderTransactions()` einfügen:
```js
function renderCategoryView() {
  const el = document.getElementById('categoryViewList');
  if (!el) return;

  if (!transactions.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>Keine Buchungen in diesem Monat.<br>Tippe auf <strong>+</strong> um eine hinzuzufügen.</p></div>`;
    return;
  }

  // Nettobetrag pro Kategorie berechnen
  const totals = {};
  transactions.forEach(t => {
    const key = t.category_id ?? 0;
    if (!totals[key]) totals[key] = 0;
    totals[key] += t.type === 'out' ? -t.amount : t.amount;
  });

  // Kategorien mit Buchungen holen und alphabetisch sortieren
  const rows = Object.entries(totals)
    .map(([catId, net]) => {
      const cat = getCatById(Number(catId));
      return { name: cat.name, icon: cat.icon, net };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  el.innerHTML = rows.map(r => `
    <div class="cat-view-row">
      <span class="cat-view-icon">${r.icon}</span>
      <span class="cat-view-name">${r.name}</span>
      <span class="cat-view-amount ${r.net >= 0 ? 'positive' : 'negative'}">${fmtCurrency(r.net)}</span>
    </div>
  `).join('');
}
```

- [ ] **Schritt 2: Manuell prüfen**

Browser öffnen (oder Dev-Server starten), Drawer öffnen → „Kategorien" wählen. Erwartung:
- Kategorieliste erscheint, alphabetisch sortiert
- Beträge in Accent-Farbe (Ausgaben) oder Grün (Einnahmen)
- Monatsnavigation aktualisiert die Liste korrekt

- [ ] **Schritt 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(categories): implement renderCategoryView"
```

---

### Task 7: Default-View-Einstellung (dpDisplay)

**Files:**
- Modify: `frontend/index.html` (HTML dpSettings-Panel, neues dpDisplay-Panel, JS init())

- [ ] **Schritt 1: `dpDisplay` zu `_drawerSubs` hinzufügen**

Ersetze:
```js
const _drawerSubs = ['dpSettings', 'dpCats', 'dpTags', 'dpImport'];
```

durch:
```js
const _drawerSubs = ['dpSettings', 'dpCats', 'dpTags', 'dpImport', 'dpDisplay'];
```

- [ ] **Schritt 2: „Darstellung"-Eintrag im dpSettings-Panel hinzufügen**

Im `dpSettings`-Panel die `<nav>`-Liste erweitern – nach dem „Import/Export"-Button und vor dem schließenden `</nav>`:
```html
<button class="drawer-nav-item" onclick="drawerNav('dpDisplay')">
  Darstellung
  <span class="drawer-nav-chevron">›</span>
</button>
```

- [ ] **Schritt 3: Neues `dpDisplay`-Panel einfügen**

Nach dem schließenden `</div>` des `dpImport`-Panels einfügen:
```html
<!-- Panel 2d: Darstellung -->
<div class="drawer-panel" id="dpDisplay" data-state="right">
  <div class="drawer-sub-head">
    <button class="drawer-back-btn" onclick="drawerBack()" aria-label="Zurück zu Einstellungen">‹ Einstellungen</button>
    <span class="drawer-sub-title">Darstellung</span>
  </div>
  <div class="drawer-section">
    <h3>Startansicht</h3>
    <div class="settings-section">
      <label style="display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer">
        <input type="radio" name="defaultView" value="transactions" onchange="saveDefaultView(this.value)" style="accent-color:var(--accent)">
        Transaktionen
      </label>
      <label style="display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer">
        <input type="radio" name="defaultView" value="categories" onchange="saveDefaultView(this.value)" style="accent-color:var(--accent)">
        Kategorien
      </label>
    </div>
  </div>
</div>
```

- [ ] **Schritt 4: `saveDefaultView()` und Init-Logik hinzufügen**

Nach `loadApiBaseInput()` (ca. L2270) einfügen:
```js
function saveDefaultView(view) {
  localStorage.setItem('pocketlog.defaultView', view);
}

function loadDefaultView() {
  return localStorage.getItem('pocketlog.defaultView') || 'transactions';
}

function syncDefaultViewRadios() {
  const val = loadDefaultView();
  document.querySelectorAll('input[name="defaultView"]').forEach(r => {
    r.checked = r.value === val;
  });
}
```

- [ ] **Schritt 5: `drawerNav` für `dpDisplay` erweitern**

In `drawerNav()` nach den bestehenden `if`-Blöcken ergänzen:
```js
if (panelId === 'dpDisplay') syncDefaultViewRadios();
```

- [ ] **Schritt 6: `init()` anpassen**

In `init()` vor `await loadAndRender()` einfügen:
```js
showPanel(loadDefaultView());
```

Die bestehende Zeile `document.getElementById('yearLabel').textContent = chartYear;` bleibt.

- [ ] **Schritt 7: Prüfen**

Drawer → Einstellungen → Darstellung öffnen. Radio-Button auf „Kategorien" setzen, App neu laden → Kategorienansicht erscheint als Startansicht. Zurück auf „Transaktionen" → App startet wieder mit Transaktionsliste.

- [ ] **Schritt 8: Commit**

```bash
git add frontend/index.html
git commit -m "feat(settings): add default view setting in drawer"
```

---

### Task 8: Panel-Padding für mehr Platz anpassen

**Files:**
- Modify: `frontend/index.html` (CSS `.panel`)

- [ ] **Schritt 1: Panel-Bottom-Padding reduzieren**

Das Bottom-Padding von `.panel` war auf `90px` gesetzt (Platz für die alten Bottom-Tabs). Jetzt reicht weniger. Ersetze:
```css
.panel { display: none; padding: 8px 20px 90px; }
```

durch:
```css
.panel { display: none; padding: 8px 20px 32px; }
```

- [ ] **Schritt 2: Commit**

```bash
git add frontend/index.html
git commit -m "feat(ui): reduce panel bottom padding after removing bottom nav"
```

---

### Task 9: Initiales aktives Drawer-Item korrekt setzen

**Files:**
- Modify: `frontend/index.html` (HTML dpMain initial active class)

- [ ] **Schritt 1: Initiales `active`-Attribut aus dpMain entfernen**

In Task 3 wurde dem ersten Drawer-Item `class="drawer-nav-item active"` gegeben. Das ist jetzt falsch – `showPanel(loadDefaultView())` in `init()` setzt das korrekte Item. Entferne das hartcodierte `active` aus dem HTML:

```html
<button class="drawer-nav-item" data-panel="categories" onclick="showPanel('categories')">
  Kategorien
</button>
```

(Das `active` wird durch `showPanel()` beim Init gesetzt.)

- [ ] **Schritt 2: Commit**

```bash
git add frontend/index.html
git commit -m "fix(nav): let init() control initial active drawer item"
```

---

## Selbst-Review gegen Spec

| Spec-Anforderung | Task |
|---|---|
| Drawer: 4 Items (Kategorien, Transaktionen, Auswertungen, Einstellungen) | Task 3 |
| Bottom-Tabs entfernen | Task 1 |
| Bilanz-Karte entfernen | Task 2 |
| panel-categories + renderCategoryView | Task 5 + 6 |
| Alphabetische Sortierung | Task 6 |
| Aktives Drawer-Item markieren | Task 4 |
| Default-View-Einstellung in dpDisplay | Task 7 |
| Panel-Padding nach Tab-Entfernung anpassen | Task 8 |
| Init lädt Default-View | Task 7 Schritt 6 |
