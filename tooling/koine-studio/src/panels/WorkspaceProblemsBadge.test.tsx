import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { WorkspaceProblemsBadge } from '@/panels/WorkspaceProblemsBadge';
import type { LspDiagnostic } from '@/lsp/lsp';

const err = (msg: string): LspDiagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: msg,
  severity: 1,
});
const warn = (msg: string): LspDiagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: msg,
  severity: 2,
});

const badge = (c: Element) => c.querySelector('[data-role="workspace-problems"]');

describe('WorkspaceProblemsBadge', () => {
  test('renders nothing when the whole workspace is clean', () => {
    const store = createAppStore();
    const { container } = render(<WorkspaceProblemsBadge store={store} />);
    expect(badge(container)).toBeNull();
  });

  test('summarises errors/warnings across ALL files and counts the affected files', () => {
    const store = createAppStore();
    const { container } = render(<WorkspaceProblemsBadge store={store} />);

    // Two files each get a diagnostic — the rollup spans both, not just the active one.
    act(() => store.getState().setDiagnostics('file:///a.koi', [err('boom')]));
    act(() => store.getState().setDiagnostics('file:///b.koi', [warn('careful')]));

    const el = badge(container)!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('data-kind')).toBe('error'); // any error ⇒ error kind
    expect(el.textContent).toContain('1 error');
    expect(el.textContent).toContain('1 warning');
    expect(el.textContent).toContain('in 2 files');
  });

  test('uses the singular "file" for a single affected file, and clears when diagnostics go away', () => {
    const store = createAppStore();
    const { container } = render(<WorkspaceProblemsBadge store={store} />);

    act(() => store.getState().setDiagnostics('file:///a.koi', [warn('x'), warn('y')]));
    const el = badge(container)!;
    expect(el.getAttribute('data-kind')).toBe('warn');
    expect(el.textContent).toContain('2 warnings');
    expect(el.textContent).toContain('in 1 file');

    // Clearing the file's diagnostics removes the badge entirely.
    act(() => store.getState().setDiagnostics('file:///a.koi', []));
    expect(badge(container)).toBeNull();
  });
});
