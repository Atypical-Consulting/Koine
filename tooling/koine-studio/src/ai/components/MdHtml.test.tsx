// Tests for MdHtml (#990 Task 2): the single escaped-markdown render boundary for assistant
// content. The component owns the ONLY permitted `dangerouslySetInnerHTML` site over
// `renderMarkdown` output, so the suite proves both halves of that contract: the markdown subset
// renders as real elements inside `.koi-md`, and hostile model output stays inert TEXT — no
// `img`/`script` element is ever injected (see src/editor/markdown.ts for why: the whole input is
// HTML-escaped before any formatting, and the renderer emits no `href`/`src`).
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { axe } from 'vitest-axe';

import { MdHtml } from '@/ai/components/MdHtml';

const root = (c: Element) => c.querySelector('.koi-md') as HTMLElement | null;

describe('MdHtml (#990)', () => {
  it('renders headings, lists and fenced code as elements inside .koi-md', () => {
    const md = '# Title\n\n- first\n- second\n\n```\nconst x = 1;\n```';
    const { container } = render(<MdHtml md={md} />);

    const host = root(container);
    expect(host).not.toBeNull();

    const heading = host!.querySelector('h1');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe('Title');

    const items = host!.querySelectorAll('ul > li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('first');
    expect(items[1].textContent).toBe('second');

    const code = host!.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('const x = 1;');
  });

  it('renders a hostile <img onerror> payload as escaped text, never an element', () => {
    const { container } = render(<MdHtml md={'<img src=x onerror=alert(1)>'} />);

    expect(container.querySelector('img')).toBeNull();
    expect(root(container)!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders a hostile <script> payload as escaped text, never an element', () => {
    const { container } = render(<MdHtml md={'<script>alert(1)</script>'} />);

    expect(container.querySelector('script')).toBeNull();
    expect(root(container)!.textContent).toContain('<script>alert(1)</script>');
  });

  it('has no accessibility violations', async () => {
    const md = '# Title\n\nA paragraph with `code`.\n\n- one\n- two';
    const { container } = render(<MdHtml md={md} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
