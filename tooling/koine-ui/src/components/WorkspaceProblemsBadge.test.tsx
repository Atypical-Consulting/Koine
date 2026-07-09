import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { WorkspaceProblemsBadge, type WorkspaceProblemsSlice } from './WorkspaceProblemsBadge';
import type { ReadableStore } from '../host/store';

// A plain ReadableStore<WorkspaceProblemsSlice> test double — koine-ui is store-free, so this mocks the
// contract directly instead of pulling in koine-studio's real Zustand store + diagnosticsSummary (which
// the ORIGINAL koine-studio-side test exercised via createAppStore() + setDiagnostics()). The host
// adapter (readableStoreAdapter.test.ts) covers the classification wiring separately.
function createMockProblemsStore(
  initial: WorkspaceProblemsSlice,
): ReadableStore<WorkspaceProblemsSlice> & { set(next: WorkspaceProblemsSlice): void } {
  let state = initial;
  const listeners = new Set<(state: WorkspaceProblemsSlice) => void>();
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

const badge = (c: Element) => c.querySelector('[data-role="workspace-problems"]');

describe('WorkspaceProblemsBadge', () => {
  test('renders nothing when the whole workspace is clean', () => {
    const store = createMockProblemsStore({ errors: 0, warnings: 0, fileCount: 0 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);
    expect(badge(container)).toBeNull();
  });

  test('summarises errors/warnings across ALL files and counts the affected files', () => {
    const store = createMockProblemsStore({ errors: 0, warnings: 0, fileCount: 0 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);

    act(() => store.set({ errors: 1, warnings: 1, fileCount: 2 }));

    const el = badge(container)!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('data-kind')).toBe('error'); // any error ⇒ error kind
    expect(el.textContent).toContain('1 error');
    expect(el.textContent).toContain('1 warning');
    expect(el.textContent).toContain('in 2 files');
  });

  test('uses the singular "file" for a single affected file, and clears when diagnostics go away', () => {
    const store = createMockProblemsStore({ errors: 0, warnings: 0, fileCount: 0 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);

    act(() => store.set({ errors: 0, warnings: 2, fileCount: 1 }));
    const el = badge(container)!;
    expect(el.getAttribute('data-kind')).toBe('warn');
    expect(el.textContent).toContain('2 warnings');
    expect(el.textContent).toContain('in 1 file');

    act(() => store.set({ errors: 0, warnings: 0, fileCount: 0 }));
    expect(badge(container)).toBeNull();
  });

  test('has no accessibility violations', async () => {
    const store = createMockProblemsStore({ errors: 1, warnings: 1, fileCount: 1 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
