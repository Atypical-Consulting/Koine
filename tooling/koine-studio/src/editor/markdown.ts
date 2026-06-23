// --- tiny markdown renderer -------------------------------------------------
// Shared by the hover tooltip, the Glossary/Docs panes (ide.ts), the AI assistant bubbles
// (aiPanel.ts) and the `koine check` report. We render only the small subset of markdown these
// produce (headings, lists, fenced/inline code, bold/italic, GFM tables, paragraphs) rather than
// pulling in a dependency. The output is assigned to innerHTML — including for AI/model output — so
// the whole input is HTML-escaped up front (escapeHtml below) BEFORE any inline/structural formatting.
// That order is the security contract: every capture group inlineMd re-inserts is already escaped, so
// no raw markup can survive into the result. See markdown.test.ts for the escaping guarantees.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(text: string): string {
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, c) => `${p}<em>${c}</em>`);
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, (_m, p, c) => `${p}<em>${c}</em>`);
  return out;
}

// GFM tables. The glossary emitter produces `| Field | Type | Description |` blocks, so split a row
// into trimmed cells (honoring an escaped `\|` inside a cell) and recognise the `|---|:--:|`
// separator row that promotes the preceding row to a header.
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** Render a small subset of markdown to an HTML string. The input is HTML-escaped before formatting. */
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md.replace(/\r\n/g, '\n')).split('\n');
  const html: string[] = [];
  let i = 0;
  let listOpen = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMd(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushParagraph();
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      html.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMd(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // GFM table: a row immediately followed by a `|---|---|` separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      closeList();
      const headerCells = splitTableRow(line);
      i += 2; // consume the header row + the separator row
      const bodyRows: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitTableRow(lines[i]);
        bodyRows.push('<tr>' + cells.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>');
        i++;
      }
      const head = '<thead><tr>' + headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead>';
      html.push(`<table>${head}<tbody>${bodyRows.join('')}</tbody></table>`);
      continue;
    }

    const item = line.match(/^\s*[-*+]\s+(.*)$/);
    if (item) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${inlineMd(item[1])}</li>`);
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      closeList();
      i++;
      continue;
    }

    closeList();
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}
