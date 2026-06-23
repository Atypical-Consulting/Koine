// Live domain diagrams. The compiler emits a structured `{ nodes, edges }` graph alongside every
// diagram (DocsFile.diagrams[].graph), and that graph is authoritative — so there is exactly ONE
// renderer: the hand-rolled, addressable SVG renderer (src/diagrams-svg.ts) that consumes the graph and
// draws real, queryable, interactive DOM. (There is deliberately no Mermaid fallback: the structured
// graph is always sufficient, and a second rendering path would only be dead weight.)
import type { DocsFile } from '@/lsp/lsp';
import { createSvgRenderer } from '@/diagrams/diagrams-svg';

/** The renderer seam: `ide.ts` renders diagrams through this stable signature. */
export interface DiagramRenderer {
  render(
    container: HTMLElement,
    files: DocsFile[],
    theme: 'dark' | 'light',
    isCurrent: () => boolean,
  ): Promise<void>;
}

let svgRenderer: DiagramRenderer | null = null;

/**
 * Render the docs `files` as a single interactive SVG diagram into `container`. Pages with no diagrams
 * show an empty-state note, and a superseded render (`isCurrent()` false) drops itself rather than
 * clobbering a newer one.
 */
export async function renderDiagrams(
  container: HTMLElement,
  files: DocsFile[],
  theme: 'dark' | 'light',
  isCurrent: () => boolean = () => true,
): Promise<void> {
  return (svgRenderer ??= createSvgRenderer()).render(container, files, theme, isCurrent);
}
