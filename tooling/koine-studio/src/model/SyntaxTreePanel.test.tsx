import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { SyntaxTreePanel, deepestContaining, type SyntaxTreeSource } from '@/model/SyntaxTreePanel';
import type { SyntaxSpan, SyntaxTreeNode } from '@/lsp/protocol';
import { axe } from 'vitest-axe';

// A throwaway raw span — the panel renders structure, not coordinates, so every fixture node can share
// one. (1-based, end-exclusive, matching the koine/syntaxTree wire shape.)
const SPAN: SyntaxSpan = { line: 1, column: 1, endLine: 1, endColumn: 1, offset: 0, length: 0, file: null };

/** Terse fixture-node builder so a tree literal stays readable. Non-leaf/flag fields default sensibly. */
function node(kind: string, name: string | null, children: SyntaxTreeNode[] = [], extra: Partial<SyntaxTreeNode> = {}): SyntaxTreeNode {
  return { kind, name, span: SPAN, isMissing: false, isError: false, leaf: null, children, ...extra };
}

// --- spanned fixtures (for the caret → node containment half of #890) -------------------------------
// The root carries the wire's all-zero span; the real nodes carry NESTING own-spans so a caret resolves
// to exactly one deepest containing node. Billing wraps lines 1–4; Money lines 2–3; the amount Member
// sits on line 3, cols 5–19 (end-exclusive at 20).
const zeroSpan: SyntaxSpan = { line: 0, column: 0, endLine: 0, endColumn: 0, offset: 0, length: 0, file: null };
const span = (line: number, column: number, endLine: number, endColumn: number): SyntaxSpan => ({
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
    // + 5000 members).
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(120);

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
    expect(items.length).toBeLessThan(120); // windowed, not 4002 in the DOM

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
});
