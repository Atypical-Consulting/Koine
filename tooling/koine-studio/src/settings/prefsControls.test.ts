// @vitest-environment happy-dom
// Smoke tests for the pure control factories hoisted out of mountPreferencesPane's closure (#987 task 1).
// These are DOM builders only — no Settings/persistence wiring — so each test drives a control in
// isolation via the callbacks it takes as parameters, matching how prefs.ts calls them today.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    row,
    panel,
    toggle,
    metricInput,
    textInput,
    actionButton,
    copyButton,
} from "@/settings/prefsControls";

describe("prefsControls: row()", () => {
    it("gives a labelable control a koi-set-<slug> id and pairs it with <label for>", () => {
        const input = document.createElement("input");
        input.type = "text";
        const r = row("Tab Size", "Number of spaces per indent level.", input);

        expect(input.id).toBe("koi-set-tab-size");
        expect(input.getAttribute("name")).toBe("koi-set-tab-size");

        const label = r.querySelector("label")!;
        expect(label).not.toBeNull();
        expect(label.textContent).toBe("Tab Size");
        expect(label.getAttribute("for")).toBe(input.id);

        const desc = r.querySelector(".koi-set-desc")!;
        expect(desc.textContent).toBe("Number of spaces per indent level.");
    });

    it("doesn't overwrite a control's pre-existing id", () => {
        const input = document.createElement("input");
        input.id = "already-set";
        const r = row("Some title", "", input);
        expect(input.id).toBe("already-set");
        expect(r.querySelector("label")!.getAttribute("for")).toBe(
            "already-set",
        );
    });

    it("falls back to a plain <span> label for a non-form control (e.g. a switch)", () => {
        const control = document.createElement("button");
        const r = row("Word wrap", "", control);
        expect(r.querySelector("label")).toBeNull();
        const label = r.querySelector(".koi-set-label")!;
        expect(label.tagName).toBe("SPAN");
        expect(label.textContent).toBe("Word wrap");
    });
});

describe("prefsControls: panel()", () => {
    it("sets the koi-settings-panel-<id> id and role=tabpanel, and appends the given rows", () => {
        const rowEl = document.createElement("div");
        const p = panel("appearance", rowEl);
        expect(p.id).toBe("koi-settings-panel-appearance");
        expect(p.getAttribute("role")).toBe("tabpanel");
        expect(p.contains(rowEl)).toBe(true);
    });
});

describe("prefsControls: toggle()", () => {
    it("flips aria-checked on click and reports the new value via onChange", () => {
        const onChange = vi.fn();
        const t = toggle("Word wrap", onChange);
        expect(t.el.getAttribute("aria-checked")).toBe("false");

        t.el.click();
        expect(t.el.getAttribute("aria-checked")).toBe("true");
        expect(onChange).toHaveBeenCalledWith(true);

        t.el.click();
        expect(t.el.getAttribute("aria-checked")).toBe("false");
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it("set() repaints aria-checked without firing onChange", () => {
        const onChange = vi.fn();
        const t = toggle("Minimap", onChange);
        t.set(true);
        expect(t.el.getAttribute("aria-checked")).toBe("true");
        expect(onChange).not.toHaveBeenCalled();
    });

    it("blocks clicks (and drops onChange) once disabled", () => {
        const onChange = vi.fn();
        const t = toggle("Compiler tools", onChange);
        t.setDisabled(true);
        expect(t.el.disabled).toBe(true);
        expect(t.el.getAttribute("aria-disabled")).toBe("true");

        t.el.click(); // a disabled <button> dispatches no click event
        expect(onChange).not.toHaveBeenCalled();
        expect(t.el.getAttribute("aria-checked")).toBe("false");
    });
});

describe("prefsControls: textInput()", () => {
    it("builds a koi-text input and fires onChange with the value on 'change'", () => {
        const onChange = vi.fn();
        const input = textInput({ placeholder: "You", onChange });
        expect(input.className).toBe("koi-text");
        expect(input.placeholder).toBe("You");
        input.value = "Ada";
        input.dispatchEvent(new Event("change"));
        expect(onChange).toHaveBeenCalledWith("Ada");
    });

    it("defaults to type=text and respects type/autocomplete/spellcheck/list when passed", () => {
        const plain = textInput({});
        const bareInput = document.createElement("input");
        expect(plain.type).toBe("text");
        expect(plain.spellcheck).toBe(bareInput.spellcheck); // untouched when omitted

        const configured = textInput({
            type: "password",
            autocomplete: "off",
            spellcheck: false,
            list: "koi-ai-base-presets",
        });
        expect(configured.type).toBe("password");
        expect(configured.autocomplete).toBe("off");
        expect(configured.spellcheck).toBe(false);
        expect(configured.getAttribute("list")).toBe("koi-ai-base-presets");
    });

    it("sets id and name together when id is passed (mcpUrlInput's koi-mcp-url case)", () => {
        const input = textInput({ id: "koi-mcp-url" });
        expect(input.id).toBe("koi-mcp-url");
        expect(input.getAttribute("name")).toBe("koi-mcp-url");
    });
});

describe("prefsControls: actionButton()", () => {
    it("builds a type=button koi-set-action button with the given label, calling onClick on click", () => {
        const onClick = vi.fn();
        const btn = actionButton("Change…", onClick);
        expect(btn.type).toBe("button");
        expect(btn.className).toBe("koi-set-action");
        expect(btn.textContent).toBe("Change…");
        btn.click();
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("applies ariaLabel and an extra className when passed", () => {
        const btn = actionButton("Record", vi.fn(), {
            className: "koi-set-action koi-kbd-record",
            ariaLabel: "Record a new shortcut for Format document",
        });
        expect(btn.className).toBe("koi-set-action koi-kbd-record");
        expect(btn.getAttribute("aria-label")).toBe(
            "Record a new shortcut for Format document",
        );
    });
});

describe("prefsControls: copyButton()", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function mockClipboard(writeText: () => Promise<void>): void {
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: vi.fn(writeText) },
            configurable: true,
        });
    }

    it("copies getText()'s value, flashes 'Copied ✓', then reverts to the idle label after 1600ms", async () => {
        mockClipboard(() => Promise.resolve());
        const { el: btn } = copyButton("Copy", () => "hello");
        expect(btn.className).toBe("koi-set-action");

        btn.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
        expect(btn.textContent).toBe("Copied ✓");

        await vi.advanceTimersByTimeAsync(1600);
        expect(btn.textContent).toBe("Copy");
    });

    it("flips to 'Copy failed' on a rejected clipboard write", async () => {
        mockClipboard(() => Promise.reject(new Error("denied")));
        const { el: btn } = copyButton("Copy", () => "hello");

        btn.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(btn.textContent).toBe("Copy failed");
    });

    it("cancelReset disposes the pending timer without throwing", async () => {
        mockClipboard(() => Promise.resolve());
        const { el: btn, cancelReset } = copyButton("Copy", () => "hello");

        btn.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(() => cancelReset()).not.toThrow();
        await vi.advanceTimersByTimeAsync(2000);
        expect(btn.textContent).toBe("Copied ✓"); // the reset never fires — cancelled
    });

    it("a guard veto blocks the copy (mcpCopyBtn's empty-URL no-op case)", async () => {
        mockClipboard(() => Promise.resolve());
        let allow = false;
        const { el: btn } = copyButton("Copy", () => "hello", { guard: () => allow });

        btn.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(btn.textContent).toBe("Copy");

        allow = true;
        btn.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    });
});

describe("prefsControls: metricInput()", () => {
    it("clamps a value above max down to max on change", () => {
        const write = vi.fn();
        const input = metricInput(1, 8, 1, () => 4, write);
        input.value = "20";
        input.dispatchEvent(new Event("change"));
        expect(input.value).toBe("8");
        expect(write).toHaveBeenCalledWith(8);
    });

    it("clamps a value below min up to min on change", () => {
        const write = vi.fn();
        const input = metricInput(1, 8, 1, () => 4, write);
        input.value = "-5";
        input.dispatchEvent(new Event("change"));
        expect(input.value).toBe("1");
        expect(write).toHaveBeenCalledWith(1);
    });

    it("restores the last good value (via read()) on a blank or non-numeric commit, without calling write", () => {
        const write = vi.fn();
        const input = metricInput(1, 8, 1, () => 4, write);
        input.value = "";
        input.dispatchEvent(new Event("change"));
        expect(input.value).toBe("4");
        expect(write).not.toHaveBeenCalled();
    });
});
