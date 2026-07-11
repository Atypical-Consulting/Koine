// The center/deck + chrome orchestration — extracted from inspectorController (Task 4 of #985's
// decomposition, the last of the four). Owns: the CENTER "Deck" surfaces (Canvas / Code / Output / Docs)
// and their tab-level chrome (applyCenterChrome/syncCenterChrome/visibleCenters), the center-pane
// persistence (#980's captured center-persist subscription, #983's deck persistence) — but NOT the deck's
// initial restore, which moved to the facade (#1260, see `centerDeckInitialChrome` and the construction-
// reset block below) — the rail-axis switch (Domain vs Files, #453), the right-edge tool-window stripe
// (#500) + its collapse/expand/notify chrome, the left navigator morph-collapse (#730), the bottom strip's
// tabs/collapse/edge-resizer (#983, #475's narrow-viewport default), the viewport-resize cross handler's
// #475 re-evaluation, and the DeckStage/DeckSpine mount (moved out of the facade's `init()`).
//
// Deliberately standalone, like Tasks 1-3's sibling modules: this module never imports
// `@/shell/inspectorController` (the facade wires it in, never the reverse) and never imports the other
// task modules (contextMapPanel.tsx / activeContextController.ts / surfaceLoaders.tsx) — sub-modules
// don't import each other; only the facade wires cross-module effects, here via the injected `hooks`.
// The pure `deck` read behind `visibleCenters()` and the resize crossing detection are the store/facade-
// free `inspector/shared` helpers (#1262 — formerly this module's own copies of surfaceLoaders'/the
// facade's); this module binds them to its own store read / listener rather than injecting an accessor.
//
// Every DOM host this module touches is looked up here (its own `domById`/`domQueryAll` calls), never
// injected — unlike Task 1/3's single/plural `host(s)` field, this module owns dozens of chrome nodes, so
// self-contained lookups (mirroring the facade's OWN pre-extraction style) read more naturally than a
// large injected bag. Where a DOM id is ALSO needed by facade-owned code (e.g. `#view-preview`, painted by
// surfaceLoaders but toggled `hidden` here), each module does its OWN independent `domById()` call to the
// same id — the same duplication precedent `previewEl` already established pre-extraction.
import { render } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { KoineEditor } from '@/editor/editor';
import { domById, domQueryAll } from '@/shared/domById';
import {
  DATA_AXIS,
  DATA_LAXIS,
  DATA_RVIEW,
  LEFT_RAIL_IDS,
  RSTRIP_BTN_CLASS,
  axisButtonsSelector,
  lstripAxisButtonsSelector,
} from '@atypical/koine-ui';
import { isNarrowViewport } from '@/shared/breakpoint';
import { createLifecycleGuard } from '@/shared/lifecycleGuard';
import { createNarrowCrossHandler, visibleCenters as deckVisibleCenters } from '@/shell/inspector/shared';
import { loadLayout, saveLayout } from '@/shell/layoutStore';
import { readRaw, writeRaw } from '@/shell/storage';
import {
  isValidCenter,
  type BottomTab,
  type CenterView,
  type DeckState,
  type DocsView,
  type OutputTab,
  type RightView,
  type TechView,
  type UiChromeSlice,
} from '@/store/slices/uiChrome';
import type { SourceControlFocus } from '@/model/SourceControlPanel';
import { DeckSpineConnected } from '@/shell/deck/DeckSpine';
import { DeckStage } from '@/shell/deck/DeckStage';

/** Which top-level navigator the left rail shows (#453) — re-declared locally (structurally identical to
 *  the uiChrome slice's own `RailAxis`) so this module's public surface names it without importing a type
 *  solely for that purpose. */
export type RailAxis = 'domain' | 'files';

/** The write-path / persistence seams this module needs from `InspectorControllerDeps` — a locally
 *  redeclared structural subset (not a literal `Pick<InspectorControllerDeps, …>`, which would import the
 *  facade), mirroring `SurfaceLoadersDeps`/`ActiveContextControllerDeps`'s own subsets. */
export interface CenterDeckControllerDeps {
  /** Persist the legacy single-key center pane on every real change (kept alongside the Deck v2
   *  persistence below for whatever still reads it). */
  saveWorkspaceCenter(id: string): void;
  /** Persist the Deck v2 center layout on every real deck change. Optional so a caller that only wires the
   *  legacy pair doesn't need updating. Restoring the deck is no longer this module's job (#1260 — see the
   *  module doc on the construction-reset block): the facade computes it and seeds the store before this
   *  controller is even constructed, so there is no corresponding `loadWorkspaceDeck` read-path here. */
  saveWorkspaceDeck?: (deck: DeckState) => void;
  /** Bind a fixed-height resizer to a panel (ide.ts's resize.ts, injected to keep this module DOM-infra-free
   *  beyond its own element lookups). */
  initEdgeResizer(opts: {
    target: HTMLElement;
    handle: HTMLElement;
    container?: HTMLElement;
    cssVar: string;
    anchor: 'left' | 'right' | 'top' | 'bottom';
    storageKey: string;
    min: number;
    max: (size: number) => number;
  }): void;
}

/** The cross-module effects this module needs but doesn't own — every one is either facade-private state
 *  (the AI assistant panel, the Syntax Tree mount) or a call into a SIBLING task module (Task 3's
 *  surfaceLoaders) this module must never import directly. The facade implements every one of these
 *  (often as a thin wrapper around a sibling module's own method), so from this module's perspective they
 *  are opaque callbacks. Two extras beyond the brief's interface summary — `focusSourceControl` and
 *  `ensureAssistantShown` needing no split, `loadSyntaxTree` — are documented at their call sites below;
 *  they're the narrowest additions that keep a SINGLE load call per open (matching the pre-extraction
 *  stash-then-load sequence exactly) rather than importing anything. */
export interface CenterDeckControllerHooks {
  /** Lazy-load every surface currently visible under the deck state: the diagram (if visual is visible)
   *  plus each visible surface's active facet (Code's scenario runner, Output's Generated/Compatibility/
   *  Context Map, Docs' Glossary/ADR/Notes) — all of which need Task 3's surfaceLoaders or Task 1's
   *  contextMapPanel, so the whole function is facade-implemented and injected as one hook. */
  ensureVisibleLoaded(): void;
  /** Mount/refresh the Source Control right-rail panel (Task 3's `surfaceLoaders.loadSourceControl`) —
   *  called with no focus; a launcher focus (#1165) is stashed via `focusSourceControl` FIRST (mirroring
   *  the pre-extraction stash-then-load sequence, so this fires exactly once per open either way). */
  loadSourceControl(): void;
  /** Stash a launcher focus (#1165) — a specific file diff / commit — for Source Control's NEXT
   *  `loadSourceControl()` paint. Called before `selectRightView('source-control')` when a caller passes
   *  a focus to `selectRight`. */
  focusSourceControl(focus: SourceControlFocus): void;
  /** Reload the Syntax Tree right-rail panel (facade-owned mount + revision counter, #890 — untouched by
   *  this decomposition). */
  loadSyntaxTree(): void;
  /** Re-point the AI assistant at the current workspace + focus its input — the assistant panel is a
   *  facade-private lazy singleton (`deps.ensureAssistant`, not part of this module's own deps subset). */
  ensureAssistantShown(): void;
  /** Refresh the given bottom-strip tab if it needs it: Events/Relationships (Task 3's surfaceLoaders) or
   *  the lazily-created Terminal/Review panels (both facade-private — `deps.ensureTerminal`/
   *  `deps.ensureReview` are NOT part of this module's own deps subset; the hook owns the whole tab
   *  dispatch instead). */
  ensureBottomLoaded(tab: BottomTab): void;
}

export interface CenterDeckControllerOptions {
  /** The app state store — the same instance the facade was constructed with. */
  store: StoreApi<AppState>;
  /** The live editor handle (read-only here: a re-measure on reveal). */
  editor: Pick<KoineEditor, 'view'>;
  deps: CenterDeckControllerDeps;
  hooks: CenterDeckControllerHooks;
}

export interface CenterDeckController {
  selectCenter(view: CenterView): void;
  /** Show the transient, gear-launched Settings overlay (#482) over the deck. */
  showSettings(category?: string): void;
  /** Switch the left rail's active navigator axis (#453). */
  setAxis(axis: RailAxis): void;
  selectTech(view: TechView): void;
  selectOutput(view: OutputTab): void;
  selectDocsTab(view: DocsView): void;
  selectBottomTab(tab: BottomTab): void;
  /** Reveal a right-rail view, expanding the rail first if it was collapsed. */
  selectRight(view: RightView, focus?: SourceControlFocus): void;
  /** Switch the active right view WITHOUT touching the collapsed flag — the facade's own selection
   *  subscription (#533, still facade-owned — see the module doc) uses this for its "reveal Properties
   *  only while the rail is already expanded" branch, distinct from `selectRight`'s "expand THEN switch".
   *  Beyond the brief's interface summary; documented here as the narrowest addition that lets the facade
   *  reach this module's chrome without duplicating it. */
  selectRightView(view: RightView): void;
  /** Flash the Properties stripe button's attention cue (#648) — the facade's selection subscription calls
   *  this when a selection lands while the rail is collapsed. Beyond the brief's interface summary, for
   *  the same reason as `selectRightView`. */
  notifyRstripProps(): void;
  /** Apply the blessed Code ⟷ Canvas split preset. */
  splitCodeCanvas(): void;
  /** The center surfaces visible under the current deck state: all four in overview, else the primary
   *  (plus the secondary in a 2-up). */
  visibleCenters(): CenterView[];
  /** Pure chrome: surface the active center panel + its technical sub-view and mark the tabs. No data
   *  fetch — safe to call before the workspace document is open. */
  applyCenterChrome(): void;
  /** Boot the chrome into the restored mode (no fetch) + mount the DeckStage/DeckSpine. */
  init(): void;
  /** Cancel pending timers, drop every subscription, and unmount the deck Preact trees. */
  dispose(): void;
}

/** The pure chrome reset this controller applies at construction: every sub-view lands back on its
 *  default landing tab for the given (restored or default) deck. Extracted from the constructor's own
 *  `setState` call (#1260) so the facade can compute it and fold it into ITS OWN construction-time write —
 *  landing both in one atomic `setState` rather than two separate notifications. */
export function centerDeckInitialChrome(
  deck: DeckState,
): Pick<UiChromeSlice, 'deck' | 'center' | 'tech' | 'output' | 'docs' | 'bottom' | 'right'> {
  return {
    deck,
    center: deck.primary,
    tech: 'editor',
    output: 'generated',
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
  };
}

export function createCenterDeckController(options: CenterDeckControllerOptions): CenterDeckController {
  const { store, editor, deps, hooks } = options;

  // Mirrors the facade's own lifecycle guard (#1002): no async work of consequence lives in this module
  // (every fetch is behind an injected hook a sibling module already guards), but the guard still gates the
  // debounced notify-flash timer and the resize listener the same way the facade's own guard does.
  const lifecycle = createLifecycleGuard();

  // --- DOM hosts (looked up once; the same id surface init() builds, so a drift throws via domById()) ---
  const settingsPanelEl = document.getElementById('center-panel-settings'); // eslint-disable-line no-restricted-properties -- intentionally optional: absent from desktop-only test fixtures; applyCenterChrome skips the overlay toggle
  const centerBodyEl = domById('center-body');
  const deckBarEl = domById('deck-bar');
  const centerVisualEl = domById('center-visual');
  const centerTechnicalEl = domById('center-technical');
  const centerOutputEl = domById('center-output');
  const centerDocsEl = domById('center-docs');
  const editorPaneEl = domById('editor-pane');
  const scenariosView = domById('view-scenarios');
  const previewEl = domById('view-preview');
  const checkView = domById('view-check');
  const contextMapView = domById('panel-contextmap');
  const glossaryView = domById('view-glossary');
  const adrView = domById('view-docs');
  const notesView = domById('view-notes');
  // The four center surfaces, handed to the DeckStage which hosts each in its card body.
  const centerHosts: Record<CenterView, HTMLElement> = {
    visual: centerVisualEl,
    technical: centerTechnicalEl,
    output: centerOutputEl,
    docs: centerDocsEl,
  };

  // Right rail hosts.
  const inspectorHost = domById('inspector-host');
  const assistantView = domById('view-assistant');
  const sourceControlRightView = domById('rview-source-control');
  const syntaxTreeRightView = domById('rview-syntax-tree');

  // Bottom-panel hosts.
  const diagEl = domById('diagnostics');
  const diagBodyEl = domById('diag-body');
  const diagCountEl = domById('diag-count');
  const eventsPanel = domById('panel-events');
  const relationshipsPanel = domById('panel-relationships');
  const terminalPanel = domById('panel-terminal');
  const reviewPanel = domById('panel-review');

  // --- center/deck construction reset: OWNED BY THE CALLER, NOT THIS MODULE (#1260) -------------------
  // This module no longer restores or resets the deck/chrome itself. The facade computes the restored (or
  // defaulted) deck and applies `centerDeckInitialChrome(deck)` as part of ITS OWN construction-time
  // `setState` — before constructing this controller — so the whole boot-time reset (facade fields +
  // this module's chrome) lands as one write, before ANY subscriber exists anywhere (this module's own
  // subscriptions below included). Previously this module applied `centerDeckInitialChrome` in its OWN
  // separate `setState` call here, which ran AFTER the facade's earlier-constructed subscriptions (e.g.
  // activeContextController's) were already live — letting a subscriber observe a torn reset (the facade's
  // fields already reset, this module's chrome still stale) for one tick. A test harness that constructs
  // this controller directly (not through the facade) must likewise seed the store via
  // `centerDeckInitialChrome(deck)` before calling `createCenterDeckController` — see
  // centerDeckController.test.tsx's `makeController`.

  // Persist the active center pane across reloads: on a real, valid center change, write it through.
  // #985 Task 4 deletes the closure-mirror `persistedCenter` guard (#980) that used to sit alongside this
  // subscription, replacing it with a direct comparison against the subscription's OWN `prev` snapshot.
  // `center` is a plain uiChrome field (unlike surfaceLoaders' `dirtyCount()`, a METHOD that closes over
  // the store's live `get()` — calling it on a `prev` snapshot would silently read the CURRENT state, not
  // the snapshot's), so reading `prev.center` directly is safe and correct here. `isValidCenter` is
  // defensive: `s.center` is typed `CenterView`, so this store's own actions can never actually produce an
  // invalid value — the guard only ever rejects one forced in by surrounding code that bypasses the type
  // (a legacy caller, or a test). One small observable delta versus the old mirror: a
  // valid → (forced-)invalid → same-valid round-trip now RE-persists the final value once more than
  // before (the old mirror never advanced past the invalid detour, so the revert read as a no-op; this
  // guard sees a genuine `prev` transition on that last hop) — idempotent and harmless, not worth guarding
  // further (the brief calls this out explicitly rather than asking for a fix).
  const unsubscribeCenterPersist = store.subscribe((s, prev) => {
    if (s.center === prev.center) return;
    if (!isValidCenter(s.center)) return;
    deps.saveWorkspaceCenter(s.center);
  });

  // --- center chrome -----------------------------------------------------------
  const activeCenter = (): CenterView => store.getState().center as CenterView;
  const activeTech = (): TechView => store.getState().tech as TechView;
  const activeDocs = (): DocsView => store.getState().docs as DocsView;
  const activeOutput = (): OutputTab => store.getState().output as OutputTab;
  const activeBottomTab = (): BottomTab => store.getState().bottom;

  // The center surfaces visible under the current deck state — the shared pure `deck` read (#1262,
  // formerly this module's own copy), bound to this module's store here so the public zero-arg
  // `visibleCenters()` contract is unchanged.
  function visibleCenters(): CenterView[] {
    return deckVisibleCenters(store.getState().deck);
  }

  // Pure chrome: surface the active center panel + its technical sub-view and mark the tabs, all read
  // from the uiChrome slice (#193) — the single source of truth the mode buttons and tab clicks write, so
  // the highlighted tab and the shown view can never diverge. No data fetch, so the boot frame can land
  // before the workspace document is open.
  function applyCenterChrome(): void {
    const tech = activeTech();
    const output = activeOutput();
    const docs = activeDocs();
    const vis = visibleCenters();

    // Settings (#482) is a transient overlay, NOT a deck surface: when `settingsOpen`, it covers the deck
    // body and the deck-bar stays as the way back. The host is optional (absent from desktop-only test
    // fixtures), so guard the toggle.
    const settingsOpen = store.getState().settingsOpen;
    if (settingsPanelEl) settingsPanelEl.hidden = !settingsOpen;
    centerBodyEl.hidden = settingsOpen;

    // The bottom strip (Problems/Events/Relationships/Terminal/Review) is GLOBAL: it serves every center
    // view and is hidden only by its own collapse toggle (#diag-collapse), never by the active view.
    diagEl.hidden = false;
    // …but on a NARROW viewport the reading-heavy Documentation view DEFAULTS the strip collapsed so the
    // reading pane keeps full height on a phone (#475). Re-evaluated on every center switch and gated so an
    // explicit user collapse preference always wins; desktop + the working views keep the expanded default.
    applyDefaultDiagCollapsed();

    // Each surface keeps its body sub-views; a sub-view is shown when its surface is visible (primary,
    // secondary, or any in overview) AND it is that surface's active facet.
    const techVisible = vis.includes('technical');
    editorPaneEl.hidden = !(techVisible && tech === 'editor');
    scenariosView.hidden = !(techVisible && tech === 'scenarios');
    const outputVisible = vis.includes('output');
    previewEl.hidden = !(outputVisible && output === 'generated');
    checkView.hidden = !(outputVisible && output === 'compatibility');
    contextMapView.hidden = !(outputVisible && output === 'contextmap');
    const docsVisible = vis.includes('docs');
    glossaryView.hidden = !(docsVisible && docs === 'glossary');
    adrView.hidden = !(docsVisible && docs === 'adr');
    notesView.hidden = !(docsVisible && docs === 'notes');
    // CodeMirror measures lazily; revealing it from display:none leaves stale geometry until the next
    // layout tick, so force a re-measure whenever the editor becomes visible.
    if (!editorPaneEl.hidden) editor.view.requestMeasure();
  }

  // Apply the center chrome AND load whatever is now visible — the single sync point the deck/facet
  // subscription drives. The lazy-load half is entirely facade-implemented (see the hook's own doc).
  function syncCenterChrome(): void {
    applyCenterChrome();
    hooks.ensureVisibleLoaded();
  }

  function selectCenter(view: CenterView): void {
    // Plain "show this surface" = focus it 1-up; the deck subscription applies the chrome + lazy-loads.
    store.getState().focusPrimary(view);
  }

  // Show the transient Settings overlay (#482) over the deck. It's NOT a deck surface, so this flips the
  // orthogonal `settingsOpen` flag rather than routing through focusPrimary — the deck state (and its
  // persistence) is left untouched. Focusing any deck surface (the deck-bar) clears it.
  function showSettings(category?: string): void {
    store.getState().showSettings(category);
  }

  function selectTech(view: TechView): void {
    store.getState().setTech(view);
  }

  function selectOutput(view: OutputTab): void {
    store.getState().setOutput(view);
  }

  // A launcher scroll-to-term (#1165) is a facade/Task-3 concern (surfaceLoaders' own glossary state) —
  // the facade's own exposed `selectDocsTab(view, term?)` handles that BEFORE delegating the plain view
  // switch here (see the facade's wiring comment).
  function selectDocsTab(view: DocsView): void {
    store.getState().setDocs(view);
  }

  // --- rail axis switch: Domain vs Files (#453) ------------------------------
  const RAIL_AXIS_KEY = 'koine.studio.railAxis';
  const domainPane = domById(LEFT_RAIL_IDS.domainPane);
  const filesPane = domById(LEFT_RAIL_IDS.filesPane); // required contract (#979): ide.tsx renders LeftRail before this controller, so absence is a programmer error
  const axisButtons = domQueryAll<HTMLButtonElement>(axisButtonsSelector);
  // The collapsed-rail spine (#left-strip, #730) carries the same Domain/Files toggles; keep their pressed
  // state in lockstep with the expanded segmented control.
  const lstripAxisButtons = domQueryAll<HTMLButtonElement>(lstripAxisButtonsSelector);

  // Paint the active axis: surface its pane, hide the other, and reflect the segmented control. Showing
  // Files also force-expands its section so a reveal always lands on a visible row.
  function applyAxis(axis: RailAxis): void {
    domainPane.hidden = axis !== 'domain';
    filesPane.hidden = axis !== 'files';
    if (axis === 'files') {
      filesPane.dataset.open = 'true';
      filesPane.querySelector('.rail-sect-head')?.setAttribute('aria-expanded', 'true');
    }
    for (const b of axisButtons) b.setAttribute('aria-selected', String(b.getAttribute(DATA_AXIS) === axis));
    for (const b of lstripAxisButtons) b.setAttribute('aria-pressed', String(b.getAttribute(DATA_LAXIS) === axis));
  }

  // The active axis is owned by the uiChrome slice (runtime, #193/#983) and mirrored to
  // `koine.studio.railAxis`. `setAxis` just writes the slice; the subscription below paints + persists.
  function setAxis(axis: RailAxis): void {
    store.getState().setRailAxis(axis);
  }

  for (const b of axisButtons) {
    b.addEventListener('click', () => setAxis((b.getAttribute(DATA_AXIS) as RailAxis | null) ?? 'domain'));
  }

  // Seed the runtime axis from persistence via the slice setter BEFORE wiring the subscription (so the
  // seed can't echo), then paint once — mirroring the rightCollapsed/leftCollapsed seeds. Domain default.
  store.getState().setRailAxis(readRaw(RAIL_AXIS_KEY) === 'files' ? 'files' : 'domain');
  applyAxis(store.getState().railAxis);
  const unsubscribeRailAxis = store.subscribe((s, prev) => {
    if (s.railAxis === prev.railAxis) return;
    applyAxis(s.railAxis);
    writeRaw(RAIL_AXIS_KEY, s.railAxis);
  });

  // --- right rail: Properties / AI Chat / Source Control / Syntax Tree -------
  // The right-edge icon stripe (#right-strip) is the sole right-view switcher (#500 follow-up); the panel
  // carries only a title header naming the active tool window. (Guarded lookup so DOM fixtures that omit
  // the header don't crash the controller.)
  const rightTitleEl = document.getElementById('right-title'); // eslint-disable-line no-restricted-properties -- intentionally optional: guarded so fixtures omitting the header don't crash
  // The shared header's per-view actions slot (currently only Source Control portals its Refresh + ⋮
  // overflow buttons into it — see SourceControlPanel). Shown only while that view is active, so switching
  // to Properties/AI Chat/Syntax Tree doesn't leave a stale Source Control action pair in the title bar.
  const rightHeaderActionsEl = document.getElementById('right-header-actions'); // eslint-disable-line no-restricted-properties -- intentionally optional: guarded so fixtures omitting the header don't crash
  const rightViewLabels: Record<RightView, string> = {
    props: 'Properties',
    assistant: 'AI Chat',
    'source-control': 'Source Control',
    'syntax-tree': 'Syntax Tree',
  };
  const rightViews: Record<RightView, HTMLElement> = {
    props: inspectorHost,
    assistant: assistantView,
    'source-control': sourceControlRightView,
    'syntax-tree': syntaxTreeRightView,
  };
  function selectRightView(view: RightView): void {
    store.getState().setRight(view);
    if (rightTitleEl) rightTitleEl.textContent = rightViewLabels[view];
    if (rightHeaderActionsEl) rightHeaderActionsEl.hidden = view !== 'source-control';
    for (const [key, node] of Object.entries(rightViews)) node.hidden = key !== view;
    // Source Control is lazily mounted + folder-derived (#272): paint it on first open and re-fetch git
    // status on every re-open. The Syntax Tree is lazily mounted + model-derived (#890): mount on first
    // open, re-fetch on re-open. The AI assistant is lazily created + interactive (#235): mount it on
    // first open and re-sync the conversation to the current folder + focus the input on every re-open.
    // Every one of these is a facade/sibling-module concern, injected as a hook.
    if (view === 'source-control') hooks.loadSourceControl();
    else if (view === 'syntax-tree') hooks.loadSyntaxTree();
    else if (view === 'assistant') hooks.ensureAssistantShown();
  }
  // Reveal a right-rail view, expanding the rail first if it was collapsed — the entry point palette
  // commands (Show AI Chat, Explain this construct) route through so the panel is always actually visible.
  // A `focus` (#1165) stashes a Source-Control target (a file diff / a commit) BEFORE the load below, so
  // the panel reveals it on this open — mirrors the pre-extraction stash-then-load sequence exactly (one
  // `loadSourceControl` call either way).
  function selectRight(view: RightView, focus?: SourceControlFocus): void {
    if (view === 'source-control' && focus) hooks.focusSourceControl(focus);
    if (store.getState().rightCollapsed) store.getState().setRightCollapsed(false);
    selectRightView(view);
  }

  // Right-edge tool-window stripe (#500): Rider-style toggles that open/close (and switch) the #right
  // Properties panel from a persistent vertical bar. The collapsed flag is owned by the uiChrome slice
  // (runtime, #193) and mirrored to layoutStore (persistence) — the same split the diagnostics strip uses.
  const rstripSplitEl = domById('split');
  const rstripButtons = domQueryAll<HTMLButtonElement>(`#right-strip .${RSTRIP_BTN_CLASS}`);
  function applyRightCollapsed(collapsed: boolean): void {
    // DOM/ARIA only — persistence happens once per actual collapse transition (in the subscription
    // below), not on every right-view switch that also runs this repaint.
    rstripSplitEl.classList.toggle('right-collapsed', collapsed);
    const active = store.getState().right;
    // A stripe button reads "pressed" only while the panel is OPEN and showing that view; collapsed → none
    // pressed (the last active view is still remembered in uiChrome.right for the next expand).
    for (const b of rstripButtons) {
      b.setAttribute('aria-pressed', String(!collapsed && b.getAttribute(DATA_RVIEW) === active));
    }
  }
  // Seed the runtime flag from persistence before any subscription is wired (so this seed doesn't echo),
  // then paint the DOM/ARIA once for the restored state.
  store.getState().setRightCollapsed(loadLayout().rightCollapsed);
  applyRightCollapsed(store.getState().rightCollapsed);
  for (const b of rstripButtons) {
    b.addEventListener('click', () => {
      const view = b.getAttribute(DATA_RVIEW) as RightView;
      const st = store.getState();
      if (st.rightCollapsed) {
        // Collapsed → expand straight to the clicked view (Rider's "click Git to jump to Source Control").
        st.setRightCollapsed(false);
        selectRightView(view);
      } else if (view === st.right) {
        // Open on this view → collapse, reclaiming the column.
        st.setRightCollapsed(true);
      } else {
        // Open on another view → switch, staying open.
        selectRightView(view);
      }
    });
  }
  // Transient attention cue on the Properties stripe button when a selection lands while the rail is
  // collapsed (#648, approach b). A brief flash draws the eye to the affordance the user would click to
  // reveal the inspector — without forcing the panel open against an explicit collapse. Called by the
  // facade's own selection subscription (a genuinely facade-owned piece, untouched by this extraction).
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  function notifyRstripProps(): void {
    const btn = rstripButtons.find((b) => b.getAttribute(DATA_RVIEW) === 'props');
    if (!btn) return;
    // Remove then re-add so a repeated selection re-triggers the animation from the start, even if the
    // previous cycle hasn't finished. `void btn.offsetWidth` forces a style recalc so CSS sees the
    // removal before the re-add — harmless in happy-dom (returns 0) and load-bearing in a real browser.
    btn.classList.remove('rstrip-notify');
    void btn.offsetWidth;
    btn.classList.add('rstrip-notify');
    clearTimeout(notifyTimer);
    // Remove the marker after the animation duration so the cue resets and can re-fire on the next
    // selection without the animation-play-state sticking around.
    notifyTimer = setTimeout(() => {
      if (lifecycle.isDisposed()) return;
      btn.classList.remove('rstrip-notify');
    }, 800);
  }

  // Keep the stripe's pressed state + the collapsed grid in sync however the state changes. Persist only
  // on an actual collapse transition (not on every view switch that also repaints).
  const unsubscribeRightCollapsed = store.subscribe((s, prev) => {
    if (s.right !== prev.right || s.rightCollapsed !== prev.rightCollapsed) {
      applyRightCollapsed(s.rightCollapsed);
    }
    if (s.rightCollapsed !== prev.rightCollapsed) {
      saveLayout({ rightCollapsed: s.rightCollapsed });
    }
  });

  // --- left navigator-rail morph-collapse (#730) ------------------------------
  // The mirror of the right stripe on the opposite edge. The rail tucks to its #left-strip icon spine; the
  // flag is owned by uiChrome (runtime) and mirrored to layoutStore (persistence), like rightCollapsed.
  const railCollapseBtn = domById(LEFT_RAIL_IDS.collapse);
  const leftStripEl = domById(LEFT_RAIL_IDS.leftStrip);
  function applyLeftCollapsed(collapsed: boolean): void {
    rstripSplitEl.classList.toggle('left-collapsed', collapsed);
    railCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
  }
  store.getState().setLeftCollapsed(loadLayout().leftCollapsed);
  applyLeftCollapsed(store.getState().leftCollapsed);
  railCollapseBtn.addEventListener('click', () => store.getState().setLeftCollapsed(true));
  // Every spine button re-opens the rail; the Domain/Files toggles additionally set that axis so you land
  // on the navigator you clicked (the plain expand control carries no data-laxis, so it just re-opens).
  for (const b of Array.from(leftStripEl.querySelectorAll<HTMLButtonElement>('button'))) {
    b.addEventListener('click', () => {
      const axis = b.getAttribute(DATA_LAXIS) as RailAxis | null;
      store.getState().setLeftCollapsed(false);
      if (axis) setAxis(axis);
    });
  }
  const unsubscribeLeftCollapsed = store.subscribe((s, prev) => {
    if (s.leftCollapsed !== prev.leftCollapsed) {
      applyLeftCollapsed(s.leftCollapsed);
      saveLayout({ leftCollapsed: s.leftCollapsed });
    }
  });

  // The blessed Code ⟷ Canvas preset: the .koi text beside the live domain diagram. In the deck this is a
  // 2-up with Code selected on the left and Canvas on the right.
  function splitCodeCanvas(): void {
    store.getState().focusPrimary('technical');
    store.getState().openBeside('visual');
    // The deck subscription below already re-applies the chrome + lazy-loads synchronously on each of the
    // two writes above; this extra call is belt-and-braces (mirrors the pre-extraction code's own explicit
    // follow-up) via the SAME injected hook rather than a bespoke diagrams-only check.
    hooks.ensureVisibleLoaded();
  }

  // Subscribe to deck + facet changes so any mutation — from the DeckSpine / DeckCard, a palette command,
  // or a keyboard shortcut — re-applies the center chrome, lazy-loads the now-visible surfaces, and
  // persists the deck. Disposed in dispose() so a deferred callback can't fire into a torn-down DOM.
  const unsubscribeDeck = store.subscribe((s, prev) => {
    const centerChanged =
      s.deck !== prev.deck ||
      s.tech !== prev.tech ||
      s.output !== prev.output ||
      s.docs !== prev.docs ||
      // The Settings overlay (#482) isn't a deck surface, so a settingsOpen flip wouldn't otherwise
      // re-run the chrome; include it here so entering/leaving Settings covers/reveals the deck body.
      s.settingsOpen !== prev.settingsOpen;
    if (!centerChanged) return;
    syncCenterChrome();
    if (s.deck !== prev.deck) deps.saveWorkspaceDeck?.(s.deck);
  });

  // --- bottom panel (Problems / Events / Relationships / Terminal / Review, #144) --
  deps.initEdgeResizer({
    target: diagEl,
    handle: domById('diag-resizer'),
    container: domById('center'),
    cssVar: '--koi-diag-h',
    anchor: 'bottom',
    storageKey: 'koine.studio.diagHeight',
    min: 80,
    max: (h) => h * 0.5,
  });
  const diagCollapse = domById('diag-collapse');
  const DIAG_COLLAPSED_KEY = 'koine.studio.diagCollapsed';
  // DOM/ARIA painter only (mirroring applyRightCollapsed) — the runtime truth is the slice's
  // `diagCollapsed` (#983), and this runs from the captured subscription below on every transition.
  function applyDiagCollapsed(collapsed: boolean): void {
    diagEl.classList.toggle('collapsed', collapsed);
    diagCollapse.setAttribute('aria-expanded', String(!collapsed));
  }
  // The strip's *default* collapsed state is viewport-aware (#475): below BP_NARROW the reading-heavy
  // Documentation view defaults COLLAPSED. Only a DEFAULT — the slice action is gated on
  // `diagCollapsedPref`, so a saved choice always wins.
  function applyDefaultDiagCollapsed(): void {
    store.getState().applyDiagCollapsedDefault(isNarrowViewport() && activeCenter() === 'docs');
  }
  // Seed via the slice setters BEFORE wiring the subscription (so the seed can't echo). A STORED key is an
  // explicit choice → setDiagCollapsed (its preference wins over the #475 default); ABSENT leaves it `null`.
  const storedDiagCollapsed = readRaw(DIAG_COLLAPSED_KEY);
  if (storedDiagCollapsed !== null) store.getState().setDiagCollapsed(storedDiagCollapsed === '1');
  applyDefaultDiagCollapsed(); // apply the narrow-Docs default (#475) when there's no explicit preference
  applyDiagCollapsed(store.getState().diagCollapsed); // paint the restored state once
  // Paint on every runtime-flag transition; persist ONLY on an explicit-preference transition — so the #475
  // default and the tab-click auto-expand never write the key.
  const unsubscribeDiagCollapsed = store.subscribe((s, prev) => {
    if (s.diagCollapsed !== prev.diagCollapsed) applyDiagCollapsed(s.diagCollapsed);
    if (s.diagCollapsedPref !== prev.diagCollapsedPref && s.diagCollapsedPref !== null) {
      writeRaw(DIAG_COLLAPSED_KEY, s.diagCollapsedPref ? '1' : '0');
    }
  });
  diagCollapse.addEventListener('click', () => {
    // Toggle from the runtime truth (the slice), and record it as an explicit preference so it persists.
    const collapsed = !store.getState().diagCollapsed;
    store.getState().setDiagCollapsed(collapsed);
    if (!collapsed) hooks.ensureBottomLoaded(activeBottomTab()); // expanding → fill the active table if stale
  });

  // Tab switching: only the active panel body is shown; the count pill belongs to Problems. The first
  // time Events/Relationships is shown it loads lazily; clicking a tab also expands a collapsed panel.
  const bottomTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.diag-tab'));
  function selectBottomTab(tab: BottomTab): void {
    store.getState().setBottom(tab);
    for (const t of bottomTabs) t.setAttribute('aria-selected', String(t.dataset.panel === tab));
    diagBodyEl.hidden = tab !== 'problems';
    eventsPanel.hidden = tab !== 'events';
    relationshipsPanel.hidden = tab !== 'relationships';
    terminalPanel.hidden = tab !== 'terminal';
    reviewPanel.hidden = tab !== 'review';
    diagCountEl.hidden = tab !== 'problems';
    // A tab click always reveals its panel: the slice's TRANSIENT reveal (#1095) moves only the runtime
    // flag (the subscription paints), never the preference — so it doesn't persist and a reload restores
    // the saved choice.
    store.getState().revealDiagTransient();
    hooks.ensureBottomLoaded(tab);
  }
  for (const t of bottomTabs) {
    t.addEventListener('click', () => selectBottomTab(t.dataset.panel as BottomTab));
  }

  // --- viewport-resize cross handler (#475) -----------------------------------
  // Below $bp-narrow the reading-heavy Documentation view defaults the bottom strip collapsed; re-evaluate
  // on a narrow↔wide CROSS (rotate/resize) without clobbering an explicit user preference
  // (applyDefaultDiagCollapsed is itself gated on that). The crossing detection (ignore every resize TICK
  // that doesn't cross the breakpoint) is the shared createNarrowCrossHandler (#1262); this module keeps
  // its OWN handler + `resize` listener — independent crossing state from the facade's (still
  // facade-owned) inspector-sheet #221 cross handler, never a shared flag.
  const onViewportResize = createNarrowCrossHandler(() => applyDefaultDiagCollapsed());

  // --- boot --------------------------------------------------------------------
  // Boot the center chrome into the restored center pane (no fetch) + mount the Deck. The center is
  // already seeded in the slice at construction (setState above) and the center tabs derive their
  // highlight from it, so boot only paints the center chrome from that slice state.
  function init(): void {
    applyCenterChrome();
    // Mount the Deck: detach the four center-host sections first so rendering the stage into #center-body
    // doesn't destroy them, then let the DeckStage re-parent each into its card body (via a ref). The
    // DeckSpine (the surface switcher / pane chrome) renders into #deck-bar. Both are store-bound — the
    // deck/facet subscription above applies the chrome thereafter.
    for (const h of Object.values(centerHosts)) h.remove();
    render(
      <DeckStage
        store={store}
        surfaces={centerHosts}
        onVisibleSurfacesChange={(views) => {
          // The FLIP resized the cards; re-measure the editor once its final geometry is set.
          if (views.includes('technical')) editor.view.requestMeasure();
        }}
      />,
      centerBodyEl,
    );
    render(<DeckSpineConnected store={store} />, deckBarEl);
    // Paint the initial chrome from the restored deck (no fetch at boot — the facade's boot ladder runs
    // refreshActiveSurfaces once the workspace document is open; the deck/facet subscription lazy-loads on
    // every subsequent change).
    applyCenterChrome();
  }

  // Registered at the END of construction, so a throwing lookup above can never leak a half-built closure
  // onto `window` — mirrors the facade's own resize-listener registration timing.
  window.addEventListener('resize', onViewportResize);

  function dispose(): void {
    lifecycle.dispose();
    clearTimeout(notifyTimer); // #648: clear the stripe-flash timer so it can't touch a torn-down DOM node
    // Drop the deck/facet subscription — its callback re-applies the center chrome + lazy-loads, which
    // must not fire into a torn-down host after dispose. Unmount the deck Preact trees too so their window
    // listeners (the DeckStage keyboard handler) detach.
    unsubscribeDeck();
    render(null, centerBodyEl);
    render(null, deckBarEl);
    // Drop the center-persist subscription (#980) — its callback calls deps.saveWorkspaceCenter, which
    // must not persist the center on behalf of a torn-down session after dispose.
    unsubscribeCenterPersist();
    // Drop the right-strip collapse subscription (#500) — its callback mutates the captured #split /
    // .rstrip-btn nodes and persists, which must not fire into a torn-down host after dispose.
    unsubscribeRightCollapsed();
    // Drop the left-rail morph-collapse subscription (#730) for the same reason.
    unsubscribeLeftCollapsed();
    // Drop the #983 chrome subscriptions (rail axis, bottom-strip collapse).
    unsubscribeRailAxis();
    unsubscribeDiagCollapsed();
    window.removeEventListener('resize', onViewportResize);
  }

  return {
    selectCenter,
    showSettings,
    setAxis,
    selectTech,
    selectOutput,
    selectDocsTab,
    selectBottomTab,
    selectRight,
    selectRightView,
    notifyRstripProps,
    splitCodeCanvas,
    visibleCenters,
    applyCenterChrome,
    init,
    dispose,
  };
}
