// The workspace-open mutex, extracted from lifecycleBoot.ts's private closure (#1088). It was scoped
// to createLifecycleBoot when #1046 introduced it, which serialized only the boot ladder's own
// branches — the toolbar's Open-folder button, the mod+N / mod+Shift+O shortcuts, the command
// palette, and the reactive onWorkspaceEmptied callback reach the SAME newModel()/openFolder() through
// ide.tsx and never saw the lock. It lives here now so ide.tsx's composition root can create exactly
// one instance per boot and hand it to every workspace-opening entry point.

/** A FIFO mutex over the workspace-opening operations (import a share, New, Open folder, restore). */
export interface WorkspaceOpLock {
  /**
   * Queue `op` behind whatever is already running and resolve/reject with its result. A queued op is
   * NOT started until its turn comes, so it must re-check its own preconditions (e.g. hasOpenWorkspace())
   * when it runs rather than trusting what it read before queueing — the state it queued against may
   * have been changed by the op ahead of it (#1088).
   */
  run<T>(op: () => Promise<T>): Promise<T>;
  /**
   * True from the moment an op is enqueued until the queue drains (#1275). Synchronous at enqueue —
   * a handler that just called run() already reads busy — and derived from the queue itself, so it
   * cannot drift; a REJECTED op clears it exactly as it releases the lock.
   */
  busy(): boolean;
  /**
   * Subscribe to busy TRANSITIONS (#1275): fired with `true` when an idle lock takes its first op and
   * with `false` when the queue drains — never once per enqueued op. Returns an unsubscribe.
   */
  onBusyChanged(cb: (busy: boolean) => void): () => void;
}

/**
 * Create an independent lock. Production creates one per init(); each boot's lock is isolated, so a
 * torn-down IDE's in-flight op can never block the next one's.
 *
 * A failed op releases the lock rather than wedging the queue: the chained `.catch(() => {})` swallows
 * the rejection for the QUEUE's purposes only — the caller still receives it through the returned
 * promise, so nothing silently loses an error.
 */
export function createWorkspaceOpLock(): WorkspaceOpLock {
  let queue: Promise<unknown> = Promise.resolve();
  // The number of ops enqueued but not yet settled — busy() derives from it, so the flag can never
  // outlive (or lag) the queue it describes. Snapshot the listener set per notify so an unsubscribe
  // during delivery can't skip a sibling.
  let pending = 0;
  const listeners = new Set<(busy: boolean) => void>();
  const notify = (busy: boolean): void => {
    for (const cb of [...listeners]) cb(busy);
  };
  return {
    run<T>(op: () => Promise<T>): Promise<T> {
      pending += 1;
      if (pending === 1) notify(true); // idle → busy: the first op of a burst flips the flag
      const run = queue.catch(() => {}).then(op);
      // Settle accounting rides the same swallowed-rejection link the queue already chains on, so a
      // rejected op both releases the lock AND clears busy; the caller still sees the error via `run`.
      const settled = (): void => {
        pending -= 1;
        if (pending === 0) notify(false); // the whole queue drained, not just this op
      };
      queue = run.then(settled, settled);
      return run;
    },
    busy: () => pending > 0,
    onBusyChanged(cb: (busy: boolean) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
