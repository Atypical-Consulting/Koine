import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { SyntaxTreePanel, deepestContaining, ancestorsOf, flattenVisible, type SyntaxTreeSource } from '@/model/SyntaxTreePanel';
import type { SourceSpan, SyntaxTreeNode } from '@/lsp/protocol';
import { axe } from 'vitest-axe';

// A throwaway raw span — the panel renders structure, not coordinates, so every fixture node can share
// one. (1-based, end-exclusive, matching the koine/syntaxTree wire shape.)
const SPAN: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 1, offset: 0, length: 0, file: null };

/** Terse fixture-node builder so a tree literal stays readable. Non-leaf/flag fields default sensibly. */
function node(kind: string, name: string | null, children: SyntaxTreeNode[] = [], extra: Partial<SyntaxTreeNode> = {}): SyntaxTreeNode {
  return { kind, name, span: SPAN, isMissing: false, isError: false, leaf: null, children, ...extra };
}

// --- spanned fixtures (for the caret → node containment half of #890) -------------------------------
// The root carries the wire's all-zero span; the real nodes carry NESTING own-spans so a caret resolves
// to exactly one deepest containing node. Billing wraps lines 1–4; Money lines 2–3; the amount Member
// sits on line 3, cols 5–19 (end-exclusive at 20).
const zeroSpan: SourceSpan = { line: 0, column: 0, endLine: 0, endColumn: 0, offset: 0, length: 0, file: null };
const span = (line: number, column: number, endLine: number, endColumn: number): SourceSpan => ({
  line, column, endLine, endColumn, offset: 0, length: 0, file: 'file:///m.koi',
});
function spannedFixture(): SyntaxTreeNode {
  return node('KoineModel', null, [
    node('ContextNode', 'Billing', [
      node('ValueObjectDecl', 'Money', [
        node('Member', 'amount', [], { span: span(3, 5, 3, 20) }),
      ], { span: span(2, 3, 4, 1) }),
    ], { span: span(1, 1, 5, 1) }),
  ], { span: zeroSpan });
}

// A small, realistic tree: the KoineModel root → one Billing context → a Money value object (with a
// nested Member, collapsed by default) and a recovered ErrorNode sibling. The root + its top-level
// context expand by default; deeper nodes (Money's Member) start collapsed.
function fixture(): SyntaxTreeNode {
  return node('KoineModel', null, [
    node('ContextNode', 'Billing', [
      node('ValueObjectDecl', 'Money', [
        node('Member', 'amount', [node('TypeRef', null, [], { leaf: 'Decimal' })]),
      ]),
      node('ErrorNode', null, [], { isError: true, leaf: '??' }),
      node('Invariant', null, [], { isMissing: true }),
    ]),
  ]);
}

/** A model whose single (default-expanded) context holds `n` sibling members — a huge, fully-visible
 *  flat list of `n + 2` rows (root + context + members). Exercises windowing under breadth (#1098). */
function wideFixture(n: number): SyntaxTreeNode {
  const members = Array.from({ length: n }, (_, i) => node('Member', `m${i}`, [], { leaf: 'Int' }));
  return node('KoineModel', null, [node('ContextNode', 'Big', members)]);
}

/** Like {@link wideFixture} but the member at `target` carries a real span (on line `target + 10`) so a
 *  caret there resolves to it — a deep, off-window caret target for the virtualized caret-scroll (#1098). */
function wideSpannedFixture(n: number, target: number): SyntaxTreeNode {
  const members = Array.from({ length: n }, (_, i) =>
    node('Member', `m${i}`, [], i === target ? { span: span(i + 10, 1, i + 10, 30) } : {}),
  );
  return node('KoineModel', null, [node('ContextNode', 'Big', members, { span: span(1, 1, n + 100, 1) })], {
    span: zeroSpan,
  });
}

/** A narrow fake source the panel fetches from — a single vi.fn matching {@link SyntaxTreeSource}. */
function makeSource(tree: SyntaxTreeNode | null): SyntaxTreeSource {
  return { syntaxTree: vi.fn(async () => tree) };
}

describe('SyntaxTreePanel', () => {
  test('renders nested rows showing each node kind and name', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(fixture())} />);

    // The root + its top-level context expand by default, so the root, the context, and the context's
    // direct children (Money, the error, the missing node) are all visible; Money's Member is collapsed.
    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    expect(root.getAttribute('aria-level')).toBe('1');

    const ctx = view.getByRole('treeitem', { name: /ContextNode Billing/ });
    expect(ctx.getAttribute('aria-level')).toBe('2');
    expect(ctx.getAttribute('aria-expanded')).toBe('true');

    const money = view.getByRole('treeitem', { name: /ValueObjectDecl Money/ });
    expect(money.getAttribute('aria-level')).toBe('3');
    // Money has children (a Member) but is collapsed by default.
    expect(money.getAttribute('aria-expanded')).toBe('false');

    // The collapsed Member is NOT rendered yet.
    expect(view.queryByRole('treeitem', { name: /Member amount/ })).toBeNull();
  });

  test('an error-recovery row carries a distinct error class and an accessible marker', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(fixture())} />);

    const errorRow = await view.findByRole('treeitem', { name: /ErrorNode/ });
    expect(errorRow.className).toContain('koi-stree-item--error');
    // The accessible name suffixes an explicit "(error)" marker so AT users hear the recovery state.
    expect(errorRow.getAttribute('aria-label')).toMatch(/\(error\)/);

    const missingRow = view.getByRole('treeitem', { name: /Invariant.*\(missing\)/ });
    expect(missingRow.className).toContain('koi-stree-item--missing');
  });

  test('a null tree paints the empty-state instead of crashing', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(null)} />);
    expect(await view.findByText(/No syntax tree/i)).toBeTruthy();
    expect(view.queryByRole('tree')).toBeNull();
  });

  test('ArrowDown moves roving focus and ArrowRight expands a collapsed node', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(fixture())} />);

    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    // Focus lands on the next visible row (the Billing context).
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toMatch(/ContextNode Billing/);

    const money = view.getByRole('treeitem', { name: /ValueObjectDecl Money/ });
    money.focus();
    fireEvent.keyDown(money, { key: 'ArrowRight' });
    // Expanding Money reveals its nested Member row.
    await waitFor(() => expect(view.getByRole('treeitem', { name: /Member amount/ })).toBeTruthy());
  });

  test('refetches when the revision prop changes', async () => {
    const source = makeSource(fixture());
    const view = render(<SyntaxTreePanel source={source} revision={0} />);
    await view.findByRole('treeitem', { name: /KoineModel/ });
    expect(source.syntaxTree).toHaveBeenCalledTimes(1);

    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    await waitFor(() => expect(source.syntaxTree).toHaveBeenCalledTimes(2));
  });

  test('preserves the roving tab stop on the same node across a revision refetch', async () => {
    // The same tree comes back on every call — a typing edit that leaves the focused node intact.
    const source = makeSource(fixture());
    const view = render(<SyntaxTreePanel source={source} revision={0} />);

    // Arrow down from the root to the Billing context, taking the lone tab stop with it.
    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    const ctx = view.getByRole('treeitem', { name: /ContextNode Billing/ });
    expect(ctx.getAttribute('tabindex')).toBe('0'); // it holds the roving tab stop now
    expect(root.getAttribute('tabindex')).toBe('-1');

    // A model edit bumps the revision → the panel refetches and rebuilds the tree.
    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    await waitFor(() => expect(source.syntaxTree).toHaveBeenCalledTimes(2));

    // The tab stop stays on Billing (same kind/name identity), NOT reset back to the root.
    expect(view.getByRole('treeitem', { name: /ContextNode Billing/ }).getAttribute('tabindex')).toBe('0');
    expect(view.getByRole('treeitem', { name: /KoineModel/ }).getAttribute('tabindex')).toBe('-1');
  });

  test('falls back to the root tab stop when the focused node is gone after a refetch', async () => {
    // First the Billing tree; the refetch returns a DIFFERENT context at the same path (Shipping), so
    // the previously-focused node's identity no longer matches at `0/0`.
    const shipping = node('KoineModel', null, [
      node('ContextNode', 'Shipping', [node('ValueObjectDecl', 'Address', [])]),
    ]);
    const syntaxTree = vi.fn().mockResolvedValueOnce(fixture()).mockResolvedValueOnce(shipping);
    const source: SyntaxTreeSource = { syntaxTree };
    const view = render(<SyntaxTreePanel source={source} revision={0} />);

    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' }); // tab stop → Billing (0/0)
    expect(view.getByRole('treeitem', { name: /ContextNode Billing/ }).getAttribute('tabindex')).toBe('0');

    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    await waitFor(() => expect(syntaxTree).toHaveBeenCalledTimes(2));

    // The identity guard rejects Shipping-at-0/0 as a match, so the tab stop resets to the root.
    await waitFor(() =>
      expect(view.getByRole('treeitem', { name: /KoineModel/ }).getAttribute('tabindex')).toBe('0'),
    );
    expect(view.getByRole('treeitem', { name: /ContextNode Shipping/ }).getAttribute('tabindex')).toBe('-1');
  });

  test('re-homes DOM keyboard focus onto the preserved row when focus was in the tree', async () => {
    const syntaxTree = vi.fn(async () => fixture());
    const source: SyntaxTreeSource = { syntaxTree };
    const view = render(<SyntaxTreePanel source={source} revision={0} />);

    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' }); // keyboard focus + tab stop → Billing (0/0)
    const ctx = view.getByRole('treeitem', { name: /ContextNode Billing/ });
    expect(document.activeElement).toBe(ctx);
    // Spy on THIS row's focus so the test proves the re-focus EFFECT actively re-homes focus, rather than
    // silently passing on Preact's incidental positional DOM reuse (which keeps `activeElement` on the row
    // regardless). Removing the effect's scheduling block makes this expectation fail.
    const focusSpy = vi.spyOn(ctx, 'focus');

    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    // Let the async refetch resolve and the post-commit re-focus effect run.
    await waitFor(() => expect(syntaxTree).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // The effect called .focus() on the preserved Billing row, and focus ends up there (not <body>/root).
    expect(focusSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(view.getByRole('treeitem', { name: /ContextNode Billing/ }));
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label')).toMatch(/ContextNode Billing/);
    focusSpy.mockRestore();
  });

  test('does not steal focus into the tree when focus was elsewhere during a refetch', async () => {
    const syntaxTree = vi.fn(async () => fixture());
    const source: SyntaxTreeSource = { syntaxTree };
    const view = render(<SyntaxTreePanel source={source} revision={0} />);

    // Establish Billing as the roving tab stop (so a row IS restorable), THEN move focus out of the tree.
    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' }); // tab stop → Billing (0/0)
    (document.activeElement as HTMLElement | null)?.blur?.(); // focus leaves the tree → document.body
    expect(view.container.contains(document.activeElement)).toBe(false);

    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    // Let the async refetch resolve AND any post-commit re-focus effect run (Billing was already the tab
    // stop, so there's no DOM change to await on — flush the microtask/effect queue explicitly instead).
    await waitFor(() => expect(syntaxTree).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Even though the Billing tab stop is preserved, a refetch must NOT pull DOM focus back into the tree
    // when focus was elsewhere — only the tab stop is restored, silently.
    expect(view.container.contains(document.activeElement)).toBe(false);
  });

  test('an empty refetch resets to the root and paints the empty state without crashing', async () => {
    const syntaxTree = vi.fn().mockResolvedValueOnce(fixture()).mockResolvedValueOnce(null);
    const source: SyntaxTreeSource = { syntaxTree };
    const view = render(<SyntaxTreePanel source={source} revision={0} />);

    const root = await view.findByRole('treeitem', { name: /KoineModel/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' }); // tab stop → Billing

    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    // The now-empty tree paints the empty state (no tree role, no crash) with the tab stop reset.
    expect(await view.findByText(/No syntax tree/i)).toBeTruthy();
    expect(view.queryByRole('tree')).toBeNull();
  });

  test('clicking a row fires onNodeClick with that node and marks it current', async () => {
    const onNodeClick = vi.fn();
    const view = render(<SyntaxTreePanel source={makeSource(spannedFixture())} onNodeClick={onNodeClick} />);

    const ctx = await view.findByRole('treeitem', { name: /ContextNode Billing/ });
    fireEvent.click(ctx);

    // The click selects the row (source ↔ tree): onNodeClick fires with the node's data…
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick.mock.calls[0][0].name).toBe('Billing');
    expect(onNodeClick.mock.calls[0][0].span).toEqual(span(1, 1, 5, 1));
    // …and exactly that one row wears the current highlight.
    expect(ctx.className).toContain('koi-stree-item--current');
    expect(ctx.getAttribute('aria-current')).toBe('true');
    expect(view.container.querySelectorAll('.koi-stree-item--current').length).toBe(1);
  });

  test('pressing Enter on a row fires onNodeClick + marks it current (keyboard parity with a click)', async () => {
    const onNodeClick = vi.fn();
    const view = render(<SyntaxTreePanel source={makeSource(spannedFixture())} onNodeClick={onNodeClick} />);

    // A leaf-ish row: keyboard activation must jump to source too, not just expandable parents (WCAG 2.1.1).
    const ctx = await view.findByRole('treeitem', { name: /ContextNode Billing/ });
    ctx.focus();
    fireEvent.keyDown(ctx, { key: 'Enter' });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick.mock.calls[0][0].name).toBe('Billing');
    expect(ctx.getAttribute('aria-current')).toBe('true');
  });

  test('a caret highlights the deepest node whose span contains it, auto-expanding its ancestors', async () => {
    // The caret sits inside the (default-collapsed) Member on line 3.
    const view = render(<SyntaxTreePanel source={makeSource(spannedFixture())} caret={{ line: 3, column: 10 }} />);

    // Money is collapsed by default, so the deepest match only appears because its ancestors auto-expand.
    const member = await view.findByRole('treeitem', { name: /Member amount/ });
    expect(member.className).toContain('koi-stree-item--current');
    expect(member.getAttribute('aria-current')).toBe('true');
    // Only one node is ever current.
    expect(view.container.querySelectorAll('.koi-stree-item--current').length).toBe(1);
  });

  test('an out-of-range caret (and the all-zero-span root) highlights nothing', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(spannedFixture())} caret={{ line: 100, column: 1 }} />);
    await view.findByRole('treeitem', { name: /KoineModel/ });
    // A caret past every real span leaves no highlight — and the zero-span root is never a match.
    expect(view.container.querySelector('.koi-stree-item--current')).toBeNull();
  });

  test('has no accessibility violations', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(fixture())} />);
    await view.findByRole('tree', { name: /Syntax tree/i });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  // --- windowed virtualization (#1098) ---------------------------------------------------------------
  // ROW_HEIGHT mirrors `--koi-stree-row-h` (24px) in _syntax-tree.scss — the fixed row height the window
  // math assumes. happy-dom reports no layout, so the panel falls back to a fixed-size window.
  const ROW_HEIGHT = 24;

  test('a large tree renders only a bounded window of rows while representing the full count', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(5000))} />);
    await view.findByRole('treeitem', { name: /KoineModel/ });

    const items = view.getAllByRole('treeitem');
    // Only a viewport-sized window is in the DOM — far fewer than the 5002 visible rows (root + context
    // + 5000 members). Bound near the fallback window (~56) so a ~2× windowing regression is caught.
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(80);

    // The scroll region still accounts for EVERY row: the window is padded above + below by the
    // off-window rows' collapsed height, so the container scrolls as if all 5002 rows were present.
    const treeEl = view.getByRole('tree');
    const pad = (parseFloat(treeEl.style.paddingTop) || 0) + (parseFloat(treeEl.style.paddingBottom) || 0);
    expect(Math.round(pad / ROW_HEIGHT) + items.length).toBe(5002);
  });

  test('a small tree renders every row unwindowed (virtualization transparent below the threshold)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(fixture())} />);
    await view.findByRole('treeitem', { name: /KoineModel/ });

    // The default-expanded rows in pre-order with their aria-levels: root, Billing, then Billing's three
    // children (Money — collapsed, has a child — the error, the missing node). No row is windowed out.
    const rows = view.getAllByRole('treeitem').map((el) => ({
      label: el.getAttribute('aria-label'),
      level: el.getAttribute('aria-level'),
    }));
    expect(rows.map((r) => r.level)).toEqual(['1', '2', '3', '3', '3']);
    expect(rows[0].label).toMatch(/^KoineModel/);
    expect(rows[1].label).toMatch(/^ContextNode Billing/);
    // No windowing scaffolding for a small tree — the scroll region isn't padded.
    expect(view.getByRole('tree').style.paddingTop).toBe('');
  });

  test('a huge single sibling list windows to a bounded slice with honest aria-setsize/posinset', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(4000))} />);
    await view.findByRole('treeitem', { name: /KoineModel/ });

    const items = view.getAllByRole('treeitem');
    expect(items.length).toBeLessThan(80); // windowed near the ~56-row fallback, not 4002 in the DOM

    // The members are one flat sibling set: each rendered member reports the full set size and its
    // 1-based position, even though only a window of the set is present.
    const members = items.filter((el) => /^Member /.test(el.getAttribute('aria-label') ?? ''));
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(m.getAttribute('aria-setsize')).toBe('4000');
    // Positions are honest and contiguous within the window (posinset increases by 1 per rendered row).
    const positions = members.map((m) => Number(m.getAttribute('aria-posinset')));
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBe(positions[i - 1] + 1);
  });

  // --- keyboard nav, caret highlight-scroll & WCAG across virtualized rows (#1098) --------------------

  test('keyboard nav reaches rows outside the render window (End/Home scroll them in, then focus)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(5000))} />);
    const root = await view.findByRole('treeitem', { name: /KoineModel/ });

    // Only a window is mounted, so the last member (m4999) is NOT initially in the DOM.
    expect(view.queryByRole('treeitem', { name: /Member m4999/ })).toBeNull();

    // End must still reach it: the panel scrolls it into the window, then moves roving focus onto it.
    root.focus();
    fireEvent.keyDown(root, { key: 'End' });
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/Member m4999/),
    );
    // The roving tabindex stays a single tab stop across the windowed jump.
    expect(view.container.querySelectorAll('[role="treeitem"][tabindex="0"]').length).toBe(1);

    // Home jumps back to the (now off-window) root, scrolling it back into the window first.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/KoineModel/),
    );
  });

  test('a caret on a row outside the window scrolls it in and marks it current', async () => {
    // 300 members (> threshold) so the tree virtualizes; member #250 carries a real span far down.
    const view = render(
      <SyntaxTreePanel source={makeSource(wideSpannedFixture(300, 250))} caret={{ line: 260, column: 5 }} />,
    );
    await view.findByRole('treeitem', { name: /KoineModel/ });

    // The caret's deepest containing node (m250, well outside the initial window) is scrolled into the
    // window, mounted, and highlighted.
    await waitFor(() => {
      const current = view.container.querySelector('.koi-stree-item--current');
      expect(current).not.toBeNull();
      expect(current!.getAttribute('aria-label')).toMatch(/Member m250/);
      expect(current!.getAttribute('aria-current')).toBe('true');
    });
    expect(view.container.querySelectorAll('.koi-stree-item--current').length).toBe(1);
  });

  test('a virtualized large tree is accessibility-clean with a single roving tab stop', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(3000))} />);
    await view.findByRole('tree', { name: /Syntax tree/i });

    // Exactly one tabbable row — a single tab stop across the whole (windowed) tree.
    expect(view.container.querySelectorAll('[role="treeitem"][tabindex="0"]').length).toBe(1);
    // No WCAG violations with only a window of the 3002 rows mounted (aria-level/setsize/posinset honest).
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('the window sizes to the MEASURED viewport height and re-windows on scroll (#1098)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(5000))} />);
    await view.findByRole('tree');
    // The bounded scroll viewport is the OUTER `.koi-stree-scroll` (the `role="tree"` carrying the rows
    // is its child), so clientHeight/scrollTop are mocked on it — that is what the window math measures.
    const scroller = view.container.querySelector('.koi-stree-scroll') as HTMLElement;

    // happy-dom reports 0 layout, so give the scroller a real measured height and let the resize path
    // re-measure. The window must now size to the viewport (~10 rows + overscan), NOT the 56-row fallback.
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 240 }); // 10 rows tall
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      const n = view.getAllByRole('treeitem').length;
      expect(n).toBeGreaterThan(10);
      expect(n).toBeLessThan(40); // ceil(240/24) + 2*overscan ≈ 26, well below the fallback window
    });

    // Scroll far down: the window follows the offset — the top rows drop out, rows near ~row 50 mount.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 50 * 24 });
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(view.queryByRole('treeitem', { name: /Member m0:/ })).toBeNull();
      expect(view.getByRole('treeitem', { name: /Member m50:/ })).toBeTruthy();
    });
  });

  test('a stale scroll offset from a previous large tree cannot blank a re-fetched tree (#1098)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(5000))} revision={0} />);
    await view.findByRole('tree');
    const scroller = view.container.querySelector('.koi-stree-scroll') as HTMLElement;

    // Scroll deep, then re-fetch a fresh tree via a revision bump. The offset must NOT carry over and
    // leave the new tree's window scrolled past its end (an empty slice = blank panel).
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 120000 });
    fireEvent.scroll(scroller);
    view.rerender(<SyntaxTreePanel source={makeSource(wideFixture(4000))} revision={1} />);

    // The new tree renders from the top — the root (row 0) is present, not scrolled off into a blank window.
    await waitFor(() => expect(view.getByRole('treeitem', { name: /KoineModel/ })).toBeTruthy());
  });

  // --- sticky ancestors band (#1106) -----------------------------------------------------------------
  // When a windowed flat tree is scrolled deep, the window-top row's ancestors have scrolled out of the
  // mounted slice — so an AT walking the raw DOM would see aria-level=N rows with no level-1..N-1 parents.
  // The band re-materialises that ancestor chain, pinned above the window, keeping the levels unbroken.

  test('a sticky ancestors band restores the unbroken aria-level chain when scrolled deep (#1106)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(4000))} />);
    await view.findByRole('tree');
    const scroller = view.container.querySelector('.koi-stree-scroll') as HTMLElement;

    // At the top the window-top row IS the root, so the band is empty — the pre-#1106 bounded window with
    // no ancestor rows. Capture that baseline window count.
    expect(view.container.querySelectorAll('.koi-stree-item--band').length).toBe(0);
    const windowCountAtTop = view
      .getAllByRole('treeitem')
      .filter((el) => !el.className.includes('koi-stree-item--band')).length;

    // Scroll far down so the window mounts only level-3 members; the root (level 1) + context (level 2)
    // have scrolled out of the mounted slice.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 2000 * ROW_HEIGHT });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(view.queryByRole('treeitem', { name: /Member m0:/ })).toBeNull(); // m0 windowed out
      expect(view.container.querySelectorAll('.koi-stree-item--band').length).toBeGreaterThan(0);
    });

    const items = view.getAllByRole('treeitem');
    const band = items.filter((el) => el.className.includes('koi-stree-item--band'));
    const windowItems = items.filter((el) => !el.className.includes('koi-stree-item--band'));

    // The band carries the ancestors that scrolled out, with their REAL aria-levels (root=1, context=2).
    expect(band.map((el) => el.getAttribute('aria-level'))).toEqual(['1', '2']);
    expect(band[0].getAttribute('aria-label')).toMatch(/^KoineModel/);
    expect(band[1].getAttribute('aria-label')).toMatch(/^ContextNode Big/);

    // Unbroken chain: band(1,2) + window(3) → the mounted DOM spans levels 1..3 with no gap above the
    // visible members (the whole point of #1106).
    const levels = [...new Set(items.map((el) => Number(el.getAttribute('aria-level'))))].sort((a, b) => a - b);
    expect(levels).toEqual([1, 2, 3]);

    // Pinned ABOVE the window: band rows lead the DOM order, the first window row (level 3) follows.
    expect(items[0]).toBe(band[0]);
    expect(items[2].getAttribute('aria-level')).toBe('3');

    // The band does NOT inflate the mounted window — it is a pure overlay that windowRange ignores, so the
    // window row count is unchanged vs. the no-band baseline for the same viewport.
    expect(windowItems.length).toBe(windowCountAtTop);
    expect(windowItems.length).toBeLessThan(80);

    // No new a11y violations with the band mounted (band rows carry honest aria-level/setsize/posinset).
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('band ancestor rows are not a second tab stop — the roving tabindex stays one window row (#1106)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(5000))} />);
    const root = await view.findByRole('treeitem', { name: /KoineModel/ });

    // End moves the roving tab stop onto the last member (deep in the window) and scrolls there, so the
    // ancestors band mounts above the window.
    root.focus();
    fireEvent.keyDown(root, { key: 'End' });
    await waitFor(() => {
      expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/Member m4999/);
      expect(view.container.querySelectorAll('.koi-stree-item--band').length).toBeGreaterThan(0);
    });

    // Exactly one tabbable row across BOTH the band and the window — the focused window member; the band
    // ancestors are context, never tab stops.
    const tabbables = view.container.querySelectorAll('[role="treeitem"][tabindex="0"]');
    expect(tabbables.length).toBe(1);
    expect((tabbables[0] as HTMLElement).getAttribute('aria-label')).toMatch(/Member m4999/);
    expect(view.container.querySelectorAll('.koi-stree-item--band[tabindex="0"]').length).toBe(0);
  });

  test('activating a band ancestor scrolls its real row into the window and moves roving focus there (#1106)', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(wideFixture(5000))} />);
    const root = await view.findByRole('treeitem', { name: /KoineModel/ });

    // Scroll deep (via End) so the root/context ancestors live ONLY in the band — their real window rows
    // have scrolled out of the mounted slice.
    root.focus();
    fireEvent.keyDown(root, { key: 'End' });
    await waitFor(() => expect(view.container.querySelectorAll('.koi-stree-item--band').length).toBeGreaterThan(0));

    const bandContext = [...view.container.querySelectorAll('.koi-stree-item--band')].find((el) =>
      /ContextNode Big/.test(el.getAttribute('aria-label') ?? ''),
    ) as HTMLElement;
    expect(bandContext).toBeTruthy();

    // Activating it is NAVIGATION, not selection: scroll its real row back into the window and move the
    // single roving tab stop onto the REAL (non-band) row — never a duplicate tab stop.
    fireEvent.click(bandContext);
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement | null;
      expect(focused?.getAttribute('aria-label')).toMatch(/ContextNode Big/);
      expect(focused?.className.includes('koi-stree-item--band')).toBe(false);
    });
    expect(view.container.querySelectorAll('[role="treeitem"][tabindex="0"]').length).toBe(1);
  });

  test('a refetch recomputes the band — no stale ancestor survives a shrunk tree (#1106/#1097)', async () => {
    // A huge tree first, then a refetch to a SMALL tree (below the virtualize threshold → no band at all).
    const syntaxTree = vi.fn().mockResolvedValueOnce(wideFixture(5000)).mockResolvedValueOnce(fixture());
    const source: SyntaxTreeSource = { syntaxTree };
    const view = render(<SyntaxTreePanel source={source} revision={0} />);
    await view.findByRole('treeitem', { name: /KoineModel/ });
    const scroller = view.container.querySelector('.koi-stree-scroll') as HTMLElement;

    // Scroll deep so the band mounts the big tree's ancestors.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 3000 * ROW_HEIGHT });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(view.container.querySelectorAll('.koi-stree-item--band').length).toBeGreaterThan(0));

    // Refetch → the small `fixture()` tree resets the scroll to the top and rebuilds the rows; the band must
    // recompute from the NEW model, leaving no ancestor row from the old (now-gone) big tree behind.
    view.rerender(<SyntaxTreePanel source={source} revision={1} />);
    await waitFor(() => expect(syntaxTree).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(view.container.querySelectorAll('.koi-stree-item--band').length).toBe(0);
      expect(view.getByRole('treeitem', { name: /ContextNode Billing/ })).toBeTruthy();
    });
    // And no leftover "Big" context from the discarded tree is anywhere in the DOM.
    expect(view.queryByRole('treeitem', { name: /ContextNode Big/ })).toBeNull();
  });

  test('the band names the VISIBLE-top context, not the overscan-top one (#1106)', async () => {
    // Two contexts (Alpha: 200 members, Beta: 60) → a virtualized tree. Scroll so the row at the fold is the
    // first Beta member while the overscan-top (OVERSCAN rows higher, which the raw window `first` points at)
    // is still inside Alpha — the breadcrumb must follow what the user SEES, not the overscan row.
    const ctx = (name: string, n: number) =>
      node('ContextNode', name, Array.from({ length: n }, (_, i) => node('Member', `${name}${i}`, [], { leaf: 'Int' })));
    const twoContexts = node('KoineModel', null, [ctx('Alpha', 200), ctx('Beta', 60)]);
    const view = render(<SyntaxTreePanel source={makeSource(twoContexts)} />);
    await view.findByRole('tree');
    const scroller = view.container.querySelector('.koi-stree-scroll') as HTMLElement;

    // Flat indices: root=0, Alpha=1, Alpha m0..m199 = 2..201, Beta=202, Beta m0=203. Park the fold on Beta m0;
    // the overscan-top (203 - OVERSCAN) is still an Alpha member.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 203 * ROW_HEIGHT });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const band = [...view.container.querySelectorAll('.koi-stree-item--band')];
      expect(band.length).toBeGreaterThan(0);
      // The band's level-2 context row is Beta (the fold row's context), NOT Alpha (the overscan-top's).
      const ctxRow = band.find((el) => el.getAttribute('aria-level') === '2')!;
      expect(ctxRow.getAttribute('aria-label')).toMatch(/ContextNode Beta/);
      expect(ctxRow.getAttribute('aria-label')).not.toMatch(/Alpha/);
    });
  });
});

// The core correctness of the editor → tree half: deepest OWN-span containment (the client-side
// SyntaxGraph.FindNode heuristic), end-exclusive, skipping the all-zero root span.
describe('deepestContaining', () => {
  test('resolves the deepest node whose own span contains the caret', () => {
    const tree = spannedFixture();
    expect(deepestContaining(tree, 3, 10)?.node.name).toBe('amount'); // inside the Member
    expect(deepestContaining(tree, 2, 5)?.node.name).toBe('Money'); // inside Money, not the Member
    expect(deepestContaining(tree, 1, 1)?.node.name).toBe('Billing'); // inside Billing only
  });

  test('returns the deepest node key as an index-path from the root', () => {
    const tree = spannedFixture();
    expect(deepestContaining(tree, 3, 10)?.key).toBe('0/0/0/0'); // root → Billing → Money → amount
  });

  test('returns null when nothing — or only a zero-span node — contains the caret', () => {
    const tree = spannedFixture();
    expect(deepestContaining(tree, 100, 1)).toBeNull(); // out of range
    expect(deepestContaining(tree, 5, 1)).toBeNull(); // == Billing's end (end-exclusive), so not contained
  });

  test('a SyntaxTreeNode.span typed as the shared SourceSpan keeps the line-0 root a no-jump sentinel (#1099)', () => {
    // #1099 retyped SyntaxTreeNode.span from the deleted SyntaxSpan to the shared SourceSpan. Building
    // the spans as SourceSpan must still type-check (same seven fields) AND preserve the sentinel: the
    // all-zero root (line 0) resolves to no node, so the panel never jumps to 0:0.
    const rootSpan: SourceSpan = { file: null, line: 0, column: 0, endLine: 0, endColumn: 0, offset: 0, length: 0 };
    const childSpan: SourceSpan = { file: 'file:///m.koi', line: 1, column: 1, endLine: 3, endColumn: 1, offset: 0, length: 0 };
    const tree: SyntaxTreeNode = node('KoineModel', null, [
      node('ContextNode', 'Billing', [], { span: childSpan }),
    ], { span: rootSpan });

    // A caret inside the child resolves to it (jumpable); nothing resolves to the zero-span root.
    expect(deepestContaining(tree, 2, 1)?.node.name).toBe('Billing');
    expect(deepestContaining(tree, 0, 0)).toBeNull(); // the all-zero root is never a match → no jump
  });
});

// The ancestor derivation behind the sticky ancestors band (#1106): given the first-visible (window-top)
// row's index-path key, produce the chain of ancestor Rows (root..parent) that scrolled out above the
// window — so an AT enumerating the raw DOM sees an unbroken aria-level chain, not a window of orphaned
// aria-level=N rows.
describe('ancestorsOf', () => {
  // A deep tree with SIBLINGS at each level, so the derivation must pick the real parent chain
  // (root → context → value-object), not merely adjacent rows.
  function deepFixture(): SyntaxTreeNode {
    return node('KoineModel', null, [
      node('ContextNode', 'Billing', [
        node('ValueObjectDecl', 'Money', [
          node('Member', 'amount', []), // 0/0/0/0 — the level-4 target
          node('Member', 'currency', []), // 0/0/0/1 — a sibling member
        ]),
        node('ValueObjectDecl', 'Rate', []), // 0/0/1 — a sibling value object
      ]),
      node('ContextNode', 'Shipping', []), // 0/1 — a sibling context
    ]);
  }

  test('returns root..parent (with real aria-levels + sibling metadata) of a deep row', () => {
    const root = deepFixture();
    const expanded = new Set(['0', '0/0', '0/0/0']); // fully expand down to the members
    const rows = flattenVisible(root, expanded);

    // The first-visible row landing on the level-4 Member `amount` yields its three real ancestors, in
    // root..parent order, each carrying the aria-level it would have inline.
    const target = rows.findIndex((r) => r.key === '0/0/0/0');
    expect(rows[target].level).toBe(4);
    const path = ancestorsOf(root, rows[target].key, expanded);
    expect(path.map((r) => r.node.kind)).toEqual(['KoineModel', 'ContextNode', 'ValueObjectDecl']);
    expect(path.map((r) => r.level)).toEqual([1, 2, 3]);
    expect(path.map((r) => r.key)).toEqual(['0', '0/0', '0/0/0']);
    // Honest sibling metadata is carried through: Money is child 1 of Billing's two value objects.
    expect(path[2].posInSet).toBe(1);
    expect(path[2].setSize).toBe(2);
  });

  test('a first-visible row that IS a root has no ancestors — the band collapses to empty', () => {
    const root = deepFixture();
    const expanded = new Set(['0', '0/0', '0/0/0']);
    const rows = flattenVisible(root, expanded);
    expect(rows[0].level).toBe(1);
    expect(ancestorsOf(root, rows[0].key, expanded)).toEqual([]);
  });
});
