import type { Buffer } from '@/shell/workspaceController';

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
  /** Write a restored buffer's text+dirty through the workspace slice's `upsertBuffer` — never
   *  mutate the Map's objects in place. */
  writeBuffer(uri: string, text: string, dirty: boolean): void;
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
        const textChanged = buf.text !== doc.text;
        if (textChanged) {
          if (uri === active) deps.editor.setDoc(doc.text);
          else deps.lsp.syncDoc(uri, doc.text);
        }
        // Write text+dirty back through the slice's immutable upsertBuffer (never mutate `buf` in
        // place) — skip the call entirely when neither field actually changed, so an untouched
        // buffer doesn't churn a needless new Map.
        if (textChanged || buf.dirty !== doc.dirty) {
          deps.writeBuffer(uri, doc.text, doc.dirty);
        }
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
