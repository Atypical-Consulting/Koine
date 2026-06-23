// Live domain diagrams. The compiler emits a structured `{ nodes, edges }` graph alongside every
// diagram (DocsFile.diagrams[].graph), and that graph is authoritative. The renderer behind this seam is
// the editable maxGraph canvas (src/diagrams/diagrams-maxgraph.ts): it consumes the graph and draws a
// real, interactive, queryable maxGraph (pan/zoom/minimap/drag) instead of a static SVG. (There is
// deliberately no Mermaid fallback: the structured graph is always sufficient, and a second rendering
// path would only be dead weight.)
import type { DocsFile } from '@/lsp/lsp';
import { createMaxGraphRenderer } from '@/diagrams/diagrams-maxgraph';

/** The renderer seam: `ide.ts` renders diagrams through this stable signature. */
export interface DiagramRenderer {
  render(
    container: HTMLElement,
    files: DocsFile[],
    theme: 'dark' | 'light',
    isCurrent: () => boolean,
  ): Promise<void>;
}

let renderer: DiagramRenderer | null = null;

/**
 * Render the docs `files` as a single interactive domain diagram into `container`. Pages with no diagrams
 * show an empty-state note, and a superseded render (`isCurrent()` false) drops itself rather than
 * clobbering a newer one.
 */
export async function renderDiagrams(
  container: HTMLElement,
  files: DocsFile[],
  theme: 'dark' | 'light',
  isCurrent: () => boolean = () => true,
): Promise<void> {
  return (renderer ??= createMaxGraphRenderer()).render(container, files, theme, isCurrent);
}
