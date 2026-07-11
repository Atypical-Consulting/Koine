// Tests for loadedReservedChords — the DOM-free accessor that enumerates every chord the editor's
// loaded CodeMirror keymaps bind, so the Settings conflict-check stays exhaustive without being
// hand-maintained. Mirrors the testable-seam style of keybindings.test.ts.
import { describe, expect, test } from "vitest";
import { loadedReservedChords } from "@/editor/editor";
import { DEFAULT_BINDINGS } from "@/editor/keybindings";

describe("loadedReservedChords", () => {
    test("still covers the non-rebindable built-ins the old RESERVED_CHORDS hard-coded", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // These three were in the original hard-coded table and are still non-rebindable built-ins.
        expect(reserved).toHaveProperty("Mod-f"); // openSearchPanel → Find
        expect(reserved).toHaveProperty("Mod-d"); // selectNextOccurrence
        expect(reserved).toHaveProperty("Mod-a"); // selectAll
        // Mod-Alt-h is NO LONGER a reserved built-in: #432 made call hierarchy a rebindable registry row
        // (DEFAULT_BINDINGS.callHierarchy = 'Mod-Alt-h'), so the registryChords guard excludes it here and
        // the inter-row conflict path (findKbdDuplicate) owns a clash with it instead.
        expect(reserved).not.toHaveProperty("Mod-Alt-h");
    });

    test("does NOT include Mod-z (historyKeymap is not loaded)", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // historyKeymap is deliberately NOT loaded in editor.ts; Mod-z must stay free.
        expect(reserved).not.toHaveProperty("Mod-z");
    });

    test("catches Mod-/ (toggleComment) that the old four-entry table missed", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // Mod-/ IS in defaultKeymap but was absent from the hand table — the exact drift this fix kills.
        expect(reserved).toHaveProperty("Mod-/");
        expect(reserved["Mod-/"]).toBe("Toggle comment");
    });

    test("normalizes CodeMirror's modifier ORDER so reorder-spelled built-ins are still caught", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // defaultKeymap spells deleteLine as "Shift-Mod-k" and cursorMatchingBracket as "Shift-Mod-\\",
        // but chordFromEvent always emits Mod- before Shift-. Without normalization these would be stored
        // under keys a recorded chord can never equal, silently shadowing the built-in.
        expect(reserved).toHaveProperty("Mod-Shift-k");
        expect(reserved["Mod-Shift-k"]).toBe("Delete line");
        expect(reserved).toHaveProperty("Mod-Shift-\\");
        // The raw CodeMirror spellings must NOT leak through.
        expect(reserved).not.toHaveProperty("Shift-Mod-k");
        expect(reserved).not.toHaveProperty("Shift-Mod-\\");
    });

    test("normalizes an uppercase-letter key (Alt-A ≡ Shift-Alt-a) so it is reachable", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // CodeMirror binds toggleBlockComment to "Alt-A"; a single uppercase letter implies Shift, and
        // chordFromEvent lowercases the base — so the recorded chord is "Shift-Alt-a".
        expect(reserved).toHaveProperty("Shift-Alt-a");
        expect(reserved["Shift-Alt-a"]).toBe("Toggle block comment");
        expect(reserved).not.toHaveProperty("Alt-A");
    });

    test("returns non-empty string labels for every entry", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        for (const [chord, label] of Object.entries(reserved)) {
            expect(typeof chord).toBe("string");
            expect(typeof label).toBe("string");
            expect(label.length).toBeGreaterThan(0);
        }
    });

    test("excludes a chord that a registry override now owns, so inter-row logic handles it", () => {
        // Point a rebindable command AT a real loaded built-in chord. The accessor must then drop that
        // chord from the reserved set (the otherId != null inter-row path owns it), NOT double-count it.
        // This genuinely exercises the registryChords guard — the untouched DEFAULT_BINDINGS never
        // overlaps a built-in, so with defaults the same chord is present (the contrast below proves it).
        expect(loadedReservedChords(DEFAULT_BINDINGS)).toHaveProperty("Mod-/");
        const overridden = { ...DEFAULT_BINDINGS, format: "Mod-/" };
        expect(loadedReservedChords(overridden)).not.toHaveProperty("Mod-/");
    });

    test("labels the named built-ins", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        expect(reserved["Mod-f"]).toBe("Find");
        expect(reserved["Mod-a"]).toBe("Select all");
    });

    test("labels are chord-keyed (minification-proof), not derived from the run function's name", () => {
        // Regression guard for the esbuild name-mangling trap: every friendly label must come from the
        // chord string, so a production build (which renames run functions) still shows "Find", not a
        // mangled identifier. A named built-in therefore never degrades to the "Editor command" fallback.
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        expect(reserved["Mod-f"]).not.toBe("Editor command");
        expect(reserved["Mod-d"]).not.toBe("Editor command");
    });

    test("covers more chords than the old four-entry table", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // The derived set must be broader than the four hand-curated ones — that's the whole point.
        expect(Object.keys(reserved).length).toBeGreaterThan(4);
    });
});
