// Unit tests for the pure helper functions extracted from ide.ts into ideUtils.ts.
// These are module-scope stateless functions — no DOM, no host, no vitest DOM environment needed.
import { describe, expect, test } from 'vitest';
import {
  pathToFileUri,
  fileUriToPath,
  isSafeShareRelPath,
  diagnosticsInRange,
  renderContextMapHtml,
  escapeCell,
  renderCheckMarkdown,
  helpRows,
} from '@/shell/ideUtils';
import type { LspDiagnostic, Range } from '@/lsp/lsp';
import type { CheckResult, ContextMapResult } from '@/lsp/protocol';

// ---------------------------------------------------------------------------
// pathToFileUri / fileUriToPath — round-trip tests
// ---------------------------------------------------------------------------

describe('pathToFileUri', () => {
  test('encodes a POSIX absolute path to a file:// URI', () => {
    expect(pathToFileUri('/home/user/my model.koi')).toBe('file:///home/user/my%20model.koi');
  });

  test('encodes a POSIX path with no special characters', () => {
    expect(pathToFileUri('/home/user/model.koi')).toBe('file:///home/user/model.koi');
  });

  test('encodes a Windows drive path with backslashes to file:///C:/ form', () => {
    expect(pathToFileUri('C:\\Users\\user\\model.koi')).toBe('file:///C:/Users/user/model.koi');
  });

  test('encodes a Windows drive path with forward slashes', () => {
    expect(pathToFileUri('C:/Users/user/model.koi')).toBe('file:///C:/Users/user/model.koi');
  });

  test('encodes a bare Windows drive root with no trailing path segments', () => {
    // Only the drive segment survives the filter — the tail is empty, so no extra slash.
    expect(pathToFileUri('C:\\')).toBe('file:///C:');
  });
});

describe('fileUriToPath', () => {
  test('returns null for a non-file:// URI', () => {
    expect(fileUriToPath('https://example.com/foo')).toBeNull();
  });

  test('decodes a POSIX file:// URI back to an absolute path', () => {
    expect(fileUriToPath('file:///home/user/model.koi')).toBe('/home/user/model.koi');
  });

  test('decodes an encoded POSIX file:// URI back to an absolute path', () => {
    expect(fileUriToPath('file:///home/user/my%20model.koi')).toBe('/home/user/my model.koi');
  });

  test('decodes a Windows file:///C:/ URI back to C:/… form', () => {
    expect(fileUriToPath('file:///C:/Users/user/model.koi')).toBe('C:/Users/user/model.koi');
  });

  test('falls back to the raw rest when percent-decoding throws (malformed %)', () => {
    // '%zz' is not a valid escape sequence, so decodeURIComponent throws and the
    // function keeps the undecoded remainder verbatim.
    expect(fileUriToPath('file:///home/%zz/model.koi')).toBe('/home/%zz/model.koi');
  });

  test('returns the raw decoded rest for a file:// URI without a leading slash', () => {
    // 'file://host/a' (authority form) — rest is 'host/a', no leading slash, no drive.
    expect(fileUriToPath('file://host/a')).toBe('host/a');
  });
});

describe('pathToFileUri / fileUriToPath round-trip', () => {
  test('round-trips a POSIX absolute path', () => {
    const path = '/home/user/my model/main.koi';
    expect(fileUriToPath(pathToFileUri(path))).toBe(path);
  });

  test('round-trips a Windows drive path (forward slashes)', () => {
    const path = 'C:/Users/user/models/main.koi';
    expect(fileUriToPath(pathToFileUri(path))).toBe(path);
  });

  test('round-trips a Windows drive path (backslashes)', () => {
    // pathToFileUri normalises backslashes → the round-trip yields forward slashes
    const winPath = 'C:\\Users\\user\\main.koi';
    const uri = pathToFileUri(winPath);
    // Decoded form uses forward slashes (normalised by pathToFileUri)
    expect(fileUriToPath(uri)).toBe('C:/Users/user/main.koi');
  });
});

// ---------------------------------------------------------------------------
// isSafeShareRelPath
// ---------------------------------------------------------------------------

describe('isSafeShareRelPath', () => {
  test('accepts a simple file name', () => {
    expect(isSafeShareRelPath('model.koi')).toBe(true);
  });

  test('accepts a nested relative path', () => {
    expect(isSafeShareRelPath('billing/model.koi')).toBe(true);
  });

  test('accepts a filename that CONTAINS ".." as a substring (not a traversal segment)', () => {
    expect(isSafeShareRelPath('My..Context.koi')).toBe(true);
  });

  test('rejects an empty string', () => {
    expect(isSafeShareRelPath('')).toBe(false);
  });

  test('rejects a ".." traversal SEGMENT', () => {
    expect(isSafeShareRelPath('../escape.koi')).toBe(false);
  });

  test('rejects a ".." segment embedded in a path', () => {
    expect(isSafeShareRelPath('billing/../escape.koi')).toBe(false);
  });

  test('rejects a backslash separator', () => {
    expect(isSafeShareRelPath('billing\\model.koi')).toBe(false);
  });

  test('rejects a path with an absolute leading slash (empty leading segment)', () => {
    expect(isSafeShareRelPath('/model.koi')).toBe(false);
  });

  test('rejects a path with a trailing slash (empty trailing segment)', () => {
    expect(isSafeShareRelPath('billing/')).toBe(false);
  });

  test('rejects a path with a double slash (empty middle segment)', () => {
    expect(isSafeShareRelPath('billing//model.koi')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diagnosticsInRange
// ---------------------------------------------------------------------------

function makeDiag(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
): LspDiagnostic {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    message: `diag @${startLine}:${startChar}`,
    severity: 1,
  } as LspDiagnostic;
}

describe('diagnosticsInRange', () => {
  const diags: LspDiagnostic[] = [
    makeDiag(0, 0, 0, 5),   // line 0 only
    makeDiag(2, 3, 2, 10),  // line 2 only
    makeDiag(5, 0, 6, 0),   // lines 5–6
    makeDiag(10, 0, 10, 5), // line 10 only
  ];

  test('returns empty array when no diagnostics intersect the range', () => {
    const range: Range = { start: { line: 7, character: 0 }, end: { line: 9, character: 0 } };
    expect(diagnosticsInRange(diags, range)).toHaveLength(0);
  });

  test('returns a single diagnostic that exactly covers the range', () => {
    const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
    const result = diagnosticsInRange(diags, range);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('0:0');
  });

  test('returns diagnostics that overlap the range', () => {
    const range: Range = { start: { line: 2, character: 0 }, end: { line: 5, character: 2 } };
    const result = diagnosticsInRange(diags, range);
    // diag at 2:3-2:10 and 5:0-6:0 both intersect
    expect(result).toHaveLength(2);
  });

  test('returns all diagnostics for a wide range', () => {
    const range: Range = { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } };
    expect(diagnosticsInRange(diags, range)).toHaveLength(diags.length);
  });

  test('filters to only the diagnostic on the requested line', () => {
    const range: Range = { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } };
    const result = diagnosticsInRange(diags, range);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('10:0');
  });
});

// ---------------------------------------------------------------------------
// renderContextMapHtml
// ---------------------------------------------------------------------------

describe('renderContextMapHtml', () => {
  test('renders empty placeholders when there are no contexts and no relations', () => {
    const res: ContextMapResult = { contexts: [], relations: [] };
    const html = renderContextMapHtml(res);
    expect(html).toContain('<h2>Contexts</h2>');
    expect(html).toContain('<p class="muted">No contexts.</p>');
    expect(html).toContain('<h2>Relations</h2>');
    expect(html).toContain('<p class="muted">No context map declared.</p>');
    // No table is emitted when there are no relations.
    expect(html).not.toContain('<table');
  });

  test('renders a <ul> of contexts and HTML-escapes context names', () => {
    const res: ContextMapResult = {
      contexts: ['Billing', 'A & B <X>'],
      relations: [],
    };
    const html = renderContextMapHtml(res);
    expect(html).toContain('<ul><li>Billing</li><li>A &amp; B &lt;X&gt;</li></ul>');
    // The escaped name must not leak raw angle brackets / ampersand.
    expect(html).not.toContain('<li>A & B <X></li>');
  });

  test('renders a relation table with a unidirectional arrow and em-dash placeholders', () => {
    const res: ContextMapResult = {
      contexts: ['Billing', 'Ordering'],
      relations: [
        {
          upstream: 'Billing',
          downstream: 'Ordering',
          kind: 'CustomerSupplier',
          bidirectional: false,
          sharedTypes: [],
          acl: [],
        },
      ],
    };
    const html = renderContextMapHtml(res);
    expect(html).toContain('<table class="ctxmap">');
    // unidirectional -> arrow
    expect(html).toContain('<td class="dir">-&gt;</td>');
    expect(html).toContain('<td>Billing</td>');
    expect(html).toContain('<td>Ordering</td>');
    expect(html).toContain('<td>CustomerSupplier</td>');
    // empty sharedTypes and empty acl both render the em-dash placeholder
    const dashCells = html.match(/<td>—<\/td>/g) ?? [];
    expect(dashCells.length).toBe(2);
  });

  test('renders a bidirectional arrow, joined shared types, and ACL mappings', () => {
    const res: ContextMapResult = {
      contexts: ['Billing', 'Ordering'],
      relations: [
        {
          upstream: 'Billing',
          downstream: 'Ordering',
          kind: 'Partnership',
          bidirectional: true,
          sharedTypes: ['Money', 'Currency'],
          acl: [
            {
              upstreamContext: 'Billing',
              upstreamType: 'Money',
              localContext: 'Ordering',
              localType: 'Price',
            },
          ],
        },
      ],
    };
    const html = renderContextMapHtml(res);
    // bidirectional <-> arrow
    expect(html).toContain('<td class="dir">&lt;-&gt;</td>');
    // shared types joined by ', '
    expect(html).toContain('<td>Money, Currency</td>');
    // ACL mapping rendered as upstream → local
    expect(html).toContain('Billing.Money → Ordering.Price');
  });

  test('joins multiple ACL mappings with <br>', () => {
    const res: ContextMapResult = {
      contexts: ['A', 'B'],
      relations: [
        {
          upstream: 'A',
          downstream: 'B',
          kind: 'Conformist',
          bidirectional: false,
          sharedTypes: ['T'],
          acl: [
            { upstreamContext: 'A', upstreamType: 'X', localContext: 'B', localType: 'X2' },
            { upstreamContext: 'A', upstreamType: 'Y', localContext: 'B', localType: 'Y2' },
          ],
        },
      ],
    };
    const html = renderContextMapHtml(res);
    expect(html).toContain('A.X → B.X2<br>A.Y → B.Y2');
  });

  test('HTML-escapes relation fields and ACL identifiers', () => {
    const res: ContextMapResult = {
      contexts: [],
      relations: [
        {
          upstream: '<Up>',
          downstream: '<Down>',
          kind: 'a&b',
          bidirectional: false,
          sharedTypes: ['<T>'],
          acl: [
            {
              upstreamContext: '<UC>',
              upstreamType: '<UT>',
              localContext: '<LC>',
              localType: '<LT>',
            },
          ],
        },
      ],
    };
    const html = renderContextMapHtml(res);
    expect(html).toContain('<td>&lt;Up&gt;</td>');
    expect(html).toContain('<td>&lt;Down&gt;</td>');
    expect(html).toContain('<td>a&amp;b</td>');
    expect(html).toContain('<td>&lt;T&gt;</td>');
    expect(html).toContain('&lt;UC&gt;.&lt;UT&gt; → &lt;LC&gt;.&lt;LT&gt;');
  });
});

// ---------------------------------------------------------------------------
// escapeCell
// ---------------------------------------------------------------------------

describe('escapeCell', () => {
  test('escapes pipe characters so they do not break a markdown table cell', () => {
    expect(escapeCell('a|b|c')).toBe('a\\|b\\|c');
  });

  test('replaces a LF newline with a single space', () => {
    expect(escapeCell('line1\nline2')).toBe('line1 line2');
  });

  test('replaces a CRLF newline with a single space', () => {
    expect(escapeCell('line1\r\nline2')).toBe('line1 line2');
  });

  test('returns plain text unchanged', () => {
    expect(escapeCell('just text')).toBe('just text');
  });
});

// ---------------------------------------------------------------------------
// renderCheckMarkdown
// ---------------------------------------------------------------------------

describe('renderCheckMarkdown', () => {
  test('renders the no-breaking-changes header and the no-changes placeholder', () => {
    const res: CheckResult = { hasBreakingChanges: false, changes: [] };
    const md = renderCheckMarkdown(res);
    expect(md).toContain('# ✅ No breaking changes');
    expect(md).toContain('0 change(s): 0 breaking, 0 non-breaking.');
    expect(md).toContain('_No changes detected._');
    // No table when there are zero changes.
    expect(md).not.toContain('| Impact | Code | Message |');
  });

  test('renders the breaking-changes header and a table counting breaking vs non-breaking', () => {
    const res: CheckResult = {
      hasBreakingChanges: true,
      changes: [
        { impact: 'Breaking', code: 'K001', message: 'removed field' },
        { impact: 'NonBreaking', code: 'K002', message: 'added field' },
      ],
    };
    const md = renderCheckMarkdown(res);
    expect(md).toContain('# ⚠️ Breaking changes detected');
    expect(md).toContain('2 change(s): 1 breaking, 1 non-breaking.');
    expect(md).toContain('| Impact | Code | Message |');
    expect(md).toContain('| --- | --- | --- |');
    expect(md).toContain('| Breaking | K001 | removed field |');
    expect(md).toContain('| NonBreaking | K002 | added field |');
    expect(md).not.toContain('_No changes detected._');
  });

  test('escapes pipes and newlines inside change cells', () => {
    const res: CheckResult = {
      hasBreakingChanges: true,
      changes: [
        { impact: 'Breaking', code: 'K|01', message: 'first\nsecond' },
      ],
    };
    const md = renderCheckMarkdown(res);
    expect(md).toContain('| Breaking | K\\|01 | first second |');
  });
});

// ---------------------------------------------------------------------------
// helpRows
// ---------------------------------------------------------------------------

describe('helpRows', () => {
  test('returns a non-empty list of {keys, description} rows', () => {
    const rows = helpRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.keys).toBe('string');
      expect(row.keys.length).toBeGreaterThan(0);
      expect(typeof row.description).toBe('string');
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  test('includes the command-palette and shortcuts-help bindings', () => {
    const rows = helpRows();
    expect(rows).toContainEqual({ keys: 'mod+K', description: 'Command palette' });
    expect(rows).toContainEqual({ keys: 'F1', description: 'Keyboard shortcuts' });
  });

  test('is deterministic across calls', () => {
    expect(helpRows()).toEqual(helpRows());
  });
});
