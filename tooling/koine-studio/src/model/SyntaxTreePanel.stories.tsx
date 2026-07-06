import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
import { SyntaxTreePanel, type SyntaxTreeSource } from '@/model/SyntaxTreePanel';
import type { SourceSpan, SyntaxTreeNode } from '@/lsp/protocol';

// The right-rail Syntax Tree panel (#890) — the active document's raw parse tree as a keyboard-navigable
// WAI-ARIA tree. The panel owns its own async fetch rather than reading the store, so each story seeds a
// small in-memory {@link SyntaxTreeSource} fake (a plain async fn — stories run in the Chromium project,
// no `vi`). The "recovered" story exercises the error/missing recovery rows the panel must render
// distinctly. The @storybook/addon-a11y axe pass (Chromium/CI — not runnable locally) guards each state.

// A shared throwaway span — the panel renders structure, not coordinates.
const SPAN: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 1, offset: 0, length: 0, file: null };

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

/** The large model scrolled DEEP (#1106): the window-top row is a level-3 member whose level-1/2 ancestors
 *  have scrolled out of the mounted slice, so the sticky ancestors band mounts above the window to keep the
 *  aria-level chain unbroken in the DOM. The `play` scrolls the bounded viewport and waits for the band, so
 *  the @storybook/addon-a11y axe pass exercises the banded state that the top-of-list stories never reach.
 *  Rendered inside a fixed-height host so the tree body is a real windowing viewport (the panel is
 *  `height:100%`, sized by the right rail in the app). */
export const LargeTreeScrolledToBand: Story = {
  args: { source: makeSource(largeTree) },
  render: (args) => (
    <div style="height:360px;display:flex;flex-direction:column;border:1px solid var(--koi-line);border-radius:8px;overflow:hidden">
      <SyntaxTreePanel {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const scroller = canvasElement.querySelector<HTMLElement>('.koi-stree-scroll');
    await waitFor(() => expect(scroller?.querySelector('[role="tree"]')).toBeTruthy());
    // Scroll deep so the window mounts only level-3 members; the root/context ancestors move into the band.
    scroller!.scrollTop = Math.floor(scroller!.scrollHeight * 0.5);
    scroller!.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(canvasElement.querySelector('.koi-stree-item--band')).toBeTruthy());
  },
};

/** An unknown/absent active document (`syntaxTree` resolves null): the panel paints its empty state
 *  rather than blanking or crashing. */
export const Empty: Story = {
  args: { source: makeSource(null) },
};
