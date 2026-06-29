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

/** The rail's inner markup: the head (axis switch + collapse control) over the navigator host (Domain
 *  pane + Files pane), plus the collapsed-state icon spine (#left-strip) the morph-collapse reveals. */
export function leftRailMarkup(): string {
  return `
    <!-- Rail head: the Domain·Files axis switch and the collapse control on one row. The axis switch is a
         segmented control choosing which navigator the rail shows (Domain = the DDD construct/context
         navigator; Files = the workspace .koi tree). The collapse button tucks the whole rail to its icon
         spine (#left-strip below); both are wired in inspectorController. -->
    <div class="rail-head">
      <div id="rail-axis-switch" class="rail-axis-switch" role="tablist" aria-label="Navigator axis">
        <button type="button" class="rail-axis" id="rail-axis-domain" role="tab" data-axis="domain" aria-selected="true" aria-controls="rail-domain-pane">Domain</button>
        <button type="button" class="rail-axis" id="rail-axis-files" role="tab" data-axis="files" aria-selected="false" aria-controls="rail-files">Files</button>
      </div>
      <button type="button" id="rail-collapse" class="rail-collapse" title="Collapse the navigator" aria-label="Collapse the navigator" aria-controls="leftrail" aria-expanded="true">
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 4 5.5 8l4 4" /></svg>
      </button>
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
    <!-- Collapsed-state icon spine (#730): shown only when #split carries .left-collapsed (CSS morph in
         _leftrail.scss hides the head + navigator and reveals this). Mirrors the right rail's stripe idiom —
         the expand control re-opens to the current axis; the Domain/Files toggles re-open straight to that
         axis. Wired in inspectorController alongside the axis switch + collapse button. -->
    <nav id="left-strip" class="left-strip" aria-label="Navigator (collapsed)">
      <button type="button" class="lstrip-btn lstrip-expand" data-lexpand title="Expand the navigator" aria-label="Expand the navigator" aria-controls="leftrail">
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4l4 4-4 4" /></svg>
      </button>
      <button type="button" class="lstrip-btn" data-laxis="domain" title="Domain" aria-label="Domain navigator" aria-pressed="true">
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.4" r="1.7" /><circle cx="3.8" cy="12.2" r="1.7" /><circle cx="12.2" cy="12.2" r="1.7" /><path d="M8 5.1v2.4M8 7.5H3.8v3M8 7.5h4.2v3" /></svg>
      </button>
      <button type="button" class="lstrip-btn" data-laxis="files" title="Files" aria-label="Files navigator" aria-pressed="false">
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 4.6c0-.6.4-1 1-1h2.5l1.1 1.3h5.6c.6 0 1 .5 1 1v5.9c0 .6-.4 1-1 1H3.4c-.6 0-1-.4-1-1z" /></svg>
      </button>
    </nav>`;
}
