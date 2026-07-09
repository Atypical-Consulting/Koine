// The Editor section (extracted from prefs.ts, #987 task 4): font size, line height, tab size, the
// live type specimen, word wrap / format on save (workspace-scopable via the shared ScopeKit), auto-save,
// minimap, and default domain-canvas zoom.
//
// Word wrap and Format on save are workspace-scopable: buildEditorSection takes the shared ScopeKit
// instance (built once in prefs.ts, #987 task 2 — @/settings/prefsSections/scopeKit) as a DEPENDENCY
// rather than constructing its own, since the SAME kit instance also backs Output's outputScope and
// Advanced's traceRow, so its syncAll() sees every registered row.
//
// IMPORTANT ordering nuance: wordWrapRow / formatOnSaveRow's VALUES are synced by scopeKit.syncAll(s),
// called separately by the assembler (mountPreferencesPane's populate()) AFTER this section's own
// populate() (and after Output's) — this section's populate() must NOT set their values itself, only the
// plain (non-scoped) fields below. Their toggle's onChange still routes through the row's own
// scopedCommit, wired at construction time via scopeKit.scopedRow.
//
// This module must not import prefs.ts (no import cycles).
import { DIAGRAM_ZOOM_MIN, DIAGRAM_ZOOM_MAX } from "@/diagrams/diagramContract";
import { loadSettings, type Settings } from "@/settings/persistence";
import { row, panel, toggle, metricInput } from "@/settings/prefsControls";
import type { ScopeKit } from "@/settings/prefsSections/scopeKit";
import type { PrefsSection, SectionCtx } from "@/settings/prefsSections/types";

const FONT_MIN = 10;
const FONT_MAX = 22;
const FONT_STEP = 0.5;

const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;
const LINE_HEIGHT_STEP = 0.1;

// Indent width bounds (#750); mirror the load-time clamp in persistence.ts.
const TAB_MIN = 1;
const TAB_MAX = 8;

// Default domain-canvas zoom control step (#762). The min/max mirror the diagram zoom band exported by
// persistence (DIAGRAM_ZOOM_MIN/MAX = 10/800), so the control and the load-time clamp agree.
const CANVAS_ZOOM_STEP = 10;

/** What buildEditorSection needs from its host beyond {@link SectionCtx}: the shared ScopeKit instance
 *  that backs the word-wrap / format-on-save scoped rows (and Output's / Advanced's own scoped rows). */
export interface EditorSectionDeps {
    scopeKit: ScopeKit;
}

export function buildEditorSection(
    ctx: SectionCtx,
    deps: EditorSectionDeps,
): PrefsSection {
    const { scopeKit } = deps;

    const fontInput = metricInput(
        FONT_MIN,
        FONT_MAX,
        FONT_STEP,
        () => loadSettings().fontSize,
        (v) => ctx.commit({ fontSize: v }),
    );

    const lineHeightInput = metricInput(
        LINE_HEIGHT_MIN,
        LINE_HEIGHT_MAX,
        LINE_HEIGHT_STEP,
        () => loadSettings().lineHeight,
        (v) => ctx.commit({ lineHeight: v }),
    );

    // Indent width in spaces (#750), clamped 1..8; the editor re-applies it live via setTabSize (onChange).
    const tabSizeInput = metricInput(
        TAB_MIN,
        TAB_MAX,
        1,
        () => loadSettings().tabSize,
        (v) => ctx.commit({ tabSize: v }),
    );

    // Default domain-canvas zoom (#762): the zoom a freshly-opened diagram canvas uses when nothing
    // per-diagram is saved. Clamped to the diagram zoom band (10–800); applied to the NEXT opened canvas
    // via setDefaultCanvasZoom in ide.tsx's onChange (a live canvas keeps its current zoom until re-rendered).
    const defaultCanvasZoomInput = metricInput(
        DIAGRAM_ZOOM_MIN,
        DIAGRAM_ZOOM_MAX,
        CANVAS_ZOOM_STEP,
        () => loadSettings().defaultCanvasZoom,
        (v) => ctx.commit({ defaultCanvasZoom: v }),
    );

    // A live type specimen: a short Koine snippet that renders at the current font size, line height,
    // and word-wrap so the numeric inputs above have something tangible to read against. It updates on
    // every keystroke — visual only; the real editor re-skins through onChange like every other field.
    const specimenCode = document.createElement("pre");
    specimenCode.className = "koi-editor-specimen-code";
    specimenCode.setAttribute("aria-hidden", "true");
    specimenCode.innerHTML =
        '<span class="tk-c">// A value object is immutable and compared by its fields</span>\n' +
        '<span class="tk-k">value</span> <span class="tk-t">Money</span> {\n' +
        '  amount: <span class="tk-t">Decimal</span>\n' +
        '  currency: <span class="tk-t">Currency</span>\n' +
        "}";

    const specimenLabel = document.createElement("span");
    specimenLabel.className = "koi-editor-specimen-label";
    specimenLabel.textContent = "Preview";

    const specimen = document.createElement("figure");
    specimen.className = "koi-editor-specimen";
    specimen.append(specimenLabel, specimenCode);

    // Read a metric input's current value, clamped into range, falling back to the persisted setting
    // for an empty or non-numeric field so a mid-edit blank never blanks the preview.
    function specimenMetric(
        input: HTMLInputElement,
        min: number,
        max: number,
        fallback: number,
    ): number {
        const raw = Number(input.value.trim());
        if (input.value.trim() === "" || !Number.isFinite(raw)) return fallback;
        return Math.min(Math.max(raw, min), max);
    }
    function refreshSpecimen(): void {
        const s = loadSettings();
        specimenCode.style.fontSize = `${specimenMetric(fontInput, FONT_MIN, FONT_MAX, s.fontSize)}px`;
        specimenCode.style.lineHeight = String(
            specimenMetric(
                lineHeightInput,
                LINE_HEIGHT_MIN,
                LINE_HEIGHT_MAX,
                s.lineHeight,
            ),
        );
    }
    fontInput.addEventListener("input", refreshSpecimen);
    lineHeightInput.addEventListener("input", refreshSpecimen);

    // Word wrap + Format on save are workspace-scopable: each pairs its toggle with a User/Workspace
    // scope control (scopedRow). The toggle is built inside makeControl so its onChange routes through
    // the row's scopedCommit (User → global blob; Workspace → the override store).
    const wordWrapRow = scopeKit.scopedRow(
        "wordWrap",
        "Word wrap",
        "Wrap long lines instead of scrolling sideways.",
        (scopedCommit) => {
            const t = toggle("Word wrap", (on) => {
                scopedCommit(on);
                specimenCode.classList.toggle("is-wrapped", on); // the preview wraps / scrolls just like the editor
            });
            // Mirror the specimen whenever populate() (or a scope flip) re-sets the toggle value.
            return {
                el: t.el,
                set: (on) => {
                    t.set(on);
                    specimenCode.classList.toggle("is-wrapped", on);
                },
            };
        },
    );
    const formatOnSaveRow = scopeKit.scopedRow(
        "formatOnSave",
        "Format on save",
        "Run the Koine formatter when you press save.",
        (scopedCommit) => toggle("Format on save", (on) => scopedCommit(on)),
    );
    const autoSave = toggle("Auto-save", (on) => ctx.commit({ autoSave: on }));
    const minimap = toggle("Minimap", (on) => ctx.commit({ enableMinimap: on }));

    const editorPanel = panel(
        "editor",
        specimen,
        row("Font size", "Editor text size, in pixels.", fontInput),
        row("Line height", "Vertical spacing between lines.", lineHeightInput),
        row(
            "Tab size",
            "Number of spaces per indent level (1–8).",
            tabSizeInput,
        ),
        wordWrapRow,
        formatOnSaveRow,
        row(
            "Auto-save",
            "Save edits automatically after a short pause in typing.",
            autoSave.el,
        ),
        row(
            "Minimap",
            "Show a document overview rail on the editor’s right edge.",
            minimap.el,
        ),
        row(
            "Default canvas zoom",
            "Initial zoom (%) for a freshly-opened domain diagram canvas (10–800).",
            defaultCanvasZoomInput,
        ),
    );

    // Word wrap / Format on save are deliberately NOT set here — their values are synced exclusively by
    // scopeKit.syncAll(s), called by the assembler after this section's populate() (see the module
    // comment above).
    function populate(s: Settings): void {
        fontInput.value = String(s.fontSize);
        lineHeightInput.value = String(s.lineHeight);
        tabSizeInput.value = String(s.tabSize);
        autoSave.set(s.autoSave);
        minimap.set(s.enableMinimap);
        defaultCanvasZoomInput.value = String(s.defaultCanvasZoom);
        refreshSpecimen();
    }

    return { panel: editorPanel, populate };
}
