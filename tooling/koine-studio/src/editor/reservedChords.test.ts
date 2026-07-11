// Tests for loadedReservedChords — the DOM-free accessor that enumerates every chord the editor's
// loaded CodeMirror keymaps bind, so the Settings conflict-check stays exhaustive without being
// hand-maintained. Mirrors the testable-seam style of keybindings.test.ts.
import { describe, expect, test } from "vitest";
import { loadedReservedChords } from "@/editor/editor";
import { DEFAULT_BINDINGS } from "@/editor/keybindings";

describe("loadedReservedChords", () => {
    test("includes the four chords the old RESERVED_CHORDS hard-coded", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // These four were in the original hard-coded table and must remain covered.
        expect(reserved).toHaveProperty("Mod-f"); // openSearchPanel → Find
        expect(reserved).toHaveProperty("Mod-d"); // selectNextOccurrence
        expect(reserved).toHaveProperty("Mod-a"); // selectAll
        expect(reserved).toHaveProperty("Mod-Alt-h"); // call hierarchy
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

    test("returns non-empty string labels for every entry", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        for (const [chord, label] of Object.entries(reserved)) {
            expect(typeof chord).toBe("string");
            expect(typeof label).toBe("string");
            expect(label.length).toBeGreaterThan(0);
        }
    });

    test("excludes registry chords so inter-row logic handles them, not the built-in check", () => {
        // When a registry chord matches a built-in, the inter-row conflict (otherId != null path) runs,
        // not the built-in reserved path. The accessor must leave registry chords out.
        const resolved = { ...DEFAULT_BINDINGS };
        const reserved = loadedReservedChords(resolved);
        for (const chord of Object.values(resolved)) {
            if (chord !== "") {
                expect(reserved).not.toHaveProperty(chord);
            }
        }
    });

    test("labels the named built-ins", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        expect(reserved["Mod-f"]).toBe("Find");
        expect(reserved["Mod-a"]).toBe("Select all");
        expect(reserved["Mod-Alt-h"]).toBe("Call hierarchy");
    });

    test("covers more chords than the old four-entry table", () => {
        const reserved = loadedReservedChords(DEFAULT_BINDINGS);
        // The derived set must be broader than the four hand-curated ones — that's the whole point.
        expect(Object.keys(reserved).length).toBeGreaterThan(4);
    });
});
