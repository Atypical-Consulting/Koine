import { describe, expect, test } from 'vitest';
import { handleBeforeUnload, titleWithDirty } from '@/shell/dirty';

describe('titleWithDirty', () => {
  test('prefixes a bullet when there are unsaved files', () => {
    expect(titleWithDirty('Koine Studio', 1)).toBe('• Koine Studio');
    expect(titleWithDirty('Koine Studio', 3)).toBe('• Koine Studio');
  });

  test('returns the base title unchanged when nothing is unsaved', () => {
    expect(titleWithDirty('Koine Studio', 0)).toBe('Koine Studio');
  });

  test('does not double-prefix an already-marked title', () => {
    expect(titleWithDirty('• Koine Studio', 2)).toBe('• Koine Studio');
    expect(titleWithDirty('• Koine Studio', 0)).toBe('Koine Studio');
  });
});

describe('handleBeforeUnload', () => {
  function fakeEvent() {
    return {
      prevented: false,
      returnValue: undefined as unknown,
      preventDefault() {
        this.prevented = true;
      },
    };
  }

  test('blocks the unload and sets returnValue when there is unsaved work', () => {
    const e = fakeEvent();
    const blocked = handleBeforeUnload(e, () => true);
    expect(blocked).toBe(true);
    expect(e.prevented).toBe(true);
    expect(e.returnValue).toBeTruthy();
  });

  test('is a no-op when nothing is dirty', () => {
    const e = fakeEvent();
    const blocked = handleBeforeUnload(e, () => false);
    expect(blocked).toBe(false);
    expect(e.prevented).toBe(false);
    expect(e.returnValue).toBeUndefined();
  });
});
