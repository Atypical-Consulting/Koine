// Tests for the mobile inspector bottom sheet (#221, Task 2): a three-detent (peek/half/full)
// draggable Properties surface shown below $bp-narrow. The first group exercises the standalone sheet
// (detents, aria-modal, dismiss gestures, focus trap, a11y); the last exercises the wiring through the
// real inspectorController on a narrow viewport (a selection raises the sheet + mounts Properties into
// its body). happy-dom renders the real DOM; @testing-library/preact drives the gestures.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createInspectorSheet, openInspectorSheet, type InspectorSheet } from '@/shell/inspectorSheet';
import { leftRailMarkup } from '@/shell/leftRail';
import {
  createInspectorController,
  type InspectorAssistant,
  type InspectorControllerDeps,
  type InspectorControllerLsp,
} from '@/shell/inspectorController';
import { createAppStore } from '@/store/index';
import type {
  CheckResult,
  ContextMapResult,
  DocsResult,
  DocumentSymbol,
  EmitPreviewResult,
  GlossaryEntry,
  GlossaryModel,
  SetDocResult,
} from '@/lsp/lsp';

// --- standalone-sheet harness ------------------------------------------------
let sheets: InspectorSheet[] = [];
function mountSheet(): { host: HTMLElement; api: InspectorSheet; sheet: HTMLElement } {
  const host = document.createElement('div');
  host.id = 'inspector-sheet-host';
  document.body.appendChild(host);
  const api = createInspectorSheet(host);
  sheets.push(api);
  const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
  return { host, api, sheet };
}

function setViewport(w: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
}

afterEach(() => {
  for (const s of sheets) s.destroy();
  sheets = [];
  document.body.innerHTML = '';
  setViewport(1024);
  vi.restoreAllMocks();
});

describe('createInspectorSheet — detents + dismiss gestures', () => {
  test('renders a role=dialog starting at peek (no aria-modal); contentNode is its body', () => {
    const { api, sheet } = mountSheet();
    expect(sheet).not.toBeNull();
    expect(sheet.dataset.detent).toBe('peek');
    expect(sheet.hasAttribute('aria-modal')).toBe(false);
    expect(api.isOpen()).toBe(false);
    const body = api.contentNode();
    expect(body.classList.contains('koi-sheet-body')).toBe(true);
    expect(sheet.contains(body)).toBe(true);
  });

  test("setDetent('half') opens it modal (aria-modal=true) and reveals the backdrop", () => {
    const { host, api, sheet } = mountSheet();
    api.setDetent('half');
    expect(sheet.dataset.detent).toBe('half');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(api.isOpen()).toBe(true);
    const backdrop = host.querySelector<HTMLElement>('.koi-sheet-backdrop')!;
    expect(backdrop.hidden).toBe(false);
  });

  test('tapping the backdrop returns the sheet to peek', () => {
    const { host, api, sheet } = mountSheet();
    api.setDetent('half');
    const backdrop = host.querySelector<HTMLElement>('.koi-sheet-backdrop')!;
    fireEvent.click(backdrop);
    expect(sheet.dataset.detent).toBe('peek');
    expect(sheet.hasAttribute('aria-modal')).toBe(false);
    expect(backdrop.hidden).toBe(true);
  });

  test('a swipe-down on the grab handle lowers the sheet a detent (half → peek)', () => {
    const { host, api, sheet } = mountSheet();
    api.setDetent('half');
    const handle = host.querySelector<HTMLElement>('.koi-sheet-handle')!;
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 240, pointerId: 1 });
    expect(sheet.dataset.detent).toBe('peek');
  });

  test('a committing swipe-up does NOT double-step via the trailing synthetic click (#221)', () => {
    const { host, sheet } = mountSheet();
    const handle = host.querySelector<HTMLElement>('.koi-sheet-handle')!;
    // The pointer drag commits ONE step (peek → half). A real browser then fires a `click`; it must be
    // swallowed so the sheet doesn't ALSO step to full.
    fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 40, pointerId: 1 }); // dy = -160 → raise one
    expect(sheet.dataset.detent).toBe('half');
    fireEvent.click(handle);
    expect(sheet.dataset.detent).toBe('half'); // still half — the trailing click did not step again
  });

  test('drag-to-dismiss sticks: a committing swipe-down’s trailing click does not re-raise (#221)', () => {
    const { host, api, sheet } = mountSheet();
    api.setDetent('half');
    const handle = host.querySelector<HTMLElement>('.koi-sheet-handle')!;
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 240, pointerId: 1 }); // dy = +140 → lower one (half → peek)
    expect(sheet.dataset.detent).toBe('peek');
    fireEvent.click(handle);
    expect(sheet.dataset.detent).toBe('peek'); // NOT immediately re-raised to half
  });

  test('a plain tap (no drag) still raises one detent', () => {
    const { host, sheet } = mountSheet();
    const handle = host.querySelector<HTMLElement>('.koi-sheet-handle')!;
    fireEvent.click(handle); // keyboard/no-drag path
    expect(sheet.dataset.detent).toBe('half');
  });

  test('the body is inert + hidden from AT at peek, and interactive at half (#221)', () => {
    const { api } = mountSheet();
    const body = api.contentNode();
    // Collapsed peek clips the body to the grab-handle strip: the still-mounted Properties form must be
    // OUT of the tab + AT order.
    expect(body.hasAttribute('inert')).toBe(true);
    expect(body.getAttribute('aria-hidden')).toBe('true');
    // Raised to half it becomes reachable again.
    api.setDetent('half');
    expect(body.hasAttribute('inert')).toBe(false);
    expect(body.hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('createInspectorSheet — full detent focus + dismiss', () => {
  test("opening to full blurs the editor, traps focus, and Esc restores focus to the prior element", () => {
    const { api, sheet } = mountSheet();
    // Two focusables in the body so the trap has somewhere to wrap to.
    api.contentNode().innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const editor = document.createElement('button');
    editor.id = 'fake-editor';
    document.body.appendChild(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    api.setDetent('full');
    // The editor lost focus and focus moved INTO the sheet.
    expect(document.activeElement).not.toBe(editor);
    expect(sheet.contains(document.activeElement)).toBe(true);

    // Focus trap: Tab off the last focusable wraps to the first; Shift+Tab off the first wraps to last.
    const focusables = Array.from(sheet.querySelectorAll<HTMLElement>('button'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Esc dismisses to peek and returns focus to the editor.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(sheet.dataset.detent).toBe('peek');
    expect(document.activeElement).toBe(editor);
  });
});

describe('createInspectorSheet — half detent is modal too (#221)', () => {
  test('opening to half moves focus into the sheet, traps Tab, and Esc dismisses + restores focus', () => {
    const { api, sheet } = mountSheet();
    // Two focusables in the body so the trap has somewhere to wrap to.
    api.contentNode().innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const editor = document.createElement('button');
    editor.id = 'fake-editor';
    document.body.appendChild(editor);
    editor.focus();

    // half — NOT full — is the common path (a node tap / selection raises to half); it must be just as modal.
    api.setDetent('half');
    expect(document.activeElement).not.toBe(editor);
    expect(sheet.contains(document.activeElement)).toBe(true);

    // Tab is trapped at half (the visible-focusable filter is overlay.ts's, shared with the modal chrome).
    const focusables = Array.from(sheet.querySelectorAll<HTMLElement>('button'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Esc routes through the app's single overlay stack (no sheet-scoped Esc listener): dismiss to peek +
    // restore focus to the editor it came from.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(sheet.dataset.detent).toBe('peek');
    expect(document.activeElement).toBe(editor);
  });
});

describe('createInspectorSheet — accessibility', () => {
  test('the open sheet has no axe violations at half and full', async () => {
    const { host, api } = mountSheet();
    api.setDetent('half');
    expect(await axe(host)).toHaveNoViolations();
    api.setDetent('full');
    expect(await axe(host)).toHaveNoViolations();
  });
});

// --- inspectorController wiring on a narrow viewport --------------------------
// A trimmed mirror of inspectorController.test.ts's seed (the id surface the controller's el() looks up)
// plus the #inspector-sheet-host mount node Task 2 adds to index.html. Lets the real controller build
// its sheet so we can assert the selection → sheet wiring end to end.
const APP_HTML = `
  <div id="app">
    <div id="breadcrumb-host" class="topbar-breadcrumb" hidden></div>
    <main id="split">
      <aside id="leftrail" class="pane">${leftRailMarkup()}</aside>
      <section id="center" class="pane">
        <div id="center-tabs" role="tablist"></div>
        <div id="center-body">
          <section id="center-visual" class="center-host" role="tabpanel">
            <div id="canvas-palette-host"></div>
            <div id="diagram-host"></div>
          </section>
          <section id="center-technical" class="center-host" role="tabpanel" hidden>
            <div id="tech-tabs" role="tablist">
              <button type="button" class="tech-tab" id="tech-tab-preview" role="tab" data-tech="preview" aria-selected="false">Generated</button>
            </div>
            <div id="tech-body">
              <section id="editor-pane" class="tech-view"></section>
              <div id="view-preview" class="tech-view" role="tabpanel" hidden></div>
              <div id="view-check" class="tech-view doc-view" role="tabpanel" hidden></div>
              <div id="view-scenarios" class="tech-view" role="tabpanel" hidden></div>
            </div>
          </section>
          <section id="center-docs" class="center-host" role="tabpanel" hidden>
            <div id="docs-tabs" role="tablist"></div>
            <div id="docs-body">
              <div id="view-glossary" class="tech-view doc-view" role="tabpanel"></div>
              <div id="view-docs" class="tech-view doc-view" role="tabpanel" hidden></div>
              <div id="view-notes" class="tech-view doc-view" role="tabpanel" hidden></div>
            </div>
          </section>
          <section id="view-assistant" class="center-host" role="tabpanel" hidden></section>
        </div>
        <footer id="diagnostics">
          <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
          <div id="diag-header">
            <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true">collapse</button>
            <div class="diag-tabs" role="tablist"></div>
            <span id="diag-count" class="diag-count"></span>
          </div>
          <div id="diag-body" class="diag-panel" role="tabpanel"></div>
          <div id="panel-events" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-relationships" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-contextmap" class="diag-panel doc-view" role="tabpanel" hidden></div>
          <div id="panel-terminal" class="diag-panel diag-panel-terminal" role="tabpanel" hidden></div>
          <div id="panel-review" class="diag-panel" role="tabpanel" hidden></div>
        </footer>
      </section>
      <aside id="right" class="pane">
        <div id="right-tabs" role="tablist"></div>
        <div id="right-body">
          <div id="inspector-host" class="rview" role="tabpanel"></div>
          <div id="rview-rules" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-notes" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
        </div>
      </aside>
    </main>
    <footer id="statusbar"><span class="sb-item" id="sb-context">Context: —</span></footer>
    <div id="inspector-sheet-host"></div>
  </div>`;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function glossaryFixture(): GlossaryModel {
  const entries: GlossaryEntry[] = [
    {
      id: 'Billing',
      name: 'Billing',
      kind: 'context',
      context: 'Billing',
      qualifiedName: 'Billing',
      doc: null,
      nameRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 15 } },
    },
    {
      id: 'Billing.Money',
      name: 'Money',
      kind: 'value',
      context: 'Billing',
      qualifiedName: 'Billing.Money',
      doc: 'A monetary amount.',
      nameRange: { start: { line: 1, character: 8 }, end: { line: 1, character: 13 } },
    },
  ];
  return { entries };
}

function makeLsp() {
  return {
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => glossaryFixture()),
    livingDocs: vi.fn(async (): Promise<DocsResult> => ({ files: [] })),
    model: vi.fn(async () => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
    contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Billing'], relations: [] })),
    emitPreview: vi.fn(
      async (target: string): Promise<EmitPreviewResult> => ({ target, files: [], diagnostics: [], error: null }),
    ),
    check: vi.fn(async (): Promise<CheckResult> => ({ hasBreakingChanges: false, changes: [] })),
    setDoc: vi.fn(async (): Promise<SetDocResult> => ({ uri: null, edits: [] })),
    documentSymbols: vi.fn(async (): Promise<DocumentSymbol[]> => []),
  };
}
type Lsp = ReturnType<typeof makeLsp>;

function fakeEditor(): InspectorControllerDeps['editor'] {
  return {
    view: { requestMeasure: vi.fn() } as unknown as InspectorControllerDeps['editor']['view'],
    goto: vi.fn(),
    gotoRange: vi.fn(),
  };
}
function fakeOutput(): InspectorControllerDeps['output'] {
  return { setContent: vi.fn(), setLineWrap: vi.fn(), destroy: vi.fn() };
}
function fakePlatform(): InspectorControllerDeps['platform'] {
  return {
    kind: 'browser',
    canOpenFolders: true,
    pickFolder: vi.fn(async () => null),
    readFolderSources: vi.fn(async () => []),
    listKoiFiles: vi.fn(async () => []),
    listEntries: vi.fn(async () => []),
    readTextFile: vi.fn(async () => ''),
    gitLogForRange: vi.fn(async () => null),
  } as unknown as InspectorControllerDeps['platform'];
}
function makeAssistant(): InspectorAssistant {
  return { syncWorkspace: vi.fn<() => void>(), focusInput: vi.fn<() => void>() };
}

function makeDeps(lsp: Lsp): InspectorControllerDeps {
  return {
    lsp: lsp as unknown as InspectorControllerLsp,
    editor: fakeEditor(),
    output: fakeOutput(),
    platform: fakePlatform(),
    store: createAppStore(),
    activeUri: () => 'file:///work/model.koi',
    folderRootToken: () => '',
    initialTarget: 'csharp',
    saveWorkspaceCenter: vi.fn(),
    loadWorkspaceCenter: vi.fn(() => null),
    saveActiveContext: vi.fn(),
    loadActiveContext: vi.fn(() => null),
    setStatus: vi.fn(),
    onRenameElement: vi.fn(),
    onSaveElementDescription: vi.fn(),
    onSaveGlossaryDescription: vi.fn(),
    onApplyStructuredEdit: vi.fn(),
    onAddConstruct: vi.fn(),
    onAddAnnotation: vi.fn(),
    onAddAggregateMember: vi.fn(),
    onExportDiagram: vi.fn(),
    onCopyDiagramMermaid: vi.fn(),
    gotoSourceSpan: vi.fn(),
    revealInFiles: vi.fn(),
    ensureAssistant: vi.fn(() => makeAssistant()),
    initEdgeResizer: vi.fn(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('inspectorController — bottom sheet on a narrow viewport', () => {
  beforeEach(() => {
    document.body.innerHTML = APP_HTML;
    setViewport(500); // below $bp-narrow (640)
  });

  test('selecting an element raises the sheet to half and mounts Properties (matching data-qname) into its body', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    // Prime the model index so the inspector can resolve the selection.
    ctl.refreshActiveSurfaces();
    await flush();

    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });

    const sheet = el('inspector-sheet-host').querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.dataset.detent).toBe('half');
    expect(sheet.getAttribute('aria-modal')).toBe('true');

    const body = sheet.querySelector<HTMLElement>('.koi-sheet-body')!;
    expect(body.querySelector('[data-qname]')?.getAttribute('data-qname')).toBe('Billing.Money');
    // The desktop right-rail host is NOT used for the Properties panel on a narrow viewport.
    expect(el('inspector-host').querySelector('[data-qname]')).toBeNull();

    ctl.dispose();
  });

  test('crossing to desktop unmounts the sheet-body Properties panel — exactly one mount (#221)', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });

    const sheetBody = el('inspector-sheet-host').querySelector<HTMLElement>('.koi-sheet-body')!;
    expect(sheetBody.querySelector('[data-qname]')).not.toBeNull(); // mounted into the sheet on narrow

    // Widen past the breakpoint and fire a resize. The controller re-mounts Properties into the fixed
    // #inspector-host AND must UNMOUNT the prior sheet-body tree — Preact's render(vnode, newHost) leaves
    // the old container's tree live otherwise (a leaked, store-subscribed panel).
    setViewport(1024);
    window.dispatchEvent(new Event('resize'));
    await flush();

    expect(sheetBody.querySelector('[data-qname]')).toBeNull(); // sheet body emptied (panel unmounted)
    expect(el('inspector-host').querySelector('[data-qname]')).not.toBeNull(); // the single live mount

    ctl.dispose();
  });

  test('openInspectorSheet drives the controller-created sheet (Task 3 import seam)', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    await flush();

    openInspectorSheet('full');
    const sheet = el('inspector-sheet-host').querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.dataset.detent).toBe('full');

    ctl.dispose();
  });
});
