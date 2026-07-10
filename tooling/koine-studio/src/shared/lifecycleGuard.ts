// Six sibling controllers (inspectorController, surfaceLoaders, centerDeckController,
// activeContextController, contextMapPanel, domainNavigator) each hand-roll the same two races: "am I
// still mounted" (a local `let disposed = false`, flipped by dispose() and checked after every `await`)
// and, in several of them, "is this specific async operation still the latest one I asked for" (one or
// more local `let xSeq = 0` monotonic counters, compared post-await via a closure like
// `const isCurrent = () => !disposed && seq === xSeq`). This is that pattern promoted to one shared,
// tested primitive (#1352) so a controller declares its guard once and, per independent async race it
// runs, a sequence — instead of re-deriving the disposed-flag/counter dance by hand in each file.
// statusBar.tsx has the same disposed-only shape but is out of this issue's scope — tracked as a
// follow-up rather than folded in here.
/** An independent staleness axis a LifecycleGuard mints — call createSequence() once per concurrent
 *  async race a controller runs. Named and exported (rather than left as createSequence()'s inline
 *  return type) so a helper that wants to accept "a sequence" as a parameter has something to import. */
export interface LifecycleSequence {
  /** Mints a new current token, superseding whatever the sequence's prior token was. */
  next(): number;
  /** True only if the guard isn't disposed AND no later next() call has superseded this token. */
  isCurrent(token: number): boolean;
}

export interface LifecycleGuard {
  /** Marks the guard torn down. Idempotent — every sequence's isCurrent() returns false from here on. */
  dispose(): void;
  /** True once dispose() has been called. */
  isDisposed(): boolean;
  /** An independent staleness axis — call once per concurrent async race a controller runs. */
  createSequence(): LifecycleSequence;
}

/** Creates a fresh, independent lifecycle guard: one disposed flag shared by every sequence it mints. */
export function createLifecycleGuard(): LifecycleGuard {
  let disposed = false;

  return {
    dispose(): void {
      disposed = true;
    },
    isDisposed(): boolean {
      return disposed;
    },
    createSequence() {
      // Each sequence owns its own counter, so bumping one sequence never affects another's
      // isCurrent() — they only share the guard's `disposed` flag above.
      let current = 0;
      return {
        next(): number {
          current += 1;
          return current;
        },
        isCurrent(token: number): boolean {
          return !disposed && token === current;
        }
      };
    }
  };
}
