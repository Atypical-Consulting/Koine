import type { StoreApi } from 'zustand/vanilla';
import type { ChatMessage } from '@/ai/ai';

export interface ChatSlice {
  /** The assistant transcript and turn lifecycle for the active workspace. */
  chat: {
    /** Workspace the transcript belongs to (guards against cross-workspace replays). */
    readonly workspaceKey: string;
    /** The transcript, oldest first; every mutation produces a new array identity. */
    readonly messages: readonly ChatMessage[];
    /** Turn lifecycle: idle → streaming → idle (finish) or error (aborted with rollback). */
    readonly status: 'idle' | 'streaming' | 'error';
    /** TODO(#984 Task 2): the pending change-set state machine; null-typed placeholder until then. */
    readonly changeSet: null;
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
}

export function createChatSlice(
  set: StoreApi<ChatSlice>['setState'],
  get: StoreApi<ChatSlice>['getState'],
): ChatSlice {
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
  };
}
