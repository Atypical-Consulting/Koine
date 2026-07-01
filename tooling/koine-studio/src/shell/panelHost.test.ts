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
    createAssistantPanel: vi.fn(() => handles.assistant),
    createScenarioPanel: vi.fn(() => handles.scenario),
    createTerminalPanel: vi.fn(() => handles.terminal),
    createReviewPanel: vi.fn(() => handles.review),
  };
  return { handles, ctors };
});
vi.mock('@/settings/settingsPage', () => ({ createSettingsPage: ctors.createSettingsPage }));
vi.mock('@/ai/aiPanel', () => ({ createAssistantPanel: ctors.createAssistantPanel }));
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
    expect(ctors.createAssistantPanel).not.toHaveBeenCalled();
    expect(ctors.createScenarioPanel).not.toHaveBeenCalled();
    expect(ctors.createTerminalPanel).not.toHaveBeenCalled();
    expect(ctors.createReviewPanel).not.toHaveBeenCalled();
    expect(ctors.createSettingsPage).not.toHaveBeenCalled();
  });

  it('builds each panel on first ensure* and reuses it thereafter', () => {
    const host = createPanelHost(makeDeps());

    expect(host.ensureAssistant()).toBe(host.ensureAssistant());
    expect(ctors.createAssistantPanel).toHaveBeenCalledTimes(1);

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
