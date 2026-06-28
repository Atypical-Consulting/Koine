// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createPreferences,
  mountPreferencesPane,
  startMcpSidecarIfEnabled,
  type PrefsCallbacks,
  type PrefsPaneHandle,
} from '@/settings/prefs';
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

  it('the MCP endpoint URL input carries a non-empty id and name and keeps its aria-label', async () => {
    // This input is appended directly (it bypasses row(), which is what assigns id/name elsewhere),
    // so Chrome's "form field should have an id or name attribute" check flags it. See issue #642.
    openPrefs();
    await settle();
    const url = endpointUrl();
    expect(url.id).toBeTruthy();
    expect(url.getAttribute('name')).toBeTruthy();
    expect(url.getAttribute('aria-label')).toBe('Koine MCP endpoint URL');
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

  it('opening the modal with MCP already enabled (re)starts the sidecar and shows the live URL (#735)', async () => {
    // The modal's open path is the original "open Settings to revive the sidecar" affordance — it must
    // survive the start being lifted out of applyOpenState into an explicit on-show call.
    saveSettings({ ...DEFAULT_SETTINGS, mcpEnabled: true });
    const mcpEndpoint = vi.fn(async () => URL);
    openPrefs({ mcpEndpoint });
    await settle();
    expect(mcpEndpoint).toHaveBeenCalled();
    expect(endpointUrl().value).toBe(URL);
  });

  it('a disable during the on-open (re)start drops the stale resolve (mcpGen guard) (#735)', async () => {
    // Open with MCP enabled so startMcpSidecar launches; before its endpoint resolves, the user disables
    // MCP. The mcpGen staleness guard must discard the in-flight resolve so it can't repaint a live URL
    // over the just-disabled "Server off" state. A manually-controlled promise makes the race deterministic.
    saveSettings({ ...DEFAULT_SETTINGS, mcpEnabled: true });
    let resolveEndpoint!: (u: string) => void;
    const mcpEndpoint = vi.fn(() => new Promise<string>((res) => (resolveEndpoint = res)));
    openPrefs({ mcpEndpoint });
    // The on-open start is in flight (endpoint promise still pending). Disable MCP now.
    mcpToggle().click();
    await settle();
    // The stale on-open endpoint resolves AFTER the disable — the guard must drop it.
    resolveEndpoint(URL);
    await settle();
    expect(status().dataset.state).toBe('off');
    expect(endpointUrl().value).toBe('');
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

// The representation-independent (re)start concern extracted in #735: a DOM-free helper the Settings
// page calls on show for BOTH the Visual and JSON representations (the JSON one mounts no preferences
// pane, so it can't rely on the pane's open path). It only asks the host to (lazily) (re)spawn the
// sidecar; reflecting the endpoint in the MCP panel stays the Visual pane's job.
describe('startMcpSidecarIfEnabled (#735)', () => {
  const ENABLED = { ...DEFAULT_SETTINGS, mcpEnabled: true };
  const DISABLED = { ...DEFAULT_SETTINGS, mcpEnabled: false };

  beforeEach(() => {
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
  });

  it('(re)starts the sidecar on a hostable desktop host when MCP is enabled', async () => {
    const mcpEndpoint = vi.fn(async () => URL);
    const url = await startMcpSidecarIfEnabled({ onChange: () => {}, mcpEndpoint, mcpHostable: true }, ENABLED);
    expect(mcpEndpoint).toHaveBeenCalledTimes(1);
    expect(url).toBe(URL);
  });

  it('does nothing when MCP is disabled', async () => {
    const mcpEndpoint = vi.fn(async () => URL);
    const url = await startMcpSidecarIfEnabled({ onChange: () => {}, mcpEndpoint, mcpHostable: true }, DISABLED);
    expect(mcpEndpoint).not.toHaveBeenCalled();
    expect(url).toBe('');
  });

  it('does nothing on a non-hostable (browser) host even when enabled', async () => {
    const mcpEndpoint = vi.fn(async () => URL);
    const url = await startMcpSidecarIfEnabled({ onChange: () => {}, mcpEndpoint, mcpHostable: false }, ENABLED);
    expect(mcpEndpoint).not.toHaveBeenCalled();
    expect(url).toBe('');
  });

  it('reads loadSettings() when no snapshot is passed', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, mcpEnabled: true });
    const mcpEndpoint = vi.fn(async () => URL);
    await startMcpSidecarIfEnabled({ onChange: () => {}, mcpEndpoint, mcpHostable: true });
    expect(mcpEndpoint).toHaveBeenCalledTimes(1);
  });

  it('treats an omitted mcpHostable as hostable (desktop default)', async () => {
    const mcpEndpoint = vi.fn(async () => URL);
    await startMcpSidecarIfEnabled({ onChange: () => {}, mcpEndpoint }, ENABLED);
    expect(mcpEndpoint).toHaveBeenCalledTimes(1);
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

// chordFromEvent + prettyChord moved to shared/platform.ts (beside formatChord) and are unit-tested
// there in platform.test.ts. The keyboard-settings tests below still exercise their behavior through
// the dialog (e.g. the 'Ctrl+S' / 'Unbound' chord-display assertions, which run prettyChord).
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

// #447: the two Assistant toggles — "Compiler tools" (the agentic loop) and "Constrain AI output to
// the Koine grammar" — are mutually exclusive: a GBNF that only accepts `.koi` cannot also emit the
// tool-call JSON the agentic loop needs, so with both on the grammar silently disables the tools.
// They must exclude each other in the UI (grammar wins), and a legacy persisted both-on state must
// normalize to grammar-on/tools-off on open.
describe('Settings → Assistant: Compiler-tools / grammar mutual exclusion (#447)', () => {
  const toolsToggle = () => document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Compiler tools"]')!;
  const grammarToggle = () =>
    document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Constrain AI output to the Koine grammar"]')!;

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('default (grammar on): the Compiler-tools toggle is disabled so it can never be on alongside', () => {
    saveSettings({ ...DEFAULT_SETTINGS }); // aiConstrainGrammar: true, aiAgenticTools: false
    openPrefs();
    expect(grammarToggle().getAttribute('aria-checked')).toBe('true');
    expect(toolsToggle().getAttribute('aria-checked')).toBe('false');
    expect(toolsToggle().disabled).toBe(true);
  });

  it('enabling grammar disables (and clears) the Compiler-tools toggle', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiAgenticTools: false, aiConstrainGrammar: false });
    openPrefs();
    expect(toolsToggle().disabled).toBe(false);
    grammarToggle().click(); // grammar on
    expect(grammarToggle().getAttribute('aria-checked')).toBe('true');
    expect(toolsToggle().disabled).toBe(true);
    expect(toolsToggle().getAttribute('aria-checked')).toBe('false');
    expect(loadSettings().aiConstrainGrammar).toBe(true);
    expect(loadSettings().aiAgenticTools).toBe(false);
  });

  it('enabling Compiler-tools disables (and clears) the grammar toggle', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiAgenticTools: false, aiConstrainGrammar: false });
    openPrefs();
    toolsToggle().click(); // tools on
    expect(toolsToggle().getAttribute('aria-checked')).toBe('true');
    expect(grammarToggle().disabled).toBe(true);
    expect(grammarToggle().getAttribute('aria-checked')).toBe('false');
    expect(loadSettings().aiAgenticTools).toBe(true);
    expect(loadSettings().aiConstrainGrammar).toBe(false);
  });

  it('clicking the disabled (greyed) toggle is a no-op — the both-on state can never be set', () => {
    saveSettings({ ...DEFAULT_SETTINGS }); // grammar on → tools toggle disabled
    openPrefs();
    expect(toolsToggle().disabled).toBe(true);
    // A real user click on a native-disabled <button> dispatches no click event; emulate that contract
    // by firing click() and asserting nothing changed (the native `disabled` is the actual safety net).
    toolsToggle().click();
    expect(toolsToggle().getAttribute('aria-checked')).toBe('false');
    expect(grammarToggle().getAttribute('aria-checked')).toBe('true');
    expect(loadSettings().aiAgenticTools).toBe(false);
    expect(loadSettings().aiConstrainGrammar).toBe(true);
  });

  it('loading a legacy both-on state normalizes to grammar-on / tools-off (and persists it)', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiAgenticTools: true, aiConstrainGrammar: true });
    openPrefs();
    expect(grammarToggle().getAttribute('aria-checked')).toBe('true');
    expect(toolsToggle().getAttribute('aria-checked')).toBe('false');
    expect(toolsToggle().disabled).toBe(true);
    // The correction is persisted, not just reflected in the DOM.
    expect(loadSettings().aiAgenticTools).toBe(false);
    expect(loadSettings().aiConstrainGrammar).toBe(true);
  });
});

describe('Settings → Display name (#479)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  const displayNameInput = () =>
    document.querySelector<HTMLInputElement>('#koi-set-display-name')!;

  it('renders a Display name text input in the Appearance panel, bound to settings.displayName', () => {
    saveSettings({ ...DEFAULT_SETTINGS, displayName: 'Ada Lovelace' });
    openPrefs();
    const input = displayNameInput();
    expect(input).not.toBeNull();
    expect(input.type).toBe('text');
    // It lives in the Appearance panel and is populated from the stored display name on open.
    expect(input.closest('#koi-settings-panel-appearance')).not.toBeNull();
    expect(input.value).toBe('Ada Lovelace');
  });

  it('editing the field commits displayName via patchSettings and reports it through onChange', () => {
    const onChange = vi.fn();
    openPrefs({ onChange });
    const input = displayNameInput();
    input.value = 'Grace Hopper';
    input.dispatchEvent(new Event('change'));
    expect(loadSettings().displayName).toBe('Grace Hopper');
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last.displayName).toBe('Grace Hopper');
  });

  it('trims surrounding whitespace when committing the display name', () => {
    openPrefs();
    const input = displayNameInput();
    input.value = '   Alan Turing   ';
    input.dispatchEvent(new Event('change'));
    expect(loadSettings().displayName).toBe('Alan Turing');
  });
});

// Task 4: the prefs FORM extracted from the modal so it can mount into an arbitrary container (the
// transient 'settings' center view in Task 5). mountPreferencesPane builds the same two-pane category
// rail + control pane that createPreferences hands to the modal, but appends it straight into the given
// container — no modal chrome / backdrop (createModal is what produces the `.koi-modal-backdrop`) — and
// returns a destroy() that tears the form (and its child CodeMirror editors) back down.
describe('mountPreferencesPane', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  // onChange is the only required PrefsCallbacks member; the rest are optional host capabilities a bare
  // mount can omit (no MCP sidecar, no workspace scoping). A no-op cb exercises the pure-form path.
  const noopCb: PrefsCallbacks = { onChange: () => {} };

  it('renders the two-pane form into the provided container (no modal/backdrop)', () => {
    const handle: PrefsPaneHandle = mountPreferencesPane(host, noopCb);
    // Every category rail label renders straight into the container...
    expect(host.textContent).toContain('Appearance');
    expect(host.textContent).toContain('Editor');
    expect(host.textContent).toContain('About');
    // ...as the two-pane layout, mounted in-container rather than as a global modal overlay.
    expect(host.querySelector('.koi-settings-layout')).not.toBeNull();
    expect(document.querySelector('.koi-modal-backdrop')).toBeNull();
    handle.destroy();
  });

  it('populates controls from the current Settings on mount', () => {
    saveSettings({ ...DEFAULT_SETTINGS, displayName: 'Ada Lovelace' });
    const handle = mountPreferencesPane(host, noopCb);
    const input = host.querySelector<HTMLInputElement>('#koi-set-display-name')!;
    expect(input.value).toBe('Ada Lovelace');
    handle.destroy();
  });

  it('a bare mount never spawns the sidecar; startMcpSidecar is what (re)starts it on show (#735)', async () => {
    // The modal mounts this pane at app init (long before its first open), so the opt-in server must NOT
    // spawn until the surface is actually shown. The (re)start moved to the explicit startMcpSidecar call.
    saveSettings({ ...DEFAULT_SETTINGS, mcpEnabled: true });
    const mcpEndpoint = vi.fn(async () => URL);
    const handle = mountPreferencesPane(host, { onChange: () => {}, mcpEndpoint, mcpHostable: true });
    await settle();
    expect(mcpEndpoint).not.toHaveBeenCalled(); // mounted but never shown → no spawn
    handle.startMcpSidecar(); // the on-show hook
    await settle();
    expect(mcpEndpoint).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it('destroy clears the container and tears down the MCP code view', () => {
    const handle = mountPreferencesPane(host, noopCb);
    // The MCP recipe is a read-only CodeMirror view (createJsonView) mounted inside the pane.
    expect(host.querySelector('.koi-mcp-snippet .cm-editor')).not.toBeNull();
    handle.destroy();
    expect(host.children.length).toBe(0);
    expect(document.querySelector('.koi-mcp-snippet .cm-editor')).toBeNull();
  });
});
