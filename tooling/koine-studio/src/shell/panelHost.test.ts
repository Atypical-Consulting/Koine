import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelHostDeps } from '@/shell/panelHost';

// Mock the five panel constructors so we can assert WHEN each is built (laziness) and that teardown
// disposes only what was built — without spinning up real panels (SDK, PTY broker, settings DOM).
const { handles, ctors } = vi.hoisted(() => {
  const handles = {
    settings: { refresh: vi.fn(), destroy: vi.fn() },
    assistant: { explainSelection: vi.fn() },
    scenario: { refresh: vi.fn() },
    terminal: { applyTheme: vi.fn(), dispose: vi.fn() },
    review: { dispose: vi.fn() },
  };
  const ctors = {
    createSettingsPage: vi.fn(() => handles.settings),
    // Takes its options so the snapshot/apply seam tests (#472 Task 3) can read them back off the call.
    createAssistantChat: vi.fn((_opts: unknown) => handles.assistant),
    createScenarioPanel: vi.fn(() => handles.scenario),
    createTerminalPanel: vi.fn(() => handles.terminal),
    createReviewPanel: vi.fn(() => handles.review),
  };
  return { handles, ctors };
});
vi.mock('@/settings/settingsPage', () => ({ createSettingsPage: ctors.createSettingsPage }));
vi.mock('@/ai/aiPanel', () => ({ createAssistantChat: ctors.createAssistantChat }));
vi.mock('@/scenarios/scenarioPanel', () => ({ createScenarioPanel: ctors.createScenarioPanel }));
vi.mock('@/shell/terminal/terminalPanel', () => ({ createTerminalPanel: ctors.createTerminalPanel }));
vi.mock('@/review/ReviewPanel', () => ({ createReviewPanel: ctors.createReviewPanel }));

import { createPanelHost } from '@/shell/panelHost';

const PANEL_IDS = ['view-assistant', 'view-scenarios', 'panel-terminal', 'panel-review', 'settings-page-header', 'settings-page-body'];

const showSettings = vi.fn();
const closeSettings = vi.fn();
function makeDeps(): PanelHostDeps {
  return {
    prefsCallbacks: {} as PanelHostDeps['prefsCallbacks'],
    settingsCategory: () => undefined,
    showSettings,
    closeSettings,
    getSource: () => '',
    getSelection: () => null,
    applyModel: vi.fn(),
    diagnosticsFor: () => [],
    workspace: {
      activeUri: () => 'file:///a.koi',
      buffers: new Map(),
      folderRootToken: () => '',
      applyFileEdit: async () => null,
    },
    getCachedDomainIndex: async () => null,
    lsp: {} as PanelHostDeps['lsp'],
    platform: {} as PanelHostDeps['platform'],
    reviewStore: {} as PanelHostDeps['reviewStore'],
    gotoSourceSpan: vi.fn(),
    reviewAuthorName: () => 'You',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  for (const id of PANEL_IDS) {
    const node = document.createElement('div');
    node.id = id;
    document.body.appendChild(node);
  }
});

describe('panelHost', () => {
  it('builds nothing at construction (every panel is lazy)', () => {
    createPanelHost(makeDeps());
    expect(ctors.createAssistantChat).not.toHaveBeenCalled();
    expect(ctors.createScenarioPanel).not.toHaveBeenCalled();
    expect(ctors.createTerminalPanel).not.toHaveBeenCalled();
    expect(ctors.createReviewPanel).not.toHaveBeenCalled();
    expect(ctors.createSettingsPage).not.toHaveBeenCalled();
  });

  it('builds each panel on first ensure* and reuses it thereafter', () => {
    const host = createPanelHost(makeDeps());

    expect(host.ensureAssistant()).toBe(host.ensureAssistant());
    expect(ctors.createAssistantChat).toHaveBeenCalledTimes(1);

    expect(host.ensureScenarios()).toBe(host.ensureScenarios());
    expect(ctors.createScenarioPanel).toHaveBeenCalledTimes(1);

    expect(host.ensureTerminal()).toBe(host.ensureTerminal());
    expect(ctors.createTerminalPanel).toHaveBeenCalledTimes(1);

    host.ensureReview();
    host.ensureReview();
    expect(ctors.createReviewPanel).toHaveBeenCalledTimes(1);
  });

  it('openSettings records the intent and builds the page lazily, refreshing on re-open', () => {
    const host = createPanelHost(makeDeps());
    host.openSettings('about');
    expect(showSettings).toHaveBeenCalledWith('about');
    expect(ctors.createSettingsPage).toHaveBeenCalledTimes(1);

    host.openSettings();
    expect(ctors.createSettingsPage).toHaveBeenCalledTimes(1); // reused, not rebuilt
    expect(handles.settings.refresh).toHaveBeenCalled();
  });

  it('applyTerminalTheme is a no-op until the terminal exists, then drives it', () => {
    const host = createPanelHost(makeDeps());
    host.applyTerminalTheme();
    expect(handles.terminal.applyTheme).not.toHaveBeenCalled();

    host.ensureTerminal();
    host.applyTerminalTheme();
    expect(handles.terminal.applyTheme).toHaveBeenCalledOnce();
  });

  // #472 Task 3: the snapshot producer keys by the buffer uri (the buffers Map key), so two roots
  // holding the SAME relPath both survive — no collapse — while displayPath carries each key's
  // workspace-relative label for the review UI.
  it('snapshots the workspace keyed by buffer uri with relPath as the display path (#472)', () => {
    const deps = makeDeps();
    deps.workspace.buffers = new Map([
      ['file:///wsA/model.koi', { relPath: 'model.koi', text: 'context A {}' }],
      ['file:///wsB/model.koi', { relPath: 'model.koi', text: 'context B {}' }],
    ]);
    const host = createPanelHost(deps);
    host.ensureAssistant();
    const opts = ctors.createAssistantChat.mock.calls[0][0] as {
      getWorkspaceFiles?: () => { files: Record<string, string>; displayPath: Record<string, string> };
    };
    expect(opts.getWorkspaceFiles!()).toEqual({
      files: { 'file:///wsA/model.koi': 'context A {}', 'file:///wsB/model.koi': 'context B {}' },
      displayPath: { 'file:///wsA/model.koi': 'model.koi', 'file:///wsB/model.koi': 'model.koi' },
    });
  });

  // #472 Task 3: the change-set apply addresses each write by the staged edit's OPAQUE key (buffer
  // uri, or `new:<relPath>` for a file to create) — never the ambiguous relPath — while the
  // partial-apply failure report speaks the user's language: the DISPLAY relPath.
  it('onApplyChangeSet forwards each staged edit by KEY and reports failures by display relPath (#472)', async () => {
    const deps = makeDeps();
    const applyFileEdit = vi.fn(async (key: string, _body: string) => (key.startsWith('new:') ? null : key));
    deps.workspace.applyFileEdit = applyFileEdit;
    const host = createPanelHost(deps);
    host.ensureAssistant();
    const opts = ctors.createAssistantChat.mock.calls[0][0] as {
      onApplyChangeSet?: (
        files: { key: string; relPath: string; body: string; isNew: boolean }[],
      ) => Promise<{ failed: string[] }>;
    };
    const result = await opts.onApplyChangeSet!([
      { key: 'file:///wsB/model.koi', relPath: 'model.koi', body: 'context B { v2 }', isNew: false },
      { key: 'new:fresh.koi', relPath: 'fresh.koi', body: 'context Fresh {}', isNew: true },
    ]);
    expect(applyFileEdit).toHaveBeenNthCalledWith(1, 'file:///wsB/model.koi', 'context B { v2 }');
    expect(applyFileEdit).toHaveBeenNthCalledWith(2, 'new:fresh.koi', 'context Fresh {}');
    expect(result).toEqual({ failed: ['fresh.koi'] });
  });

  it('dispose tears down only the panels that were built', () => {
    const host = createPanelHost(makeDeps());
    expect(() => host.dispose()).not.toThrow(); // nothing built → safe

    host.ensureTerminal();
    host.ensureReview();
    host.openSettings();
    host.dispose();
    expect(handles.terminal.dispose).toHaveBeenCalled();
    expect(handles.review.dispose).toHaveBeenCalled();
    expect(handles.settings.destroy).toHaveBeenCalled();
  });
});
