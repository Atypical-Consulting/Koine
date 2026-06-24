// The brain of inline (ghost-text) AI completions: a pure debounce → fetch → show → accept/dismiss
// state machine, deliberately free of any DOM, CodeMirror, or network knowledge so it can be unit-tested
// in isolation. The editor extension (inlineCompletion.ts) feeds it edits via onType() and renders
// whatever it surfaces; the AI client (inlineCompletionClient.ts) is injected as `fetch`.
//
// The two hard parts it owns: (1) a debounce so we don't fire a request on every keystroke, and
// (2) invalidation — an edit must abort the in-flight request AND make sure a request that resolves
// *after* it can never paint a now-stale suggestion. Both are handled with a single monotonic `seq`.

/** Where the machine is: nothing to show, a request in flight (or debouncing), or a suggestion on screen. */
export type InlineStatus = 'idle' | 'pending' | 'showing';

export interface InlineStateOptions<Ctx> {
  /** Idle delay after the last keystroke before a request fires. */
  debounceMs: number;
  /** Master gate — when false, typing never schedules a request (the prefs toggle, default off). */
  isEnabled: () => boolean;
  /** Per-context gate: only suggest at sensible spots (cursor at a boundary, no selection, …). */
  canSuggest: (ctx: Ctx) => boolean;
  /** Fetch a continuation for the context. Must honor `signal`, which is aborted on the next edit. */
  fetch: (ctx: Ctx, signal: AbortSignal) => Promise<string | null>;
}

export interface InlineState<Ctx> {
  /** Call on every edit with the current context; (re)starts the debounce or clears, per the gates. */
  onType(ctx: Ctx): void;
  /** Accept the shown suggestion: returns its text and clears, or null when nothing is shown. */
  accept(): string | null;
  /** Drop any pending/shown suggestion and abort an in-flight request. */
  dismiss(): void;
  readonly status: InlineStatus;
  readonly suggestion: string | null;
  /** The context the shown suggestion was computed for (null while idle/pending). */
  readonly context: Ctx | null;
  /**
   * Set by the view layer to be notified when the *rendered* state changes. The synchronous
   * transitions inside onType() also fire this, but the view that called onType is already mid-update;
   * its real value is the async transition (a resolved fetch) that no transaction is driving.
   */
  onChange: (() => void) | null;
}

export function createInlineState<Ctx>(opts: InlineStateOptions<Ctx>): InlineState<Ctx> {
  let status: InlineStatus = 'idle';
  let suggestion: string | null = null;
  let context: Ctx | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let aborter: AbortController | null = null;
  // Monotonic request id. Bumped whenever we cancel or start a request, so a fetch that resolves after
  // being superseded sees `mySeq !== seq` and drops its result instead of painting a stale suggestion.
  let seq = 0;

  const api: InlineState<Ctx> = {
    onChange: null,
    get status() {
      return status;
    },
    get suggestion() {
      return suggestion;
    },
    get context() {
      return context;
    },
    onType,
    accept,
    dismiss,
  };

  function setState(next: InlineStatus, sug: string | null, ctx: Ctx | null): void {
    const changed = status !== next || suggestion !== sug;
    status = next;
    suggestion = sug;
    context = ctx;
    if (changed) api.onChange?.();
  }

  /** Tear down a scheduled debounce + an in-flight fetch and invalidate any result still settling. */
  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (aborter) {
      aborter.abort();
      aborter = null;
    }
    seq++;
  }

  function onType(ctx: Ctx): void {
    // A new edit invalidates whatever was scheduled, in flight, or already on screen.
    cancel();
    if (!opts.isEnabled() || !opts.canSuggest(ctx)) {
      setState('idle', null, null);
      return;
    }
    setState('pending', null, null);
    timer = setTimeout(() => {
      timer = null;
      start(ctx);
    }, opts.debounceMs);
  }

  function start(ctx: Ctx): void {
    const mySeq = ++seq;
    const controller = new AbortController();
    aborter = controller;
    opts
      .fetch(ctx, controller.signal)
      .then((result) => {
        // Superseded by a newer edit (or aborted) → drop silently; the newer request owns the screen.
        if (mySeq !== seq || controller.signal.aborted) return;
        aborter = null;
        if (result && result.length > 0) {
          setState('showing', result, ctx);
        } else {
          setState('idle', null, null);
        }
      })
      .catch(() => {
        // The client is contracted never to throw, but stay defensive: a failure just means no ghost.
        if (mySeq !== seq) return;
        aborter = null;
        setState('idle', null, null);
      });
  }

  function accept(): string | null {
    if (status !== 'showing' || suggestion === null) return null;
    const text = suggestion;
    cancel();
    setState('idle', null, null);
    return text;
  }

  function dismiss(): void {
    cancel();
    setState('idle', null, null);
  }

  return api;
}
