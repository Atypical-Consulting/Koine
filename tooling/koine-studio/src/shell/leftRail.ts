// leftRail: the single source of truth for the left sidebar's INNER markup (#453). ide.tsx's boot
// injects this into <aside id="leftrail"> before any el(...) lookup, so index.html stays a thin shell
// and the rail can never drift from the ids the controller queries.
//
// The rail is a DDD "Domain" navigator, not a section stack: a labelled Domain·Files axis switch over
// one navigator host, plus a slim documentation footer. The Domain axis is the default; the Files axis
// holds the workspace .koi tree (#filetree-body — the file explorer's mount). The axis show/hide wiring
// and the strategic/tactical Domain renderers land in later tasks; this establishes the markup only —
// Domain visible, Files hidden — so #filetree-body stays present and functional.
//
// What moved: the former Explorer + Overview sections are gone (Overview deleted outright; the construct
// tree now mounts into #rail-domain-pane). Context Map + Ubiquitous Language left the docs footer for the
// strategic Domain view (a later task); only ADR + Notes remain here.

/** The rail's inner markup: the axis switch, the navigator host (Domain pane + Files pane) and the docs footer. */
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
    </div>
    <!-- Documentation footer: shortcuts into the model's prose surfaces. Context Map + Ubiquitous Language
         moved into the Domain axis (a later task rebuilds them in the strategic view); ADR + Notes stay
         here. These are navigation, so they wear the toolbar's stroked line-icon idiom. Wired in
         inspectorController via [data-doclink]. -->
    <nav id="rail-docs-body" class="rail-docs-foot" aria-label="Documentation">
      <ul class="koi-doclinks">
        <li>
          <button type="button" class="koi-doclink" data-doclink="adr" title="Architecture Decision Records">
            <svg class="tb-ico koi-doclink-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2.5h4.6L12 5.9V13.5H4Z" /><path d="M8.4 2.5v3.2h3.2" /><path d="M5.8 9.6 7.2 11 10 7.9" />
            </svg>
            <span class="koi-doclink-label">ADR</span>
          </button>
        </li>
        <li>
          <button type="button" class="koi-doclink" data-doclink="notes" title="Free-form notes on the model">
            <svg class="tb-ico koi-doclink-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10.4 3.1 12.9 5.6 6.1 12.4 3 13 3.6 9.9Z" /><path d="M9.2 4.3 11.7 6.8" />
            </svg>
            <span class="koi-doclink-label">Notes</span>
          </button>
        </li>
      </ul>
    </nav>`;
}
