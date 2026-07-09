import { describe, expect, test } from 'vitest';
import type { FsEntry } from '@/host';
import type { ExplorerRootGroup } from '@/shell/explorer';
import { analyze, findFileForContext, flattenVisible, koiStem, parentMapOf, scopeMatchOf } from '@/shell/explorerModel';

// A two-context tree: `orders/` holds a nested `order.koi` plus a plain `notes.txt`; `shared.koi`
// sits at the top level. Mirrors explorer.test.ts's sampleTree shape (folders-first, alpha).
function sampleTree(): FsEntry[] {
  return [
    {
      token: 'ROOT/orders',
      name: 'orders',
      relPath: 'orders',
      kind: 'dir',
      children: [
        { token: 'ROOT/orders/order.koi', name: 'order.koi', relPath: 'orders/order.koi', kind: 'file' },
        { token: 'ROOT/orders/notes.txt', name: 'notes.txt', relPath: 'orders/notes.txt', kind: 'file' },
      ],
    },
    { token: 'ROOT/shared.koi', name: 'shared.koi', relPath: 'shared.koi', kind: 'file' },
  ];
}

function group(root = 'ROOT'): ExplorerRootGroup {
  return { root, entries: sampleTree() };
}

// A second workspace root, disjoint from `group()`, for multi-root coverage.
function secondGroup(): ExplorerRootGroup {
  return {
    root: 'ROOT2',
    entries: [
      {
        token: 'ROOT2/billing',
        name: 'billing',
        relPath: 'billing',
        kind: 'dir',
        children: [
          { token: 'ROOT2/billing/invoice.koi', name: 'invoice.koi', relPath: 'billing/invoice.koi', kind: 'file' },
        ],
      },
    ],
  };
}

const notActive = () => false;

describe('analyze', () => {
  test('an empty filter treats every entry as visible-irrelevant (visible set stays empty, no matches)', () => {
    const result = analyze([group()], '', notActive);
    expect(result.visible.size).toBe(0);
    expect(result.matchCount).toBe(0);
    expect(result.liveDirs.has('ROOT/orders')).toBe(true);
  });

  test('a filter matching a leaf file makes only that file (not siblings) visible', () => {
    const result = analyze([group()], 'shared', notActive);
    expect(result.visible.has('ROOT/shared.koi')).toBe(true);
    expect(result.visible.has('ROOT/orders')).toBe(false);
    expect(result.visible.has('ROOT/orders/order.koi')).toBe(false);
    expect(result.matchCount).toBe(1);
  });

  test('matched-dir-reveals-subtree: a directory name match reveals every descendant, unfiltered', () => {
    const result = analyze([group()], 'orders', notActive);
    expect(result.visible.has('ROOT/orders')).toBe(true);
    expect(result.visible.has('ROOT/orders/order.koi')).toBe(true);
    expect(result.visible.has('ROOT/orders/notes.txt')).toBe(true);
    // Only the directory itself matched by name — its children didn't also match "orders".
    expect(result.matchCount).toBe(1);
  });

  test('dir-counted-in-matches: a directory whose name matches contributes to matchCount like a file', () => {
    // "o" matches: orders (dir), order.koi, notes.txt does not contain "o"... use a query that only
    // hits the dir name to isolate the dir-counts-too behavior.
    const result = analyze([group()], 'orders', notActive);
    expect(result.matchCount).toBe(1);
  });

  test('a child match also reveals its ancestor directory even when the ancestor name itself misses', () => {
    const result = analyze([group()], 'order.koi', notActive);
    expect(result.visible.has('ROOT/orders')).toBe(true); // ancestor of the matched file
    expect(result.visible.has('ROOT/orders/order.koi')).toBe(true);
    expect(result.visible.has('ROOT/orders/notes.txt')).toBe(false); // sibling, not itself matched
    expect(result.matchCount).toBe(1);
  });

  test('filter matching is case-insensitive and trims surrounding whitespace', () => {
    const result = analyze([group()], '  SHARED  ', notActive);
    expect(result.visible.has('ROOT/shared.koi')).toBe(true);
    expect(result.matchCount).toBe(1);
  });

  test('reports the active file token with its ancestor chain', () => {
    const isActive = (token: string) => token === 'ROOT/orders/order.koi';
    const result = analyze([group()], '', isActive);
    expect(result.active).toEqual({ token: 'ROOT/orders/order.koi', ancestors: ['ROOT/orders'] });
  });

  test('a top-level active file reports an empty ancestor chain', () => {
    const isActive = (token: string) => token === 'ROOT/shared.koi';
    const result = analyze([group()], '', isActive);
    expect(result.active).toEqual({ token: 'ROOT/shared.koi', ancestors: [] });
  });

  test('no active file yields null', () => {
    const result = analyze([group()], '', notActive);
    expect(result.active).toBeNull();
  });

  test('walks every group, so liveDirs and matches span multiple workspace roots', () => {
    const result = analyze([group(), secondGroup()], 'billing', notActive);
    expect(result.liveDirs.has('ROOT/orders')).toBe(true);
    expect(result.liveDirs.has('ROOT2/billing')).toBe(true);
    expect(result.visible.has('ROOT2/billing')).toBe(true);
    expect(result.visible.has('ROOT2/billing/invoice.koi')).toBe(true);
    expect(result.matchCount).toBe(1);
  });
});

describe('flattenVisible', () => {
  test('flattens a fully-expanded single-root tree in visual (pre-order) sequence', () => {
    const rows = flattenVisible([group()], new Set(), '');
    expect(rows.map((r) => r.token)).toEqual([
      'ROOT/orders',
      'ROOT/orders/order.koi',
      'ROOT/orders/notes.txt',
      'ROOT/shared.koi',
    ]);
  });

  test('carries level and parentToken for each row', () => {
    const rows = flattenVisible([group()], new Set(), '');
    const byToken = new Map(rows.map((r) => [r.token, r]));
    expect(byToken.get('ROOT/orders')).toMatchObject({ level: 1, parentToken: null, kind: 'dir' });
    expect(byToken.get('ROOT/orders/order.koi')).toMatchObject({
      level: 2,
      parentToken: 'ROOT/orders',
      kind: 'file',
    });
    expect(byToken.get('ROOT/shared.koi')).toMatchObject({ level: 1, parentToken: null, kind: 'file' });
  });

  test('a collapsed directory contributes its own row but not its children', () => {
    const rows = flattenVisible([group()], new Set(['ROOT/orders']), '');
    expect(rows.map((r) => r.token)).toEqual(['ROOT/orders', 'ROOT/shared.koi']);
  });

  test('a filter force-expands every directory regardless of collapsed state', () => {
    const rows = flattenVisible([group()], new Set(['ROOT/orders']), 'order');
    // "order" matches the dir name AND order.koi; both live under the (collapsed) orders dir, plus
    // notes.txt is pulled in too because the dir's own name-match reveals its whole subtree.
    expect(rows.map((r) => r.token)).toEqual(['ROOT/orders', 'ROOT/orders/order.koi', 'ROOT/orders/notes.txt']);
  });

  test('a filter with no directory match excludes non-matching siblings entirely', () => {
    const rows = flattenVisible([group()], new Set(), 'shared');
    expect(rows.map((r) => r.token)).toEqual(['ROOT/shared.koi']);
  });

  test('flattens across multiple root groups in group order, transparent to group boundaries', () => {
    const rows = flattenVisible([group(), secondGroup()], new Set(), '');
    expect(rows.map((r) => r.token)).toEqual([
      'ROOT/orders',
      'ROOT/orders/order.koi',
      'ROOT/orders/notes.txt',
      'ROOT/shared.koi',
      'ROOT2/billing',
      'ROOT2/billing/invoice.koi',
    ]);
  });

  test('a collapsed directory in one group does not affect flattening in another group', () => {
    const rows = flattenVisible([group(), secondGroup()], new Set(['ROOT2/billing']), '');
    expect(rows.map((r) => r.token)).toEqual([
      'ROOT/orders',
      'ROOT/orders/order.koi',
      'ROOT/orders/notes.txt',
      'ROOT/shared.koi',
      'ROOT2/billing',
    ]);
  });

  // Code-review fix (Fix 7): `flattenVisible` used to ALWAYS re-derive `visible` via its own internal
  // `analyze()` call, duplicating a tree walk `ExplorerPanel` already performs itself every render (for
  // `matchCount`/`liveDirs`) — and `flattenVisible` is keyed on `collapsed`, which changes on every single
  // directory collapse/expand click, the most common explorer interaction. The optional 4th `visible`
  // param lets a caller pass a pre-computed set in instead; omitting it (every call above) keeps computing
  // it internally, unchanged.
  describe('with a precomputed visible set (optional 4th param)', () => {
    test('passing analyze()’s own visible set produces IDENTICAL output to self-computing it, unfiltered', () => {
      const collapsed = new Set<string>();
      const selfComputed = flattenVisible([group(), secondGroup()], collapsed, '');
      const { visible } = analyze([group(), secondGroup()], '', notActive);
      const precomputed = flattenVisible([group(), secondGroup()], collapsed, '', visible);
      expect(precomputed).toEqual(selfComputed);
    });

    test('passing analyze()’s own visible set produces IDENTICAL output to self-computing it, while filtering', () => {
      const collapsed = new Set(['ROOT/orders']);
      const filter = 'order';
      const selfComputed = flattenVisible([group()], collapsed, filter);
      const { visible } = analyze([group()], filter, notActive);
      const precomputed = flattenVisible([group()], collapsed, filter, visible);
      expect(precomputed).toEqual(selfComputed);
    });

    test('an explicitly empty precomputed visible set still yields no rows while filtering (no silent full-tree fallback)', () => {
      const rows = flattenVisible([group()], new Set(), 'order', new Set());
      expect(rows).toEqual([]);
    });
  });
});

describe('parentMapOf', () => {
  test('maps every token to its immediate containing directory token', () => {
    const map = parentMapOf([group()]);
    expect(map.get('ROOT/orders/order.koi')).toBe('ROOT/orders');
    expect(map.get('ROOT/orders/notes.txt')).toBe('ROOT/orders');
  });

  test('maps a top-level entry (dir or file) to null, not its group root token', () => {
    const map = parentMapOf([group()]);
    expect(map.get('ROOT/orders')).toBeNull();
    expect(map.get('ROOT/shared.koi')).toBeNull();
  });

  test('covers every group, keeping each group root-relative', () => {
    const map = parentMapOf([group(), secondGroup()]);
    expect(map.get('ROOT2/billing')).toBeNull();
    expect(map.get('ROOT2/billing/invoice.koi')).toBe('ROOT2/billing');
  });

  test('is sufficient to compute self/descendant/current-parent drop rejections', () => {
    const map = parentMapOf([group()]);
    // Self-drop: dragging "ROOT/orders" onto itself is always invalid — the map isn't consulted for
    // that case (an identity check suffices), but ancestry lets a caller reject a drop onto a
    // descendant of the dragged item...
    const isDescendantOf = (candidate: string, ancestorToken: string): boolean => {
      let cur = map.get(candidate) ?? null;
      while (cur !== null) {
        if (cur === ancestorToken) return true;
        cur = map.get(cur) ?? null;
      }
      return false;
    };
    // order.koi is a descendant of orders → dropping "orders" into "order.koi" must be rejected.
    expect(isDescendantOf('ROOT/orders/order.koi', 'ROOT/orders')).toBe(true);
    // shared.koi is unrelated to orders.
    expect(isDescendantOf('ROOT/shared.koi', 'ROOT/orders')).toBe(false);
    // current-parent rejection: order.koi's current parent is already "ROOT/orders", a no-op move.
    expect(map.get('ROOT/orders/order.koi')).toBe('ROOT/orders');
  });
});

describe('findFileForContext', () => {
  test('finds a nested file by case-insensitive stem match and returns its ancestor chain', () => {
    const hit = findFileForContext([group()], 'Order');
    expect(hit).toEqual({ token: 'ROOT/orders/order.koi', ancestors: ['ROOT/orders'] });
  });

  test('finds a top-level file with an empty ancestor chain', () => {
    const hit = findFileForContext([group()], 'shared');
    expect(hit).toEqual({ token: 'ROOT/shared.koi', ancestors: [] });
  });

  test('matches by stem only — a query naming the full "name.koi" does not match', () => {
    const hit = findFileForContext([group()], 'order.koi');
    expect(hit).toBeNull();
  });

  // Code-review fix (Fix 6): this used to inline its own stem-stripping instead of calling `koiStem`, and
  // fell back to the full lowercased filename (not `null`) for a non-`.koi` file — so a non-`.koi` file
  // used to be matchable by its literal name. That's a genuine behavioral drift from `koiStem`'s own
  // documented null-for-non-koi contract (one `.koi` file is one bounded context — "Reveal in Files" has
  // nothing to reveal for anything else), and worse, it could FALSE-MATCH: see the next test.
  test('does NOT match a non-.koi file, even by its literal name (one .koi file is one bounded context)', () => {
    expect(findFileForContext([group()], 'notes.txt')).toBeNull();
  });

  test('a coincidentally-named non-.koi file does not false-match a context search', () => {
    const bareNameGroup: ExplorerRootGroup = {
      root: 'ROOT3',
      entries: [{ token: 'ROOT3/billing', name: 'billing', relPath: 'billing', kind: 'file' }],
    };
    // "billing" (no extension) must NOT match a search for the "billing" context — only a real
    // "billing.koi" file's stem should.
    expect(findFileForContext([bareNameGroup], 'billing')).toBeNull();
  });

  test('returns null on a miss', () => {
    expect(findFileForContext([group()], 'nonexistent')).toBeNull();
  });

  test('returns null for a blank query', () => {
    expect(findFileForContext([group()], '   ')).toBeNull();
  });

  test('searches across every group', () => {
    const hit = findFileForContext([group(), secondGroup()], 'invoice');
    expect(hit).toEqual({ token: 'ROOT2/billing/invoice.koi', ancestors: ['ROOT2/billing'] });
  });
});

// ADR-0009 (#1188) active-context scope emphasis's pure computations (#989 gap-fill) — ported from
// explorer.ts's private `koiStem`/`analyze()`'s `scopeMatch`. `ExplorerPanel`/`ExplorerPanel.test.tsx`
// cover the per-row `is-scoped`/`dim` class application end-to-end; these unit tests pin the two
// helpers directly.
describe('koiStem', () => {
  test('strips the .koi extension and lowercases', () => {
    expect(koiStem('Billing.koi')).toBe('billing');
  });

  test('returns null for a non-.koi file', () => {
    expect(koiStem('notes.txt')).toBeNull();
    expect(koiStem('README')).toBeNull();
  });
});

describe('scopeMatchOf', () => {
  test('true when some file across every group has a matching .koi stem', () => {
    expect(scopeMatchOf([group()], 'order')).toBe(true);
    expect(scopeMatchOf([group(), secondGroup()], 'invoice')).toBe(true);
  });

  test('false when no file matches — the no-op case', () => {
    expect(scopeMatchOf([group()], 'shipping')).toBe(false);
  });

  test('a non-.koi file never matches, even by its literal name', () => {
    expect(scopeMatchOf([group()], 'notes.txt')).toBe(false);
  });
});
