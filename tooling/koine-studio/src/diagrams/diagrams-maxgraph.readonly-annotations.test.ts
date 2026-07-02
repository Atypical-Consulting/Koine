// Regression: the palette's annotation-create event is dispatched on `document`, so a mounted READ-ONLY
// canvas (the bottom Context Map tab's graph) used to answer it alongside the domain canvas — authoring
// the note on the invisible map and clobbering the workspace's saved layout (positions/notes) with the
// context map's cells. The scenario needs BOTH canvases listening on a pristine `document`, so it lives
// in its own file: the main suite's renderer tests leave undisposed canvases listening on `document`,
// which would answer the event too and mask what this test asserts.
import { describe, expect, test, beforeAll, afterEach, vi } from 'vitest';
import * as mx from '@maxgraph/core';
import { buildCanvas } from '@/diagrams/diagrams-maxgraph';

// The annotation prompt routes through Koine's own modal; stub it so the test drives the async dialog.
vi.mock('@atypical/koine-ui', () => ({ koiPrompt: vi.fn(), koiConfirm: vi.fn() }));
import { koiPrompt } from '@atypical/koine-ui';
import {
  DIAGRAM_ANNOTATION_CREATE_EVENT,
  positionKey,
  setDiagramEditing,
  setDiagramLayoutStore,
  setDiagramPersistScope,
} from '@/diagrams/diagramContract';
import { loadDiagramAnnotations, loadDiagramPositions } from '@/settings/persistence';
import { createBrowserLayoutStore } from '@/diagrams/layoutStore';
import type { DiagramGraph, DiagramNode } from '@/lsp/lsp';

// happy-dom returns 0 from getBoundingClientRect; maxGraph reads the container rect on construction.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
});

afterEach(() => {
  document.body.innerHTML = '';
  setDiagramEditing(false);
  setDiagramPersistScope('scratch');
  setDiagramLayoutStore(null);
  localStorage.clear();
  vi.clearAllMocks();
});

function makeContainer(): HTMLElement {
  const c = document.createElement('div');
  Object.assign(c.style, { width: '800px', height: '600px' });
  document.body.appendChild(c);
  return c;
}

function node(over: Partial<DiagramNode> & { id: string; qualifiedName: string }): DiagramNode {
  return {
    id: over.id,
    label: over.label ?? over.qualifiedName,
    kind: over.kind ?? 'value-object',
    qualifiedName: over.qualifiedName,
    sourceSpan: over.sourceSpan ?? null,
    stereotype: over.stereotype ?? null,
    members: over.members ?? [],
  };
}

describe('read-only canvas vs. the create-annotation event', () => {
  test('only the domain canvas authors the note; the read-only map never persists over the saved layout', async () => {
    setDiagramEditing(true); // ide flips editing on at boot; the canvas's own readOnly contract must still win
    setDiagramPersistScope('ws-readonly-annotations');
    // The user's hand-arranged domain layout, already saved to the shared per-workspace store.
    const seededNote = { id: 'note-1', text: 'Remember to model returns', x: 600, y: 30, width: 180, height: 96 };
    createBrowserLayoutStore().save({ positions: { 'Ordering.Order': { x: 500, y: 120 } }, notes: [seededNote], groups: [] });
    vi.mocked(koiPrompt).mockResolvedValue('Returns flow TBD');

    const domainGraph: DiagramGraph = {
      nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' })],
      edges: [],
    };
    const ctxMapGraph: DiagramGraph = {
      nodes: [
        node({ id: 'Sales', qualifiedName: 'Sales', kind: 'context' }),
        node({ id: 'Shipping', qualifiedName: 'Shipping', kind: 'context' }),
      ],
      edges: [{ from: 'Sales', to: 'Shipping', label: 'Customer/Supplier', arrowKind: 'association' }],
    };
    // Both canvases mounted at once, like the domain tab + the bottom Context Map tab's Graph view.
    const domain = buildCanvas(mx, makeContainer(), domainGraph, await createBrowserLayoutStore().load());
    const ctxMap = buildCanvas(mx, makeContainer(), ctxMapGraph, undefined, { readOnly: true });
    try {
      document.dispatchEvent(new CustomEvent(DIAGRAM_ANNOTATION_CREATE_EVENT, { detail: { kind: 'note' } }));
      await new Promise((r) => setTimeout(r, 0)); // let the koiPrompt promise chains settle

      // The note lands on the editable domain canvas only; the read-only context map stays inert.
      expect(domain.noteCells.size).toBe(2); // the restored note + the freshly-authored one
      expect(ctxMap.noteCells.size).toBe(0);
      expect(koiPrompt).toHaveBeenCalledTimes(1);

      // The persisted layout is the DOMAIN canvas's: the hand-arranged position and both notes survive —
      // the context map's cells never overwrite the shared store.
      const positions = loadDiagramPositions(positionKey());
      expect(positions['Ordering.Order']).toEqual({ x: 500, y: 120 });
      expect(positions['Sales']).toBeUndefined();
      expect(loadDiagramAnnotations(positionKey()).notes).toHaveLength(2);
    } finally {
      domain.dispose();
      ctxMap.dispose();
    }
  });
});
