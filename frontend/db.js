// IndexedDB-Outbox für Offline-Schreibvorgänge.
// Verwendet von index.html und sw.js gleichermaßen.

(function (global) {
  const DB_NAME = 'pocketlog';
  // v2 adds the `failed` dead-letter store for 4xx responses so we
  // never silently drop user data on replay.
  const DB_VERSION = 2;
  const STORE = 'outbox';
  const FAILED_STORE = 'failed';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(FAILED_STORE)) {
          db.createObjectStore(FAILED_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function enqueue(entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ ...entry, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function all() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function count() {
    const items = await all();
    return items.length;
  }

  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function failedAdd(entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FAILED_STORE, 'readwrite');
      tx.objectStore(FAILED_STORE).add({ ...entry, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function failedAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FAILED_STORE, 'readonly');
      const req = tx.objectStore(FAILED_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function failedCount() {
    const items = await failedAll();
    return items.length;
  }

  async function failedClear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FAILED_STORE, 'readwrite');
      tx.objectStore(FAILED_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Spielt die Outbox ab. Liefert {ok, failed}:
  //   ok     – Anzahl erfolgreich abgearbeiteter Einträge
  //   failed – Anzahl Einträge, die der Server mit 4xx abgelehnt hat
  //            (Validation, Not Found …). Diese landen im Failed-Store,
  //            damit sie nicht stillschweigend verschwinden.
  // 5xx- und Netzfehler brechen die Schleife ab — der Eintrag bleibt
  // in der Outbox und wird beim nächsten Sync erneut versucht.
  //
  // 401 ist ein Sonderfall: bedeutet „Session abgelaufen / abgemeldet".
  // Der Eintrag DARF NICHT als failed verworfen werden — der User muss
  // sich erst neu einloggen, und dann läuft der Replay weiter. Wir
  // brechen also wie bei 5xx ab, ohne den Eintrag zu konsumieren.
  // Für state-changing Requests muss der Replay zudem den
  // CSRF-Header mitschicken; das Token bekommen wir vom Client per
  // setCsrfToken().
  let _csrfToken = '';
  function setCsrfToken(value) {
    _csrfToken = typeof value === 'string' ? value : '';
  }

  async function drain(apiBase) {
    const items = await all();
    let ok = 0;
    let failed = 0;
    for (const item of items) {
      let res;
      try {
        const headers = {};
        if (item.body) headers['Content-Type'] = 'application/json';
        if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
        res = await fetch(apiBase + item.path, {
          method: item.method,
          credentials: 'same-origin',
          headers,
          body: item.body ? JSON.stringify(item.body) : undefined,
        });
      } catch (e) {
        break; // offline / Netz weg
      }
      if (res.ok) {
        await remove(item.id);
        ok++;
      } else if (res.status === 401) {
        // Session weg — Replay erst nach erneutem Login möglich.
        // Eintrag bleibt erhalten, Loop bricht ab.
        break;
      } else if (res.status >= 400 && res.status < 500) {
        const detail = await res.text().catch(() => '');
        await failedAdd({
          method: item.method,
          path: item.path,
          body: item.body,
          status: res.status,
          detail: detail.slice(0, 500),
        });
        await remove(item.id);
        failed++;
      } else {
        break; // 5xx: später erneut versuchen
      }
    }
    return { ok, failed };
  }

  global.PocketLogOutbox = {
    enqueue,
    all,
    remove,
    count,
    drain,
    clear,
    failedAll,
    failedCount,
    failedClear,
    setCsrfToken,
  };
})(self);
