import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'vitest-axe';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS } from '@/settings/persistence';

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

// The real header markup (index.html): an <h2> title + an empty #settings-mode-toggle host the
// radiogroup mounts into.
function makeHeader(): HTMLElement {
  const header = document.createElement('header');
  const h2 = document.createElement('h2');
  h2.textContent = 'Settings';
  const toggle = document.createElement('div');
  toggle.id = 'settings-mode-toggle';
  header.append(h2, toggle);
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
});
