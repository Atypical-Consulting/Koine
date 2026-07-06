// Bridge tests for #984 Task 3 (ported to the #990 Task 6 assembly): the assistant's transcript +
// turn lifecycle live in the app store's `chat` slice, not in host closures. Each test drives the
// assembled AssistantChat through its DOM (the same fake-provider harness as aiPanel.test.ts) while
// observing the INJECTED store, proving the slice is the single source of truth for the conversation:
// a completed send lands the turn in `chat.messages` with an idle → streaming → idle lifecycle,
// syncWorkspace() hydrates the slice from the new folder's stored transcript, and the mid-stream
// deferral is observable in state.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAssistantChat, type AssistantPanelOptions } from '@/ai/aiPanel';
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

describe('assistant ↔ chat slice bridge (#984 Task 3)', () => {
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

  // Type a prompt through the CONTROLLED composer (the input listener lands it in chat.draft
  // synchronously) and send it via the Send button (the from-input path).
  function typeSend(container: HTMLElement, text: string): void {
    const input = container.querySelector<HTMLTextAreaElement>('.koi-assistant-input')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
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
    createAssistantChat(opts(container, store));

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
    const panel = createAssistantChat(opts(container, store, { getWorkspaceKey: () => key }));

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
    const panel = createAssistantChat(opts(container, store, { getWorkspaceKey: () => key }));

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

// --- #984 Task 4: the change-set review is a CONSUMER of the slice's state machine ---------------
// The change-set DOM (checkboxes, Apply, superseded treatment) renders from the store's
// `chat.changeSet` (the declarative ChangeSetPanel), and every user gesture dispatches a slice
// action — no closure-held accepted/applied/invalidated/inFlight state remains.
describe('assistant ↔ chat slice change-set bridge (#984 Task 4)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });
  afterEach(() => {
    localStorage.clear();
    vi.mocked(runAssistant).mockReset();
  });

  // Options for a workspace turn that can stage multi-file edits, modeled on aiPanel.test.ts's
  // change-set harness (tools on, a one-file workspace snapshot, a stub edit-tool executor).
  function csOpts(
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
      getWorkspaceKey: () => 'ws',
      getSelection: () => null,
      getUseTools: () => true,
      getConstrainGrammar: () => false,
      getWorkspaceFiles: () => ({ 'orders.koi': 'context Orders {}' }),
      runEditTool: vi.fn(async () => 'ok'),
      onApplyChangeSet: vi.fn(async () => ({ failed: [] as string[] })),
      ...over,
    };
  }

  // Drive a generative send via the first quick action (offerApply defaults true).
  function fire(container: HTMLElement): void {
    container.querySelector<HTMLButtonElement>('.koi-assistant-quick .koi-assistant-action')!.click();
  }

  test('a DOM-driven Apply walks the store through reviewing → applying → applied', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    const store = createAppStore();
    // Record every change-set phase-kind transition, so the DOM gesture's path through the state
    // machine is pinned (not just the terminal state).
    const phases: string[] = [];
    store.subscribe((s, prev) => {
      if (s.chat.changeSet !== prev.chat.changeSet && s.chat.changeSet) {
        const kind = s.chat.changeSet.phase.kind;
        if (phases[phases.length - 1] !== kind) phases.push(kind);
      }
    });
    const container = document.createElement('div');
    createAssistantChat(csOpts(container, store));

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    expect(store.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });

    container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!.click();
    await vi.waitFor(() =>
      expect(store.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 1 }),
    );
    expect(phases).toEqual(['reviewing', 'applying', 'applied']);
  });

  test('a Send with an un-applied set standing invalidates it as superseded in the store and the DOM', async () => {
    // Turn 1 stages a set; turn 2 is a plain reply, so the store's set after turn 2 is still turn 1's
    // — now invalidated('superseded') by the send, with the DOM treatment rendered by ChangeSetPanel.
    let turn = 0;
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      turn++;
      if (turn === 1) req.editSession?.stage('orders.koi', 'context Orders { /* t1 */ }');
      req.onText('done');
      return 'done';
    });
    const store = createAppStore();
    const container = document.createElement('div');
    createAssistantChat(csOpts(container, store));

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const stagedId = store.getState().chat.changeSet!.id;
    const panel = container.querySelector('.koi-changeset')!;

    fire(container);
    await vi.waitFor(() =>
      expect(store.getState().chat.changeSet?.phase).toEqual({ kind: 'invalidated', reason: 'superseded' }),
    );
    expect(store.getState().chat.changeSet?.id).toBe(stagedId);
    // The superseded treatment reached the DOM from the slice state (no imperative handle).
    await vi.waitFor(() => expect(panel.classList.contains('koi-changeset-superseded')).toBe(true));
    expect(panel.querySelector<HTMLButtonElement>('.koi-changeset-apply')!.disabled).toBe(true);
    expect(panel.querySelector('.koi-changeset-status')?.textContent).toMatch(/superseded/i);
  });

  test('a REJECTED apply returns the store to reviewing with the error note and re-enables Apply (#633)', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.onText('Edit.');
      return 'Edit.';
    });
    const store = createAppStore();
    const container = document.createElement('div');
    createAssistantChat(
      csOpts(container, store, {
        onApplyChangeSet: vi.fn(async () => {
          throw new Error('setDoc blew up');
        }),
      }),
    );

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const applyBtn = container.querySelector<HTMLButtonElement>('.koi-changeset-apply')!;
    applyBtn.click();

    await vi.waitFor(() => {
      const phase = store.getState().chat.changeSet?.phase;
      expect(phase?.kind).toBe('reviewing');
      expect(phase?.kind === 'reviewing' ? phase.note : undefined).toContain('setDoc blew up');
    });
    await vi.waitFor(() => expect(applyBtn.disabled).toBe(false));
  });

  test('accept-checkbox toggles land in chat.changeSet.files[].accepted', async () => {
    vi.mocked(runAssistant).mockImplementation(async (req: any) => {
      req.editSession?.stage('orders.koi', 'context Orders { /* edited */ }');
      req.editSession?.stage('events.koi', 'integration event OrderPlaced {}');
      req.onText('Two edits.');
      return 'Two edits.';
    });
    const store = createAppStore();
    const container = document.createElement('div');
    createAssistantChat(csOpts(container, store));

    fire(container);
    await vi.waitFor(() => expect(container.querySelector('.koi-changeset')).not.toBeNull());
    const acceptedByPath = (): Record<string, boolean> =>
      Object.fromEntries(store.getState().chat.changeSet!.files.map((f) => [f.relPath, f.accepted]));
    expect(acceptedByPath()).toEqual({ 'orders.koi': true, 'events.koi': true });

    const eventsRow = [...container.querySelectorAll('.koi-changeset-file')].find((r) =>
      r.textContent?.includes('events.koi'),
    )!;
    const check = eventsRow.querySelector<HTMLInputElement>('.koi-changeset-accept')!;
    check.checked = false;
    check.dispatchEvent(new Event('change'));
    expect(acceptedByPath()).toEqual({ 'orders.koi': true, 'events.koi': false });

    check.checked = true;
    check.dispatchEvent(new Event('change'));
    expect(acceptedByPath()).toEqual({ 'orders.koi': true, 'events.koi': true });
  });
});
