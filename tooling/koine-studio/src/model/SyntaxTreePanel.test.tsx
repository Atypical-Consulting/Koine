import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { SyntaxTreePanel, type SyntaxTreeSource } from '@/model/SyntaxTreePanel';
import type { SyntaxSpan, SyntaxTreeNode } from '@/lsp/protocol';
import { axe } from 'vitest-axe';

// A throwaway raw span — the panel renders structure, not coordinates, so every fixture node can share
// one. (1-based, end-exclusive, matching the koine/syntaxTree wire shape.)
const SPAN: SyntaxSpan = { line: 1, column: 1, endLine: 1, endColumn: 1, offset: 0, length: 0, file: null };

/** Terse fixture-node builder so a tree literal stays readable. Non-leaf/flag fields default sensibly. */
function node(kind: string, name: string | null, children: SyntaxTreeNode[] = [], extra: Partial<SyntaxTreeNode> = {}): SyntaxTreeNode {
  return { kind, name, span: SPAN, isMissing: false, isError: false, leaf: null, children, ...extra };
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

  test('has no accessibility violations', async () => {
    const view = render(<SyntaxTreePanel source={makeSource(fixture())} />);
    await view.findByRole('tree', { name: /Syntax tree/i });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
