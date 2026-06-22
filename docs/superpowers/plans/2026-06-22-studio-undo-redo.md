# Koine Studio Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single unified undo/redo system to Koine Studio, surfaced as two top-bar buttons (+ `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`), where the `.koi` code text is the one source of truth and the diagram/inspector/glossary re-derive from restored code.

**Architecture:** A new `historyController` owns past/present/future **snapshots** of every open buffer's text; a `historySlice` in the Zustand store exposes reactive `canUndo`/`canRedo`; a `<HistoryControls>` Preact island renders the buttons. Edits funnel through the existing `onChange` (typing, debounced) and `applyWorkspaceEdit` (structured edits, immediate) seams; restore writes code back and calls the existing `onDocEdited` so all views follow. CodeMirror's built-in history is removed so there is exactly one timeline.

**Tech Stack:** TypeScript, Preact (islands), Zustand (vanilla store), CodeMirror 6, Vitest + @testing-library/preact.

## Global Constraints

- All paths below are relative to `tooling/koine-studio/`.
- Test runner: `npm test` (= `vitest run`); typecheck/build: `npm run build` (= `tsc && vite build`). Tests are co-located `*.test.ts(x)`.
- Preact islands subscribe to the store via `useStore(store, selector)` from `zustand` (the `preact/compat` alias), taking the store as a `store` prop — never the singleton directly — so tests can inject `createAppStore()`.
- Slices are pure: `create<Name>Slice(set, get)` returning state + setters, composed in `src/store/index.ts`. No controller/DOM refs in a slice.
- Controllers use dependency injection (factory `create<Name>Controller(deps)`), mirroring `src/workspaceController.ts`. No new npm dependencies.
- The `.koi` code text lives in `workspaceController.buffers` (a `Map<string, Buffer>`); the store only projects it. Do not move document text into the store.
- Commit with the GitHub identity: `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`.

---

### Task 1: `historySlice` — reactive `canUndo`/`canRedo` in the store

**Files:**
- Create: `src/store/slices/history.ts`
- Test: `src/store/slices/history.test.ts`
- Modify: `src/store/index.ts`

**Interfaces:**
- Consumes: nothing (foundational).
- Produces:
  - `interface HistorySlice { canUndo: boolean; canRedo: boolean; setHistoryState(s: { canUndo: boolean; canRedo: boolean }): void }`
  - `createHistorySlice(set, get): HistorySlice`
  - `AppState` (in `src/store/index.ts`) gains `& HistorySlice`.

- [ ] **Step 1: Write the failing test**

Create `src/store/slices/history.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createHistorySlice, type HistorySlice } from './history';

const make = () => createStore<HistorySlice>((set, get) => createHistorySlice(set, get));

describe('history slice', () => {
  test('starts with both disabled', () => {
    const s = make();
    expect(s.getState().canUndo).toBe(false);
    expect(s.getState().canRedo).toBe(false);
  });

  test('setHistoryState updates both flags', () => {
    const s = make();
    s.getState().setHistoryState({ canUndo: true, canRedo: false });
    expect(s.getState().canUndo).toBe(true);
    expect(s.getState().canRedo).toBe(false);
    s.getState().setHistoryState({ canUndo: false, canRedo: true });
    expect(s.getState().canUndo).toBe(false);
    expect(s.getState().canRedo).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- history`
Expected: FAIL — `Cannot find module './history'`.

- [ ] **Step 3: Create the slice**

Create `src/store/slices/history.ts`:

```ts
import type { StoreApi } from 'zustand/vanilla';

export interface HistorySlice {
  /** True when there is at least one undo step (drives the top-bar Undo button). */
  canUndo: boolean;
  /** True when there is at least one redo step (drives the top-bar Redo button). */
  canRedo: boolean;
  /** Replace the reactive button state; the historyController calls this on every change. */
  setHistoryState(s: { canUndo: boolean; canRedo: boolean }): void;
}

export function createHistorySlice(
  set: StoreApi<HistorySlice>['setState'],
  _get: StoreApi<HistorySlice>['getState'],
): HistorySlice {
  return {
    canUndo: false,
    canRedo: false,
    setHistoryState: (s) => set({ canUndo: s.canUndo, canRedo: s.canRedo }),
  };
}
```

- [ ] **Step 4: Compose the slice into the store**

In `src/store/index.ts`: add the import, extend `AppState`, and spread the slice.

Add after the other slice imports (around line 7):

```ts
import { createHistorySlice, type HistorySlice } from './slices/history';
```

Extend the `AppState` union (it currently ends `& UiChromeSlice;`):

```ts
export type AppState = SelectionSlice &
  ActiveContextSlice &
  DiagnosticsSlice &
  DocViewsSlice &
  WorkspaceSlice &
  UiChromeSlice &
  HistorySlice;
```

Spread it in `createAppStore` (after `...createUiChromeSlice(set, get),`):

```ts
    ...createHistorySlice(set, get),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- history`
Expected: PASS (2 tests). Then `npx tsc --noEmit` → no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/slices/history.ts src/store/slices/history.test.ts src/store/index.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): history slice for reactive undo/redo state"
```

---

### Task 2: `historyController` — snapshot stacks + capture/restore

**Files:**
- Create: `src/historyController.ts`
- Test: `src/historyController.test.ts`

**Interfaces:**
- Consumes: `Buffer` from `./workspaceController`; the `{ canUndo, canRedo }` shape published into Task 1's `setHistoryState`.
- Produces:
  - `interface HistorySnapshot { activeUri: string; docs: Record<string, { text: string; dirty: boolean }> }`
  - `interface HistoryControllerDeps { buffers(): Map<string, Buffer>; activeUri(): string; editor: { getDoc(): string; setDoc(doc: string): void }; lsp: { syncDoc(uri: string, text: string): void }; activateFile(uri: string): void; onRestored(): void; publish(s: { canUndo: boolean; canRedo: boolean }): void; debounceMs?: number; maxDepth?: number }`
  - `interface HistoryController { readonly isRestoring: boolean; noteEdit(opts?: { immediate?: boolean }): void; undo(): void; redo(): void; reset(): void }`
  - `createHistoryController(deps: HistoryControllerDeps): HistoryController`

- [ ] **Step 1: Write the failing test**

Create `src/historyController.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { createHistoryController, type HistoryController } from './historyController';
import type { Buffer } from './workspaceController';

function setup(opts: { maxDepth?: number; debounceMs?: number } = {}) {
  const buffers = new Map<string, Buffer>();
  const mk = (uri: string, text: string, dirty = false): Buffer =>
    ({ uri, path: uri, relPath: uri, name: uri, text, dirty });
  buffers.set('a', mk('a', 'A0'));
  let active = 'a';
  // Mutable hooks let individual tests simulate the real onChange re-entrancy.
  const hooks: { onSetDoc?: (doc: string) => void; onRestored?: () => void } = {};
  const setDoc = vi.fn((doc: string) => hooks.onSetDoc?.(doc));
  const syncDoc = vi.fn();
  const activateFile = vi.fn((uri: string) => { active = uri; });
  const onRestored = vi.fn(() => hooks.onRestored?.());
  const published: Array<{ canUndo: boolean; canRedo: boolean }> = [];
  const ctrl: HistoryController = createHistoryController({
    buffers: () => buffers,
    activeUri: () => active,
    editor: { getDoc: () => buffers.get(active)!.text, setDoc },
    lsp: { syncDoc },
    activateFile,
    onRestored,
    publish: (s) => published.push({ ...s }),
    debounceMs: opts.debounceMs ?? 5,
    maxDepth: opts.maxDepth ?? 100,
  });
  const edit = (uri: string, text: string, dirty = true) => {
    const b = buffers.get(uri)!;
    b.text = text;
    b.dirty = dirty;
  };
  return { ctrl, buffers, mk, edit, setDoc, syncDoc, activateFile, onRestored, published, hooks,
           setActive: (u: string) => { active = u; } };
}

describe('historyController', () => {
  test('an edit enables undo; undo restores the prior text via setDoc', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    expect(h.published.at(-1)).toEqual({ canUndo: true, canRedo: false });

    h.ctrl.undo();
    expect(h.buffers.get('a')!.text).toBe('A0');
    expect(h.setDoc).toHaveBeenCalledWith('A0');
    expect(h.published.at(-1)).toEqual({ canUndo: false, canRedo: true });
  });

  test('redo re-applies the undone edit', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    h.ctrl.redo();
    expect(h.buffers.get('a')!.text).toBe('A1');
    expect(h.published.at(-1)).toEqual({ canUndo: true, canRedo: false });
  });

  test('a new edit after undo clears the redo future', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    h.edit('a', 'A2');
    h.ctrl.noteEdit({ immediate: true });
    expect(h.published.at(-1)).toEqual({ canUndo: true, canRedo: false });
    h.ctrl.redo(); // no future → no-op
    expect(h.buffers.get('a')!.text).toBe('A2');
  });

  test('rapid typing coalesces into a single step (debounced)', () => {
    vi.useFakeTimers();
    try {
      const h = setup({ debounceMs: 5 });
      h.edit('a', 'A1'); h.ctrl.noteEdit();
      h.edit('a', 'A2'); h.ctrl.noteEdit();
      h.edit('a', 'A3'); h.ctrl.noteEdit();
      vi.advanceTimersByTime(5);
      expect(h.published.at(-1)).toEqual({ canUndo: true, canRedo: false });
      h.ctrl.undo();
      expect(h.buffers.get('a')!.text).toBe('A0'); // one step back to baseline, not A2/A1
    } finally {
      vi.useRealTimers();
    }
  });

  test('undo flushes a pending debounced edit first, making it redoable', () => {
    vi.useFakeTimers();
    try {
      const h = setup({ debounceMs: 5 });
      h.edit('a', 'A1'); h.ctrl.noteEdit(); // pending, not yet committed
      h.ctrl.undo();
      expect(h.buffers.get('a')!.text).toBe('A0');
      h.ctrl.redo();
      expect(h.buffers.get('a')!.text).toBe('A1');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a dirty-only change (a save) creates no step', () => {
    const h = setup();
    h.edit('a', 'A1', true);
    h.ctrl.noteEdit({ immediate: true });
    const before = h.published.length;
    h.buffers.get('a')!.dirty = false; // save: text unchanged, dirty flips
    h.ctrl.noteEdit({ immediate: true });
    expect(h.published.length).toBe(before);
  });

  test('a multi-file structured edit undoes every buffer in one step', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.edit('a', 'A1');
    h.edit('b', 'B1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    expect(h.buffers.get('a')!.text).toBe('A0');
    expect(h.buffers.get('b')!.text).toBe('B0');
    expect(h.setDoc).toHaveBeenCalledWith('A0');      // active buffer via the editor
    expect(h.syncDoc).toHaveBeenCalledWith('b', 'B0'); // non-active buffer via the LSP
  });

  test('restore activates the snapshot’s file when the active file differs', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true }); // baseline snapshot had active 'a'
    h.setActive('b');                      // user switched files
    h.ctrl.undo();
    expect(h.activateFile).toHaveBeenCalledWith('a');
  });

  test('isRestoring suppresses capture re-entered from a restore', () => {
    const h = setup();
    let reentered = 0;
    h.hooks.onRestored = () => { h.ctrl.noteEdit({ immediate: true }); reentered++; };
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();                 // restore → onRestored → noteEdit must be ignored
    expect(reentered).toBe(1);
    h.ctrl.redo();                 // history not corrupted by the re-entrant edit
    expect(h.buffers.get('a')!.text).toBe('A1');
    expect(h.published.at(-1)).toEqual({ canUndo: true, canRedo: false });
  });

  test('reset clears the stacks and re-baselines on current buffers', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.reset();
    expect(h.published.at(-1)).toEqual({ canUndo: false, canRedo: false });
    h.ctrl.undo(); // no-op after reset
    expect(h.buffers.get('a')!.text).toBe('A1');
  });

  test('depth cap drops the oldest step', () => {
    const h = setup({ maxDepth: 2 });
    for (const t of ['A1', 'A2', 'A3']) { h.edit('a', t); h.ctrl.noteEdit({ immediate: true }); }
    h.ctrl.undo(); // A2
    h.ctrl.undo(); // A1 (A0 was dropped)
    expect(h.published.at(-1)).toEqual({ canUndo: false, canRedo: true });
    expect(h.buffers.get('a')!.text).toBe('A1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- historyController`
Expected: FAIL — `Cannot find module './historyController'`.

- [ ] **Step 3: Implement the controller**

Create `src/historyController.ts`:

```ts
import type { Buffer } from './workspaceController';

/** A point-in-time snapshot of every open buffer's text + dirty flag, plus which file was active. */
export interface HistorySnapshot {
  activeUri: string;
  docs: Record<string, { text: string; dirty: boolean }>;
}

export interface HistoryControllerDeps {
  /** The live open buffer set (workspaceController.buffers). */
  buffers(): Map<string, Buffer>;
  /** The uri shown in the editor right now. */
  activeUri(): string;
  /** The editor handle — swap the active buffer's doc. */
  editor: { getDoc(): string; setDoc(doc: string): void };
  /** The LSP client — push a restored NON-active buffer to the server. */
  lsp: { syncDoc(uri: string, text: string): void };
  /** Switch the editor to a file (workspaceController.activateFile) so a restore reveals the change. */
  activateFile(uri: string): void;
  /** Re-derive every view from the restored code (ide.tsx wires onDocEdited + renderTree). */
  onRestored(): void;
  /** Publish reactive button state into the store (history slice's setHistoryState). */
  publish(state: { canUndo: boolean; canRedo: boolean }): void;
  /** Idle window (ms) that coalesces a typing burst into one step. Default 500. */
  debounceMs?: number;
  /** Max number of undo steps retained. Default 100. */
  maxDepth?: number;
}

export interface HistoryController {
  /** True while a restore is writing buffers back — capture is suppressed during this. */
  readonly isRestoring: boolean;
  /** Record that the code changed. `immediate` commits now (structured edits); else debounced (typing). */
  noteEdit(opts?: { immediate?: boolean }): void;
  /** Step back one snapshot (settles any pending typing first). */
  undo(): void;
  /** Step forward one snapshot. */
  redo(): void;
  /** Drop all history and re-baseline on the current buffers (workspace swap / structural file op). */
  reset(): void;
}

export function createHistoryController(deps: HistoryControllerDeps): HistoryController {
  const debounceMs = deps.debounceMs ?? 500;
  const maxDepth = deps.maxDepth ?? 100;

  let past: HistorySnapshot[] = [];
  let present: HistorySnapshot = snapshot();
  let future: HistorySnapshot[] = [];
  let restoring = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Capture every open buffer's current text + dirty flag and the active uri.
  function snapshot(): HistorySnapshot {
    const docs: Record<string, { text: string; dirty: boolean }> = {};
    for (const buf of deps.buffers().values()) {
      docs[buf.uri] = { text: buf.text, dirty: buf.dirty };
    }
    return { activeUri: deps.activeUri(), docs };
  }

  // Two snapshots are the same edit-state when every buffer's TEXT matches; dirty + active are
  // ignored, so saving or merely switching files never creates an undo step.
  function sameText(a: HistorySnapshot, b: HistorySnapshot): boolean {
    const ak = Object.keys(a.docs);
    if (ak.length !== Object.keys(b.docs).length) return false;
    for (const uri of ak) {
      if (b.docs[uri]?.text !== a.docs[uri].text) return false;
    }
    return true;
  }

  function publish(): void {
    deps.publish({ canUndo: past.length > 0, canRedo: future.length > 0 });
  }

  // Push the current state as a new step when its text differs from the present baseline; otherwise
  // just refresh the baseline's dirty/active without adding a step.
  function commit(): void {
    const cur = snapshot();
    if (sameText(cur, present)) {
      present = cur;
      return;
    }
    past.push(present);
    if (past.length > maxDepth) past.shift();
    present = cur;
    future = [];
    publish();
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Settle a pending debounced commit immediately (before undo/redo, and on an immediate edit).
  function flush(): void {
    if (timer !== null) {
      clearTimer();
      commit();
    }
  }

  function restore(snap: HistorySnapshot): void {
    restoring = true;
    try {
      const bufs = deps.buffers();
      const active = deps.activeUri();
      for (const [uri, doc] of Object.entries(snap.docs)) {
        const buf = bufs.get(uri);
        if (!buf) continue; // file no longer open (shouldn't happen: structural ops reset history)
        if (buf.text !== doc.text) {
          buf.text = doc.text;
          if (uri === active) deps.editor.setDoc(doc.text);
          else deps.lsp.syncDoc(uri, doc.text);
        }
        buf.dirty = doc.dirty;
      }
      if (snap.activeUri !== active && bufs.has(snap.activeUri)) {
        deps.activateFile(snap.activeUri);
      }
      deps.onRestored();
    } finally {
      restoring = false;
    }
  }

  return {
    get isRestoring() {
      return restoring;
    },
    noteEdit(opts) {
      if (restoring) return;
      clearTimer();
      if (opts?.immediate) {
        commit();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        commit();
      }, debounceMs);
    },
    undo() {
      flush();
      if (past.length === 0) return;
      future.unshift(present);
      present = past.pop()!;
      restore(present);
      publish();
    },
    redo() {
      flush();
      if (future.length === 0) return;
      past.push(present);
      present = future.shift()!;
      restore(present);
      publish();
    },
    reset() {
      clearTimer();
      past = [];
      future = [];
      present = snapshot();
      publish();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- historyController`
Expected: PASS (11 tests). Then `npx tsc --noEmit` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/historyController.ts src/historyController.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): historyController for workspace undo/redo snapshots"
```

---

### Task 3: `<HistoryControls>` — the top-bar Undo/Redo buttons

**Files:**
- Create: `src/panels/HistoryControls.tsx`
- Test: `src/panels/HistoryControls.test.tsx`

**Interfaces:**
- Consumes: `AppState` (`canUndo`/`canRedo` from Task 1).
- Produces: `HistoryControls(props: { store: StoreApi<AppState>; onUndo: () => void; onRedo: () => void; undoTitle: string; redoTitle: string })`. Renders a `<div class="tb-group">` with `[data-role="undo"]` / `[data-role="redo"]` buttons, `disabled` bound to `!canUndo` / `!canRedo`.

- [ ] **Step 1: Write the failing test**

Create `src/panels/HistoryControls.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '../store/index';
import { HistoryControls } from './HistoryControls';

const undoBtn = (c: Element) => c.querySelector('[data-role="undo"]') as HTMLButtonElement;
const redoBtn = (c: Element) => c.querySelector('[data-role="redo"]') as HTMLButtonElement;

describe('HistoryControls', () => {
  test('both buttons start disabled on a fresh store', () => {
    const store = createAppStore();
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(true);
  });

  test('canUndo/canRedo toggle the disabled state', () => {
    const store = createAppStore();
    const { container } = render(
      <HistoryControls store={store} onUndo={() => {}} onRedo={() => {}} undoTitle="Undo" redoTitle="Redo" />,
    );
    act(() => store.getState().setHistoryState({ canUndo: true, canRedo: false }));
    expect(undoBtn(container).disabled).toBe(false);
    expect(redoBtn(container).disabled).toBe(true);
    act(() => store.getState().setHistoryState({ canUndo: false, canRedo: true }));
    expect(undoBtn(container).disabled).toBe(true);
    expect(redoBtn(container).disabled).toBe(false);
  });

  test('clicks call the handlers', () => {
    const store = createAppStore();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    act(() => store.getState().setHistoryState({ canUndo: true, canRedo: true }));
    const { container } = render(
      <HistoryControls store={store} onUndo={onUndo} onRedo={onRedo} undoTitle="Undo" redoTitle="Redo" />,
    );
    fireEvent.click(undoBtn(container));
    fireEvent.click(redoBtn(container));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- HistoryControls`
Expected: FAIL — `Cannot find module './HistoryControls'`.

- [ ] **Step 3: Implement the island**

Create `src/panels/HistoryControls.tsx`:

```tsx
import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '../store/index';

// The top-bar Undo/Redo buttons. Subscribes to the history slice so the buttons enable/disable
// reactively; clicks call into the imperative historyController through plain callbacks, so this panel
// stays free of controller imports (mirrors UnsavedIndicator's onSaveAll seam). Titles are passed in
// already platform-formatted (⌘Z / Ctrl+Z) by ide.tsx via formatChord.
export function HistoryControls(props: {
  store: StoreApi<AppState>;
  onUndo: () => void;
  onRedo: () => void;
  undoTitle: string;
  redoTitle: string;
}) {
  const canUndo = useStore(props.store, (s) => s.canUndo);
  const canRedo = useStore(props.store, (s) => s.canRedo);
  return (
    <div class="tb-group" role="group" aria-label="History">
      <button
        type="button"
        class="icon-btn"
        data-role="undo"
        title={props.undoTitle}
        aria-label="Undo"
        disabled={!canUndo}
        onClick={() => props.onUndo()}
      >
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4 2.5 7.5 6 11M2.5 7.5h6.5a4 4 0 0 1 0 8H8" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        data-role="redo"
        title={props.redoTitle}
        aria-label="Redo"
        disabled={!canRedo}
        onClick={() => props.onRedo()}
      >
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 4 13.5 7.5 10 11M13.5 7.5H7a4 4 0 0 0 0 8h1" />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- HistoryControls`
Expected: PASS (3 tests). Then `npx tsc --noEmit` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/panels/HistoryControls.tsx src/panels/HistoryControls.test.tsx
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): HistoryControls top-bar undo/redo buttons"
```

---

### Task 4: Wire it all together (remove CM history, add the seam, mount, shortcuts)

This is the integration glue. The unit-tested pieces (Tasks 1–3) prove the logic; this task verifies by typecheck + the full suite + a manual smoke test, since the `ide.tsx` boot path is not unit-instantiable.

**Files:**
- Modify: `src/editor.ts:17`, `src/editor.ts:752`, `src/editor.ts:769` (remove CodeMirror history)
- Modify: `src/workspaceController.ts` (add the `onEntriesRefreshed` seam)
- Modify: `index.html` (add the island host)
- Modify: `src/ide.tsx` (construct + wire the controller, mount the island, shortcuts, palette)

**Interfaces:**
- Consumes: `createHistoryController` (Task 2), `HistoryControls` (Task 3), `setHistoryState` (Task 1), and the existing `workspace` / `controller` / `editor` / `lsp` / `appStore` / `formatChord` symbols in `ide.tsx`.
- Produces: a new `onEntriesRefreshed(cb)` seam on `WorkspaceController`.

- [ ] **Step 1: Remove CodeMirror's built-in history (single timeline)**

In `src/editor.ts` line 17, drop `history` and `historyKeymap` from the import:

```ts
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
```

Delete the `history(),` line (currently line 752).

Delete the `...historyKeymap,` line inside the `keymap.of([...])` (currently line 769).

- [ ] **Step 2: Add the `onEntriesRefreshed` seam to the workspace controller**

In `src/workspaceController.ts`, add the seam to the `WorkspaceController` interface (next to `onActiveChanged` / `onBuffersChanged`, around line 178):

```ts
  /** Fired after the explorer entry tree is re-read (a folder open or any structural file op). */
  onEntriesRefreshed(cb: () => void): void;
```

In `createWorkspaceController`, add the backing field next to the other outward seams (around line 192):

```ts
  let entriesRefreshed: (() => void) | null = null;
```

Fire it at the end of `refreshEntries()` (after `renderTree();`, around line 256):

```ts
  async function refreshEntries(): Promise<void> {
    if (folderRoot === '') return;
    try {
      entries = await platform.listEntries(folderRoot);
    } catch (e) {
      console.error('listEntries failed:', e);
    }
    renderTree();
    entriesRefreshed?.();
  }
```

Register the method in the returned object (next to `onBuffersChanged`, around line 775):

```ts
    onEntriesRefreshed(cb) {
      entriesRefreshed = cb;
    },
```

- [ ] **Step 3: Add the island host to the toolbar**

In `index.html`, insert a divider + host right after the New/Open `tb-group` closes (after its `</div>` on line 34, before the existing `<span class="tb-divider">` on line 35):

```html
          <span class="tb-divider" aria-hidden="true"></span>
          <div id="history-controls-host"></div>
```

Result order in the toolbar: New | Open · Undo | Redo · Generate · Check.

- [ ] **Step 4: Import the new modules in `ide.tsx`**

Near the other imports (the `render` import is at line 74, `UnsavedIndicator` at 75, `createWorkspaceController` at 79):

```ts
import { createHistoryController } from './historyController';
import { HistoryControls } from './panels/HistoryControls';
```

- [ ] **Step 5: Construct the history controller and mount the island**

In `src/ide.tsx`, immediately AFTER the `workspace = createWorkspaceController({ ... });` call closes (just before `workspace.onActiveChanged(...)` at line 807), add:

```ts
  // The workspace-level undo/redo timeline (code = the single source of truth). It snapshots the open
  // buffers' text; restore writes code back and onRestored re-derives every view. canUndo/canRedo are
  // published into the store for the <HistoryControls> buttons.
  const history = createHistoryController({
    buffers: () => workspace.buffers,
    activeUri: () => workspace.activeUri(),
    editor: { getDoc: () => editor.getDoc(), setDoc: (d) => editor.setDoc(d) },
    lsp: { syncDoc: (uri, text) => lsp.syncDoc(uri, text) },
    activateFile: (uri) => workspace.activateFile(uri),
    onRestored: () => {
      controller.onDocEdited();
      workspace.renderTree();
    },
    publish: (s) => appStore.getState().setHistoryState(s),
  });
  // Reset history whenever the explorer tree is re-read: a folder open (fresh baseline) or any
  // structural file op (rename/move/delete/create) whose snapshots would reference stale uris.
  workspace.onEntriesRefreshed(() => history.reset());
  // The top-bar Undo/Redo buttons (reactive enable/disable via the store).
  render(
    <HistoryControls
      store={appStore}
      onUndo={() => history.undo()}
      onRedo={() => history.redo()}
      undoTitle={`Undo (${formatChord('mod+Z')})`}
      redoTitle={`Redo (${formatChord('mod+Shift+Z')})`}
    />,
    el('history-controls-host'),
  );
```

(`history` is referenced by the `onChange`/`onBuffersChanged` closures defined earlier in the same function; like the existing `workspace`/`controller` references there, it resolves at call time — those callbacks only fire after init completes.)

- [ ] **Step 6: Capture typing edits in `onChange`**

In the `editorSession.onChange((doc) => { ... })` handler (lines 373–380), add the `noteEdit` call after `controller.onDocEdited();`:

```ts
  editorSession.onChange((doc) => {
    if (welcome.visible) welcome.hide();
    const becameDirty = workspace.syncActiveBuffer(doc);
    controller.onDocEdited();
    if (!history.isRestoring) history.noteEdit();
    if (becameDirty) workspace.renderTree();
  });
```

- [ ] **Step 7: Capture structured edits in `onBuffersChanged`**

In the `workspace.onBuffersChanged(() => { ... })` callback (lines 817–819), commit immediately so each structured/cross-file edit is one discrete step:

```ts
  workspace.onBuffersChanged(() => {
    controller.onDocEdited();
    history.noteEdit({ immediate: true });
  });
```

- [ ] **Step 8: Bind the global keyboard shortcuts**

Add a new `window` keydown listener next to the existing save listener (after the block ending at line ~862). `overlayOpen` and `history` are in scope:

```ts
  // Undo/redo drive the single workspace history (CodeMirror's own history was removed). Match on
  // e.code (physical Z/Y) so macOS Option-composed glyphs don't slip past.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlayOpen()) return;
    if (e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    } else if (e.code === 'KeyY' && !e.shiftKey) {
      e.preventDefault();
      history.redo();
    }
  });
```

- [ ] **Step 9: Add palette commands (discoverability)**

In the command list (the `cmds` array near line 1199, next to the `format` entry), add:

```ts
      { id: 'undo', title: 'Undo', hint: 'mod+Z', group: 'Edit', run: () => history.undo() },
      { id: 'redo', title: 'Redo', hint: 'mod+Shift+Z', group: 'Edit', run: () => history.redo() },
```

- [ ] **Step 10: Dim disabled buttons (only if not already styled)**

Check whether disabled icon-buttons are already dimmed:

Run: `grep -rn "icon-btn" src/**/*.scss src/*.scss styles 2>/dev/null | grep -i "disabled"`

If there is NO existing `:disabled` rule for `.icon-btn`, add one to the stylesheet that defines `.icon-btn` (find it with `grep -rln "\.icon-btn" --include=*.scss .`):

```scss
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
  pointer-events: none;
}
```

If a `:disabled` rule already exists, skip this step.

- [ ] **Step 11: Typecheck and run the full suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS — all existing tests plus the new history/historyController/HistoryControls suites green. If any existing editor test asserted CodeMirror undo behaviour, update it to reflect that the editor no longer owns history (search: `grep -rn "history\|undo\|redo" src/editor.test.ts` if that file exists).

- [ ] **Step 12: Manual smoke test**

Use the `run-studio-web` skill to launch Studio Web, then verify:
1. Type in the code editor, pause, type again → the top-bar Undo button enables; clicking it (and `Cmd/Ctrl+Z`) steps back a burst at a time; Redo replays.
2. Make a structured edit (e.g. add/connect a type on the diagram, or rename via the inspector) → Undo reverts it in one step and the diagram/inspector update to match the restored code.
3. Undo a change in one file, confirm the editor switches to the affected file and the view follows.
4. Open a different folder / New model → Undo and Redo both disable (history cleared).

- [ ] **Step 13: Commit**

```bash
git add src/editor.ts src/workspaceController.ts index.html src/ide.tsx
# include the stylesheet from Step 10 if you changed it
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): wire workspace undo/redo into the top bar and shortcuts"
```

---

## Self-Review

**Spec coverage:**
- Single unified timeline / remove CM history → Task 4 Step 1 + Step 8. ✓
- Per typing-burst coalescing → Task 2 (`noteEdit` debounce) + Task 4 Step 6. ✓
- Snapshot whole open buffer set with `{ text, dirty }` → Task 2 `snapshot()`. ✓
- Controller owns truth, slice projects `canUndo`/`canRedo` → Tasks 1 + 2. ✓
- `<HistoryControls>` island in the top bar with reactive disable → Tasks 3 + 4 Steps 3, 5. ✓
- Restore writes code back + views re-derive via `onDocEdited` → Task 2 `restore()` + Task 4 Step 5 (`onRestored`). ✓
- Multi-file structured edit = one step → Task 2 multi-file test + Task 4 Step 7. ✓
- Structured edits commit immediately; typing debounced → Task 4 Steps 6–7. ✓
- Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z → Task 4 Step 8. ✓
- Clear history on workspace swap / structural file ops → Task 4 Step 2 + Step 5 (`onEntriesRefreshed` → `reset`). ✓
- Dirty restored from snapshot → Task 2 `restore()` sets `buf.dirty`. ✓
- Depth cap → Task 2 `maxDepth`. ✓
- Tests: controller unit, slice, island, integration smoke → Tasks 1–4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `setHistoryState({ canUndo, canRedo })` is identical across the slice (Task 1), the controller's `publish` (Task 2), and the wiring (Task 4). `HistoryController` surface (`isRestoring`, `noteEdit`, `undo`, `redo`, `reset`) matches between Task 2's definition and Task 4's calls. `HistoryControls` props (`store`, `onUndo`, `onRedo`, `undoTitle`, `redoTitle`) match between Task 3 and Task 4 Step 5. `onEntriesRefreshed` added in Task 4 Step 2 and consumed in Step 5. ✓

**Known limitation (documented in the spec):** undoing across a save boundary may show a file as dirty when its text actually matches disk (snapshots carry the dirty flag at capture time, not save-point tracking). Harmless; out of scope.
