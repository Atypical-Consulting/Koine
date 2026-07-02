import { beforeEach, describe, expect, test, vi } from 'vitest';
import { saveSecret, loadSecret } from '@/ai/secrets';

describe('secret store', () => {
  test('round-trips an encrypted value', async () => {
    await saveSecret('rt', 'sk-secret-123');
    expect(await loadSecret('rt')).toBe('sk-secret-123');
  });

  test('returns "" for an unknown secret', async () => {
    expect(await loadSecret('never-written')).toBe('');
  });

  test('an empty value deletes the stored secret', async () => {
    await saveSecret('del', 'value');
    expect(await loadSecret('del')).toBe('value');
    await saveSecret('del', '');
    expect(await loadSecret('del')).toBe('');
  });

  test('overwriting replaces the previous value', async () => {
    await saveSecret('ow', 'first');
    await saveSecret('ow', 'second');
    expect(await loadSecret('ow')).toBe('second');
  });

  test('reuses one device key across distinct secrets', async () => {
    await saveSecret('k1', 'alpha');
    await saveSecret('k2', 'beta');
    expect(await loadSecret('k1')).toBe('alpha');
    expect(await loadSecret('k2')).toBe('beta');
  });

  test('preserves unicode', async () => {
    await saveSecret('uni', 'clé-🔑-naïve');
    expect(await loadSecret('uni')).toBe('clé-🔑-naïve');
  });

  test('degrades gracefully when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(saveSecret('nocrypto', 'x')).resolves.toBeUndefined();
      expect(await loadSecret('nocrypto')).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// #634 — device-key get-or-create must be atomic. Before the fix, two callers racing the FIRST key
// creation each minted a distinct AES key and overwrote KEY_ID (last write wins); a record encrypted
// under the loser's key then failed to decrypt after reload and the saved API key was silently lost.
describe('concurrent device-key creation (issue #634)', () => {
  const DB_NAME = 'koine-studio-secrets';
  const STORE = 'vault';

  // Empty the vault (drop any device key/records a prior test wrote) and reset the module registry so
  // each test races the genuine FIRST key creation against a fresh module instance (keyPromise unset).
  async function freshStore(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
    vi.resetModules();
  }

  // A fresh import of the secret store with its in-memory memo reset — i.e. a brand-new tab/reload
  // backed by the SAME (persisted) IndexedDB.
  async function freshInstance(): Promise<typeof import('@/ai/secrets')> {
    vi.resetModules();
    return import('@/ai/secrets');
  }

  // A same-origin Web Locks stub that serializes requests by name. Real `navigator.locks` is absent in
  // happy-dom, so this is how the cross-tab lock path gets exercised at all.
  function installSerializingWebLocks(): void {
    const tails = new Map<string, Promise<unknown>>();
    const locks = {
      request<T>(name: string, cb: () => Promise<T>): Promise<T> {
        const prev = tails.get(name) ?? Promise.resolve();
        const result = prev.then(() => cb());
        tails.set(
          name,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      },
    };
    vi.stubGlobal('navigator', { locks });
  }

  beforeEach(async () => {
    await freshStore();
  });

  test('single tab: two concurrent first saves both survive a reload', async () => {
    const tab = await import('@/ai/secrets');
    // Both saves race the first device-key creation in ONE tab (e.g. boot initSecrets vs saveApiKey).
    await Promise.all([tab.saveSecret('a', 'alpha'), tab.saveSecret('b', 'beta')]);

    // Reload: a fresh module instance reading the persisted store must decrypt BOTH records.
    const reloaded = await freshInstance();
    expect(await reloaded.loadSecret('a')).toBe('alpha');
    expect(await reloaded.loadSecret('b')).toBe('beta');
  });

  test('cross tab: Web Locks serialize first-creation so no secret is lost', async () => {
    installSerializingWebLocks();
    try {
      // Two separate tabs (distinct module instances, distinct in-memory memo) save at the same time.
      const tabA = await freshInstance();
      const tabB = await freshInstance();
      await Promise.all([tabA.saveSecret('x', 'one'), tabB.saveSecret('y', 'two')]);

      const reloaded = await freshInstance();
      expect(await reloaded.loadSecret('x')).toBe('one');
      expect(await reloaded.loadSecret('y')).toBe('two');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// A transient IndexedDB open failure (e.g. Chrome's intermittent "Internal error opening backing
// store") must not poison the cached connection for the whole session: getOrCreateKey explicitly
// refuses to memoize a failure so it can be retried, but before the fix openDb kept the rejected
// connection promise cached, so every retry re-hit the same dead promise and a key saved AFTER
// storage recovered was silently dropped.
describe('transient IndexedDB open failure (connection retry)', () => {
  test('a failed open is not cached: a later save in the same session persists the secret', async () => {
    const realIndexedDB = indexedDB;
    let failNext = true;
    vi.stubGlobal('indexedDB', {
      open(name: string, version?: number) {
        if (!failNext) return realIndexedDB.open(name, version);
        failNext = false;
        // A minimal IDBOpenDBRequest that fails: only onerror ever fires, with a transient error.
        const req = {
          error: new Error('Internal error opening backing store'),
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => req.onerror?.());
        return req as unknown as IDBOpenDBRequest;
      },
    });
    try {
      // A fresh module instance: no cached connection or device key inherited from sibling tests.
      vi.resetModules();
      const store = await import('@/ai/secrets');
      // The boot-time attempt hits the transient failure — best-effort, nothing persisted, no throw.
      await store.saveSecret('retry', 'lost-first-attempt');
      // Storage has recovered; the user now pastes their key in Settings → Assistant. The save must
      // reopen the connection instead of reusing the cached rejection…
      await store.saveSecret('retry', 'sk-live-123');
      // …so the secret round-trips within the same session.
      expect(await store.loadSecret('retry')).toBe('sk-live-123');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
