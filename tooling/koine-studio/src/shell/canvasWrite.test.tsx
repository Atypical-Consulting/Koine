import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the mobile-zone bar (a Preact component) to a no-op and capture the comment composer's callbacks
// so we can drive its onSubmit. Everything else (diagram contract, store, model helpers) runs for real.
vi.mock('@/shell/MobileZoneBar', () => ({ MobileZoneBar: () => null }));
const { composerOpts } = vi.hoisted(() => ({ composerOpts: { current: null as null | { onSubmit(text: string): void; onCancel(): void } } }));
vi.mock('@/review/CommentComposer', () => ({
  createCommentComposer: vi.fn((opts: { onSubmit(text: string): void; onCancel(): void }) => {
    composerOpts.current = opts;
    return { dispose: vi.fn() };
  }),
}));

import { createCanvasWrite, type CanvasWriteDeps } from '@/shell/canvasWrite';
import { DIAGRAM_ANNOTATION_CREATE_EVENT, EMPTY_STATE_PICK_EVENT, isDiagramTouchMode } from '@/diagrams/diagramContract';
import { BP_NARROW } from '@/shared/breakpoint';

function mountDom(): void {
  document.body.innerHTML = `
    <div id="center-visual"></div>
    <div id="mobile-zone-bar-host"></div>
    <div id="split"></div>`;
}

let disposers: Array<() => void> = [];
function build(over: Partial<CanvasWriteDeps> = {}): { cw: ReturnType<typeof createCanvasWrite>; deps: CanvasWriteDeps } {
  const deps = {
    editor: { getDoc: vi.fn(() => ''), setDoc: vi.fn() },
    workspace: { activeUri: vi.fn(() => 'file:///a.koi'), applyWorkspaceEdit: vi.fn() },
    lsp: { applyModelEdit: vi.fn(), rename: vi.fn() },
    controller: { loadDiagrams: vi.fn(), ensureModelIndex: vi.fn(async () => ({})), selectBottomTab: vi.fn(), selectCenter: vi.fn() },
    setStatus: vi.fn(),
    prompt: { ask: vi.fn() },
    confirm: { ask: vi.fn() },
    reviewStore: { add: vi.fn() },
    refreshReviewDecorations: vi.fn(),
    reviewAuthorName: () => 'You',
    gotoSourceSpan: vi.fn(),
    splitEl: document.getElementById('split') as HTMLElement,
    defaultCanvasZoom: 1,
    blank: 'context NewModel {\n\n}\n',
    ...over,
  } as unknown as CanvasWriteDeps;
  const cw = createCanvasWrite(deps);
  disposers.push(cw.dispose);
  return { cw, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  composerOpts.current = null;
  mountDom();
});
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  document.body.innerHTML = '';
});

describe('canvasWrite', () => {
  it('createCanvasAnnotation dispatches a DIAGRAM_ANNOTATION_CREATE event carrying the kind', () => {
    const { cw } = build();
    const seen: string[] = [];
    document.addEventListener(DIAGRAM_ANNOTATION_CREATE_EVENT, (e) => seen.push((e as CustomEvent).detail.kind), { once: true });
    cw.createCanvasAnnotation('note' as never);
    expect(seen).toEqual(['note']);
  });

  describe('applyStructuredEdit', () => {
    it('patches the buffer without a success toast on a successful model edit', async () => {
      const { cw, deps } = build();
      (deps.lsp.applyModelEdit as ReturnType<typeof vi.fn>).mockResolvedValue({
        diagnostics: [],
        uri: 'file:///a.koi',
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }],
      });
      const ok = await cw.applyStructuredEdit({ kind: 'addType', target: 'C', name: 'V', type: 'value' } as never);
      expect(ok).toBe(true);
      expect(deps.workspace.applyWorkspaceEdit).toHaveBeenCalledOnce();
      expect(deps.setStatus).not.toHaveBeenCalled();
    });

    it('rolls back (no patch) and surfaces the rejecting diagnostic', async () => {
      const { cw, deps } = build();
      (deps.lsp.applyModelEdit as ReturnType<typeof vi.fn>).mockResolvedValue({
        diagnostics: [{ code: 'KOI1234', message: 'nope' }],
        uri: null,
        edits: [],
      });
      const ok = await cw.applyStructuredEdit({ kind: 'addType', target: 'C', name: 'V', type: 'value' } as never);
      expect(ok).toBe(false);
      expect(deps.workspace.applyWorkspaceEdit).not.toHaveBeenCalled();
      expect(deps.setStatus).toHaveBeenCalledWith('KOI1234: nope', 'error');
    });
  });

  it('seeds a starter into a pristine doc on an empty-canvas pick (EMPTY_STATE_PICK round-trip)', () => {
    const { deps } = build({ editor: { getDoc: vi.fn(() => ''), setDoc: vi.fn() } as never });
    const canvas = document.getElementById('center-visual') as HTMLElement;
    canvas.dispatchEvent(new CustomEvent(EMPTY_STATE_PICK_EVENT, { detail: { kind: 'aggregate' } }));
    expect(deps.editor.setDoc).toHaveBeenCalledOnce();
    const written = (deps.editor.setDoc as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain('aggregate Sales root Order'); // the validated starter, replacing the pristine doc
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it('addReviewComment mounts a composer near the selection and commits a thread on submit', () => {
    const { cw, deps } = build();
    const span = { file: 'file:///a.koi', line: 1, column: 1, endLine: 1, endColumn: 2 };
    cw.addReviewComment(span as never);

    expect(document.querySelector('.koi-comment-composer-host')).not.toBeNull();
    expect(composerOpts.current).not.toBeNull();

    composerOpts.current!.onSubmit('looks good');
    expect(deps.reviewStore.add).toHaveBeenCalledWith('file:///a.koi', expect.objectContaining({ file: 'file:///a.koi' }), 'looks good', 'You');
    expect(deps.controller.selectBottomTab).toHaveBeenCalledWith('review');
    expect(deps.refreshReviewDecorations).toHaveBeenCalledOnce();
    // The composer host is torn down on submit.
    expect(document.querySelector('.koi-comment-composer-host')).toBeNull();
  });

  describe('onDiagramViewportResize (#1403 — createNarrowCrossHandler conversion)', () => {
    const origWidth = window.innerWidth;
    const setWidth = (value: number) =>
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value });

    afterEach(() => setWidth(origWidth));

    it('a breakpoint cross toggles touch mode exactly once and reloads diagrams; same-side ticks are no-ops', () => {
      setWidth(1280);
      const { deps } = build();
      expect(isDiagramTouchMode()).toBe(false);

      setWidth(500);
      window.dispatchEvent(new Event('resize'));
      expect(isDiagramTouchMode()).toBe(true);
      expect(deps.controller.loadDiagrams).toHaveBeenCalledOnce();

      // keyboard/address-bar churn on the same (narrow) side — no re-fire
      setWidth(BP_NARROW - 50);
      window.dispatchEvent(new Event('resize'));
      expect(isDiagramTouchMode()).toBe(true);
      expect(deps.controller.loadDiagrams).toHaveBeenCalledOnce();
    });
  });
});
