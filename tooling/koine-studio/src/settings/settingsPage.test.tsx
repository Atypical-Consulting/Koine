import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'vitest-axe';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, effectiveSettings } from '@/settings/persistence';

// vi.mock is hoisted above module-scope consts, so the spies must come from vi.hoisted(). loadSettings()
// returns a COMPLETE Settings incl the live secret `aiApiKey: 'sk-LIVE'` — settingsToJsonDoc must strip
// it from the JSON seed, and jsonDocToSettings must re-inject it on a valid edit.
const { saveSettings, loadSettings } = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  loadSettings: vi.fn(() => ({ ...DEFAULT_SETTINGS, aiApiKey: 'sk-LIVE' })),
}));
// Partial mock: keep DEFAULT_SETTINGS, patchSettings, whenSecretsReady, … real (mountPreferencesPane
// needs them) but swap save/load so the page's persist/read path is observable + deterministic.
vi.mock('@/settings/persistence', async (orig) => ({
  ...(await orig<typeof import('@/settings/persistence')>()),
  saveSettings,
  loadSettings,
}));

// Theme has its own live-apply path (dataset + listeners) outside cb.onChange/applyAppearance; spy on it
// so the JSON apply path's explicit setTheme() call is observable. Everything else in the module stays real.
const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }));
vi.mock('@/settings/theme', async (orig) => ({
  ...(await orig<typeof import('@/settings/theme')>()),
  setTheme,
}));

import { createSettingsPage, type SettingsPageHandle } from './settingsPage';

const MODE_KEY = 'koine.studio.settingsEditorMode';
const SCOPE_KEY = 'koine.studio.settingsJsonScope';

// The real header markup (index.html): an <h2> title + a controls cluster holding the #settings-scope-toggle
// slot (User/Workspace mounts here in JSON mode) and the #settings-mode-toggle slot (the Visual/JSON
// radiogroup), so both toggles share one row.
function makeHeader(): HTMLElement {
  const header = document.createElement('header');
  const h2 = document.createElement('h2');
  h2.textContent = 'Settings';
  const controls = document.createElement('div');
  controls.className = 'settings-page-header-controls';
  const scopeSlot = document.createElement('div');
  scopeSlot.id = 'settings-scope-toggle';
  const modeSlot = document.createElement('div');
  modeSlot.id = 'settings-mode-toggle';
  controls.append(scopeSlot, modeSlot);
  header.append(h2, controls);
  return header;
}

const cb = { onChange: vi.fn() } as const;

const jsonRadio = (header: HTMLElement): HTMLElement =>
  Array.from(header.querySelectorAll<HTMLElement>('[role="radio"]')).find((b) => /json/i.test(b.textContent ?? ''))!;
const visualRadio = (header: HTMLElement): HTMLElement =>
  Array.from(header.querySelectorAll<HTMLElement>('[role="radio"]')).find((b) => /visual/i.test(b.textContent ?? ''))!;

// The JSON editor's content carries a distinctive aria-label (set by createJsonSettingsEditor), so it
// can be told apart from the Visual pane's own CodeMirror view (the read-only MCP recipe snippet).
const jsonEditor = (body: HTMLElement): HTMLElement | null =>
  body.querySelector<HTMLElement>('[aria-label="Settings JSON document"]');

// Drive a real edit through the page's onChange seam: the JSON editor (createJsonSettingsEditor) fires
// its onChange on every doc change, including this programmatic dispatch — exactly the path a keystroke
// takes — so the page's debounced validate/persist handler runs for real (no test-only back door).
function typeJson(body: HTMLElement, text: string): void {
  const view = EditorView.findFromDOM(body.querySelector('.cm-editor') as HTMLElement)!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

describe('createSettingsPage', () => {
  let header: HTMLElement;
  let body: HTMLElement;
  let handle: SettingsPageHandle | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    saveSettings.mockClear();
    cb.onChange.mockClear();
    setTheme.mockClear();
    // Re-establish the default loaded settings each test (a test may override loadSettings to simulate a
    // change from another surface).
    loadSettings.mockImplementation(() => ({ ...DEFAULT_SETTINGS, aiApiKey: 'sk-LIVE' }));
    document.body.innerHTML = '';
    header = makeHeader();
    body = document.createElement('div');
    // The real page lives inside the app's <main> landmark (index.html); mirror that so the a11y run
    // doesn't trip the "all content within a landmark" (region) best-practice rule on a bare fixture.
    const main = document.createElement('main');
    main.append(header, body);
    document.body.append(main);
    localStorage.clear();
  });

  afterEach(() => {
    handle?.destroy();
    handle = undefined;
    vi.useRealTimers();
  });

  it('renders a Visual/JSON segmented toggle (radiogroup) and starts in Visual', () => {
    handle = createSettingsPage({ header, body }, cb);
    const group = header.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBeTruthy();
    const radios = group!.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(2);
    // Visual is the default + checked, with a roving tabindex (checked → 0, other → -1).
    expect(visualRadio(header).getAttribute('aria-checked')).toBe('true');
    expect(visualRadio(header).getAttribute('tabindex')).toBe('0');
    expect(jsonRadio(header).getAttribute('aria-checked')).toBe('false');
    expect(jsonRadio(header).getAttribute('tabindex')).toBe('-1');
    expect(body.textContent).toContain('Appearance');
  });

  it('arrow keys move the representation toggle (focus follows selection) and switch the body', () => {
    // The toggle is a single-select radiogroup, so an arrow both moves focus AND activates. This pins the
    // keyboard behavior across the swap from the bespoke radiogroup to the shared segmented() control.
    handle = createSettingsPage({ header, body }, cb);
    const press = (el: HTMLElement, key: string): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };
    // ArrowRight on Visual selects JSON: roving tabindex moves, focus follows, the body becomes the editor.
    press(visualRadio(header), 'ArrowRight');
    expect(jsonRadio(header).getAttribute('aria-checked')).toBe('true');
    expect(jsonRadio(header).getAttribute('tabindex')).toBe('0');
    expect(visualRadio(header).getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(jsonRadio(header));
    expect(jsonEditor(body)).not.toBeNull();
    // ArrowLeft brings it back to Visual (the two-pane form returns).
    press(jsonRadio(header), 'ArrowLeft');
    expect(visualRadio(header).getAttribute('aria-checked')).toBe('true');
    expect(body.textContent).toContain('Appearance');
  });

  it('switching to JSON serializes current settings without the secret', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    // Read the editor's actual document (the seed) — robust vs. happy-dom's partial line rendering.
    const view = EditorView.findFromDOM(body.querySelector('.cm-editor') as HTMLElement)!;
    const text = view.state.doc.toString();
    expect(text).toContain('theme');
    expect(text).not.toContain('aiApiKey');
    expect(text).not.toContain('sk-LIVE');
    expect(localStorage.getItem(MODE_KEY)).toBe('json');
  });

  it('a valid JSON edit debounces into saveSettings (with the secret re-injected) and live-applies', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    typeJson(body, '{ "fontSize": 15 }');
    // Not yet — the apply is debounced (~350ms).
    expect(saveSettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const saved = saveSettings.mock.calls.at(-1)![0];
    expect(saved.fontSize).toBe(15);
    expect(saved.aiApiKey).toBe('sk-LIVE'); // secret re-injected from loadSettings()
    // Live-applied through the same cb.onChange hook the Visual form uses.
    expect(cb.onChange).toHaveBeenCalledWith(saved);
  });

  it('a JSON theme edit applies the theme live via setTheme (cb.onChange does not cover theme)', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    typeJson(body, '{ "theme": "light" }');
    vi.advanceTimersByTime(500);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // Theme is applied through its own path, not just cb.onChange — without this the studio wouldn't re-skin.
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('refresh() re-seeds the JSON editor when settings changed from another surface', () => {
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cb);
    const read = (): string =>
      EditorView.findFromDOM(body.querySelector('.cm-editor') as HTMLElement)!.state.doc.toString();
    expect(read()).toContain(`"fontSize": ${DEFAULT_SETTINGS.fontSize}`);
    // A setting changes elsewhere (toolbar/palette) while the page sits built but hidden.
    loadSettings.mockImplementation(() => ({ ...DEFAULT_SETTINGS, aiApiKey: 'sk-LIVE', fontSize: 19 }));
    handle.refresh();
    expect(read()).toContain('"fontSize": 19');
    // A programmatic re-seed is not a user edit: it must NOT schedule a persist.
    vi.advanceTimersByTime(500);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('an invalid JSON edit shows a diagnostic and never persists', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    typeJson(body, '{ "theme": ');
    vi.advanceTimersByTime(500);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(body.querySelector('.settings-json-diagnostics')).not.toBeNull();
    expect(body.textContent?.toLowerCase()).toMatch(/invalid|error|json/);
  });

  it('an invalid JSON edit marks the editor aria-invalid then a valid edit clears it', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    // Invalid document → the field carries the persistent invalid/error relationship.
    typeJson(body, '{ "theme": ');
    vi.advanceTimersByTime(500);
    const field = jsonEditor(body)!;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-errormessage')).toBeTruthy();
    // Fix it → a valid document drops both attributes and the field reads clean.
    typeJson(body, '{ "fontSize": 15 }');
    vi.advanceTimersByTime(500);
    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(field.hasAttribute('aria-errormessage')).toBe(false);
  });

  it('aria-errormessage resolves to the diagnostics strip (a real element by id)', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    typeJson(body, '{ "theme": ');
    vi.advanceTimersByTime(500);
    const field = jsonEditor(body)!;
    const strip = body.querySelector<HTMLElement>('.settings-json-diagnostics')!;
    expect(strip.id).toBeTruthy();
    // The field points at the strip's id, so a screen reader can follow the relationship to the
    // (now-visible) error text.
    expect(field.getAttribute('aria-errormessage')).toBe(strip.id);
    expect(document.getElementById(strip.id)).toBe(strip);
  });

  it('an out-of-range value is rejected (schema invalid) and not persisted', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    typeJson(body, '{ "fontSize": 999 }');
    vi.advanceTimersByTime(500);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(body.textContent?.toLowerCase()).toMatch(/invalid|error|json/);
  });

  it('JSON→Visual re-mounts the Visual pane from persisted settings', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    expect(jsonEditor(body)).not.toBeNull();
    visualRadio(header).click();
    // The JSON editor is torn down (the Visual pane has its OWN CodeMirror — the MCP snippet — so target
    // the JSON editor by its content's aria-label rather than the generic .cm-editor) and the form is back.
    expect(jsonEditor(body)).toBeNull();
    expect(body.textContent).toContain('Appearance');
    expect(localStorage.getItem(MODE_KEY)).toBe('visual');
  });

  it('refresh(category) on a JSON-mode page switches to Visual and lands on that tab (#731)', () => {
    // A category deep-link (the About command) targets a Visual tab; JSON has no tabs, so the page must
    // switch to Visual rather than silently drop the category and keep showing the JSON editor.
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cb);
    expect(jsonEditor(body)).not.toBeNull(); // started on JSON

    handle.refresh('about');

    expect(jsonEditor(body)).toBeNull(); // switched to Visual
    expect(visualRadio(header).getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(MODE_KEY)).toBe('visual');
    const aboutTab = body.querySelector<HTMLElement>('#koi-settings-tab-about');
    expect(aboutTab?.getAttribute('aria-selected')).toBe('true');
    expect(body.querySelector<HTMLElement>('#koi-settings-panel-about')?.hidden).toBe(false);
  });

  it('restores the last-used representation from localStorage', () => {
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cb);
    expect(jsonRadio(header).getAttribute('aria-checked')).toBe('true');
    expect(body.querySelector('.cm-editor')).not.toBeNull();
  });

  it('destroy tears down the active pane and clears the header', () => {
    const h = createSettingsPage({ header, body }, cb);
    expect(header.querySelector('[role="radiogroup"]')).not.toBeNull();
    h.destroy();
    expect(header.querySelector('[role="radiogroup"]')).toBeNull();
    expect(body.querySelector('.cm-editor')).toBeNull();
  });

  // --- #735: the desktop MCP sidecar (re)starts on Settings SHOW for BOTH representations -----------
  // Pre-#727 the modal's open path always revived the sidecar; after the Visual/JSON page split the
  // (re)start lived behind the Visual pane, so opening straight into JSON mode never revived it. The
  // page now fires the representation-independent (re)start on show for both panes (assert via the
  // mcpEndpoint callback, the actual host hook that (re)spawns `koine mcp --http`).
  const desktopCb = () => ({
    onChange: vi.fn(),
    mcpEndpoint: vi.fn(async () => 'http://127.0.0.1:51000/mcp'),
    mcpStop: vi.fn(async () => {}),
    mcpHostable: true,
  });
  const enabledMcp = () =>
    loadSettings.mockImplementation(() => ({ ...DEFAULT_SETTINGS, aiApiKey: 'sk-LIVE', mcpEnabled: true }));

  it('opening straight into JSON mode (desktop, MCP enabled) (re)starts the sidecar', () => {
    localStorage.setItem(MODE_KEY, 'json');
    enabledMcp();
    const c = desktopCb();
    handle = createSettingsPage({ header, body }, c);
    // No Visual pane is mounted in JSON mode, yet the on-show concern must still revive the sidecar.
    expect(c.mcpEndpoint).toHaveBeenCalled();
  });

  it('opening into JSON mode on a browser host (not hostable) never starts a sidecar', () => {
    localStorage.setItem(MODE_KEY, 'json');
    enabledMcp();
    const c = { ...desktopCb(), mcpHostable: false };
    handle = createSettingsPage({ header, body }, c);
    expect(c.mcpEndpoint).not.toHaveBeenCalled();
  });

  it('opening into JSON mode with MCP disabled does not start a sidecar', () => {
    localStorage.setItem(MODE_KEY, 'json');
    // mcpEnabled stays false (DEFAULT_SETTINGS).
    const c = desktopCb();
    handle = createSettingsPage({ header, body }, c);
    expect(c.mcpEndpoint).not.toHaveBeenCalled();
  });

  it('opening into Visual mode (desktop, MCP enabled) starts the sidecar exactly once (no double-start)', () => {
    // Default mode is Visual.
    enabledMcp();
    const c = desktopCb();
    handle = createSettingsPage({ header, body }, c);
    expect(c.mcpEndpoint).toHaveBeenCalledTimes(1);
  });

  it('a Visual↔JSON flip fires the (re)start once per representation build, never twice (#735)', () => {
    // Default mode is Visual. The flip re-invokes the (idempotent) on-show concern exactly once per build
    // — so flipping to Visual reflects the live endpoint, and the host reuses the running sidecar rather
    // than spawning a second one. The Studio-side guarantee under test is "one mcpEndpoint call per build".
    enabledMcp();
    const c = desktopCb();
    handle = createSettingsPage({ header, body }, c);
    expect(c.mcpEndpoint).toHaveBeenCalledTimes(1); // initial Visual show
    jsonRadio(header).click(); // flip to JSON
    expect(c.mcpEndpoint).toHaveBeenCalledTimes(2);
    visualRadio(header).click(); // flip back to Visual
    expect(c.mcpEndpoint).toHaveBeenCalledTimes(3);
  });

  it('re-showing the page in JSON mode (refresh) (re)starts the sidecar again', () => {
    localStorage.setItem(MODE_KEY, 'json');
    enabledMcp();
    const c = desktopCb();
    handle = createSettingsPage({ header, body }, c);
    c.mcpEndpoint.mockClear();
    handle.refresh(); // the host calls this on every re-open of Settings
    expect(c.mcpEndpoint).toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    // axe schedules its async ruleset on real setTimeout, so it never resolves under fake timers.
    vi.useRealTimers();
    handle = createSettingsPage({ header, body }, cb);
    expect(await axe(document.body)).toHaveNoViolations();
  });

  // --- Task 2: JSON scope toggle (User | Workspace) #736 -----------------------------------
  // The scope toggle is a segmented control (role=radiogroup) mounted into the HEADER beside the
  // Visual/JSON toggle. It appears only in JSON mode and is torn down on mode-swap or destroy().

  // Helpers: query the scope toggle (it lives in the header, beside the representation toggle).
  const scopeGroup = (root: HTMLElement): HTMLElement | null =>
    root.querySelector('[role="radiogroup"][aria-label="Settings JSON scope"]');
  const scopeBtn = (root: HTMLElement, v: 'user' | 'workspace'): HTMLButtonElement | null =>
    (scopeGroup(root)?.querySelector(`[data-value="${v}"]`) as HTMLButtonElement | null) ?? null;

  it('scope toggle is absent in Visual mode (default)', () => {
    handle = createSettingsPage({ header, body }, cb);
    expect(scopeGroup(header)).toBeNull();
  });

  it('scope toggle appears when starting in JSON mode', () => {
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cb);
    expect(scopeGroup(header)).not.toBeNull();
  });

  it('scope toggle appears after switching from Visual to JSON', () => {
    handle = createSettingsPage({ header, body }, cb);
    jsonRadio(header).click();
    expect(scopeGroup(header)).not.toBeNull();
  });

  it('scope toggle is removed when switching back to Visual', () => {
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cb);
    expect(scopeGroup(header)).not.toBeNull();
    visualRadio(header).click();
    expect(scopeGroup(header)).toBeNull();
  });

  it('destroy() removes the scope toggle from the header', () => {
    localStorage.setItem(MODE_KEY, 'json');
    const h = createSettingsPage({ header, body }, cb);
    expect(scopeGroup(header)).not.toBeNull();
    h.destroy();
    expect(scopeGroup(header)).toBeNull();
  });

  it('without a workspace: Workspace pill is disabled/aria-disabled, scope forced to user, note shown', () => {
    // cb has no workspaceKey → wsKey() returns null
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cb);

    const group = scopeGroup(header)!;
    expect(group).not.toBeNull();
    // Group marked as disabled
    expect(group.getAttribute('aria-disabled')).toBe('true');
    expect(group.classList.contains('is-disabled')).toBe(true);
    // User is checked, Workspace is not
    expect(scopeBtn(header, 'user')!.getAttribute('aria-checked')).toBe('true');
    expect(scopeBtn(header, 'workspace')!.getAttribute('aria-checked')).toBe('false');
    // Workspace button is natively disabled
    expect(scopeBtn(header, 'workspace')!.disabled).toBe(true);
    // Empty-state note shown
    expect(body.querySelector('.settings-json-scope-empty')).not.toBeNull();
    expect(body.textContent).toContain('Open a folder to edit workspace settings');
  });

  it('with a workspace open: pills are enabled, no empty-state note', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => 'ws-key' };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);

    const group = scopeGroup(header)!;
    expect(group.getAttribute('aria-disabled')).toBe('false');
    expect(group.classList.contains('is-disabled')).toBe(false);
    expect(scopeBtn(header, 'user')!.disabled).toBe(false);
    expect(scopeBtn(header, 'workspace')!.disabled).toBe(false);
    expect(body.querySelector('.settings-json-scope-empty')).toBeNull();
  });

  it('clicking Workspace (workspace open) flips aria-checked and persists the scope', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => 'ws-key' };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);

    scopeBtn(header, 'workspace')!.click();

    expect(scopeBtn(header, 'workspace')!.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(SCOPE_KEY)).toBe('workspace');
  });

  it('ArrowRight on User radio moves to Workspace and persists scope', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => 'ws-key' };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);

    scopeBtn(header, 'user')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(scopeBtn(header, 'workspace')!.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(SCOPE_KEY)).toBe('workspace');
  });

  // --- Fix 3: mid-session folder-open restores persisted scope (#736) -------
  it('mid-session folder open restores persisted workspace scope', () => {
    // A prior session persisted 'workspace' as the preferred scope.
    localStorage.setItem(SCOPE_KEY, 'workspace');
    // Start with NO workspace key — scope must be forced to 'user'.
    let wsk: string | null = null;
    const cbMutable = { onChange: vi.fn(), workspaceKey: () => wsk };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbMutable);

    // No workspace open: User is active regardless of the persisted scope.
    expect(scopeBtn(header, 'user')!.getAttribute('aria-checked')).toBe('true');
    expect(scopeBtn(header, 'workspace')!.getAttribute('aria-checked')).toBe('false');

    // Simulate folder open mid-session.
    wsk = 'ws-key';
    handle.refresh();

    // Now scope should be restored to 'workspace' (from SCOPE_KEY) because a folder is open.
    expect(scopeBtn(header, 'workspace')!.getAttribute('aria-checked')).toBe('true');
    // Editor is seeded with the flat workspace doc (no overrides → empty object).
    const wsText = EditorView.findFromDOM(body.querySelector('.cm-editor') as HTMLElement)!.state.doc.toString();
    expect(wsText).toContain('{}');
  });

  // --- Task 3: Workspace scope round-trip (#736) -----------------------------------------
  // Each test uses a workspace-capable cb so the Workspace pill is enabled.

  const WS_KEY = 'ws-key';
  const WS_OVERRIDES_KEY = `koine.studio.wsOverrides.${WS_KEY}`;

  it('a valid Workspace doc sets the wsOverrides blob and calls onChange with user-level settings', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => WS_KEY };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);
    // Switch to Workspace scope.
    scopeBtn(header, 'workspace')!.click();
    cbWs.onChange.mockClear();

    // Type a valid workspace doc that sets previewTarget.
    typeJson(body, '{ "previewTarget": "typescript" }');
    vi.advanceTimersByTime(500);

    // (1) The keyed wsOverrides blob carries previewTarget.
    const blob = JSON.parse(localStorage.getItem(WS_OVERRIDES_KEY) ?? '{}') as Record<string, unknown>;
    expect(blob.previewTarget).toBe('typescript');
    // (2) cb.onChange receives USER-level settings (not merged). The host computes effectiveSettings
    //     itself using the persisted blob — passing merged settings here would leak overrides into the
    //     user baseline and contaminate other workspaces.
    expect(cbWs.onChange).toHaveBeenCalledTimes(1);
    const received = cbWs.onChange.mock.calls[0][0] as typeof DEFAULT_SETTINGS;
    expect(received.previewTarget).toBe(DEFAULT_SETTINGS.previewTarget); // user-level: 'csharp'
    // The override IS live-applicable: the merge the host would compute gives 'typescript'.
    expect(effectiveSettings(loadSettings(), WS_KEY).previewTarget).toBe('typescript');
  });

  it('setting the Workspace doc to {} clears the override from the blob', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => WS_KEY };
    // Pre-seed a workspace override in localStorage.
    localStorage.setItem(WS_OVERRIDES_KEY, JSON.stringify({ previewTarget: 'typescript' }));
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);
    scopeBtn(header, 'workspace')!.click();

    // Type an empty workspace doc — clears all scoped overrides.
    typeJson(body, '{}');
    vi.advanceTimersByTime(500);

    // All four scoped keys must be absent from the blob after replace.
    const blob = JSON.parse(localStorage.getItem(WS_OVERRIDES_KEY) ?? '{}') as Record<string, unknown>;
    expect(blob.previewTarget).toBeUndefined();
    expect(blob.formatOnSave).toBeUndefined();
    expect(blob.wordWrap).toBeUndefined();
    expect(blob.lspTrace).toBeUndefined();
  });

  it('an invalid Workspace doc renders diagnostics and persists nothing to the blob', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => WS_KEY };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);
    scopeBtn(header, 'workspace')!.click();
    cbWs.onChange.mockClear();

    // An unknown key violates additionalProperties:false on the workspace schema.
    typeJson(body, '{ "badKey": "value" }');
    vi.advanceTimersByTime(500);

    // Diagnostics strip is visible.
    expect(body.querySelector<HTMLElement>('.settings-json-diagnostics')?.hidden).toBe(false);
    expect(body.textContent?.toLowerCase()).toMatch(/invalid|error/);
    // Nothing was persisted — blob is still absent.
    expect(localStorage.getItem(WS_OVERRIDES_KEY)).toBeNull();
    // No onChange call.
    expect(cbWs.onChange).not.toHaveBeenCalled();
  });

  it('switching to Workspace scope re-seeds the editor with the flat workspace doc', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => WS_KEY };
    // Pre-seed an override so the workspace doc is non-empty.
    localStorage.setItem(WS_OVERRIDES_KEY, JSON.stringify({ previewTarget: 'typescript' }));
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);
    // Currently User scope — editor shows the grouped user settings.json.
    const userText = EditorView.findFromDOM(body.querySelector('.cm-editor') as HTMLElement)!.state.doc.toString();
    expect(userText).toContain('appearance'); // the grouped user doc has top-level group names

    // Switch to Workspace scope.
    scopeBtn(header, 'workspace')!.click();

    // Editor now shows the flat workspace override doc.
    const wsText = EditorView.findFromDOM(body.querySelector('.cm-editor') as HTMLElement)!.state.doc.toString();
    expect(wsText).toContain('"previewTarget"');
    expect(wsText).toContain('"typescript"');
    expect(wsText).not.toContain('appearance');
    // A scope switch alone must NOT persist anything.
    vi.advanceTimersByTime(500);
    expect(cbWs.onChange).not.toHaveBeenCalled();
  });

  it('a valid Workspace doc does not call setTheme (theme is not a scoped key)', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => WS_KEY };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);
    scopeBtn(header, 'workspace')!.click();
    setTheme.mockClear();

    typeJson(body, '{ "previewTarget": "typescript" }');
    vi.advanceTimersByTime(500);

    expect(setTheme).not.toHaveBeenCalled();
  });

  // --- Task 4: partial-removal-reverts-to-user integration (#736) ----------------------------
  // Removing a key from the Workspace doc (rather than setting it to the User value) must
  // drop it from the wsOverrides blob entirely — reverting the effective setting to the User
  // value — while the remaining overridden keys stay in the blob and in effectiveSettings.

  it('partial removal of a Workspace key reverts that key to the User value while others stay overridden', () => {
    const cbWs = { onChange: vi.fn(), workspaceKey: (): string | null => WS_KEY };
    localStorage.setItem(MODE_KEY, 'json');
    handle = createSettingsPage({ header, body }, cbWs);

    // Step 1: switch to Workspace scope and apply two overrides.
    scopeBtn(header, 'workspace')!.click();
    cbWs.onChange.mockClear();

    typeJson(body, '{ "previewTarget": "typescript", "lspTrace": "verbose" }');
    vi.advanceTimersByTime(500);

    // Both keys are in the blob.
    const blobAfterTwo = JSON.parse(localStorage.getItem(WS_OVERRIDES_KEY) ?? '{}') as Record<string, unknown>;
    expect(blobAfterTwo.previewTarget).toBe('typescript');
    expect(blobAfterTwo.lspTrace).toBe('verbose');
    expect(cbWs.onChange).toHaveBeenCalledTimes(1);
    // onChange receives user-level settings (not merged); verify the effective merge separately.
    const effectiveAfterTwo = effectiveSettings(loadSettings(), WS_KEY) as typeof DEFAULT_SETTINGS;
    expect(effectiveAfterTwo.previewTarget).toBe('typescript');
    expect(effectiveAfterTwo.lspTrace).toBe('verbose');

    // Step 2: apply a doc with only lspTrace (drop previewTarget).
    cbWs.onChange.mockClear();
    typeJson(body, '{ "lspTrace": "verbose" }');
    vi.advanceTimersByTime(500);

    // previewTarget is gone from the blob (reverted to User value); lspTrace remains.
    const blobAfterOne = JSON.parse(localStorage.getItem(WS_OVERRIDES_KEY) ?? '{}') as Record<string, unknown>;
    expect(blobAfterOne.previewTarget).toBeUndefined();
    expect(blobAfterOne.lspTrace).toBe('verbose');

    // The effective merge now shows the revert: previewTarget is the User default, lspTrace stays.
    // onChange receives user-level settings; the host's effectiveSettings() is the source of truth.
    expect(cbWs.onChange).toHaveBeenCalledTimes(1);
    const effectiveAfterOne = effectiveSettings(loadSettings(), WS_KEY) as typeof DEFAULT_SETTINGS;
    expect(effectiveAfterOne.previewTarget).toBe(DEFAULT_SETTINGS.previewTarget); // reverted to user default
    expect(effectiveAfterOne.lspTrace).toBe('verbose'); // still overridden
  });
});
