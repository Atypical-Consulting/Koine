// Bridge tests for #984 Task 3: the assistant panel's transcript + turn lifecycle live in the app
// store's `chat` slice, not in panel-local closures. Each test drives the panel through its DOM
// (the same fake-provider harness as aiPanel.test.ts) while observing the INJECTED store, proving
// the slice is the single source of truth for the conversation: a completed send lands the turn in
// `chat.messages` with an idle → streaming → idle lifecycle, syncWorkspace() hydrates the slice from
// the new folder's stored transcript, and the mid-stream deferral is now observable in state.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAssistantPanel, type AssistantPanelOptions } from '@/ai/aiPanel';
import { runAssistant } from '@/ai/ai';
import { loadChat, saveChat } from '@/settings/persistence';
import { createAppStore, type AppState } from '@/store/index';
import type { StoreApi } from 'zustand/vanilla';

// Fake provider, modeled on aiPanel.test.ts's harness: the default implementation streams a plain
// reply and resolves; tests that need a gated stream install their own implementation.
vi.mock('@/ai/ai', async (orig) => ({
  ...(await orig<typeof import('@/ai/ai')>()),
  runAssistant: vi.fn(async (req: { onText: (t: string) => void }) => {
    req.onText('reply');
    return 'reply';
  }),
}));

describe('aiPanel ↔ chat slice bridge (#984 Task 3)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void }) => {
      req.onText('reply');
      return 'reply';
    });
  });
  afterEach(() => {
    localStorage.clear();
  });

  function opts(
    container: HTMLElement,
    store: StoreApi<AppState>,
    over: Partial<AssistantPanelOptions> = {},
  ): AssistantPanelOptions {
    return {
      container,
      store,
      getProvider: () => 'anthropic',
      getBaseUrl: () => '',
      getApiKey: () => 'sk',
      getModel: () => '',
      getContext: () => ({ fileName: 'm.koi', source: 'context X {}', diagnostics: [] }),
      onApplyModel: () => {},
      onOpenPrefs: () => {},
      getWorkspaceKey: () => 'A',
      getSelection: () => null,
      getUseTools: () => false,
      getConstrainGrammar: () => false,
      ...over,
    };
  }

  // Type a prompt and send it via the Send button (the from-input path).
  function typeSend(container: HTMLElement, text: string): void {
    container.querySelector<HTMLTextAreaElement>('.koi-assistant-input')!.value = text;
    container.querySelector<HTMLButtonElement>('.koi-assistant-send')!.click();
  }

  test('a completed send lands the (user, assistant) pair in chat.messages, status idle → streaming → idle', async () => {
    const store = createAppStore();
    // Record every status TRANSITION (not every set) so the turn lifecycle is pinned end-to-end.
    const transitions: string[] = [store.getState().chat.status];
    store.subscribe((s, prev) => {
      if (s.chat.status !== prev.chat.status) transitions.push(s.chat.status);
    });
    const container = document.createElement('div');
    createAssistantPanel(opts(container, store));

    typeSend(container, 'hello');
    await vi.waitFor(() => expect(transitions).toEqual(['idle', 'streaming', 'idle']));

    expect(store.getState().chat.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'reply'],
    ]);
    expect(store.getState().chat.workspaceKey).toBe('A');
  });

  test('a workspace switch + syncWorkspace() hydrates chat.workspaceKey and chat.messages from the new folder', () => {
    // Folder B already has a saved conversation from an earlier session.
    saveChat('B', [
      { role: 'user', content: 'earlier B question' },
      { role: 'assistant', content: 'earlier B answer' },
    ]);
    let key = 'A';
    const store = createAppStore();
    const container = document.createElement('div');
    const panel = createAssistantPanel(opts(container, store, { getWorkspaceKey: () => key }));

    // Mount pointed the slice at the initial workspace.
    expect(store.getState().chat.workspaceKey).toBe('A');
    expect(store.getState().chat.messages).toEqual([]);

    key = 'B';
    panel.syncWorkspace();

    expect(store.getState().chat.workspaceKey).toBe('B');
    expect(store.getState().chat.messages.map((m) => m.content)).toEqual([
      'earlier B question',
      'earlier B answer',
    ]);
  });

  test('a mid-stream syncWorkspace() leaves the store untouched until the turn settles, then the deferred hydrate lands', async () => {
    saveChat('B', [{ role: 'user', content: 'b history' }]);
    let key = 'A';
    let finish!: () => void;
    vi.mocked(runAssistant).mockImplementation(async (req: { onText: (t: string) => void }) => {
      req.onText('partial…');
      await new Promise<void>((r) => {
        finish = r;
      });
      return 'A reply';
    });
    const store = createAppStore();
    const container = document.createElement('div');
    const panel = createAssistantPanel(opts(container, store, { getWorkspaceKey: () => key }));

    typeSend(container, 'question in A');
    await vi.waitFor(() => expect(store.getState().chat.status).toBe('streaming'));

    // Mid-stream the folder switches and the host calls syncWorkspace(): the deferral keeps the
    // slice untouched — the live turn's workspace key and transcript stay A's.
    key = 'B';
    panel.syncWorkspace();
    expect(store.getState().chat.workspaceKey).toBe('A');
    expect(store.getState().chat.messages.map((m) => m.content)).toEqual(['question in A']);

    // The turn settles: the reply commits to A first (persisted under A's send-time key), then the
    // deferred hydrate re-points the slice at B's stored conversation.
    finish();
    await vi.waitFor(() => expect(store.getState().chat.workspaceKey).toBe('B'));
    expect(store.getState().chat.messages.map((m) => m.content)).toEqual(['b history']);
    expect(store.getState().chat.status).toBe('idle');
    expect(loadChat('A').map((m) => m.content)).toEqual(['question in A', 'A reply']);
  });
});
