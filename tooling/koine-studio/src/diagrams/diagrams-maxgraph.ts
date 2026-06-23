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
import type { DiagramGraph, DiagramMember, DiagramNode, DocsFile } from '@/lsp/lsp';
import { mergeGraphsForView } from '@/model/modelTables';
import { buildEmptyState } from '@/diagrams/emptyState';

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

/** A live canvas: the graph, a node-id→cell index (for edges + selection), and a teardown closure. */
export interface CanvasHandle {
  graph: MxGraph;
  cells: Map<string, MxCell>;
  dispose(): void;
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
  // Render each cell's stored DiagramNode as its UML/simple HTML label (a `.koi-node` div, themed by CSS).
  graph.convertValueToString = (cell): string => {
    const v = cell.value as DiagramNode | string | null;
    if (v && typeof v === 'object' && 'qualifiedName' in v) return nodeLabelHtml(v as DiagramNode);
    return String(v ?? '');
  };

  const cells = new Map<string, MxCell>();
  const parent = graph.getDefaultParent();
  graph.batchUpdate(() => {
    for (const node of merged.nodes) {
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
  });

  return {
    graph,
    cells,
    dispose: () => graph.destroy(),
  };
}

/**
 * The maxGraph renderer behind the {@link DiagramRenderer} seam. Fuses the (already context-scoped) files
 * into one domain canvas; an empty model shows the inviting empty state; a superseded render (isCurrent()
 * false) disposes itself rather than clobbering a newer one.
 */
export function createMaxGraphRenderer(): DiagramRenderer {
  // The canvas currently committed to the DOM (the renderer is cached across renders by diagrams.ts).
  let active: CanvasHandle | null = null;

  return {
    // `theme` is part of the seam but unused — cells are themed via CSS custom properties, so a theme
    // flip restyles the live SVG without a re-render.
    async render(container, files, _theme, isCurrent = () => true): Promise<void> {
      const graphs = selectDomainGraphs(files);

      if (!graphs.length) {
        if (isCurrent()) {
          active?.dispose();
          active = null;
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

      if (isCurrent()) {
        active?.dispose();
        active = handle;
        container.replaceChildren(root);
        handle.graph.getView().revalidate(); // re-render now that the surface is in the live DOM
      } else {
        // Superseded: never reached the page — dispose so its listeners/observers don't leak.
        handle.dispose();
      }
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
