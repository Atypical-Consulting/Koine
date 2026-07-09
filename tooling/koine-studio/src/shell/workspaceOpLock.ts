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
  return {
    run<T>(op: () => Promise<T>): Promise<T> {
      const run = queue.catch(() => {}).then(op);
      queue = run.catch(() => {});
      return run;
    },
  };
}
