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
  { relPath: 'ordering/order.koi', body: 'context Ordering {\n  aggregate Order {}\n}', isNew: false },
  { relPath: 'billing/invoice.koi', body: 'context Billing {}', isNew: true },
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

  test('applying: Apply stays label-tracked but disabled (no second concurrent apply), checkboxes stay live', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => store.getState().beginChangeSetApply());

    expect(applyBtn(container).textContent).toBe('Apply 2 files');
    expect(applyBtn(container).disabled).toBe(true);
    // The slice allows toggling mid-apply; the panel must not lock the checkboxes early.
    expect(checkboxes(container).every((cb) => !cb.disabled)).toBe(true);
  });

  test('reviewing with a note (#633): the note lands in the live region and Apply is RE-ENABLED for retry', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => {
      store.getState().beginChangeSetApply();
      store.getState().rejectChangeSetApply('Apply failed: Error: disk write failed');
    });

    expect(status(container).textContent).toBe('Apply failed: Error: disk write failed');
    expect(applyBtn(container).disabled).toBe(false);
    expect(applyBtn(container).textContent).toBe('Apply 2 files');
    expect(discardBtn(container)).not.toBeNull();
  });

  test('a partial failure settles back to reviewing with the failed-files note and Apply re-enabled', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => {
      store.getState().beginChangeSetApply();
      store.getState().resolveChangeSetApply({ failed: ['billing/invoice.koi'] });
    });

    expect(status(container).textContent).toBe('Failed to apply: billing/invoice.koi');
    expect(applyBtn(container).disabled).toBe(false);
  });

  test('applied is terminal: "Applied ✓" label, Discard gone, checkboxes disabled, outcome announced', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => {
      store.getState().beginChangeSetApply();
      store.getState().resolveChangeSetApply({ failed: [] });
    });

    expect(applyBtn(container).textContent).toBe('Applied 2 files ✓');
    expect(applyBtn(container).disabled).toBe(true);
    expect(discardBtn(container)).toBeNull();
    expect(checkboxes(container).every((cb) => cb.disabled)).toBe(true);
    expect(status(container).textContent).toBe('Applied 2 files.');
  });

  test('applied count follows the slice appliedCount (singular form at 1 file)', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => {
      store.getState().setChangeSetFileAccepted('billing/invoice.koi', false);
      store.getState().beginChangeSetApply();
      store.getState().resolveChangeSetApply({ failed: [] });
    });

    expect(applyBtn(container).textContent).toBe('Applied 1 file ✓');
    expect(status(container).textContent).toBe('Applied 1 file.');
  });

  test('invalidated (#473): superseded treatment, Apply + checkboxes disabled, reason announced', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => store.getState().invalidateChangeSet('superseded'));

    expect(panel(container)!.classList.contains('koi-changeset-superseded')).toBe(true);
    expect(applyBtn(container).disabled).toBe(true);
    expect(checkboxes(container).every((cb) => cb.disabled)).toBe(true);
    expect(status(container).textContent).toBe(
      'This change set was superseded by a newer turn and can no longer be applied.',
    );
  });

  test('drifted rows (#473) carry the sticky drift warning on the right row', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    act(() => store.getState().markChangeSetDrift(['ordering/order.koi']));

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

  test('a discard from the slice unmounts the panel (renders null again)', () => {
    const store = reviewingStore();
    const { container } = mount(store);
    expect(panel(container)).not.toBeNull();
    act(() => store.getState().discardChangeSet());
    expect(panel(container)).toBeNull();
  });

  test('has no accessibility violations (reviewing with drift + diagnostics)', async () => {
    const store = reviewingStore('ok: false — 1 error(s)\norder.koi(1,1): error KOI0001: boom');
    store.getState().markChangeSetDrift(['ordering/order.koi']);
    const { container } = mount(store);
    expect(await axe(container)).toHaveNoViolations();
  });
});
