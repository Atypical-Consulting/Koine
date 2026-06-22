// Koine Studio secret store: encrypts a small string secret (the assistant API key) at rest using
// AES-256-GCM, with a non-extractable key kept in IndexedDB. Pure data — no DOM, no Tauri. Like
// store.ts, every operation is best-effort and never throws: a blocked or absent store (private
// mode, insecure context, quota) degrades to "not persisted" rather than breaking the app.
//
// Threat model — be honest about the ceiling. This defeats casual inspection (devtools → Storage),
// shared-machine snooping, and profile/backup theft: the secret is never written in the clear and
// the AES key is non-extractable, so it can't leave the device. It does NOT defend against
// same-origin XSS — code running in this origin can call the decrypt path directly. This is
// defense-in-depth, not a vault.

// A dedicated database, separate from fs.ts's `koine-studio`/`handles` store, so the two evolve
// independently with no shared version/upgrade coordination.
const DB_NAME = 'koine-studio-secrets';
const STORE = 'vault';
// The single device key lives under this reserved id; secrets are keyed by their own names.
const KEY_ID = '__cryptoKey';

/** A persisted, encrypted secret: the GCM nonce plus the ciphertext (both structured-cloned). */
interface SecretRecord {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

/** Web Crypto + IndexedDB are both required; either may be missing in an insecure or locked-down context. */
function cryptoAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;
}

// Cache the connection so repeated reads/writes don't reopen the DB.
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbGet<T>(key: string): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
      }),
  );
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/**
 * The device AES-GCM key: read from IndexedDB, or generated (non-extractable) and persisted on first
 * use. The key is stored as an opaque CryptoKey via structured clone — its bytes are never exposed.
 * Returns null when crypto/storage is unavailable or any step fails.
 */
async function getOrCreateKey(): Promise<CryptoKey | null> {
  if (!cryptoAvailable()) return null;
  try {
    const existing = await idbGet<CryptoKey>(KEY_ID);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbPut(KEY_ID, key);
    return key;
  } catch {
    return null;
  }
}

/**
 * Encrypt and persist a named secret. An empty value deletes any stored record. Best-effort: a
 * missing store or quota/security error simply means the secret isn't persisted (never throws).
 */
export async function saveSecret(name: string, value: string): Promise<void> {
  if (!cryptoAvailable()) return;
  try {
    if (value.length === 0) {
      await idbDelete(name);
      return;
    }
    const key = await getOrCreateKey();
    if (!key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    const record: SecretRecord = { iv, data };
    await idbPut(name, record);
  } catch {
    // best-effort only
  }
}

/** Decrypt a stored secret, returning '' when it is absent, unreadable, or crypto is unavailable. */
export async function loadSecret(name: string): Promise<string> {
  if (!cryptoAvailable()) return '';
  try {
    const record = await idbGet<SecretRecord>(name);
    if (!record) return '';
    const key = await getOrCreateKey();
    if (!key) return '';
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data);
    return new TextDecoder().decode(plain);
  } catch {
    return '';
  }
}
