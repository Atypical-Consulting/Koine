import { describe, expect, test, vi } from 'vitest';
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
