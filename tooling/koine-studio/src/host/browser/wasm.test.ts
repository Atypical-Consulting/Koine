import { describe, expect, test, vi } from 'vitest';
import { guardWasmSurface } from './wasm';

describe('guardWasmSurface', () => {
  test('passes through exports the bundle does provide', () => {
    const glossary = vi.fn(() => '{"entries":[]}');
    const api = guardWasmSurface({ Glossary: glossary });

    expect(api.Glossary('[]')).toBe('{"entries":[]}');
    expect(glossary).toHaveBeenCalledWith('[]');
  });

  // Reproduces the reported bug: a stale public/koine-wasm/ bundle (built before #67) has no
  // GlossaryModel export, so `api.GlossaryModel(...)` would otherwise blow up with the cryptic
  // "TypeError: api.GlossaryModel is not a function". The guard turns it into a fix-me message.
  test('a missing export throws an actionable rebuild message instead of a raw TypeError', () => {
    const api = guardWasmSurface({ Glossary: () => '{}' });

    expect(() => api.GlossaryModel('[]')).toThrowError(/GlossaryModel.*stale.*npm run build:wasm/s);
  });

  test('symbol access is untouched so the surface can still be inspected/awaited', () => {
    const api = guardWasmSurface({}) as unknown as Record<PropertyKey, unknown>;
    expect(api[Symbol.toPrimitive]).toBeUndefined();
  });

  // Regression: the Promise resolution machinery probes `value.then` to decide if the resolved value
  // is a thenable. If the guard returned a throwing function for the (unknown, non-export) string
  // `then`, the proxy would masquerade as a thenable and the whole language-server boot would reject
  // with a bogus `export "then" is missing`. So `then` and other non-export strings must pass through.
  test('non-export string props (then, toString) pass through so the proxy is not a fake thenable', () => {
    const api = guardWasmSurface({ Glossary: () => '{}' }) as unknown as Record<string, unknown>;
    expect(api.then).toBeUndefined();
    expect(typeof api.toString).toBe('function');
  });

  test('a proxied surface resolves cleanly when returned from a promise (await does not throw)', async () => {
    const api = guardWasmSurface({ Glossary: () => '{"entries":[]}' });
    await expect(Promise.resolve(api)).resolves.toBe(api);
  });
});
