/** Verlauf im Browser, damit die PWA nach einem Neustart weitergeht. */
const DB_NAME = "okg-pwa";
const STORE = "state";
const KEY = "turns";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadTurns<T>(): Promise<T[]> {
  try {
    const db = await open();
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as T[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function saveTurns<T>(turns: T[]): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(turns, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ohne Persistenz funktioniert die App weiter, nur ohne Verlauf.
  }
}

export async function clearTurns(): Promise<void> {
  await saveTurns([]);
}
