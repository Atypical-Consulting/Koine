import { describe, expect, it, beforeAll, vi } from 'vitest';
import * as mx from '@maxgraph/core';
import { canvasToSvg, diagramToPlantUml } from '@/export/diagramExport';
import { buildCanvas } from '@/diagrams/diagrams-maxgraph';
import type { DiagramEdge, DiagramGraph, DiagramMember, DiagramNode } from '@/lsp/protocol';

// The diagram renderer routes its rename/delete gestures through Koine's modal overlay; stub it so importing
// buildCanvas (and constructing a canvas) stays side-effect-free in this DOM-driven test.
vi.mock('@/shared/overlay', () => ({ koiPrompt: vi.fn(), koiConfirm: vi.fn() }));

// happy-dom returns 0 from getBoundingClientRect; maxGraph reads the container rect on construction. Shim it
// so the graph constructs with a sane size (mirrors diagrams-maxgraph.test.ts) and assert on the STRING.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
});

// --- fixture builders --------------------------------------------------------

function member(text: string, kind: string): DiagramMember {
  return { text, kind };
}

function node(over: Partial<DiagramNode> & { id: string }): DiagramNode {
  return {
    id: over.id,
    label: over.label ?? over.id,
    kind: over.kind ?? 'value-object',
    qualifiedName: over.qualifiedName ?? over.id,
    sourceSpan: over.sourceSpan ?? null,
    stereotype: over.stereotype ?? null,
    members: over.members ?? [],
    invariants: over.invariants,
    doc: over.doc,
  };
}

function edge(over: Partial<DiagramEdge> & { from: string; to: string }): DiagramEdge {
  return {
    from: over.from,
    to: over.to,
    label: over.label ?? null,
    cardinality: over.cardinality ?? null,
    sourceCardinality: over.sourceCardinality ?? null,
    arrowKind: over.arrowKind ?? null,
    backingMember: over.backingMember ?? null,
  };
}

function graph(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramGraph {
  return { nodes, edges };
}

describe('diagramToPlantUml', () => {
  describe('aggregate → class diagram', () => {
    const g = graph(
      [
        node({
          id: 'Ordering.Order',
          label: 'Order',
          kind: 'aggregate-root',
          qualifiedName: 'Ordering.Order',
          stereotype: 'aggregate root',
          members: [member('id: OrderId', 'field'), member('total: Money', 'field'), member('submit()', 'method')],
        }),
        node({
          id: 'Ordering.OrderLine',
          label: 'OrderLine',
          kind: 'entity',
          qualifiedName: 'Ordering.OrderLine',
          stereotype: 'entity',
          members: [member('qty: int', 'field')],
        }),
      ],
      [
        edge({
          from: 'Ordering.Order',
          to: 'Ordering.OrderLine',
          arrowKind: 'composition',
          cardinality: '*',
          sourceCardinality: '1',
          label: 'lines',
        }),
      ],
    );

    it('wraps output in @startuml/@enduml', () => {
      const out = diagramToPlantUml(g, 'aggregate', 'Order aggregate');
      expect(out.startsWith('@startuml')).toBe(true);
      expect(out.trimEnd().endsWith('@enduml')).toBe(true);
    });

    it('includes the caption as a title', () => {
      const out = diagramToPlantUml(g, 'aggregate', 'Order aggregate');
      expect(out).toContain('title Order aggregate');
    });

    it('emits a class declaration per node with a sanitized id', () => {
      const out = diagramToPlantUml(g, 'aggregate', 'Order aggregate');
      expect(out).toContain('class "Order" as Ordering_Order');
      expect(out).toContain('class "OrderLine" as Ordering_OrderLine');
    });

    it('emits the UML stereotype', () => {
      const out = diagramToPlantUml(g, 'aggregate', 'Order aggregate');
      expect(out).toContain('<<aggregate root>>');
    });

    it('emits member rows from node.members', () => {
      const out = diagramToPlantUml(g, 'aggregate', 'Order aggregate');
      expect(out).toContain('id: OrderId');
      expect(out).toContain('total: Money');
      expect(out).toContain('submit()');
    });

    it('emits a composition arrow with cardinalities and label', () => {
      const out = diagramToPlantUml(g, 'aggregate', 'Order aggregate');
      expect(out).toContain('Ordering_Order "1" *-- "*" Ordering_OrderLine : lines');
    });
  });

  describe('statemachine → state diagram', () => {
    const g = graph(
      [
        node({ id: 'Draft', label: 'Draft', kind: 'state', qualifiedName: 'Draft' }),
        node({ id: 'Submitted', label: 'Submitted', kind: 'state', qualifiedName: 'Submitted' }),
      ],
      [edge({ from: 'Draft', to: 'Submitted', arrowKind: 'transition', label: 'submit' })],
    );

    it('emits state declarations and a transition arrow', () => {
      const out = diagramToPlantUml(g, 'statemachine', 'Order lifecycle');
      expect(out).toContain('@startuml');
      expect(out).toContain('state "Draft" as Draft');
      expect(out).toContain('state "Submitted" as Submitted');
      expect(out).toContain('Draft --> Submitted : submit');
      expect(out).toContain('@enduml');
    });
  });

  describe('contextmap → component diagram', () => {
    const g = graph(
      [
        node({ id: 'Ordering', label: 'Ordering', kind: 'context', qualifiedName: 'Ordering' }),
        node({ id: 'Billing', label: 'Billing', kind: 'context', qualifiedName: 'Billing' }),
      ],
      [edge({ from: 'Ordering', to: 'Billing', arrowKind: 'association', label: 'customer-supplier' })],
    );

    it('emits component declarations and a relation arrow', () => {
      const out = diagramToPlantUml(g, 'contextmap', 'Context map');
      expect(out).toContain('component "Ordering" as Ordering');
      expect(out).toContain('component "Billing" as Billing');
      expect(out).toContain('Ordering --> Billing : customer-supplier');
    });

    it('emits a bidirectional arrow for bidirectional edges', () => {
      const bi = graph(
        [
          node({ id: 'Ordering', label: 'Ordering', kind: 'context', qualifiedName: 'Ordering' }),
          node({ id: 'Billing', label: 'Billing', kind: 'context', qualifiedName: 'Billing' }),
        ],
        [edge({ from: 'Ordering', to: 'Billing', arrowKind: 'bidirectional', label: 'partnership' })],
      );
      const out = diagramToPlantUml(bi, 'contextmap', 'Context map');
      expect(out).toContain('Ordering <--> Billing : partnership');
    });
  });

  describe('escaping & id sanitization', () => {
    it('sanitizes node ids with dots, spaces and special chars to underscores', () => {
      const g = graph(
        [node({ id: 'A.b-c d:e', label: 'Weird', kind: 'context', qualifiedName: 'A.b-c d:e' })],
        [],
      );
      const out = diagramToPlantUml(g, 'contextmap', 'X');
      expect(out).toContain('as A_b_c_d_e');
      // the raw, unsanitized id must not leak into an identifier position
      expect(out).not.toContain('as A.b-c d:e');
    });

    it('escapes quotes and newlines in labels', () => {
      const g = graph(
        [node({ id: 'n1', label: 'Say "hi"\nthere', kind: 'context', qualifiedName: 'n1' })],
        [],
      );
      const out = diagramToPlantUml(g, 'contextmap', 'X');
      // a literal double-quote inside the quoted label would break PlantUML; it must be escaped/stripped
      expect(out).not.toContain('"Say "hi"');
      // no raw newline inside the label
      expect(out).not.toMatch(/component "[^"]*\n/);
    });

    it('escapes special characters in the title', () => {
      const g = graph([], []);
      const out = diagramToPlantUml(g, 'aggregate', 'Line1\nLine2');
      expect(out).not.toMatch(/title [^\n]*\nLine2/);
    });

    it('resolves edges against sanitized ids', () => {
      const g = graph(
        [
          node({ id: 'Ctx.A', label: 'A', kind: 'context', qualifiedName: 'Ctx.A' }),
          node({ id: 'Ctx.B', label: 'B', kind: 'context', qualifiedName: 'Ctx.B' }),
        ],
        [edge({ from: 'Ctx.A', to: 'Ctx.B', arrowKind: 'association', label: 'uses' })],
      );
      const out = diagramToPlantUml(g, 'contextmap', 'X');
      expect(out).toContain('Ctx_A --> Ctx_B : uses');
    });
  });

  describe('empty / unknown / degenerate graphs', () => {
    it('yields a valid empty skeleton for an empty graph', () => {
      const out = diagramToPlantUml(graph([], []), 'aggregate', '');
      expect(out).toContain('@startuml');
      expect(out).toContain('@enduml');
    });

    it('does not throw on an unknown kind and still produces a skeleton', () => {
      const g = graph([node({ id: 'X', label: 'X', kind: 'event', qualifiedName: 'X' })], []);
      const out = diagramToPlantUml(g, 'integration-events', 'Events');
      expect(out).toContain('@startuml');
      expect(out).toContain('@enduml');
      expect(out).toContain('X');
    });

    it('omits the title line when caption is empty', () => {
      const out = diagramToPlantUml(graph([], []), 'aggregate', '');
      expect(out).not.toContain('title ');
    });
  });
});

// --- canvasToSvg: standalone SVG from the live maxGraph canvas (issue #271 Task 2) -------------------------

function makeContainer(): HTMLElement {
  const c = document.createElement('div');
  Object.assign(c.style, { width: '800px', height: '600px' });
  document.body.appendChild(c);
  return c;
}

describe('canvasToSvg', () => {
  // A single dotted node so buildCanvas draws a class box with a `.koi-node[data-qname]` HTML label, plus a
  // bounded-context swimlane (whose stroke uses var(--koi-line)) — exercising both the node markup and a
  // var() that must be resolved in the export.
  const merged: DiagramGraph = {
    nodes: [
      node({
        id: 'Ordering.Order',
        label: 'Order',
        kind: 'aggregate-root',
        qualifiedName: 'Ordering.Order',
        stereotype: 'aggregate root',
        members: [member('id: OrderId', 'field'), member('total: Money', 'field')],
      }),
    ],
    edges: [],
  };

  it('returns a standalone <svg> document carrying the SVG namespace and a concrete viewBox', () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      handle.graph.getView().revalidate();
      const out = canvasToSvg(handle);
      expect(out.startsWith('<svg')).toBe(true);
      expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(out).toMatch(/viewBox="[-\d]+ [-\d]+ \d+ \d+"/);
      expect(out).toMatch(/width="\d+"/);
      expect(out).toMatch(/height="\d+"/);
    } finally {
      handle.dispose();
      container.remove();
    }
  });

  it('carries the rendered node markup (label text + data-qname)', () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      handle.graph.getView().revalidate();
      const out = canvasToSvg(handle);
      expect(out).toContain('data-qname="Ordering.Order"');
      expect(out).toContain('Order');
    } finally {
      handle.dispose();
      container.remove();
    }
  });

  it('inlines the DDD palette so nothing renders as an unresolved var(), with concrete styling present', () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      handle.graph.getView().revalidate();
      const out = canvasToSvg(handle);
      // No unresolved custom-property reference survives into the standalone SVG.
      expect(out).not.toContain('var(');
      // The palette is inlined as a <style> block AND concrete colour attributes are present.
      expect(out).toContain('<style');
      expect(out).toContain('--koi-line: #2a3242');
      expect(out).toMatch(/(fill|stroke)="#[0-9a-fA-F]{3,6}"/);
    } finally {
      handle.dispose();
      container.remove();
    }
  });

  it('throws a clear error when the handle exposes no <svg> surface', () => {
    const fake = {
      graph: { getView: () => ({ getCanvas: () => null }), container: document.createElement('div') },
    } as unknown as Parameters<typeof canvasToSvg>[0];
    expect(() => canvasToSvg(fake)).toThrow(/no <svg>/);
  });
});
