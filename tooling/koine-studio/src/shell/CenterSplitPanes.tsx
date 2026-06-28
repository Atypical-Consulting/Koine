// CenterSplitPanes — manages split-pane DOM inside #center-body.
//
// ## User-facing feature (issue #720)
// The "Split →" and "Split ↓" buttons in the center tab bar call `splitCenter('row')` /
// `splitCenter('column')` on the app store. The "Reset" button (visible when 2+ panes are open)
// calls `setCenterLayout(DEFAULT_CENTER_LAYOUT)` to return to a single pane. These controls live
// in the `SplitControls` Preact component rendered by `inspectorController.tsx` into
// `#center-split-controls` at the right end of `#center-tabs`. The `centerLayout` store subscription
// keeps the controls and this module's DOM in sync whenever the layout changes.
//
// ## DOM management
// In single-pane mode: a no-op (removes any leftover split structure).
// In N-pane mode: creates/updates .center-split-pane slots and moves the four
// center-host elements (#center-visual, #center-technical, #center-docs,
// #view-assistant) into their respective pane's .center-pane-content div.
//
// The per-pane view selector is rendered as a small Preact component into each
// pane's .center-pane-selector div so the user can switch views per-pane.
//
// Between every adjacent pair of pane slots, a .center-splitter-host div is
// inserted and a CenterSplitter Preact component is mounted into it, providing
// keyboard- and pointer-driven resize (WCAG 2.1 AA SC 2.1.1 / SC 4.1.2).
import { render } from 'preact';
import type { CenterLayout, CenterView } from '@/store/slices/uiChrome';
import { CenterSplitter } from '@/shell/CenterSplitter';

// --- PaneSelector component --------------------------------------------------

const VIEW_LABELS: Record<CenterView, string> = {
  visual: 'Visual',
  technical: 'Code',
  docs: 'Docs',
};

const ALL_VIEWS: CenterView[] = ['visual', 'technical', 'docs'];

function PaneSelector({
  layout,
  paneId,
  onSelect,
}: {
  layout: CenterLayout;
  paneId: string;
  onSelect: (paneId: string, view: CenterView) => void;
}) {
  const pane = layout.panes.find((p) => p.id === paneId);
  if (!pane) return null;
  return (
    <div class="center-pane-header" role="tablist" aria-label="Pane view">
      {ALL_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={String(pane.view === v) as 'true' | 'false'}
          class="center-pane-tab"
          onClick={(e) => {
            // Prevent the click from bubbling to the pane's own click handler,
            // which would focus the pane (already done by onSelect) + applyCenterChrome.
            e.stopPropagation();
            onSelect(paneId, v);
          }}
        >
          {VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

// --- The IDs of the four center views ----------------------------------------
// The center-host sections live in #center-body and are moved into pane slots.
const CENTER_VIEW_IDS: Record<CenterView, string> = {
  visual: 'center-visual',
  technical: 'center-technical',
  docs: 'center-docs',
};

// --- applySplitPaneLayout ----------------------------------------------------

export interface SplitPaneLayoutDeps {
  /** The rendered center body element (#center-body). */
  centerBodyEl: HTMLElement;
  /** Get the latest center layout state. */
  getLayout(): CenterLayout;
  /** Called when user clicks a view-selector tab button (pane-local view switch). */
  onPaneViewSelect(paneId: string, view: CenterView): void;
  /** Called when user clicks the pane itself to focus it. */
  onPaneFocus(paneId: string): void;
  /** Called by the splitter to update fractional sizes. */
  onResize(sizes: number[]): void;
}

/** Apply or tear down the split-pane layout in #center-body.
 *
 *  - Single pane: remove all .center-split-pane slots and restore the center-host
 *    elements directly in #center-body (position:absolute fills the body).
 *  - Multi pane: create/update .center-split-pane slots, move each center-host
 *    element into the matching pane's .center-pane-content area, size by flex.
 */
export function applySplitPaneLayout(deps: SplitPaneLayoutDeps): void {
  const { centerBodyEl, getLayout, onPaneViewSelect, onPaneFocus, onResize } = deps;
  const layout = getLayout();

  if (layout.panes.length <= 1) {
    // --- single-pane mode: clean up any existing split ---
    cleanupSplitPanes(centerBodyEl);
    return;
  }

  // --- multi-pane mode ---
  centerBodyEl.dataset.split = layout.orientation;

  // Build a map of existing pane slots (keyed by pane-id) for reuse.
  const existingSlots = new Map<string, HTMLElement>();
  for (const slot of Array.from(centerBodyEl.querySelectorAll<HTMLElement>('.center-split-pane'))) {
    const id = slot.dataset.paneId;
    if (id) existingSlots.set(id, slot);
  }

  // Build/update a slot per pane; move DOM elements into the slots in order.
  const usedIds = new Set<string>();
  const orderedSlots: HTMLElement[] = [];

  for (let i = 0; i < layout.panes.length; i++) {
    const pane = layout.panes[i];
    usedIds.add(pane.id);

    // Reuse or create the slot element.
    let slot = existingSlots.get(pane.id);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'center-split-pane';
      slot.dataset.paneId = pane.id;

      // The pane body is click-to-focus (the pane's OUTER div, not the tab buttons).
      slot.addEventListener('click', () => onPaneFocus(pane.id));

      // Create the selector and content child divs once.
      const selectorDiv = document.createElement('div');
      selectorDiv.className = 'center-pane-selector';
      const contentDiv = document.createElement('div');
      contentDiv.className = 'center-pane-content';
      slot.appendChild(selectorDiv);
      slot.appendChild(contentDiv);
    }

    // Update size.
    slot.style.flex = String(layout.sizes[i]);

    // Update focused indicator (data attribute only — aria-selected is not valid on a plain div).
    slot.classList.toggle('is-focused', pane.id === layout.focusedPaneId);
    slot.dataset.focused = String(pane.id === layout.focusedPaneId);

    // Move the matching center-host element into this pane's content div.
    const contentDiv = slot.querySelector<HTMLElement>('.center-pane-content')!;
    const viewEl = document.getElementById(CENTER_VIEW_IDS[pane.view]);
    if (viewEl && viewEl.parentElement !== contentDiv) {
      contentDiv.appendChild(viewEl);
    }

    // Re-render the pane selector (Preact reconciles efficiently on re-renders).
    const selectorDiv = slot.querySelector<HTMLElement>('.center-pane-selector')!;
    render(
      <PaneSelector layout={layout} paneId={pane.id} onSelect={onPaneViewSelect} />,
      selectorDiv,
    );

    orderedSlots.push(slot);
  }

  // Remove pane slots that are no longer in the layout.
  for (const [id, slot] of existingSlots) {
    if (!usedIds.has(id)) {
      // Return any center-host child back to #center-body before removing the slot.
      for (const viewEl of Array.from(slot.querySelectorAll<HTMLElement>('.center-host'))) {
        centerBodyEl.appendChild(viewEl);
      }
      // Also return non-.center-host elements that happen to be center view IDs.
      for (const viewId of Object.values(CENTER_VIEW_IDS)) {
        const viewEl = slot.querySelector(`#${viewId}`);
        if (viewEl) centerBodyEl.appendChild(viewEl);
      }
      render(null, slot.querySelector<HTMLElement>('.center-pane-selector')!);
      slot.remove();
    }
  }

  // Collect existing splitter hosts (keyed by splitter index) for reuse.
  const existingSplitterHosts = new Map<number, HTMLElement>();
  for (const host of Array.from(centerBodyEl.querySelectorAll<HTMLElement>('.center-splitter-host'))) {
    const idx = parseInt(host.dataset.splitterIndex ?? '-1', 10);
    if (idx >= 0) existingSplitterHosts.set(idx, host);
  }

  // Build the interleaved sequence: [pane0, splitter0, pane1, splitter1, pane2, …]
  // We'll reconstruct this directly in centerBodyEl.
  const interleavedChildren: HTMLElement[] = [];
  for (let i = 0; i < orderedSlots.length; i++) {
    interleavedChildren.push(orderedSlots[i]);
    if (i < orderedSlots.length - 1) {
      // Get or create the splitter host for gap i.
      let host = existingSplitterHosts.get(i);
      if (!host) {
        host = document.createElement('div');
        host.className = 'center-splitter-host';
        host.dataset.splitterIndex = String(i);
      }
      // Mount/update the CenterSplitter Preact component.
      render(
        <CenterSplitter
          layout={layout}
          splitterIndex={i}
          containerEl={centerBodyEl}
          onResize={onResize}
        />,
        host,
      );
      interleavedChildren.push(host);
      existingSplitterHosts.delete(i);
    }
  }

  // Remove stale splitter hosts (e.g. going from 3 panes back to 2).
  for (const host of existingSplitterHosts.values()) {
    render(null, host);
    host.remove();
  }

  // Place interleaved children in order in centerBodyEl, leaving non-split children (the center-host
  // elements that may still be direct children) at the end (they are hidden via .center-host rules).
  for (let i = 0; i < interleavedChildren.length; i++) {
    const child = interleavedChildren[i];
    // Walk forward in the DOM to find or place this child at position i among the split children.
    // (We only reorder if needed to avoid unnecessary DOM mutations.)
    const splitChildren = Array.from(
      centerBodyEl.querySelectorAll<HTMLElement>('.center-split-pane, .center-splitter-host'),
    );
    if (splitChildren[i] !== child) {
      const refEl = splitChildren[i];
      if (refEl) {
        centerBodyEl.insertBefore(child, refEl);
      } else {
        centerBodyEl.appendChild(child);
      }
    }
  }
}

/** Remove all .center-split-pane slots and splitter hosts; return center-host elements to #center-body. */
function cleanupSplitPanes(centerBodyEl: HTMLElement): void {
  const slots = Array.from(centerBodyEl.querySelectorAll<HTMLElement>('.center-split-pane'));
  const splitterHosts = Array.from(centerBodyEl.querySelectorAll<HTMLElement>('.center-splitter-host'));

  if (slots.length === 0 && splitterHosts.length === 0) return;

  for (const slot of slots) {
    // Return any center-host children back to #center-body.
    for (const viewEl of Array.from(slot.querySelectorAll<HTMLElement>('.center-host'))) {
      centerBodyEl.appendChild(viewEl);
    }
    // Also return elements by their known IDs.
    for (const viewId of Object.values(CENTER_VIEW_IDS)) {
      const viewEl = slot.querySelector(`#${viewId}`);
      if (viewEl) centerBodyEl.appendChild(viewEl);
    }
    // Unmount any Preact trees in the selector host.
    const selectorDiv = slot.querySelector<HTMLElement>('.center-pane-selector');
    if (selectorDiv) render(null, selectorDiv);
    slot.remove();
  }

  // Unmount and remove splitter hosts.
  for (const host of splitterHosts) {
    render(null, host);
    host.remove();
  }

  // Remove the split data attribute.
  delete centerBodyEl.dataset.split;
}
