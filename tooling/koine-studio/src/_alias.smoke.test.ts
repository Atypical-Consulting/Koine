import { describe, it, expect } from 'vitest';
import { useAppStore } from '@/store/hooks';

describe('@/ path alias', () => {
  it('resolves @/ to src/ under vitest', () => {
    expect(typeof useAppStore).toBe('function');
  });
});
