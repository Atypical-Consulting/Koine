import type { Meta, StoryObj } from '@storybook/preact-vite';
import { SyntaxTreePanel, type SyntaxTreeSource } from '@/model/SyntaxTreePanel';
import type { SyntaxSpan, SyntaxTreeNode } from '@/lsp/protocol';

// The right-rail Syntax Tree panel (#890) — the active document's raw parse tree as a keyboard-navigable
// WAI-ARIA tree. The panel owns its own async fetch rather than reading the store, so each story seeds a
// small in-memory {@link SyntaxTreeSource} fake (a plain async fn — stories run in the Chromium project,
// no `vi`). The "recovered" story exercises the error/missing recovery rows the panel must render
// distinctly. The @storybook/addon-a11y axe pass (Chromium/CI — not runnable locally) guards each state.

// A shared throwaway span — the panel renders structure, not coordinates.
const SPAN: SyntaxSpan = { line: 1, column: 1, endLine: 1, endColumn: 1, offset: 0, length: 0, file: null };

function node(
  kind: string,
  name: string | null,
  children: SyntaxTreeNode[] = [],
  extra: Partial<SyntaxTreeNode> = {},
): SyntaxTreeNode {
  return { kind, name, span: SPAN, isMissing: false, isError: false, leaf: null, children, ...extra };
}

/** A static in-memory source: `syntaxTree` resolves the given tree (or null for the empty state). */
function makeSource(tree: SyntaxTreeNode | null): SyntaxTreeSource {
  return { syntaxTree: async () => tree };
}

const normalTree: SyntaxTreeNode = node('KoineModel', null, [
  node('ContextNode', 'Billing', [
    node('ValueObjectDecl', 'Money', [
      node('Member', 'amount', [node('TypeRef', null, [], { leaf: 'Decimal' })]),
      node('Member', 'currency', [node('TypeRef', null, [], { leaf: 'Currency' })]),
      node('Invariant', null, [node('BinaryExpr', null, [], { leaf: 'amount >= 0' })]),
    ]),
    node('EntityDecl', 'Invoice', [
      node('Member', 'id', [node('TypeRef', null, [], { leaf: 'InvoiceId' })]),
      node('Member', 'total', [node('TypeRef', null, [], { leaf: 'Money' })]),
    ]),
  ]),
]);

// A large model: one context with 3000 sibling members — well past the panel's windowing threshold, so
// only a viewport slice mounts. Exercises the virtualized render + a11y (aria-level/setsize/posinset,
// single roving tab stop) under breadth (#1098).
const largeTree: SyntaxTreeNode = node('KoineModel', null, [
  node(
    'ContextNode',
    'Big',
    Array.from({ length: 3000 }, (_, i) => node('Member', `field${i}`, [], { leaf: 'Int' })),
  ),
]);

// A half-typed file's recovered tree: a dangling ErrorNode and a phantom (missing) node ANTLR inserts
// during error recovery, alongside otherwise-valid structure.
const recoveredTree: SyntaxTreeNode = node('KoineModel', null, [
  node('ContextNode', 'Ordering', [
    node('ValueObjectDecl', 'Quantity', [
      node('Member', 'value', [node('TypeRef', null, [], { leaf: 'Int' })]),
      node('Member', 'unit', [], { isMissing: true }), // a member whose type never got typed
    ]),
    node('ErrorNode', null, [], { isError: true, leaf: 'aggreg' }), // a half-typed keyword
  ]),
]);

const meta = {
  title: 'Panels/SyntaxTreePanel',
  component: SyntaxTreePanel,
  parameters: { layout: 'padded' },
  args: {
    source: makeSource(normalTree),
  },
} satisfies Meta<typeof SyntaxTreePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A well-formed model: the root + its top-level context expand by default; deeper nodes (members,
 *  invariants) start collapsed and expand on demand. */
export const NormalTree: Story = {};

/** A half-typed file: the parser's recovered tree carries an `ErrorNode` and a `missing` member, each
 *  rendered with its distinct recovery marker so the recovered subtree stays legible. */
export const RecoveredErrorTree: Story = {
  args: { source: makeSource(recoveredTree) },
};

/** A large model (one context, 3000 members): the panel virtualizes, mounting only a viewport window of
 *  rows while keeping the flat WAI-ARIA semantics and a single roving tab stop. Guards the windowed render
 *  against the @storybook/addon-a11y axe pass (Chromium/CI). */
export const LargeTree: Story = {
  args: { source: makeSource(largeTree) },
};

/** An unknown/absent active document (`syntaxTree` resolves null): the panel paints its empty state
 *  rather than blanking or crashing. */
export const Empty: Story = {
  args: { source: makeSource(null) },
};
