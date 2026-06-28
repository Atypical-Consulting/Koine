// leftRail: the single source of truth for the left sidebar's INNER markup (#453). ide.tsx's boot
// injects this into <aside id="leftrail"> before any el(...) lookup, so index.html stays a thin shell
// and the rail can never drift from the ids the controller queries.
//
// The rail is a DDD "Domain" navigator, not a section stack: a labelled Domain·Files axis switch over
// one navigator host. The Domain axis is the default; the Files axis holds the workspace .koi tree
// (#filetree-body — the file explorer's mount). The axis show/hide wiring and the strategic/tactical
// Domain renderers land in later tasks; this establishes the markup only — Domain visible, Files hidden —
// so #filetree-body stays present and functional.
//
// What moved: the former Explorer + Overview sections are gone (Overview deleted outright; the construct
// tree now mounts into #rail-domain-pane). The documentation footer (Context Map, Ubiquitous Language,
// ADR, Notes) is gone too (#730): Context Map + Glossary live in the Domain axis, and ADR + Notes are
// reached through the center Deck's Docs surface — so the rail no longer doubles as a docs doorway.

/** The rail's inner markup: the axis switch over the navigator host (Domain pane + Files pane). */
export function leftRailMarkup(): string {
  return `
    <!-- Domain·Files axis: a segmented control choosing which navigator the rail shows. Domain is the
         DDD construct/context navigator; Files is the workspace .koi tree. The active-axis wiring lands
         in a later task — Domain is the default here. -->
    <div id="rail-axis-switch" class="rail-axis-switch" role="tablist" aria-label="Navigator axis">
      <button type="button" class="rail-axis" id="rail-axis-domain" role="tab" data-axis="domain" aria-selected="true" aria-controls="rail-domain-pane">Domain</button>
      <button type="button" class="rail-axis" id="rail-axis-files" role="tab" data-axis="files" aria-selected="false" aria-controls="rail-files">Files</button>
    </div>
    <div id="rail-navigator-body" class="rail-navigator-body">
      <!-- Domain axis: the DDD construct/context navigator. The ModelOutlinePanel mounts here for now
           (inspectorController.loadModel); a later task swaps in the strategic/tactical renderers.
           Visible by default. -->
      <div id="rail-domain-pane" class="rail-pane" role="tabpanel" aria-labelledby="rail-axis-domain"></div>
      <!-- Files axis: the workspace .koi tree, hidden until the Files axis is selected (later task). The
           #filetree-* ids are the file explorer's mount (#filetree-body) and the workspace-name label
           (#filetree-title); ide.tsx's boot wires both, so they live here unchanged. -->
      <section class="rail-sect rail-files-pane" id="rail-files" data-open="true" role="tabpanel" aria-labelledby="rail-axis-files" hidden>
        <div class="rail-sect-head-row">
          <button type="button" class="rail-sect-head" aria-expanded="true" aria-controls="filetree-body">Files</button>
          <span id="filetree-title" class="rail-sect-meta">Scratch</span>
        </div>
        <div class="rail-sect-body" id="filetree-body"></div>
      </section>
    </div>`;
}
