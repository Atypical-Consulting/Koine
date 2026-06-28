// The gear-launched Settings center page (#center-panel-settings). It hosts the SAME two-pane
// preference form the modal uses (mountPreferencesPane) PLUS an alternate, editable settings.json
// representation (createJsonSettingsEditor), and a Visual/JSON segmented toggle in the page header to
// switch between them. The JSON side owns a debounced validate-and-apply loop: a parse/schema-valid
// document is persisted (saveSettings) and live-applied through cb.onChange — the very hook every
// Visual control commits through — so an edit in either representation skins the studio immediately.
//
// SECRET INVARIANT: the aiApiKey is never serialized into the JSON. settingsToJsonDoc() strips it from
// the seed and jsonDocToSettings() re-injects the live in-memory key on parse, so the JSON surface can
// neither display nor clear the encrypted key.
import { mountPreferencesPane, startMcpSidecarIfEnabled, type PrefsCallbacks } from '@/settings/prefs';
import { createJsonSettingsEditor, type JsonSettingsEditor } from '@/editor/editor';
import { settingsToJsonDoc, jsonDocToSettings } from '@/settings/settingsSchema';
import { loadSettings, saveSettings } from '@/settings/persistence';
import { setTheme } from '@/settings/theme';
import { el } from '@/shared/el';

/** Which representation the page is showing. Persisted so the last-used one is restored on reopen. */
export type SettingsEditorMode = 'visual' | 'json';

/** localStorage key for the active representation (visual/json). */
const MODE_KEY = 'koine.studio.settingsEditorMode';

/** Debounce before a JSON edit is validated + applied — long enough to coalesce a burst of keystrokes. */
const DEBOUNCE_MS = 350;

export interface SettingsPageHandle {
  /**
   * Re-sync the active representation from the live settings — call on every (re)open, since settings can
   * change from OTHER surfaces (the toolbar theme toggle, the command palette) while the page sits built
   * but hidden. The Visual pane repaints; the JSON editor re-seeds (only when it diverges, so an in-flight
   * valid edit isn't disturbed) and any stale diagnostics clear.
   */
  refresh(): void;
  /** Tear down the active pane/editor, clear the header toggle, and cancel any pending debounce. */
  destroy(): void;
}

/** Read the persisted representation, defaulting to Visual when absent/invalid. */
function loadMode(): SettingsEditorMode {
  return localStorage.getItem(MODE_KEY) === 'json' ? 'json' : 'visual';
}

function saveMode(mode: SettingsEditorMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A storage failure (private mode / quota) must never break switching representations.
  }
}

const MODES: { value: SettingsEditorMode; label: string }[] = [
  { value: 'visual', label: 'Visual' },
  { value: 'json', label: 'JSON' },
];

/**
 * Mount the Settings page into the (already-rendered) header + body hosts and return a teardown handle.
 * The Visual pane is the same form the modal embeds; the JSON editor is the schema-aware settings.json
 * surface. The page owns the representation toggle, the visual↔json swap, and the JSON validate-and-apply
 * loop.
 */
export function createSettingsPage(
  hosts: { header: HTMLElement; body: HTMLElement },
  cb: PrefsCallbacks,
): SettingsPageHandle {
  let mode: SettingsEditorMode = loadMode();

  // Exactly one of these is live at a time (mirrors `mode`).
  let pane: ReturnType<typeof mountPreferencesPane> | null = null;
  let editor: JsonSettingsEditor | null = null;
  let diagnostics: HTMLElement | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- header: the Visual/JSON segmented control ----------------------------
  // An accessible radiogroup: two role=radio buttons, roving tabindex (checked → 0, other → -1), and
  // Left/Right/Up/Down/Home/End arrow navigation that both moves focus AND activates (a single-select
  // group, so focus follows selection).
  const radios: HTMLButtonElement[] = [];
  const group = el('div', {
    class: 'settings-mode-toggle-group',
    attrs: { role: 'radiogroup', 'aria-label': 'Settings representation' },
  });

  for (const { value, label } of MODES) {
    const radio = el('button', {
      class: 'settings-mode-radio',
      text: label,
      attrs: { type: 'button', role: 'radio', 'data-mode': value },
      on: {
        click: () => setMode(value),
        keydown: (e: KeyboardEvent) => onRadioKeydown(e),
      },
    });
    radios.push(radio);
    group.append(radio);
  }

  function paintToggle(): void {
    for (const r of radios) {
      const on = r.dataset.mode === mode;
      r.setAttribute('aria-checked', String(on));
      r.setAttribute('tabindex', on ? '0' : '-1');
      r.classList.toggle('is-active', on);
    }
  }

  function onRadioKeydown(e: KeyboardEvent): void {
    const idx = radios.findIndex((r) => r === e.target);
    if (idx < 0) return;
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % radios.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + radios.length) % radios.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = radios.length - 1;
    else return;
    e.preventDefault();
    setMode(radios[next].dataset.mode as SettingsEditorMode);
    radios[next].focus();
  }

  // The header already carries an <h2> + an empty #settings-mode-toggle slot (index.html); mount into
  // that slot when present, else append to the header directly (keeps tests/callers that pass a bare
  // header working).
  const toggleHost = hosts.header.querySelector('#settings-mode-toggle') ?? hosts.header;
  toggleHost.append(group);

  // --- body: the active representation ---------------------------------------

  function renderDiagnostics(errors: Array<{ message: string; line?: number }>): void {
    if (!diagnostics) return;
    // role=alert announces a content change only while already rendered: reveal BEFORE writing (mirrors
    // the keybinding-conflict alert in prefs.ts). The leading "Invalid" title also guarantees the strip
    // reads as an error regardless of the underlying parser/schema message.
    diagnostics.hidden = false;
    diagnostics.replaceChildren(
      el('p', { class: 'settings-json-diagnostics-title', text: 'Invalid settings.json — changes not saved:' }),
      el(
        'ul',
        { class: 'settings-json-diagnostics-list' },
        errors.map((e) => el('li', { text: e.line != null ? `Line ${e.line}: ${e.message}` : e.message })),
      ),
    );
  }

  function clearDiagnostics(): void {
    if (!diagnostics) return;
    diagnostics.hidden = true;
    diagnostics.replaceChildren();
  }

  // The JSON editor's onChange (fires on every doc change). Debounced so a burst of keystrokes validates
  // once; a valid document persists + live-applies, an invalid one only surfaces diagnostics.
  function scheduleApply(text: string): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      applyJsonText(text);
    }, DEBOUNCE_MS);
  }

  function applyJsonText(text: string): void {
    // `current` = the last persisted settings; jsonDocToSettings re-injects its secret so a JSON edit can
    // never clear/overwrite the encrypted key.
    const res = jsonDocToSettings(text, loadSettings());
    if (res.settings) {
      clearDiagnostics();
      saveSettings(res.settings);
      // Theme has its OWN live-apply path (dataset + listeners) that cb.onChange/applyAppearance do not
      // cover — mirror the Visual form's Theme control, which commits via setTheme. Without this a JSON
      // theme edit would persist but never re-skin the studio.
      setTheme(res.settings.theme);
      cb.onChange(res.settings); // the single live-apply hook the Visual form also commits through
    } else if (res.errors) {
      renderDiagnostics(res.errors); // surface the messages; do NOT persist
    }
  }

  // The desktop MCP sidecar (re)start on Settings SHOW, fired for BOTH representations (issue #735).
  // Before #727 the Settings modal's open path always revived the sidecar; after the Visual/JSON split the
  // (re)start lived behind the Visual pane, so opening straight into JSON never revived it. The Visual pane
  // layers its MCP-panel UI on top via startMcpSidecar; JSON mode mounts no pane, so it calls the DOM-free
  // concern directly. `cb.mcpEndpoint` is idempotent (it reuses a running sidecar), so re-resolving — e.g.
  // after a Visual↔JSON flip — reflects the live endpoint without ever spawning a second process.
  function startMcpOnShow(): void {
    if (mode === 'visual') pane?.startMcpSidecar();
    else void startMcpSidecarIfEnabled(cb);
  }

  function buildBody(): void {
    if (mode === 'visual') {
      pane = mountPreferencesPane(hosts.body, cb);
      // Repaint the pane (but DON'T focus the category tab — this is an embedded center page, not a modal,
      // so stealing focus onto a tab would be jarring); the sidecar (re)start is the startMcpOnShow call.
      pane.refresh(undefined, false);
    } else {
      // Seed from loadSettings() (the secret is already omitted by settingsToJsonDoc).
      editor = createJsonSettingsEditor(hosts.body, {
        onChange: (text) => scheduleApply(text),
        initial: settingsToJsonDoc(loadSettings()),
      });
      // The diagnostics strip lives below the editor; role=alert so a fresh error is announced.
      diagnostics = el('div', { class: 'settings-json-diagnostics', attrs: { role: 'alert', hidden: true } });
      hosts.body.append(diagnostics);
    }
    startMcpOnShow(); // (re)start the sidecar on show, for whichever representation just mounted
  }

  function teardownBody(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pane) {
      pane.destroy();
      pane = null;
    }
    if (editor) {
      editor.destroy();
      editor = null;
    }
    if (diagnostics) {
      diagnostics.remove();
      diagnostics = null;
    }
    // Drop any stragglers so a re-mount starts from a clean body.
    hosts.body.replaceChildren();
  }

  // Switch representation: tear down the current side, then rebuild the other. A JSON→Visual swap always
  // re-mounts from loadSettings() — the LAST VALID PERSISTED state — so if the just-abandoned JSON was
  // invalid (never saved), the form simply shows the last good settings rather than the broken draft.
  function setMode(next: SettingsEditorMode): void {
    if (next === mode) return;
    teardownBody();
    mode = next;
    saveMode(mode);
    paintToggle();
    buildBody();
  }

  // Re-sync the active representation from the live settings (see SettingsPageHandle.refresh). Called by
  // the host on every (re)open so a change made elsewhere while the page sat hidden is reflected.
  function refresh(): void {
    if (mode === 'visual') {
      pane?.refresh(undefined, false); // repaint from live settings; embedded, so don't steal focus
    } else if (editor) {
      // Re-seed only when the persisted document actually differs, so a re-open doesn't clobber an
      // in-flight valid edit. A programmatic re-seed is not a user edit, so drop the onChange-scheduled
      // re-apply it would otherwise trigger. Either way, clear any stale diagnostics.
      const fresh = settingsToJsonDoc(loadSettings());
      if (editor.getText() !== fresh) {
        editor.setContent(fresh);
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
      }
      clearDiagnostics();
    }
    startMcpOnShow(); // a re-open is a show too — (re)start the sidecar regardless of representation (#735)
  }

  // Initial paint.
  paintToggle();
  buildBody();

  return {
    refresh,
    destroy(): void {
      teardownBody();
      group.remove(); // clear the header toggle
    },
  };
}
