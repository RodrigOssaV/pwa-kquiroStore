// Capa mínima sobre IndexedDB (sin dependencias).
//
// Stores:
//   items    – lista actual            keyPath "id"
//   catalog  – código → nombre/precio  keyPath "code"
//   exports  – historial de Excel      keyPath "id" (autoIncrement)
//   meta     – ajustes y estado        keyPath "key"

const DB_NAME = "kquiro-scanner";
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("catalog")) db.createObjectStore("catalog", { keyPath: "code" });
      if (!db.objectStoreNames.contains("exports")) db.createObjectStore("exports", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si otra pestaña actualiza la versión, cerramos para no bloquearla.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("La base de datos está bloqueada por otra pestaña."));
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Ejecuta `fn(stores)` dentro de una transacción y espera a que termine (commit). */
async function tx(storeNames, mode, fn) {
  const db = await open();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let result;
    Promise.resolve(fn(stores)).then((r) => (result = r), reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transacción abortada"));
  });
}

export const getAll = (store) => tx(store, "readonly", (s) => promisify(s[store].getAll()));
export const get = (store, key) => tx(store, "readonly", (s) => promisify(s[store].get(key)));
export const put = (store, value) => tx(store, "readwrite", (s) => promisify(s[store].put(value)));
export const del = (store, key) => tx(store, "readwrite", (s) => promisify(s[store].delete(key)));
export const clear = (store) => tx(store, "readwrite", (s) => promisify(s[store].clear()));

/** Inserta/actualiza muchos registros en una sola transacción. */
export const putMany = (store, values) =>
  tx(store, "readwrite", (s) => {
    for (const v of values) s[store].put(v);
  });

export async function getMeta(key, fallback = null) {
  const row = await get("meta", key);
  return row ? row.value : fallback;
}

export const setMeta = (key, value) => put("meta", { key, value });

/** Pide almacenamiento persistente para que el navegador no borre los datos. */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
