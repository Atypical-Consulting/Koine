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
import type { DiagramGraph, DiagramNode, DocsFile } from '@/lsp/lsp';
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
  // Render each cell's stored DiagramNode by its display label (real compartment HTML lands with styling).
  graph.convertValueToString = (cell): string => {
    const v = cell.value as DiagramNode | string | null;
    if (v && typeof v === 'object' && 'label' in v) return String(v.label);
    return String(v ?? '');
  };

  const cells = new Map<string, MxCell>();
  const parent = graph.getDefaultParent();
  graph.batchUpdate(() => {
    for (const node of merged.nodes) {
      const cell = graph.insertVertex({
        parent,
        id: node.id,
        value: node,
        position: [0, 0],
        size: isClassNode(node) ? [180, 90] : [140, 40],
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
