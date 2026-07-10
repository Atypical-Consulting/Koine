// The Context Map panel: the strategic context map's interactive GRAPH or dense TABLE view (Task 1 of
// the inspectorController decomposition — the most self-contained seam, since the graph reuses the SAME
// maxGraph engine as the domain canvas but is otherwise a standalone read-only view). Owns the maxGraph
// handle lifecycle, the Graph/Table mode toggle (persisted through the uiChrome slice's `contextMapView`,
// mirrored to `koine.studio.contextMapView` for cross-session restore, #983), the hover tooltip, and the
// relation-details strip. Both modes read the SAME fetched `ContextMapResult`, so toggling never
// refetches — it repaints the stored result.
//
// Deliberately standalone: this module never imports `@/shell/inspectorController` (the facade wires it
// in, never the reverse — importing back would be a cycle). The host DOM node (`#panel-contextmap`) and
// the two navigation side-effects a graph-node click can trigger (filter to a context, jump to its `.koi`
// declaration) are injected, so this panel never reaches into the facade's own `deps`.
import { render } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { ContextMapResult, DiagramEdge, DiagramNode, SourceSpan } from '@/lsp/lsp';
import { renderContextMapGraph, type ContextMapGraphHandle } from '@/diagrams/diagrams-maxgraph';
import { buildContextMapGraph, type ContextMapEdge } from '@/diagrams/contextMapGraph';
import { isAllContexts, type ContextScope } from '@/model/activeContext';
import { guardedLoad } from '@/shell/guardedLoad';
import { readRaw, writeRaw } from '@/shell/storage';
import { escapeHtml, formatAclMapping, renderContextMapHtml } from '@/shell/ideUtils';

/** The narrow LSP surface this panel needs — just the strategic context-map fetch. A structural subset
 *  of `InspectorControllerLsp`, defined locally (not imported) so this module never depends on the
 *  facade; any object with a matching `contextMap()` (including the real `InspectorControllerLsp`)
 *  satisfies it. */
export interface ContextMapPanelLsp {
  contextMap(): Promise<ContextMapResult>;
}

export interface ContextMapPanelDeps {
  /** The app state store — the same instance the facade was constructed with. */
  store: StoreApi<AppState>;
  /** The panel's DOM host (`#panel-contextmap`); owned by the facade, injected here. */
  host: HTMLElement;
  lsp: ContextMapPanelLsp;
  /** The two navigation side-effects a graph-node click can trigger — injected so this module never
   *  reaches back into the facade's own `deps`. */
  onNavigate: {
    /** Filter the workspace to the clicked context scope. */
    setActiveContext(scope: ContextScope): void;
    /** Jump to the clicked node's `.koi` declaration (a span-less node stays inert to navigation). */
    gotoSourceSpan(span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>): void;
  };
}

export interface ContextMapPanel {
  /** Fetch the context map (guarded by the docViews `contextmap` token, so a repeat call while fresh is
   *  a no-op) and paint the active mode from it. */
  load(): Promise<void>;
  /** Dispose the mounted maxGraph handle and drop this panel's store subscriptions. Safe to call even if
   *  the panel was never loaded. */
  dispose(): void;
}

const CONTEXT_MAP_VIEW_KEY = 'koine.studio.contextMapView';
type ContextMapMode = 'graph' | 'table';

export function createContextMapPanel(deps: ContextMapPanelDeps): ContextMapPanel {
  const { store, host, lsp, onNavigate } = deps;

  // Set as dispose()'s first statement, mirroring the facade's own `disposed` gate (#1002): suppresses
  // all post-await mount/render work once the panel is torn down, so an in-flight fetch or a suspended
  // maxGraph mount that resolves after dispose can't touch a dead host.
  let disposed = false;

  // The active view is owned by the uiChrome slice (runtime, #983) and mirrored to
  // `koine.studio.contextMapView`. Seed it via the slice setter BEFORE wiring the subscription (so the
  // seed can't echo), then read `store.getState().contextMapView` at every use site. Graph default.
  store.getState().setContextMapView(readRaw(CONTEXT_MAP_VIEW_KEY) === 'table' ? 'table' : 'graph');
  let lastContextMap: ContextMapResult | null = null;
  let contextMapGraphHandle: ContextMapGraphHandle | null = null;
  let contextMapRenderSeq = 0;

  function disposeContextMapGraph(): void {
    contextMapGraphHandle?.dispose();
    contextMapGraphHandle = null;
  }

  // Write a status/empty/error message imperatively into the host — mirrors inspectorController's own
  // `docMessage` (this host never holds a Preact tree, so the render(null, …) unmount is a harmless no-op
  // here too; kept for parity with the shared helper's contract in case that ever changes).
  function docMessage(view: HTMLElement, text: string, kind: 'muted' | 'error' = 'muted'): void {
    render(null, view);
    view.innerHTML = '';
    const p = document.createElement('p');
    p.className = kind === 'error' ? 'doc-error' : 'muted';
    p.textContent = text;
    view.appendChild(p);
  }

  // The hover tooltip for a relation edge (a context node's name is already on its box, so → null there).
  // maxGraph renders the string as innerHTML with `\n`→`<br>`, so every fragment is escaped first.
  function contextMapTooltip(value: DiagramNode | DiagramEdge): string | null {
    if (!('from' in value && 'to' in value)) return null;
    const e = value as ContextMapEdge;
    const arrow = e.bidirectional ? '↔' : '→';
    const lines = [`${e.label ?? 'relation'}: ${e.from} ${arrow} ${e.to}`];
    if (e.sharedTypes.length) lines.push(`Shared: ${e.sharedTypes.join(', ')}`);
    for (const a of e.acl) lines.push(`ACL: ${formatAclMapping(a)}`);
    return lines.map(escapeHtml).join('\n');
  }

  // Fill the details strip with a selected relation's kind, direction, shared types and ACL — so nothing
  // from the table view is lost on the graph. `null` hides it (empty-canvas click / fresh render).
  function showRelationDetails(detailsHost: HTMLElement, edge: ContextMapEdge | null): void {
    if (!edge) {
      detailsHost.hidden = true;
      detailsHost.innerHTML = '';
      return;
    }
    const arrow = edge.bidirectional ? '↔' : '→';
    const dir = `${escapeHtml(edge.from)} ${arrow} ${escapeHtml(edge.to)}`;
    const shared = edge.sharedTypes.length ? edge.sharedTypes.map(escapeHtml).join(', ') : '—';
    const acl = edge.acl.length ? edge.acl.map((a) => escapeHtml(formatAclMapping(a))).join('<br>') : '—';
    detailsHost.innerHTML =
      `<div class="ctxmap-details-head"><span class="ctxmap-details-kind">${escapeHtml(edge.label ?? 'Relation')}</span>` +
      `<span class="ctxmap-details-dir">${dir}</span></div>` +
      `<dl class="ctxmap-details-grid"><dt>Shared types</dt><dd>${shared}</dd><dt>ACL</dt><dd>${acl}</dd></dl>`;
    detailsHost.hidden = false;
  }

  // Build the panel skeleton (Graph|Table toggle + stage + details strip) once into the host; a prior
  // `docMessage` (the 'Loading…' line) wiped it, so this rebuilds when absent and returns its parts.
  function ensureContextMapSkeleton(): { stage: HTMLElement; details: HTMLElement } {
    const existing = host.querySelector<HTMLElement>('.ctxmap');
    if (existing) {
      return {
        stage: existing.querySelector<HTMLElement>('.ctxmap-stage')!,
        details: existing.querySelector<HTMLElement>('.ctxmap-details')!,
      };
    }
    host.innerHTML = '';
    const shell = document.createElement('div');
    shell.className = 'ctxmap';

    const toolbar = document.createElement('div');
    toolbar.className = 'ctxmap-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Context map view');
    const makeTab = (mode: ContextMapMode, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctxmap-tab';
      b.dataset.ctxmapView = mode;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(store.getState().contextMapView === mode));
      b.addEventListener('click', () => setContextMapMode(mode));
      return b;
    };
    toolbar.append(makeTab('graph', 'Graph'), makeTab('table', 'Table'));

    const stage = document.createElement('div');
    stage.className = 'ctxmap-stage';
    const details = document.createElement('div');
    details.className = 'ctxmap-details';
    details.hidden = true;

    shell.append(toolbar, stage, details);
    host.appendChild(shell);
    return { stage, details };
  }

  // Focus the active bounded-context scope on the Context Map graph (ADR 0009 / #1188): mark the node
  // whose bare context name matches the active scope so you can tell which context is active — a FOCUS,
  // never a filter (every node stays drawn, the map is not blanked). Re-applied after every (re)paint and
  // on a live scope change (the subscription below); the graph content is scope-independent, so this
  // never refetches.
  function emphasiseContextMapScope(): void {
    const scope = store.getState().activeContext;
    const active = isAllContexts(scope) ? null : scope;
    for (const node of Array.from(host.querySelectorAll<HTMLElement>('.koi-ctxmap-graph .koi-svg-node'))) {
      const on = active != null && node.dataset.qname === active;
      node.classList.toggle('is-scoped', on);
      if (on) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
  }

  // Just write the slice; the captured subscription below persists the key and repaints on a change.
  function setContextMapMode(mode: ContextMapMode): void {
    store.getState().setContextMapView(mode);
  }
  // Persist `koine.studio.contextMapView` and repaint on a toggle change. Captured + disposed like siblings.
  const unsubscribeContextMapView = store.subscribe((s, prev) => {
    if (s.contextMapView === prev.contextMapView) return;
    writeRaw(CONTEXT_MAP_VIEW_KEY, s.contextMapView);
    void paintContextMap();
  });
  // Re-focus the active context's node on a LIVE scope change (ADR 0009 / #1188). Independent of the
  // facade's own `activeContext` subscription (which drives the OTHER scoped surfaces — the diagram, the
  // Files tree emphasis, …): this repaint is pure DOM emphasis of whatever is currently painted here,
  // never a refetch, so the panel owns its own slice of that fan-out.
  const unsubscribeActiveContext = store.subscribe((s, prev) => {
    if (s.activeContext === prev.activeContext) return;
    emphasiseContextMapScope();
  });

  // Paint the active view from the stored ContextMapResult. A monotonic seq makes a superseded async graph
  // render (a later toggle/refresh) bail before it touches the DOM; the prior graph handle is disposed first.
  async function paintContextMap(): Promise<void> {
    const seq = ++contextMapRenderSeq;
    // Shared by the async gate below AND both post-await tails, so the two halves of the guard
    // (disposal + supersession) can't drift apart again (#1261).
    const isCurrent = () => !disposed && seq === contextMapRenderSeq;
    disposeContextMapGraph();
    const { stage, details } = ensureContextMapSkeleton();
    for (const b of host.querySelectorAll<HTMLButtonElement>('.ctxmap-tab')) {
      b.setAttribute('aria-pressed', String(b.dataset.ctxmapView === store.getState().contextMapView));
    }
    showRelationDetails(details, null);

    const res = lastContextMap;
    if (!res || (res.contexts.length === 0 && res.relations.length === 0)) {
      stage.innerHTML = '<p class="muted">No context map declared.</p>';
      return;
    }

    if (store.getState().contextMapView === 'table') {
      stage.innerHTML = `<div class="koi-md ctxmap-table">${renderContextMapHtml(res)}</div>`;
      return;
    }

    try {
      const graph = buildContextMapGraph(res);
      // renderContextMapGraph itself suspends again internally (a dynamic maxGraph import) before it mounts
      // into stage and wires its click listener — its own `isCurrent` gate must also see `disposed`, not
      // just the local seq, or a resolving mount still lands (and wires live handlers) in a torn-down host
      // (#1002). paintContextMap is reached both from load()'s guardedLoad render callback and from a live
      // setContextMapMode toggle, so this fix covers both call paths uniformly.
      contextMapGraphHandle = await renderContextMapGraph(stage, graph, isCurrent, {
        // A context-node click both FILTERS the workspace to that bounded context (only when it's a
        // real, known context — a synthetic dangling endpoint isn't a valid scope) AND JUMPS to its
        // `.koi` declaration (#290). The graph node carries the declaration span, so we reuse the same
        // jump-to-source path the bottom tables use; a span-less node (a dangling endpoint or a
        // recovered parse) stays inert to navigation but still filters.
        onContextClick: (n) => {
          if (store.getState().contexts.includes(n.qualifiedName)) onNavigate.setActiveContext(n.qualifiedName);
          if (n.sourceSpan) onNavigate.gotoSourceSpan(n.sourceSpan);
        },
        onRelationSelect: (edge) => showRelationDetails(details, edge as ContextMapEdge | null),
        tooltip: (value) => contextMapTooltip(value),
        // Re-focus the scoped node after every view refresh (zoom/pan, #1210): maxGraph recreates the
        // HTML label DOM on a refresh, discarding the `.is-scoped` mark this same function applies below.
        onAfterRender: () => emphasiseContextMapScope(),
      });
      // Focus the active context's node once the graph is mounted (ADR 0009 / #1188).
      if (isCurrent()) emphasiseContextMapScope();
    } catch (e) {
      if (isCurrent()) docMessage(stage, 'Could not render the context-map graph: ' + String(e), 'error');
    }
  }

  // The docViews slice's 'contextmap' token guards the fetch — a token captured before the await is
  // compared after, so a superseded fetch (an edit bumped the token) can't clobber a newer render;
  // markLoaded only takes for the token it fetched. The view (graph/table) is repainted from the result.
  async function load(): Promise<void> {
    await guardedLoad({
      store,
      key: 'contextmap',
      isDisposed: () => disposed,
      loading: () => {
        disposeContextMapGraph();
        docMessage(host, 'Loading context map…');
      },
      fetch: () => lsp.contextMap(),
      render: (res) => {
        lastContextMap = res;
        void paintContextMap();
      },
      onError: (e) => {
        disposeContextMapGraph();
        docMessage(host, 'Context map request failed: ' + String(e), 'error');
      },
    });
  }

  function dispose(): void {
    disposed = true;
    disposeContextMapGraph();
    unsubscribeContextMapView();
    unsubscribeActiveContext();
  }

  return { load, dispose };
}
