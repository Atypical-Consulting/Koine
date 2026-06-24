import { describe, expect, test } from 'vitest';
import { applyReplace, planReplacements, runSearch, type SearchQuery } from '@/shell/workspaceSearch';

/** A SearchQuery with the inert defaults, overridden field-by-field per case. */
function q(over: Partial<SearchQuery>): SearchQuery {
  return { text: '', caseSensitive: false, wholeWord: false, regex: false, include: '', ...over };
}

const FILES = [
  { uri: 'file:///a.koi', text: 'aggregate Order\n  total: Money\n' },
  { uri: 'file:///b.koi', text: 'value Money\nentity Line\n' },
];

describe('runSearch — literal matching', () => {
  test('finds a literal across multiple files with per-file matches and counts', () => {
    const out = runSearch(FILES, q({ text: 'Money' }));
    expect(out.error).toBeNull();
    expect(out.files.map((f) => f.uri)).toEqual(['file:///a.koi', 'file:///b.koi']);

    const a = out.files[0];
    expect(a.matches).toHaveLength(1);
    expect(a.matches[0]).toEqual({ line: 2, column: 9, length: 5, preview: '  total: Money' });

    const b = out.files[1];
    expect(b.matches).toHaveLength(1);
    expect(b.matches[0]).toEqual({ line: 1, column: 6, length: 5, preview: 'value Money' });

    const total = out.files.reduce((n, f) => n + f.matches.length, 0);
    expect(total).toBe(2);
  });

  test('skips files with no match (only files with hits are returned)', () => {
    const out = runSearch(FILES, q({ text: 'aggregate' }));
    expect(out.files.map((f) => f.uri)).toEqual(['file:///a.koi']);
  });

  test('an empty query matches nothing and is not an error', () => {
    const out = runSearch(FILES, q({ text: '' }));
    expect(out).toEqual({ files: [], error: null });
  });

  test('strips a trailing CR from the preview so CRLF files render cleanly', () => {
    const out = runSearch([{ uri: 'file:///c.koi', text: 'value Money\r\nentity Line\r\n' }], q({ text: 'Money' }));
    expect(out.files[0].matches[0].preview).toBe('value Money');
  });
});

describe('runSearch — case sensitivity', () => {
  const files = [{ uri: 'file:///x', text: 'Order order ORDER' }];

  test('case-insensitive matches every casing', () => {
    expect(runSearch(files, q({ text: 'order', caseSensitive: false })).files[0].matches).toHaveLength(3);
  });

  test('case-sensitive matches only the exact casing', () => {
    const matches = runSearch(files, q({ text: 'order', caseSensitive: true })).files[0].matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].column).toBe(6);
  });
});

describe('runSearch — whole word', () => {
  const files = [{ uri: 'file:///x', text: 'order orders reorder order' }];

  test('substring search hits every occurrence', () => {
    expect(runSearch(files, q({ text: 'order' })).files[0].matches).toHaveLength(4);
  });

  test('whole-word search ignores occurrences inside larger words', () => {
    const matches = runSearch(files, q({ text: 'order', wholeWord: true })).files[0].matches;
    expect(matches.map((m) => m.column)).toEqual([0, 21]);
  });
});

describe('runSearch — include glob', () => {
  const files = [
    { uri: 'file:///proj/src/order.koi', text: 'Money' },
    { uri: 'file:///proj/docs/readme.md', text: 'Money' },
  ];

  test('filters by extension glob anywhere in the tree', () => {
    expect(runSearch(files, q({ text: 'Money', include: '*.koi' })).files.map((f) => f.uri)).toEqual([
      'file:///proj/src/order.koi',
    ]);
  });

  test('a comma-separated include matches any listed glob', () => {
    expect(runSearch(files, q({ text: 'Money', include: '*.md, *.koi' })).files).toHaveLength(2);
  });

  test('a path-segment glob anchors on the directory', () => {
    expect(runSearch(files, q({ text: 'Money', include: 'src/*.koi' })).files.map((f) => f.uri)).toEqual([
      'file:///proj/src/order.koi',
    ]);
  });
});

describe('runSearch — regex', () => {
  test('matches a regex pattern and reports its span', () => {
    const out = runSearch([{ uri: 'file:///x', text: 'id: Guid, name: Text' }], q({ text: '\\w+: \\w+', regex: true }));
    const cols = out.files[0].matches.map((m) => m.column);
    expect(cols).toEqual([0, 10]);
  });

  test('an invalid regex returns an error result without throwing', () => {
    const out = runSearch([{ uri: 'file:///x', text: 'whatever' }], q({ text: '(', regex: true }));
    expect(out.files).toEqual([]);
    expect(out.error).toBeTruthy();
  });
});

describe('applyReplace', () => {
  test('replaces every literal occurrence right-to-left so offsets stay valid', () => {
    expect(applyReplace('a.a.a', q({ text: 'a' }), 'XXXX')).toBe('XXXX.XXXX.XXXX');
  });

  test('expands $1 capture groups in regex mode', () => {
    expect(applyReplace('Money amount', q({ text: '(\\w+) amount', regex: true }), '$1 total')).toBe('Money total');
  });

  test('treats $1 literally in non-regex mode', () => {
    expect(applyReplace('keep amount', q({ text: 'amount' }), '$1')).toBe('keep $1');
  });

  test('preserves CRLF / LF line endings around replacements', () => {
    expect(applyReplace('Money\r\nMoney\n', q({ text: 'Money' }), 'Cash')).toBe('Cash\r\nCash\n');
  });

  test('an invalid regex leaves the text untouched (no throw)', () => {
    expect(applyReplace('text(', q({ text: '(', regex: true }), 'y')).toBe('text(');
  });

  test('an empty query leaves the text untouched', () => {
    expect(applyReplace('text', q({ text: '' }), 'y')).toBe('text');
  });
});

describe('planReplacements', () => {
  test('replaces an open buffer against its live (dirty) text, flagged open', () => {
    const plan = planReplacements(
      [{ uri: 'file:///a', bufferText: 'Cash here', diskText: 'Money here' }],
      q({ text: 'Cash' }),
      'Coin',
    );
    expect(plan).toEqual([{ uri: 'file:///a', open: true, text: 'Coin here', count: 1 }]);
  });

  test('replaces a closed file against its on-disk text, flagged closed', () => {
    const plan = planReplacements([{ uri: 'file:///b', diskText: 'Money and Money' }], q({ text: 'Money' }), 'Cash');
    expect(plan).toEqual([{ uri: 'file:///b', open: false, text: 'Cash and Cash', count: 2 }]);
  });

  test('preserves CRLF / LF line endings through the replacement', () => {
    const plan = planReplacements([{ uri: 'file:///c', diskText: 'Money\r\nMoney\n' }], q({ text: 'Money' }), 'Cash');
    expect(plan[0].text).toBe('Cash\r\nCash\n');
  });

  test('omits files whose text does not change', () => {
    const plan = planReplacements([{ uri: 'file:///a', bufferText: 'nothing here' }], q({ text: 'Money' }), 'Cash');
    expect(plan).toEqual([]);
  });

  test('expands $1 capture groups in regex replacements', () => {
    const plan = planReplacements(
      [{ uri: 'file:///a', diskText: 'Money amount' }],
      q({ text: '(\\w+) amount', regex: true }),
      '$1 total',
    );
    expect(plan[0].text).toBe('Money total');
  });
});
