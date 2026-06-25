import { describe, expect, test } from 'vitest';
import { renderMarkdown } from '@/editor/markdown';

// renderMarkdown is the tiny markdown→HTML renderer shared by the hover tooltip, the Glossary/Docs
// panes, the AI assistant bubbles (aiPanel.ts) and the `koine check` report. The AI path renders model
// output straight into innerHTML, so escaping is a security property, not a nicety — hence the explicit
// escaping suite below. Source span notes: escapeHtml runs over the WHOLE input up front (editor.ts:308)
// before any inline/structural formatting, so capture groups re-inserted by inlineMd are already escaped.

describe('renderMarkdown — formatting', () => {
  test('wraps bold, italic (* and _) and inline code', () => {
    expect(renderMarkdown('**b**')).toContain('<strong>b</strong>');
    expect(renderMarkdown('a *i* b')).toContain('<em>i</em>');
    expect(renderMarkdown('a _i_ b')).toContain('<em>i</em>');
    expect(renderMarkdown('`x`')).toContain('<code>x</code>');
  });

  test('headings map level to <h1>..<h6>', () => {
    expect(renderMarkdown('# H')).toContain('<h1>H</h1>');
    expect(renderMarkdown('### H')).toContain('<h3>H</h3>');
  });

  test('a dash run becomes a single <ul> with <li> items', () => {
    const html = renderMarkdown('- a\n- b');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
    expect(html).toContain('</ul>');
  });

  test('a fenced block becomes <pre><code> with the body preserved', () => {
    const html = renderMarkdown('```\nline1\nline2\n```');
    expect(html).toContain('<pre><code>line1\nline2</code></pre>');
  });

  test('plain text becomes a <p>', () => {
    expect(renderMarkdown('hello world')).toContain('<p>hello world</p>');
  });

  test('a GFM table with a separator row becomes a <table> with <thead>/<tbody>', () => {
    const html = renderMarkdown('| Field | Type |\n| --- | --- |\n| id | OrderId |');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead><tr><th>Field</th><th>Type</th></tr></thead>');
    expect(html).toContain('<tr><td>id</td><td>OrderId</td></tr>');
  });
});

describe('renderMarkdown — HTML escaping (XSS safety)', () => {
  test('raw HTML in a paragraph is escaped, never emitted as live markup', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('HTML inside an inline-code span is escaped', () => {
    const html = renderMarkdown('`<img src=x onerror=alert(1)>`');
    expect(html).not.toContain('<img');
    expect(html).toContain('<code>&lt;img src=x onerror=alert(1)&gt;</code>');
  });

  test('HTML inside a heading is escaped', () => {
    const html = renderMarkdown('# <b>x</b>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('<h1>&lt;b&gt;x&lt;/b&gt;</h1>');
  });

  test('HTML inside a list item is escaped', () => {
    const html = renderMarkdown('- <iframe></iframe>');
    expect(html).not.toContain('<iframe>');
    expect(html).toContain('&lt;iframe&gt;');
  });

  test('HTML inside a table cell is escaped', () => {
    const html = renderMarkdown('| a |\n| --- |\n| <svg onload=alert(1)> |');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
  });

  test('HTML inside a fenced code block is escaped', () => {
    const html = renderMarkdown('```\n<script>evil()</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
  });

  test('bare ampersands are entity-escaped', () => {
    expect(renderMarkdown('Tom & Jerry')).toContain('Tom &amp; Jerry');
  });
});
