// Live domain diagrams for the Diagrams inspector tab. The compiler's DocsEmitter (koine/docs)
// produces one Mermaid-in-Markdown page per bounded context plus the strategic context-map and
// integration-event pages; we pull the ```mermaid fences out of those pages and render them to
// SVG with mermaid.js. The tab stays diagram-focused (it shows each diagram with the nearest
// markdown heading as a caption) so it complements, rather than duplicates, the Glossary tab.
//
// mermaid is a heavy dependency, so it is dynamically imported the first time the tab renders and
// the module promise is cached. The render theme tracks the studio's light/dark setting.
import type { DocsFile } from './lsp';

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
interface Diagram {
  caption: string;
  code: string;
}

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;
const HEADING = /^#{1,6}\s+(.*)$/gm;

/** Extract every ```mermaid block from a docs page, captioned by the heading that precedes it. */
function extractDiagrams(content: string): Diagram[] {
  const out: Diagram[] = [];
  for (const m of content.matchAll(MERMAID_FENCE)) {
    const before = content.slice(0, m.index);
    const headings = [...before.matchAll(HEADING)];
    const caption = headings.length ? headings[headings.length - 1][1].trim() : '';
    out.push({ caption, code: m[1].trim() });
  }
  return out;
}

/** The page title: the docs file's first level-1 heading, else a humanised file name. */
function pageTitle(file: DocsFile): string {
  const h1 = file.contents.match(/^#\s+(.*)$/m);
  if (h1) return h1[1].trim();
  const name = file.path.split('/').pop() ?? file.path;
  return name.replace(/\.md$/, '');
}

/**
 * Render the docs `files` as live diagrams into `container`. Pages with no Mermaid diagrams are
 * skipped; when nothing has a diagram an empty-state note is shown. A diagram that fails to parse
 * degrades to its source in a code block with the error, so one bad diagram never blanks the tab.
 */
export async function renderDiagrams(
  container: HTMLElement,
  files: DocsFile[],
  theme: 'dark' | 'light',
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const pages = files
    .map((f) => ({ title: pageTitle(f), diagrams: extractDiagrams(f.contents) }))
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
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
