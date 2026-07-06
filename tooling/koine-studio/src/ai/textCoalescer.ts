// Per-frame coalescing for the assistant's streamed text deltas (#984 follow-up). The provider
// streams MANY small deltas per second, and dispatching one store set() per delta makes every
// subscriber pay per token — the Transcript's full keyed re-render + autoscroll layout read, the
// StoreInspector, anything else on the store. The host buffers deltas here and flushes ONE
// `appendStreamingText(buffered)` per animation frame instead.
//
// The ORDERING contract is the load-bearing part: the buffer is invisible to the store, so the host
// MUST `flushNow()` (which also cancels the pending frame) before any semantic boundary that reads or
// clears the live turn's text — a tool call starting (the chat slice clears `turn.text` there, so a
// late flush would resurrect the discarded "thinking" preamble), committing or aborting the turn, and
// anything else that consumes `turn.text`. A pending frame left uncancelled past the turn's end could
// otherwise leak one turn's tail into the NEXT turn's freshly seeded text.

export interface TextCoalescer {
  /** Buffer one streamed delta and schedule a flush on the next animation frame. */
  push(delta: string): void;
  /**
   * Flush the buffered text synchronously and cancel the pending frame. Idempotent and safe on an
   * empty buffer (no store dispatch happens), so hosts call it unconditionally at every boundary.
   */
  flushNow(): void;
}

/**
 * Make a coalescer that accumulates pushed deltas and hands the concatenation to `flush` once per
 * animation frame — falling back to a ~frame-length `setTimeout` where `requestAnimationFrame`
 * doesn't exist (non-window contexts; happy-dom builds without the shim).
 */
export function makeTextCoalescer(flush: (text: string) => void): TextCoalescer {
  let buffer = '';
  /** Cancels the scheduled flush; null when nothing is pending. */
  let cancelPending: (() => void) | null = null;

  const flushBuffered = (): void => {
    cancelPending = null;
    if (!buffer) return;
    const text = buffer;
    buffer = '';
    flush(text);
  };

  const schedule = (): void => {
    if (cancelPending) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(flushBuffered);
      cancelPending = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(flushBuffered, 16);
      cancelPending = () => clearTimeout(id);
    }
  };

  return {
    push(delta) {
      if (!delta) return;
      buffer += delta;
      schedule();
    },
    flushNow() {
      cancelPending?.();
      flushBuffered();
    },
  };
}
