// Panel-level checks for the Spotlight launcher's overlay SHELL (issue #1143, task 3): the scrim +
// card + input row + prefix-mode pill. Results (Task 4), preview (Task 5), actions (Task 6), and full
// keyboard nav (Task 7) are exercised by later tasks' own test files — this file only covers what this
// task builds. Mirrors src/shell/searchController.test.tsx: mount the real component with fake seams.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { LauncherPanel } from '@/launcher/LauncherPanel';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { Command } from '@atypical/koine-ui';

afterEach(() => cleanup());

function makeSources(over: Partial<LauncherSources> = {}): LauncherSources {
  return {
    modelIndex: vi.fn(async () => ({ glossary: { entries: [] }, byQn: new Map(), qnByCtxName: new Map() })),
    commands: vi.fn((): Command[] => []),
    files: vi.fn(() => []),
    gitLog: vi.fn(() => null),
    canUseGit: false,
    glossary: vi.fn(() => []),
    ...over,
  };
}

function mount(sources: LauncherSources, onClose = vi.fn()) {
  return render(<LauncherPanel sources={sources} visible={true} onClose={onClose} />);
}

describe('LauncherPanel', () => {
  test('renders the scrim overlay, visible, and focuses the search input', async () => {
    const view = mount(makeSources());

    const scrim = view.container.querySelector('.lx-scrim');
    expect(scrim).toBeTruthy();
    expect((scrim as HTMLElement).hidden).toBe(false);
    expect(scrim!.getAttribute('role')).toBe('dialog');
    expect(scrim!.getAttribute('aria-modal')).toBe('true');
    expect(scrim!.getAttribute('aria-label')).toBe('Command launcher');

    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    expect(input).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  test('hides the scrim (hidden attribute) when not visible', () => {
    const view = render(<LauncherPanel sources={makeSources()} visible={false} onClose={vi.fn()} />);
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;
    expect(scrim.hidden).toBe(true);
  });

  test('typing a prefix char switches mode and strips it from the effective query', () => {
    const view = mount(makeSources());
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;

    fireEvent.input(input, { target: { value: '@Or' } });

    const pill = view.container.querySelector('.lx-modepill');
    expect(pill).toBeTruthy();
    expect(pill!.textContent).toContain('Symbols');

    const results = view.container.querySelector('.lx-results');
    expect(results).toBeTruthy();
    expect(results!.getAttribute('data-mode')).toBe('@');
    expect(results!.getAttribute('data-query')).toBe('Or');
  });

  test('no mode pill and the raw input is the query when there is no recognized prefix', () => {
    const view = mount(makeSources());
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'aggregate' } });

    expect(view.container.querySelector('.lx-modepill')).toBeNull();
    const results = view.container.querySelector('.lx-results')!;
    expect(results.getAttribute('data-mode')).toBe('all');
    expect(results.getAttribute('data-query')).toBe('aggregate');
  });

  test('clicking the mode pill clear button removes the mode prefix from the input', () => {
    const view = mount(makeSources());
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '@Or' } });
    expect(view.container.querySelector('.lx-modepill')).toBeTruthy();

    fireEvent.click(view.getByLabelText('Clear mode'));

    expect(view.container.querySelector('.lx-modepill')).toBeNull();
    expect(input.value).toBe('Or');
    expect(input.value.startsWith('@')).toBe(false);
  });

  test('Escape calls onClose', () => {
    const onClose = vi.fn();
    const view = mount(makeSources(), onClose);
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('loads the live catalog once on open and reflects its length in the result count', async () => {
    const sources = makeSources({
      commands: () => [{ id: 'cmd:new-file', title: 'New file', run: () => {} }],
    });
    const view = mount(sources);

    await waitFor(() => expect(view.container.querySelector('.lx-count')!.textContent).toBe('1'));
    expect(sources.modelIndex).toHaveBeenCalledTimes(1);
  });
});
