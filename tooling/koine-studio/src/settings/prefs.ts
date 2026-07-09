// Settings form for Koine Studio: the two-pane preference center the gear-launched Settings page embeds
// (the legacy modal was retired, #731). Laid out as a vertical category rail (Appearance / Editor /
// Keyboard / Output / Assistant / MCP / Advanced / About) on the left, the active category's controls on
// the right. The set of persisted Settings (./persistence) is the source of truth; each control writes a
// single-field patch through patchSettings() and reports the merged Settings back via onChange. The app's
// onChange handler is the single place that re-skins the studio (applyAppearance + editor soft-wrap), so
// flipping a control applies live there; only Theme is applied here directly, through ./theme's setTheme
// (its own live-apply + listeners).
//
// mountPreferencesPane below is a thin ASSEMBLER, not the home of the controls themselves (#987): each
// category's DOM + wiring lives in its own module under ./prefsSections/ (appearance, about, editor,
// keyboard, output, assistant, mcp, advanced), built via a buildXSection(ctx, deps) call and composed
// into the `categories` rail here. Shared machinery lives beside them: ./prefsControls.ts (the pure,
// callback-driven control factories — row/panel/select/toggle/segmented/…), ./prefsSections/scopeKit.ts
// (the User/Workspace per-field override toggle, built once and passed to every scopable section), and
// ./prefsSections/types.ts (the SectionCtx/PrefsSection contracts every section module implements). A
// section module must never import this file — mountPreferencesPane imports them, never the reverse.
import {
    loadSettings,
    patchSettings,
    saveSettings,
    clearApiKey,
    clearKeybindingOverrides,
    DEFAULT_SETTINGS,
    type Settings,
} from "@/settings/persistence";
import type { McpEndpoint } from "@/host/types";
import { setTheme } from "@/settings/theme";
import { createScopeKit } from "@/settings/prefsSections/scopeKit";
import type { SectionCtx } from "@/settings/prefsSections/types";
import { buildAppearanceSection } from "@/settings/prefsSections/appearance";
import { buildAboutSection } from "@/settings/prefsSections/about";
import { buildEditorSection } from "@/settings/prefsSections/editor";
import { buildKeyboardSection } from "@/settings/prefsSections/keyboard";
import { buildOutputSection } from "@/settings/prefsSections/output";
import { buildAssistantSection } from "@/settings/prefsSections/assistant";
import { buildMcpSection } from "@/settings/prefsSections/mcp";
import { buildAdvancedSection } from "@/settings/prefsSections/advanced";

export interface PrefsCallbacks {
    /** Fired after every committed change with the merged, persisted Settings. */
    onChange(s: Settings): void;

    /**
     * Resolve the local MCP HTTP endpoint to surface in the Assistant settings (so the user can paste its
     * URL into LM Studio) — the loopback URL plus whether the host fell back to an OS-assigned port because
     * the configured one was busy ({@link McpEndpoint}) — or null when the host can't serve one (the web
     * build, where the row stays hidden). Optional: a caller that doesn't wire it simply never shows the row.
     */
    mcpEndpoint?(): Promise<McpEndpoint | null>;

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

    /**
     * Whether this host has an integrated terminal (Tauri desktop only).
     * When false or omitted the "Terminal shell args" Advanced row is hidden.
     */
    hasIntegratedTerminal?: boolean;

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

// (Editor's own font/line-height/tab-size/canvas-zoom bounds moved with it into prefsSections/editor.ts,
// #987 task 4; Assistant's temperature bounds and MCP's port bounds moved with THEM into
// prefsSections/assistant.ts and prefsSections/mcp.ts respectively, #987 task 6.)

// Category rail icons, drawn in the studio's 16×16 line-icon idiom (stroke = currentColor).
const ICON = {
    appearance:
        '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/></svg>',
    editor: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4 2.4 8 6 12"/><path d="M10 4l3.6 4-3.6 4"/></svg>',
    keyboard:
        '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.6" y="4" width="12.8" height="8" rx="1.4"/><path d="M4 6.4h.01M6.4 6.4h.01M8.8 6.4h.01M11.2 6.4h.01M4.8 9.6h6.4"/></svg>',
    assistant:
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.5 3.9 3.9 1.5-3.9 1.5L8 13l-1.5-3.9L2.6 7.6l3.9-1.5z"/></svg>',
    mcp: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.6v4.2M10 2.6v4.2M4.4 6.8h7.2v1.4a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6z"/><path d="M8 12v1.8"/></svg>',
    advanced:
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/><circle cx="6" cy="4.6" r="1.7" fill="var(--koi-paper-2)"/><circle cx="10.4" cy="8" r="1.7" fill="var(--koi-paper-2)"/><circle cx="5" cy="11.4" r="1.7" fill="var(--koi-paper-2)"/></svg>',
    output: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.4 2.6c-1.2 0-1.7.6-1.7 1.8v1.6c0 .9-.3 1.3-1.1 1.4v1.2c.8.1 1.1.5 1.1 1.4v1.6c0 1.2.5 1.8 1.7 1.8M9.6 2.6c1.2 0 1.7.6 1.7 1.8v1.6c0 .9.3 1.3 1.1 1.4v1.2c-.8.1-1.1.5-1.1 1.4v1.6c0 1.2-.5 1.8-1.7 1.8"/></svg>',
    about: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.4"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none"/></svg>',
} as const;

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
 * (or `null` when disabled, not hostable, or it can't be brought up). The browser host passes
 * `mcpHostable: false` and never spawns; a disabled `mcpEnabled` is a no-op. `mcpEndpoint` is idempotent
 * (it reuses a running sidecar), so a redundant call — e.g. on a representation flip — reflects the live
 * endpoint without a second process.
 */
export async function startMcpSidecarIfEnabled(
    cb: PrefsCallbacks,
    s: Settings = loadSettings(),
): Promise<McpEndpoint | null> {
    if (!(s.mcpEnabled && cb.mcpHostable !== false)) return null;
    try {
        return (await cb.mcpEndpoint?.()) ?? null;
    } catch {
        return null;
    }
}

// Import for use in this module; re-export so callers importing from here (e.g. prefs.test.ts)
// keep working without an import-path change. Canonical definition: @/shared/wrapIndex (#745).
export { wrapIndex } from "@/shared/wrapIndex";
import { wrapIndex } from "@/shared/wrapIndex";

// segmented() and stringListInput() now live in @/settings/prefsControls (hoisted out to module scope,
// #987 task 1) alongside the other pure control factories; re-exported so callers importing from this
// module (e.g. prefs.test.ts, settingsPage.tsx) keep working without an import-path change. Neither is
// called directly in THIS module anymore: `segmented`'s one call site (Theme) moved into
// prefsSections/appearance.ts (#987 task 3), and `stringListInput`'s (Advanced's shellArgsControl) moved
// into prefsSections/advanced.ts (#987 task 7) — kept as pure re-exports, not local imports, so neither
// trips noUnusedLocals.
export { segmented, stringListInput } from "@/settings/prefsControls";

/**
 * Build the two-pane preference form (category rail + control pane) and append it into `container` — no
 * modal chrome. The DOM is created once and populated from the current Settings on mount; each control
 * commits a single-field patch through patchSettings() and reports the merged Settings back via cb.onChange.
 * Returns a handle to repaint/tear-down the pane. The gear-launched Settings center page
 * ({@link import('@/settings/settingsPage').createSettingsPage}) mounts this pane inside its Visual tab.
 */
export function mountPreferencesPane(
    container: HTMLElement,
    cb: PrefsCallbacks,
): MountedPrefsPane {
    // Every control commits a single-field patch, then reports the merged Settings to the app.
    function commit(patch: Partial<Settings>): void {
        cb.onChange(patchSettings(patch));
    }

    // The ctx every extracted section module (prefsSections/*) gets: `commit` is this module's own
    // single-field-patch path; `onChange` is the raw report path a control that bypasses patchSettings
    // still needs (Appearance's Theme — see prefsSections/appearance.ts). Built once and passed to each
    // section builder below; later tasks (Editor, Keyboard, Output, Assistant, MCP, Advanced) reuse the
    // same ctx at their own call sites.
    const sectionCtx: SectionCtx = { commit, onChange: cb.onChange };

    // Every pure, callback-driven control factory (row, panel, select, toggle, metricInput, segmented,
    // stringListInput, langPicker, accentPicker — @/settings/prefsControls, #987 task 1) is now used only
    // INSIDE the section modules that need it (Advanced's traceRow/advancedPanel among the last call
    // sites, #987 task 7) — none is imported directly here anymore; this module only re-exports
    // `segmented`/`stringListInput` for callers importing from this path (see above).

    // --- per-workspace scope control ------------------------------------------
    // The four scoped fields (previewTarget, formatOnSave, wordWrap, lspTrace) can be overridden per
    // workspace. The shared machinery (the User/Workspace segmented toggle, the scoped-commit routing,
    // and the scoped row layout) lives in @/settings/prefsSections/scopeKit (#987 task 2) — one kit
    // instance is built here and passed as a dependency to its three call sites (Editor's wordWrapRow /
    // formatOnSaveRow, Output's outputScope, and Advanced's traceRow — all three now in prefsSections/).
    // `deps.commit` is this module's own `commit` (the User-scope path); `deps.onChange` is the
    // Workspace-scope path and the segmented toggle's own scope-flip handler.
    const scopeKit = createScopeKit({
        workspaceKey: () => cb.workspaceKey?.() ?? null,
        commit,
        onChange: cb.onChange,
    });

    // --- Appearance -----------------------------------------------------------
    // Construction + control wiring extracted into prefsSections/appearance.ts (#987 task 3 — the first
    // section module, setting the pattern later tasks copy).

    const appearance = buildAppearanceSection(sectionCtx);

    // --- Editor ---------------------------------------------------------------
    // Construction + control wiring extracted into prefsSections/editor.ts (#987 task 4), following the
    // pattern Appearance set (task 3). Takes the shared scopeKit as a dependency for its two workspace-
    // scopable rows (word wrap, format on save).

    const editor = buildEditorSection(sectionCtx, { scopeKit });

    // --- Keyboard -------------------------------------------------------------
    // Construction + control wiring — including the chord recorder's document-level capture-phase
    // keydown listener (armRecording/disarmRecording) — extracted whole into prefsSections/keyboard.ts
    // (#987 task 5, the most delicate section: get the arm/disarm pairing wrong and a listener leaks that
    // swallows every keystroke on the page). Keyboard does NOT take sectionCtx: its commits go straight
    // through saveKeybindingOverride/clearKeybindingOverrides, not commit()/onChange(), and it notifies via
    // its own deps.onKeybindingsChanged rather than the shared ctx.

    const keyboard = buildKeyboardSection({
        onKeybindingsChanged: cb.onKeybindingsChanged,
    });

    // --- Output ---------------------------------------------------------------
    // Construction + control wiring extracted into prefsSections/output.ts (#987 task 4), following the
    // pattern Appearance set (task 3). Takes the shared scopeKit as a dependency for its one workspace-
    // scopable field (previewTarget).

    const output = buildOutputSection(sectionCtx, { scopeKit });

    // --- Assistant (AI) -------------------------------------------------------
    // Construction + control wiring — including the Compiler-tools/grammar mutual exclusion (#447) and
    // the on-open secret back-fill (backfillSecret) — extracted whole into prefsSections/assistant.ts
    // (#987 task 6).

    const assistant = buildAssistantSection(sectionCtx);

    // --- MCP server (Settings → MCP) -------------------------------------------
    // Construction + control wiring — including the sidecar start/stop lifecycle, the copy-confirmation
    // timers, the CodeMirror recipe view, and the mcpGen supersession counter — extracted whole into
    // prefsSections/mcp.ts (#987 task 6, the other section with an async lifecycle alongside Assistant).
    // mcp does take sectionCtx (its mcpEnableToggle/applyMcpEnabled/applyMcpPort commits route through
    // ctx.commit), plus its own narrow deps for the three MCP-shaped PrefsCallbacks members.

    const mcp = buildMcpSection(sectionCtx, {
        mcpEndpoint: cb.mcpEndpoint,
        mcpStop: cb.mcpStop,
        mcpHostable: cb.mcpHostable,
    });

    // --- Advanced (+ Workspace root) --------------------------------------------
    // Construction + control wiring — the workspace-root control, the workspace-scopable LSP trace row,
    // the terminal shell-args editor, and the two-click Reset's arm/confirm/disarm state machine —
    // extracted whole into prefsSections/advanced.ts (#987 task 7, the FINAL section in the split).
    //
    // Reset's CONFIRMED-click behavior is the one genuine cross-section fan-out in the whole pane: it
    // must reach into every other section (repaint the whole pane, stop the MCP sidecar, reset the MCP
    // panel, live-apply the theme and keymap), which a section module must never do directly (no
    // cross-section coupling, no import cycles). So `onReset` below stays HERE, in the assembler, holding
    // that entire original sequence verbatim, unchanged in order or content; buildAdvancedSection is only
    // handed the hook and calls it once, on confirmation.

    function onReset(): void {
        saveSettings({ ...DEFAULT_SETTINGS });
        void clearApiKey(); // reset wipes the secret too, not just the plaintext settings
        clearKeybindingOverrides(); // ...and restores default keybindings (kept in their own store)
        const fresh = loadSettings();
        setTheme(fresh.theme); // theme has its own live-apply path (not covered by applyAppearance)
        populate(fresh); // also repaints the Keyboard panel to the freshly-cleared defaults
        void cb.mcpStop?.(); // defaults disable MCP — stop any running sidecar and reflect it
        // showMcpOff() bumps mcp's own mcpGen internally, so it supersedes any in-flight enable/probe
        // and can't repaint the panel after reset.
        mcp.showMcpOff();
        mcp.syncMcpUi(false);
        cb.onChange(fresh); // re-skins accent/motion/editor metrics + soft-wrap via the app's onChange
        cb.onKeybindingsChanged?.(); // live-apply the restored default keymap to the editor
    }

    const advanced = buildAdvancedSection(sectionCtx, {
        scopeKit,
        canSaveProjects: cb.canSaveProjects,
        hasIntegratedTerminal: cb.hasIntegratedTerminal,
        workspaceRootName: cb.workspaceRootName,
        pickWorkspaceRoot: cb.pickWorkspaceRoot,
        onReset,
    });

    // --- About ----------------------------------------------------------------
    // Construction extracted into prefsSections/about.ts (#987 task 3); `about.refresh()` is still
    // called from applyOpenState below, at the same point the inline call used to run.

    const about = buildAboutSection();

    // --- assemble the two-pane layout -----------------------------------------

    const categories = [
        {
            id: "appearance",
            label: "Appearance",
            icon: ICON.appearance,
            panel: appearance.panel,
        },
        {
            id: "editor",
            label: "Editor",
            icon: ICON.editor,
            panel: editor.panel,
        },
        {
            id: "keyboard",
            label: "Keyboard",
            icon: ICON.keyboard,
            panel: keyboard.panel,
        },
        {
            id: "output",
            label: "Output",
            icon: ICON.output,
            panel: output.panel,
        },
        {
            id: "assistant",
            label: "Assistant",
            icon: ICON.assistant,
            panel: assistant.panel,
        },
        { id: "mcp", label: "MCP", icon: ICON.mcp, panel: mcp.panel },
        {
            id: "advanced",
            label: "Advanced",
            icon: ICON.advanced,
            panel: advanced.panel,
        },
        { id: "about", label: "About", icon: ICON.about, panel: about.panel },
    ] as const;

    const nav = document.createElement("nav");
    nav.className = "koi-settings-nav";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-orientation", "vertical");
    nav.setAttribute("aria-label", "Settings categories");

    const panels = document.createElement("div");
    panels.className = "koi-settings-panels";

    const tabs = categories.map((c) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "koi-settings-tab";
        tab.setAttribute("role", "tab");
        tab.id = `koi-settings-tab-${c.id}`;
        tab.setAttribute("aria-controls", c.panel.id);
        tab.tabIndex = -1;
        const icon = document.createElement("span");
        icon.className = "koi-settings-tab-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = c.icon;
        const label = document.createElement("span");
        label.textContent = c.label;
        tab.append(icon, label);
        c.panel.setAttribute("aria-labelledby", tab.id);
        nav.appendChild(tab);
        panels.appendChild(c.panel);
        return tab;
    });

    let activeIndex = 0;
    function selectCategory(index: number, focusTab = false): void {
        // Switching (or re-selecting) a category cancels an armed keybinding recorder and clears any open
        // conflict prompt — otherwise the document-level capture listener keeps swallowing keystrokes typed
        // into another panel and could rebind the now-hidden Keyboard row.
        keyboard.suspend();
        activeIndex = index;
        categories.forEach((c, i) => {
            const on = i === index;
            tabs[i].setAttribute("aria-selected", String(on));
            tabs[i].classList.toggle("is-active", on);
            tabs[i].tabIndex = on ? 0 : -1;
            c.panel.hidden = !on;
        });
        if (focusTab) tabs[index].focus();
    }

    tabs.forEach((tab, i) =>
        tab.addEventListener("click", () => selectCategory(i)),
    );
    // Roving arrow navigation between categories (vertical tablist convention).
    nav.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        selectCategory(wrapIndex(activeIndex, delta, categories.length), true); // shared wrap helper
    });

    const layout = document.createElement("div");
    layout.className = "koi-settings-layout";
    layout.append(nav, panels);
    container.appendChild(layout);

    // --- populate every control from the current Settings ---------------------

    function populate(s: Settings): void {
        appearance.populate(s);
        editor.populate(s);
        // output.populate(s) rebuilds the language cards from the live EMIT_TARGETS first: the picker was
        // constructed during init() (before the backend seed), so a backend-seeded target only appears
        // once this re-renders on open (issue #282). The scoped sync below then sets its selection to the
        // effective target — do not let scopeKit.syncAll run ahead of this call.
        output.populate(s);
        assistant.populate(s);
        mcp.populate(s);
        // The four workspace-scopable rows (previewTarget, formatOnSave, wordWrap, lspTrace): reflect each
        // row's scope (User/Workspace) from the override store and set its value control to the EFFECTIVE
        // value, so a Workspace row shows its override while a User row shows the user value. Runs after
        // output.populate(s) (outputLang.refresh()) so the picker's cards exist before its selection is set.
        scopeKit.syncAll(s);
        advanced.populate(s);
        // Repaint the Keyboard panel from the current overrides (and cancel any armed recording / open
        // conflict) so a reopen — including the one the Advanced reset triggers — shows fresh chords.
        keyboard.populate(s);
    }

    // The pane's "open" state: repaint every control from the current Settings, refresh the About card,
    // back-fill the workspace-root + secret fields, sync the MCP panel's enabled/host visibility, and reveal
    // the active category. This is REPAINT ONLY — the MCP sidecar (re)start is the separate on-show
    // {@link startMcpSidecar} call (issue #735), so a bare mount / never-shown embed never spawns the opt-in
    // server. `focusTab` moves focus onto the active category tab: wanted when a MODAL opens (focus into the
    // dialog), but NOT for the embedded center page (it would steal focus from the page).
    function applyOpenState({ focusTab }: { focusTab: boolean }): void {
        advanced.disarmReset();
        const s = loadSettings();
        populate(s);
        about.refresh();
        void advanced.refreshWsRootValue();
        // On a very fast first paint the secret may still be decrypting; back-fill the key once it lands,
        // but never clobber a value the user has already started typing.
        assistant.backfillSecret();
        mcp.syncMcpUi(s.mcpEnabled); // reflect enabled/host visibility; the actual (re)start is startMcpSidecar
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
        keyboard.suspend();
    }

    // Fully tear the pane down: drop transient state, supersede any in-flight async (so a late sidecar /
    // probe result can't repaint a removed pane), clear pending timers, destroy the MCP CodeMirror view,
    // and remove the form root from its container.
    function destroy(): void {
        suspend();
        mcp.destroy();
        advanced.destroy();
        layout.remove();
    }

    // Populate immediately from the current Settings so an embedded pane shows live values without the
    // caller wiring anything; the surface is NOT yet shown (so no sidecar spawns) and focus is NOT moved
    // (that would steal it from the surrounding page). Baseline the MCP panel to "server off" (renders the
    // placeholder recipe) until the surface is shown and startMcpSidecar runs.
    applyOpenState({ focusTab: false });
    mcp.showMcpOff();

    return { destroy, refresh, startMcpSidecar: mcp.startMcpSidecar, suspend };
}
