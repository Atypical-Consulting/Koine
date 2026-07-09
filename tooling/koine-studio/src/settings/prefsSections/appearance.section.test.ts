// @vitest-environment happy-dom
// Unit tests for the Appearance section module (extracted from prefs.ts, #987 task 3 — the first
// section module, setting the pattern later tasks copy). These drive buildAppearanceSection() in
// isolation — no mountPreferencesPane — against the REAL @/settings/persistence + @/settings/theme
// modules backed by happy-dom's localStorage, matching the pattern scopeKit.test.ts already uses (no
// mocking of persistence).
import { describe, it, expect, beforeEach } from "vitest";
import { buildAppearanceSection } from "@/settings/prefsSections/appearance";
import { buildCtx } from "@/settings/prefsSections/testSupport";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    loadSettings,
    type Settings,
} from "@/settings/persistence";

const FIXTURE: Settings = {
    ...DEFAULT_SETTINGS,
    theme: "light",
    accent: "violet",
    reduceMotion: true,
    displayName: "Ada Lovelace",
    fontFamily: "Fira Code",
    startupView: "lastWorkspace",
};

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

describe("buildAppearanceSection — panel shape", () => {
    it("builds the koi-settings-panel-appearance tabpanel", () => {
        const ctx = buildCtx();
        const section = buildAppearanceSection(ctx);
        expect(section.panel.id).toBe("koi-settings-panel-appearance");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
        expect(section.panel.tagName).toBe("SECTION");
    });
});

describe("buildAppearanceSection.populate", () => {
    it("repaints theme, accent, reduce motion, display name, editor font, and on-startup from a Settings fixture", () => {
        const ctx = buildCtx();
        const section = buildAppearanceSection(ctx);
        document.body.appendChild(section.panel);

        section.populate(FIXTURE);

        const themeLight = section.panel.querySelector<HTMLButtonElement>(
            '.koi-segmented[aria-label="Theme"] .koi-seg[data-value="light"]',
        )!;
        const themeDark = section.panel.querySelector<HTMLButtonElement>(
            '.koi-segmented[aria-label="Theme"] .koi-seg[data-value="dark"]',
        )!;
        expect(themeLight.getAttribute("aria-checked")).toBe("true");
        expect(themeDark.getAttribute("aria-checked")).toBe("false");

        const accentViolet = section.panel.querySelector<HTMLButtonElement>(
            '.koi-accent-row .koi-accent-swatch[data-value="violet"]',
        )!;
        expect(accentViolet.getAttribute("aria-checked")).toBe("true");

        const reduceMotionToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Reduce motion"]',
        )!;
        expect(reduceMotionToggle.getAttribute("aria-checked")).toBe("true");

        const displayNameInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-display-name")!;
        expect(displayNameInput.value).toBe("Ada Lovelace");

        const fontFamilyInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-editor-font")!;
        expect(fontFamilyInput.value).toBe("Fira Code");

        const startupSelect =
            section.panel.querySelector<HTMLSelectElement>("#koi-set-on-startup")!;
        expect(startupSelect.value).toBe("lastWorkspace");
    });
});

describe("buildAppearanceSection — Theme's special commit path", () => {
    it("selecting a theme persists + applies live via setTheme and reports through ctx.onChange, NOT ctx.commit", () => {
        saveSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
        const ctx = buildCtx();
        const section = buildAppearanceSection(ctx);
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        const themeLightBtn = section.panel.querySelector<HTMLButtonElement>(
            '.koi-segmented[aria-label="Theme"] .koi-seg[data-value="light"]',
        )!;
        themeLightBtn.click();

        expect(loadSettings().theme).toBe("light"); // persisted via setTheme, not ctx.commit
        expect(document.documentElement.dataset.theme).toBe("light"); // applied live
        expect(ctx.commit).not.toHaveBeenCalled();
        expect(ctx.onChange).toHaveBeenCalledTimes(1);
        expect(ctx.onChange.mock.calls[0]![0].theme).toBe("light");
    });
});

describe("buildAppearanceSection — other fields commit through ctx.commit", () => {
    it("accent, reduce motion, display name, editor font, and on-startup route through ctx.commit", () => {
        const ctx = buildCtx();
        const section = buildAppearanceSection(ctx);
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        const accentBtn = section.panel.querySelector<HTMLButtonElement>(
            '.koi-accent-row .koi-accent-swatch[data-value="teal"]',
        )!;
        accentBtn.click();
        expect(ctx.commit).toHaveBeenCalledWith({ accent: "teal" });

        const reduceMotionToggle = section.panel.querySelector<HTMLButtonElement>(
            '.koi-switch[aria-label="Reduce motion"]',
        )!;
        reduceMotionToggle.click();
        expect(ctx.commit).toHaveBeenCalledWith({ reduceMotion: true });

        const displayNameInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-display-name")!;
        displayNameInput.value = "  Grace Hopper  ";
        displayNameInput.dispatchEvent(new Event("change"));
        expect(ctx.commit).toHaveBeenCalledWith({ displayName: "Grace Hopper" });

        const fontFamilyInput =
            section.panel.querySelector<HTMLInputElement>("#koi-set-editor-font")!;
        fontFamilyInput.value = "  Fira Code  ";
        fontFamilyInput.dispatchEvent(new Event("change"));
        expect(ctx.commit).toHaveBeenCalledWith({ fontFamily: "Fira Code" });

        const startupSelect =
            section.panel.querySelector<HTMLSelectElement>("#koi-set-on-startup")!;
        startupSelect.value = "lastWorkspace";
        startupSelect.dispatchEvent(new Event("change"));
        expect(ctx.commit).toHaveBeenCalledWith({ startupView: "lastWorkspace" });

        expect(ctx.onChange).not.toHaveBeenCalled(); // only Theme reports via onChange
    });
});
