// Vitest setup (test-only). happy-dom 20.x ships no Web Storage, so modules that persist via
// `localStorage` (store.ts) can't be exercised without a shim. Install a minimal in-memory
// localStorage/sessionStorage on the global. Never bundled into the app — only vitest loads this.

// happy-dom ships no IndexedDB either; the secret store (secrets.ts) needs one. fake-indexeddb/auto
// installs an in-memory IndexedDB on the global. A fresh environment per test file isolates it.
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage; crypto?: Crypto };
// happy-dom 20.x now exposes a `localStorage` on the global that lacks the full Web Storage surface
// (notably `clear`), which would shadow our shim if we only checked for its absence. Install the
// in-memory shim whenever Storage is missing OR incomplete, so every test sees a real Storage.
if (typeof g.localStorage?.clear !== 'function') g.localStorage = makeStorage();
if (typeof g.sessionStorage?.clear !== 'function') g.sessionStorage = makeStorage();

// secrets.ts needs Web Crypto (crypto.subtle). happy-dom may not expose it; back it with Node's
// WebCrypto so AES-GCM encrypt/decrypt behaves as it does in the browser.
if (!g.crypto?.subtle) g.crypto = webcrypto as unknown as Crypto;
