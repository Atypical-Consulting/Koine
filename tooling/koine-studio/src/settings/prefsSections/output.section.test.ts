// @vitest-environment happy-dom
// Unit tests for the Output section module (extracted from prefs.ts, #987 task 4 — following the
// pattern set by Appearance/About, task 3). These drive buildOutputSection() in isolation — no
// mountPreferencesPane — against the REAL @/settings/persistence module backed by happy-dom's
// localStorage, and a REAL createScopeKit instance (matching scopeKit.test.ts's own
// "makeScopeBinding used directly" case) for the previewTarget scoped binding, since buildOutputSection
// takes the shared kit as a dependency rather than building its own.
//
// EMIT_TARGETS is a live, module-level MUTABLE array (@/shared/emitTargets — replaced in place by
// setEmitTargets, issue #282), not something the codebase mocks (see prefs.test.ts's own "Settings →
// Output panel" describe block, which reads BUILTIN_EMIT_TARGETS directly with no vi.mock). So the
// populate()-refreshes-the-picker pin below mutates EMIT_TARGETS for real via setEmitTargets and
// restores it afterward.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildOutputSection } from "@/settings/prefsSections/output";
import { buildScopeKit as buildKit } from "@/settings/prefsSections/testSupport";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    loadSettings,
    type Settings,
} from "@/settings/persistence";
import {
    BUILTIN_EMIT_TARGETS,
    setEmitTargets,
    type EmitTarget,
} from "@/shared/emitTargets";

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

afterEach(() => {
    setEmitTargets(BUILTIN_EMIT_TARGETS); // undo any test's seeding so later files see the built-ins
});

const langOptsIn = (panel: HTMLElement) => [
    ...panel.querySelectorAll<HTMLButtonElement>(".koi-lang-opt"),
];

describe("buildOutputSection — panel shape", () => {
    it("builds the koi-settings-panel-output tabpanel", () => {
        const section = buildOutputSection({ scopeKit: buildKit() });
        expect(section.panel.id).toBe("koi-settings-panel-output");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
        expect(section.panel.tagName).toBe("SECTION");
    });

    it("renders one language card per built-in emit target", () => {
        const section = buildOutputSection({ scopeKit: buildKit() });
        expect(langOptsIn(section.panel).map((b) => b.dataset.value)).toEqual(
            BUILTIN_EMIT_TARGETS.map((t) => t.id),
        );
    });
});

describe("buildOutputSection.populate — issue #282", () => {
    it("calls outputLang.refresh() so a target added to EMIT_TARGETS AFTER construction appears once populate() runs", () => {
        const section = buildOutputSection({ scopeKit: buildKit() });
        document.body.appendChild(section.panel);

        // Not present yet: the picker was built (and rendered its cards) before this target existed.
        expect(
            langOptsIn(section.panel).some((b) => b.dataset.value === "go"),
        ).toBe(false);

        const GO: EmitTarget = { id: "go", displayName: "Go", fileExtension: ".go" };
        setEmitTargets([...BUILTIN_EMIT_TARGETS, GO]);

        section.populate(loadSettings());

        expect(
            langOptsIn(section.panel).some((b) => b.dataset.value === "go"),
        ).toBe(true);
    });
});

describe("buildOutputSection — previewTarget routes through the shared ScopeKit", () => {
    it("selecting a language calls scopeKit's commit path with previewTarget", () => {
        const kitCommit = vi.fn((patch: Partial<Settings>) => {
            saveSettings({ ...loadSettings(), ...patch });
        });
        const section = buildOutputSection({
            scopeKit: buildKit({ commit: kitCommit }),
        });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        langOptsIn(section.panel)
            .find((b) => b.dataset.value === "python")!
            .click();

        expect(kitCommit).toHaveBeenCalledWith({ previewTarget: "python" });
        expect(loadSettings().previewTarget).toBe("python");
    });
});
