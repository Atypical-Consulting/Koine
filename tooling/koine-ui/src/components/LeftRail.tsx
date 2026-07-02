import type { JSX } from 'preact';

// LeftRail: a left sidebar's inner markup as a Preact component — Koine Studio's #759 migration off an
// imperative `leftRailMarkup()` string builder injected via innerHTML at boot. Moved here verbatim
// (issue #905, Task 4). The host keeps its `<aside id="leftrail">` a thin shell; it renders this into it
// before any imperative lookup into the ids below.
//
// The rail is a DDD "Domain" navigator: a labelled Domain·Files axis switch over one navigator host. The
// Domain axis is the default; the Files axis holds a workspace tree. The axis show/hide wiring, the
// collapse control, and the collapsed-state spine toggles are all owned by the consuming app (in Koine
// Studio, `inspectorController`), which captures these ids/nodes after mount — so LeftRail renders ONCE
// and never re-renders (no store subscription), and the imperative children that mount into
// `#rail-domain-pane` (a Domain navigator) and `#filetree-body` (a file explorer) are never reconciled
// away. Those two hosts stay empty here, filled imperatively after mount by the consuming app. Every id
// a host queries is preserved verbatim, so behaviour is unchanged from the original string builder.

/** The collapse chevron (points left — tuck the rail to its spine). */
const collapseIcon: JSX.Element = <path d="M9.5 4 5.5 8l4 4" />;
/** The spine expand chevron (points right — re-open the rail). */
const expandIcon: JSX.Element = <path d="M6.5 4l4 4-4 4" />;
/** Domain spine glyph — a small construct/context graph node cluster. */
const domainIcon: JSX.Element = (
  <>
    <circle cx="8" cy="3.4" r="1.7" />
    <circle cx="3.8" cy="12.2" r="1.7" />
    <circle cx="12.2" cy="12.2" r="1.7" />
    <path d="M8 5.1v2.4M8 7.5H3.8v3M8 7.5h4.2v3" />
  </>
);
/** Files spine glyph — a folder. */
const filesIcon: JSX.Element = <path d="M2.4 4.6c0-.6.4-1 1-1h2.5l1.1 1.3h5.6c.6 0 1 .5 1 1v5.9c0 .6-.4 1-1 1H3.4c-.6 0-1-.4-1-1z" />;

export function LeftRail(): JSX.Element {
  return (
    <>
      {/* Rail head: the Domain·Files axis switch + the collapse control on one row (both wired by the
          consuming host). The axis switch chooses which navigator the rail shows; the collapse button
          tucks the whole rail to its icon spine (#left-strip below). */}
      <div class="rail-head">
        <div id="rail-axis-switch" class="rail-axis-switch" role="tablist" aria-label="Navigator axis">
          <button
            type="button"
            class="rail-axis"
            id="rail-axis-domain"
            role="tab"
            data-axis="domain"
            aria-selected="true"
            aria-controls="rail-domain-pane"
          >
            Domain
          </button>
          <button
            type="button"
            class="rail-axis"
            id="rail-axis-files"
            role="tab"
            data-axis="files"
            aria-selected="false"
            aria-controls="rail-files"
          >
            Files
          </button>
        </div>
        <button
          type="button"
          id="rail-collapse"
          class="rail-collapse"
          title="Collapse the navigator"
          aria-label="Collapse the navigator"
          aria-controls="leftrail"
          aria-expanded="true"
        >
          <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
            {collapseIcon}
          </svg>
        </button>
      </div>
      <div id="rail-navigator-body" class="rail-navigator-body">
        {/* Domain axis: the DDD construct/context navigator. A navigator panel mounts into this host
            (imperatively, by the consuming host); a later task swaps in the strategic/tactical renderers.
            Visible by default — left empty here, filled imperatively. */}
        <div id="rail-domain-pane" class="rail-pane" role="tabpanel" aria-labelledby="rail-axis-domain" />
        {/* Files axis: a workspace file tree, hidden until the Files axis is selected. The #filetree-*
            ids are the file explorer's mount (#filetree-body) and the workspace-name label
            (#filetree-title); the consuming host's boot wires both — #filetree-body is left empty here,
            filled by the explorer island. */}
        <section
          class="rail-sect rail-files-pane"
          id="rail-files"
          data-open="true"
          role="tabpanel"
          aria-labelledby="rail-axis-files"
          hidden
        >
          <div class="rail-sect-head-row">
            <button type="button" class="rail-sect-head" aria-expanded="true" aria-controls="filetree-body">
              Files
            </button>
            <span id="filetree-title" class="rail-sect-meta">
              Scratch
            </span>
          </div>
          <div class="rail-sect-body" id="filetree-body" />
        </section>
      </div>
      {/* Collapsed-state icon spine: shown only when the host's split container carries a collapsed
          state class (CSS morph hides the head + navigator and reveals this). Mirrors a right-rail
          stripe idiom; the expand control re-opens to the current axis, the Domain/Files toggles re-open
          straight to that axis. Wired by the consuming host alongside the axis switch + collapse button. */}
      <nav id="left-strip" class="left-strip" aria-label="Navigator (collapsed)">
        <button
          type="button"
          class="lstrip-btn lstrip-expand"
          data-lexpand
          title="Expand the navigator"
          aria-label="Expand the navigator"
          aria-controls="leftrail"
        >
          <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
            {expandIcon}
          </svg>
        </button>
        <button
          type="button"
          class="lstrip-btn"
          data-laxis="domain"
          title="Domain"
          aria-label="Domain navigator"
          aria-pressed="true"
        >
          <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
            {domainIcon}
          </svg>
        </button>
        <button
          type="button"
          class="lstrip-btn"
          data-laxis="files"
          title="Files"
          aria-label="Files navigator"
          aria-pressed="false"
        >
          <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
            {filesIcon}
          </svg>
        </button>
      </nav>
    </>
  );
}
