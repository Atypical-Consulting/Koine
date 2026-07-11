// @vitest-environment happy-dom
// Unit tests for the Keyboard section module (extracted from prefs.ts, #987 task 5 — the chord recorder
// moves whole). This is the MOST DELICATE section: it owns the one genuinely fragile piece of transient
// state in prefs.ts — a document-level capture-phase keydown listener, armed while a row records a new
// chord. These tests drive buildKeyboardSection() in isolation (no mountPreferencesPane) against the REAL
// @/settings/persistence module (happy-dom localStorage), and specifically pin the arm/disarm pairing: a
// bug here leaks a listener that swallows every keystroke on the page.
//
// prefs.test.ts's "keyboard settings" describe block already covers the full user-facing behavior
// (conflict prompts, Reset, Reset all, suspend) end-to-end through mountPreferencesPane and must keep
// passing unmodified — these tests are a narrower, module-level pin on the listener lifecycle itself.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildKeyboardSection } from "@/settings/prefsSections/keyboard";
import {
    DEFAULT_SETTINGS,
    saveSettings,
    loadSettings,
    loadKeybindingOverrides,
    resolveKeybindings,
    saveKeybindingOverride,
} from "@/settings/persistence";
import { DEFAULT_BINDINGS } from "@/editor/keybindings";

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    saveSettings({ ...DEFAULT_SETTINGS });
});

// A test that leaves a row armed would leak its document-level keydown listener into the next test —
// mirror prefs.test.ts's own afterEach guard.
afterEach(() => {
    document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
});

function recordBtn(panel: HTMLElement, id: string): HTMLButtonElement {
    return panel.querySelector<HTMLButtonElement>(
        `.koi-kbd-row[data-binding-id="${id}"] .koi-kbd-record`,
    )!;
}

describe("buildKeyboardSection — panel shape", () => {
    it("builds the koi-settings-panel-keyboard tabpanel with one row per rebindable command plus Reset all", () => {
        const section = buildKeyboardSection({});
        expect(section.panel.id).toBe("koi-settings-panel-keyboard");
        expect(section.panel.getAttribute("role")).toBe("tabpanel");
        expect(section.panel.tagName).toBe("SECTION");
        expect(
            section.panel.querySelectorAll(".koi-kbd-row").length,
        ).toBeGreaterThan(0);
        expect(
            section.panel.querySelector(".koi-kbd-reset-all"),
        ).not.toBeNull();
    });

    it("groups rows by scope under Editor / Global subheadings (#432)", () => {
        const section = buildKeyboardSection({});
        const subheads = [
            ...section.panel.querySelectorAll<HTMLElement>(".koi-kbd-subhead"),
        ].map((h) => h.textContent);
        expect(subheads).toEqual(["Editor", "Global"]);

        // The editor group carries call-hierarchy (folded in by #432); the global group carries the
        // command palette + save-all.
        expect(
            section.panel.querySelector(
                '.koi-kbd-row[data-binding-id="callHierarchy"]',
            ),
        ).not.toBeNull();
        expect(
            section.panel.querySelector(
                '.koi-kbd-row[data-binding-id="commandPalette"]',
            ),
        ).not.toBeNull();
        expect(
            section.panel.querySelector(
                '.koi-kbd-row[data-binding-id="saveAll"]',
            ),
        ).not.toBeNull();

        // The Global heading sits AFTER every editor row and BEFORE the global rows (document order).
        const kids = [...section.panel.children];
        const globalHeadIdx = kids.findIndex((n) => n.id === "koi-kbd-scope-global");
        const callHierIdx = kids.findIndex(
            (n) => (n as HTMLElement).dataset?.bindingId === "callHierarchy",
        );
        const paletteIdx = kids.findIndex(
            (n) => (n as HTMLElement).dataset?.bindingId === "commandPalette",
        );
        expect(callHierIdx).toBeLessThan(globalHeadIdx);
        expect(globalHeadIdx).toBeLessThan(paletteIdx);
    });
});

describe("buildKeyboardSection — arm/disarm listener pairing", () => {
    it("arming a row's recorder adds exactly one capture-phase document keydown listener", () => {
        const section = buildKeyboardSection({});
        document.body.appendChild(section.panel);

        const addSpy = vi.spyOn(document, "addEventListener");
        const removeSpy = vi.spyOn(document, "removeEventListener");

        recordBtn(section.panel, "format").click();

        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(addSpy).toHaveBeenCalledWith(
            "keydown",
            expect.any(Function),
            true,
        );
        expect(removeSpy).not.toHaveBeenCalled();

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it("clicking Record a second time disarms and removes the SAME listener that was added", () => {
        const section = buildKeyboardSection({});
        document.body.appendChild(section.panel);

        const addSpy = vi.spyOn(document, "addEventListener");
        const removeSpy = vi.spyOn(document, "removeEventListener");

        const btn = recordBtn(section.panel, "format");
        btn.click(); // arm
        const addedListener = addSpy.mock.calls[0][1];
        btn.click(); // second click: disarm

        expect(removeSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledWith("keydown", addedListener, true);
        expect(btn.textContent).toBe("Record");
        expect(btn.classList.contains("is-recording")).toBe(false);

        addSpy.mockRestore();
        removeSpy.mockRestore();
    });

    it("pressing Escape while armed disarms and removes the listener without recording anything", () => {
        const section = buildKeyboardSection({});
        document.body.appendChild(section.panel);

        recordBtn(section.panel, "format").click(); // arm
        const removeSpy = vi.spyOn(document, "removeEventListener");

        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );

        expect(removeSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledWith(
            "keydown",
            expect.any(Function),
            true,
        );
        expect(loadKeybindingOverrides().format).toBeUndefined();

        removeSpy.mockRestore();
    });

    it("section.suspend() disarms an armed recorder, so no leaked listener rebinds a hidden row", () => {
        const onKeybindingsChanged = vi.fn();
        const section = buildKeyboardSection({ onKeybindingsChanged });
        document.body.appendChild(section.panel);

        recordBtn(section.panel, "format").click(); // arm, but never deliver a key
        const removeSpy = vi.spyOn(document, "removeEventListener");

        section.suspend();

        expect(removeSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledWith(
            "keydown",
            expect.any(Function),
            true,
        );

        // The post-suspend keystroke must be ignored: the document listener was torn down on suspend.
        document.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "k",
                ctrlKey: true,
                bubbles: true,
            }),
        );
        expect(loadKeybindingOverrides().format).toBeUndefined();
        expect(onKeybindingsChanged).not.toHaveBeenCalled();

        removeSpy.mockRestore();
    });

    it("section.suspend() when nothing is armed is a safe no-op (no error, no removeEventListener call)", () => {
        const section = buildKeyboardSection({});
        document.body.appendChild(section.panel);

        const removeSpy = vi.spyOn(document, "removeEventListener");

        expect(() => section.suspend()).not.toThrow();
        expect(removeSpy).not.toHaveBeenCalled();

        // Calling it again (already-idle) stays a no-op too.
        expect(() => section.suspend()).not.toThrow();
        expect(removeSpy).not.toHaveBeenCalled();

        removeSpy.mockRestore();
    });
});

describe("buildKeyboardSection — recording behavior + deps.onKeybindingsChanged", () => {
    it("recording a chord persists the override, repaints the row, and fires deps.onKeybindingsChanged", () => {
        const onKeybindingsChanged = vi.fn();
        const section = buildKeyboardSection({ onKeybindingsChanged });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        recordBtn(section.panel, "format").click();
        document.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "j",
                ctrlKey: true,
                bubbles: true,
            }),
        );

        expect(loadKeybindingOverrides().format).toBe("Mod-j");
        expect(onKeybindingsChanged).toHaveBeenCalledTimes(1);
        const chord = section.panel.querySelector<HTMLElement>(
            '.koi-kbd-row[data-binding-id="format"] .koi-kbd-chord',
        )!;
        expect(chord.textContent).toBe("Ctrl+J");
    });

    it("Reset all clears every override and fires deps.onKeybindingsChanged", () => {
        const onKeybindingsChanged = vi.fn();
        const section = buildKeyboardSection({ onKeybindingsChanged });
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        saveKeybindingOverride("format", "Mod-j");
        section.panel
            .querySelector<HTMLButtonElement>(".koi-kbd-reset-all")!
            .click();

        expect(loadKeybindingOverrides()).toEqual({});
        expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
        expect(onKeybindingsChanged).toHaveBeenCalledTimes(1);
    });

    it("deps.onKeybindingsChanged is optional — recording still persists without a callback wired", () => {
        const section = buildKeyboardSection({});
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        expect(() => {
            recordBtn(section.panel, "format").click();
            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "j",
                    ctrlKey: true,
                    bubbles: true,
                }),
            );
        }).not.toThrow();
        expect(loadKeybindingOverrides().format).toBe("Mod-j");
    });
});

describe("buildKeyboardSection.populate", () => {
    it("ignores its Settings argument, but disarms any recorder, hides open conflicts, and repaints from overrides", () => {
        const section = buildKeyboardSection({});
        document.body.appendChild(section.panel);
        section.populate(loadSettings());

        recordBtn(section.panel, "format").click(); // arm
        const removeSpy = vi.spyOn(document, "removeEventListener");

        saveKeybindingOverride("format", "Mod-j");
        section.populate({ ...DEFAULT_SETTINGS }); // the argument itself is unused

        expect(removeSpy).toHaveBeenCalledTimes(1); // disarmed
        const btn = recordBtn(section.panel, "format");
        expect(btn.textContent).toBe("Record");
        expect(btn.classList.contains("is-recording")).toBe(false);
        const chord = section.panel.querySelector<HTMLElement>(
            '.koi-kbd-row[data-binding-id="format"] .koi-kbd-chord',
        )!;
        expect(chord.textContent).toBe("Ctrl+J"); // repainted from the freshly-saved override

        removeSpy.mockRestore();
    });
});
