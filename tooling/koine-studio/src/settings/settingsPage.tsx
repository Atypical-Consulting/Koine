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
import { mountPreferencesPane, segmented, type PrefsCallbacks } from '@/settings/prefs';
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

// Stable id on the diagnostics strip so the editor content's `aria-errormessage` can target it. The page
// builds exactly one Settings instance at a time and tears the strip down on teardown/representation swap,
// so a constant id never collides. See createJsonSettingsEditor.setInvalid (editor.ts) for the field side.
const DIAGNOSTICS_ID = 'settings-json-diagnostics';

export interface SettingsPageHandle {
  /**
   * Re-sync the active representation from the live settings — call on every (re)open, since settings can
   * change from OTHER surfaces (the toolbar theme toggle, the command palette) while the page sits built
   * but hidden. The Visual pane repaints; the JSON editor re-seeds (only when it diverges, so an in-flight
   * valid edit isn't disturbed) and any stale diagnostics clear. Pass a category id (#731) to land the
   * Visual pane on that tab (the About deep-link); ignored in JSON mode, which has no category tabs.
   */
  refresh(category?: string): void;
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
  // The shared, keyboard-navigable segmented() control (prefs.ts): a role=radiogroup of role=radio
  // buttons with roving tabindex (checked → 0, other → -1) and arrow/Home/End navigation where focus
  // follows selection. Selecting an option switches the page's representation via setMode. This reuses
  // the same control the Theme + scope toggles use, replacing a hand-rolled radiogroup that duplicated
  // the identical ARIA + key handling.
  const modeToggle = segmented<SettingsEditorMode>('Settings representation', MODES, setMode);

  // The header already carries an <h2> + an empty #settings-mode-toggle slot (index.html); mount into
  // that slot when present, else append to the header directly (keeps tests/callers that pass a bare
  // header working).
  const toggleHost = hosts.header.querySelector('#settings-mode-toggle') ?? hosts.header;
  toggleHost.append(modeToggle.el);

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
    // Persistent field↔error relationship: point the editor content at the now-visible strip so a
    // screen-reader user re-entering the field is told it is invalid (the role=alert announcement is
    // one-shot). No-op when the JSON editor isn't mounted.
    editor?.setInvalid(DIAGNOSTICS_ID);
  }

  function clearDiagnostics(): void {
    if (!diagnostics) return;
    diagnostics.hidden = true;
    diagnostics.replaceChildren();
    // Valid document → drop aria-invalid / aria-errormessage so the field reads clean.
    editor?.setInvalid(null);
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

  function buildBody(): void {
    if (mode === 'visual') {
      pane = mountPreferencesPane(hosts.body, cb);
      // Show the pane (repaint + start the MCP sidecar when enabled) but DON'T focus the category tab —
      // this is an embedded center page, not a modal, so stealing focus onto a tab would be jarring.
      pane.refresh(undefined, false);
    } else {
      // Seed from loadSettings() (the secret is already omitted by settingsToJsonDoc).
      editor = createJsonSettingsEditor(hosts.body, {
        onChange: (text) => scheduleApply(text),
        initial: settingsToJsonDoc(loadSettings()),
      });
      // The diagnostics strip lives below the editor; role=alert so a fresh error is announced. The id lets
      // the editor content's aria-errormessage point at it while the document is invalid (setInvalid).
      diagnostics = el('div', {
        class: 'settings-json-diagnostics',
        attrs: { id: DIAGNOSTICS_ID, role: 'alert', hidden: true },
      });
      hosts.body.append(diagnostics);
    }
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
    modeToggle.set(mode);
    buildBody();
  }

  // Re-sync the active representation from the live settings (see SettingsPageHandle.refresh). Called by
  // the host on every (re)open so a change made elsewhere while the page sat hidden is reflected. An
  // optional category (#731) lands the Visual pane on that tab; embedded, so never steal focus onto it.
  function refresh(category?: string): void {
    // A category deep-link (e.g. the About command) targets a Visual category tab; the JSON
    // representation has no tabs, so switch to Visual first — otherwise the requested category is silently
    // dropped and the page just shows the settings.json editor (#731).
    if (category && mode === 'json') setMode('visual');
    if (mode === 'visual') {
      pane?.refresh(category, false); // repaint from live settings; land on `category` when given
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
  }

  // Initial paint.
  modeToggle.set(mode);
  buildBody();

  return {
    refresh,
    destroy(): void {
      teardownBody();
      modeToggle.el.remove(); // clear the header toggle
    },
  };
}
