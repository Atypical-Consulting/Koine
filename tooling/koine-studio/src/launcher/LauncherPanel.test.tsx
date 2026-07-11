// Panel-level checks for the Spotlight launcher's overlay SHELL (issue #1143, task 3): the scrim +
// card + input row + prefix-mode pill. Results (Task 4) and preview (Task 5) get their own describe
// blocks below; quick actions (Task 6) are covered further down (the action menu + default-run
// wiring); full keyboard nav (Task 7) is still not exercised here. Mirrors
// src/shell/searchController.test.tsx: mount the real component with fake seams.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { LauncherPanel } from '@/launcher/LauncherPanel';
import type { LauncherActionDeps } from '@/launcher/actions';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { CatalogEntry } from '@/launcher/catalog';
import { registerOverlay } from '@atypical/koine-ui';
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

/** A no-op stub for the quick-action effect seam (issue #1143, task 6) — Task 8 binds the real thing. */
function makeActionDeps(over: Partial<LauncherActionDeps> = {}): LauncherActionDeps {
  return {
    gotoDefinition: vi.fn(),
    findUsages: vi.fn(),
    peek: vi.fn(),
    rename: vi.fn(),
    copy: vi.fn(),
    openFile: vi.fn(),
    openFileChanges: vi.fn(),
    revealFile: vi.fn(),
    openGlossary: vi.fn(),
    findInModel: vi.fn(),
    gotoRule: vi.fn(),
    viewCommit: vi.fn(),
    revertCommit: vi.fn(),
    runCommand: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
}

function mount(sources: LauncherSources, onClose = vi.fn(), actionDeps: LauncherActionDeps = makeActionDeps()) {
  return render(<LauncherPanel sources={sources} visible={true} onClose={onClose} actionDeps={actionDeps} />);
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
    const view = render(<LauncherPanel sources={makeSources()} visible={false} onClose={vi.fn()} actionDeps={makeActionDeps()} />);
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

  test('clearing the mode also drops a single following space so "@ Order" becomes "Order" (#1145)', () => {
    const view = mount(makeSources());
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '@ Order' } });
    expect(view.container.querySelector('.lx-modepill')).toBeTruthy();

    fireEvent.click(view.getByLabelText('Clear mode'));

    expect(input.value).toBe('Order');
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

  // #1276: on desktop, a rejected source join (e.g. buildCatalog's own commitEntries somehow still
  // throwing, or any future source added the same way) must not leave the launcher stuck showing
  // nothing forever with an unhandled rejection — it should settle on an empty, but responsive, catalog.
  test('degrades to an empty (not stuck) catalog when the source join rejects', async () => {
    const sources = makeSources({
      commands: () => [{ id: 'cmd:new-file', title: 'New file', run: () => {} }],
      modelIndex: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const view = mount(sources);

    await waitFor(() => expect(view.container.querySelector('.lx-count')!.textContent).toBe('0'));
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

  // A quick-look (issue #1165): `peek` pins ANY entry's preview into the pane through the shell handle,
  // WITHOUT navigating and WITHOUT moving the keyboard selection — the read-only counterpart to ↵.
  test('peek pins the given entry\'s preview without moving the selected row (#1165)', async () => {
    const sources = makeKnownCatalogSources();
    let peekFn: ((entry: CatalogEntry) => void) | null = null;
    const view = render(
      <LauncherPanel
        sources={sources}
        visible={true}
        onClose={vi.fn()}
        actionDeps={makeActionDeps()}
        onRegisterPeek={(fn) => {
          peekFn = fn;
        }}
      />,
    );
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    // The empty-query default selects + previews the Order aggregate.
    expect(view.container.querySelector('.lx-preview .pv-name')!.textContent).toBe('Order');

    // Peek a DIFFERENT entry (a glossary term): its preview is pinned into the pane…
    const peeked = { id: 'g:peeked', cat: 'glossary', title: 'Peeked Term' } as unknown as CatalogEntry;
    act(() => peekFn!(peeked));
    expect(view.container.querySelector('.lx-preview .pv-name')!.textContent).toBe('Peeked Term');

    // …while the keyboard selection is untouched (Order is still the selected row).
    const selectedRow = view.container.querySelector('.lx-item.sel') as HTMLElement;
    expect(selectedRow.textContent).toContain('Order');
  });
});

describe('LauncherPanel — quick actions + action menu + toast (issue #1143, task 6)', () => {
  test('clicking a result row runs its default quick action against the injected deps', async () => {
    const actionDeps = makeActionDeps();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, vi.fn(), actionDeps);

    // Empty-query "Top hits" lists the Order aggregate first (see the preview-pane describe above) —
    // its default action (index 0 of actionsFor) is "Go to definition".
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const row = view.container.querySelector('.lx-item') as HTMLElement;
    expect(row.textContent).toContain('Order');

    fireEvent.click(row);

    expect(actionDeps.gotoDefinition).toHaveBeenCalledTimes(1);
    const called = (actionDeps.gotoDefinition as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(called.qualifiedName).toBe('Ordering.Order');
  });

  test('the footer "⌘K actions" trigger opens the popover listing the selected result\'s actions', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

    expect(view.container.querySelector('.lx-actmenu')).toBeNull();
    const trigger = view.getByText('actions').closest('button') as HTMLButtonElement;

    fireEvent.click(trigger);

    const menu = view.container.querySelector('.lx-actmenu') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute('role')).toBe('menu');
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(Array.from(items).map((i) => i.textContent)).toEqual([
      'Go to definition↵', 'Find usages⇧↵', 'Peek⌥↵', 'Rename symbolF2', 'Copy name⌘C',
    ]);
    expect(items[0].className).toContain('sel');
  });

  test('the selected row\'s tail "Actions" button also opens the menu for that result', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

    const tailBtn = view.container.querySelector('.lx-item.sel .lx-actbtn') as HTMLButtonElement;
    expect(tailBtn).toBeTruthy();

    fireEvent.click(tailBtn);

    expect(view.container.querySelector('.lx-actmenu')).toBeTruthy();
  });

  test('clicking an action-menu row runs that action and closes the menu', async () => {
    const actionDeps = makeActionDeps();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, vi.fn(), actionDeps);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    fireEvent.click(view.getByText('actions').closest('button') as HTMLButtonElement);

    const items = view.container.querySelectorAll('.lx-actmenu [role="menuitem"]');
    fireEvent.click(items[1]); // "Find usages"

    expect(actionDeps.findUsages).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.lx-actmenu')).toBeNull();
  });

  test('Copy name shows a confirmation toast', async () => {
    const actionDeps = makeActionDeps();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, vi.fn(), actionDeps);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    fireEvent.click(view.getByText('actions').closest('button') as HTMLButtonElement);

    const items = view.container.querySelectorAll('.lx-actmenu [role="menuitem"]');
    fireEvent.click(items[4]); // "Copy name"

    await waitFor(() => expect(actionDeps.toast).toHaveBeenCalledTimes(1));
    const toast = view.container.querySelector('.lx-toast') as HTMLElement;
    expect(toast.className).toContain('show');
    expect(toast.textContent).toContain('Order');
  });

  test('Escape closes the action menu without closing the whole launcher', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, onClose);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    fireEvent.click(view.getByText('actions').closest('button') as HTMLButtonElement);
    expect(view.container.querySelector('.lx-actmenu')).toBeTruthy();

    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;
    fireEvent.keyDown(scrim, { key: 'Escape' });

    expect(view.container.querySelector('.lx-actmenu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('LauncherPanel — visible-but-disabled command rows (issue #1407)', () => {
  // open-folder / new-model flip from when() to enabled() while a workspace-open op is busy
  // (commandWiring.ts, #1407 Task 3): they stay in the catalog (when()/isEnabled is unaffected) but
  // must render as visible-but-disabled instead of a plain runnable row that silently no-ops. This
  // stands in for either real command, gated on the same `enabled()` axis.
  function gatedCommand(isBusy: () => boolean, run: () => void = vi.fn()): Command {
    return { id: 'open-folder', title: 'Open folder…', hint: '⌘⇧O', group: 'File', run, enabled: () => !isBusy() };
  }

  // Switches the launcher into `>` (Commands) mode so the single injected command is the only
  // rendered row — the curated empty-query default set never includes commands (defaults.ts).
  async function mountInCommandsMode(commands: Command[], actionDeps: LauncherActionDeps = makeActionDeps()) {
    const sources = makeSources({ commands: () => commands });
    const view = mount(sources, vi.fn(), actionDeps);
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '>' } });
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    return view;
  }

  test('a busy-gated command row renders with the disabled class and aria-disabled', async () => {
    const view = await mountInCommandsMode([gatedCommand(() => true)]);
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    expect(row.textContent).toContain('Open folder');
    expect(row.classList.contains('lx-item--disabled')).toBe(true);
    expect(row.getAttribute('aria-disabled')).toBe('true');
  });

  test('the same command renders with no disabled marker once the op is no longer busy', async () => {
    const view = await mountInCommandsMode([gatedCommand(() => false)]);
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    expect(row.classList.contains('lx-item--disabled')).toBe(false);
    expect(row.hasAttribute('aria-disabled')).toBe(false);
  });

  test('a command with no enabled() field at all renders with no disabled marker (unaffected by this axis)', async () => {
    const plain: Command = { id: 'search', title: 'Search across files…', run: vi.fn() };
    const view = await mountInCommandsMode([plain]);
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    expect(row.classList.contains('lx-item--disabled')).toBe(false);
    expect(row.hasAttribute('aria-disabled')).toBe(false);
  });

  test('clicking a busy-gated command row does not run it', async () => {
    const runCommand = vi.fn();
    const view = await mountInCommandsMode([gatedCommand(() => true)], makeActionDeps({ runCommand }));
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    fireEvent.click(row);

    expect(runCommand).not.toHaveBeenCalled();
  });

  test('selecting a busy-gated command row and pressing Enter does not run it', async () => {
    const runCommand = vi.fn();
    const view = await mountInCommandsMode([gatedCommand(() => true)], makeActionDeps({ runCommand }));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'Enter' });

    expect(runCommand).not.toHaveBeenCalled();
  });

  test('the row\'s "⌘K actions" quick-action trigger is suppressed for a disabled row (its only action is the gated Run)', async () => {
    const view = await mountInCommandsMode([gatedCommand(() => true)]);
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    expect(row.querySelector('.lx-actbtn')).toBeNull();
  });

  test('an enabled row still shows its "⌘K actions" trigger once selected', async () => {
    const view = await mountInCommandsMode([gatedCommand(() => false)]);
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    expect(row.querySelector('.lx-actbtn')).not.toBeNull();
  });

  test('re-evaluates enabled() fresh at click time rather than a stale catalog-build snapshot', async () => {
    let busy = true;
    const runCommand = vi.fn();
    const view = await mountInCommandsMode([gatedCommand(() => busy)], makeActionDeps({ runCommand }));
    const row = view.container.querySelector('.lx-item') as HTMLElement;

    fireEvent.click(row);
    expect(runCommand).not.toHaveBeenCalled();

    busy = false; // the workspace op finishes while the launcher is still open — no re-open needed
    fireEvent.click(row);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe('LauncherPanel — keyboard model (issue #1143, task 7)', () => {
  test('ArrowDown moves the .sel row forward and wraps at the end', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    // The curated empty-query default is [Order, Money, commit] (see the preview-pane describe above).
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item')).toHaveLength(3));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'ArrowDown' });
    let items = view.container.querySelectorAll('.lx-item');
    expect(items[1].className).toContain('sel');
    expect(items[1].textContent).toContain('Money');

    fireEvent.keyDown(scrim, { key: 'ArrowDown' });
    items = view.container.querySelectorAll('.lx-item');
    expect(items[2].className).toContain('sel');

    fireEvent.keyDown(scrim, { key: 'ArrowDown' }); // wraps past the last row back to the top
    items = view.container.querySelectorAll('.lx-item');
    expect(items[0].className).toContain('sel');
    expect(items[0].textContent).toContain('Order');
  });

  test('ArrowUp from the top row wraps to the last row', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item')).toHaveLength(3));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'ArrowUp' });

    const items = view.container.querySelectorAll('.lx-item');
    expect(items[2].className).toContain('sel');
  });

  test('Tab fills the input with the mode-prefixed selected title', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    await waitFor(() => expect(sources.modelIndex).toHaveBeenCalled());

    fireEvent.input(input, { target: { value: '@Or' } });
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'Tab' });

    expect(input.value).toBe('@Order');
  });

  test('Escape clears a non-empty query before closing the launcher', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, onClose);
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Order' } });
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(scrim, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Cmd+K opens the quick-actions menu for the selected result', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;
    expect(view.container.querySelector('.lx-actmenu')).toBeNull();

    fireEvent.keyDown(scrim, { key: 'k', metaKey: true });

    expect(view.container.querySelector('.lx-actmenu')).toBeTruthy();
  });

  test('in the action menu, ArrowDown moves the selection and Enter runs it against the injected deps', async () => {
    const actionDeps = makeActionDeps();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, vi.fn(), actionDeps);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'k', metaKey: true }); // open the menu for the selected "Order" symbol
    fireEvent.keyDown(scrim, { key: 'ArrowDown' }); // Go to definition -> Find usages
    fireEvent.keyDown(scrim, { key: 'Enter' });

    expect(actionDeps.findUsages).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.lx-actmenu')).toBeNull();
  });

  test('mouse-move over a row selects it', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item')).toHaveLength(3));

    const items = view.container.querySelectorAll('.lx-item');
    expect(items[0].className).toContain('sel');

    fireEvent.mouseMove(items[1]);

    const after = view.container.querySelectorAll('.lx-item');
    expect(after[1].className).toContain('sel');
    expect(after[0].className).not.toContain('sel');
  });

  test('traps keydowns while open: a bubbling ⌘K / ⌘S from inside the scrim never reaches the window (#1145)', async () => {
    // The shell's GLOBAL chords listen on `window`; while the launcher is open it must own its keys so
    // ⌘K/⌘S/⌘Z don't toggle the palette or act on the editor beneath. The existing tests dispatch on the
    // scrim directly and so miss this — here we dispatch a REAL bubbling event from the focused input and
    // assert it's stopped before it reaches a window listener.
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

    const windowSpy = vi.fn();
    window.addEventListener('keydown', windowSpy);
    try {
      const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
      expect(windowSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowSpy);
    }
  });

  test('aria-activedescendant on the input tracks the selected result row (#1145 a11y)', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item')).toHaveLength(3));
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;

    const first = view.container.querySelector('.lx-item.sel') as HTMLElement;
    expect(first.id).toBeTruthy();
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id);

    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;
    fireEvent.keyDown(scrim, { key: 'ArrowDown' });

    const next = view.container.querySelector('.lx-item.sel') as HTMLElement;
    expect(next.id).not.toBe(first.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(next.id);
  });

  test('the action menu drives its active item via aria-activedescendant, not aria-selected on menuitems (#1145 a11y)', async () => {
    const sources = makeKnownCatalogSources();
    const view = mount(sources);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const scrim = view.container.querySelector('.lx-scrim') as HTMLElement;

    fireEvent.keyDown(scrim, { key: 'k', metaKey: true }); // open the actions menu

    const menu = view.container.querySelector('.lx-actmenu') as HTMLElement;
    expect(menu.getAttribute('aria-activedescendant')).toBe('lx-act-0');
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items[0].id).toBe('lx-act-0');
    expect(items[0].hasAttribute('aria-selected')).toBe(false); // wrong pairing for role="menuitem"

    fireEvent.keyDown(scrim, { key: 'ArrowDown' });

    expect((view.container.querySelector('.lx-actmenu') as HTMLElement).getAttribute('aria-activedescendant')).toBe('lx-act-1');
  });
});

describe('LauncherPanel — shared Esc-stack (issue #1164)', () => {
  /** Dispatch an Escape straight at `document` — the path koine-ui's single shared Esc handler
   * (`overlay.ts`, registered at import) listens on. It never traverses the `.lx-scrim`, so the
   * panel's own `onKeyDown` can't intercept it: only a launcher layer that registered on the shared
   * stack via `registerOverlay` can act on it. That's what makes this a clean probe of the
   * registration itself, independent of the scrim's keydown trap. */
  function documentEscape(): void {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
  }

  test('registers a launcher-level dismiss on the shared stack: a document Escape clears a non-empty query, else closes', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, onClose);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Order' } });

    // First document Escape peels the launcher layer's dismiss: a non-empty query clears first.
    documentEscape();
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();

    // Second document Escape, query now empty → the same dismiss closes the launcher.
    documentEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('unregisters from the shared stack on hide, so a later document Escape is inert', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();
    const view = render(<LauncherPanel sources={sources} visible={true} onClose={onClose} actionDeps={makeActionDeps()} />);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

    // Hide the launcher (visible → false): its cleanup must leave the shared stack.
    view.rerender(<LauncherPanel sources={sources} visible={false} onClose={onClose} actionDeps={makeActionDeps()} />);

    documentEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('nests the action menu above the launcher: a bubbling Escape peels menu → launcher via the shared stack', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, onClose);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;

    // Open the action menu (⌘K) — this pushes a menu layer ON TOP of the launcher layer.
    fireEvent.keyDown(input, { key: 'k', metaKey: true });
    expect(view.container.querySelector('.lx-actmenu')).toBeTruthy();

    // A document listener proves the Escape now BUBBLES past the scrim to the shared handler, rather
    // than being trapped by the panel's stopPropagation and dismissed by the reducer.
    const docEsc = vi.fn();
    document.addEventListener('keydown', docEsc);
    try {
      // First bubbling Escape from the focused input: the topmost layer (the menu) closes, launcher stays.
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(docEsc).toHaveBeenCalledTimes(1); // reached the shared document handler (stopPropagation narrowed)
      expect(view.container.querySelector('.lx-actmenu')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      // Second bubbling Escape: the menu layer is gone, so the launcher layer is topmost → it closes.
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', docEsc);
    }
  });

  test('an Escape from a focused menuitem closes just the menu via the shared stack, not any handler on .lx-actmenu', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();
    const view = mount(sources, onClose);
    await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
    fireEvent.click(view.getByText('actions').closest('button') as HTMLButtonElement);
    expect(view.container.querySelector('.lx-actmenu')).toBeTruthy();

    // The ONE path that could ever reach `ActionMenu`'s own keydown handler: focus lands on a
    // `.lx-actitem` (role="menuitem", tabIndex=0) rather than the search input. A bubbling Escape from
    // there must still dismiss the menu through the shared Esc-stack — menuitem → `.lx-actmenu` → the
    // scrim (which lets Escape through since #1164) → document → the topmost (menu) layer — so the
    // shared stack, NOT any handler bound on `.lx-actmenu`, is what closes it. Menu closes; the launcher
    // beneath stays open. (Passes both before and after the handler removal — the characterization the
    // removal must preserve.)
    const menuitem = view.container.querySelector('.lx-actmenu [role="menuitem"]') as HTMLElement;
    menuitem.focus();
    fireEvent.keyDown(menuitem, { key: 'Escape' });

    expect(view.container.querySelector('.lx-actmenu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('hiding the launcher while the menu is open pops BOTH layers — no stale close-fn leaks onto the stack', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();

    // Simulate an unrelated overlay already open BENEATH the launcher: it must be the one a later Escape
    // dismisses, proving no leaked launcher/menu layer sits above it after the launcher hides.
    const unrelated = vi.fn();
    const unregisterUnrelated = registerOverlay(unrelated);
    try {
      const view = render(<LauncherPanel sources={sources} visible={true} onClose={onClose} actionDeps={makeActionDeps()} />);
      await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
      const input = view.getByLabelText('Search commands, symbols, files…') as HTMLInputElement;

      // Open the action menu (pushes launcher + menu layers above `unrelated`), then hide the launcher
      // WITHOUT pressing Escape — mirrors createLauncher.close() flipping `visible` false.
      fireEvent.keyDown(input, { key: 'k', metaKey: true });
      expect(view.container.querySelector('.lx-actmenu')).toBeTruthy();
      view.rerender(<LauncherPanel sources={sources} visible={false} onClose={onClose} actionDeps={makeActionDeps()} />);
      // Both effect cleanups must run: the menu layer pops once `visible`'s reset flips `menuOpen` false.
      await waitFor(() => expect(view.container.querySelector('.lx-actmenu')).toBeNull());

      // One document Escape: with both launcher layers popped, `unrelated` is topmost and handles it.
      // A leaked launcher/menu layer would sit above `unrelated` and swallow this Escape instead.
      documentEscape();
      expect(unrelated).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      unregisterUnrelated();
    }
  });

  test('layered above another overlay, the launcher dismisses first — the overlay beneath is untouched', async () => {
    const onClose = vi.fn();
    const sources = makeKnownCatalogSources();

    // An unrelated overlay is already open BENEATH the launcher (the whole point of #1164: correct
    // depth ordering when the launcher coexists with another overlay).
    const beneath = vi.fn();
    const unregisterBeneath = registerOverlay(beneath);
    try {
      const view = mount(sources, onClose);
      await waitFor(() => expect(view.container.querySelectorAll('.lx-item').length).toBeGreaterThan(0));

      // The launcher registered ON TOP of `beneath`, so an Escape (empty query) dismisses the launcher
      // layer — the topmost — while the overlay beneath keeps its place on the stack, unfired.
      documentEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(beneath).not.toHaveBeenCalled();
    } finally {
      unregisterBeneath();
    }
  });
});
