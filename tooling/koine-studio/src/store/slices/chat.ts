import type { StoreApi } from 'zustand/vanilla';
import type { ChatMessage } from '@/ai/ai';
import type { StagedEdit } from '@/ai/editSession';

/** One reviewed file inside the pending change set. */
export interface ChangeSetFileState {
  readonly relPath: string;
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
    /** The pending change-set review, or null when nothing is staged. */
    readonly changeSet: ChatChangeSetState | null;
  };
  /** Replace key + transcript on workspace switch. NO-OP while streaming — a mid-stream workspace reassignment must not clobber the live turn. */
  hydrateChat(workspaceKey: string, messages: readonly ChatMessage[]): void;
  /** Append one turn immutably (new array identity, prior snapshot untouched). */
  appendChatMessage(msg: ChatMessage): void;
  /** idle|error → streaming; no-op if a turn is already streaming. */
  startChatTurn(): void;
  /** streaming → idle. */
  finishChatTurn(): void;
  /**
   * Abort the live turn. rollbackUserTurn: true pops exactly the trailing message if it is the
   * just-sent user turn and sets status 'error'; false keeps the transcript intact → 'idle'.
   */
  abortChatTurn(opts: { rollbackUserTurn: boolean }): void;
  /** Empty the transcript (the workspace key and status are untouched). */
  clearChatTranscript(): void;
  /**
   * Replace the change set with a fresh reviewing one (monotonic id, all files accepted, none
   * drifted); `before` supplies each relPath's send-time text, defaulting to `''` for new files.
   */
  stageChangeSet(
    files: readonly StagedEdit[],
    before: Record<string, string>,
    diagnostics: string | null,
  ): void;
  /** Toggle one file's accept checkbox; works in reviewing AND applying, no-op once terminal. */
  setChangeSetFileAccepted(relPath: string, accepted: boolean): void;
  /** Set `drifted: true` on the named files — sticky (never unsets) and idempotent (#473). */
  markChangeSetDrift(relPaths: readonly string[]): void;
  /** reviewing → applying; no-op unless reviewing with at least one accepted file. */
  beginChangeSetApply(): void;
  /**
   * Settle an apply: no failures → terminal `applied` counting the accepted files; any failures →
   * back to `reviewing` with a note naming them so retry stays open (no false Applied). No-op
   * unless applying — in particular after invalidation (#684).
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
      changeSet: null,
    },
    hydrateChat: (workspaceKey, messages) => {
      const chat = get().chat;
      if (chat.status === 'streaming') return;
      set({ chat: { ...chat, workspaceKey, messages: [...messages] } });
    },
    appendChatMessage: (msg) => {
      const chat = get().chat;
      set({ chat: { ...chat, messages: [...chat.messages, msg] } });
    },
    startChatTurn: () => {
      const chat = get().chat;
      if (chat.status === 'streaming') return;
      set({ chat: { ...chat, status: 'streaming' } });
    },
    finishChatTurn: () => {
      set({ chat: { ...get().chat, status: 'idle' } });
    },
    abortChatTurn: ({ rollbackUserTurn }) => {
      const chat = get().chat;
      if (rollbackUserTurn) {
        const last = chat.messages[chat.messages.length - 1];
        const messages = last?.role === 'user' ? chat.messages.slice(0, -1) : chat.messages;
        set({ chat: { ...chat, messages, status: 'error' } });
      } else {
        set({ chat: { ...chat, status: 'idle' } });
      }
    },
    clearChatTranscript: () => {
      set({ chat: { ...get().chat, messages: [] } });
    },
    stageChangeSet: (files, before, diagnostics) => {
      setChangeSet({
        id: nextChangeSetId++,
        files: files.map((f) => ({
          relPath: f.relPath,
          body: f.body,
          isNew: f.isNew,
          before: before[f.relPath] ?? '',
          accepted: true,
          drifted: false,
        })),
        diagnostics,
        phase: { kind: 'reviewing' },
      });
    },
    setChangeSetFileAccepted: (relPath, accepted) => {
      const cs = get().chat.changeSet;
      if (!cs || (cs.phase.kind !== 'reviewing' && cs.phase.kind !== 'applying')) return;
      setChangeSet({
        ...cs,
        files: cs.files.map((f) => (f.relPath === relPath ? { ...f, accepted } : f)),
      });
    },
    markChangeSetDrift: (relPaths) => {
      const cs = get().chat.changeSet;
      if (!cs) return;
      setChangeSet({
        ...cs,
        files: cs.files.map((f) => (relPaths.includes(f.relPath) ? { ...f, drifted: true } : f)),
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
          ? { kind: 'applied', appliedCount: cs.files.filter((f) => f.accepted).length }
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
