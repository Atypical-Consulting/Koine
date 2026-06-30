import { afterEach, describe, expect, it, test, vi } from 'vitest';
import { panelEnabled, panelGate } from '@/shell/panelGate';
import type { StorageLike } from '@/shell/localStorageFlag';

// An in-memory Storage stand-in so each test controls the capability deterministically (the global
// happy-dom shim is shared across files; a fresh map per test keeps the cases isolated). Mirrors
// localStorageFlag.test.ts — panelGate is a thin gate over that same PersistedFlag primitive.
function memStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

// A storage stand-in whose every method throws (Safari private mode / disabled cookies / sandboxed
// iframe) — proves the gate degrades to HIDDEN rather than crashing or leaking an unfinished panel.
const throwing: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

// Most tests pin dev-mode off so the pure flag semantics are deterministic regardless of how vitest
// resolves import.meta.env.DEV; the dev-affordance is exercised explicitly further down.
const PROD = { isDev: () => false } as const;

const CAP = 'rules';
const KEY = 'koine.studio.panel.rules';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('panelGate', () => {
  it('is disabled (hidden) until the capability is enabled', () => {
    const gate = panelGate(CAP, { storage: memStorage(), ...PROD });
    expect(gate.enabled()).toBe(false);
  });

  it("enable() writes the flag under the koine.studio.panel.* key and enabled() then reads true", () => {
    const storage = memStorage();
    const gate = panelGate(CAP, { storage, ...PROD });

    gate.enable();

    expect(storage.getItem(KEY)).toBe('1');
    expect(gate.enabled()).toBe(true);
  });

  it('disable() clears the flag so the panel hides again', () => {
    const storage = memStorage({ [KEY]: '1' });
    const gate = panelGate(CAP, { storage, ...PROD });
    expect(gate.enabled()).toBe(true);

    gate.disable();

    expect(storage.getItem(KEY)).toBe(null);
    expect(gate.enabled()).toBe(false);
  });

  it('honours a capability already enabled in storage', () => {
    const gate = panelGate(CAP, { storage: memStorage({ [KEY]: '1' }), ...PROD });
    expect(gate.enabled()).toBe(true);
  });

  it('scopes each capability to its own prefixed key', () => {
    const storage = memStorage();
    const rules = panelGate('rules', { storage, ...PROD });
    const notes = panelGate('notes', { storage, ...PROD });

    rules.enable();

    expect(rules.enabled()).toBe(true);
    expect(notes.enabled()).toBe(false);
    expect(storage.map.has('koine.studio.panel.notes')).toBe(false);
  });

  it('fails closed (hidden) when storage throws on read — never leak an unfinished panel', () => {
    const gate = panelGate(CAP, { storage: throwing, ...PROD });
    expect(gate.enabled()).toBe(false);
  });

  it('enable()/disable() never throw when storage throws on write', () => {
    const gate = panelGate(CAP, { storage: throwing, ...PROD });
    expect(() => gate.enable()).not.toThrow();
    expect(() => gate.disable()).not.toThrow();
  });

  it('forces the panel visible in a dev build even when the flag is unset', () => {
    const gate = panelGate(CAP, { storage: memStorage(), isDev: () => true });
    expect(gate.enabled()).toBe(true);
  });

  it('does not force-on in dev when devForcesOn is disabled', () => {
    const gate = panelGate(CAP, { storage: memStorage(), isDev: () => true, devForcesOn: false });
    expect(gate.enabled()).toBe(false);
  });

  it('wires the dev affordance to import.meta.env.DEV by default (no isDev override)', () => {
    vi.stubEnv('DEV', true);
    expect(panelGate(CAP, { storage: memStorage() }).enabled()).toBe(true);

    vi.stubEnv('DEV', false);
    expect(panelGate(CAP, { storage: memStorage() }).enabled()).toBe(false);
  });

  test('falls back to the real localStorage when no storage is injected', () => {
    // happy-dom provides a working localStorage; round-trip through the default adapter.
    const gate = panelGate('default-adapter-probe', PROD);
    gate.disable();
    expect(gate.enabled()).toBe(false);

    gate.enable();
    expect(gate.enabled()).toBe(true);
    expect(localStorage.getItem('koine.studio.panel.default-adapter-probe')).toBe('1');

    gate.disable();
    expect(gate.enabled()).toBe(false);
  });
});

describe('panelEnabled', () => {
  it('mirrors panelGate(...).enabled() for the same capability', () => {
    const enabled = memStorage({ [KEY]: '1' });
    const disabled = memStorage();
    expect(panelEnabled(CAP, { storage: enabled, ...PROD })).toBe(true);
    expect(panelEnabled(CAP, { storage: disabled, ...PROD })).toBe(false);
  });
});
