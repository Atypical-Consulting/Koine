import { describe, expect, test } from 'vitest';
import { KOINE_UI_VERSION } from './index';

describe('index barrel', () => {
  test('re-exports the KOINE_UI_VERSION sentinel', () => {
    expect(KOINE_UI_VERSION).toBeDefined();
    expect(typeof KOINE_UI_VERSION).toBe('string');
  });
});
