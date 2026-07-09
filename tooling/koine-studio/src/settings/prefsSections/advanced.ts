// The Advanced section (extracted from prefs.ts, #987 task 7 — the FINAL section in the split): the
// workspace-root control (shown only when the host can save projects), the workspace-scopable LSP trace
// verbosity row, the desktop-only terminal shell-args editor, and the destructive two-click Reset.
//
// Reset is the one call site in the whole split with a genuine cross-section fan-out: on confirmation the
// original inline handler reached into EVERY other section (repainting the whole pane, stopping the MCP
// sidecar, resetting the MCP panel, live-applying the theme and keymap). Since section modules must not
// import prefs.ts or reach into siblings (no cross-section coupling, no import cycles), this module keeps
// ONLY the two-click arm/confirm/disarm state machine — on confirmation it calls `deps.onReset()`, a
// single hook the assembler (prefs.ts) supplies. `onReset` holds that entire original sequence verbatim,
// unchanged in order or content, just relocated to a named function in prefs.ts (see its own comment).
//
// This module must not import prefs.ts (no import cycles).
import type { Settings } from "@/settings/persistence";
import {
    row,
    panel,
    select,
    stringListInput,
} from "@/settings/prefsControls";
import type { ScopeKit } from "@/settings/prefsSections/scopeKit";
import type { PrefsSection, SectionCtx } from "@/settings/prefsSections/types";

/** What buildAdvancedSection needs from its host beyond {@link SectionCtx}. */
export interface AdvancedSectionDeps {
    /** The shared ScopeKit instance (also backing Editor's/Output's own scoped rows) — Advanced's one
     *  scoped field is lspTrace. */
    scopeKit: ScopeKit;

    /**
     * Whether this host can save projects to a workspace root directory. True in the browser when the
     * File System Access API is present; false on the Tauri desktop. When false, the workspace root row
     * is hidden.
     */
    canSaveProjects?: boolean;

    /**
     * Whether this host has an integrated terminal (Tauri desktop only). When false or omitted the
     * "Terminal shell args" row is hidden.
     */
    hasIntegratedTerminal?: boolean;

    /** Return the remembered workspace root's display name, or null if not yet set. */
    workspaceRootName?(): Promise<string | null>;

    /** Re-pick the workspace root directory; returns its name, or null if dismissed. */
    pickWorkspaceRoot?(): Promise<string | null>;

    /** Run on a CONFIRMED (second-click) Reset — the entire cross-section reset sequence, owned by the
     *  assembler since it reaches into every other section. */
    onReset(): void;
}

export function buildAdvancedSection(
    ctx: SectionCtx,
    deps: AdvancedSectionDeps,
): PrefsSection & {
    refreshWsRootValue(): Promise<void>;
    disarmReset(): void;
    destroy(): void;
} {
    // --- Workspace root (shown only when the host can save projects) ----------

    const wsRootValue = document.createElement("span");
    wsRootValue.className = "koi-set-label";
    wsRootValue.textContent = "Not set yet";

    const wsRootBtn = document.createElement("button");
    wsRootBtn.type = "button";
    wsRootBtn.className = "koi-set-action";
    wsRootBtn.textContent = "Change…";
    wsRootBtn.addEventListener("click", () => {
        void deps.pickWorkspaceRoot?.().then((name) => {
            if (name !== null) wsRootValue.textContent = name;
        });
    });

    const wsRootControl = document.createElement("div");
    wsRootControl.className = "koi-mcp-control";
    wsRootControl.append(wsRootValue, wsRootBtn);
    const wsRootRow = row(
        "Workspace root",
        'The directory under which "Save to disk" writes named projects.',
        wsRootControl,
    );
    wsRootRow.hidden = !deps.canSaveProjects;

    async function refreshWsRootValue(): Promise<void> {
        if (!deps.canSaveProjects || !deps.workspaceRootName) return;
        const name = await deps.workspaceRootName();
        wsRootValue.textContent = name ?? "Not set yet";
    }

    // --- Advanced -------------------------------------------------------------

    // LSP trace is workspace-scopable. The <select> is the value control; its change routes through the
    // scope binding (User → global blob; Workspace → the override store).
    const traceSelect = select([
        { value: "off", label: "Off" },
        { value: "messages", label: "Messages" },
        { value: "verbose", label: "Verbose" },
    ] as const);
    const traceRow = deps.scopeKit.scopedRow(
        "lspTrace",
        "Language server trace",
        "Verbosity of LSP logging in the console.",
        (scopedCommit) => {
            traceSelect.addEventListener("change", () => {
                const v = traceSelect.value;
                scopedCommit(v === "messages" || v === "verbose" ? v : "off");
            });
            return { el: traceSelect, set: (v) => (traceSelect.value = v) };
        },
    );

    // Terminal shell args — desktop only (hidden on the web host).
    const shellArgsControl = stringListInput(
        "Terminal shell arguments",
        (values) => {
            ctx.commit({ terminalShellArgs: values });
        },
    );
    const shellArgsRow = row(
        "Terminal shell args",
        "Arguments passed to the login shell when the integrated terminal opens. Empty uses the shell default (`-l`).",
        shellArgsControl.el,
    );
    shellArgsRow.hidden = !deps.hasIntegratedTerminal;

    // Reset is destructive (it clears the assistant key too), so it confirms on a second click and
    // disarms itself shortly after to avoid an accidental wipe. This module owns ONLY the arm/confirm/
    // disarm state machine; the actual cross-section reset sequence lives in deps.onReset (see the module
    // doc comment above).
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "koi-set-danger";
    let armed = false;
    let disarmTimer: ReturnType<typeof setTimeout> | undefined;
    function disarmReset(): void {
        armed = false;
        resetBtn.classList.remove("is-armed");
        resetBtn.textContent = "Reset to defaults";
        if (disarmTimer) clearTimeout(disarmTimer);
    }
    resetBtn.addEventListener("click", () => {
        if (!armed) {
            armed = true;
            resetBtn.classList.add("is-armed");
            resetBtn.textContent = "Click again to reset everything";
            disarmTimer = setTimeout(disarmReset, 4000);
            return;
        }
        disarmReset();
        deps.onReset();
    });

    const advancedPanel = panel(
        "advanced",
        wsRootRow,
        traceRow,
        shellArgsRow,
        row(
            "Reset",
            "Restore every setting — including the assistant — to its default.",
            resetBtn,
        ),
    );

    // populate(s) covers ONLY the shell-args chip list — the trace row's value comes from
    // deps.scopeKit.syncAll(s), called separately by the assembler (same pattern as Editor's word-wrap/
    // format-on-save rows): do not have this touch traceSelect directly.
    function populate(s: Settings): void {
        shellArgsControl.set(s.terminalShellArgs);
    }

    // Clear the pending disarm timer — called by the assembler's own destroy() so a torn-down pane never
    // fires a stray disarmReset() after the fact.
    function destroy(): void {
        clearTimeout(disarmTimer);
    }

    return { panel: advancedPanel, populate, refreshWsRootValue, disarmReset, destroy };
}
