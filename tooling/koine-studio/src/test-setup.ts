// Vitest setup (test-only). happy-dom 20.x ships no Web Storage, so modules that persist via
// `localStorage` (store.ts) can't be exercised without a shim. Install a minimal in-memory
// localStorage/sessionStorage on the global. Never bundled into the app — only vitest loads this.

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

const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
if (!g.localStorage) g.localStorage = makeStorage();
if (!g.sessionStorage) g.sessionStorage = makeStorage();
