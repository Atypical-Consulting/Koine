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
// Web Lock name that serializes first-time device-key creation across tabs/workers (see getOrCreateKey).
const DEVICE_KEY_LOCK = 'koine-studio-device-key';

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

/** The same-origin Web Lock manager, or null when the Web Locks API is unavailable (older browsers, the
 *  happy-dom test env, an insecure context). Feature-detected so the absence is a clean fallback, not a throw. */
function lockManager(): LockManager | null {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** Run `fn` under the device-key Web Lock when the API is available, else run it directly. The lock is
 *  same-origin and shared across tabs/workers, so it serializes first-creation even between tabs (which
 *  each have their own module + `keyPromise`); without it, fall back best-effort (cross-tab race unchanged). */
function withDeviceKeyLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  return locks ? locks.request(DEVICE_KEY_LOCK, fn) : fn();
}

/**
 * Read or mint the device AES-GCM key, then generate+persist it (non-extractable) at most once across
 * a first-creation race. Two layers make it atomic:
 *   1. A module-level `keyPromise` single-flights concurrent in-tab callers (e.g. boot's `initSecrets`
 *      racing a `saveApiKey`) onto ONE generate-and-persist.
 *   2. A same-origin Web Lock around generate+persist, re-reading KEY_ID inside the lock, serializes the
 *      first creation across separate tabs (each has its own `keyPromise`) so a loser adopts the winner's
 *      key instead of overwriting it.
 * Without this, racers minted distinct keys and the last KEY_ID write won, leaving records encrypted
 * under a now-lost key — the saved API key silently vanished on reload (#634). The key is stored as an
 * opaque CryptoKey via structured clone, so its bytes are never exposed. Returns null when crypto/storage
 * is unavailable or any step fails; a failed attempt is not cached, so a transient error can be retried.
 */
let keyPromise: Promise<CryptoKey | null> | null = null;

function getOrCreateKey(): Promise<CryptoKey | null> {
  // Bail before memoizing so a transient crypto-unavailable context isn't cached as a permanent failure.
  if (!cryptoAvailable()) return Promise.resolve(null);
  const pending = (keyPromise ??= doGetOrCreateKey());
  return pending.then((key) => {
    if (!key && keyPromise === pending) keyPromise = null; // don't memoize a failure — allow a later retry
    return key;
  });
}

async function doGetOrCreateKey(): Promise<CryptoKey | null> {
  try {
    const existing = await idbGet<CryptoKey>(KEY_ID);
    if (existing) return existing;
    return await withDeviceKeyLock(async () => {
      // Re-read inside the lock: a racer that lost the lock adopts the winner's key rather than minting a second.
      const winner = await idbGet<CryptoKey>(KEY_ID);
      if (winner) return winner;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await idbPut(KEY_ID, key);
      return key;
    });
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
