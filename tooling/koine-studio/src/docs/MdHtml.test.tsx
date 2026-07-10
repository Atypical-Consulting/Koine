// Tests for docs/MdHtml (#992 task 5): the single escaped-markdown render boundary for the ADR/Notes
// Docs pages. Mirrors src/ai/components/MdHtml.test.tsx's shape (that component is the assistant's own,
// separate confinement site, #990) — this suite proves the same two-part contract for the Docs pages:
// the markdown subset renders as real elements inside `.koi-md`, and hostile ADR/note body text stays
// inert TEXT (no `img`/`script` element is ever injected), driven against the REAL `renderMarkdown` (not
// a stub) so a regression that bypassed the escape-first contract would fail here even though the
// panel's own tests pass a trivial stub renderer for wiring checks.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { axe } from 'vitest-axe';

import { MdHtml } from '@/docs/MdHtml';
import { renderMarkdown } from '@/editor/markdown';

const root = (c: Element) => c.querySelector('.koi-md') as HTMLElement | null;

describe('MdHtml (#992)', () => {
  it('renders headings, lists and fenced code as elements inside .koi-md.koi-docs-prose', () => {
    const md = '# Title\n\n- first\n- second\n\n```\nconst x = 1;\n```';
    const { container } = render(<MdHtml md={md} render={renderMarkdown} />);

    const host = root(container);
    expect(host).not.toBeNull();
    expect(host!.classList.contains('koi-docs-prose')).toBe(true);

    const heading = host!.querySelector('h1');
    expect(heading?.textContent).toBe('Title');

    const items = host!.querySelectorAll('ul > li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('first');
    expect(items[1].textContent).toBe('second');

    const code = host!.querySelector('pre > code');
    expect(code?.textContent).toBe('const x = 1;');
  });

  it('a blank body falls back to an em dash placeholder', () => {
    const { container } = render(<MdHtml md="   " render={renderMarkdown} />);
    expect(root(container)!.textContent).toBe('—');
  });

  it('calls the injected render function, not a hardcoded renderer', () => {
    const { container } = render(<MdHtml md="anything" render={() => '<mark>stubbed</mark>'} />);
    expect(root(container)!.innerHTML).toBe('<mark>stubbed</mark>');
  });

  it('renders a hostile <script> payload as escaped text, never a live element (security)', () => {
    const { container } = render(<MdHtml md={'<script>window.__mdHtmlPwned = true</script>'} render={renderMarkdown} />);

    expect(container.querySelector('script')).toBeNull();
    expect((globalThis as unknown as { __mdHtmlPwned?: boolean }).__mdHtmlPwned).toBeUndefined();
    expect(root(container)!.textContent).toContain('<script>window.__mdHtmlPwned = true</script>');
  });

  it('renders a hostile <img onerror> payload as escaped text, never a live element (security)', () => {
    const { container } = render(<MdHtml md={'<img src=x onerror=alert(1)>'} render={renderMarkdown} />);

    expect(container.querySelector('img')).toBeNull();
    expect(root(container)!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('has no accessibility violations', async () => {
    const md = '# Title\n\nA paragraph with `code`.\n\n- one\n- two';
    const { container } = render(<MdHtml md={md} render={renderMarkdown} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
