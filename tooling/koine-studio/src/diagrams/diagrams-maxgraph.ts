// maxGraph-backed domain diagram renderer (replaces the hand-rolled SVG renderer). It consumes the SAME
// structured `{ nodes, edges }` graph the compiler emits (DocsFile.diagrams[].graph), fuses every diagram
// into one deduped domain canvas, and draws it with @maxgraph/core. The renderer↔IDE contract (events,
// editing/persist state) lives in `diagramContract.ts`, so this is a drop-in behind the `DiagramRenderer`
// seam (`diagrams.ts`).
//
// This file is built incrementally; the current slice is the read-only skeleton: select + merge graphs,
// one vertex per node, the empty state, and the superseded-render guard. Styling, bounded-context
// containers, layout, edges, interaction, and persistence land in later tasks.
import type { DiagramRenderer } from '@/diagrams/diagrams';
import type { Graph as MxGraph, Cell as MxCell } from '@maxgraph/core';
import type { DiagramEdge, DiagramGraph, DiagramMember, DiagramNode, DocsFile } from '@/lsp/lsp';
import { mergeGraphsForView } from '@/model/modelTables';
import { buildEmptyState } from '@/diagrams/emptyState';
import { loadDiagramZoom, saveDiagramZoom } from '@/settings/persistence';

/** The @maxgraph/core module shape, loaded lazily (code-split out of the main bundle). */
type Mx = typeof import('@maxgraph/core');

let mxPromise: Promise<Mx> | null = null;

/** Boot @maxgraph/core once (cached); null the cache on failure so a later visit retries (mirrors elk). */
function getMaxGraph(): Promise<Mx> {
  if (!mxPromise) {
    mxPromise = import('@maxgraph/core');
    mxPromise.catch(() => {
      mxPromise = null;
    });
  }
  return mxPromise;
}

/** A node draws as a UML class box (compartments) iff it has a stereotype or any members; else a simple box. */
export function isClassNode(node: DiagramNode): boolean {
  return node.stereotype != null || (node.members?.length ?? 0) > 0;
}

// --- node label HTML + sizing -------------------------------------------------
// Nodes render as HTML labels (the maxGraph cell shape is transparent), so the box — border, fill,
// compartments — is drawn by CSS keyed on `data-kind` (see _diagrams-maxgraph.scss). This keeps theming
// pure CSS (no reliance on var() resolving inside SVG fill attributes) and matches the DDD palette the
// SVG renderer used. Sizing mirrors the SVG renderer's geometry so the layout spacing reads the same and
// stays deterministic for headless tests (happy-dom can't measure HTML).
const CHAR_W = 8.2; // px per char at the 13px label font
const MEMBER_CHAR_W = 7; // px per char at the 12px member-row font
const NODE_PAD_X = 28;
const ROW_H = 18;
const HEADER_H = 44;
const COMPARTMENT_PAD = 6;
const CLASS_PAD_X = 16;
const MIN_W = 72;
const MIN_CLASS_W = 120;
const MAX_W = 280;
const SIMPLE_H = 40;

/** Split a class node's members into the attribute compartment (field/value/computed) and methods. */
function partitionMembers(node: DiagramNode): { fields: DiagramMember[]; methods: DiagramMember[] } {
  const fields = node.members.filter((m) => m.kind === 'field' || m.kind === 'value' || m.kind === 'computed');
  const methods = node.members.filter((m) => m.kind === 'method');
  return { fields, methods };
}

/** The pre-layout box size for a node, clamped to a sane width range (mirrors the SVG renderer). */
export function nodeSize(node: DiagramNode): [number, number] {
  if (!isClassNode(node)) {
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(node.label.length * CHAR_W) + NODE_PAD_X));
    return [w, SIMPLE_H];
  }
  const { fields, methods } = partitionMembers(node);
  const stereoW = node.stereotype ? `«${node.stereotype}»`.length * MEMBER_CHAR_W : 0;
  const titleW = node.label.length * CHAR_W;
  const rowW = node.members.reduce((m, r) => Math.max(m, r.text.length * MEMBER_CHAR_W), 0);
  const w = Math.max(MIN_CLASS_W, Math.min(MAX_W, Math.ceil(Math.max(titleW, stereoW, rowW) + CLASS_PAD_X * 2)));
  let h = HEADER_H + (fields.length > 0 ? fields.length * ROW_H + COMPARTMENT_PAD * 2 : COMPARTMENT_PAD);
  if (methods.length > 0) h += methods.length * ROW_H + COMPARTMENT_PAD * 2;
  return [w, Math.ceil(h)];
}

function memberRow(text: string, computed = false): string {
  return `<div class="koi-node__row${computed ? ' koi-node__row--computed' : ''}">${escapeHtml(text)}</div>`;
}

/** The HTML label for a node: a compartmented UML class box, or a single-line box, tagged with data-kind. */
export function nodeLabelHtml(node: DiagramNode): string {
  const kind = escapeHtml(node.kind);
  if (!isClassNode(node)) {
    return `<div class="koi-node koi-node--simple" data-kind="${kind}">${escapeHtml(node.label)}</div>`;
  }
  const { fields, methods } = partitionMembers(node);
  const head =
    `<div class="koi-node__head">` +
    (node.stereotype ? `<div class="koi-node__stereo">«${escapeHtml(node.stereotype)}»</div>` : '') +
    `<div class="koi-node__title">${escapeHtml(node.label)}</div>` +
    `</div>`;
  const fieldComp = fields.length
    ? `<div class="koi-node__compartment">${fields.map((m) => memberRow(m.text, m.kind === 'computed')).join('')}</div>`
    : '';
  const methodComp = methods.length
    ? `<div class="koi-node__compartment">${methods.map((m) => memberRow(m.text)).join('')}</div>`
    : '';
  return `<div class="koi-node koi-node--class" data-kind="${kind}">${head}${fieldComp}${methodComp}</div>`;
}

/**
 * Select the graphs that belong on the unified domain canvas: every diagram EXCEPT the strategic context
 * map (it has its own bottom tab), keeping only those that actually carry nodes.
 */
export function selectDomainGraphs(files: DocsFile[]): DiagramGraph[] {
  return files
    .flatMap((f) => f.diagrams ?? [])
    .filter((d) => d.kind !== 'contextmap')
    .map((d) => d.graph)
    .filter((g): g is DiagramGraph => !!g && g.nodes.length > 0);
}

/** A live canvas: the graph, a node-id→cell index (for edges + selection), the per-context container
 *  cells, and a teardown closure. */
export interface CanvasHandle {
  graph: MxGraph;
  cells: Map<string, MxCell>;
  containers: Map<string, MxCell>;
  dispose(): void;
}

/** The bounded context of a `Context.Name` qualified name (everything before the first dot); '' if none. */
export function contextOf(qualifiedName: string): string {
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? '' : qualifiedName.slice(0, dot);
}

/**
 * Lay out the domain canvas in two levels — REPLACING elkjs. Each bounded-context container's members are
 * arranged left→right by an inner {@link HierarchicalLayout} that resizes the container to fit; then the
 * containers (and any context-less root nodes) are arranged by an outer layout. Runs inside one batch.
 * Wrapped so a headless/measure-less environment (vitest) can't blank the canvas on a layout hiccup —
 * the model (nodes, parenting) is the tested contract; pixel placement is verified in the running studio.
 */
function runTwoLevelLayout(mx: Mx, graph: MxGraph): void {
  const { HierarchicalLayout } = mx;
  const model = graph.getDataModel();
  const root = graph.getDefaultParent();
  try {
    graph.batchUpdate(() => {
      const count = root.getChildCount();
      // Inner: arrange each context container's members left→right and resize the box to wrap them.
      for (let i = 0; i < count; i++) {
        const child = root.getChildAt(i);
        if (child?.isVertex() && child.getChildCount() > 0) {
          const inner = new HierarchicalLayout(graph, 'east');
          inner.resizeParent = true;
          inner.parentBorder = 30; // clears the swimlane header (startSize 28) so members don't overlap it
          inner.intraCellSpacing = 30;
          inner.interRankCellSpacing = 60;
          inner.execute(child);
        }
      }
      // Outer: lay the containers (and any context-less root nodes) out left→right in a row. Done MANUALLY
      // rather than with a HierarchicalLayout: there are no inter-container edges to rank on, and an
      // edgeless layout scatters the boxes and desyncs them from their (relative-positioned) children.
      let x = 0;
      const GAP = 64;
      for (let i = 0; i < count; i++) {
        const child = root.getChildAt(i);
        if (!child?.isVertex()) continue;
        const g = child.getGeometry();
        if (!g) continue;
        const next = g.clone();
        next.x = x;
        next.y = 0;
        model.setGeometry(child, next);
        x += next.width + GAP;
      }
    });
  } catch {
    // A layout failure (e.g. no measurable DOM under happy-dom) must not break the render; the nodes are
    // still present and addressable, just unarranged until the next relayout.
  }
}

/** Place a small multiplicity label at one end of an edge (x=-1 source end, x=+1 target end). */
function addEndLabel(graph: MxGraph, edge: MxCell, text: string, at: -1 | 1): void {
  graph.insertVertex({
    parent: edge,
    value: text,
    position: [at, 0],
    size: [0, 0],
    relative: true,
    style: { fontColor: 'var(--koi-muted)', labelBackgroundColor: 'var(--koi-surface)', fontSize: 11, resizable: false },
  });
}

/**
 * Build the maxGraph canvas for one merged domain graph into `container`. Kept free of the render
 * lifecycle so tests can drive it directly and assert on the model (`graph.getDataModel()`), per the
 * headless-testing discipline (happy-dom can't measure pixels). The maxGraph module is injected so this
 * stays synchronous and the dynamic import lives only in `render()`.
 */
export function buildCanvas(mx: Mx, container: HTMLElement, merged: DiagramGraph): CanvasHandle {
  const { Graph } = mx;
  const graph = new Graph(container);
  // CSP-safe: never fall through to the single `eval` path for unregistered style names (Tauri strict CSP).
  graph.getView().allowEval = false;
  graph.setHtmlLabels(true); // labels render as HTML so class nodes can use compartment markup (later task).
  graph.setCellsEditable(false); // read-only skeleton; in-canvas editing is wired in a later task.
  // Render each cell's stored value: a DiagramNode → its UML/simple HTML label (a `.koi-node` div themed
  // by CSS); a DiagramEdge → its mid label text; anything else (container name, cardinality) → the string.
  graph.convertValueToString = (cell): string => {
    const v = cell.value as DiagramNode | DiagramEdge | string | null;
    if (v && typeof v === 'object') {
      if ('qualifiedName' in v) return nodeLabelHtml(v);
      if ('from' in v && 'to' in v) return v.label ?? '';
    }
    return String(v ?? '');
  };

  const cells = new Map<string, MxCell>();
  const containers = new Map<string, MxCell>();
  const root = graph.getDefaultParent();

  // Group nodes by bounded context (the qualified-name prefix). Context-less nodes (states, bare context
  // nodes) have no dot and live at the root level.
  const byContext = new Map<string, DiagramNode[]>();
  for (const node of merged.nodes) {
    const ctx = contextOf(node.qualifiedName);
    const bucket = byContext.get(ctx);
    if (bucket) bucket.push(node);
    else byContext.set(ctx, [node]);
  }

  graph.batchUpdate(() => {
    // A swimlane container per non-empty NAMED context: a subtle bounding box with the context name as its
    // header bar. Nodes are parented INTO their context; the inner layout grows the box to fit them.
    for (const [ctx, nodes] of byContext) {
      if (ctx === '' || nodes.length === 0) continue;
      const container = graph.insertVertex({
        parent: root,
        id: `ctx:${ctx}`,
        value: ctx,
        position: [0, 0],
        size: [240, 160],
        style: {
          shape: 'swimlane',
          startSize: 28,
          fillColor: 'none',
          swimlaneFillColor: 'none',
          strokeColor: 'var(--koi-line)',
          fontColor: 'var(--koi-muted)',
          fontStyle: 1, // bold header
          fontSize: 12,
          verticalAlign: 'top',
          align: 'left',
          spacingLeft: 10,
          rounded: true,
        },
      });
      containers.set(ctx, container);
    }

    for (const node of merged.nodes) {
      const ctx = contextOf(node.qualifiedName);
      const parent = (ctx && containers.get(ctx)) || root;
      const [w, h] = nodeSize(node);
      const cell = graph.insertVertex({
        parent,
        id: node.id,
        value: node,
        position: [0, 0],
        size: [w, h],
        // Transparent cell — the HTML label (.koi-node) draws the whole box; overflow:'fill' stretches the
        // label to the cell bounds so CSS (keyed on data-kind) owns the appearance and theming.
        style: { fillColor: 'none', strokeColor: 'none', overflow: 'fill', verticalAlign: 'top', align: 'left' },
      });
      cells.set(node.id, cell);
    }

    // Edges between the merged endpoints. Composition gets a filled diamond at the owner (source) end + a
    // target arrow + per-end multiplicity labels; every other relationship is a single target arrow. The
    // DiagramEdge is kept as the cell value so a later disconnect gesture can read its backingMember.
    for (const edge of merged.edges) {
      const source = cells.get(edge.from);
      const target = cells.get(edge.to);
      if (!source || !target) continue;
      const composition = edge.arrowKind === 'composition';
      const e = graph.insertEdge({
        parent: root,
        source,
        target,
        value: edge,
        style: {
          edgeStyle: 'orthogonalEdgeStyle', // registered name → CSP-safe (no eval)
          rounded: true,
          strokeColor: 'var(--koi-line)',
          fontColor: 'var(--koi-muted)',
          startArrow: composition ? 'diamondThin' : 'none',
          startFill: composition,
          startSize: 12,
          endArrow: 'open',
          endSize: 10,
        },
      });
      if (composition) {
        if (edge.sourceCardinality) addEndLabel(graph, e, edge.sourceCardinality, -1);
        if (edge.cardinality) addEndLabel(graph, e, edge.cardinality, 1);
      }
    }
  });

  runTwoLevelLayout(mx, graph);

  return {
    graph,
    cells,
    containers,
    dispose: () => graph.destroy(),
  };
}

/** The localStorage key for the domain canvas zoom level (not workspace-scoped — matches the old renderer). */
const ZOOM_PERSIST_KEY = 'koi-domain-diagram';

/**
 * Mount the interactive chrome around a built canvas: left-drag panning, a zoom control bar (−/%/+/fit),
 * Ctrl/⌘+wheel zoom, and the Outline minimap. Returns a teardown that detaches them. Kept out of
 * buildCanvas so the model stays unit-testable; the visual chrome is verified in the running studio.
 */
function mountChrome(mx: Mx, handle: CanvasHandle, host: HTMLElement): { dispose: () => void; fit: () => void } {
  const { Outline } = mx;
  const graph = handle.graph;

  // Pan with a left-drag on empty canvas (never over a cell, so node clicks still register).
  graph.setPanning(true);
  const panning = graph.getPlugin('PanningHandler') as unknown as
    | { useLeftButtonForPanning?: boolean; ignoreCell?: boolean }
    | undefined;
  if (panning) {
    panning.useLeftButtonForPanning = true;
    panning.ignoreCell = true;
  }
  graph.centerZoom = false;
  graph.zoomFactor = 1.2;

  const fitPlugin = graph.getPlugin('fit') as unknown as
    | { fit?: (o?: unknown) => void; fitCenter?: (o?: unknown) => void }
    | undefined;
  const fit = (): void => {
    // The layout can place content at negative/large coordinates; frame it into the viewport. Needs a
    // measured container, so it's a no-op until the surface is attached to the live DOM (see render()).
    try {
      if (fitPlugin?.fitCenter) fitPlugin.fitCenter({ margin: 24 });
      else if (fitPlugin?.fit) fitPlugin.fit({ border: 24 });
      else {
        const g = graph as unknown as { fit?: (b?: number) => void; center?: (h?: boolean, v?: boolean) => void };
        g.fit?.(24);
        g.center?.(true, true);
      }
    } catch {
      /* container not measurable yet — ignore */
    }
  };

  // Restore the saved zoom level (best-effort).
  const saved = loadDiagramZoom(ZOOM_PERSIST_KEY);
  if (saved != null) graph.zoomTo(saved / 100, false);

  // --- control bar -----------------------------------------------------------
  const controls = document.createElement('div');
  controls.className = 'koi-canvas-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Diagram zoom controls');

  const pct = document.createElement('span');
  pct.className = 'koi-canvas-zoom-pct';
  pct.setAttribute('aria-live', 'polite');
  const syncPct = (): void => {
    const p = Math.round(graph.getView().scale * 100);
    pct.textContent = `${p}%`;
    saveDiagramZoom(ZOOM_PERSIST_KEY, p);
  };

  const button = (glyph: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'koi-canvas-btn';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  };

  controls.append(
    button('−', 'Zoom out', () => {
      graph.zoomOut();
      syncPct();
    }),
    pct,
    button('+', 'Zoom in', () => {
      graph.zoomIn();
      syncPct();
    }),
    button('⤢', 'Fit to screen', () => {
      fit();
      syncPct();
    }),
  );
  host.appendChild(controls);
  syncPct();

  // Ctrl/⌘ + wheel zooms the canvas; a plain wheel is left to scroll the page.
  const onWheel = (evt: WheelEvent): void => {
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    if (evt.deltaY < 0) graph.zoomIn();
    else graph.zoomOut();
    syncPct();
  };
  host.addEventListener('wheel', onWheel, { passive: false });

  // --- minimap (Outline) -----------------------------------------------------
  const outlineDiv = document.createElement('div');
  outlineDiv.className = 'koi-canvas-outline';
  outlineDiv.setAttribute('aria-hidden', 'true');
  host.appendChild(outlineDiv);
  let outline: { destroy(): void } | null = null;
  try {
    outline = new Outline(graph, outlineDiv);
  } catch {
    // Outline reads laid-out geometry; under a measure-less headless DOM it may fail — skip it there.
    outlineDiv.remove();
  }

  return {
    dispose: () => {
      host.removeEventListener('wheel', onWheel);
      outline?.destroy();
    },
    fit,
  };
}

/**
 * The maxGraph renderer behind the {@link DiagramRenderer} seam. Fuses the (already context-scoped) files
 * into one domain canvas; an empty model shows the inviting empty state; a superseded render (isCurrent()
 * false) disposes itself rather than clobbering a newer one.
 */
export function createMaxGraphRenderer(): DiagramRenderer {
  // Teardown for the canvas + chrome currently committed (the renderer is cached across renders).
  let activeDispose: (() => void) | null = null;

  return {
    // `theme` is part of the seam but unused — cells are themed via CSS custom properties, so a theme
    // flip restyles the live SVG without a re-render.
    async render(container, files, _theme, isCurrent = () => true): Promise<void> {
      const graphs = selectDomainGraphs(files);

      if (!graphs.length) {
        if (isCurrent()) {
          activeDispose?.();
          activeDispose = null;
          container.replaceChildren(buildEmptyState());
        }
        return;
      }

      let mx: Mx;
      try {
        mx = await getMaxGraph();
      } catch (e) {
        if (isCurrent()) {
          container.innerHTML = `<p class="doc-error">Could not load the diagram renderer: ${escapeHtml(String(e))}</p>`;
        }
        return;
      }

      const merged = mergeGraphsForView(graphs);

      // Build into a detached host so a superseded render never half-paints the live canvas.
      const root = document.createElement('div');
      // `koi-svg-diagram` is kept so the inspector's selection cross-highlight selector still scopes here.
      root.className = 'koi-diagrams koi-diagrams-single koi-svg-diagram';
      const surface = document.createElement('div');
      surface.className = 'koi-canvas';
      root.appendChild(surface);

      const handle = buildCanvas(mx, surface, merged);
      const chrome = mountChrome(mx, handle, surface);
      const dispose = (): void => {
        chrome.dispose();
        handle.dispose();
      };

      if (isCurrent()) {
        activeDispose?.();
        activeDispose = dispose;
        container.replaceChildren(root);
        handle.graph.getView().revalidate(); // re-render now that the surface is in the live DOM
        chrome.fit(); // frame the laid-out content (it can sit at negative coords) into the viewport
      } else {
        // Superseded: never reached the page — dispose so its listeners/observers don't leak.
        dispose();
      }
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
