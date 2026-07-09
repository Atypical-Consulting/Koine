// @vitest-environment happy-dom
// Unit tests for the Assistant section module (extracted from prefs.ts, #987 task 6). Drives
// buildAssistantSection() in isolation — no mountPreferencesPane — against the REAL
// @/settings/persistence module backed by happy-dom's localStorage, matching output.section.test.ts's
// established pattern for these section-module tests.
import { describe, it, expect, beforeEach } from "vitest";
import { buildAssistantSection } from "@/settings/prefsSections/assistant";
import { buildCtx } from "@/settings/prefsSections/testSupport";
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

const toolsToggle = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(
        '.koi-switch[aria-label="Compiler tools"]',
    )!;
const grammarToggle = (panel: HTMLElement) =>
    panel.querySelector<HTMLButtonElement>(
        '.koi-switch[aria-label="Constrain AI output to the Koine grammar"]',
    )!;

describe("buildAssistantSection — panel shape", () => {
    it("builds the koi-settings-panel-assistant tabpanel", () => {
        const ctx = buildCtx();
        const section = buildAssistantSection(ctx);
        expect(section.panel.id).toBe("koi-settings-panel-assistant");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
    });
});

// #447: mirrors prefs.test.ts's "Settings → Assistant: Compiler-tools / grammar mutual exclusion"
// legacy-both-on case, pinned again here at the section-module level so the normalization can't silently
// regress if this module's populate() drifts from what prefs.ts's inline code used to do.
describe("buildAssistantSection.populate — #447 mutual exclusion normalization", () => {
    it("normalizes a legacy both-on state to grammar-wins (tools off) and persists the correction", () => {
        saveSettings({
            ...DEFAULT_SETTINGS,
            aiAgenticTools: true,
            aiConstrainGrammar: true,
        });
        const ctx = buildCtx();
        const section = buildAssistantSection(ctx);
        document.body.appendChild(section.panel);

        section.populate(loadSettings());

        expect(
            grammarToggle(section.panel).getAttribute("aria-checked"),
        ).toBe("true");
        expect(toolsToggle(section.panel).getAttribute("aria-checked")).toBe(
            "false",
        );
        expect(toolsToggle(section.panel).disabled).toBe(true); // greyed by syncAiExclusivity()
        // The correction is persisted (via the raw patchSettings import), not just reflected in the DOM.
        expect(loadSettings().aiAgenticTools).toBe(false);
        expect(loadSettings().aiConstrainGrammar).toBe(true);
    });

    it("leaves a legal state (only one of the two on) untouched", () => {
        saveSettings({
            ...DEFAULT_SETTINGS,
            aiAgenticTools: true,
            aiConstrainGrammar: false,
        });
        const ctx = buildCtx();
        const section = buildAssistantSection(ctx);
        document.body.appendChild(section.panel);

        section.populate(loadSettings());

        expect(toolsToggle(section.panel).getAttribute("aria-checked")).toBe(
            "true",
        );
        expect(loadSettings().aiAgenticTools).toBe(true);
        expect(loadSettings().aiConstrainGrammar).toBe(false);
    });
});

describe("buildAssistantSection — provider switch reports via ctx.onChange", () => {
    it("switching provider reads back patchSettings' merged Settings (not ctx.commit) and reports it", () => {
        const ctx = buildCtx();
        const section = buildAssistantSection(ctx);
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        const providerSelect =
            section.panel.querySelector<HTMLSelectElement>(".koi-select")!;
        providerSelect.value = "openai";
        providerSelect.dispatchEvent(new Event("change"));

        expect(loadSettings().aiProvider).toBe("openai");
        expect(ctx.onChange).toHaveBeenCalled();
        const last = ctx.onChange.mock.calls.at(-1)![0] as Settings;
        expect(last.aiProvider).toBe("openai");
    });
});
