import { useMemo } from 'preact/hooks';

/**
 * The single escaped-markdown render boundary for the Docs (ADR/Notes) pages (#992 task 5). Mirrors the
 * assistant's own `src/ai/components/MdHtml.tsx` (#990) — a per-subsystem confinement pattern, not a
 * single app-wide component: `render` is injected here (rather than importing `renderMarkdown`
 * directly) because `DocsPanelData.renderMarkdown` is a controller-supplied seam — the former
 * `docsPanel.ts`'s `mdBlock` took the exact same parameter — which also lets this component's own tests,
 * and `AdrPanel`/`NotesPanel`'s wiring tests, exercise it with a trivial stub renderer without pulling in
 * the real Markdown pipeline every time.
 *
 * This is THE ONLY permitted `dangerouslySetInnerHTML` site across the whole #992 model/docs-panel JSX
 * conversion (`AdrPanel`/`NotesPanel` route every rendered ADR/note body through this one component,
 * never their own `innerHTML` write). It is safe because `render` — in production, `editor/markdown.ts`'s
 * `renderMarkdown` — HTML-escapes the WHOLE input up front, before any inline/structural formatting, so
 * no raw markup from an ADR or note body can reach the DOM, and the renderer emits no `href`/`src`
 * attributes (no URL surface either). See `editor/markdown.ts`'s own header comment and `markdown.test.ts`
 * for the pinned escaping guarantees; `MdHtml.test.tsx` re-proves the contract end-to-end against the
 * real renderer, including hostile `<script>`/`<img onerror>` input.
 */
export function MdHtml(props: { md: string; render: (md: string) => string }) {
  const { md, render } = props;
  const html = useMemo(() => render(md.trim() || '—'), [md, render]);
  // The one sanctioned raw-HTML sink for the Docs pages — see the module doc above for why it's safe.
  return <div class="koi-md koi-docs-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
