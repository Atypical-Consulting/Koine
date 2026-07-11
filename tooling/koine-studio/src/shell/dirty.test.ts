import { describe, expect, test } from 'vitest';
import { handleBeforeUnload } from '@/shell/dirty';

// (`titleWithDirty`'s tests moved to @atypical/koine-ui with the function — see
// koine-ui/src/components/UnsavedIndicator.test.tsx, #1244.)

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
