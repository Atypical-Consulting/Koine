// @vitest-environment happy-dom
// Smoke tests for the pure control factories hoisted out of mountPreferencesPane's closure (#987 task 1).
// These are DOM builders only — no Settings/persistence wiring — so each test drives a control in
// isolation via the callbacks it takes as parameters, matching how prefs.ts calls them today.
import { describe, it, expect, vi } from "vitest";
import { row, panel, toggle, metricInput } from "@/settings/prefsControls";

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
