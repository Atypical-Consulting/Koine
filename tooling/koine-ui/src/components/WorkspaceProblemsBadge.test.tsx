import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { WorkspaceProblemsBadge, type WorkspaceProblemsSlice } from './WorkspaceProblemsBadge';
import { createTestReadableStore } from '../host/storeTestUtils';

// The shared ReadableStore<T> test double (host/storeTestUtils) — koine-ui is store-free, so it mocks
// the contract directly instead of pulling in koine-studio's real Zustand store + diagnosticsSummary
// (which the ORIGINAL koine-studio-side test exercised via createAppStore() + setDiagnostics()). The
// host adapter (readableStores.test.ts) covers the classification/formatting wiring separately.

const badge = (c: Element) => c.querySelector('[data-role="workspace-problems"]');

describe('WorkspaceProblemsBadge', () => {
  test('renders nothing when the whole workspace is clean', () => {
    const store = createTestReadableStore<WorkspaceProblemsSlice>({ kind: 'clean', parts: [], fileCount: 0 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);
    expect(badge(container)).toBeNull();
  });

  test('renders the host-provided kind/parts across ALL files and the affected-file count', () => {
    const store = createTestReadableStore<WorkspaceProblemsSlice>({ kind: 'clean', parts: [], fileCount: 0 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);

    act(() => store.set({ kind: 'error', parts: ['1 error', '1 warning'], fileCount: 2 }));

    const el = badge(container)!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('data-kind')).toBe('error'); // any error ⇒ error kind
    expect(el.textContent).toContain('1 error');
    expect(el.textContent).toContain('1 warning');
    expect(el.textContent).toContain('in 2 files');
  });

  test('uses the singular "file" for a single affected file, and clears when diagnostics go away', () => {
    const store = createTestReadableStore<WorkspaceProblemsSlice>({ kind: 'clean', parts: [], fileCount: 0 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);

    act(() => store.set({ kind: 'warn', parts: ['2 warnings'], fileCount: 1 }));
    const el = badge(container)!;
    expect(el.getAttribute('data-kind')).toBe('warn');
    expect(el.textContent).toContain('2 warnings');
    expect(el.textContent).toContain('in 1 file');

    act(() => store.set({ kind: 'clean', parts: [], fileCount: 0 }));
    expect(badge(container)).toBeNull();
  });

  test('has no accessibility violations', async () => {
    const store = createTestReadableStore<WorkspaceProblemsSlice>({ kind: 'error', parts: ['1 error', '1 warning'], fileCount: 1 });
    const { container } = render(<WorkspaceProblemsBadge store={store} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
