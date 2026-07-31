// Tests for ChangeSetPanel (#990 Task 3): the change-set review as a declarative consumer of the chat
// slice's `chat.changeSet` state machine (#984). The component must reproduce the imperative
// renderChangeSet DOM contract — the `koi-changeset*` classes, the labelled group, the polite
// role="status" live region, the per-file rows (accept checkbox / badge / path / line-diff), drift
// warnings (#473), the diagnostics block (#474), the reviewing-note retry shape (#633), and the two
// terminal treatments (Applied ✓, superseded) — while deriving EVERY control state from the slice and
// doing no async work itself (Apply/Discard delegate to the host callbacks).
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createAppStore, type AppState } from '@/store/index';
import type { StagedEdit } from '@/ai/editSession';
import type { StoreApi } from 'zustand/vanilla';
import { ChangeSetPanel } from '@/ai/components/ChangeSetPanel';

const staged: StagedEdit[] = [
  {
    key: 'ordering/order.koi',
    relPath: 'ordering/order.koi',
    body: 'context Ordering {\n  aggregate Order {}\n}',
    isNew: false,
  },
  { key: 'billing/invoice.koi', relPath: 'billing/invoice.koi', body: 'context Billing {}', isNew: true },
];
const before = { 'ordering/order.koi': 'context Ordering {\n}' };

/** A store whose chat slice holds the two-file staged set, still reviewing. */
function reviewingStore(diagnostics: string | null = null): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().stageChangeSet(staged, before, diagnostics);
  return store;
}

function mount(store: StoreApi<AppState>, handlers?: { onApply?: () => void; onDiscard?: () => void }) {
  return render(
    <ChangeSetPanel
      store={store}
      onApply={handlers?.onApply ?? (() => {})}
      onDiscard={handlers?.onDiscard ?? (() => {})}
    />,
  );
}

const panel = (c: Element) => c.querySelector('.koi-changeset') as HTMLElement | null;
const applyBtn = (c: Element) => c.querySelector('.koi-changeset-apply') as HTMLButtonElement;
const discardBtn = (c: Element) => c.querySelector('.koi-changeset-discard') as HTMLButtonElement | null;
const status = (c: Element) => c.querySelector('.koi-changeset-status') as HTMLElement;
const checkboxes = (c: Element) => [...c.querySelectorAll('.koi-changeset-accept')] as HTMLInputElement[];

describe('ChangeSetPanel (#990)', () => {
  test('renders nothing when chat.changeSet is null', () => {
    const { container } = mount(createAppStore());
    expect(panel(container)).toBeNull();
    expect(container.textContent).toBe('');
  });

  test('reviewing: labelled group, per-file rows with badge + path + diff, Apply counts the accepted files', () => {
    const { container } = mount(reviewingStore());

    const group = panel(container)!;
    expect(group).not.toBeNull();
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('2 proposed file changes');

    const rows = group.querySelectorAll('.koi-changeset-file');
    expect(rows.length).toBe(2);

    // Row 1: a modified file with its accept checkbox, badge, path and line diff.
    const first = rows[0];
    const check = first.querySelector('.koi-changeset-accept') as HTMLInputElement;
    expect(check.type).toBe('checkbox');
    expect(check.checked).toBe(true);
    expect(check.getAttribute('aria-label')).toBe('Accept changes to ordering/order.koi');
    expect(first.querySelector('.koi-changeset-badge-modified')!.textContent).toBe('modified');
    expect(first.querySelector('.koi-changeset-path')!.textContent).toBe('ordering/order.koi');
    const diff = first.querySelector('.koi-changeset-diff')!.textContent!;
    expect(diff).toContain('  context Ordering {'); // shared line
    expect(diff).toContain('+   aggregate Order {}'); // added line

    // Row 2: a brand-new file — every diff line is an addition.
    const second = rows[1];
    expect(second.querySelector('.koi-changeset-badge-new')!.textContent).toBe('new');
    expect(second.querySelector('.koi-changeset-diff')!.textContent).toBe('+ context Billing {}');

    // The live region exists and is polite even when empty.
    expect(status(container).getAttribute('role')).toBe('status');
    expect(status(container).getAttribute('aria-live')).toBe('polite');

    expect(applyBtn(container).textContent).toBe('Apply 2 files');
    expect(applyBtn(container).disabled).toBe(false);
    expect(discardBtn(container)!.textContent).toBe('Discard');
  });

  test('unchecking a row dispatches setChangeSetFileAccepted and the Apply label tracks the count', () => {
    const store = reviewingStore();
    const { container } = mount(store);

    fireEvent.click(checkboxes(container)[0]);
    expect(store.getState().chat.changeSet!.files[0].accepted).toBe(false);
    expect(applyBtn(container).textContent).toBe('Apply 1 file');
    expect(applyBtn(container).disabled).toBe(false);

    // Re-check flows back through the slice too.
    fireEvent.click(checkboxes(container)[0]);
    expect(store.getState().chat.changeSet!.files[0].accepted).toBe(true);
    expect(applyBtn(container).textContent).toBe('Apply 2 files');
  });

  test('Apply is disabled at zero accepted files', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    fireEvent.click(checkboxes(container)[0]);
    fireEvent.click(checkboxes(container)[1]);
    expect(applyBtn(container).textContent).toBe('Apply 0 files');
    expect(applyBtn(container).disabled).toBe(true);
  });

  test('Apply click hands the accepted files to onApply; Discard click calls onDiscard', () => {
    const store = reviewingStore();
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    const { container } = mount(store, { onApply, onDiscard });

    fireEvent.click(checkboxes(container)[1]); // drop the new file → only order.koi stays accepted
    fireEvent.click(applyBtn(container));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0][0].map((f: { relPath: string }) => f.relPath)).toEqual([
      'ordering/order.koi',
    ]);

    fireEvent.click(discardBtn(container)!);
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  test('applying: Apply stays label-tracked but disabled (no second concurrent apply), checkboxes stay live', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => store.getState().beginChangeSetApply(2));

    expect(applyBtn(container).textContent).toBe('Apply 2 files');
    expect(applyBtn(container).disabled).toBe(true);
    // The slice allows toggling mid-apply; the panel must not lock the checkboxes early.
    expect(checkboxes(container).every((cb) => !cb.disabled)).toBe(true);
  });

  // #1136: the live region derives ENTIRELY from `chat.changeSet.phase` — no host-owned `attempt`
  // side-channel. `beginChangeSetApply`'s `note` (the host's in-flight wording, e.g. a drift-skip
  // announcement) must render live while applying, before any settle.
  test('applying: the live region renders phase.note (#1136 — no attempt prop involved)', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() =>
      store
        .getState()
        .beginChangeSetApply(2, 'Applying 1 clean file. Skipped 1 that changed since it was proposed.'),
    );

    expect(status(container).textContent).toBe(
      'Applying 1 clean file. Skipped 1 that changed since it was proposed.',
    );
  });

  test('applied: the live region renders phase.note when the host supplied one, and the terminal label uses phase.appliedCount (#1136)', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => {
      store.getState().beginChangeSetApply(2);
      store
        .getState()
        .resolveChangeSetApply({ failed: [], note: 'Applied 2 files. Skipped 1 that changed since it was proposed.' });
    });

    expect(applyBtn(container).textContent).toBe('Applied 2 files ✓');
    expect(status(container).textContent).toBe(
      'Applied 2 files. Skipped 1 that changed since it was proposed.',
    );
  });

  test('reviewing with a note (#633): the note lands in the live region and Apply is RE-ENABLED for retry', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => {
      store.getState().beginChangeSetApply(2);
      store.getState().rejectChangeSetApply('Apply failed: Error: disk write failed');
    });

    expect(status(container).textContent).toBe('Apply failed: Error: disk write failed');
    expect(applyBtn(container).disabled).toBe(false);
    expect(applyBtn(container).textContent).toBe('Apply 2 files');
    expect(discardBtn(container)).not.toBeNull();
  });

  test('a partial failure settles back to reviewing with the failed-files note and Apply re-enabled', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => {
      store.getState().beginChangeSetApply(2);
      store.getState().resolveChangeSetApply({ failed: ['billing/invoice.koi'] });
    });

    expect(status(container).textContent).toBe('Failed to apply: billing/invoice.koi');
    expect(applyBtn(container).disabled).toBe(false);
  });

  test('applied is terminal: "Applied ✓" label, Discard gone, checkboxes disabled, outcome announced', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => {
      store.getState().beginChangeSetApply(2);
      store.getState().resolveChangeSetApply({ failed: [] });
    });

    expect(applyBtn(container).textContent).toBe('Applied 2 files ✓');
    expect(applyBtn(container).disabled).toBe(true);
    expect(discardBtn(container)).toBeNull();
    expect(checkboxes(container).every((cb) => cb.disabled)).toBe(true);
    expect(status(container).textContent).toBe('Applied 2 files.');
  });

  test('applied count follows the slice appliedCount (singular form at 1 file)', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => {
      store.getState().setChangeSetFileAccepted('billing/invoice.koi', false);
      store.getState().beginChangeSetApply(1);
      store.getState().resolveChangeSetApply({ failed: [] });
    });

    expect(applyBtn(container).textContent).toBe('Applied 1 file ✓');
    expect(status(container).textContent).toBe('Applied 1 file.');
  });

  test('invalidated (#473): superseded treatment, Apply + checkboxes disabled, reason announced', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => store.getState().invalidateChangeSet('superseded'));

    expect(panel(container)!.classList.contains('koi-changeset-superseded')).toBe(true);
    expect(applyBtn(container).disabled).toBe(true);
    expect(checkboxes(container).every((cb) => cb.disabled)).toBe(true);
    expect(status(container).textContent).toBe(
      'This change set was superseded by a newer turn and can no longer be applied.',
    );
  });

  test('drifted rows (#473) carry the sticky drift warning on the right row', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    await act(() => store.getState().markChangeSetDrift(['ordering/order.koi']));

    const rows = container.querySelectorAll('.koi-changeset-file');
    const warn = rows[0].querySelector('.koi-changeset-drift');
    expect(warn).not.toBeNull();
    expect(warn!.textContent).toBe('Changed since this was proposed — skipped to protect your edits.');
    expect(rows[1].querySelector('.koi-changeset-drift')).toBeNull();
  });

  test('non-clean diagnostics (#474) render the labelled diagnostics block; a clean result renders none', () => {
    const failing = mount(reviewingStore('ok: false — 1 error(s)\norder.koi(1,1): error KOI0001: boom'));
    const diag = failing.container.querySelector('.koi-changeset-diagnostics')!;
    expect(diag).not.toBeNull();
    expect(diag.textContent).toContain('error KOI0001: boom');
    expect(diag.getAttribute('aria-label')).toBe('Validation diagnostics for the staged changes');

    const clean = mount(reviewingStore('ok: true — compiled 2 file(s)'));
    expect(clean.container.querySelector('.koi-changeset-diagnostics')).toBeNull();
  });

  test('a discard from the slice unmounts the panel (renders null again)', async () => {
    const store = reviewingStore();
    const { container } = mount(store);
    expect(panel(container)).not.toBeNull();
    await act(() => store.getState().discardChangeSet());
    expect(panel(container)).toBeNull();
  });

  test('has no accessibility violations (reviewing with drift + diagnostics)', async () => {
    const store = reviewingStore('ok: false — 1 error(s)\norder.koi(1,1): error KOI0001: boom');
    store.getState().markChangeSetDrift(['ordering/order.koi']);
    const { container } = mount(store);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// #472 Task 4: two roots of a multi-root workspace staging the SAME relPath must review as two
// distinct rows. Rows key by the staged edit's opaque key; each row renders the DISPLAY label the
// host carried from the tool layer's per-session index (`relPath@1`, `relPath@2`, …) on the slice
// state — NOT a label re-derived from row order, which would swap the twins whenever the model staged
// them in the opposite order — and every dispatch/callback carries the KEY so a toggle or apply can
// never hit the wrong root.
describe('colliding relPaths across roots (#472)', () => {
  const wsA = 'file:///wsA/model.koi';
  const wsB = 'file:///wsB/model.koi';
  const colliding: StagedEdit[] = [
    { key: wsA, relPath: 'model.koi', body: 'context A {\n  aggregate One {}\n}', isNew: false },
    { key: wsB, relPath: 'model.koi', body: 'context B {\n  aggregate Two {}\n}', isNew: false },
  ];
  const collidingBefore = { [wsA]: 'context A {\n}', [wsB]: 'context B {\n}' };
  // The tool-layer display labels, keyed by session KEY — what the model addressed each file by.
  const collidingDisplay = { [wsA]: 'model.koi@1', [wsB]: 'model.koi@2' };

  function collidingStore(): StoreApi<AppState> {
    const store = createAppStore();
    store.getState().stageChangeSet(colliding, collidingBefore, null, collidingDisplay);
    return store;
  }

  test('each row shows a DISTINCT disambiguated label and a diff derived from its OWN before', () => {
    const { container } = mount(collidingStore());
    const rows = [...container.querySelectorAll('.koi-changeset-file')];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.querySelector('.koi-changeset-path')!.textContent)).toEqual([
      'model.koi@1',
      'model.koi@2',
    ]);
    // Per-row before: each diff keeps its own root's shared line (no last-writer collapse).
    const diffs = rows.map((r) => r.querySelector('.koi-changeset-diff')!.textContent!);
    expect(diffs[0]).toContain('  context A {');
    expect(diffs[0]).toContain('+   aggregate One {}');
    expect(diffs[0]).not.toContain('context B');
    expect(diffs[1]).toContain('  context B {');
    expect(diffs[1]).toContain('+   aggregate Two {}');
    expect(diffs[1]).not.toContain('context A');
    // The accept checkboxes are labelled with the disambiguated names too.
    expect(rows.map((r) => r.querySelector('.koi-changeset-accept')!.getAttribute('aria-label'))).toEqual([
      'Accept changes to model.koi@1',
      'Accept changes to model.koi@2',
    ]);
  });

  test('unchecking one colliding row dispatches setChangeSetFileAccepted with its KEY, twin untouched', () => {
    const store = collidingStore();
    const { container } = mount(store);
    fireEvent.click(checkboxes(container)[1]); // uncheck wsB's row
    const files = store.getState().chat.changeSet!.files;
    expect(files.find((f) => f.key === wsB)?.accepted).toBe(false);
    expect(files.find((f) => f.key === wsA)?.accepted).toBe(true);
  });

  test('Apply forwards the accepted entries with their STAGED keys', () => {
    const store = collidingStore();
    const onApply = vi.fn();
    const { container } = mount(store, { onApply });
    fireEvent.click(applyBtn(container));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0][0].map((f: { key: string }) => f.key)).toEqual([wsA, wsB]);
  });

  test('labels follow the PROVIDED display field, not row order: reverse-staged twins keep their own labels', () => {
    // The model staged the twins in the OPPOSITE order to the tool index (wsB first). A row-order
    // re-derivation would label row 0 `model.koi@1` — i.e. wsB would masquerade as the path the model
    // called `model.koi@1` (wsA), and the user would uncheck/accept the wrong root's file.
    const store = createAppStore();
    store.getState().stageChangeSet([colliding[1], colliding[0]], collidingBefore, null, collidingDisplay);
    const { container } = mount(store);
    const rows = [...container.querySelectorAll('.koi-changeset-file')];
    expect(rows.map((r) => r.querySelector('.koi-changeset-path')!.textContent)).toEqual([
      'model.koi@2', // row 0 IS wsB — its tool-layer label, not a recomputed @1
      'model.koi@1',
    ]);
    expect(rows.map((r) => r.querySelector('.koi-changeset-accept')!.getAttribute('aria-label'))).toEqual([
      'Accept changes to model.koi@2',
      'Accept changes to model.koi@1',
    ]);
  });

  test('a SINGLE staged twin keeps its root marker (never a bare relPath that could mean either root)', () => {
    const store = createAppStore();
    store.getState().stageChangeSet([colliding[1]], collidingBefore, null, { [wsB]: 'model.koi@2' });
    const { container } = mount(store);
    expect(container.querySelector('.koi-changeset-path')!.textContent).toBe('model.koi@2');
    expect(container.querySelector('.koi-changeset-accept')!.getAttribute('aria-label')).toBe(
      'Accept changes to model.koi@2',
    );
  });

  test('unique relPaths keep their bare labels (no needless @n marker)', () => {
    const { container } = mount(reviewingStore());
    expect([...container.querySelectorAll('.koi-changeset-path')].map((el) => el.textContent)).toEqual([
      'ordering/order.koi',
      'billing/invoice.koi',
    ]);
  });

  test('has no accessibility violations (disambiguated rows)', async () => {
    const { container } = mount(collidingStore());
    expect(await axe(container)).toHaveNoViolations();
  });
});

// #1132 Task 4: in a multi-root workspace, a model-proposed brand-new file needs a place to land.
// The new-file row grows a native `<select class="koi-changeset-root">` — one `<option>` per
// workspace root, labelled by folder name (title carries the full root so two roots with colliding
// last segments stay disambiguated) — wired straight to `setChangeSetFileRoot` (#1132 Task 2). A
// modified row, or a workspace with one root or none, renders no select at all.
describe('root picker for new-file rows (#1132)', () => {
  const rootA = 'file:///workspaceA/shared';
  const rootB = 'file:///workspaceB/shared';

  /** A reviewing store over the same two-file `staged` set (row 0 modified, row 1 new), with `roots`
   *  seeded and an optional per-key `targetRoot` map (mirrors Task 2/3's `stageChangeSet` wiring). */
  function storeWithRoots(roots: readonly string[], targetRoots?: Record<string, string>): StoreApi<AppState> {
    const store = createAppStore();
    store.getState().setRoots(roots);
    store.getState().stageChangeSet(staged, before, null, undefined, targetRoots);
    return store;
  }

  const rootSelect = (row: Element) => row.querySelector('.koi-changeset-root') as HTMLSelectElement | null;

  test('a new-file row in a multi-root workspace renders a select with one option per root, folder-labelled and full-root-titled', () => {
    const store = storeWithRoots([rootA, rootB]);
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');

    const select = rootSelect(rows[1])!;
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    expect(select.getAttribute('aria-label')).toBe('Folder for new file billing/invoice.koi');

    const options = [...select.querySelectorAll('option')];
    // Both roots share the last path segment ("shared") — the visible label collides, but `title`
    // (the full root token) still disambiguates them.
    expect(options.map((o) => o.textContent)).toEqual(['shared', 'shared']);
    expect(options.map((o) => o.getAttribute('title'))).toEqual([rootA, rootB]);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([rootA, rootB]);
  });

  test('a MODIFIED row renders no root select, even in a multi-root workspace', () => {
    const store = storeWithRoots([rootA, rootB]);
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[0])).toBeNull();
  });

  test('a single-root workspace renders no root select at all, even for a new-file row', () => {
    const store = storeWithRoots([rootA]);
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])).toBeNull();
  });

  test('a zero-root store (no folder open yet) renders no root select either', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])).toBeNull();
  });

  test('the initial value is the row targetRoot when Task 2/3 already chose one', () => {
    const store = storeWithRoots([rootA, rootB], { 'billing/invoice.koi': rootB });
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])!.value).toBe(rootB);
  });

  test('the initial value falls back to roots[0] when no targetRoot was chosen', () => {
    const store = storeWithRoots([rootA, rootB]);
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])!.value).toBe(rootA);
  });

  test('changing the select dispatches setChangeSetFileRoot with the row key and the chosen root', () => {
    const store = storeWithRoots([rootA, rootB]);
    const { container } = mount(store);
    const rows = container.querySelectorAll('.koi-changeset-file');
    const select = rootSelect(rows[1])!;

    // `@testing-library/preact`'s `fireEvent.change` special-cases `change` → `input` when it detects
    // preact/compat is loaded ANYWHERE in the process (this repo aliases `react`/`react-dom` to
    // preact/compat for other dependencies) — a global, not per-component, signal, so it mis-fires
    // even for this component's plain-preact `<select onChange>` (bound to the real `change` event).
    // Dispatching the native event directly through the base `fireEvent(el, event)` form sidesteps
    // that renaming and exercises exactly what a real browser does when a user picks an option.
    select.value = rootB;
    fireEvent(select, new Event('change', { bubbles: true }));

    const fileState = store.getState().chat.changeSet!.files.find((f) => f.key === 'billing/invoice.koi');
    expect(fileState?.targetRoot).toBe(rootB);
  });

  test('the select is disabled once the review is terminal, same rule as the accept checkbox', async () => {
    const store = storeWithRoots([rootA, rootB]);
    const { container } = mount(store);
    await act(() => {
      store.getState().beginChangeSetApply(2);
      store.getState().resolveChangeSetApply({ failed: [] });
    });
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])!.disabled).toBe(true);
  });

  test('has no accessibility violations (multi-root new-file picker)', async () => {
    const store = storeWithRoots([rootA, rootB]);
    const { container } = mount(store);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// #1689: a root removed mid-review (workspaceController.ts's removeRoot) must not leave the picker —
// or the underlying slice state — pointing at a dead root. The panel reconciles reactively whenever
// `roots` changes, via reconcileChangeSetRoots (#1689 Task 1).
describe('root reconciliation when a workspace root is removed mid-review (#1689)', () => {
  const rootA = 'file:///workspaceA/shared';
  const rootB = 'file:///workspaceB/shared';

  function storeWithRoots(roots: readonly string[], targetRoots?: Record<string, string>): StoreApi<AppState> {
    const store = createAppStore();
    store.getState().setRoots(roots);
    store.getState().stageChangeSet(staged, before, null, undefined, targetRoots);
    return store;
  }

  const rootSelect = (row: Element) => row.querySelector('.koi-changeset-root') as HTMLSelectElement | null;

  test('root removed, count stays multi: targetRoot resets to null and the picker falls back to roots[0]', () => {
    const store = storeWithRoots([rootA, rootB], { 'billing/invoice.koi': rootB });
    const { container } = mount(store);

    act(() => {
      store.getState().setRoots([rootA]);
    });

    const fileState = store.getState().chat.changeSet!.files.find((f) => f.key === 'billing/invoice.koi');
    expect(fileState?.targetRoot).toBeNull();
    const rows = container.querySelectorAll('.koi-changeset-file');
    // Only rootA survives, so the multi-root picker no longer renders — but the value it WOULD show
    // (had a second root remained) is proven by the slice-level assertion above; here we only need to
    // confirm the row no longer holds the dead root's value anywhere observable.
    expect(rootSelect(rows[1])).toBeNull();
  });

  test('root removed, a second root still present: the surviving picker shows the roots[0] fallback', () => {
    const rootC = 'file:///workspaceC/shared';
    const store = storeWithRoots([rootA, rootB, rootC], { 'billing/invoice.koi': rootB });
    const { container } = mount(store);

    act(() => {
      store.getState().setRoots([rootA, rootC]);
    });

    const fileState = store.getState().chat.changeSet!.files.find((f) => f.key === 'billing/invoice.koi');
    expect(fileState?.targetRoot).toBeNull();
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])!.value).toBe(rootA);
  });

  test('the still-present root is left untouched', () => {
    const store = storeWithRoots([rootA, rootB], { 'billing/invoice.koi': rootB });
    const { container } = mount(store);

    act(() => {
      store.getState().setRoots([rootA, rootB]);
    });

    const fileState = store.getState().chat.changeSet!.files.find((f) => f.key === 'billing/invoice.koi');
    expect(fileState?.targetRoot).toBe(rootB);
    const rows = container.querySelectorAll('.koi-changeset-file');
    expect(rootSelect(rows[1])!.value).toBe(rootB);
  });
});
