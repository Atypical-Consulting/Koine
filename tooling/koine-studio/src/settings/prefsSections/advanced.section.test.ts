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
import { buildAdvancedSection } from "@/settings/prefsSections/advanced";
import { createScopeKit } from "@/settings/prefsSections/scopeKit";
import type { SectionCtx } from "@/settings/prefsSections/types";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    loadSettings,
    type Settings,
} from "@/settings/persistence";

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

function buildCtx(): SectionCtx & {
    commit: ReturnType<typeof vi.fn>;
    onChange: ReturnType<typeof vi.fn>;
} {
    const commit = vi.fn((patch: Partial<Settings>) => {
        saveSettings({ ...loadSettings(), ...patch });
    });
    const onChange = vi.fn();
    return { commit, onChange };
}

// The shared ScopeKit instance buildAdvancedSection takes as a dependency (#987 task 2), built the same
// way mountPreferencesPane builds its one instance.
function buildKit() {
    return createScopeKit({
        workspaceKey: () => null,
        commit: (patch: Partial<Settings>) =>
            saveSettings({ ...loadSettings(), ...patch }),
        onChange: () => {},
    });
}

function buildSection(
    overrides: Partial<{
        canSaveProjects: boolean;
        hasIntegratedTerminal: boolean;
        workspaceRootName(): Promise<string | null>;
        pickWorkspaceRoot(): Promise<string | null>;
        onReset(): void;
    }> = {},
) {
    const ctx = buildCtx();
    const onReset = overrides.onReset ?? vi.fn();
    const section = buildAdvancedSection(ctx, {
        scopeKit: buildKit(),
        canSaveProjects: overrides.canSaveProjects,
        hasIntegratedTerminal: overrides.hasIntegratedTerminal,
        workspaceRootName: overrides.workspaceRootName,
        pickWorkspaceRoot: overrides.pickWorkspaceRoot,
        onReset,
    });
    return { ctx, section, onReset };
}

const resetBtnOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(".koi-set-danger")!;
const wsRootRowOf = (panel: HTMLElement) =>
    panel.querySelector<HTMLElement>(".koi-mcp-control")!.closest<HTMLElement>(
        ".koi-set-row",
    )!;

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
