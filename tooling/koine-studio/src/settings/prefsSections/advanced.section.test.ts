// @vitest-environment happy-dom
// Unit tests for the Advanced section module (extracted from prefs.ts, #987 task 7 — the FINAL section,
// closing out the split). Drives buildAdvancedSection() in isolation — no mountPreferencesPane — against
// the REAL @/settings/persistence module backed by happy-dom's localStorage, matching output.section.
// test.ts's / mcp.section.test.ts's established pattern for these section-module tests.
//
// The Reset button's two-click arm/confirm/disarm state machine is the one piece of genuinely fragile
// transient state this module owns (mirroring keyboard.ts's own arm/disarm care for its chord recorder):
// a first click arms (must NOT call deps.onReset), a second CONFIRMS (must call deps.onReset exactly
// once), and an idle arm auto-disarms after 4s so a stray later click can't silently wipe settings.
//
// prefs.test.ts's own Advanced-panel tests (workspace root, LSP trace scoping, shell args, Reset) already
// cover the full user-facing behavior end-to-end through mountPreferencesPane and must keep passing
// unmodified — these tests are a narrower, module-level pin on the section's own state machine + deps
// wiring in isolation.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { buildAdvancedSection } from "@/settings/prefsSections/advanced";
import { buildCtx, buildScopeKit as buildKit } from "@/settings/prefsSections/testSupport";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    saveKeybindingOverride,
    loadKeybindingOverrides,
    resolveKeybindings,
} from "@/settings/persistence";
import { DEFAULT_BINDINGS } from "@/editor/keybindings";

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

function buildSection(
    overrides: Partial<{
        canSaveProjects: boolean;
        hasIntegratedTerminal: boolean;
        workspaceRootName(): Promise<string | null>;
        pickWorkspaceRoot(): Promise<string | null>;
        onReset(): void;
        onKeybindingsChanged(): void;
    }> = {},
) {
    const ctx = buildCtx();
    const onReset = overrides.onReset ?? vi.fn();
    const onKeybindingsChanged = overrides.onKeybindingsChanged ?? vi.fn();
    const section = buildAdvancedSection(ctx, {
        scopeKit: buildKit(),
        canSaveProjects: overrides.canSaveProjects,
        hasIntegratedTerminal: overrides.hasIntegratedTerminal,
        workspaceRootName: overrides.workspaceRootName,
        pickWorkspaceRoot: overrides.pickWorkspaceRoot,
        onReset,
        onKeybindingsChanged,
    });
    return { ctx, section, onReset, onKeybindingsChanged };
}

const resetBtnOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(".koi-set-danger")!;
const wsRootRowOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLElement>(".koi-mcp-control")!.closest<HTMLElement>(
        ".koi-set-row",
    )!;

// The raw keybindings.json editor (#434): an editable CodeMirror view driven the same way
// settingsPage.test.tsx drives its own editable JSON view — EditorView.findFromDOM + dispatch, the
// exact path a real keystroke takes (no test-only back door).
const kbdJsonTextOf = (panel: HTMLElement): string =>
    EditorView.findFromDOM(
        panel.querySelector(".koi-kbdjson-editor .cm-editor") as HTMLElement,
    )!.state.doc.toString();
const typeKbdJson = (panel: HTMLElement, text: string): void => {
    const view = EditorView.findFromDOM(
        panel.querySelector(".koi-kbdjson-editor .cm-editor") as HTMLElement,
    )!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};
const kbdJsonApplyOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(".koi-kbdjson-apply")!;
const kbdJsonRevertOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(".koi-kbdjson-revert")!;
const kbdJsonErrorOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLElement>(".koi-kbdjson-error")!;

describe("buildAdvancedSection — panel shape", () => {
    it("builds the koi-settings-panel-advanced tabpanel", () => {
        const { section } = buildSection();
        expect(section.panel.id).toBe("koi-settings-panel-advanced");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
        expect(section.panel.tagName).toBe("SECTION");
    });
});

describe("buildAdvancedSection — workspace root row visibility", () => {
    it("is hidden when deps.canSaveProjects is omitted", () => {
        const { section } = buildSection();
        expect(wsRootRowOf(section.panel).hidden).toBe(true);
    });

    it("is hidden when deps.canSaveProjects is false", () => {
        const { section } = buildSection({ canSaveProjects: false });
        expect(wsRootRowOf(section.panel).hidden).toBe(true);
    });

    it("is shown when deps.canSaveProjects is true", () => {
        const { section } = buildSection({ canSaveProjects: true });
        expect(wsRootRowOf(section.panel).hidden).toBe(false);
    });
});

describe("buildAdvancedSection — Reset two-click arm/confirm state machine", () => {
    it("a first click arms the button but does NOT call deps.onReset", () => {
        const { section, onReset } = buildSection();
        document.body.appendChild(section.panel);
        const btn = resetBtnOf(section.panel);

        btn.click();

        expect(onReset).not.toHaveBeenCalled();
        expect(btn.classList.contains("is-armed")).toBe(true);
        expect(btn.textContent).toBe("Click again to reset everything");
    });

    it("a second (confirming) click calls deps.onReset exactly once and disarms", () => {
        const { section, onReset } = buildSection();
        document.body.appendChild(section.panel);
        const btn = resetBtnOf(section.panel);

        btn.click(); // arm
        btn.click(); // confirm

        expect(onReset).toHaveBeenCalledTimes(1);
        expect(btn.classList.contains("is-armed")).toBe(false);
        expect(btn.textContent).toBe("Reset to defaults");
    });

    it("auto-disarms 4s after arming, so a later click arms again instead of confirming", () => {
        vi.useFakeTimers();
        try {
            const { section, onReset } = buildSection();
            document.body.appendChild(section.panel);
            const btn = resetBtnOf(section.panel);

            btn.click(); // arm
            expect(btn.classList.contains("is-armed")).toBe(true);

            vi.advanceTimersByTime(4000);

            expect(btn.classList.contains("is-armed")).toBe(false);
            expect(btn.textContent).toBe("Reset to defaults");
            expect(onReset).not.toHaveBeenCalled();

            // A subsequent click after the auto-disarm arms again rather than confirming.
            btn.click();
            expect(onReset).not.toHaveBeenCalled();
            expect(btn.classList.contains("is-armed")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("section.disarmReset() cancels an armed button without calling deps.onReset", () => {
        const { section, onReset } = buildSection();
        document.body.appendChild(section.panel);
        const btn = resetBtnOf(section.panel);

        btn.click(); // arm
        section.disarmReset();

        expect(btn.classList.contains("is-armed")).toBe(false);
        expect(btn.textContent).toBe("Reset to defaults");
        expect(onReset).not.toHaveBeenCalled();
    });
});

describe("buildAdvancedSection.destroy", () => {
    it("clears the pending disarm timer so it never fires after teardown", () => {
        vi.useFakeTimers();
        try {
            const { section, onReset } = buildSection();
            document.body.appendChild(section.panel);
            const btn = resetBtnOf(section.panel);

            btn.click(); // arm — schedules the 4s auto-disarm timer
            section.destroy();

            // Advancing time past the original timeout must not throw or call onReset — the timer was
            // cleared by destroy(), not merely fired harmlessly.
            expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
            expect(onReset).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("clears the timer via clearTimeout — spy confirms destroy() actually cancels it", () => {
        const { section } = buildSection();
        document.body.appendChild(section.panel);
        const btn = resetBtnOf(section.panel);

        btn.click(); // arm — schedules the disarm timer

        const clearSpy = vi.spyOn(globalThis, "clearTimeout");
        section.destroy();

        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });
});

describe("buildAdvancedSection.populate", () => {
    it("repaints the shell-args chip list from Settings.terminalShellArgs", () => {
        const { section } = buildSection({ hasIntegratedTerminal: true });
        document.body.appendChild(section.panel);

        section.populate({
            ...DEFAULT_SETTINGS,
            terminalShellArgs: ["-l", "-i"],
        });

        const chips = section.panel.querySelectorAll(".koi-chip");
        const texts = Array.from(chips).map(
            (c) => c.querySelector("span")!.textContent,
        );
        expect(texts).toEqual(["-l", "-i"]);
    });
});

describe("buildAdvancedSection — terminal shell args visibility", () => {
    it("is hidden when deps.hasIntegratedTerminal is omitted", () => {
        const { section } = buildSection();
        const row = section.panel
            .querySelector(".koi-string-list")
            ?.closest<HTMLElement>(".koi-set-row");
        expect(row?.hidden).toBe(true);
    });

    it("is shown when deps.hasIntegratedTerminal is true", () => {
        const { section } = buildSection({ hasIntegratedTerminal: true });
        const row = section.panel
            .querySelector(".koi-string-list")
            ?.closest<HTMLElement>(".koi-set-row");
        expect(row?.hidden).toBe(false);
    });
});

describe("buildAdvancedSection.refreshWsRootValue", () => {
    it("no-ops when canSaveProjects is false", async () => {
        const workspaceRootName = vi.fn(async () => "should-not-be-called");
        const { section } = buildSection({
            canSaveProjects: false,
            workspaceRootName,
        });
        await section.refreshWsRootValue();
        expect(workspaceRootName).not.toHaveBeenCalled();
    });

    it("sets the display value from deps.workspaceRootName() when canSaveProjects is true", async () => {
        const workspaceRootName = vi.fn(async () => "my-project");
        const { section } = buildSection({
            canSaveProjects: true,
            workspaceRootName,
        });
        document.body.appendChild(section.panel);
        await section.refreshWsRootValue();
        expect(workspaceRootName).toHaveBeenCalledTimes(1);
        const value = section.panel.querySelector(".koi-mcp-control .koi-set-label");
        expect(value?.textContent).toBe("my-project");
    });
});

// The raw keybindings.json editor (#434): a power-user escape hatch that round-trips with the
// graphical Keyboard recorder — both read/write the same koine.studio.keybindings override blob.
// populate() seeds the view from loadKeybindingOverrides(); Apply validates via
// parseKeybindingOverrides and, on success, fully REPLACES the override store (clear + re-apply each
// entry) so a removed key's override is also dropped, not just merged.
describe("buildAdvancedSection — raw keybindings.json editor", () => {
    it("populate() seeds the editor from the current overrides, formatted", () => {
        saveKeybindingOverride("format", "Ctrl-d");
        const { section } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });
        expect(JSON.parse(kbdJsonTextOf(section.panel))).toEqual({ format: "Ctrl-d" });
    });

    it("Apply on a valid edited blob persists it and fires onKeybindingsChanged", () => {
        const { section, onKeybindingsChanged } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });

        typeKbdJson(section.panel, '{"format": "Ctrl-d"}');
        kbdJsonApplyOf(section.panel).click();

        expect(loadKeybindingOverrides()).toEqual({ format: "Ctrl-d" });
        expect(resolveKeybindings().format).toBe("Ctrl-d");
        expect(onKeybindingsChanged).toHaveBeenCalledTimes(1);
        expect(kbdJsonErrorOf(section.panel).hidden).toBe(true);
    });

    it("Apply fully replaces the store: a key dropped from the edited JSON loses its override too", () => {
        saveKeybindingOverride("format", "Ctrl-d");
        saveKeybindingOverride("rename", "Ctrl-r");
        const { section } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });

        typeKbdJson(section.panel, '{"format": "Ctrl-d"}'); // rename dropped
        kbdJsonApplyOf(section.panel).click();

        expect(loadKeybindingOverrides()).toEqual({ format: "Ctrl-d" });
    });

    it("Apply with {} clears every override (equivalent to Reset all)", () => {
        saveKeybindingOverride("rename", "Ctrl-r");
        const { section, onKeybindingsChanged } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });

        typeKbdJson(section.panel, "{}");
        kbdJsonApplyOf(section.panel).click();

        expect(loadKeybindingOverrides()).toEqual({});
        expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
        expect(onKeybindingsChanged).toHaveBeenCalledTimes(1);
    });

    it("Apply on malformed JSON writes nothing, shows the error, and does not fire onKeybindingsChanged", () => {
        saveKeybindingOverride("format", "Ctrl-d");
        const { section, onKeybindingsChanged } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });

        typeKbdJson(section.panel, "not json{");
        kbdJsonApplyOf(section.panel).click();

        expect(loadKeybindingOverrides()).toEqual({ format: "Ctrl-d" }); // unchanged
        expect(onKeybindingsChanged).not.toHaveBeenCalled();
        expect(kbdJsonErrorOf(section.panel).hidden).toBe(false);
        expect(kbdJsonErrorOf(section.panel).textContent).toMatch(/json/i);
    });

    it("Apply on an unknown command id writes nothing and names the offending id in the error", () => {
        const { section, onKeybindingsChanged } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });

        typeKbdJson(section.panel, '{"bogusCommand": "Ctrl-x"}');
        kbdJsonApplyOf(section.panel).click();

        expect(loadKeybindingOverrides()).toEqual({});
        expect(onKeybindingsChanged).not.toHaveBeenCalled();
        expect(kbdJsonErrorOf(section.panel).textContent).toContain("bogusCommand");
    });

    it("Revert discards unsaved edits and reloads the last-persisted overrides", () => {
        saveKeybindingOverride("format", "Ctrl-d");
        const { section, onKeybindingsChanged } = buildSection();
        document.body.appendChild(section.panel);
        section.populate({ ...DEFAULT_SETTINGS });

        typeKbdJson(section.panel, "garbage, not json");
        kbdJsonRevertOf(section.panel).click();

        expect(JSON.parse(kbdJsonTextOf(section.panel))).toEqual({ format: "Ctrl-d" });
        expect(kbdJsonErrorOf(section.panel).hidden).toBe(true);
        expect(onKeybindingsChanged).not.toHaveBeenCalled(); // Revert never persists or live-applies
    });
});
