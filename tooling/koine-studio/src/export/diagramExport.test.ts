import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import mermaid from 'mermaid';
import * as mx from '@maxgraph/core';
import { canvasToSvg, diagramToMermaid, diagramToPlantUml, exportDiagram, svgToPng } from '@/export/diagramExport';
import { buildCanvas } from '@/diagrams/diagrams-maxgraph';
import type { Diagram, DiagramEdge, DiagramGraph, DiagramMember, DiagramNode } from '@/lsp/protocol';

// The diagram renderer routes its rename/delete gestures through Koine's modal overlay; stub it so importing
// buildCanvas (and constructing a canvas) stays side-effect-free in this DOM-driven test.
vi.mock('@atypical/koine-ui', () => ({ koiPrompt: vi.fn(), koiConfirm: vi.fn() }));

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

// --- diagramToMermaid: one valid Mermaid classDiagram from the merged graph (issue #271 review) -----------

describe('diagramToMermaid', () => {
  const aggregate = graph(
    [
      node({
        id: 'Ordering.Order',
        label: 'Order',
        stereotype: 'aggregate root',
        members: [member('id: OrderId', 'field'), member('submit()', 'method')],
      }),
      node({ id: 'Ordering.OrderLine', label: 'OrderLine' }),
    ],
    [edge({ from: 'Ordering.Order', to: 'Ordering.OrderLine', label: 'lines', arrowKind: 'composition', sourceCardinality: '1', cardinality: '*' })],
  );

  it('starts with a single classDiagram header (a valid one-document snippet)', () => {
    const out = diagramToMermaid(aggregate);
    expect(out.startsWith('classDiagram')).toBe(true);
    expect(out.match(/classDiagram/g)?.length).toBe(1);
  });

  it('declares each node as a labelled class with sanitized id and member rows', () => {
    const out = diagramToMermaid(aggregate);
    expect(out).toContain('class Ordering_Order["Order"]');
    // The typed member `id: OrderId` emits colon-free (issue #340): Mermaid reads the colon after the
    // class id as the member separator, so a second colon in the member text aborts the parse.
    expect(out).toContain('Ordering_Order : id OrderId');
    expect(out).toContain('Ordering_Order : submit()');
  });

  it('renders a composition edge with cardinalities resolving to the sanitized ids', () => {
    const out = diagramToMermaid(aggregate);
    expect(out).toContain('Ordering_Order "1" *-- "*" Ordering_OrderLine : lines');
  });

  it('strips Mermaid-structural characters from labels/members so they cannot break the document', () => {
    const g = graph([node({ id: 'A', label: 'Lab"el [x] {y}', members: [member('m`{}`', 'field')] })], []);
    const out = diagramToMermaid(g);
    expect(out).not.toContain('"Lab"el'); // the inner quote was neutralised
    expect(out).not.toMatch(/\[x\]|\{y\}/); // brackets/braces stripped from the label
    expect(out).toContain('classDiagram');
  });

  it('skips a dangling edge whose endpoint has no declared node', () => {
    const g = graph([node({ id: 'A' })], [edge({ from: 'A', to: 'ghost' })]);
    const out = diagramToMermaid(g);
    expect(out).not.toContain('ghost');
  });

  it('emits a bare classDiagram for an empty graph', () => {
    expect(diagramToMermaid(graph([], [])).trim()).toBe('classDiagram');
  });

  // issue #340: Mermaid's classDiagram grammar reads the FIRST colon after a class id as the member
  // separator, so any colon INSIDE the member text — a typed field `street: String`, a method signature
  // `schedule(order: OrderId): Delivery` — is a second separator that aborts the parse. Every member row
  // must therefore carry no colon past the leading `alias :` separator.
  it('emits no colon after the leading "alias :" member separator (issue #340)', () => {
    const typed = graph(
      [
        node({ id: 'Delivery.Address', label: 'Address', members: [member('street: String', 'field')] }),
        node({
          id: 'Delivery.Scheduler',
          label: 'Scheduler',
          members: [member('schedule(order: OrderId, destination: Address): Delivery', 'method')],
        }),
      ],
      [],
    );
    const out = diagramToMermaid(typed);
    // Member rows are `  alias : text`; exclude the `class …` declarations and the `-->`/`*--` edge rows.
    const memberRows = out
      .split('\n')
      .filter((l) => / : /.test(l) && !/^\s*class /.test(l) && !/-->|\*--/.test(l));
    expect(memberRows.length).toBeGreaterThan(0); // the fixture really produced member rows
    for (const row of memberRows) {
      const afterSeparator = row.slice(row.indexOf(' : ') + 3);
      expect(afterSeparator).not.toContain(':');
    }
  });
});

// --- diagramToMermaid renders in Mermaid: a real parse guard (issue #340) --------------------------------
// The #271 string-shape tests above never fed their output to Mermaid, so the double-colon parse bug stayed
// green. This guard parses the emitted document with the actual `mermaid` library, so the same class of bug
// can't slip through CI again. (mermaid.parse rejects invalid input; suppressErrors:true returns false
// instead of throwing — a stable boolean to assert under happy-dom.)

describe('diagramToMermaid → renders in Mermaid (issue #340)', () => {
  // One graph exercising every shape that touches the member/edge emit path: a typed field, an optional `?`
  // field, a method signature with inner colons + parens, generic/collection fields with angle brackets and
  // a comma (`List<OrderLine>`, `Map<String, Int>` — the real shapes the compiler emits, see
  // DocsEmitter.Diagrams / MarkdownDoc.KoineType), an enum-member row (already colon-free), a composition
  // edge with cardinalities, and a cross-context edge label.
  const rich = graph(
    [
      node({
        id: 'Delivery.Address',
        label: 'Address',
        stereotype: 'value object',
        members: [member('street: String', 'field'), member('zip?: String', 'field')],
      }),
      node({
        id: 'Delivery.Scheduler',
        label: 'Scheduler',
        stereotype: 'domain service',
        members: [member('schedule(order: OrderId, destination: Address): Delivery', 'method')],
      }),
      node({
        id: 'Delivery.Status',
        label: 'Status',
        stereotype: 'enum',
        members: [member('Pending', 'enum-member'), member('Delivered', 'enum-member')],
      }),
      node({
        id: 'Ordering.Order',
        label: 'Order',
        members: [member('lines: List<OrderLine>', 'field'), member('totals: Map<String, Int>', 'field')],
      }),
    ],
    [
      edge({
        from: 'Delivery.Scheduler',
        to: 'Delivery.Address',
        arrowKind: 'composition',
        sourceCardinality: '1',
        cardinality: '0..1',
        label: 'destination',
      }),
      edge({ from: 'Ordering.Order', to: 'Delivery.Scheduler', arrowKind: 'association', label: 'publishes' }),
    ],
  );

  it('parses the emitted document as one valid classDiagram (no parse error)', async () => {
    const out = diagramToMermaid(rich);
    const result = await mermaid.parse(out, { suppressErrors: true });
    // `false` => Mermaid rejected the document; a truthy diagram descriptor => it parsed.
    expect(result).not.toBe(false);
  });

  it('would reject the pre-fix double-colon member shape (the guard has teeth)', async () => {
    // The bug emitted `Alias : street: String`; confirm Mermaid actually rejects that, so the test above is
    // a real regression guard and not vacuously green.
    const broken = 'classDiagram\n  class A["A"]\n  A : street: String\n';
    const result = await mermaid.parse(broken, { suppressErrors: true });
    expect(result).toBe(false);
  });

  // issue #343: the edge-label path has the identical latent defect #340 fixed for member rows. Mermaid's
  // classDiagram edge syntax is `A --> B : label`, so a colon INSIDE the label is a second separator that
  // aborts the parse — symmetric to the member bug. Routing the edge label through the same colon-safe
  // sanitizer keeps the document parseable for any label.
  it('parses an edge whose label contains a colon (issue #343)', async () => {
    const g = graph(
      [node({ id: 'A', label: 'A' }), node({ id: 'B', label: 'B' })],
      [edge({ from: 'A', to: 'B', arrowKind: 'association', label: 'tagged: urgent' })],
    );
    const out = diagramToMermaid(g);
    const result = await mermaid.parse(out, { suppressErrors: true });
    // Before the fix the row emits `A --> B : tagged: urgent` and Mermaid rejects the second colon.
    expect(result).not.toBe(false);
  });

  it('would reject the pre-fix colon-bearing edge label (the guard has teeth)', async () => {
    // Confirm Mermaid actually rejects `A --> B : a:b`, so the test above is a real regression guard.
    const broken = 'classDiagram\n  class A["A"]\n  class B["B"]\n  A --> B : a:b\n';
    const result = await mermaid.parse(broken, { suppressErrors: true });
    expect(result).toBe(false);
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

// --- svgToPng + exportDiagram (issue #271 Task 3) --------------------------------------------------------

function diagramFixture(over: Partial<Diagram> = {}): Diagram {
  return {
    caption: over.caption ?? 'Order aggregate',
    kind: over.kind ?? 'aggregate',
    mermaid: over.mermaid ?? '',
    graph:
      over.graph ??
      graph(
        [
          node({
            id: 'Ordering.Order',
            label: 'Order',
            kind: 'aggregate-root',
            qualifiedName: 'Ordering.Order',
            stereotype: 'aggregate root',
            members: [member('id: OrderId', 'field')],
          }),
        ],
        [],
      ),
  };
}

describe('svgToPng', () => {
  // happy-dom has no real 2D raster — stub the browser primitives so the code path runs and yields bytes.
  class StubImage {
    onload: (() => void) | null = null;
    onerror: ((e?: unknown) => void) | null = null;
    width = 100;
    height = 80;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rasterizes an SVG string to a non-empty PNG byte array (stubbed raster)', async () => {
    vi.stubGlobal('Image', StubImage as unknown as typeof Image);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale() {},
      drawImage() {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,' + btoa('PNGDATA'),
    );

    const bytes = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('rejects when the image fails to load', async () => {
    class FailImage {
      onload: (() => void) | null = null;
      onerror: ((e?: unknown) => void) | null = null;
      width = 0;
      height = 0;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.(new Error('boom')));
      }
    }
    vi.stubGlobal('Image', FailImage as unknown as typeof Image);
    await expect(svgToPng('<svg/>')).rejects.toThrow();
  });
});

describe('exportDiagram', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exports PlantUML: saves a .puml name with the UTF-8 PlantUML bytes', async () => {
    const diagram = diagramFixture({ caption: 'Order aggregate' });
    const save = vi.fn().mockResolvedValue(true);

    const ok = await exportDiagram('plantuml', diagram, {} as Parameters<typeof exportDiagram>[2], save);

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    const [name, bytes] = save.mock.calls[0] as [string, Uint8Array];
    expect(name.endsWith('.puml')).toBe(true);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain('@startuml');
    expect(decoded).toBe(diagramToPlantUml(diagram.graph, diagram.kind, diagram.caption));
  });

  it('exports SVG: saves a .svg name with the canvas SVG bytes', async () => {
    const diagram = diagramFixture();
    const container = makeContainer();
    const handle = buildCanvas(mx, container, diagram.graph);
    const save = vi.fn().mockResolvedValue(true);
    try {
      handle.graph.getView().revalidate();
      const ok = await exportDiagram('svg', diagram, handle, save);
      expect(ok).toBe(true);
      const [name, bytes] = save.mock.calls[0] as [string, Uint8Array];
      expect(name.endsWith('.svg')).toBe(true);
      const decoded = new TextDecoder().decode(bytes);
      expect(decoded.startsWith('<svg')).toBe(true);
    } finally {
      handle.dispose();
      container.remove();
    }
  });

  it('propagates a cancelled save as false and a successful save as true', async () => {
    const diagram = diagramFixture();
    const cancelled = vi.fn().mockResolvedValue(false);
    const succeeded = vi.fn().mockResolvedValue(true);

    const handle = {} as Parameters<typeof exportDiagram>[2];
    expect(await exportDiagram('plantuml', diagram, handle, cancelled)).toBe(false);
    expect(await exportDiagram('plantuml', diagram, handle, succeeded)).toBe(true);
  });

  it('derives a safe base name from a blank caption (fallback to diagram)', async () => {
    const diagram = diagramFixture({ caption: '   ' });
    const save = vi.fn().mockResolvedValue(true);
    await exportDiagram('plantuml', diagram, {} as Parameters<typeof exportDiagram>[2], save);
    const [name] = save.mock.calls[0] as [string, Uint8Array];
    expect(name).toBe('diagram.puml');
  });

  it('sanitizes path-hostile characters in the caption', async () => {
    const diagram = diagramFixture({ caption: 'Ordering/Order: v1?' });
    const save = vi.fn().mockResolvedValue(true);
    await exportDiagram('plantuml', diagram, {} as Parameters<typeof exportDiagram>[2], save);
    const [name] = save.mock.calls[0] as [string, Uint8Array];
    expect(name.endsWith('.puml')).toBe(true);
    expect(name).not.toMatch(/[/\\:?*"<>|]/);
  });
});
