import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { titleWithDirty, UnsavedIndicator, type UnsavedIndicatorSlice } from './UnsavedIndicator';
import type { ReadableStore } from '../host/store';

// A plain ReadableStore<UnsavedIndicatorSlice> test double — koine-ui is store-free, so this mocks the
// contract directly instead of pulling in koine-studio's real Zustand store (which the ORIGINAL
// koine-studio-side test used via createAppStore() + a seeded buffer Map). The dirty-count derivation
// from the buffer set is the host adapter's job, pinned in koine-studio's readableStores.test.ts.
function createMockUnsavedStore(initial: UnsavedIndicatorSlice): ReadableStore<UnsavedIndicatorSlice> & {
  set(next: UnsavedIndicatorSlice): void;
} {
  let state = initial;
  const listeners = new Set<(state: UnsavedIndicatorSlice) => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

// The static index.html host the indicator drives: a <button id="unsaved-indicator" hidden>.
function host(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'unsaved-indicator';
  b.className = 'unsaved-indicator';
  b.hidden = true;
  document.body.append(b);
  return b;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

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

describe('UnsavedIndicator', () => {
  test('shows the "N unsaved" pill for the dirty count and hides when all clean', () => {
    const button = host();
    const store = createMockUnsavedStore({ dirtyCount: 0 });
    document.title = 'Koine Studio';

    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={() => {}} />);
    });

    // No dirty buffers yet: the pill is hidden and the title is unmarked.
    expect(button.hidden).toBe(true);
    expect(button.textContent).toBe('');
    expect(document.title).toBe('Koine Studio');

    // Two dirty buffers: the pill shows "2 unsaved" and the title gains a bullet — SYNCHRONOUSLY with
    // the store change (the component drives the host via a direct subscription, not a re-render).
    store.set({ dirtyCount: 2 });
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('2 unsaved');
    expect(button.getAttribute('aria-label')).toBe('Save 2 unsaved files');
    expect(document.title).toBe('• Koine Studio');

    // A single dirty buffer uses the singular aria-label.
    store.set({ dirtyCount: 1 });
    expect(button.textContent).toBe('1 unsaved');
    expect(button.getAttribute('aria-label')).toBe('Save 1 unsaved file');

    // Everything clean again: the pill hides and the title is unmarked.
    store.set({ dirtyCount: 0 });
    expect(button.hidden).toBe(true);
    expect(button.textContent).toBe('');
    expect(document.title).toBe('Koine Studio');
  });

  test('clicking the pill calls onSaveAll', () => {
    const button = host();
    const store = createMockUnsavedStore({ dirtyCount: 1 });
    const onSaveAll = vi.fn();

    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={onSaveAll} />);
    });

    button.click();
    expect(onSaveAll).toHaveBeenCalledTimes(1);
  });

  test('has no accessibility violations', async () => {
    const button = host();
    const store = createMockUnsavedStore({ dirtyCount: 2 });
    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={() => {}} />);
    });
    expect(await axe(button)).toHaveNoViolations();
  });

  test('keeps a baseline aria-label even with no unsaved buffers (so the button is never label-less)', () => {
    const button = host();
    const store = createMockUnsavedStore({ dirtyCount: 0 });

    // Mount with zero dirty buffers: the pill is hidden, but the host button must still carry a
    // non-empty baseline aria-label. axe (storybook's a11y addon on macOS CI, #747) can otherwise race
    // the transient window where the static button is visible but the effect hasn't labelled it yet and
    // flag `button-name`; a baseline label means the button is never label-less.
    act(() => {
      render(<UnsavedIndicator store={store} host={button} baseTitle="Koine Studio" onSaveAll={() => {}} />);
    });

    expect(button.hidden).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Unsaved changes');
  });
});
