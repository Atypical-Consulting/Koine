import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { dismissFloating, showActionMenu, showRenameInput } from '@/editor/actions';
import type { MenuItem } from '@/editor/actions';

// actions.ts owns the two floating widgets (showActionMenu / showRenameInput) plus the shared
// dismissal machinery (dismissFloating + the internal placeAt/registerActive). They mount fixed-position
// DOM on document.body and anchor to a CodeMirror doc offset via view.coordsAtPos. We drive them against a
// REAL EditorView (the @codemirror/* packages construct fine under happy-dom — see ide.test.ts). Note:
// happy-dom has no layout, so view.coordsAtPos() always returns null; that means placeAt always takes its
// fallback branch (left=120/top=120) and the on-screen-clamp arithmetic for the coords-present branch can't
// be exercised here (it needs a real browser with layout). Everything else — the menu/input behaviour,
// keyboard nav, dismissal triggers, and the single-active-widget invariant — runs for real.

// A fresh detached EditorView per test, mounted in the document so scrollDOM/focus behave.
function makeView(doc = 'hello\nworld'): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ parent, state: EditorState.create({ doc }) });
}

// Convenience accessors for the single active widget on the body.
const menuEl = () => document.querySelector<HTMLElement>('.koi-action-menu');
const renameEl = () => document.querySelector<HTMLElement>('.koi-rename');
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.koi-action-row'));
const selectedRow = () => document.querySelector<HTMLButtonElement>('.koi-action-row[aria-selected="true"]');

// Dispatch a keydown on a target and return the event (so we can assert defaultPrevented).
function keydown(target: EventTarget, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => {
  // Always leave the body clean even if a test left a widget open.
  dismissFloating();
  vi.useRealTimers();
});

describe('dismissFloating', () => {
  it('is a no-op when nothing is open', () => {
    expect(() => dismissFloating()).not.toThrow();
    expect(menuEl()).toBeNull();
  });

  it('removes the active widget from the DOM and runs its cleanup', () => {
    const view = makeView();
    showActionMenu(view, 0, [{ label: 'a', run: () => {} }]);
    expect(menuEl()).not.toBeNull();

    dismissFloating();
    expect(menuEl()).toBeNull();
  });

  it('detaches the scroll/mousedown listeners so a later scroll does not re-dismiss', () => {
    const view = makeView();
    showActionMenu(view, 0, [{ label: 'a', run: () => {} }]);
    dismissFloating();
    // A scroll after dismissal must not throw (listener was removed) and nothing should re-mount.
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    expect(menuEl()).toBeNull();
  });
});

describe('showActionMenu — empty state', () => {
  it('renders the default empty note with role=menu and no rows', () => {
    const view = makeView();
    showActionMenu(view, 0, []);

    const menu = menuEl()!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(rows()).toHaveLength(0);
    const empty = menu.querySelector('.koi-action-empty');
    expect(empty?.textContent).toBe('No actions available.');
  });

  it('uses a custom emptyText when supplied', () => {
    const view = makeView();
    showActionMenu(view, 0, [], { emptyText: 'Nothing to do here.' });
    expect(menuEl()!.querySelector('.koi-action-empty')?.textContent).toBe('Nothing to do here.');
  });

  it('auto-dismisses the empty note after 1400ms', () => {
    vi.useFakeTimers();
    const view = makeView();
    showActionMenu(view, 0, []);
    expect(menuEl()).not.toBeNull();

    vi.advanceTimersByTime(1399);
    expect(menuEl()).not.toBeNull(); // still up just before the deadline
    vi.advanceTimersByTime(1);
    expect(menuEl()).toBeNull(); // gone at 1400ms
  });

  it('clearing the empty note early (via dismiss) cancels the auto-dismiss timer', () => {
    vi.useFakeTimers();
    const view = makeView();
    showActionMenu(view, 0, []);
    dismissFloating();
    expect(menuEl()).toBeNull();
    // Advancing past the deadline must not throw or touch a removed node.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });
});

describe('showActionMenu — populated', () => {
  const item = (label: string, run = () => {}, detail?: string): MenuItem => ({ label, detail, run });

  it('renders one button row per item with role=menuitem and the label text', () => {
    const view = makeView();
    showActionMenu(view, 0, [item('Rename'), item('Find references')]);

    const r = rows();
    expect(r).toHaveLength(2);
    expect(r.map((b) => b.getAttribute('role'))).toEqual(['menuitem', 'menuitem']);
    expect(r.map((b) => b.querySelector('.koi-action-label')?.textContent)).toEqual([
      'Rename',
      'Find references',
    ]);
  });

  it('renders a detail span only for items that have a detail', () => {
    const view = makeView();
    showActionMenu(view, 0, [item('Rename', () => {}, 'F2'), item('Plain')]);

    const r = rows();
    expect(r[0].querySelector('.koi-action-detail')?.textContent).toBe('F2');
    expect(r[1].querySelector('.koi-action-detail')).toBeNull();
  });

  it('selects the first row on open', () => {
    const view = makeView();
    showActionMenu(view, 0, [item('a'), item('b'), item('c')]);
    expect(selectedRow()).toBe(rows()[0]);
    expect(rows().map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  });

  it('ArrowDown advances selection and wraps past the last row to the first', () => {
    const view = makeView();
    const menu = (showActionMenu(view, 0, [item('a'), item('b')]), menuEl()!);

    keydown(menu, 'ArrowDown');
    expect(selectedRow()).toBe(rows()[1]);
    keydown(menu, 'ArrowDown'); // wrap 1 -> 0
    expect(selectedRow()).toBe(rows()[0]);
  });

  it('ArrowUp moves selection back and wraps from the first row to the last', () => {
    const view = makeView();
    const menu = (showActionMenu(view, 0, [item('a'), item('b'), item('c')]), menuEl()!);

    keydown(menu, 'ArrowUp'); // wrap 0 -> 2
    expect(selectedRow()).toBe(rows()[2]);
  });

  it('mouseenter on a row selects it', () => {
    const view = makeView();
    showActionMenu(view, 0, [item('a'), item('b')]);
    rows()[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    expect(selectedRow()).toBe(rows()[1]);
  });

  it('Enter runs the selected item and dismisses the menu first', () => {
    const view = makeView();
    const order: string[] = [];
    const run = vi.fn(() => {
      // The menu must already be gone by the time run() fires (dismissFloating runs first).
      order.push(menuEl() ? 'menu-open' : 'menu-closed');
    });
    const menu = (showActionMenu(view, 0, [item('Run me', run)]), menuEl()!);

    const e = keydown(menu, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['menu-closed']);
    expect(menuEl()).toBeNull();
  });

  it('Enter runs the row the user navigated to, not just the first', () => {
    const view = makeView();
    const runA = vi.fn();
    const runB = vi.fn();
    const menu = (showActionMenu(view, 0, [item('a', runA), item('b', runB)]), menuEl()!);

    keydown(menu, 'ArrowDown'); // select b
    keydown(menu, 'Enter');
    expect(runA).not.toHaveBeenCalled();
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('clicking a row runs that item and dismisses the menu', () => {
    const view = makeView();
    const run = vi.fn();
    showActionMenu(view, 0, [item('a'), item('b', run)]);

    rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(menuEl()).toBeNull();
  });

  it('Escape dismisses the menu and refocuses the editor', () => {
    const view = makeView();
    const focus = vi.spyOn(view, 'focus');
    const menu = (showActionMenu(view, 0, [item('a')]), menuEl()!);

    const e = keydown(menu, 'Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(menuEl()).toBeNull();
    expect(focus).toHaveBeenCalled();
  });

  it('ignores unrelated keys (no preventDefault, menu stays open)', () => {
    const view = makeView();
    const menu = (showActionMenu(view, 0, [item('a')]), menuEl()!);
    const e = keydown(menu, 'b');
    expect(e.defaultPrevented).toBe(false);
    expect(menuEl()).not.toBeNull();
  });
});

describe('showActionMenu — dismissal triggers', () => {
  it('an editor scroll dismisses the menu', () => {
    const view = makeView();
    showActionMenu(view, 0, [{ label: 'a', run: () => {} }]);
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    expect(menuEl()).toBeNull();
  });

  it('an outside mousedown dismisses the menu (after the deferred listener attaches)', () => {
    vi.useFakeTimers();
    const view = makeView();
    showActionMenu(view, 0, [{ label: 'a', run: () => {} }]);

    // The mousedown listener is attached on the next tick so the opening click can't self-close it.
    // Before that tick fires, an outside mousedown is a no-op.
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menuEl()).not.toBeNull();

    vi.advanceTimersByTime(0); // let the setTimeout(0) attach the listener
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menuEl()).toBeNull();
  });

  it('a mousedown INSIDE the menu does not dismiss it', () => {
    vi.useFakeTimers();
    const view = makeView();
    const menu = (showActionMenu(view, 0, [{ label: 'a', run: () => {} }]), menuEl()!);
    vi.advanceTimersByTime(0);

    menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menuEl()).not.toBeNull();
  });
});

describe('showActionMenu — single-active-widget invariant', () => {
  it('opening a second menu removes the first from the DOM', () => {
    const view = makeView();
    showActionMenu(view, 0, [{ label: 'first', run: () => {} }]);
    showActionMenu(view, 0, [{ label: 'second', run: () => {} }]);

    expect(document.querySelectorAll('.koi-action-menu')).toHaveLength(1);
    expect(menuEl()!.querySelector('.koi-action-label')?.textContent).toBe('second');
  });

  it('opening a rename input replaces an open action menu', () => {
    const view = makeView();
    showActionMenu(view, 0, [{ label: 'a', run: () => {} }]);
    showRenameInput(view, 0, 'Foo', () => {});

    expect(menuEl()).toBeNull();
    expect(renameEl()).not.toBeNull();
  });
});

describe('showRenameInput', () => {
  it('mounts a text input pre-filled with the placeholder plus the hint and aria-label', () => {
    const view = makeView();
    showRenameInput(view, 0, 'OrderId', () => {});

    const box = renameEl()!;
    const input = box.querySelector<HTMLInputElement>('.koi-rename-input')!;
    expect(input.type).toBe('text');
    expect(input.value).toBe('OrderId');
    expect(input.spellcheck).toBe(false);
    expect(input.getAttribute('aria-label')).toBe('Rename symbol');
    expect(box.querySelector('.koi-rename-hint')?.textContent).toContain('rename');
  });

  it('Enter with a changed, non-empty value submits the trimmed name and dismisses', () => {
    const view = makeView();
    const onSubmit = vi.fn();
    const focus = vi.spyOn(view, 'focus');
    showRenameInput(view, 0, 'Old', onSubmit);

    const input = document.querySelector<HTMLInputElement>('.koi-rename-input')!;
    input.value = '  NewName  ';
    const e = keydown(input, 'Enter');

    expect(e.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith('NewName'); // trimmed
    expect(renameEl()).toBeNull();
    expect(focus).toHaveBeenCalled();
  });

  it('Enter with the unchanged value dismisses but does NOT submit', () => {
    const view = makeView();
    const onSubmit = vi.fn();
    showRenameInput(view, 0, 'Same', onSubmit);

    const input = document.querySelector<HTMLInputElement>('.koi-rename-input')!;
    input.value = 'Same';
    keydown(input, 'Enter');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(renameEl()).toBeNull();
  });

  it('Enter whose value trims to empty dismisses but does NOT submit', () => {
    const view = makeView();
    const onSubmit = vi.fn();
    showRenameInput(view, 0, 'Old', onSubmit);

    const input = document.querySelector<HTMLInputElement>('.koi-rename-input')!;
    input.value = '   ';
    keydown(input, 'Enter');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(renameEl()).toBeNull();
  });

  it('a value that equals the placeholder only after trimming still counts as unchanged', () => {
    const view = makeView();
    const onSubmit = vi.fn();
    showRenameInput(view, 0, 'Name', onSubmit);

    const input = document.querySelector<HTMLInputElement>('.koi-rename-input')!;
    input.value = '  Name  '; // trims to 'Name' === placeholder
    keydown(input, 'Enter');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape cancels: dismisses, refocuses the editor, never submits', () => {
    const view = makeView();
    const onSubmit = vi.fn();
    const focus = vi.spyOn(view, 'focus');
    showRenameInput(view, 0, 'Old', onSubmit);

    const input = document.querySelector<HTMLInputElement>('.koi-rename-input')!;
    const e = keydown(input, 'Escape');

    expect(e.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(renameEl()).toBeNull();
    expect(focus).toHaveBeenCalled();
  });

  it('ignores unrelated keys (input stays open, no submit)', () => {
    const view = makeView();
    const onSubmit = vi.fn();
    showRenameInput(view, 0, 'Old', onSubmit);
    const input = document.querySelector<HTMLInputElement>('.koi-rename-input')!;
    const e = keydown(input, 'x');

    expect(e.defaultPrevented).toBe(false);
    expect(renameEl()).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('an outside mousedown cancels the rename without submitting', () => {
    vi.useFakeTimers();
    const view = makeView();
    const onSubmit = vi.fn();
    showRenameInput(view, 0, 'Old', onSubmit);
    vi.advanceTimersByTime(0); // attach the deferred outside-mousedown listener

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(renameEl()).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
