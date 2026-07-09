// @vitest-environment happy-dom
// Unit tests for the per-workspace scope kit (extracted from prefs.ts, #987 task 2). These drive
// createScopeKit() in isolation — no mountPreferencesPane — exercising it the same way prefs.ts's three
// call sites do (scopedRow for a toggle-backed field, makeScopeBinding directly for the Output picker):
// against the REAL @/settings/persistence module backed by happy-dom's localStorage, matching the pattern
// prefs.test.ts's "Settings → User/Workspace scope toggle" describe block already uses (no mocking of
// persistence — saveSettings/loadSettings/loadWorkspaceOverrides are exercised for real).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createScopeKit } from "@/settings/prefsSections/scopeKit";
import { toggle } from "@/settings/prefsControls";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    loadSettings,
    loadWorkspaceOverrides,
    saveWorkspaceOverride,
    workspaceKeyOf,
    type Settings,
} from "@/settings/persistence";

const ROOTS = ["/Users/me/projects/billing"];
const KEY = workspaceKeyOf(ROOTS);

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

// Build a scopedRow-style "Word wrap" control the same way prefs.ts's wordWrapRow does: a role=switch
// toggle wired through the row's scopedCommit.
function buildWordWrapRow(
    kit: ReturnType<typeof createScopeKit>,
): HTMLElement {
    return kit.scopedRow(
        "wordWrap",
        "Word wrap",
        "Wrap long lines instead of scrolling sideways.",
        (scopedCommit) => toggle("Word wrap", (on) => scopedCommit(on)),
    );
}

const scopeGroup = (label: string) =>
    document.querySelector<HTMLElement>(`.koi-segmented[aria-label="${label}"]`)!;
const scopeBtn = (label: string, value: "user" | "workspace") =>
    scopeGroup(label).querySelector<HTMLButtonElement>(
        `.koi-seg[data-value="${value}"]`,
    )!;
const wordWrapToggle = () =>
    document.querySelector<HTMLButtonElement>('.koi-switch[aria-label="Word wrap"]')!;
const WORD_WRAP_SCOPE = "Word wrap scope";

describe("createScopeKit — null workspaceKey (no workspace open)", () => {
    it("builds the scope toggle disabled and routes value commits through deps.commit, never saveWorkspaceOverride", () => {
        const commit = vi.fn((patch: Partial<Settings>) => {
            saveSettings({ ...loadSettings(), ...patch });
        });
        const onChange = vi.fn();
        const kit = createScopeKit({
            workspaceKey: () => null,
            commit,
            onChange,
        });
        const rowEl = buildWordWrapRow(kit);
        document.body.appendChild(rowEl);
        kit.syncAll(loadSettings());

        const group = scopeGroup(WORD_WRAP_SCOPE);
        expect(group.getAttribute("aria-disabled")).toBe("true");
        for (const b of group.querySelectorAll<HTMLButtonElement>(".koi-seg")) {
            expect(b.disabled).toBe(true);
        }

        wordWrapToggle().click();
        expect(commit).toHaveBeenCalledWith({ wordWrap: true });
        expect(loadSettings().wordWrap).toBe(true);
        expect(loadWorkspaceOverrides(KEY)).not.toHaveProperty("wordWrap");
    });
});

describe("createScopeKit — non-null workspaceKey", () => {
    it("flipping the segmented toggle to Workspace persists the row's CURRENT value via saveWorkspaceOverride", () => {
        saveSettings({ ...DEFAULT_SETTINGS, wordWrap: false });
        const commit = vi.fn();
        const onChange = vi.fn();
        const kit = createScopeKit({
            workspaceKey: () => KEY,
            commit,
            onChange,
        });
        const rowEl = buildWordWrapRow(kit);
        document.body.appendChild(rowEl);
        kit.syncAll(loadSettings());

        scopeBtn(WORD_WRAP_SCOPE, "workspace").click();

        expect(loadWorkspaceOverrides(KEY)).toHaveProperty("wordWrap", false);
        expect(loadSettings().wordWrap).toBe(false); // user value untouched
        expect(
            scopeBtn(WORD_WRAP_SCOPE, "workspace").getAttribute("aria-checked"),
        ).toBe("true");
        expect(onChange).toHaveBeenCalled();
    });

    it("syncAll(s) reflects the effective (override) value when scope is Workspace", () => {
        saveSettings({ ...DEFAULT_SETTINGS, wordWrap: false });
        const commit = vi.fn();
        const onChange = vi.fn();
        const kit = createScopeKit({
            workspaceKey: () => KEY,
            commit,
            onChange,
        });
        const rowEl = buildWordWrapRow(kit);
        document.body.appendChild(rowEl);
        kit.syncAll(loadSettings());

        // Move to Workspace scope, then flip the value control — the override becomes true while the
        // user setting stays false.
        scopeBtn(WORD_WRAP_SCOPE, "workspace").click();
        wordWrapToggle().click();
        expect(loadWorkspaceOverrides(KEY)).toHaveProperty("wordWrap", true);
        expect(loadSettings().wordWrap).toBe(false);
        expect(wordWrapToggle().getAttribute("aria-checked")).toBe("true");

        // Change the override directly in the store (as if another tab/reopen changed it), bypassing the
        // control entirely — a fresh syncAll (e.g. a pane reopen) must pick up the EFFECTIVE (override)
        // value from the store, not any value cached in the control.
        saveWorkspaceOverride(KEY, "wordWrap", false);
        expect(wordWrapToggle().getAttribute("aria-checked")).toBe("true"); // stale until syncAll runs
        kit.syncAll(loadSettings());
        expect(wordWrapToggle().getAttribute("aria-checked")).toBe("false");
        expect(
            scopeBtn(WORD_WRAP_SCOPE, "workspace").getAttribute("aria-checked"),
        ).toBe("true");
    });

    it("flipping back to User clears the override and resets the value control to the user value", () => {
        saveSettings({ ...DEFAULT_SETTINGS, wordWrap: true });
        const commit = vi.fn();
        const onChange = vi.fn();
        const kit = createScopeKit({
            workspaceKey: () => KEY,
            commit,
            onChange,
        });
        const rowEl = buildWordWrapRow(kit);
        document.body.appendChild(rowEl);
        kit.syncAll(loadSettings());

        scopeBtn(WORD_WRAP_SCOPE, "workspace").click();
        wordWrapToggle().click(); // override -> false
        expect(loadWorkspaceOverrides(KEY)).toHaveProperty("wordWrap", false);

        scopeBtn(WORD_WRAP_SCOPE, "user").click();
        expect(loadWorkspaceOverrides(KEY)).not.toHaveProperty("wordWrap");
        expect(loadSettings().wordWrap).toBe(true); // user value never moved
        expect(wordWrapToggle().getAttribute("aria-checked")).toBe("true");
    });
});

describe("createScopeKit.makeScopeBinding used directly (e.g. Output language)", () => {
    it("exposes seg + scopedCommit without a wrapping row, for a heading-row layout", () => {
        const commit = vi.fn((patch: Partial<Settings>) => {
            saveSettings({ ...loadSettings(), ...patch });
        });
        const onChange = vi.fn();
        const kit = createScopeKit({
            workspaceKey: () => null,
            commit,
            onChange,
        });
        let current: Settings["previewTarget"] | null = null;
        const binding = kit.makeScopeBinding(
            "previewTarget",
            "Output language",
            (v) => (current = v),
        );
        document.body.appendChild(binding.seg);
        kit.syncAll(loadSettings());

        // syncAll drove setValue with the effective (here: user, since no workspace) value.
        expect(current).toBe(loadSettings().previewTarget);
        expect(
            document
                .querySelector<HTMLElement>('.koi-segmented[aria-label="Output language scope"]')!
                .getAttribute("aria-disabled"),
        ).toBe("true");

        binding.scopedCommit("typescript");
        expect(commit).toHaveBeenCalledWith({ previewTarget: "typescript" });
    });
});
