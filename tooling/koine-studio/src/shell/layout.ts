// The view-layout controller, extracted from ide.tsx's init() (#757). Owns the #split data-* attribute
// mirroring (panel side / side-rail side), the inspector + left-rail edge resizers (and their re-wiring
// when the side-rail side flips), the left-sidebar section disclosure, the file-tree (⌘B) toggle, and
// the layout palette actions (LayoutActions). View-only state — persisted in localStorage via
// layoutStore, NEVER the .koi model.
//
// Pure structural lift: every closure keeps its exact logic; it just moves out of init() and reaches the
// shell (the #split element, the inspector's axis switch, the chrome-collapse store toggles) through the
// injected `deps`.
import { initEdgeResizer } from '@/shell/resize';
import { loadLayout, saveLayout, type LayoutState } from '@/shell/layoutStore';
import { type LayoutActions } from '@/shell/layoutCommands';

export interface LayoutControllerDeps {
  /** The #split grid host whose data-* attributes drive the layout reflow + the resizers' target. */
  splitEl: HTMLElement;
  /** Switch the left rail's axis (the inspector controller owns + persists it) — drives ⌘B. */
  setAxis(axis: 'files' | 'domain'): void;
  /** Flip the right Properties panel's collapse flag (uiChrome slice). */
  toggleRightCollapsed(): void;
  /** Flip the left navigator rail's collapse flag (uiChrome slice). */
  toggleLeftCollapsed(): void;
}

export interface LayoutController {
  /** The layout palette actions (split/panel/rail toggles), consumed by the command surface. */
  readonly actions: LayoutActions;
  /** ⌘B: show/hide the file tree by flipping the rail's Domain↔Files axis. */
  toggleFileTree(): void;
  /** Release the edge resizers + the section-disclosure listeners. */
  dispose(): void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function createLayoutController(deps: LayoutControllerDeps): LayoutController {
  const { splitEl } = deps;
  const filesSect = el<HTMLElement>('rail-files');

  // View-only state (orientation / panel side / side-rail side / whether the split is open and on which
  // uri), persisted in localStorage via layoutStore — it NEVER round-trips into the .koi model. On boot
  // we read it, paint #split's data-* attributes (CSS reflows the grid), and anchor the inspector /
  // left-rail resizers on the side each pane currently sits.
  // `let` (not const): each layout action below reassigns it from saveLayout's MERGED return value, so
  // that return is the single source of truth the next action reads (no per-field manual shadow).
  let layout = loadLayout();

  // Mirror the layout enums onto #split as data-* attributes; _split.scss keys the grid off them
  // (data-panel-side docks the bottom panel bottom/right; data-siderail-side moves the inspector rail
  // left/right).
  function applyLayoutAttrs(l: LayoutState): void {
    splitEl.dataset.panelSide = l.panelSide;
    splitEl.dataset.siderailSide = l.sideRail;
  }
  applyLayoutAttrs(layout);

  // The inspector + left-rail resizers anchor to the side each pane sits on. With the default layout the
  // inspector is the right rail and the file-rail is the left, so this matches the historical wiring;
  // when sideRail==='left' the two swap. Each resizer's disposer is kept so a live side-rail/panel/
  // orientation toggle can tear the stale wiring down and re-init with the new anchor — the handle then
  // drags correctly without a reload.
  let disposeInspectorResizer: () => void;
  let disposeLeftRailResizer: () => void;

  // (Re)wire the inspector + left-rail handles from the current sideRail side. Disposes any prior wiring
  // first so toggling never stacks listeners (and the stale anchor never lingers).
  function wireRailResizers(sideRail: LayoutState['sideRail']): void {
    disposeInspectorResizer?.();
    disposeLeftRailResizer?.();
    const inspectorOnRight = sideRail === 'right';
    disposeInspectorResizer = initEdgeResizer({
      target: splitEl,
      handle: el('split-resizer'),
      cssVar: '--koi-inspector-w',
      anchor: inspectorOnRight ? 'right' : 'left',
      storageKey: 'koine.studio.splitWidth',
      min: 220,
    });
    // Left sidebar width — the single rail (Files / Explorer / Overview / Documentation).
    disposeLeftRailResizer = initEdgeResizer({
      target: splitEl,
      handle: el('leftrail-resizer'),
      cssVar: '--koi-leftrail-w',
      anchor: inspectorOnRight ? 'left' : 'right',
      storageKey: 'koine.studio.leftrailWidth',
      min: 200,
      max: (w) => w * 0.5,
    });
  }

  wireRailResizers(layout.sideRail);

  // The layout palette commands' effects: each persists the change via saveLayout, then re-applies the
  // #split data-* attributes (CSS does the reflow). The toggles flip the corresponding enum AND re-wire
  // the affected resizer so its drag handle is live immediately (no reload). The persisted state is what
  // boot reads, so the arrangement survives a reload too.
  const actions: LayoutActions = {
    togglePanelSide() {
      const next = layout.panelSide === 'bottom' ? 'right' : 'bottom';
      layout = saveLayout({ panelSide: next });
      applyLayoutAttrs(layout);
    },
    toggleSideRail() {
      const next = layout.sideRail === 'right' ? 'left' : 'right';
      layout = saveLayout({ sideRail: next });
      applyLayoutAttrs(layout);
      wireRailResizers(next); // re-point the inspector + left-rail handles to their swapped anchors live
    },
    toggleProperties() {
      // The right Properties panel's collapse flag is owned by the uiChrome slice; inspectorController
      // subscribes to it and reconciles the DOM + persistence (the #500 stripe wiring), so the command
      // just flips the slice. The stripe icons and this command therefore stay in lock-step.
      deps.toggleRightCollapsed();
    },
    toggleNavigator() {
      // Symmetric to toggleProperties (#730): the left navigator rail's collapse flag is owned by the
      // uiChrome slice and reconciled by inspectorController's morph-collapse wiring, so the command just
      // flips the slice — the head's collapse button, the spine, and this command stay in lock-step.
      deps.toggleLeftCollapsed();
    },
  };

  // Open/collapse a left-sidebar section, keeping its header's aria-expanded in step. The single source
  // of truth for section state.
  function setRailSectionOpen(sect: HTMLElement, open: boolean): void {
    sect.dataset.open = open ? 'true' : 'false';
    sect.querySelector('.rail-sect-head')?.setAttribute('aria-expanded', String(open));
  }

  // Left-sidebar section disclosure: clicking a header collapses/expands its body (routed through
  // setRailSectionOpen, the single source of truth for section state).
  const sectionHeads: Array<{ head: HTMLButtonElement; onClick: () => void }> = [];
  for (const head of Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-sect-head'))) {
    const onClick = (): void => {
      const sect = head.closest<HTMLElement>('.rail-sect');
      if (sect) setRailSectionOpen(sect, sect.dataset.open === 'false');
    };
    head.addEventListener('click', onClick);
    sectionHeads.push({ head, onClick });
  }

  // Since #453 the rail's AXIS (Domain vs Files) is the single source of truth for the file tree's
  // visibility — the inspector controller's setAxis owns + persists it (RAIL_AXIS_KEY) and applyAxis
  // toggles the Files pane. The rail DEFAULTS to Domain (the DDD navigator); the file tree is reached
  // deliberately via ⌘B / the Files button / "Reveal in Files".
  function toggleFileTree(): void {
    // ⌘B shows/hides "the file tree", which since #453 lives on the rail's Files axis — so this toggles
    // the Domain↔Files axis (the controller owns + persists the axis, and re-expands the Files section
    // when it surfaces). When the Files pane is hidden the Domain view holds the rail, so ⌘B reveals it.
    deps.setAxis(filesSect.hidden ? 'files' : 'domain');
  }

  return {
    actions,
    toggleFileTree,
    dispose() {
      disposeInspectorResizer?.();
      disposeLeftRailResizer?.();
      for (const { head, onClick } of sectionHeads) head.removeEventListener('click', onClick);
    },
  };
}
