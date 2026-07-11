// The Keyboard section (extracted from prefs.ts, #987 task 5 — moved WHOLE, verbatim). One row per
// rebindable editor command (KEYBINDINGS). Each row records a new combo (a document-level capture-phase
// keydown listener while armed), resets to its default, or — on a clash with another command's chord —
// surfaces a confirmable conflict. Every committed change persists through the override store
// (@/settings/persistence) and live-applies via deps.onKeybindingsChanged.
//
// This is the MOST DELICATE section in the split: it owns the one genuinely fragile piece of transient
// state in prefs.ts — armRecording/disarmRecording and the document-level keydown listener they
// arm/disarm — moved here TOGETHER, unchanged, so the arm/disarm pairing stays intact. A bug here leaks
// a listener that swallows every keystroke on the page.
//
// Keyboard does NOT take the shared SectionCtx: its commits don't go through commit()/onChange() — they
// go through saveKeybindingOverride/clearKeybindingOverrides directly, and notify via
// deps.onKeybindingsChanged?.() — so it takes its own narrow deps instead.
//
// suspend() exposes exactly what the THREE original call sites in prefs.ts did inline (disarmRecording()
// + hide every row's open conflict prompt): selectCategory (switching categories) and the pane-level
// suspend() (which destroy() also covers, by calling the pane's own suspend()) now just call
// keyboard.suspend().
//
// This module must not import prefs.ts (no import cycles).
import {
    resolveKeybindings,
    loadKeybindingOverrides,
    saveKeybindingOverride,
    clearKeybindingOverrides,
    type Settings,
} from "@/settings/persistence";
import { row, panel } from "@/settings/prefsControls";
import {
    KEYBINDINGS,
    DEFAULT_BINDINGS,
    type BindingId,
} from "@/editor/keybindings";
import { loadedReservedChords } from "@/editor/editor";
import { chordFromEvent, prettyChord } from "@/shared/platform";
import type { PrefsSection } from "@/settings/prefsSections/types";

/** What buildKeyboardSection needs from its host: the live-apply hook fired after every committed
 *  keybinding change (reconfigures the editor keymap). Optional: a caller that doesn't wire it simply
 *  never live-applies (tests, mostly). */
export interface KeyboardSectionDeps {
    onKeybindingsChanged?(): void;
}

export function buildKeyboardSection(
    deps: KeyboardSectionDeps,
): PrefsSection & { suspend(): void } {
    // Editor shortcuts OUTSIDE the rebindable registry that a remap would silently shadow: the registry
    // keymap compartment is registered at higher precedence than the editor's own Mod-Alt-h (call
    // hierarchy) and the loaded CodeMirror keymaps (searchKeymap / defaultKeymap). We can't unbind these,
    // but we warn before letting a remap mask one. The reserved set is DERIVED from the keymaps the editor
    // actually loads via loadedReservedChords() (editor.ts) — re-read on each applyRecordedChord so it is
    // exhaustive by construction and can never drift from the editor. Registry chords are excluded there
    // (the inter-row conflict path below owns those); only non-rebindable built-ins remain.

    interface KbdRowState {
        chord: HTMLElement;
        recordBtn: HTMLButtonElement;
        resetBtn: HTMLButtonElement;
        conflict: HTMLElement;
        reassignBtn: HTMLButtonElement;
        cancelBtn: HTMLButtonElement;
        /** A recorded chord awaiting conflict confirmation: the clashing label and the rebindable command
         *  that currently owns it — null when it clashes with a reserved/built-in shortcut we can't unbind
         *  (confirming then just applies the remap, shadowing the built-in). */
        pending: {
            chord: string;
            otherId: BindingId | null;
            label: string;
        } | null;
    }
    const kbdRows = new Map<BindingId, KbdRowState>();

    // Recording is global (only one row arms at a time): the armed id + its document listener.
    let kbdArmed: BindingId | null = null;
    let kbdKeyListener: ((e: KeyboardEvent) => void) | null = null;

    const kbdLabel = (id: BindingId): string =>
        KEYBINDINGS.find((b) => b.id === id)?.label ?? id;

    // Re-read the resolved map and repaint one row: chord display + the per-row Reset's enabled state
    // (Reset only means something when this command actually carries an override).
    function repaintKbdRow(id: BindingId): void {
        const row = kbdRows.get(id);
        if (!row) return;
        row.chord.textContent = prettyChord(resolveKeybindings()[id]);
        row.resetBtn.disabled = !(id in loadKeybindingOverrides());
    }
    function repaintKeyboard(): void {
        for (const id of kbdRows.keys()) repaintKbdRow(id);
    }

    function hideKbdConflict(id: BindingId): void {
        const row = kbdRows.get(id);
        if (!row) return;
        row.pending = null;
        row.conflict.hidden = true;
        row.conflict.textContent = "";
        row.reassignBtn.hidden = true;
        row.cancelBtn.hidden = true;
    }

    function showKbdConflict(
        id: BindingId,
        chord: string,
        label: string,
        otherId: BindingId | null,
    ): void {
        const row = kbdRows.get(id);
        if (!row) return;
        row.pending = { chord, otherId, label };
        // Unhide BEFORE writing the text: role="alert" only announces a content change made while the node
        // is already rendered, so setting textContent while [hidden] then revealing it would stay silent.
        row.conflict.hidden = false;
        row.conflict.textContent = `Already bound to “${label}”. Reassign?`;
        row.reassignBtn.hidden = false;
        row.cancelBtn.hidden = false;
        row.reassignBtn.focus(); // move focus to the confirm so keyboard / screen-reader users can act on it
    }

    function disarmRecording(): void {
        if (kbdKeyListener) {
            document.removeEventListener("keydown", kbdKeyListener, true);
            kbdKeyListener = null;
        }
        if (kbdArmed !== null) {
            const row = kbdRows.get(kbdArmed);
            if (row) {
                row.recordBtn.textContent = "Record";
                row.recordBtn.classList.remove("is-recording");
            }
            kbdArmed = null;
        }
    }

    // The rebindable command (≠ id) whose RESOLVED chord equals `chord` — the duplicate a commit
    // without a conflict prompt would silently double-bind. Unbound ("") rows never count.
    function findKbdDuplicate(
        id: BindingId,
        chord: string,
    ): BindingId | undefined {
        const resolved = resolveKeybindings();
        return (Object.keys(resolved) as BindingId[]).find(
            (k) => k !== id && resolved[k] !== "" && resolved[k] === chord,
        );
    }

    // Commit a freshly recorded chord, or defer to a conflict prompt when it clashes with another
    // rebindable command or a reserved/built-in shortcut.
    function applyRecordedChord(id: BindingId, chord: string): void {
        // Scan for a duplicate owner BEFORE the own-default fast path below: the Reassign flow can hand
        // this command's default chord to another command, so even the default can clash.
        const otherId = findKbdDuplicate(id, chord);
        if (otherId) {
            showKbdConflict(id, chord, kbdLabel(otherId), otherId); // clashes with another rebindable command
            return; // wait for the user to confirm the reassignment
        }
        // Recording a command's own default drops any override instead of persisting a redundant one — so
        // the store stays clean and the per-row Reset's enabled state stays honest.
        if (chord === DEFAULT_BINDINGS[id]) {
            saveKeybindingOverride(id, null);
            repaintKbdRow(id);
            deps.onKeybindingsChanged?.();
            return;
        }
        const reserved = loadedReservedChords(resolveKeybindings())[chord];
        if (reserved) {
            showKbdConflict(id, chord, reserved, null); // would shadow a built-in / call-hierarchy shortcut
            return;
        }
        saveKeybindingOverride(id, chord);
        repaintKbdRow(id);
        deps.onKeybindingsChanged?.();
    }

    function armRecording(id: BindingId): void {
        disarmRecording(); // cancel any other in-flight recording first
        for (const k of kbdRows.keys()) hideKbdConflict(k); // clear THIS and any other row's stale conflict prompt
        kbdArmed = id;
        const row = kbdRows.get(id);
        if (row) {
            row.recordBtn.textContent = "Press keys…";
            row.recordBtn.classList.add("is-recording");
        }
        kbdKeyListener = (e: KeyboardEvent) => {
            // Capture + swallow so the combo isn't also handled by the app/editor underneath the dialog.
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                disarmRecording(); // cancel — no change
                return;
            }
            const chord = chordFromEvent(e);
            if (chord === null) return; // a bare modifier — keep waiting for the real key
            // Reject a modifier-less printable single char: binding it would swallow that character in the
            // editor (preventDefault), making it un-typeable. Named keys (F2/F12/Enter…) and any modifier
            // combo are fine; stay armed so the user can press a valid combo.
            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1)
                return;
            const armedId = kbdArmed;
            disarmRecording();
            if (armedId !== null) applyRecordedChord(armedId, chord);
        };
        document.addEventListener("keydown", kbdKeyListener, true);
    }

    function buildKbdRow(id: BindingId, label: string): HTMLElement {
        const control = document.createElement("div");
        control.className = "koi-kbd-control";

        const chord = document.createElement("span");
        chord.className = "koi-kbd-chord";
        // The current binding lives in this span; tie it to the Record button so a screen reader announces
        // "Record a new shortcut for Format document, ⌘S" instead of a bare, ambiguous "Record".
        chord.id = `koi-kbd-chord-${id}`;

        const recordBtn = document.createElement("button");
        recordBtn.type = "button";
        recordBtn.className = "koi-set-action koi-kbd-record";
        recordBtn.textContent = "Record";
        recordBtn.setAttribute(
            "aria-label",
            `Record a new shortcut for ${label}`,
        );
        recordBtn.setAttribute("aria-describedby", chord.id);

        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "koi-kbd-reset";
        resetBtn.textContent = "Reset";
        resetBtn.setAttribute(
            "aria-label",
            `Reset the ${label} shortcut to its default`,
        );

        const conflict = document.createElement("span");
        conflict.className = "koi-kbd-conflict";
        conflict.setAttribute("role", "alert");
        conflict.hidden = true;

        const reassignBtn = document.createElement("button");
        reassignBtn.type = "button";
        reassignBtn.className = "koi-set-action koi-kbd-reassign";
        reassignBtn.textContent = "Reassign";
        reassignBtn.setAttribute(
            "aria-label",
            `Reassign this shortcut to ${label}`,
        );
        reassignBtn.hidden = true;

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "koi-kbd-cancel";
        cancelBtn.textContent = "Cancel";
        cancelBtn.setAttribute(
            "aria-label",
            `Cancel reassigning the ${label} shortcut`,
        );
        cancelBtn.hidden = true;

        control.append(
            chord,
            recordBtn,
            resetBtn,
            conflict,
            reassignBtn,
            cancelBtn,
        );

        const r = row(label, "", control);
        r.classList.add("koi-kbd-row");
        r.dataset.bindingId = id;

        kbdRows.set(id, {
            chord,
            recordBtn,
            resetBtn,
            conflict,
            reassignBtn,
            cancelBtn,
            pending: null,
        });

        recordBtn.addEventListener("click", () => {
            if (kbdArmed === id)
                disarmRecording(); // a second click toggles recording off
            else armRecording(id);
        });
        resetBtn.addEventListener("click", () => {
            hideKbdConflict(id);
            // Reset restores the default chord, which the Reassign flow may meanwhile have handed to
            // ANOTHER command — route through the same conflict prompt instead of silently double-binding.
            const otherId = findKbdDuplicate(id, DEFAULT_BINDINGS[id]);
            if (otherId) {
                showKbdConflict(
                    id,
                    DEFAULT_BINDINGS[id],
                    kbdLabel(otherId),
                    otherId,
                );
                return; // wait for the user to confirm the reassignment
            }
            saveKeybindingOverride(id, null); // drop the remap so the default wins again
            repaintKbdRow(id);
            deps.onKeybindingsChanged?.();
        });
        reassignBtn.addEventListener("click", () => {
            const row = kbdRows.get(id);
            const p = row?.pending;
            if (!p) return;
            if (p.otherId) saveKeybindingOverride(p.otherId, ""); // a rebindable prior owner becomes unbound
            // This command takes the chord (shadowing a built-in if reserved); taking back its OWN default
            // drops the override instead of persisting a redundant one, keeping the store clean.
            saveKeybindingOverride(
                id,
                p.chord === DEFAULT_BINDINGS[id] ? null : p.chord,
            );
            hideKbdConflict(id);
            repaintKbdRow(id);
            if (p.otherId) repaintKbdRow(p.otherId);
            deps.onKeybindingsChanged?.();
        });
        cancelBtn.addEventListener("click", () => hideKbdConflict(id)); // dismiss — keep the current binding

        return r;
    }

    const keyboardRows = KEYBINDINGS.map((b) => buildKbdRow(b.id, b.label));

    const kbdResetAll = document.createElement("button");
    kbdResetAll.type = "button";
    kbdResetAll.className = "koi-set-action koi-kbd-reset-all";
    kbdResetAll.textContent = "Reset all shortcuts";
    kbdResetAll.addEventListener("click", () => {
        clearKeybindingOverrides();
        for (const id of kbdRows.keys()) hideKbdConflict(id);
        repaintKeyboard();
        deps.onKeybindingsChanged?.();
    });

    const keyboardPanel = panel(
        "keyboard",
        ...keyboardRows,
        row(
            "Reset all",
            "Restore the default shortcut for every command.",
            kbdResetAll,
        ),
    );

    // Cancel any armed recording / open conflict and repaint from the current overrides — called on
    // every open (populate) so the panel never reopens mid-recording or showing a stale chord.
    function refreshKeyboard(): void {
        disarmRecording();
        for (const id of kbdRows.keys()) hideKbdConflict(id);
        repaintKeyboard();
    }

    // populate(s) ignores its Settings argument — this panel repaints from resolveKeybindings() /
    // loadKeybindingOverrides() directly, not from the passed-in Settings — matching what the bare
    // refreshKeyboard() call at the end of the assembler's populate() did before the extraction.
    function populate(_s: Settings): void {
        refreshKeyboard();
    }

    // Exposes exactly what the pane's THREE original call sites did inline (disarmRecording() + hide
    // every row's open conflict prompt): selectCategory (switching categories) and the pane-level
    // suspend() (destroy() calls the pane's own suspend(), which already covers it).
    function suspend(): void {
        disarmRecording();
        for (const id of kbdRows.keys()) hideKbdConflict(id);
    }

    return { panel: keyboardPanel, populate, suspend };
}
