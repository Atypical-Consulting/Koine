// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chordFromEvent, createPreferences, type PrefsCallbacks } from '@/settings/prefs';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  workspaceKeyOf,
  loadWorkspaceOverrides,
  loadKeybindingOverrides,
  resolveKeybindings,
  saveKeybindingOverride,
} from '@/settings/persistence';
import { DEFAULT_BINDINGS } from '@/editor/keybindings';
import { BUILTIN_EMIT_TARGETS } from '@/shared/emitTargets';
import { MCP_CLIENTS } from '@/mcp/mcp';

// Flush queued microtasks + timers so the panel's async steps (mcpEndpoint, mcpStop, probe) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

const URL = 'http://127.0.0.1:51000/mcp';
// Mirrors the placeholder used by createPreferences when no live endpoint has resolved (prefs.ts).
const MCP_URL_PLACEHOLDER = 'http://127.0.0.1:PORT/mcp';

function openPrefs(over: Partial<PrefsCallbacks> = {}): void {
  const prefs = createPreferences({
    onChange: () => {},
    mcpEndpoint: async () => URL,
    mcpStop: async () => {},
    mcpHostable: true,
    ...over,
  });
  prefs.open();
}

const mcpToggle = () =>
  document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Enable MCP server"]')!;
const mcpClientSelect = () =>
  document.querySelector<HTMLSelectElement>('#koi-settings-panel-mcp .koi-select')!;
const snippet = () => document.querySelector<HTMLDivElement>('.koi-mcp-snippet')!;
const status = () => document.querySelector<HTMLElement>('.koi-mcp-status')!;
const endpointUrl = () => document.querySelector<HTMLInputElement>('.koi-mcp-control .koi-text')!;
const testBtn = () =>
  [...document.querySelectorAll<HTMLButtonElement>('#koi-settings-panel-mcp .koi-set-action')].find(
    (b) => b.textContent === 'Test connection',
  )!;

describe('Settings → MCP panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('starts disabled, server off, with the LM Studio HTTP recipe (placeholder URL)', async () => {
    openPrefs();
    await settle();
    expect(mcpToggle().getAttribute('aria-checked')).toBe('false');
    expect(status().dataset.state).toBe('off');
    // Disabled ⇒ no endpoint started ⇒ the HTTP snippet carries the placeholder, not a live URL.
    expect(snippet().textContent).toContain('"url"');
    expect(snippet().textContent).toContain('PORT');
  });

  it('enabling starts the sidecar and the snippet picks up the live URL', async () => {
    const mcpEndpoint = vi.fn(async () => URL);
    openPrefs({ mcpEndpoint });
    await settle();
    mcpToggle().click();
    await settle();
    expect(mcpEndpoint).toHaveBeenCalled();
    expect(endpointUrl().value).toBe(URL);
    expect(snippet().textContent).toContain(URL);
  });

  it('disabling stops the sidecar', async () => {
    const mcpStop = vi.fn(async () => {});
    openPrefs({ mcpStop });
    await settle();
    mcpToggle().click(); // on
    await settle();
    mcpToggle().click(); // off
    await settle();
    expect(mcpStop).toHaveBeenCalled();
    expect(status().dataset.state).toBe('off');
  });

  it('switching to Claude Desktop shows the stdio command recipe', async () => {
    openPrefs();
    await settle();
    const sel = mcpClientSelect();
    sel.value = 'claude-desktop';
    sel.dispatchEvent(new Event('change'));
    await settle();
    expect(snippet().textContent).toContain('koine-mcp');
    expect(snippet().textContent).not.toContain('"url"');
  });

  it('Test connection reports the tool count from a stubbed server', async () => {
    const TOOLS = ['koine_validate', 'koine_compile', 'koine_format', 'koine_reference', 'koine_examples'];
    const fetchStub = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const payload =
        body.method === 'initialize'
          ? { result: { serverInfo: { name: 'koine' } } }
          : { result: { tools: TOOLS.map((name) => ({ name })) } };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      openPrefs();
      await settle();
      mcpToggle().click(); // enable so the endpoint resolves
      await settle();
      testBtn().click();
      await settle();
      expect(status().dataset.state).toBe('ok');
      expect(status().textContent).toContain('5 tools');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('on a non-hostable (web) host the toggle is disabled but recipes still render', async () => {
    openPrefs({ mcpHostable: false });
    await settle();
    expect(mcpToggle().disabled).toBe(true);
    expect(snippet().textContent).toContain('"url"');
  });

  it('enabling when the sidecar fails to start surfaces a failure status', async () => {
    openPrefs({ mcpEndpoint: async () => null });
    await settle();
    mcpToggle().click();
    await settle();
    expect(endpointUrl().value).toBe('');
    expect(status().dataset.state).toBe('fail');
  });

  it('renders the recipe as a highlighted CodeMirror view and Copy writes the exact snippet', async () => {
    // The recipe is now a read-only CodeMirror view (.koi-mcp-snippet .cm-editor), not a bare <pre>.
    // Copy must round-trip the exact snippet JSON through the view, preserving JSON.parse for clients.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    openPrefs();
    await settle();
    const sel = mcpClientSelect();
    sel.value = 'lm-studio';
    sel.dispatchEvent(new Event('change'));
    await settle();

    expect(document.querySelector('.koi-mcp-snippet .cm-editor')).not.toBeNull();

    const expected = MCP_CLIENTS.find((c) => c.id === 'lm-studio')!.snippet(MCP_URL_PLACEHOLDER);
    const copyBtn = [
      ...document.querySelectorAll<HTMLButtonElement>('#koi-settings-panel-mcp .koi-set-action'),
    ].find((b) => b.textContent === 'Copy')!;
    copyBtn.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith(expected);
  });
});

describe('Settings → Output panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  const langOpts = () =>
    [...document.querySelectorAll<HTMLButtonElement>('#koi-settings-panel-output .koi-lang-opt')];

  it('renders one option per built-in emit target with C# selected by default', () => {
    openPrefs();
    const opts = langOpts();
    // Derived from the shared emit-target list (issue #282), not a hardcoded set, so it tracks the
    // registry — the picker offers exactly the backend's targets (built-ins when offline).
    expect(opts.map((b) => b.dataset.value)).toEqual(BUILTIN_EMIT_TARGETS.map((t) => t.id));
    const checked = opts.find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked?.dataset.value).toBe('csharp');
  });

  it('selecting a language commits previewTarget and reports it via onChange', () => {
    const onChange = vi.fn();
    openPrefs({ onChange });
    langOpts().find((b) => b.dataset.value === 'python')!.click();
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last.previewTarget).toBe('python');
    expect(loadSettings().previewTarget).toBe('python');
  });

  it('reflects the persisted target when reopened', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'php' });
    openPrefs();
    const checked = langOpts().find((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked?.dataset.value).toBe('php');
  });
});

describe('Settings → About panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('renders About as the last category tab with the wordmark and four links', () => {
    openPrefs();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.koi-settings-tab')];
    expect(tabs[tabs.length - 1]?.id).toBe('koi-settings-tab-about');
    const panel = document.querySelector('#koi-settings-panel-about')!;
    expect(panel.querySelector('.koi-about-wordmark')?.textContent).toContain('Koine');
    const labels = [...panel.querySelectorAll('.koi-about-link-label')].map((n) => n.textContent);
    expect(labels).toEqual(['GitHub', 'Home', 'Docs', 'Blog']);
  });

  it('open("about") opens directly on the About tab', () => {
    const prefs = createPreferences({
      onChange: () => {},
      mcpEndpoint: async () => URL,
      mcpStop: async () => {},
      mcpHostable: true,
    });
    prefs.open('about');
    const tab = document.querySelector<HTMLButtonElement>('#koi-settings-tab-about')!;
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector<HTMLElement>('#koi-settings-panel-about')!.hidden).toBe(false);
  });

  it('fills the build chip on open', async () => {
    openPrefs();
    await settle();
    const chip = document.querySelector<HTMLElement>('#koi-settings-panel-about .koi-about-chip')!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toMatch(/^v/);
  });
});

describe('Settings → User/Workspace scope toggle', () => {
  const ROOTS = ['/Users/me/projects/billing'];
  const KEY = workspaceKeyOf(ROOTS);

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  // The scope segmented for a given field's accessible label (e.g. "Word wrap scope").
  const scopeGroup = (label: string) =>
    document.querySelector<HTMLElement>(`.koi-segmented[aria-label="${label}"]`)!;
  const scopeBtn = (label: string, value: 'user' | 'workspace') =>
    scopeGroup(label).querySelector<HTMLButtonElement>(`.koi-seg[data-value="${value}"]`)!;
  // The Word wrap value toggle (role=switch) — distinct from the scope segmented.
  const wordWrapToggle = () =>
    document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Word wrap"]')!;
  const formatOnSaveToggle = () =>
    document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Format on save"]')!;
  const WORD_WRAP_SCOPE = 'Word wrap scope';

  it('hides/disables every scope control when no workspace is open', () => {
    openPrefs({ workspaceKey: () => null });
    for (const label of [
      'Output language scope',
      'Format on save scope',
      'Word wrap scope',
      'Language server trace scope',
    ]) {
      const group = scopeGroup(label);
      // Unambiguous, testable state: aria-disabled on the group and disabled on its option buttons.
      expect(group.getAttribute('aria-disabled')).toBe('true');
      for (const b of group.querySelectorAll<HTMLButtonElement>('.koi-seg')) {
        expect(b.disabled).toBe(true);
      }
    }
  });

  it('enables the scope control when a workspace is open, defaulting to User', () => {
    openPrefs({ workspaceKey: () => KEY });
    const group = scopeGroup(WORD_WRAP_SCOPE);
    expect(group.getAttribute('aria-disabled')).toBe('false');
    expect(scopeBtn(WORD_WRAP_SCOPE, 'user').getAttribute('aria-checked')).toBe('true');
    expect(scopeBtn(WORD_WRAP_SCOPE, 'workspace').getAttribute('aria-checked')).toBe('false');
  });

  it('flipping a row to Workspace persists the current value as an override, leaving the user value untouched', () => {
    saveSettings({ ...DEFAULT_SETTINGS, wordWrap: false });
    const onChange = vi.fn();
    openPrefs({ workspaceKey: () => KEY, onChange });

    // Flip the Word wrap row's scope to Workspace.
    scopeBtn(WORD_WRAP_SCOPE, 'workspace').click();

    // The current value (false) is now an explicit workspace override...
    expect(loadWorkspaceOverrides(KEY)).toHaveProperty('wordWrap', false);
    // ...and the user/global value is unchanged.
    expect(loadSettings().wordWrap).toBe(false);
    expect(scopeBtn(WORD_WRAP_SCOPE, 'workspace').getAttribute('aria-checked')).toBe('true');
  });

  it('editing the value while scope=Workspace writes to the override, NOT the user settings', () => {
    saveSettings({ ...DEFAULT_SETTINGS, wordWrap: false });
    const onChange = vi.fn();
    openPrefs({ workspaceKey: () => KEY, onChange });

    scopeBtn(WORD_WRAP_SCOPE, 'workspace').click();
    onChange.mockClear();
    // Turn word wrap on — this must hit the workspace override, not the user blob.
    wordWrapToggle().click();

    expect(loadWorkspaceOverrides(KEY)).toHaveProperty('wordWrap', true);
    expect(loadSettings().wordWrap).toBe(false); // user value stays put
    // The host is notified with the UNCHANGED user settings (it re-applies effective behaviors itself).
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last.wordWrap).toBe(false);
  });

  it('editing the value while scope=User writes to the user settings (the existing path)', () => {
    saveSettings({ ...DEFAULT_SETTINGS, wordWrap: false });
    const onChange = vi.fn();
    openPrefs({ workspaceKey: () => KEY, onChange });

    // Scope defaults to User; toggling commits to the global blob.
    wordWrapToggle().click();
    expect(loadSettings().wordWrap).toBe(true);
    expect(loadWorkspaceOverrides(KEY)).not.toHaveProperty('wordWrap');
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last.wordWrap).toBe(true);
  });

  it('flipping back to User clears the override and restores the user value in the control', () => {
    saveSettings({ ...DEFAULT_SETTINGS, formatOnSave: true });
    openPrefs({ workspaceKey: () => KEY });
    const FOS_SCOPE = 'Format on save scope';

    // Go to Workspace, change the override to false.
    scopeBtn(FOS_SCOPE, 'workspace').click();
    formatOnSaveToggle().click(); // override now false
    expect(loadWorkspaceOverrides(KEY)).toHaveProperty('formatOnSave', false);

    // Flip back to User: the override is cleared and the control resets to the user value (true).
    scopeBtn(FOS_SCOPE, 'user').click();
    expect(loadWorkspaceOverrides(KEY)).not.toHaveProperty('formatOnSave');
    expect(loadSettings().formatOnSave).toBe(true); // user value never moved
    expect(formatOnSaveToggle().getAttribute('aria-checked')).toBe('true');
    expect(scopeBtn(FOS_SCOPE, 'user').getAttribute('aria-checked')).toBe('true');
  });

  it('on reopen, a row with an existing override shows Workspace scope and the override value', () => {
    // Seed an override directly, then open with the workspace key.
    saveSettings({ ...DEFAULT_SETTINGS, wordWrap: false });
    const prefs = createPreferences({ onChange: () => {}, workspaceKey: () => KEY });
    prefs.open();
    // No override yet → User.
    expect(scopeBtn(WORD_WRAP_SCOPE, 'user').getAttribute('aria-checked')).toBe('true');
    // Create the override, reopen.
    scopeBtn(WORD_WRAP_SCOPE, 'workspace').click();
    wordWrapToggle().click(); // override = true
    prefs.close();
    prefs.open();
    expect(scopeBtn(WORD_WRAP_SCOPE, 'workspace').getAttribute('aria-checked')).toBe('true');
    // The value control shows the EFFECTIVE (override) value, not the user value.
    expect(wordWrapToggle().getAttribute('aria-checked')).toBe('true');
  });
});

// chordFromEvent is a pure keydown→CodeMirror-key normalizer; unit-test it directly (no DOM/UI).
describe('chordFromEvent', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('maps a plain function key', () => {
    expect(chordFromEvent(ev({ key: 'F2' }))).toBe('F2');
  });
  it('maps Ctrl+D to a portable Mod chord', () => {
    expect(chordFromEvent(ev({ key: 'd', ctrlKey: true }))).toBe('Mod-d');
  });
  it('maps Shift+F12', () => {
    expect(chordFromEvent(ev({ key: 'F12', shiftKey: true }))).toBe('Shift-F12');
  });
  it('maps Ctrl+. (a punctuation key)', () => {
    expect(chordFromEvent(ev({ key: '.', ctrlKey: true }))).toBe('Mod-.');
  });
  it('returns null for a bare modifier (keep waiting for a real key)', () => {
    expect(chordFromEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Alt', altKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Meta', metaKey: true }))).toBeNull();
  });
  it('lowercases the base and orders modifiers Mod-Shift', () => {
    expect(chordFromEvent(ev({ key: 'K', ctrlKey: true, shiftKey: true }))).toBe('Mod-Shift-k');
  });
});

describe('keyboard settings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  // A test that intentionally leaves a row armed (the min-modifier guard) would leak its document-level
  // keydown listener into the next test. Escape disarms an armed recorder and is a harmless no-op
  // otherwise, so dispatch it between tests to guarantee no listener survives.
  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('#koi-settings-panel-keyboard .koi-kbd-row')];
  const rowFor = (id: string) =>
    document.querySelector<HTMLElement>(`#koi-settings-panel-keyboard .koi-kbd-row[data-binding-id="${id}"]`)!;
  const chordOf = (id: string) => rowFor(id).querySelector<HTMLElement>('.koi-kbd-chord')!;
  const recordBtn = (id: string) => rowFor(id).querySelector<HTMLButtonElement>('.koi-kbd-record')!;
  const resetBtn = (id: string) => rowFor(id).querySelector<HTMLButtonElement>('.koi-kbd-reset')!;
  const conflictOf = (id: string) => rowFor(id).querySelector<HTMLElement>('.koi-kbd-conflict')!;
  const reassignBtn = (id: string) => rowFor(id).querySelector<HTMLButtonElement>('.koi-kbd-reassign')!;

  // Simulate the recording flow: arm the row, then deliver a keydown to the document-level listener.
  function record(id: string, init: KeyboardEventInit): void {
    recordBtn(id).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  }

  it('lists all five rebindable commands, each showing its resolved key', () => {
    openPrefs();
    expect(rows()).toHaveLength(5);
    // happy-dom is a non-mac platform, so "Mod" renders as "Ctrl"; F12 has no modifier.
    expect(chordOf('goToDefinition').textContent).toBe('F12');
    expect(chordOf('format').textContent).toBe('Ctrl+S');
  });

  it('recording a chord persists the override, updates the display, and fires onKeybindingsChanged', () => {
    const onKeybindingsChanged = vi.fn();
    openPrefs({ onKeybindingsChanged });
    record('format', { key: 'j', ctrlKey: true });
    expect(loadKeybindingOverrides().format).toBe('Mod-j');
    expect(onKeybindingsChanged).toHaveBeenCalled();
    expect(chordOf('format').textContent).toBe('Ctrl+J');
  });

  it('per-row Reset restores the default and fires onKeybindingsChanged', () => {
    const onKeybindingsChanged = vi.fn();
    openPrefs({ onKeybindingsChanged });
    record('format', { key: 'j', ctrlKey: true });
    expect(loadKeybindingOverrides().format).toBe('Mod-j');

    onKeybindingsChanged.mockClear();
    resetBtn('format').click();
    expect(loadKeybindingOverrides().format).toBeUndefined();
    expect(resolveKeybindings().format).toBe('Mod-s');
    expect(onKeybindingsChanged).toHaveBeenCalled();
  });

  it('a chord already bound to another command surfaces a conflict and defers the save until confirmed', () => {
    const onKeybindingsChanged = vi.fn();
    openPrefs({ onKeybindingsChanged });
    // F12 is go-to-definition's default — recording it onto rename collides.
    record('rename', { key: 'F12' });

    const conflict = conflictOf('rename');
    expect(conflict.hidden).toBe(false);
    expect(conflict.getAttribute('role')).toBe('alert');
    expect(conflict.textContent).toContain('Go to definition');
    // Until confirmed, nothing is written.
    expect(loadKeybindingOverrides().rename).toBeUndefined();

    onKeybindingsChanged.mockClear();
    reassignBtn('rename').click();
    expect(loadKeybindingOverrides().rename).toBe('F12');
    // The prior owner is now explicitly unbound ('').
    expect(loadKeybindingOverrides().goToDefinition).toBe('');
    expect(chordOf('goToDefinition').textContent).toBe('Unbound');
    expect(onKeybindingsChanged).toHaveBeenCalled();
  });

  it('Reset all clears every override and fires onKeybindingsChanged', () => {
    const onKeybindingsChanged = vi.fn();
    openPrefs({ onKeybindingsChanged });
    record('format', { key: 'j', ctrlKey: true });
    expect(loadKeybindingOverrides().format).toBe('Mod-j');

    onKeybindingsChanged.mockClear();
    document.querySelector<HTMLButtonElement>('#koi-settings-panel-keyboard .koi-kbd-reset-all')!.click();
    expect(loadKeybindingOverrides()).toEqual({});
    expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
    expect(onKeybindingsChanged).toHaveBeenCalled();
  });

  it('Advanced "Reset to defaults" also clears keybinding overrides', () => {
    saveKeybindingOverride('format', 'Mod-d');
    openPrefs();
    const danger = document.querySelector<HTMLButtonElement>('#koi-settings-panel-advanced .koi-set-danger')!;
    danger.click(); // arm
    danger.click(); // confirm
    expect(loadKeybindingOverrides()).toEqual({});
    expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('ignores a modifier-less printable key (binding it would make the character un-typeable)', () => {
    const onKeybindingsChanged = vi.fn();
    openPrefs({ onKeybindingsChanged });
    record('format', { key: 'g' }); // a bare letter, no modifier — must be rejected
    expect(loadKeybindingOverrides().format).toBeUndefined();
    expect(onKeybindingsChanged).not.toHaveBeenCalled();
    expect(chordOf('format').textContent).toBe('Ctrl+S'); // unchanged
  });

  it('warns before letting a remap shadow a reserved editor shortcut, then applies on confirm', () => {
    const onKeybindingsChanged = vi.fn();
    openPrefs({ onKeybindingsChanged });
    // Mod-f (Find) is a loaded built-in the registry compartment would shadow — not a rebindable command.
    record('format', { key: 'f', ctrlKey: true });
    const conflict = conflictOf('format');
    expect(conflict.hidden).toBe(false);
    expect(conflict.textContent).toContain('Find');
    expect(loadKeybindingOverrides().format).toBeUndefined(); // deferred until confirmed

    reassignBtn('format').click();
    expect(loadKeybindingOverrides().format).toBe('Mod-f');
    expect(onKeybindingsChanged).toHaveBeenCalled();
  });

  it('recording a command’s own default drops the override instead of persisting a redundant one', () => {
    openPrefs();
    record('format', { key: 'j', ctrlKey: true }); // override away from the default
    expect(loadKeybindingOverrides().format).toBe('Mod-j');
    record('format', { key: 's', ctrlKey: true }); // record the default (Mod-s) back
    expect(loadKeybindingOverrides().format).toBeUndefined();
    expect(resolveKeybindings().format).toBe('Mod-s');
  });

  it('disarms the recorder when the dialog closes, so no leaked listener rebinds a hidden row', () => {
    const onKeybindingsChanged = vi.fn();
    const prefs = createPreferences({ onChange: () => {}, onKeybindingsChanged });
    prefs.open();
    recordBtn('format').click(); // arm, but never deliver a key
    prefs.close();
    // The post-close keystroke must be ignored — the document listener was torn down on close.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(loadKeybindingOverrides().format).toBeUndefined();
    expect(onKeybindingsChanged).not.toHaveBeenCalled();
  });
});
