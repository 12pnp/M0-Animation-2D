/**
 * The editor's one IndexedDB database (E6-PLAN step 4a): what the browser keeps for it beyond
 * `localStorage`: Export to Unity's folder, and the recovery copy. Every call fails soft (a
 * private window, blocked storage): reads give null, writes are skipped.
 */

const DB = "boneburst-editor", VERSION = 2;
export type StoreName = "handles" | "recovery";

function open(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      for (const s of ["handles", "recovery"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | null> {
  try {
    const d = await open();
    return await new Promise((ok) => {
      const r = d.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => ok((r.result as T | undefined) ?? null);
      r.onerror = () => ok(null);
    });
  } catch { return null; }
}

/** Put `value` (undefined: delete the key); whether it was kept. */
export async function idbSet(store: StoreName, key: string, value: unknown): Promise<boolean> {
  try {
    const d = await open();
    return await new Promise((ok) => {
      const t = d.transaction(store, "readwrite");
      if (value === undefined) t.objectStore(store).delete(key); else t.objectStore(store).put(value, key);
      t.oncomplete = () => ok(true);
      t.onerror = () => ok(false);
      t.onabort = () => ok(false);
    });
  } catch { return false; }
}
