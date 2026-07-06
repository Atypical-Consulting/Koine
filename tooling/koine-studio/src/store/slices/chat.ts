import type { StoreApi } from 'zustand/vanilla';
import type { ChatMessage } from '@/ai/ai';
import type { StagedEdit } from '@/ai/editSession';

/** One reviewed file inside the pending change set. */
export interface ChangeSetFileState {
  /**
   * The staged edit's OPAQUE session key (buffer uri, or `new:<relPath>` for a brand-new file,
   * #472): the row identity every per-file action keys by. `relPath` is only the display label —
   * NOT unique across the roots of a multi-root workspace.
   */
  readonly key: string;
  readonly relPath: string;
  /**
   * The TOOL-LAYER display label the model addressed this file by (#472): the disambiguated
   * `relPath@n` marker when several roots share the relPath, else the bare relPath. Carried onto the
   * row at stage time — the SINGLE source the review renders — so the label under review can never
   * swap relative to the paths the model listed/wrote (row order is STAGE order, not session order).
   */
  readonly display: string;
  readonly body: string;
  /** From {@link StagedEdit}: brand-new file vs revision of an existing workspace file. */
  readonly isNew: boolean;
  /** Send-time text the reviewed diff was computed against (`''` for new files). */
  readonly before: string;
  /** The accept checkbox. */
  readonly accepted: boolean;
  /** Sticky once marked at apply time (#473) — never unset. */
  readonly drifted: boolean;
}

/**
 * One tool call inside the EPHEMERAL streaming turn (#990 Task 4): the state behind a
 * `koi-assistant-tool` card. Mirrors exactly what the imperative panel's card displays — nothing more.
 */
export interface ChatToolCall {
  /** The per-turn call id from ai.ts's ToolCallStart/End (1, 2, …) — the card correlation key. */
  readonly id: number;
  readonly name: string;
  /** The raw argsJson the model produced (pretty-printed at render time, like the card's dataset.args). */
  readonly args: string;
  /** The card's data-state: pending on START, ok/error once the END event settles it. */
  readonly state: 'pending' | 'ok' | 'error';
  /** The chip text on the card's summary row (ToolCallEnd.summary); null while pending. */
  readonly summary: string | null;
  /**
   * The card body's Result text — the tool's resultText on success, the error message on failure
   * (the caller folds ToolCallEnd exactly as the imperative card did). Stored RAW; the renderer
   * clamps it to TOOL_RESULT_CLAMP with a "(truncated)" note. Null while pending.
   */
  readonly result: string | null;
  readonly durationMs: number | null;
}

/**
 * The live turn while `status === 'streaming'` (#990 Task 4): the accumulated streamed text plus the
 * tool-call cards opened so far, in call order. EPHEMERAL — NEVER persisted: persistence only ever
 * saves `messages`; this exists solely so the declarative Transcript can render what the imperative
 * panel kept as loose DOM (the streaming bubble and its live-DOM tool-card Map).
 */
export interface ChatStreamingTurn {
  /** The streamed text so far. Reset when a tool call starts — that text was a "thinking" preamble. */
  readonly text: string;
  readonly toolCalls: readonly ChatToolCall[];
}

export type ChangeSetPhase =
  | { kind: 'reviewing'; note?: string } // note carries the #633 apply-failure / partial-failure message
  | { kind: 'applying' }
  | { kind: 'applied'; appliedCount: number } // terminal
  | { kind: 'invalidated'; reason: string }; // terminal (#473/#684)

export interface ChatChangeSetState {
  /** Monotonic per staged set — strictly increasing across the store's lifetime, even across discard. */
  readonly id: number;
  readonly files: readonly ChangeSetFileState[];
  readonly diagnostics: string | null;
  readonly phase: ChangeSetPhase;
}

export interface ChatSlice {
  /** The assistant transcript and turn lifecycle for the active workspace. */
  chat: {
    /** Workspace the transcript belongs to (guards against cross-workspace replays). */
    readonly workspaceKey: string;
    /** The transcript, oldest first; every mutation produces a new array identity. */
    readonly messages: readonly ChatMessage[];
    /** Turn lifecycle: idle → streaming → idle (finish) or error (aborted with rollback). */
    readonly status: 'idle' | 'streaming' | 'error';
    /**
     * The EPHEMERAL live turn — non-null only while streaming, cleared by finish/abort. NEVER
     * persisted (persistence only ever saves `messages`); see {@link ChatStreamingTurn}.
     */
    readonly turn: ChatStreamingTurn | null;
    /** The pending change-set review, or null when nothing is staged. */
    readonly changeSet: ChatChangeSetState | null;
    /**
     * The composer textarea's text (#990 Task 5), so the declarative Composer renders it CONTROLLED
     * and the host's error-rollback restore lands as a plain `setChatDraft(prompt)` dispatch.
     * EPHEMERAL — never persisted (persistence only ever saves `messages`), and untouched by the
     * turn lifecycle / hydrateChat, so unsent text survives a failed turn and a workspace swap.
     */
    readonly draft: string;
  };
  /**
   * Replace key + transcript on workspace switch. NO-OP while streaming — a mid-stream workspace
   * reassignment must not clobber the live turn. A DIFFERENT-key hydrate also drops the pending
   * change set (its staged bodies were computed against the old workspace's buffers) and the
   * ephemeral turn (belt-and-braces — already null when not streaming); a same-key hydrate keeps
   * them, so a panel re-show never kills a review in progress.
   */
  hydrateChat(workspaceKey: string, messages: readonly ChatMessage[]): void;
  /** Append one turn immutably (new array identity, prior snapshot untouched). */
  appendChatMessage(msg: ChatMessage): void;
  /**
   * idle|error → streaming, seeding an empty {@link ChatStreamingTurn}; no-op if a turn is already
   * streaming (in particular, the live turn's accumulated text/cards are never clobbered).
   */
  startChatTurn(): void;
  /** streaming → idle; drops the ephemeral turn. */
  finishChatTurn(): void;
  /**
   * Drop the ephemeral turn while KEEPING the streaming status (#990 Task 6). The send effect
   * commits the finished reply to `messages` BEFORE its post-turn work settles (the bounded
   * parse-and-repair loop still runs LLM turns under the same busy window), so without this the
   * transcript would render the committed bubble AND the stale streaming bubble side by side.
   * No-op when no turn is live.
   */
  clearStreamingTurn(): void;
  /**
   * Abort the live turn (dropping the ephemeral turn). rollbackUserTurn: true pops exactly the
   * trailing message if it is the just-sent user turn and sets status 'error'; false keeps the
   * transcript intact → 'idle'.
   */
  abortChatTurn(opts: { rollbackUserTurn: boolean }): void;
  /** Accumulate a streamed text delta onto the live turn; no-op when no turn is streaming. */
  appendStreamingText(delta: string): void;
  /**
   * Open a pending tool-call card on the live turn. Also clears the accumulated text — anything
   * streamed before a tool call was a "thinking" preamble, and the imperative panel cleared it so
   * the card and the eventual answer render in chronological order. No-op when not streaming.
   */
  startToolCall(call: { id: number; name: string; args: string }): void;
  /**
   * Settle the SAME pending entry `startToolCall` opened (keyed by id, order preserved). `result`
   * is the card body's Result text — resultText on ok, the error message on error. No-op when not
   * streaming or when the id is unknown.
   */
  completeToolCall(end: {
    id: number;
    state: 'ok' | 'error';
    summary: string;
    result: string;
    durationMs: number;
  }): void;
  /**
   * Empty the transcript AND retire any pending change set — the review belongs to the cleared
   * conversation and must not outlive it. The workspace key and status are untouched.
   */
  clearChatTranscript(): void;
  /** Replace the composer draft ('' clears it). The only writer of `chat.draft`. */
  setChatDraft(text: string): void;
  /**
   * Replace the change set with a fresh reviewing one (monotonic id, all files accepted, none
   * drifted); `before` supplies each staged edit's send-time text keyed by its opaque KEY (#472),
   * defaulting to `''` for new files. `display` supplies each key's tool-layer display label (the
   * `relPath@n` marker for a relPath shared across roots); a key without an entry — or no map at
   * all, for single-root/legacy callers — falls back to the bare relPath.
   */
  stageChangeSet(
    files: readonly StagedEdit[],
    before: Record<string, string>,
    diagnostics: string | null,
    display?: Record<string, string>,
  ): void;
  /** Toggle one file's accept checkbox, addressed by its staged-edit KEY (#472); works in
   *  reviewing AND applying, no-op once terminal. */
  setChangeSetFileAccepted(key: string, accepted: boolean): void;
  /** Set `drifted: true` on the files named by KEY — sticky (never unsets) and idempotent (#473). */
  markChangeSetDrift(keys: readonly string[]): void;
  /** reviewing → applying; no-op unless reviewing with at least one accepted file. */
  beginChangeSetApply(): void;
  /**
   * Settle an apply: no failures → terminal `applied` counting the files actually WRITTEN (accepted
   * minus the drift-skipped rows — the host marks drift before beginChangeSetApply, #473); any
   * failures → back to `reviewing` with a note naming them so retry stays open (no false Applied).
   * No-op unless applying — in particular after invalidation (#684).
   */
  resolveChangeSetApply(result: { failed: readonly string[] }): void;
  /** applying → reviewing with the error note (#633: the in-flight lock must never stay stuck); no-op unless applying (#684). */
  rejectChangeSetApply(error: string): void;
  /** reviewing | applying → invalidated; NO-OP on terminal `applied` (the "Applied ✓" survives) and on null. */
  invalidateChangeSet(reason: string): void;
  /** Drop the change set entirely. */
  discardChangeSet(): void;
}

export function createChatSlice(
  set: StoreApi<ChatSlice>['setState'],
  get: StoreApi<ChatSlice>['getState'],
): ChatSlice {
  // Strictly increasing across this store's lifetime, even across discard — a stale async apply
  // resolving against a NEWER set can be detected by comparing ids.
  let nextChangeSetId = 1;

  const setChangeSet = (changeSet: ChatChangeSetState | null): void => {
    set({ chat: { ...get().chat, changeSet } });
  };

  return {
    chat: {
      workspaceKey: 'scratch',
      messages: [],
      status: 'idle',
      turn: null,
      changeSet: null,
      draft: '',
    },
    hydrateChat: (workspaceKey, messages) => {
      const chat = get().chat;
      if (chat.status === 'streaming') return;
      if (workspaceKey !== chat.workspaceKey) {
        // A workspace SWAP takes the staged review with it: the change set's bodies were computed
        // against the old workspace's buffers, so it must not stay applyable over another folder.
        // The ephemeral turn is dropped too (belt-and-braces — already null when not streaming).
        set({ chat: { ...chat, workspaceKey, messages: [...messages], changeSet: null, turn: null } });
        return;
      }
      set({ chat: { ...chat, workspaceKey, messages: [...messages] } });
    },
    appendChatMessage: (msg) => {
      const chat = get().chat;
      set({ chat: { ...chat, messages: [...chat.messages, msg] } });
    },
    startChatTurn: () => {
      const chat = get().chat;
      if (chat.status === 'streaming') return;
      set({ chat: { ...chat, status: 'streaming', turn: { text: '', toolCalls: [] } } });
    },
    finishChatTurn: () => {
      set({ chat: { ...get().chat, status: 'idle', turn: null } });
    },
    clearStreamingTurn: () => {
      const chat = get().chat;
      if (!chat.turn) return;
      set({ chat: { ...chat, turn: null } });
    },
    abortChatTurn: ({ rollbackUserTurn }) => {
      const chat = get().chat;
      if (rollbackUserTurn) {
        const last = chat.messages[chat.messages.length - 1];
        const messages = last?.role === 'user' ? chat.messages.slice(0, -1) : chat.messages;
        set({ chat: { ...chat, messages, status: 'error', turn: null } });
      } else {
        set({ chat: { ...chat, status: 'idle', turn: null } });
      }
    },
    appendStreamingText: (delta) => {
      const chat = get().chat;
      if (!chat.turn) return;
      set({ chat: { ...chat, turn: { ...chat.turn, text: chat.turn.text + delta } } });
    },
    startToolCall: (call) => {
      const chat = get().chat;
      if (!chat.turn) return;
      const opened: ChatToolCall = {
        ...call,
        state: 'pending',
        summary: null,
        result: null,
        durationMs: null,
      };
      // Clear the streamed preamble alongside opening the card (see the interface doc).
      set({ chat: { ...chat, turn: { text: '', toolCalls: [...chat.turn.toolCalls, opened] } } });
    },
    completeToolCall: ({ id, state, summary, result, durationMs }) => {
      const chat = get().chat;
      if (!chat.turn || !chat.turn.toolCalls.some((c) => c.id === id)) return;
      set({
        chat: {
          ...chat,
          turn: {
            ...chat.turn,
            toolCalls: chat.turn.toolCalls.map((c) =>
              c.id === id ? { ...c, state, summary, result, durationMs } : c,
            ),
          },
        },
      });
    },
    clearChatTranscript: () => {
      // The change set goes with the conversation it reviewed (the retired imperative panel's
      // rebuild dropped it on Clear too — one owner, same behavior).
      set({ chat: { ...get().chat, messages: [], changeSet: null } });
    },
    setChatDraft: (text) => {
      set({ chat: { ...get().chat, draft: text } });
    },
    stageChangeSet: (files, before, diagnostics, display) => {
      setChangeSet({
        id: nextChangeSetId++,
        files: files.map((f) => ({
          key: f.key,
          relPath: f.relPath,
          display: display?.[f.key] ?? f.relPath,
          body: f.body,
          isNew: f.isNew,
          before: before[f.key] ?? '',
          accepted: true,
          drifted: false,
        })),
        diagnostics,
        phase: { kind: 'reviewing' },
      });
    },
    setChangeSetFileAccepted: (key, accepted) => {
      const cs = get().chat.changeSet;
      if (!cs || (cs.phase.kind !== 'reviewing' && cs.phase.kind !== 'applying')) return;
      setChangeSet({
        ...cs,
        files: cs.files.map((f) => (f.key === key ? { ...f, accepted } : f)),
      });
    },
    markChangeSetDrift: (keys) => {
      const cs = get().chat.changeSet;
      if (!cs) return;
      setChangeSet({
        ...cs,
        files: cs.files.map((f) => (keys.includes(f.key) ? { ...f, drifted: true } : f)),
      });
    },
    beginChangeSetApply: () => {
      const cs = get().chat.changeSet;
      if (!cs || cs.phase.kind !== 'reviewing') return;
      if (!cs.files.some((f) => f.accepted)) return;
      setChangeSet({ ...cs, phase: { kind: 'applying' } });
    },
    resolveChangeSetApply: ({ failed }) => {
      const cs = get().chat.changeSet;
      if (!cs || cs.phase.kind !== 'applying') return;
      const phase: ChangeSetPhase =
        failed.length === 0
          ? // Truthful count: what was actually written — a drifted row was skipped by the host's
            // apply (never written), so it must not inflate the terminal "Applied N" (#473).
            { kind: 'applied', appliedCount: cs.files.filter((f) => f.accepted && !f.drifted).length }
          : { kind: 'reviewing', note: `Failed to apply: ${failed.join(', ')}` };
      setChangeSet({ ...cs, phase });
    },
    rejectChangeSetApply: (error) => {
      const cs = get().chat.changeSet;
      if (!cs || cs.phase.kind !== 'applying') return;
      setChangeSet({ ...cs, phase: { kind: 'reviewing', note: error } });
    },
    invalidateChangeSet: (reason) => {
      const cs = get().chat.changeSet;
      if (!cs || (cs.phase.kind !== 'reviewing' && cs.phase.kind !== 'applying')) return;
      setChangeSet({ ...cs, phase: { kind: 'invalidated', reason } });
    },
    discardChangeSet: () => {
      setChangeSet(null);
    },
  };
}
