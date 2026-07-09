// The per-workspace scope kit (extracted from prefs.ts, #987 task 2): the four scoped fields
// (previewTarget, formatOnSave, wordWrap, lspTrace) can be overridden per workspace. Each scoped row
// pairs its VALUE control with a User/Workspace `segmented` toggle that routes commits either to the
// global settings blob (User) or the workspace override store (Workspace). When no workspace is open
// the toggle is disabled and behavior is forced to User.
//
// mountPreferencesPane builds ONE kit instance (createScopeKit) and uses it at its three call sites
// (Editor's wordWrapRow/formatOnSaveRow via scopedRow, Output's outputScope via makeScopeBinding
// directly, Advanced's traceRow via scopedRow) — those call sites stay in prefs.ts; only the shared
// machinery moved here. This module must not import prefs.ts (no import cycles).
import {
    loadSettings,
    loadWorkspaceOverrides,
    saveWorkspaceOverride,
    effectiveSettings,
    type Settings,
} from "@/settings/persistence";
import { row, segmented } from "@/settings/prefsControls";

type Scope = "user" | "workspace";

/** The four Settings fields that can carry a per-workspace override. */
export type ScopedField =
    | "previewTarget"
    | "formatOnSave"
    | "wordWrap"
    | "lspTrace";

// One scoped row's wiring, registered so syncAll() can re-sync its scope + value on every open.
interface ScopedControl {
    /** Re-read the override store for the current workspace and reflect scope + effective value. */
    sync(s: Settings): void;
}

/** What the kit needs from its host (mountPreferencesPane): the current workspace key, the User-scope
 *  commit path (the moral equivalent of `cb.onChange(patchSettings(patch))`), and the raw onChange used
 *  by the Workspace-scope path and the segmented toggle's own scope-flip handler. */
export interface ScopeKitDeps {
    /** The current workspace key, or null when none is open / the host doesn't scope settings. */
    workspaceKey(): string | null;
    /** Commit a User-scope patch — same shape/behavior as prefs.ts's own `commit(patch)`
     *  (`cb.onChange(patchSettings(patch))`), called here with a single-field patch via `[field]`. */
    commit(patch: Partial<Settings>): void;
    /** Report the merged Settings back to the host — used directly for the Workspace-scope commit path
     *  (`onChange(loadSettings())`) and by the segmented toggle's own scope-flip handler. */
    onChange(s: Settings): void;
}

export interface ScopeKit {
    /**
     * The shared scope-binding for one workspace-scopable field. Builds the User/Workspace segmented
     * toggle, owns this row's scope state, exposes the `scopedCommit` the value control calls on edit,
     * and registers itself so `syncAll()` re-syncs scope + effective value on every open. The value
     * control is supplied via `setValue` (so the binding can reset it on a Workspace→User flip) and
     * `title` names the segmented accessibly ("<title> scope").
     *
     * - User scope (or no workspace): value edits go through `deps.commit` (the global path).
     * - Workspace scope: value edits go through saveWorkspaceOverride; the host is notified with the
     *   UNCHANGED user settings so the global value is never touched (it re-applies effective behavior).
     */
    makeScopeBinding<K extends ScopedField>(
        field: K,
        title: string,
        setValue: (value: Settings[K]) => void,
    ): { seg: HTMLElement; scopedCommit(value: Settings[K]): void };

    /**
     * Build a labelled scoped ROW (label/description on the left; value control + User/Workspace toggle
     * on the right). `makeControl` receives the row's `scopedCommit` to call on every value edit.
     */
    scopedRow<K extends ScopedField>(
        field: K,
        title: string,
        description: string,
        makeControl: (scopedCommit: (value: Settings[K]) => void) => {
            el: HTMLElement;
            set(value: Settings[K]): void;
        },
    ): HTMLElement;

    /** Re-sync every scoped control registered so far from the current Settings — replaces the old
     *  `for (const sc of scopedControls) sc.sync(s);` loop that ran once, at populate() time. */
    syncAll(s: Settings): void;
}

/** Build one scope-kit instance for a preferences pane. Call once per `mountPreferencesPane` and reuse
 *  it at every workspace-scopable field's call site. */
export function createScopeKit(deps: ScopeKitDeps): ScopeKit {
    const scopedControls: ScopedControl[] = [];

    // The current workspace key, or null when none is open / the host doesn't scope settings.
    const wsKey = (): string | null => deps.workspaceKey();

    function makeScopeBinding<K extends ScopedField>(
        field: K,
        title: string,
        setValue: (value: Settings[K]) => void,
    ): { seg: HTMLElement; scopedCommit(value: Settings[K]): void } {
        let scope: Scope = "user";

        function scopedCommit(value: Settings[K]): void {
            const key = wsKey();
            if (scope === "workspace" && key) {
                saveWorkspaceOverride(key, field, value);
                deps.onChange(loadSettings());
            } else {
                deps.commit({ [field]: value } as Partial<Settings>);
            }
        }

        const scopeSeg = segmented<Scope>(
            `${title} scope`,
            [
                { value: "user", label: "User" },
                { value: "workspace", label: "Workspace" },
            ],
            (next) => {
                const key = wsKey();
                if (!key) return; // disabled — nothing to do without a workspace
                if (next === scope) return;
                scope = next;
                if (next === "workspace") {
                    // Make "Workspace" meaningful at once: persist the row's CURRENT value as the override.
                    saveWorkspaceOverride(key, field, loadSettings()[field]);
                } else {
                    // Back to User: clear the override and reset the value control to the user value.
                    saveWorkspaceOverride(key, field, null);
                    setValue(loadSettings()[field]);
                }
                deps.onChange(loadSettings());
            },
        );

        // Reflect "no workspace" unambiguously: disable the toggle's buttons and mark the group, so the
        // control keeps its place in the layout while clearly inert (and the state stays testable).
        function applyEnabled(): void {
            scopeSeg.setDisabled(wsKey() === null);
        }

        scopedControls.push({
            sync(s: Settings): void {
                const key = wsKey();
                const ov = key ? loadWorkspaceOverrides(key) : {};
                scope = key && field in ov ? "workspace" : "user";
                scopeSeg.set(scope);
                // Show the effective value: a Workspace row shows its override, a User row the user value.
                setValue(effectiveSettings(s, key)[field]);
                applyEnabled();
            },
        });

        return { seg: scopeSeg.el, scopedCommit };
    }

    function scopedRow<K extends ScopedField>(
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

        const wrap = document.createElement("div");
        wrap.className = "koi-set-scoped";
        wrap.append(control.el, binding.seg);
        return row(title, description, wrap, control.el);
    }

    function syncAll(s: Settings): void {
        for (const sc of scopedControls) sc.sync(s);
    }

    return { makeScopeBinding, scopedRow, syncAll };
}
