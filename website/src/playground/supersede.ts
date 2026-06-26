// A per-operation superseder (#353): a sequence of calls where each new operation cancels the previous
// one's in-flight work. The playground holds one per *logical* operation (compile-on-change, lint) and
// passes each `next()` signal to `compile`/`diagnose`; a newer edit calls `next()` again, aborting the
// prior call's AbortSignal so the worker client drops that call's pending id. Because each operation has
// its own superseder, independent operations never cancel each other.

export interface Superseder {
  /** Start a new operation: abort the previous one (if any) and return a fresh, un-aborted signal. */
  next(): AbortSignal;
  /** Abort the in-flight operation without starting a new one (e.g. a hard Stop). */
  abort(): void;
}

/** Create a {@link Superseder}. */
export function createSuperseder(): Superseder {
  let current: AbortController | null = null;
  return {
    next(): AbortSignal {
      current?.abort();
      current = new AbortController();
      return current.signal;
    },
    abort(): void {
      current?.abort();
      current = null;
    },
  };
}
