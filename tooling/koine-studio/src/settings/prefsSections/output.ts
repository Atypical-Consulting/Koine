// The Output section (extracted from prefs.ts, #987 task 4): the emit-target picker that drives the
// language the Generated preview emits.
//
// previewTarget is workspace-scopable (User/Workspace toggle) via the shared ScopeKit instance (built
// once in prefs.ts, #987 task 2 — @/settings/prefsSections/scopeKit), taken as a DEPENDENCY rather than
// built here, since the SAME kit instance also backs Editor's wordWrapRow/formatOnSaveRow and Advanced's
// traceRow, so its syncAll() sees every registered row.
//
// populate(s) here is JUST outputLang.refresh() — see the comment inline for why (issue #282). The
// assembler (mountPreferencesPane's populate()) calls it BEFORE scopeKit.syncAll(s) so the picker's
// cards exist before the scoped sync sets the selection — do not let syncAll run ahead of this call.
//
// This module must not import prefs.ts (no import cycles).
import type { Settings } from "@/settings/persistence";
import { langPicker, panel } from "@/settings/prefsControls";
import type { ScopeKit } from "@/settings/prefsSections/scopeKit";
import type { PrefsSection } from "@/settings/prefsSections/types";

/** What buildOutputSection needs from its host: the shared ScopeKit instance that backs the
 *  previewTarget scoped binding (and Editor's / Advanced's own scoped rows). Output routes its only
 *  field (previewTarget) entirely through scopeKit, not through a SectionCtx commit/onChange path — so
 *  unlike most other sections, this builder takes no {@link import('@/settings/prefsSections/types').SectionCtx}. */
export interface OutputSectionDeps {
    scopeKit: ScopeKit;
}

export function buildOutputSection(deps: OutputSectionDeps): PrefsSection {
    const { scopeKit } = deps;

    // previewTarget is workspace-scopable. Route the picker's commit through the shared scope binding
    // (User → global blob; Workspace → the override store) and surface its User/Workspace toggle in the
    // output block's heading row.
    const outputScope = scopeKit.makeScopeBinding(
        "previewTarget",
        "Output language",
        (t) => outputLang.set(t),
    );
    const outputLang = langPicker((target) => outputScope.scopedCommit(target));

    // Output lays the picker out full-width under its own heading (not a narrow label/control row) so
    // the four language cards have room to breathe and the caption can say what actually changes.
    const outputText = document.createElement("div");
    outputText.className = "koi-set-text";
    const outputLabel = document.createElement("span");
    outputLabel.className = "koi-set-label";
    outputLabel.textContent = "Output language";
    const outputDesc = document.createElement("span");
    outputDesc.className = "koi-set-desc";
    outputDesc.textContent =
        "The language the Generated preview emits. Your .koi source stays the same — switch any time.";
    outputText.append(outputLabel, outputDesc);

    // The heading row carries the caption on the left and the User/Workspace scope toggle on the right.
    const outputHead = document.createElement("div");
    outputHead.className = "koi-output-head";
    outputHead.append(outputText, outputScope.seg);

    const outputBlock = document.createElement("div");
    outputBlock.className = "koi-output-block";
    outputBlock.append(outputHead, outputLang.el);

    const outputPanel = panel("output", outputBlock);

    function populate(_s: Settings): void {
        // Rebuild the language cards from the live EMIT_TARGETS first: the picker was constructed during
        // init() (before the backend seed), so a backend-seeded target only appears once this re-renders
        // on open (issue #282). The scoped sync (scopeKit.syncAll, called by the assembler right after
        // this section's populate) then sets its selection to the effective target.
        outputLang.refresh();
    }

    return { panel: outputPanel, populate };
}
