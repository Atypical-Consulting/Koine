// Panel-level checks for the Spotlight launcher's overlay SHELL (issue #1143, task 3): the scrim +
// card + input row + prefix-mode pill. Results (Task 4), preview (Task 5), actions (Task 6), and full
// keyboard nav (Task 7) are exercised by later tasks' own test files — this file only covers what this
// task builds. Mirrors src/shell/searchController.test.tsx: mount the real component with fake seams.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { LauncherPanel } from '@/launcher/LauncherPanel';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { Command } from '@atypical/koine-ui';
import type { ModelIndex } from '@/model/modelIndex';
import type { GlossaryEntry } from '@/lsp/lsp';

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

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

/**
 * A known, small live catalog for the grouped-results tests below: an aggregate + a value-object
 * symbol, a domain event, a workspace file, a registry command, and a git commit — one entry per
 * `GROUPS` category the fixture bothers to populate. Commit/keyword text is chosen so a query of
 * "Order" matches only the symbol/event/file rows (not the command or the commit), keeping the
 * group-order assertions unambiguous.
 */
function makeKnownCatalogSources(): LauncherSources {
  const orderAgg: GlossaryEntry = {
    id: 'Ordering.Order', name: 'Order', kind: 'aggregate', context: 'Ordering',
    qualifiedName: 'Ordering.Order', doc: null, nameRange: RANGE,
  };
  const moneyVo: GlossaryEntry = {
    id: 'Ordering.Money', name: 'Money', kind: 'quantity', context: 'Ordering',
    qualifiedName: 'Ordering.Money', doc: null, nameRange: RANGE,
  };
  const placedEvent: GlossaryEntry = {
    id: 'Ordering.OrderPlaced', name: 'OrderPlaced', kind: 'event', context: 'Ordering',
    qualifiedName: 'Ordering.OrderPlaced', doc: null, nameRange: RANGE,
  };
  const modelIndex: ModelIndex = {
    glossary: { entries: [orderAgg, moneyVo, placedEvent] },
    byQn: new Map([
      [orderAgg.qualifiedName, { entry: orderAgg }],
      [moneyVo.qualifiedName, { entry: moneyVo }],
      [placedEvent.qualifiedName, { entry: placedEvent }],
    ]),
    qnByCtxName: new Map(),
  };

  return makeSources({
    modelIndex: vi.fn(async () => modelIndex),
    commands: vi.fn((): Command[] => [{ id: 'cmd:new-file', title: 'New file', run: () => {} }]),
    files: vi.fn(() => [{ uri: 'file:///ws/src/Ordering/ordering.koi', relPath: 'src/Ordering/ordering.koi' }]),
    gitLog: vi.fn(() =>
      Promise.resolve([{ sha: 'abc1234567890', author: 'Ada Lovelace', date: '2026-07-01T10:00:00Z', message: 'chore: initial commit' }]),
    ),
    canUseGit: true,
  });
}

function groupLabels(container: ParentNode): (string | null)[] {
  return Array.from(container.querySelectorAll('.lx-group-label')).map((el) => {
    const text = el.textContent ?? '';
    return text.replace(/\d+$/, '').trim();
  });
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

describe('LauncherPanel — grouped results (issue #1143, task 4)', () => {
  test('empty query shows the curated Top hits / Recent default set, not the full catalog', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);

    // The full live catalog has 6 entries (1 command, 2 symbols, 1 event, 1 file, 1 commit) but the
    // curated empty-query view only ever shows the Top-hits symbols + Recent commits/files slices.
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

    const labels = groupLabels(view.container);
    expect(labels).toEqual(['Top hits', 'Recent']);
    expect(view.container.querySelectorAll('.lx-item')).toHaveLength(3); // 2 symbols + 1 commit
  });

  test('typing a symbol name filters + groups results under the GROUPS headers in order', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(sources.modelIndex).toHaveBeenCalled());
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'Order' } });

    await waitFor(() => expect(groupLabels(view.container).length).toBeGreaterThan(0));
    // "Order" fuzzy-matches the Order aggregate, the OrderPlaced event, and ordering.koi's filename —
    // but neither "New file" (the command) nor "chore: initial commit" (the commit) contain the
    // subsequence o-r-d-e-r, so those two groups are absent — GROUPS order: symbol, event, file.
    expect(groupLabels(view.container)).toEqual(['Domain symbols', 'Events', 'Files']);
  });

  test('a symbol row shows a .lx-kind chip colored by its DDD token, with <mark> highlights in the title', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    await waitFor(() => expect(sources.modelIndex).toHaveBeenCalled());

    fireEvent.input(input, { target: { value: 'Order' } });

    await waitFor(() => expect(view.container.querySelector('.lx-kind')).toBeTruthy());
    const chip = view.container.querySelector('.lx-kind') as HTMLElement;
    expect(chip.textContent).toBe('AR');
    expect(chip.getAttribute('style')).toContain('--kc');
    expect(chip.getAttribute('style')).toContain('var(--koi-ddd-aggregate)');

    const row = chip.closest('.lx-item') as HTMLElement;
    const marks = row.querySelectorAll('.lx-title mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(Array.from(marks).map((m) => m.textContent).join('')).toBe('Order');
  });

  test('#-mode input shows only the Events group', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    await waitFor(() => expect(sources.modelIndex).toHaveBeenCalled());

    fireEvent.input(input, { target: { value: '#Order' } });

    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    expect(groupLabels(view.container)).toEqual(['Events']);
    expect(view.container.querySelector('.lx-item')!.textContent).toContain('OrderPlaced');
  });
});

describe('LauncherPanel — live preview pane (issue #1143, task 5)', () => {
  test('has no .has-preview class before the live catalog has loaded (no results yet)', () => {
    const view = mount(makeSources());
    const card = view.container.querySelector('.lx') as HTMLElement;
    expect(card.className).not.toContain('has-preview');
    expect(view.container.querySelector('.lx-preview')!.textContent).toBe('');
  });

  test('adds .has-preview and renders the first visible result\'s preview + marks its row selected', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);

    // The curated empty-query default's "Top hits" lists symbols in catalog order — Order (the
    // aggregate) comes before Money — so the FIRST visible row (today's stand-in "selection", Task 7
    // supplies real ↑/↓ state) is the Order aggregate.
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

    const card = view.container.querySelector('.lx') as HTMLElement;
    expect(card.className).toContain('has-preview');

    const preview = view.container.querySelector('.lx-preview') as HTMLElement;
    expect(preview.querySelector('.pv-name')!.textContent).toBe('Order');
    const chip = preview.querySelector('.pv-head .lx-kind') as HTMLElement;
    expect(chip.textContent).toBe('AR');
    expect(preview.querySelector('.pv-grid')).toBeTruthy();

    const selectedRow = view.container.querySelector('.lx-item.sel') as HTMLElement;
    expect(selectedRow.textContent).toContain('Order');
    expect(view.container.querySelectorAll('.lx-item.sel')).toHaveLength(1);
  });
});
