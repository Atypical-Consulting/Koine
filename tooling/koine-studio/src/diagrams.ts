// Live domain diagrams for the Diagrams inspector tab. The compiler's DocsEmitter (koine/docs)
// produces one Mermaid-in-Markdown page per bounded context plus the strategic context-map and
// integration-event pages, and (issue #93) a structured `{ nodes, edges }` graph riding alongside each
// diagram. The tab is rendered behind a swappable `DiagramRenderer` seam (#66): the default is the
// hand-rolled, addressable SVG renderer (src/diagrams-svg.ts) that consumes the structured graph; the
// Mermaid renderer is kept as the per-diagram fallback and as the flag's other value.
//
// Both renderers dynamically import their heavy engine (mermaid / elkjs) the first time the tab renders
// and cache the module promise; the render theme tracks the studio's light/dark setting.
import type { DocsFile } from './lsp';
import { createSvgRenderer } from './diagrams-svg';

/**
 * The renderer seam (#66): the Diagrams tab delegates to whichever implementation the flag selects.
 * Keeping it explicit lets the SVG renderer and the Mermaid fallback be swapped (and unit-tested) in
 * isolation while `renderDiagrams` stays a thin selector with a stable signature for `ide.ts`.
 */
export interface DiagramRenderer {
  render(
    container: HTMLElement,
    files: DocsFile[],
    theme: 'dark' | 'light',
    isCurrent: () => boolean,
  ): Promise<void>;
}

/** The slice of the mermaid API we use (kept minimal so the cast survives version bumps). */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
let initializedTheme: string | null = null;
let renderSeq = 0;

/** Boot mermaid once (cached) and (re)initialize it whenever the active theme changes. */
async function getMermaid(theme: 'dark' | 'light'): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => ((m as { default?: unknown }).default ?? m) as unknown as MermaidApi);
    // Don't cache a rejected import — null it so a later visit retries (e.g. after the network recovers).
    mermaidPromise.catch(() => {
      mermaidPromise = null;
    });
  }
  const mermaid = await mermaidPromise;
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
      fontFamily: 'var(--koi-font-body), system-ui, sans-serif',
    });
    initializedTheme = theme;
  }
  return mermaid;
}

/** One diagram pulled from a docs page: its rendered code plus the nearest preceding heading. */
interface MermaidDiagram {
  caption: string;
  code: string;
}

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;
const HEADING = /^#{1,6}\s+(.*)$/gm;

/** Extract every ```mermaid block from a docs page, captioned by the heading that precedes it. */
function extractDiagrams(content: string): MermaidDiagram[] {
  const out: MermaidDiagram[] = [];
  for (const m of content.matchAll(MERMAID_FENCE)) {
    const before = content.slice(0, m.index);
    const headings = [...before.matchAll(HEADING)];
    const caption = headings.length ? headings[headings.length - 1][1].trim() : '';
    out.push({ caption, code: m[1].trim() });
  }
  return out;
}

/**
 * Strip the ```mermaid …``` fence off a structured diagram's `mermaid` field, yielding the raw diagram
 * source `mermaid.render()` expects. The compiler emits `Diagram.mermaid` as the *exact fenced block*
 * embedded in the Markdown (` ```mermaid\nflowchart LR\n…\n``` `, so `contents` contains it verbatim) —
 * but `mermaid.render(id, code)` wants the inner source only, exactly what `extractDiagrams` returned
 * (its capture group, trimmed). Reuse `MERMAID_FENCE` so the result equals the regex path; if the
 * string somehow isn't fenced, return it trimmed as-is.
 */
export function stripMermaidFence(mermaid: string): string {
  // Fresh, non-global matcher so there's no shared lastIndex state.
  const m = mermaid.match(/```mermaid\n([\s\S]*?)```/);
  return (m ? m[1] : mermaid).trim();
}

/**
 * The Mermaid diagrams for a docs file, preferring the structured `file.diagrams` (issue #93) — whose
 * `.mermaid` is the fenced snippet and `.caption` the heading — and only regex-extracting the markdown
 * fences when the structured list is empty. Preferring the structured source means the SVG renderer's
 * per-diagram fallback (which hands us a synthetic file carrying only `diagrams: [diagram]`, no fence)
 * renders the diagram instead of finding no fence and showing the empty-state note. It also makes the
 * `DIAGRAM_RENDERER='mermaid'` path consume the same structured source as the SVG path. The structured
 * `mermaid` is fence-stripped to the raw source `mermaid.render` expects (see `stripMermaidFence`).
 */
export function mermaidDiagramsFor(file: DocsFile): MermaidDiagram[] {
  if (file.diagrams?.length) {
    return file.diagrams.map((d) => ({ caption: d.caption, code: stripMermaidFence(d.mermaid) }));
  }
  return extractDiagrams(file.contents);
}

/** The page title: the docs file's first level-1 heading, else a humanised file name. */
function pageTitle(file: DocsFile): string {
  const h1 = file.contents.match(/^#\s+(.*)$/m);
  if (h1) return h1[1].trim();
  const name = file.path.split('/').pop() ?? file.path;
  return name.replace(/\.md$/, '');
}

/**
 * The Mermaid renderer: pulls ```mermaid fences out of each page's markdown and renders them to SVG via
 * mermaid.js. It is the historical renderer, kept as the SVG renderer's per-diagram fallback and as the
 * `DIAGRAM_RENDERER` flag's alternative. A diagram that fails to parse degrades to its source in a code
 * block with the error, so one bad diagram never blanks the tab.
 */
export function createMermaidRenderer(): DiagramRenderer {
  return {
    async render(container, files, theme, isCurrent = () => true): Promise<void> {
      const pages = files
        .map((f) => ({ title: pageTitle(f), diagrams: mermaidDiagramsFor(f) }))
        .filter((p) => p.diagrams.length > 0);

      if (!pages.length) {
        if (isCurrent()) {
          container.innerHTML =
            '<p class="muted">No diagrams yet — add an aggregate, a state machine, or a context map to your model.</p>';
        }
        return;
      }

      let mermaid: MermaidApi;
      try {
        mermaid = await getMermaid(theme);
      } catch (e) {
        // Guard like the other container writes: a superseded render must not clobber a newer one.
        if (isCurrent()) {
          container.innerHTML = `<p class="doc-error">Could not load the diagram renderer: ${String(e)}</p>`;
        }
        return;
      }

      const root = document.createElement('div');
      root.className = 'koi-diagrams';

      for (const page of pages) {
        const section = document.createElement('section');
        section.className = 'koi-diagram-page';

        const h = document.createElement('h2');
        h.className = 'koi-diagram-title';
        h.textContent = page.title;
        section.appendChild(h);

        for (const diagram of page.diagrams) {
          const card = document.createElement('figure');
          card.className = 'koi-diagram';

          if (diagram.caption && diagram.caption !== page.title) {
            const cap = document.createElement('figcaption');
            cap.className = 'koi-diagram-caption';
            cap.textContent = diagram.caption;
            card.appendChild(cap);
          }

          const surface = document.createElement('div');
          surface.className = 'koi-diagram-surface';
          try {
            const { svg } = await mermaid.render(`koi-mmd-${++renderSeq}`, diagram.code);
            surface.innerHTML = svg;
          } catch (e) {
            surface.innerHTML =
              `<pre class="koi-diagram-fallback"><code>${escapeHtml(diagram.code)}</code></pre>` +
              `<p class="doc-error">Diagram failed to render: ${escapeHtml(String(e))}</p>`;
          }
          card.appendChild(surface);
          section.appendChild(card);
        }

        root.appendChild(section);
      }

      // A newer render may have started while we awaited mermaid (theme flip / edit / refresh) — drop
      // this superseded result rather than letting it win the last DOM write with a stale model/theme.
      if (isCurrent()) container.replaceChildren(root);
    },
  };
}

// Which renderer the Diagrams tab uses. Defaulting to 'svg' so the interactive (addressable) renderer
// actually ships and Task 4's click-to-jump-to-source is reachable; the Mermaid renderer stays as the
// per-diagram fallback and as this flag's other value, so reverting is one line.
const DIAGRAM_RENDERER: 'svg' | 'mermaid' = 'svg';

let svgRenderer: DiagramRenderer | null = null;
let mermaidRenderer: DiagramRenderer | null = null;

function selectRenderer(): DiagramRenderer {
  if (DIAGRAM_RENDERER === 'mermaid') {
    return (mermaidRenderer ??= createMermaidRenderer());
  }
  return (svgRenderer ??= createSvgRenderer());
}

/**
 * Render the docs `files` as live diagrams into `container`, behind the selected `DiagramRenderer`.
 * Signature is kept stable for `ide.ts`: pages with no diagrams are skipped, an empty model shows an
 * empty-state note, and a superseded render (`isCurrent()` false) drops itself rather than clobbering a
 * newer one.
 */
export async function renderDiagrams(
  container: HTMLElement,
  files: DocsFile[],
  theme: 'dark' | 'light',
  isCurrent: () => boolean = () => true,
): Promise<void> {
  return selectRenderer().render(container, files, theme, isCurrent);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
