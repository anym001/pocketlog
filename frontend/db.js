// IndexedDB-Outbox für Offline-Schreibvorgänge.
// Verwendet von index.html und sw.js gleichermaßen.

(function (global) {
  const DB_NAME = 'pocketlog';
  const DB_VERSION = 1;
  const STORE = 'outbox';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
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

  // Spielt die Outbox ab. Liefert die Anzahl erfolgreich abgearbeiteter Einträge.
  // Entries, die mit 4xx ablehnen, werden verworfen (keine Endlosschleife).
  // Netzfehler lassen den Eintrag stehen.
  async function drain(apiBase) {
    const items = await all();
    let done = 0;
    for (const item of items) {
      try {
        const res = await fetch(apiBase + item.path, {
          method: item.method,
          headers: item.body ? { 'Content-Type': 'application/json' } : {},
          body: item.body ? JSON.stringify(item.body) : undefined,
        });
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          await remove(item.id);
          done++;
        } else {
          break; // 5xx oder Netzwerk: später erneut versuchen
        }
      } catch (e) {
        break; // offline / Netz weg
      }
    }
    return done;
  }

  global.PocketLogOutbox = { enqueue, all, remove, count, drain };
})(self);
