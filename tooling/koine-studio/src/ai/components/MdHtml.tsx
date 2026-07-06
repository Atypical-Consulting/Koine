import { renderMarkdown } from '@/editor/markdown';

/**
 * The single escaped-markdown render boundary for assistant content (#990).
 *
 * This component is THE ONLY permitted `dangerouslySetInnerHTML` site for assistant content.
 * It is safe because `renderMarkdown` (src/editor/markdown.ts) HTML-escapes the WHOLE input up
 * front — before any inline/structural formatting — so no raw markup in model output can survive
 * into the produced HTML, and the renderer emits no `href`/`src` attributes, so there is no URL
 * surface (no `javascript:` links, no image fetches) either. Any other assistant-facing component
 * must compose this one rather than adding its own raw-HTML sink.
 */
export function MdHtml({ md }: { md: string }) {
  return <div class="koi-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />;
}
