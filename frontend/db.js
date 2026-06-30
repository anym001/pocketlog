// IndexedDB outbox for offline write operations.
// Used by index.html and sw.js alike.

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

  // Replays the outbox. Returns {ok, failed}:
  //   ok     – number of entries processed successfully
  //   failed – number of entries the server rejected with a 4xx
  //            (validation, not found …). These land in the failed
  //            store so they don't vanish silently.
  // 5xx and network errors abort the loop — the entry stays in the
  // outbox and is retried on the next sync.
  //
  // 401 is a special case: it means "session expired / logged out".
  // The entry MUST NOT be discarded as failed — the user has to log in
  // again first, then the replay continues. So we abort like on a 5xx,
  // without consuming the entry.
  // For state-changing requests the replay must also send the CSRF
  // header; we get the token from the client via setCsrfToken().
  let _csrfToken = '';
  function setCsrfToken(value) {
    _csrfToken = typeof value === 'string' ? value : '';
  }

  async function drain(apiBase) {
    const items = await all();
    // Every queued entry is a state-changing write, so each needs the CSRF
    // header. Without a token the server rejects them all with 403 and we'd
    // dead-letter the user's data on what is really a setup gap (e.g. the SW
    // lost its in-memory token after a restart, or the page outbox was never
    // seeded). Treat a missing token like being offline: keep the entries and
    // retry once a token is available, rather than discarding them.
    if (items.length && !_csrfToken) {
      return { ok: 0, failed: 0, deferred: items.length };
    }
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
        // Session gone — replay only possible after a fresh login.
        // The entry is kept, the loop aborts.
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
        break; // 5xx: retry later
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
