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
import { mountPreferencesPane, segmented, startMcpSidecarIfEnabled, type PrefsCallbacks } from '@/settings/prefs';
import { createJsonSettingsEditor, type JsonSettingsEditor } from '@/editor/editor';
import { settingsToJsonDoc, jsonDocToSettings, workspaceOverridesToJsonDoc, jsonDocToWorkspaceOverrides, SETTINGS_JSON_SCHEMA, WORKSPACE_SETTINGS_JSON_SCHEMA } from '@/settings/settingsSchema';
import { loadSettings, saveSettings, loadWorkspaceOverrides, replaceWorkspaceOverrides } from '@/settings/persistence';
import { setTheme } from '@/settings/theme';
import { el } from '@/shared/el';

/** Which representation the page is showing. Persisted so the last-used one is restored on reopen. */
export type SettingsEditorMode = 'visual' | 'json';

/** Which settings document the JSON editor targets. */
type JsonScope = 'user' | 'workspace';

/** localStorage key for the active representation (visual/json). */
const MODE_KEY = 'koine.studio.settingsEditorMode';

/** localStorage key for the active JSON scope (user/workspace). */
const SCOPE_KEY = 'koine.studio.settingsJsonScope';

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

/** Read the persisted JSON scope, defaulting to 'user' when absent/invalid. */
function loadScope(): JsonScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'workspace' ? 'workspace' : 'user';
  } catch {
    return 'user';
  }
}

/** Persist the JSON scope. A storage failure must never break scope switching. */
function saveScope(s: JsonScope): void {
  try {
    localStorage.setItem(SCOPE_KEY, s);
  } catch {
    // Ignore storage failures (private mode / quota).
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
 *
 * @param onClose Optional callback invoked when the user clicks the header close control or presses Esc.
 *   Pass `appStore.getState().closeSettings` from the IDE host to close the Settings overlay (#746).
 */
export function createSettingsPage(
  hosts: { header: HTMLElement; body: HTMLElement },
  cb: PrefsCallbacks,
  onClose?: () => void,
): SettingsPageHandle {
  let mode: SettingsEditorMode = loadMode();

  // The current workspace key (or null when no workspace is open / host doesn't scope settings).
  const wsKey = (): string | null => cb.workspaceKey?.() ?? null;

  // Exactly one of these is live at a time (mirrors `mode`).
  let pane: ReturnType<typeof mountPreferencesPane> | null = null;
  let editor: JsonSettingsEditor | null = null;
  let diagnostics: HTMLElement | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // JSON scope state + the scope toggle control (only live while in JSON mode).
  // Defaults to 'user' when no workspace is open; otherwise restores the persisted choice.
  let scope: JsonScope = wsKey() === null ? 'user' : loadScope();

  // Return the JSON schema for the active scope: the workspace schema is flat (no group nesting),
  // the user schema is the full grouped settings.json schema. Drives the editor's inline linting.
  function schemaForScope(): Record<string, unknown> {
    return scope === 'workspace' ? WORKSPACE_SETTINGS_JSON_SCHEMA : SETTINGS_JSON_SCHEMA;
  }
  let scopeToggle: { el: HTMLElement; set(value: JsonScope): void } | null = null;

  // The wsKey() value captured when the JSON body was last built, so refresh() can detect a
  // workspace-availability change and fully rebuild the body (toggle enabled-state + seed) instead
  // of just re-seeding the existing editor.
  let builtWsKey: string | null = null;

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

  // --- header: close control (#746) -----------------------------------------
  // A visible ✕ button in the header (#settings-page-header) so pointer/touch users can dismiss the
  // Settings overlay without a keyboard. Calls the same `onClose` path as Esc. Always rendered so
  // keyboard and assistive-tech users can discover it; clicking is a no-op when no onClose is wired
  // (defensive — the host always wires it, but tests/callers that omit it must not throw).
  const closeBtn = el('button', {
    class: 'settings-close-btn',
    attrs: {
      type: 'button',
      'aria-label': 'Close settings',
    },
    text: '✕',
  });
  closeBtn.addEventListener('click', () => onClose?.());
  hosts.header.append(closeBtn);

  // --- body: the active representation ---------------------------------------

  // Return the correct seed document for the active scope: the full user settings.json (grouped,
  // namespaced) for 'user', or the flat workspace-scoped overrides document for 'workspace'.
  // Falls back to the user seed when no workspace key is available (defensive — the Workspace pill
  // is disabled when wsKey() is null, so this branch should not occur in normal use).
  function seedForScope(): string {
    if (scope === 'workspace') {
      const key = wsKey();
      if (key === null) return settingsToJsonDoc(loadSettings()); // fallback: no workspace open
      return workspaceOverridesToJsonDoc(loadWorkspaceOverrides(key));
    }
    return settingsToJsonDoc(loadSettings());
  }

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

  // Switch the JSON scope: persists the new choice, syncs the toggle UI, cancels any in-flight
  // debounce (abandoning an invalid draft — mirrors the Visual↔JSON swap behavior), clears stale
  // diagnostics, and re-seeds the editor from the scope's own document.
  function setScope(next: JsonScope): void {
    if (next === scope) return;
    if (next === 'workspace' && wsKey() === null) {
      scopeToggle?.set(scope); // re-sync the toggle to the unchanged scope (Fix 4)
      return;
    }
    scope = next;
    saveScope(scope);
    scopeToggle?.set(scope);
    // Cancel any pending debounce so the old draft is never applied to the new scope.
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearDiagnostics();
    // Re-seed the live editor from the scope-appropriate document and swap the inline schema so
    // the linter/completions/hover stay aligned with the document being edited (Fix 2).
    if (editor) {
      editor.setSchema(schemaForScope());
      editor.setContent(seedForScope());
      // The setContent triggers onChange which schedules a new debounce; cancel it — the seed is
      // already the persisted state, so re-applying it is unnecessary.
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
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
    if (scope === 'workspace') {
      // Defensive guard: never enter the workspace apply path without a workspace key.
      const key = wsKey();
      if (key === null) return;
      const res = jsonDocToWorkspaceOverrides(text);
      if (res.overrides !== undefined) {
        clearDiagnostics();
        replaceWorkspaceOverrides(key, res.overrides);
        // Notify listeners with the USER-level settings. The host (ide.tsx) caches this as the user
        // baseline and computes effectiveSettings(s, wsKey()) itself — passing the merged object would
        // leak workspace overrides into other workspaces as the user baseline. The override is already
        // persisted via replaceWorkspaceOverrides above, so the host's effectiveSettings picks it up.
        // Theme is not a scoped key so setTheme is not needed here.
        cb.onChange(loadSettings());
      } else if (res.errors) {
        renderDiagnostics(res.errors); // surface messages; do NOT persist
      }
      return;
    }
    // user scope (unchanged) -------------------------------------------------
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
      // Snapshot the workspace key once so refresh() can detect an availability change and so every
      // conditional in this branch reads a consistent value (Fix 3 — avoid triple wsKey() reads).
      const currentWsKey = wsKey();
      builtWsKey = currentWsKey;
      // --- JSON scope toggle (User | Workspace) — mounted into the header, beside the Visual/JSON toggle ---
      // Re-derive scope from persistence on each build: restores a persisted 'workspace' scope when a
      // folder opens mid-session (Fix 3); forces 'user' when no workspace is available.
      scope = currentWsKey === null ? 'user' : loadScope();
      scopeToggle = segmented<JsonScope>(
        'Settings JSON scope',
        [
          { value: 'user', label: 'User' },
          { value: 'workspace', label: 'Workspace' },
        ],
        setScope,
      );
      scopeToggle.set(scope);
      // Reflect "no workspace": disable the Workspace pill (mirrors makeScopeBinding.applyEnabled).
      const wsOpen = currentWsKey !== null;
      scopeToggle.el.setAttribute('aria-disabled', String(!wsOpen));
      scopeToggle.el.classList.toggle('is-disabled', !wsOpen);
      for (const b of scopeToggle.el.querySelectorAll<HTMLButtonElement>('.koi-seg')) b.disabled = !wsOpen;
      // Mount the scope toggle into the header's #settings-scope-toggle slot so User/Workspace sits on the
      // SAME row as the Visual/JSON representation toggle (next to it). Fall back to the header itself when
      // the slot is absent (keeps tests/callers that pass a bare header working). teardownBody() removes it.
      const scopeHost = hosts.header.querySelector('#settings-scope-toggle') ?? hosts.header;
      scopeHost.append(scopeToggle.el);
      if (!wsOpen) {
        // The disabled Workspace pill needs an explanation, but the header has no room for a sentence, so the
        // note renders as a quiet hint above the editor in the body. A stable id keeps the cross-DOM
        // aria-describedby link (header toggle → body note) so a screen-reader user still hears why the group
        // is disabled (aria-describedby resolves by id regardless of DOM position). Removed by replaceChildren.
        const noteId = 'settings-json-scope-note';
        const note = el('p', { class: 'settings-json-scope-empty', text: 'Open a folder to edit workspace settings' });
        note.id = noteId;
        scopeToggle.el.setAttribute('aria-describedby', noteId);
        hosts.body.append(note);
      }

      // Seed from the scope-appropriate document (user: full settings.json; workspace: flat overrides),
      // and wire the matching inline JSON schema so the linter/completions reflect the document's shape.
      editor = createJsonSettingsEditor(hosts.body, {
        onChange: (text) => scheduleApply(text),
        initial: seedForScope(),
        schema: schemaForScope(),
      });
      // The diagnostics strip lives below the editor; role=alert so a fresh error is announced. The id lets
      // the editor content's aria-errormessage point at it while the document is invalid (setInvalid).
      diagnostics = el('div', {
        class: 'settings-json-diagnostics',
        attrs: { id: DIAGNOSTICS_ID, role: 'alert', hidden: true },
      });
      hosts.body.append(diagnostics);
    }
    startMcpOnShow(); // (re)start the sidecar on show, for whichever representation just mounted
  }

  function teardownBody(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // The scope toggle lives in the HEADER (not the body), so replaceChildren() below won't reach it —
    // remove its node explicitly. The empty-state note (when present) is in the body and goes with the
    // replaceChildren() sweep.
    if (scopeToggle) {
      scopeToggle.el.remove();
      scopeToggle = null;
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
      // If workspace availability changed since the body was built (e.g. a folder was opened or closed
      // while the page sat hidden), fully rebuild the body so the scope toggle's enabled/empty-state
      // AND the seeded document both reflect the current wsKey(). buildBody calls startMcpOnShow.
      if (wsKey() !== builtWsKey) {
        // Clear a visible stale diagnostics strip before teardown so the role=alert node is emptied
        // before its parent is removed — avoids a momentary stale error announcement (Fix 5).
        clearDiagnostics();
        teardownBody();
        buildBody();
        return; // buildBody already called startMcpOnShow — skip the outer call
      }
      // Lightweight re-seed: only when the scope-appropriate document actually differs, so a re-open
      // doesn't clobber an in-flight valid edit. Either way, clear any stale diagnostics.
      const fresh = seedForScope();
      if (editor.getText() !== fresh) {
        editor.setContent(fresh);
        // A programmatic re-seed is not a user edit — cancel the debounce onChange just scheduled.
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
