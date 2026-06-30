// Settings form for Koine Studio: the two-pane preference center the gear-launched Settings page embeds
// (the legacy modal was retired, #731). Laid out as a vertical category rail (Appearance / Editor /
// Assistant / Advanced) on the left, the active category's controls on the right. The set of persisted
// Settings is the
// source of truth (./persistence); each control writes a single-field patch through patchSettings() and
// reports the merged Settings back via onChange. The app's onChange handler is the single place that
// re-skins the studio (applyAppearance + editor soft-wrap), so flipping a control applies live there;
// only Theme is applied here directly, through ./theme's setTheme (its own live-apply + listeners).
import {
  loadSettings,
  patchSettings,
  saveSettings,
  saveApiKey,
  clearApiKey,
  whenSecretsReady,
  loadWorkspaceOverrides,
  saveWorkspaceOverride,
  effectiveSettings,
  resolveKeybindings,
  loadKeybindingOverrides,
  saveKeybindingOverride,
  clearKeybindingOverrides,
  DEFAULT_SETTINGS,
  type Settings,
  type AccentName,
  type PreviewTarget,
} from '@/settings/persistence';
import { DIAGRAM_ZOOM_MIN, DIAGRAM_ZOOM_MAX } from '@/diagrams/diagramContract';
import { setTheme } from '@/settings/theme';
import { ACCENTS, ACCENT_ORDER } from '@/settings/appearance';
import { createAboutPanel } from '@/settings/about';
import { createJsonView } from '@/editor/editor';
import { mcpJsonSnippet, MCP_CLIENTS, probeMcp } from '@/mcp/mcp';
import { EMIT_TARGETS } from '@/shared/emitTargets';
import { KEYBINDINGS, DEFAULT_BINDINGS, type BindingId } from '@/editor/keybindings';
import { chordFromEvent, prettyChord } from '@/shared/platform';

export interface PrefsCallbacks {
  /** Fired after every committed change with the merged, persisted Settings. */
  onChange(s: Settings): void;

  /**
   * Resolve the local MCP HTTP endpoint URL to surface in the Assistant settings (so the user can
   * paste it into LM Studio), or null when the host can't serve one — the web build, where the row
   * stays hidden. Optional: a caller that doesn't wire it simply never shows the row.
   */
  mcpEndpoint?(): Promise<string | null>;

  /**
   * Stop the local MCP sidecar when the user disables it. Optional: a host that never starts one
   * (browser) can omit it. Pairs with {@link mcpEndpoint}, which (re)starts it.
   */
  mcpStop?(): Promise<void>;

  /**
   * Whether this host can actually run the MCP sidecar — the desktop shell can, a browser tab cannot.
   * Defaults to true when omitted; the web build passes false so the toggle is shown disabled and the
   * endpoint/test rows stay hidden (the copy-paste recipes still render, pointing at the CLI).
   */
  mcpHostable?: boolean;

  /**
   * Whether this host can save projects to a workspace root directory. True in the browser when the
   * File System Access API is present; false on the Tauri desktop. When false, the workspace root row
   * is hidden from Settings.
   */
  canSaveProjects?: boolean;

  /** Return the remembered workspace root's display name (for Settings), or null if not yet set. */
  workspaceRootName?(): Promise<string | null>;

  /** Re-pick the workspace root directory; returns its name, or null if dismissed. */
  pickWorkspaceRoot?(): Promise<string | null>;

  /**
   * The stable storage key of the currently-open workspace, or null when no workspace is open
   * (or the host can't scope settings per project). Drives the per-row User/Workspace scope toggle:
   * a non-null key lets the four scoped fields (previewTarget, formatOnSave, wordWrap, lspTrace) be
   * overridden for this project; null disables the scope control and forces user-level behavior.
   */
  workspaceKey?(): string | null;

  /** Live-apply a keybinding change: reconfigure the editor keymap. */
  onKeybindingsChanged?(): void;
}

const FONT_MIN = 10;
const FONT_MAX = 22;
const FONT_STEP = 0.5;

const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;
const LINE_HEIGHT_STEP = 0.1;

// Indent width + assistant temperature bounds (#750); mirror the load-time clamps in persistence.ts.
const TAB_MIN = 1;
const TAB_MAX = 8;

// Default domain-canvas zoom control step (#762). The min/max mirror the diagram zoom band exported by
// persistence (DIAGRAM_ZOOM_MIN/MAX = 10/800), so the control and the load-time clamp agree.
const CANVAS_ZOOM_STEP = 10;

const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TEMP_STEP = 0.1;

// Category rail icons, drawn in the studio's 16×16 line-icon idiom (stroke = currentColor).
const ICON = {
  appearance:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/></svg>',
  editor:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4 2.4 8 6 12"/><path d="M10 4l3.6 4-3.6 4"/></svg>',
  keyboard:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.6" y="4" width="12.8" height="8" rx="1.4"/><path d="M4 6.4h.01M6.4 6.4h.01M8.8 6.4h.01M11.2 6.4h.01M4.8 9.6h6.4"/></svg>',
  assistant:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.5 3.9 3.9 1.5-3.9 1.5L8 13l-1.5-3.9L2.6 7.6l3.9-1.5z"/></svg>',
  mcp:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.6v4.2M10 2.6v4.2M4.4 6.8h7.2v1.4a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6z"/><path d="M8 12v1.8"/></svg>',
  advanced:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/><circle cx="6" cy="4.6" r="1.7" fill="var(--koi-paper-2)"/><circle cx="10.4" cy="8" r="1.7" fill="var(--koi-paper-2)"/><circle cx="5" cy="11.4" r="1.7" fill="var(--koi-paper-2)"/></svg>',
  output:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 2.6c-1.2 0-1.7.6-1.7 1.8v1.6c0 .9-.3 1.3-1.1 1.4v1.2c.8.1 1.1.5 1.1 1.4v1.6c0 1.2.5 1.8 1.7 1.8M9.6 2.6c1.2 0 1.7.6 1.7 1.8v1.6c0 .9.3 1.3 1.1 1.4v1.2c-.8.1-1.1.5-1.1 1.4v1.6c0 1.2-.5 1.8-1.7 1.8"/></svg>',
  about:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.4"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none"/></svg>',
} as const;

// chordFromEvent (keydown → CodeMirror key) and prettyChord (CodeMirror key → display string) live in
// shared/platform.ts beside formatChord — they're platform-string helpers, not Settings-dialog logic.

/** A mounted preferences pane. The public contract is just teardown; the embedded Settings page drives the
 *  richer {@link MountedPrefsPane} returned by {@link mountPreferencesPane}. */
export interface PrefsPaneHandle {
  /** Remove the form from its container, destroy its child editors (the MCP CodeMirror view), and drop
   *  any transient recorder listener / pending timers. After this the pane is dead — re-mount to reuse. */
  destroy(): void;
}

/** The richer handle the embedded Settings page drives: repaint on (re)open ({@link refresh}) and cancel
 *  transient recorder/conflict state ({@link suspend}). Callers that only need teardown see the narrower
 *  {@link PrefsPaneHandle}. */
interface MountedPrefsPane extends PrefsPaneHandle {
  /** Repaint every control from the current Settings; optionally land on a category id first. `focusTab`
   *  (default true) focuses the active category tab; the embedded center page passes false so re-showing it
   *  never steals focus from the page. Repaint only: the MCP sidecar (re)start is the separate on-show
   *  {@link startMcpSidecar} call (issue #735). */
  refresh(categoryId?: string, focusTab?: boolean): void;
  /** The Settings "on show" hook: (re)start the desktop MCP sidecar when enabled and reflect it in this
   *  pane's MCP panel. The center page calls it on show / (re)show; a bare mount never does, so the opt-in
   *  server is never spawned before Settings is actually presented. */
  startMcpSidecar(): void;
  /** Cancel any armed keybinding recorder + open conflict prompt — the disarm {@link destroy} also runs,
   *  exposed for a caller that wants to pause transient state without tearing the pane down. */
  suspend(): void;
}

/**
 * (Re)start the desktop MCP sidecar when the user has opted in on a host that can run it — the
 * representation-independent, DOM-free half of the Settings "on show" path (issue #735). The Settings
 * center page calls this on show for BOTH the Visual and JSON representations; the JSON one mounts no
 * preferences pane, so it can't rely on the pane's open path. The Visual pane and the modal route their
 * start through the pane's {@link MountedPrefsPane.startMcpSidecar}, which layers the MCP-panel UI on top
 * of this same launch.
 *
 * It only asks the host to (lazily) (re)spawn `koine mcp --http` and resolves the endpoint it announces
 * (or `''` when it can't be brought up). The browser host passes `mcpHostable: false` and never spawns; a
 * disabled `mcpEnabled` is a no-op. `mcpEndpoint` is idempotent (it reuses a running sidecar), so a
 * redundant call — e.g. on a representation flip — reflects the live endpoint without a second process.
 */
export async function startMcpSidecarIfEnabled(cb: PrefsCallbacks, s: Settings = loadSettings()): Promise<string> {
  if (!(s.mcpEnabled && cb.mcpHostable !== false)) return '';
  try {
    return (await cb.mcpEndpoint?.()) ?? '';
  } catch {
    return '';
  }
}

// Import for use in this module; re-export so callers importing from here (e.g. prefs.test.ts)
// keep working without an import-path change. Canonical definition: @/shared/wrapIndex (#745).
export { wrapIndex } from '@/shared/wrapIndex';
import { wrapIndex } from '@/shared/wrapIndex';

/**
 * A segmented radio group (e.g. Dark / Light): a row of role=radio buttons under a role=radiogroup, with
 * exactly one option checked at a time. Keyboard-navigable per the WAI-ARIA radiogroup pattern — a roving
 * tabindex (only the checked option is in the tab order) plus Arrow/Home/End navigation where focus
 * follows selection (single-select semantics, matching a click). Arrow nav skips disabled options, so a
 * scope toggle whose every option is disabled (no workspace open) stays inert. `set(value)` drives both
 * `aria-checked` and the roving tabindex; the group is seeded with one tabbable option at construction so
 * it is reachable by Tab even before the first `set()`.
 *
 * Module-level + exported (it was a closure inside {@link mountPreferencesPane}) so it can be the single
 * shared control behind every Studio segmented: the Theme toggle and the four User/Workspace scope
 * toggles here, and the Settings page's Visual/JSON representation toggle (settingsPage.tsx).
 */
export function segmented<T extends string>(
  ariaLabel: string,
  options: readonly { value: T; label: string }[],
  onSelect: (value: T) => void,
): { el: HTMLElement; set(value: T): void } {
  const group = document.createElement('div');
  group.className = 'koi-segmented';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', ariaLabel);

  const buttons = options.map(({ value, label }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'koi-seg';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.tabIndex = -1;
    b.dataset.value = value;
    b.textContent = label;
    b.addEventListener('click', () => selectButton(b));
    b.addEventListener('keydown', onArrow);
    group.appendChild(b);
    return b;
  });

  // set() drives aria-checked AND the roving tabindex: only the checked option is tabbable (0), every
  // other is taken out of the tab order (-1) so Tab enters the group once and the arrows move within it.
  const set = (value: T): void => {
    for (const b of buttons) {
      const checked = b.dataset.value === value;
      b.setAttribute('aria-checked', String(checked));
      b.tabIndex = checked ? 0 : -1;
    }
  };

  // Move selection (and focus) to `target` and commit it — the shared path for both a click and an arrow
  // key, so focus-follows-selection holds for the keyboard exactly as it already did for the pointer.
  function selectButton(target: HTMLButtonElement): void {
    const value = target.dataset.value as T;
    set(value);
    onSelect(value);
    target.focus();
  }

  // Arrow / Home / End navigation across the ENABLED options (a no-workspace scope toggle has none, so
  // this is a no-op there). Right/Down → next, Left/Up → previous (both wrap), Home → first, End → last.
  function onArrow(e: KeyboardEvent): void {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return; // the focused option isn't navigable (e.g. all disabled) — leave the group be
    let next: HTMLButtonElement;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[wrapIndex(i, +1, enabled.length)]; // shared wrap helper
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[wrapIndex(i, -1, enabled.length)]; // shared wrap helper
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    else return;
    e.preventDefault();
    selectButton(next);
  }

  // Seed one tabbable option so the group is keyboard-reachable before the first set() (callers set the
  // real selection during populate); the first option carries the roving tabindex until then.
  if (buttons.length > 0) buttons[0].tabIndex = 0;

  return { el: group, set };
}

/**
 * Build the two-pane preference form (category rail + control pane) and append it into `container` — no
 * modal chrome. The DOM is created once and populated from the current Settings on mount; each control
 * commits a single-field patch through patchSettings() and reports the merged Settings back via cb.onChange.
 * Returns a handle to repaint/tear-down the pane. The gear-launched Settings center page
 * ({@link import('@/settings/settingsPage').createSettingsPage}) mounts this pane inside its Visual tab.
 */
export function mountPreferencesPane(container: HTMLElement, cb: PrefsCallbacks): MountedPrefsPane {
  // Every control commits a single-field patch, then reports the merged Settings to the app.
  function commit(patch: Partial<Settings>): void {
    cb.onChange(patchSettings(patch));
  }

  // --- control factories ----------------------------------------------------

  // A labelled settings row: a title (+ optional description) on the left, the control on the right.
  // `content` is what fills the control cell (usually `control` itself, but a scoped row passes a
  // wrapper holding the value control + its User/Workspace toggle); `control` is the labelable target
  // the <label for> binds to (defaults to `content`).
  function row(title: string, description: string, content: HTMLElement, control: HTMLElement = content): HTMLElement {
    const r = document.createElement('div');
    r.className = 'koi-set-row';
    const text = document.createElement('div');
    text.className = 'koi-set-text';
    // Associate the label with a labelable form control (input/select/textarea): give it a stable id
    // derived from the title and emit a real <label for>, so the field has an accessible name + id
    // (fixes the "form field should have an id/name" + "no label associated" DevTools notices). Non-form
    // controls (the role=switch toggle, segmented groups, accent swatches) carry their own aria-label,
    // so they keep a plain <span>.
    const labelable =
      control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement;
    const label = document.createElement(labelable ? 'label' : 'span');
    label.className = 'koi-set-label';
    label.textContent = title;
    if (labelable) {
      if (!control.id) control.id = `koi-set-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
      if (!control.getAttribute('name')) control.setAttribute('name', control.id);
      (label as HTMLLabelElement).htmlFor = control.id;
    }
    text.appendChild(label);
    if (description) {
      const desc = document.createElement('span');
      desc.className = 'koi-set-desc';
      desc.textContent = description;
      text.appendChild(desc);
    }
    const ctrl = document.createElement('div');
    ctrl.className = 'koi-set-control';
    ctrl.appendChild(content);
    r.append(text, ctrl);
    return r;
  }

  // A panel groups rows under a category.
  function panel(id: string, ...rows: HTMLElement[]): HTMLElement {
    const p = document.createElement('section');
    p.className = 'koi-settings-panel';
    p.id = `koi-settings-panel-${id}`;
    p.setAttribute('role', 'tabpanel');
    p.append(...rows);
    return p;
  }

  // An iOS-style on/off switch backed by role=switch (toggles on click; label via aria-label).
  function toggle(
    ariaLabel: string,
    onChange: (on: boolean) => void,
  ): { el: HTMLButtonElement; set(on: boolean): void; setDisabled(disabled: boolean): void } {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'koi-switch';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', ariaLabel);
    btn.setAttribute('aria-checked', 'false');
    const thumb = document.createElement('span');
    thumb.className = 'koi-switch-thumb';
    btn.appendChild(thumb);
    const set = (on: boolean) => btn.setAttribute('aria-checked', String(on));
    // Grey out + block interaction (e.g. a mutually-exclusive sibling is on). The native `disabled`
    // attribute is what actually blocks the click (a disabled <button> dispatches no click event, so
    // onChange can't fire); aria-disabled is set alongside it as an explicit, redundant signal.
    const setDisabled = (disabled: boolean) => {
      btn.disabled = disabled;
      btn.setAttribute('aria-disabled', String(disabled));
    };
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-checked') !== 'true';
      set(next);
      onChange(next);
    });
    return { el: btn, set, setDisabled };
  }

  // The segmented radio group (Theme, the User/Workspace scope toggles) is the shared, keyboard-navigable
  // `segmented()` helper hoisted to module scope (below), so settingsPage.tsx can reuse it too.

  // --- per-workspace scope control ------------------------------------------
  // The four scoped fields (previewTarget, formatOnSave, wordWrap, lspTrace) can be overridden per
  // workspace. Each scoped row pairs its VALUE control with a User/Workspace `segmented` toggle that
  // routes commits either to the global settings blob (User) or the workspace override store
  // (Workspace). When no workspace is open the toggle is disabled and behavior is forced to User.

  type Scope = 'user' | 'workspace';

  // One scoped row's wiring, registered so populate() can re-sync its scope + value on every open.
  interface ScopedControl {
    /** Re-read the override store for the current workspace and reflect scope + effective value. */
    sync(s: Settings): void;
  }
  const scopedControls: ScopedControl[] = [];

  // The current workspace key, or null when none is open / the host doesn't scope settings.
  const wsKey = (): string | null => cb.workspaceKey?.() ?? null;

  /**
   * The shared scope-binding for one workspace-scopable field. Builds the User/Workspace segmented
   * toggle, owns this row's scope state, exposes the `scopedCommit` the value control calls on edit,
   * and registers itself so populate() re-syncs scope + effective value on every open. The value
   * control is supplied via `setValue` (so the binding can reset it on a Workspace→User flip) and
   * `title` names the segmented accessibly ("<title> scope").
   *
   * - User scope (or no workspace): value edits go through patchSettings (the global path).
   * - Workspace scope: value edits go through saveWorkspaceOverride; the host is notified with the
   *   UNCHANGED user settings so the global value is never touched (it re-applies effective behavior).
   */
  function makeScopeBinding<K extends 'previewTarget' | 'formatOnSave' | 'wordWrap' | 'lspTrace'>(
    field: K,
    title: string,
    setValue: (value: Settings[K]) => void,
  ): { seg: HTMLElement; scopedCommit(value: Settings[K]): void } {
    let scope: Scope = 'user';

    function scopedCommit(value: Settings[K]): void {
      const key = wsKey();
      if (scope === 'workspace' && key) {
        saveWorkspaceOverride(key, field, value);
        cb.onChange(loadSettings());
      } else {
        cb.onChange(patchSettings({ [field]: value } as Partial<Settings>));
      }
    }

    const scopeSeg = segmented<Scope>(
      `${title} scope`,
      [
        { value: 'user', label: 'User' },
        { value: 'workspace', label: 'Workspace' },
      ],
      (next) => {
        const key = wsKey();
        if (!key) return; // disabled — nothing to do without a workspace
        if (next === scope) return;
        scope = next;
        if (next === 'workspace') {
          // Make "Workspace" meaningful at once: persist the row's CURRENT value as the override.
          saveWorkspaceOverride(key, field, loadSettings()[field]);
        } else {
          // Back to User: clear the override and reset the value control to the user value.
          saveWorkspaceOverride(key, field, null);
          setValue(loadSettings()[field]);
        }
        cb.onChange(loadSettings());
      },
    );

    // Reflect "no workspace" unambiguously: disable the toggle's buttons and mark the group, so the
    // control keeps its place in the layout while clearly inert (and the state stays testable).
    function applyEnabled(): void {
      const enabled = wsKey() !== null;
      scopeSeg.el.setAttribute('aria-disabled', String(!enabled));
      scopeSeg.el.classList.toggle('is-disabled', !enabled);
      for (const b of scopeSeg.el.querySelectorAll<HTMLButtonElement>('.koi-seg')) b.disabled = !enabled;
    }

    scopedControls.push({
      sync(s: Settings): void {
        const key = wsKey();
        const ov = key ? loadWorkspaceOverrides(key) : {};
        scope = key && field in ov ? 'workspace' : 'user';
        scopeSeg.set(scope);
        // Show the effective value: a Workspace row shows its override, a User row the user value.
        setValue(effectiveSettings(s, key)[field]);
        applyEnabled();
      },
    });

    return { seg: scopeSeg.el, scopedCommit };
  }

  /**
   * Build a labelled scoped ROW (label/description on the left; value control + User/Workspace toggle
   * on the right). `makeControl` receives the row's `scopedCommit` to call on every value edit.
   */
  function scopedRow<K extends 'previewTarget' | 'formatOnSave' | 'wordWrap' | 'lspTrace'>(
    field: K,
    title: string,
    description: string,
    makeControl: (scopedCommit: (value: Settings[K]) => void) => {
      el: HTMLElement;
      set(value: Settings[K]): void;
    },
  ): HTMLElement {
    // Late-bound so the binding's Workspace→User reset can drive the value control built just below.
    let control: { el: HTMLElement; set(value: Settings[K]): void };
    const binding = makeScopeBinding(field, title, (v) => control.set(v));
    control = makeControl(binding.scopedCommit);

    const wrap = document.createElement('div');
    wrap.className = 'koi-set-scoped';
    wrap.append(control.el, binding.seg);
    return row(title, description, wrap, control.el);
  }

  // The accent swatch picker: one coloured dot per preset, single-selection radio group.
  function accentPicker(onSelect: (value: AccentName) => void): { el: HTMLElement; set(value: AccentName): void } {
    const group = document.createElement('div');
    group.className = 'koi-accent-row';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Accent colour');
    const buttons = ACCENT_ORDER.map((name) => {
      const preset = ACCENTS[name];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'koi-accent-swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', preset.label);
      b.title = preset.label;
      b.dataset.value = name;
      b.style.setProperty('--koi-swatch', preset.swatch);
      const dot = document.createElement('span');
      dot.className = 'koi-accent-dot';
      b.appendChild(dot);
      b.addEventListener('click', () => {
        set(name);
        onSelect(name);
      });
      group.appendChild(b);
      return b;
    });
    const set = (value: AccentName) => {
      for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
    };
    return { el: group, set };
  }

  // The output-language picker: a card per target (identity dot + name + the file extension it
   // emits), laid out as a single-selection radio group.
  function langPicker(
    onSelect: (value: PreviewTarget) => void,
  ): { el: HTMLElement; set(value: PreviewTarget): void; refresh(): void } {
    const group = document.createElement('div');
    group.className = 'koi-lang-picker';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Output language');
    // A card per target (identity dot + display name + emitted extension). The picker DOM is built
    // once at construction (during init(), before the backend seed resolves), so `refresh()` REBUILDS
    // the cards from the LIVE EMIT_TARGETS — called from the settings-panel open path (issue #282) so
    // a backend-seeded target appears here without a front-end edit, even though construction predates
    // the seed. `set` only toggles the selection, so it must read the current buttons each call.
    function refresh(): void {
      group.replaceChildren();
      for (const t of EMIT_TARGETS) {
        const id = t.id;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'koi-lang-opt';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.dataset.value = id;
        const dot = document.createElement('span');
        dot.className = 'lang-dot';
        dot.dataset.lang = id;
        dot.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'koi-lang-name';
        label.textContent = t.displayName;
        const ext = document.createElement('span');
        ext.className = 'koi-lang-ext';
        ext.textContent = t.fileExtension;
        b.append(dot, label, ext);
        b.addEventListener('click', () => {
          set(id);
          onSelect(id);
        });
        group.appendChild(b);
      }
    }
    const set = (value: PreviewTarget) => {
      for (const b of group.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.value === value));
    };
    refresh();
    return { el: group, set, refresh };
  }

  // A clamped numeric setting input. On commit it parses, restores the prior value for empty/blank
  // or non-numeric input (Number('') is 0, so the blank case must be caught explicitly), clamps into
  // [min, max], then writes the single field. The committed change re-applies appearance via onChange.
  function metricInput(
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (value: number) => void,
  ): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'koi-number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('change', () => {
      const text = input.value.trim();
      const raw = Number(text);
      if (text === '' || !Number.isFinite(raw)) {
        input.value = String(read()); // restore the last good value
        return;
      }
      const clamped = Math.min(Math.max(raw, min), max);
      input.value = String(clamped);
      write(clamped);
    });
    return input;
  }

  function select<T extends string>(options: readonly { value: T; label: string }[]): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'koi-select';
    for (const { value, label } of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    return sel;
  }

  // --- Appearance -----------------------------------------------------------

  const themeSeg = segmented<Settings['theme']>(
    'Theme',
    [
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
    (theme) => {
      setTheme(theme); // persists + applies live + notifies theme listeners
      cb.onChange(loadSettings());
    },
  );

  // Appearance fields just commit; the live re-skin happens in onChange via applyAppearance (the one
  // place that defines how a Settings object maps to the DOM), so there is a single apply path.
  const accent = accentPicker((name) => commit({ accent: name }));
  const reduceMotion = toggle('Reduce motion', (on) => commit({ reduceMotion: on }));

  // The name attributed to review comments authored from Studio (#479). Committed trimmed; a blank value
  // is stored as-is and resolves to the 'You' fallback at comment-creation time (resolveReviewAuthor).
  const displayNameInput = document.createElement('input');
  displayNameInput.type = 'text';
  displayNameInput.className = 'koi-text';
  displayNameInput.spellcheck = false;
  displayNameInput.autocomplete = 'off';
  displayNameInput.placeholder = 'You';
  displayNameInput.addEventListener('change', () => {
    commit({ displayName: displayNameInput.value.trim() });
  });

  // Editor font-stack override (#750). A blank value falls back to the theme's default mono font, applied
  // live via applyAppearance (onChange) like the other appearance fields. Committed trimmed.
  const fontFamilyInput = document.createElement('input');
  fontFamilyInput.type = 'text';
  fontFamilyInput.className = 'koi-text';
  fontFamilyInput.spellcheck = false;
  fontFamilyInput.autocomplete = 'off';
  fontFamilyInput.placeholder = 'Theme default (monospace)';
  fontFamilyInput.addEventListener('change', () => {
    commit({ fontFamily: fontFamilyInput.value.trim() });
  });

  const appearancePanel = panel(
    'appearance',
    row('Theme', 'Light or dark surfaces across the whole studio.', themeSeg.el),
    row('Accent', 'The highlight colour for selections, focus, and actions.', accent.el),
    row('Reduce motion', 'Collapse animations and transitions.', reduceMotion.el),
    row('Editor font', 'A CSS font-family for the editor. Blank uses the theme’s default monospace font.', fontFamilyInput),
    row(
      'Display name',
      'The name your review comments are attributed to. Leave blank to show as “You”.',
      displayNameInput,
    ),
  );

  // --- Editor ---------------------------------------------------------------

  const fontInput = metricInput(
    FONT_MIN,
    FONT_MAX,
    FONT_STEP,
    () => loadSettings().fontSize,
    (v) => commit({ fontSize: v }),
  );

  const lineHeightInput = metricInput(
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_STEP,
    () => loadSettings().lineHeight,
    (v) => commit({ lineHeight: v }),
  );

  // Indent width in spaces (#750), clamped 1..8; the editor re-applies it live via setTabSize (onChange).
  const tabSizeInput = metricInput(
    TAB_MIN,
    TAB_MAX,
    1,
    () => loadSettings().tabSize,
    (v) => commit({ tabSize: v }),
  );

  // Default domain-canvas zoom (#762): the zoom a freshly-opened diagram canvas uses when nothing
  // per-diagram is saved. Clamped to the diagram zoom band (10–800); applied to the NEXT opened canvas
  // via setDefaultCanvasZoom in ide.tsx's onChange (a live canvas keeps its current zoom until re-rendered).
  const defaultCanvasZoomInput = metricInput(
    DIAGRAM_ZOOM_MIN,
    DIAGRAM_ZOOM_MAX,
    CANVAS_ZOOM_STEP,
    () => loadSettings().defaultCanvasZoom,
    (v) => commit({ defaultCanvasZoom: v }),
  );

  // A live type specimen: a short Koine snippet that renders at the current font size, line height,
  // and word-wrap so the numeric inputs above have something tangible to read against. It updates on
  // every keystroke — visual only; the real editor re-skins through onChange like every other field.
  const specimenCode = document.createElement('pre');
  specimenCode.className = 'koi-editor-specimen-code';
  specimenCode.setAttribute('aria-hidden', 'true');
  specimenCode.innerHTML =
    '<span class="tk-c">// A value object is immutable and compared by its fields</span>\n' +
    '<span class="tk-k">value</span> <span class="tk-t">Money</span> {\n' +
    '  amount: <span class="tk-t">Decimal</span>\n' +
    '  currency: <span class="tk-t">Currency</span>\n' +
    '}';

  const specimenLabel = document.createElement('span');
  specimenLabel.className = 'koi-editor-specimen-label';
  specimenLabel.textContent = 'Preview';

  const specimen = document.createElement('figure');
  specimen.className = 'koi-editor-specimen';
  specimen.append(specimenLabel, specimenCode);

  // Read a metric input's current value, clamped into range, falling back to the persisted setting
  // for an empty or non-numeric field so a mid-edit blank never blanks the preview.
  function specimenMetric(input: HTMLInputElement, min: number, max: number, fallback: number): number {
    const raw = Number(input.value.trim());
    if (input.value.trim() === '' || !Number.isFinite(raw)) return fallback;
    return Math.min(Math.max(raw, min), max);
  }
  function refreshSpecimen(): void {
    const s = loadSettings();
    specimenCode.style.fontSize = `${specimenMetric(fontInput, FONT_MIN, FONT_MAX, s.fontSize)}px`;
    specimenCode.style.lineHeight = String(
      specimenMetric(lineHeightInput, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, s.lineHeight),
    );
  }
  fontInput.addEventListener('input', refreshSpecimen);
  lineHeightInput.addEventListener('input', refreshSpecimen);

  // Word wrap + Format on save are workspace-scopable: each pairs its toggle with a User/Workspace
  // scope control (scopedRow). The toggle is built inside makeControl so its onChange routes through
  // the row's scopedCommit (User → global blob; Workspace → the override store).
  const wordWrapRow = scopedRow('wordWrap', 'Word wrap', 'Wrap long lines instead of scrolling sideways.', (scopedCommit) => {
    const t = toggle('Word wrap', (on) => {
      scopedCommit(on);
      specimenCode.classList.toggle('is-wrapped', on); // the preview wraps / scrolls just like the editor
    });
    // Mirror the specimen whenever populate() (or a scope flip) re-sets the toggle value.
    return {
      el: t.el,
      set: (on) => {
        t.set(on);
        specimenCode.classList.toggle('is-wrapped', on);
      },
    };
  });
  const formatOnSaveRow = scopedRow(
    'formatOnSave',
    'Format on save',
    'Run the Koine formatter when you press save.',
    (scopedCommit) => toggle('Format on save', (on) => scopedCommit(on)),
  );
  const autoSave = toggle('Auto-save', (on) => commit({ autoSave: on }));
  const minimap = toggle('Minimap', (on) => commit({ enableMinimap: on }));

  const editorPanel = panel(
    'editor',
    specimen,
    row('Font size', 'Editor text size, in pixels.', fontInput),
    row('Line height', 'Vertical spacing between lines.', lineHeightInput),
    row('Tab size', 'Number of spaces per indent level (1–8).', tabSizeInput),
    wordWrapRow,
    formatOnSaveRow,
    row('Auto-save', 'Save edits automatically after a short pause in typing.', autoSave.el),
    row('Minimap', 'Show a document overview rail on the editor’s right edge.', minimap.el),
    row(
      'Default canvas zoom',
      'Initial zoom (%) for a freshly-opened domain diagram canvas (10–800).',
      defaultCanvasZoomInput,
    ),
  );

  // --- Keyboard -------------------------------------------------------------
  // One row per rebindable editor command (KEYBINDINGS). Each row records a new combo (a document-level
  // capture-phase keydown listener while armed), resets to its default, or — on a clash with another
  // command's chord — surfaces a confirmable conflict. Every committed change persists through the
  // Task-2 override store and live-applies via cb.onKeybindingsChanged.

  // Editor shortcuts OUTSIDE the rebindable registry that a remap would silently shadow: the registry
  // keymap compartment is registered at higher precedence than the editor's own Mod-Alt-h (call
  // hierarchy) and the loaded CodeMirror keymaps (search → Mod-f / Mod-d, default → Mod-a). We can't
  // unbind these, but we warn before letting a remap mask one. Verified against editor.ts's loaded
  // keymaps (note: historyKeymap is NOT loaded, so Mod-z is free); not exhaustive — built-in coverage
  // can grow as more commands enter scope.
  const RESERVED_CHORDS: Record<string, string> = {
    'Mod-Alt-h': 'Call hierarchy',
    'Mod-f': 'Find',
    'Mod-d': 'Select next occurrence',
    'Mod-a': 'Select all',
  };

  interface KbdRowState {
    chord: HTMLElement;
    recordBtn: HTMLButtonElement;
    resetBtn: HTMLButtonElement;
    conflict: HTMLElement;
    reassignBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
    /** A recorded chord awaiting conflict confirmation: the clashing label and the rebindable command
     *  that currently owns it — null when it clashes with a reserved/built-in shortcut we can't unbind
     *  (confirming then just applies the remap, shadowing the built-in). */
    pending: { chord: string; otherId: BindingId | null; label: string } | null;
  }
  const kbdRows = new Map<BindingId, KbdRowState>();

  // Recording is global (only one row arms at a time): the armed id + its document listener.
  let kbdArmed: BindingId | null = null;
  let kbdKeyListener: ((e: KeyboardEvent) => void) | null = null;

  const kbdLabel = (id: BindingId): string => KEYBINDINGS.find((b) => b.id === id)?.label ?? id;

  // Re-read the resolved map and repaint one row: chord display + the per-row Reset's enabled state
  // (Reset only means something when this command actually carries an override).
  function repaintKbdRow(id: BindingId): void {
    const row = kbdRows.get(id);
    if (!row) return;
    row.chord.textContent = prettyChord(resolveKeybindings()[id]);
    row.resetBtn.disabled = !(id in loadKeybindingOverrides());
  }
  function repaintKeyboard(): void {
    for (const id of kbdRows.keys()) repaintKbdRow(id);
  }

  function hideKbdConflict(id: BindingId): void {
    const row = kbdRows.get(id);
    if (!row) return;
    row.pending = null;
    row.conflict.hidden = true;
    row.conflict.textContent = '';
    row.reassignBtn.hidden = true;
    row.cancelBtn.hidden = true;
  }

  function showKbdConflict(id: BindingId, chord: string, label: string, otherId: BindingId | null): void {
    const row = kbdRows.get(id);
    if (!row) return;
    row.pending = { chord, otherId, label };
    // Unhide BEFORE writing the text: role="alert" only announces a content change made while the node
    // is already rendered, so setting textContent while [hidden] then revealing it would stay silent.
    row.conflict.hidden = false;
    row.conflict.textContent = `Already bound to “${label}”. Reassign?`;
    row.reassignBtn.hidden = false;
    row.cancelBtn.hidden = false;
    row.reassignBtn.focus(); // move focus to the confirm so keyboard / screen-reader users can act on it
  }

  function disarmRecording(): void {
    if (kbdKeyListener) {
      document.removeEventListener('keydown', kbdKeyListener, true);
      kbdKeyListener = null;
    }
    if (kbdArmed !== null) {
      const row = kbdRows.get(kbdArmed);
      if (row) {
        row.recordBtn.textContent = 'Record';
        row.recordBtn.classList.remove('is-recording');
      }
      kbdArmed = null;
    }
  }

  // Commit a freshly recorded chord, or defer to a conflict prompt when it clashes with another
  // rebindable command or a reserved/built-in shortcut.
  function applyRecordedChord(id: BindingId, chord: string): void {
    // Recording a command's own default drops any override instead of persisting a redundant one — so
    // the store stays clean and the per-row Reset's enabled state stays honest.
    if (chord === DEFAULT_BINDINGS[id]) {
      saveKeybindingOverride(id, null);
      repaintKbdRow(id);
      cb.onKeybindingsChanged?.();
      return;
    }
    const resolved = resolveKeybindings();
    const otherId = (Object.keys(resolved) as BindingId[]).find(
      (k) => k !== id && resolved[k] !== '' && resolved[k] === chord,
    );
    if (otherId) {
      showKbdConflict(id, chord, kbdLabel(otherId), otherId); // clashes with another rebindable command
      return; // wait for the user to confirm the reassignment
    }
    const reserved = RESERVED_CHORDS[chord];
    if (reserved) {
      showKbdConflict(id, chord, reserved, null); // would shadow a built-in / call-hierarchy shortcut
      return;
    }
    saveKeybindingOverride(id, chord);
    repaintKbdRow(id);
    cb.onKeybindingsChanged?.();
  }

  function armRecording(id: BindingId): void {
    disarmRecording(); // cancel any other in-flight recording first
    for (const k of kbdRows.keys()) hideKbdConflict(k); // clear THIS and any other row's stale conflict prompt
    kbdArmed = id;
    const row = kbdRows.get(id);
    if (row) {
      row.recordBtn.textContent = 'Press keys…';
      row.recordBtn.classList.add('is-recording');
    }
    kbdKeyListener = (e: KeyboardEvent) => {
      // Capture + swallow so the combo isn't also handled by the app/editor underneath the dialog.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        disarmRecording(); // cancel — no change
        return;
      }
      const chord = chordFromEvent(e);
      if (chord === null) return; // a bare modifier — keep waiting for the real key
      // Reject a modifier-less printable single char: binding it would swallow that character in the
      // editor (preventDefault), making it un-typeable. Named keys (F2/F12/Enter…) and any modifier
      // combo are fine; stay armed so the user can press a valid combo.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) return;
      const armedId = kbdArmed;
      disarmRecording();
      if (armedId !== null) applyRecordedChord(armedId, chord);
    };
    document.addEventListener('keydown', kbdKeyListener, true);
  }

  function buildKbdRow(id: BindingId, label: string): HTMLElement {
    const control = document.createElement('div');
    control.className = 'koi-kbd-control';

    const chord = document.createElement('span');
    chord.className = 'koi-kbd-chord';
    // The current binding lives in this span; tie it to the Record button so a screen reader announces
    // "Record a new shortcut for Format document, ⌘S" instead of a bare, ambiguous "Record".
    chord.id = `koi-kbd-chord-${id}`;

    const recordBtn = document.createElement('button');
    recordBtn.type = 'button';
    recordBtn.className = 'koi-set-action koi-kbd-record';
    recordBtn.textContent = 'Record';
    recordBtn.setAttribute('aria-label', `Record a new shortcut for ${label}`);
    recordBtn.setAttribute('aria-describedby', chord.id);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'koi-kbd-reset';
    resetBtn.textContent = 'Reset';
    resetBtn.setAttribute('aria-label', `Reset the ${label} shortcut to its default`);

    const conflict = document.createElement('span');
    conflict.className = 'koi-kbd-conflict';
    conflict.setAttribute('role', 'alert');
    conflict.hidden = true;

    const reassignBtn = document.createElement('button');
    reassignBtn.type = 'button';
    reassignBtn.className = 'koi-set-action koi-kbd-reassign';
    reassignBtn.textContent = 'Reassign';
    reassignBtn.setAttribute('aria-label', `Reassign this shortcut to ${label}`);
    reassignBtn.hidden = true;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'koi-kbd-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', `Cancel reassigning the ${label} shortcut`);
    cancelBtn.hidden = true;

    control.append(chord, recordBtn, resetBtn, conflict, reassignBtn, cancelBtn);

    const r = row(label, '', control);
    r.classList.add('koi-kbd-row');
    r.dataset.bindingId = id;

    kbdRows.set(id, { chord, recordBtn, resetBtn, conflict, reassignBtn, cancelBtn, pending: null });

    recordBtn.addEventListener('click', () => {
      if (kbdArmed === id) disarmRecording(); // a second click toggles recording off
      else armRecording(id);
    });
    resetBtn.addEventListener('click', () => {
      hideKbdConflict(id);
      saveKeybindingOverride(id, null); // drop the remap so the default wins again
      repaintKbdRow(id);
      cb.onKeybindingsChanged?.();
    });
    reassignBtn.addEventListener('click', () => {
      const row = kbdRows.get(id);
      const p = row?.pending;
      if (!p) return;
      if (p.otherId) saveKeybindingOverride(p.otherId, ''); // a rebindable prior owner becomes unbound
      saveKeybindingOverride(id, p.chord); // this command takes the chord (shadowing a built-in if reserved)
      hideKbdConflict(id);
      repaintKbdRow(id);
      if (p.otherId) repaintKbdRow(p.otherId);
      cb.onKeybindingsChanged?.();
    });
    cancelBtn.addEventListener('click', () => hideKbdConflict(id)); // dismiss — keep the current binding

    return r;
  }

  const keyboardRows = KEYBINDINGS.map((b) => buildKbdRow(b.id, b.label));

  const kbdResetAll = document.createElement('button');
  kbdResetAll.type = 'button';
  kbdResetAll.className = 'koi-set-action koi-kbd-reset-all';
  kbdResetAll.textContent = 'Reset all shortcuts';
  kbdResetAll.addEventListener('click', () => {
    clearKeybindingOverrides();
    for (const id of kbdRows.keys()) hideKbdConflict(id);
    repaintKeyboard();
    cb.onKeybindingsChanged?.();
  });

  const keyboardPanel = panel(
    'keyboard',
    ...keyboardRows,
    row('Reset all', 'Restore the default shortcut for every command.', kbdResetAll),
  );

  // Cancel any armed recording / open conflict and repaint from the current overrides — called on
  // every open (populate) so the panel never reopens mid-recording or showing a stale chord.
  function refreshKeyboard(): void {
    disarmRecording();
    for (const id of kbdRows.keys()) hideKbdConflict(id);
    repaintKeyboard();
  }

  // --- Output ---------------------------------------------------------------

  // previewTarget is workspace-scopable. Route the picker's commit through the shared scope binding
  // (User → global blob; Workspace → the override store) and surface its User/Workspace toggle in the
  // output block's heading row.
  const outputScope = makeScopeBinding('previewTarget', 'Output language', (t) => outputLang.set(t));
  const outputLang = langPicker((target) => outputScope.scopedCommit(target));

  // Output lays the picker out full-width under its own heading (not a narrow label/control row) so
  // the four language cards have room to breathe and the caption can say what actually changes.
  const outputText = document.createElement('div');
  outputText.className = 'koi-set-text';
  const outputLabel = document.createElement('span');
  outputLabel.className = 'koi-set-label';
  outputLabel.textContent = 'Output language';
  const outputDesc = document.createElement('span');
  outputDesc.className = 'koi-set-desc';
  outputDesc.textContent =
    'The language the Generated preview emits. Your .koi source stays the same — switch any time.';
  outputText.append(outputLabel, outputDesc);

  // The heading row carries the caption on the left and the User/Workspace scope toggle on the right.
  const outputHead = document.createElement('div');
  outputHead.className = 'koi-output-head';
  outputHead.append(outputText, outputScope.seg);

  const outputBlock = document.createElement('div');
  outputBlock.className = 'koi-output-block';
  outputBlock.append(outputHead, outputLang.el);

  const outputPanel = panel('output', outputBlock);

  // --- Assistant (AI) -------------------------------------------------------

  const aiProviderSelect = select([
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'openai', label: 'OpenAI-compatible' },
  ] as const);

  const aiBaseUrlInput = document.createElement('input');
  aiBaseUrlInput.type = 'text';
  aiBaseUrlInput.className = 'koi-text';
  aiBaseUrlInput.spellcheck = false;
  aiBaseUrlInput.placeholder = 'https://api.openai.com/v1';
  aiBaseUrlInput.setAttribute('list', 'koi-ai-base-presets');
  const presets = document.createElement('datalist');
  presets.id = 'koi-ai-base-presets';
  for (const url of ['https://api.openai.com/v1', 'http://localhost:11434/v1', 'http://localhost:1234/v1']) {
    const opt = document.createElement('option');
    opt.value = url;
    presets.appendChild(opt);
  }

  const aiKeyInput = document.createElement('input');
  aiKeyInput.type = 'password';
  aiKeyInput.className = 'koi-text';
  aiKeyInput.autocomplete = 'off';
  aiKeyInput.placeholder = 'sk-…  (blank for local Ollama / LM Studio)';

  const aiModelInput = document.createElement('input');
  aiModelInput.type = 'text';
  aiModelInput.className = 'koi-text';
  aiModelInput.spellcheck = false;
  aiModelInput.placeholder = 'claude-opus-4-8';

  // #447: Compiler tools and grammar-constraint are mutually exclusive — a GBNF that only accepts `.koi`
  // can't also emit the tool-call JSON the agentic loop needs, so with both on the grammar would
  // silently disable the tools. Enabling one CLEARS the other (grammar is the default winner); the
  // losing toggle is greyed by syncAiExclusivity() so the broken pairing can never be set.
  const aiAgenticTools = toggle('Compiler tools', (on) => {
    if (on) aiConstrainGrammar.set(false); // tools win this turn → reflect grammar going off
    commit(on ? { aiAgenticTools: true, aiConstrainGrammar: false } : { aiAgenticTools: false });
    syncAiExclusivity();
  });
  const aiInlineCompletions = toggle('AI inline completions', (on) => commit({ aiInlineCompletions: on }));
  const aiConstrainGrammar = toggle('Constrain AI output to the Koine grammar', (on) => {
    if (on) aiAgenticTools.set(false); // grammar wins this turn → reflect tools going off
    commit(on ? { aiConstrainGrammar: true, aiAgenticTools: false } : { aiConstrainGrammar: false });
    syncAiExclusivity();
  });

  // Reflect the mutual exclusion in the UI: whichever of the two is on disables (greys) the other, so
  // it can't be turned on alongside. Reads the live aria-checked state so it stays correct after each
  // toggle and on open. A function declaration (hoisted) so the toggle closures above can call it.
  function syncAiExclusivity(): void {
    const toolsOn = aiAgenticTools.el.getAttribute('aria-checked') === 'true';
    const grammarOn = aiConstrainGrammar.el.getAttribute('aria-checked') === 'true';
    aiAgenticTools.setDisabled(grammarOn);
    aiConstrainGrammar.setDisabled(toolsOn);
  }

  // Assistant sampling temperature (#750), clamped 0..2; sent on every assistant request (getTemperature).
  const temperatureInput = metricInput(
    TEMP_MIN,
    TEMP_MAX,
    TEMP_STEP,
    () => loadSettings().aiTemperature,
    (v) => commit({ aiTemperature: v }),
  );
  const temperatureRow = row(
    'Temperature',
    'Assistant sampling temperature (0–2). Lower is steadier; higher is more varied.',
    temperatureInput,
  );

  const baseUrlRow = row('Base URL', 'Endpoint for the OpenAI-compatible provider.', aiBaseUrlInput);
  const agenticToolsRow = row(
    'Compiler tools',
    'Let the model validate, compile and format your model mid-chat. Off keeps replies streaming — some local servers (LM Studio) stop streaming when tools are offered. Mutually exclusive with grammar-constraint below — turn that off to use tools.',
    aiAgenticTools.el,
  );
  const inlineCompletionsRow = row(
    'AI inline completions',
    'Predict the next line as ghost text while you type; Tab accepts, Esc dismisses. Off by default — it sends the surrounding buffer to the provider above on each idle pause, so it spends tokens and no-ops without a configured provider.',
    aiInlineCompletions.el,
  );
  const constrainGrammarRow = row(
    'Constrain AI output to the Koine grammar',
    "Guarantee the assistant's generated .koi parses: grammar-capable local models are constrained to the Koine grammar, while other providers validate-and-repair the model before Apply is enabled. Mutually exclusive with Compiler tools — grammar wins, since a grammar-constrained model can't also call tools.",
    aiConstrainGrammar.el,
  );
  function syncProviderFields(): void {
    const isOpenai = aiProviderSelect.value === 'openai';
    baseUrlRow.hidden = !isOpenai;
    // Compiler tool-use is supported on BOTH providers now (the Anthropic adapter advertises the
    // koine tools too — see runAnthropic in ai.ts), so the opt-in applies regardless of provider.
    agenticToolsRow.hidden = false;
    aiModelInput.placeholder = isOpenai ? 'gpt-4o  ·  qwen2.5-coder  ·  …' : 'claude-opus-4-8';
  }

  aiProviderSelect.addEventListener('change', () => {
    const aiProvider = aiProviderSelect.value === 'openai' ? 'openai' : 'anthropic';
    const merged = patchSettings({ aiProvider });
    // Swap the model field to the model remembered for the now-selected provider, so a Claude id is
    // never left sitting in front of an OpenAI endpoint (and vice-versa).
    aiModelInput.value = aiProvider === 'openai' ? merged.aiModelOpenai : merged.aiModel;
    syncProviderFields();
    cb.onChange(merged);
  });
  aiBaseUrlInput.addEventListener('change', () => {
    const url = aiBaseUrlInput.value.trim();
    commit({ aiBaseUrl: url || 'https://api.openai.com/v1' });
  });
  // The key is a secret: it goes through the encrypted store, not the plaintext settings blob.
  aiKeyInput.addEventListener('change', () => {
    void saveApiKey(aiKeyInput.value.trim()).then(() => cb.onChange(loadSettings()));
  });
  aiModelInput.addEventListener('change', () => {
    const model = aiModelInput.value.trim();
    commit(aiProviderSelect.value === 'openai' ? { aiModelOpenai: model } : { aiModel: model });
  });

  const assistantPanel = panel(
    'assistant',
    row('Provider', 'Which API the assistant talks to.', aiProviderSelect),
    baseUrlRow,
    row('API key', 'Encrypted in this browser and never leaves this device — sent only to the provider you choose.', aiKeyInput),
    row('Model', 'The model id the assistant requests.', aiModelInput),
    temperatureRow,
    agenticToolsRow,
    inlineCompletionsRow,
    constrainGrammarRow,
    presets,
  );

  // --- MCP server (Settings → MCP) ------------------------------------------
  // The desktop shell hosts a `koine mcp --http` sidecar; this panel toggles it on/off, shows the
  // right copy-paste recipe per client, and self-probes the endpoint to confirm an LLM can reach
  // Koine's tools. The web build can't host a server, so the toggle is disabled and only the recipes
  // (pointing at the `koine mcp --http` CLI) are shown.

  // URL shown inside HTTP recipes before a live endpoint resolves (or on the web build).
  const MCP_URL_PLACEHOLDER = 'http://127.0.0.1:PORT/mcp';

  const mcpEnableToggle = toggle('Enable MCP server', (on) => void applyMcpEnabled(on));
  const mcpEnableRow = row(
    'Enable MCP server',
    'Serve Koine’s compiler tools to an external MCP client (LM Studio, Claude Desktop…).',
    mcpEnableToggle.el,
  );

  // A browser tab can't host a server — surfaced as a caption when !mcpHostable.
  const mcpWebHint = document.createElement('p');
  mcpWebHint.className = 'koi-mcp-note';
  mcpWebHint.textContent =
    'A browser tab can’t host a server. Run `koine mcp --http` from the CLI, then use the recipe below.';
  mcpWebHint.hidden = true;

  // Endpoint URL (read-only) + Copy mcp.json — the quick path for a URL client.
  const mcpUrlInput = document.createElement('input');
  mcpUrlInput.type = 'text';
  mcpUrlInput.className = 'koi-text';
  mcpUrlInput.readOnly = true;
  mcpUrlInput.spellcheck = false;
  mcpUrlInput.placeholder = 'starting…';
  // This input is appended directly (not via row(), which assigns id/name elsewhere), so give it a
  // stable id/name (Chrome form-field id/name check; the aria-label stays the accessible name).
  mcpUrlInput.id = 'koi-mcp-url';
  mcpUrlInput.name = 'koi-mcp-url';
  mcpUrlInput.setAttribute('aria-label', 'Koine MCP endpoint URL');

  const mcpCopyBtn = document.createElement('button');
  mcpCopyBtn.type = 'button';
  mcpCopyBtn.className = 'koi-set-action';
  mcpCopyBtn.textContent = 'Copy mcp.json';
  let mcpCopyTimer: ReturnType<typeof setTimeout> | undefined;
  mcpCopyBtn.addEventListener('click', () => {
    const url = mcpUrlInput.value.trim();
    if (!url) return;
    navigator.clipboard
      .writeText(mcpJsonSnippet(url))
      .then(() => (mcpCopyBtn.textContent = 'Copied ✓'))
      .catch(() => (mcpCopyBtn.textContent = 'Copy failed'))
      .finally(() => {
        clearTimeout(mcpCopyTimer);
        mcpCopyTimer = setTimeout(() => (mcpCopyBtn.textContent = 'Copy mcp.json'), 1600);
      });
  });

  const mcpControl = document.createElement('div');
  mcpControl.className = 'koi-mcp-control';
  mcpControl.append(mcpUrlInput, mcpCopyBtn);
  const mcpEndpointRow = row('Endpoint', 'The loopback URL a URL-based client connects to.', mcpControl);

  // Per-client recipe picker.
  const mcpClientSelect = select(MCP_CLIENTS.map((c) => ({ value: c.id, label: c.label })));
  mcpClientSelect.addEventListener('change', () => {
    commit({ mcpClient: mcpClientSelect.value as Settings['mcpClient'] });
    renderRecipe();
  });
  const mcpClientRow = row('Client', 'Pick your MCP client for its exact setup snippet.', mcpClientSelect);

  // The recipe body: a heading + Copy, the snippet, the config hint, and an optional caveat.
  // The snippet is a read-only CodeMirror JSON view (createJsonView) so it's syntax-highlighted like
  // every other code surface in Studio; Copy reads its text back verbatim via getText(). tabIndex
  // keeps the box keyboard-focusable/scrollable (CodeMirror's read-only content isn't in the tab
  // order); the accessible name lives on the view's role=textbox content, so the wrapper doesn't
  // repeat it.
  const mcpSnippet = document.createElement('div');
  mcpSnippet.className = 'koi-mcp-snippet';
  mcpSnippet.tabIndex = 0;
  const mcpSnippetView = createJsonView(mcpSnippet);

  const mcpRecipeCopy = document.createElement('button');
  mcpRecipeCopy.type = 'button';
  mcpRecipeCopy.className = 'koi-set-action';
  mcpRecipeCopy.textContent = 'Copy';
  let mcpRecipeTimer: ReturnType<typeof setTimeout> | undefined;
  mcpRecipeCopy.addEventListener('click', () => {
    navigator.clipboard
      .writeText(mcpSnippetView.getText())
      .then(() => (mcpRecipeCopy.textContent = 'Copied ✓'))
      .catch(() => (mcpRecipeCopy.textContent = 'Copy failed'))
      .finally(() => {
        clearTimeout(mcpRecipeTimer);
        mcpRecipeTimer = setTimeout(() => (mcpRecipeCopy.textContent = 'Copy'), 1600);
      });
  });

  const mcpRecipeHead = document.createElement('div');
  mcpRecipeHead.className = 'koi-mcp-recipe-head';
  const mcpRecipeTitle = document.createElement('span');
  mcpRecipeTitle.className = 'koi-set-label';
  mcpRecipeTitle.textContent = 'Configuration';
  mcpRecipeHead.append(mcpRecipeTitle, mcpRecipeCopy);

  const mcpRecipeHint = document.createElement('p');
  mcpRecipeHint.className = 'koi-mcp-hint';
  const mcpRecipeNote = document.createElement('p');
  mcpRecipeNote.className = 'koi-mcp-note';

  const mcpRecipe = document.createElement('div');
  mcpRecipe.className = 'koi-mcp-recipe';
  mcpRecipe.append(mcpRecipeHead, mcpSnippet, mcpRecipeHint, mcpRecipeNote);

  function renderRecipe(): void {
    const client = MCP_CLIENTS.find((c) => c.id === mcpClientSelect.value) ?? MCP_CLIENTS[0];
    const url = mcpUrlInput.value.trim() || MCP_URL_PLACEHOLDER;
    mcpSnippetView.setContent(client.snippet(url));
    mcpRecipeHint.textContent = client.configHint;
    mcpRecipeNote.textContent = client.note ?? '';
    mcpRecipeNote.hidden = !client.note;
  }

  // Connection test: Studio probes the endpoint as a minimal MCP client and reports the tool count.
  const mcpTestBtn = document.createElement('button');
  mcpTestBtn.type = 'button';
  mcpTestBtn.className = 'koi-set-action';
  mcpTestBtn.textContent = 'Test connection';

  const mcpStatus = document.createElement('span');
  mcpStatus.className = 'koi-mcp-status';
  mcpStatus.setAttribute('role', 'status');
  mcpStatus.setAttribute('aria-live', 'polite');

  type McpStatusKind = 'idle' | 'off' | 'checking' | 'ok' | 'fail';
  const STATUS_LABEL: Record<McpStatusKind, string> = {
    idle: 'Not checked',
    off: 'Server off',
    checking: 'Checking…',
    ok: 'Connected',
    fail: 'Not reachable',
  };
  function setMcpStatus(kind: McpStatusKind, text?: string): void {
    mcpStatus.dataset.state = kind;
    mcpStatus.textContent = text ?? STATUS_LABEL[kind];
  }

  const mcpTestControl = document.createElement('div');
  mcpTestControl.className = 'koi-mcp-control';
  mcpTestControl.append(mcpTestBtn, mcpStatus);
  const mcpTestRow = row('Connection', 'Confirm an LLM can reach Koine’s tools at this URL.', mcpTestControl);

  // Monotonic token bumped by every enable/disable/reset/open. A slow async result (endpoint launch,
  // probe) checks its captured token before writing the UI and drops itself if a newer action has
  // since superseded it — so a late enable can't re-show a URL for a server the user just disabled,
  // and a probe can't overwrite "Server off" after a disable.
  let mcpGen = 0;

  mcpTestBtn.addEventListener('click', () => void runMcpTest());
  async function runMcpTest(): Promise<void> {
    if (!loadSettings().mcpEnabled) return setMcpStatus('off');
    const url = mcpUrlInput.value.trim();
    if (!url) return setMcpStatus('fail', 'No endpoint');
    const gen = ++mcpGen;
    setMcpStatus('checking');
    const result = await probeMcp(url);
    if (gen !== mcpGen) return; // a newer toggle/test ran while we probed — don't clobber its status
    if (result.ok) setMcpStatus('ok', `Connected ✓ — ${result.tools.length} tools`);
    else setMcpStatus('fail');
  }

  // Resolve (and on the desktop, lazily launch) the MCP sidecar endpoint URL, or '' if it can't be
  // brought up. DOM-free so callers can guard the write against a newer action via mcpGen.
  async function resolveMcpEndpoint(): Promise<string> {
    if (!cb.mcpEndpoint) return '';
    try {
      return (await cb.mcpEndpoint()) ?? '';
    } catch {
      return '';
    }
  }

  // Paint the "server off" state: no endpoint, the recipe on its placeholder URL, status off.
  function showMcpOff(): void {
    mcpUrlInput.value = '';
    renderRecipe();
    setMcpStatus('off');
  }

  // Apply an enable result to the UI: reveal the URL + recipe, or surface a start failure (a blank
  // URL means the sidecar never came up) instead of a benign "Not checked".
  function showMcpStarted(url: string): void {
    mcpUrlInput.value = url;
    renderRecipe();
    if (url) setMcpStatus('idle');
    else setMcpStatus('fail', 'Server didn’t start');
  }

  // Toggle the sidecar: start + reveal the endpoint on enable, stop + clear it on disable.
  async function applyMcpEnabled(on: boolean): Promise<void> {
    const gen = ++mcpGen;
    commit({ mcpEnabled: on });
    if (on) {
      const url = await resolveMcpEndpoint();
      if (gen !== mcpGen) return; // superseded by a newer toggle/reset — drop this stale result
      showMcpStarted(url);
    } else {
      await cb.mcpStop?.();
      if (gen !== mcpGen) return;
      showMcpOff();
    }
    syncMcpUi(on);
  }

  // Reflect enabled state + host capability: the endpoint and test rows only matter when a server is
  // actually running here; the recipes are always useful, so they stay visible.
  function syncMcpUi(enabled: boolean = loadSettings().mcpEnabled): void {
    const hostable = cb.mcpHostable !== false;
    mcpEnableToggle.el.disabled = !hostable;
    mcpWebHint.hidden = hostable;
    mcpEndpointRow.hidden = !hostable || !enabled;
    mcpTestRow.hidden = !hostable || !enabled;
  }

  // The Settings "on show" sidecar (re)start: (re)spawn the desktop sidecar when enabled and reflect the
  // endpoint in THIS pane's MCP panel. The launch itself is the shared, DOM-free startMcpSidecarIfEnabled
  // (so the JSON representation, which mounts no pane, fires the same concern); here we add the panel UI,
  // guarded by mcpGen so a stale resolve can't repaint after a newer toggle/reset/close superseded it.
  // The bare mount never calls this, so the opt-in server is never spawned before Settings is shown.
  function startMcpSidecar(): void {
    const s = loadSettings();
    if (s.mcpEnabled && cb.mcpHostable !== false) {
      const gen = ++mcpGen;
      void startMcpSidecarIfEnabled(cb, s).then((url) => {
        if (gen === mcpGen) showMcpStarted(url);
      });
    } else {
      ++mcpGen;
      showMcpOff();
    }
    syncMcpUi(s.mcpEnabled);
  }

  const mcpPanel = panel('mcp', mcpEnableRow, mcpWebHint, mcpEndpointRow, mcpClientRow, mcpRecipe, mcpTestRow);

  // --- Workspace root (shown only when the host can save projects) ----------

  const wsRootValue = document.createElement('span');
  wsRootValue.className = 'koi-set-label';
  wsRootValue.textContent = 'Not set yet';

  const wsRootBtn = document.createElement('button');
  wsRootBtn.type = 'button';
  wsRootBtn.className = 'koi-set-action';
  wsRootBtn.textContent = 'Change…';
  wsRootBtn.addEventListener('click', () => {
    void cb.pickWorkspaceRoot?.().then((name) => {
      if (name !== null) wsRootValue.textContent = name;
    });
  });

  const wsRootControl = document.createElement('div');
  wsRootControl.className = 'koi-mcp-control';
  wsRootControl.append(wsRootValue, wsRootBtn);
  const wsRootRow = row(
    'Workspace root',
    'The directory under which "Save to disk" writes named projects.',
    wsRootControl,
  );
  wsRootRow.hidden = !cb.canSaveProjects;

  async function refreshWsRootValue(): Promise<void> {
    if (!cb.canSaveProjects || !cb.workspaceRootName) return;
    const name = await cb.workspaceRootName();
    wsRootValue.textContent = name ?? 'Not set yet';
  }

  // --- Advanced -------------------------------------------------------------

  // LSP trace is workspace-scopable. The <select> is the value control; its change routes through the
  // scope binding (User → global blob; Workspace → the override store).
  const traceSelect = select([
    { value: 'off', label: 'Off' },
    { value: 'messages', label: 'Messages' },
    { value: 'verbose', label: 'Verbose' },
  ] as const);
  const traceRow = scopedRow(
    'lspTrace',
    'Language server trace',
    'Verbosity of LSP logging in the console.',
    (scopedCommit) => {
      traceSelect.addEventListener('change', () => {
        const v = traceSelect.value;
        scopedCommit(v === 'messages' || v === 'verbose' ? v : 'off');
      });
      return { el: traceSelect, set: (v) => (traceSelect.value = v) };
    },
  );

  // Reset is destructive (it clears the assistant key too), so it confirms on a second click and
  // disarms itself shortly after to avoid an accidental wipe.
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'koi-set-danger';
  let armed = false;
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmReset(): void {
    armed = false;
    resetBtn.classList.remove('is-armed');
    resetBtn.textContent = 'Reset to defaults';
    if (disarmTimer) clearTimeout(disarmTimer);
  }
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetBtn.classList.add('is-armed');
      resetBtn.textContent = 'Click again to reset everything';
      disarmTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    saveSettings({ ...DEFAULT_SETTINGS });
    void clearApiKey(); // reset wipes the secret too, not just the plaintext settings
    clearKeybindingOverrides(); // ...and restores default keybindings (kept in their own store)
    const fresh = loadSettings();
    setTheme(fresh.theme); // theme has its own live-apply path (not covered by applyAppearance)
    populate(fresh); // also repaints the Keyboard panel to the freshly-cleared defaults
    void cb.mcpStop?.(); // defaults disable MCP — stop any running sidecar and reflect it
    ++mcpGen; // supersede any in-flight enable/probe so it can't repaint the panel after reset
    showMcpOff();
    syncMcpUi(false);
    cb.onChange(fresh); // re-skins accent/motion/editor metrics + soft-wrap via the app's onChange
    cb.onKeybindingsChanged?.(); // live-apply the restored default keymap to the editor
  });

  const advancedPanel = panel(
    'advanced',
    wsRootRow,
    traceRow,
    row('Reset', 'Restore every setting — including the assistant — to its default.', resetBtn),
  );

  // --- About ----------------------------------------------------------------

  const about = createAboutPanel();
  const aboutPanel = panel('about', about.el);

  // --- assemble the two-pane layout -----------------------------------------

  const categories = [
    { id: 'appearance', label: 'Appearance', icon: ICON.appearance, panel: appearancePanel },
    { id: 'editor', label: 'Editor', icon: ICON.editor, panel: editorPanel },
    { id: 'keyboard', label: 'Keyboard', icon: ICON.keyboard, panel: keyboardPanel },
    { id: 'output', label: 'Output', icon: ICON.output, panel: outputPanel },
    { id: 'assistant', label: 'Assistant', icon: ICON.assistant, panel: assistantPanel },
    { id: 'mcp', label: 'MCP', icon: ICON.mcp, panel: mcpPanel },
    { id: 'advanced', label: 'Advanced', icon: ICON.advanced, panel: advancedPanel },
    { id: 'about', label: 'About', icon: ICON.about, panel: aboutPanel },
  ] as const;

  const nav = document.createElement('nav');
  nav.className = 'koi-settings-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-orientation', 'vertical');
  nav.setAttribute('aria-label', 'Settings categories');

  const panels = document.createElement('div');
  panels.className = 'koi-settings-panels';

  const tabs = categories.map((c) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'koi-settings-tab';
    tab.setAttribute('role', 'tab');
    tab.id = `koi-settings-tab-${c.id}`;
    tab.setAttribute('aria-controls', c.panel.id);
    tab.tabIndex = -1;
    const icon = document.createElement('span');
    icon.className = 'koi-settings-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = c.icon;
    const label = document.createElement('span');
    label.textContent = c.label;
    tab.append(icon, label);
    c.panel.setAttribute('aria-labelledby', tab.id);
    nav.appendChild(tab);
    panels.appendChild(c.panel);
    return tab;
  });

  let activeIndex = 0;
  function selectCategory(index: number, focusTab = false): void {
    // Switching (or re-selecting) a category cancels an armed keybinding recorder and clears any open
    // conflict prompt — otherwise the document-level capture listener keeps swallowing keystrokes typed
    // into another panel and could rebind the now-hidden Keyboard row.
    disarmRecording();
    for (const id of kbdRows.keys()) hideKbdConflict(id);
    activeIndex = index;
    categories.forEach((c, i) => {
      const on = i === index;
      tabs[i].setAttribute('aria-selected', String(on));
      tabs[i].classList.toggle('is-active', on);
      tabs[i].tabIndex = on ? 0 : -1;
      c.panel.hidden = !on;
    });
    if (focusTab) tabs[index].focus();
  }

  tabs.forEach((tab, i) => tab.addEventListener('click', () => selectCategory(i)));
  // Roving arrow navigation between categories (vertical tablist convention).
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    selectCategory(wrapIndex(activeIndex, delta, categories.length), true); // shared wrap helper
  });

  const layout = document.createElement('div');
  layout.className = 'koi-settings-layout';
  layout.append(nav, panels);
  container.appendChild(layout);

  // --- populate every control from the current Settings ---------------------

  function populate(s: Settings): void {
    themeSeg.set(s.theme);
    accent.set(s.accent);
    reduceMotion.set(s.reduceMotion);
    displayNameInput.value = s.displayName;
    fontFamilyInput.value = s.fontFamily;
    fontInput.value = String(s.fontSize);
    lineHeightInput.value = String(s.lineHeight);
    tabSizeInput.value = String(s.tabSize);
    autoSave.set(s.autoSave);
    minimap.set(s.enableMinimap);
    defaultCanvasZoomInput.value = String(s.defaultCanvasZoom);
    refreshSpecimen();
    // Rebuild the language cards from the live EMIT_TARGETS first: the picker was constructed during
    // init() (before the backend seed), so a backend-seeded target only appears once this re-renders
    // on open (issue #282). The scoped sync below then sets its selection to the effective target.
    outputLang.refresh();
    aiProviderSelect.value = s.aiProvider;
    aiBaseUrlInput.value = s.aiBaseUrl;
    aiKeyInput.value = s.aiApiKey;
    aiModelInput.value = s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel;
    temperatureInput.value = String(s.aiTemperature);
    // #447: Compiler-tools and grammar-constraint are mutually exclusive. A legacy persisted state with
    // BOTH on is the silently-broken combination → normalize to grammar-wins (tools off) and persist
    // the correction, so the panel never even shows the broken pairing.
    const bothAiOn = s.aiAgenticTools && s.aiConstrainGrammar;
    if (bothAiOn) patchSettings({ aiAgenticTools: false });
    aiAgenticTools.set(bothAiOn ? false : s.aiAgenticTools);
    aiInlineCompletions.set(s.aiInlineCompletions);
    aiConstrainGrammar.set(s.aiConstrainGrammar);
    syncAiExclusivity();
    mcpEnableToggle.set(s.mcpEnabled);
    mcpClientSelect.value = s.mcpClient;
    renderRecipe();
    syncProviderFields();
    // The four workspace-scopable rows (previewTarget, formatOnSave, wordWrap, lspTrace): reflect each
    // row's scope (User/Workspace) from the override store and set its value control to the EFFECTIVE
    // value, so a Workspace row shows its override while a User row shows the user value. Runs after
    // outputLang.refresh() so the picker's cards exist before its selection is set.
    for (const sc of scopedControls) sc.sync(s);
    // Repaint the Keyboard panel from the current overrides (and cancel any armed recording / open
    // conflict) so a reopen — including the one the Advanced reset triggers — shows fresh chords.
    refreshKeyboard();
  }

  // The pane's "open" state: repaint every control from the current Settings, refresh the About card,
  // back-fill the workspace-root + secret fields, sync the MCP panel's enabled/host visibility, and reveal
  // the active category. This is REPAINT ONLY — the MCP sidecar (re)start is the separate on-show
  // {@link startMcpSidecar} call (issue #735), so a bare mount / never-shown embed never spawns the opt-in
  // server. `focusTab` moves focus onto the active category tab: wanted when a MODAL opens (focus into the
  // dialog), but NOT for the embedded center page (it would steal focus from the page).
  function applyOpenState({ focusTab }: { focusTab: boolean }): void {
    disarmReset();
    const s = loadSettings();
    populate(s);
    about.refresh();
    void refreshWsRootValue();
    // On a very fast first paint the secret may still be decrypting; back-fill the key once it lands,
    // but never clobber a value the user has already started typing.
    void whenSecretsReady().then(() => {
      if (aiKeyInput.value === '') aiKeyInput.value = loadSettings().aiApiKey;
    });
    syncMcpUi(s.mcpEnabled); // reflect enabled/host visibility; the actual (re)start is startMcpSidecar
    selectCategory(activeIndex, focusTab); // keep the last-open category across opens
  }

  // Repaint from the current Settings, optionally landing on a named category first. Repaint only — the
  // caller fires the MCP sidecar (re)start separately via {@link startMcpSidecar} on show (issue #735), so
  // re-syncing the form (e.g. a center-page re-show) never re-triggers the start on its own. `focusTab`
  // defaults true (the modal focuses the tab on open); the embedded center page passes false so re-showing
  // it never steals focus from the page.
  function refresh(categoryId?: string, focusTab = true): void {
    if (categoryId) {
      const i = categories.findIndex((c) => c.id === categoryId);
      if (i >= 0) activeIndex = i;
    }
    applyOpenState({ focusTab });
  }

  // Cancel any in-flight transient state: an armed keybinding recorder (whose document-level capture
  // listener would otherwise outlive a close and hijack the next keystroke — e.g. swallow Mod-S and
  // silently rebind a hidden row) and any open conflict prompt. The modal calls this on close by ANY path.
  function suspend(): void {
    disarmRecording();
    for (const id of kbdRows.keys()) hideKbdConflict(id);
  }

  // Fully tear the pane down: drop transient state, supersede any in-flight async (so a late sidecar /
  // probe result can't repaint a removed pane), clear pending timers, destroy the MCP CodeMirror view,
  // and remove the form root from its container.
  function destroy(): void {
    suspend();
    ++mcpGen;
    clearTimeout(mcpCopyTimer);
    clearTimeout(mcpRecipeTimer);
    clearTimeout(disarmTimer);
    mcpSnippetView.destroy();
    layout.remove();
  }

  // Populate immediately from the current Settings so an embedded pane shows live values without the
  // caller wiring anything; the surface is NOT yet shown (so no sidecar spawns) and focus is NOT moved
  // (that would steal it from the surrounding page). Baseline the MCP panel to "server off" (renders the
  // placeholder recipe) until the surface is shown and startMcpSidecar runs.
  applyOpenState({ focusTab: false });
  ++mcpGen;
  showMcpOff();

  return { destroy, refresh, startMcpSidecar, suspend };
}
