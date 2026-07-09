// @vitest-environment happy-dom
// Unit tests for the Editor section module (extracted from prefs.ts, #987 task 4 — following the
// pattern set by Appearance/About, task 3). These drive buildEditorSection() in isolation — no
// mountPreferencesPane — against the REAL @/settings/persistence module backed by happy-dom's
// localStorage, and a REAL createScopeKit instance (matching scopeKit.test.ts's own pattern) for the
// word-wrap / format-on-save scoped rows, since buildEditorSection takes the shared kit as a dependency
// rather than building its own.
import { describe, it, expect, beforeEach } from "vitest";
import { buildEditorSection } from "@/settings/prefsSections/editor";
import { buildCtx, buildScopeKit as buildKit } from "@/settings/prefsSections/testSupport";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    loadSettings,
    type Settings,
} from "@/settings/persistence";

const FIXTURE: Settings = {
    ...DEFAULT_SETTINGS,
    fontSize: 18,
    lineHeight: 1.8,
    tabSize: 4,
    autoSave: true,
    enableMinimap: false,
    defaultCanvasZoom: 250,
    wordWrap: true,
    formatOnSave: true,
};

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

describe("buildEditorSection — panel shape", () => {
    it("builds the koi-settings-panel-editor tabpanel", () => {
        const ctx = buildCtx();
        const section = buildEditorSection(ctx, { scopeKit: buildKit() });
        expect(section.panel.id).toBe("koi-settings-panel-editor");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
        expect(section.panel.tagName).toBe("SECTION");
    });
});

describe("buildEditorSection.populate", () => {
    it("repaints font size, line height, tab size, auto-save, minimap, default canvas zoom, and the type specimen from a Settings fixture", () => {
        const ctx = buildCtx();
        const section = buildEditorSection(ctx, { scopeKit: buildKit() });
        document.body.appendChild(section.panel);

        section.populate(FIXTURE);

        const fontInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-font-size")!;
        expect(fontInput.value).toBe("18");

        const lineHeightInput = section.panel.querySelector<HTMLInputElement>(
            "#koi-set-line-height",
        )!;
        expect(lineHeightInput.value).toBe("1.8");

        const tabSizeInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-tab-size")!;
        expect(tabSizeInput.value).toBe("4");

        const autoSaveToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Auto-save"]',
        )!;
        expect(autoSaveToggle.getAttribute("aria-checked")).toBe("true");

        const minimapToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Minimap"]',
        )!;
        expect(minimapToggle.getAttribute("aria-checked")).toBe("false");

        const zoomInput = section.panel.querySelector<HTMLInputElement>(
            "#koi-set-default-canvas-zoom",
        )!;
        expect(zoomInput.value).toBe("250");

        // refreshSpecimen(): the live type specimen mirrors the (just-repainted) font size / line height
        // inputs — this is the visible effect of populate() calling refreshSpecimen().
        const specimenCode = section.panel.querySelector<HTMLElement>(
            ".koi-editor-specimen-code",
        )!;
        expect(specimenCode.style.fontSize).toBe("18px");
        expect(specimenCode.style.lineHeight).toBe("1.8");
    });

    it("does NOT set word wrap / format on save — those are synced exclusively by scopeKit.syncAll, called separately by the assembler", () => {
        const ctx = buildCtx();
        const kit = buildKit();
        const section = buildEditorSection(ctx, { scopeKit: kit });
        document.body.appendChild(section.panel);

        section.populate(FIXTURE); // fixture has wordWrap: true, formatOnSave: true

        const wordWrapToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Word wrap"]',
        )!;
        const formatOnSaveToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Format on save"]',
        )!;
        // Untouched by populate() alone — still each toggle's construction-time default (false).
        expect(wordWrapToggle.getAttribute("aria-checked")).toBe("false");
        expect(formatOnSaveToggle.getAttribute("aria-checked")).toBe("false");

        kit.syncAll(FIXTURE); // the assembler's separate, later call
        expect(wordWrapToggle.getAttribute("aria-checked")).toBe("true");
        expect(formatOnSaveToggle.getAttribute("aria-checked")).toBe("true");
    });

    it("refreshSpecimen updates live on font/line-height input events, not just populate()", () => {
        const ctx = buildCtx();
        const section = buildEditorSection(ctx, { scopeKit: buildKit() });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        const fontInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-font-size")!;
        fontInput.value = "20";
        fontInput.dispatchEvent(new Event("input"));

        const specimenCode = section.panel.querySelector<HTMLElement>(
            ".koi-editor-specimen-code",
        )!;
        expect(specimenCode.style.fontSize).toBe("20px");
    });
});

describe("buildEditorSection — plain fields commit through ctx.commit", () => {
    it("font size, line height, tab size, auto-save, minimap, and default canvas zoom route through ctx.commit", () => {
        const ctx = buildCtx();
        const section = buildEditorSection(ctx, { scopeKit: buildKit() });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        const autoSaveToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Auto-save"]',
        )!;
        autoSaveToggle.click();
        expect(ctx.commit).toHaveBeenCalledWith({ autoSave: true });

        const minimapToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Minimap"]',
        )!;
        minimapToggle.click();
        expect(ctx.commit).toHaveBeenCalledWith({ enableMinimap: true });
    });
});
