// The diagram-authoring + canvas write-path controller, extracted from ide.tsx's init() (#757). Owns the
// model→.koi round-trip the canvas drives (issue #91): node rename/delete, draw/remove relationship,
// add type / aggregate member, the empty-canvas concept seeder, canvas-only annotations, the in-editor
// review-comment composer, and the mobile-zone switcher. It binds the DIAGRAM_* gesture listeners on the
// #center-visual canvas and renders the mobile zone bar; everything reaches the editor / workspace / LSP /
// inspector controller / dialogs through the injected `deps`. Pure structural lift — every closure keeps
// its exact logic.
import { render } from 'preact';
import { appStore } from '@/store/index';
import { openInspectorSheet } from '@/shell/inspectorSheet';
import { isNarrowViewport } from '@/shared/breakpoint';
import { domById } from '@/shared/domById';
import { MobileZoneBar } from '@/shell/MobileZoneBar';
import { type MobileZone } from '@/store/slices/uiChrome';
import { createCommentComposer, type CommentComposer } from '@/review/CommentComposer';
import { isAllContexts } from '@/model/activeContext';
import { resolveInspectableQn } from '@/model/modelIndex';
import {
  DIAGRAM_ANNOTATION_CREATE_EVENT,
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_REFIT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  EMPTY_STATE_PICK_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  setDefaultCanvasZoom,
  setDiagramEditing,
  setDiagramTouchMode,
  type AddNodeKind,
  type AggregateMemberKind,
  type CanvasAnnotationKind,
  type DiagramAnnotationCreateDetail,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramNodeEditDetail,
  type DiagramNodeNavigateDetail,
  type EmptyConceptKind,
  type EmptyStatePickDetail,
} from '@/diagrams/diagramContract';
import type { SourceSpan, StructuredEdit } from '@/lsp/lsp';
import type { KoineLsp } from '@/lsp/lsp';
import type { WorkspaceController } from '@/shell/workspaceController';
import type { ConfirmDialog, PromptDialog } from '@/shared/overlay';

// Starter shapes the empty-canvas doorways seed (the EMPTY_STATE_PICK_EVENT contract). Each is a strict
// subset of a validated template (templates/starters/{ordering,contextmap}) so it always compiles green;
// seeding one into a fresh model lights up the canvas immediately.
const CONCEPT_STARTER: Record<EmptyConceptKind, string> = {
  aggregate: `context Ordering {

  aggregate Sales root Order {

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Decimal
      subtotal:  Decimal = unitPrice * quantity
    }

    entity Order identified by OrderId {
      lines: List<OrderLine>
      // Add the fields, invariants, and behaviours your Order needs.
    }
  }
}
`,
  stateMachine: `context Ordering {

  aggregate Sales root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    entity Order identified by OrderId {
      status: OrderStatus = Draft

      states status {
        Draft  -> Placed
        Placed -> Shipped
        Placed -> Cancelled
        // Add the transitions your lifecycle allows.
      }
    }
  }
}
`,
  contextMap: `context Catalog {
  entity Product identified by ProductId {
    sku:  String
    name: String
  }
}

context Sales {
  value OrderRef {
    value: String
  }
}

contextmap {
  Catalog -> Sales : conformist
  // Map each upstream context onto the downstream ones that depend on it.
}
`,
};

// Adding a node = inserting a new construct skeleton into the active context (addType). The kind comes
// from the palette button (defaulting to value) and the user names the type.
const ADD_DEFAULT_NAME: Record<AddNodeKind, string> = {
  value: 'NewValue',
  entity: 'NewEntity',
  aggregate: 'NewAggregate',
  event: 'NewEvent',
  enum: 'NewEnum',
  service: 'NewService',
};

export interface CanvasWriteDeps {
  editor: { getDoc(): string; setDoc(doc: string): void };
  workspace: Pick<WorkspaceController, 'activeUri' | 'applyWorkspaceEdit'>;
  lsp: Pick<KoineLsp, 'applyModelEdit' | 'rename'>;
  controller: {
    loadDiagrams(): Promise<unknown> | void;
    ensureModelIndex(): Promise<Parameters<typeof resolveInspectableQn>[0]>;
    selectBottomTab(tab: 'review'): void;
    selectCenter(view: 'visual' | 'technical'): void;
  };
  setStatus(text: string, kind: 'error'): void;
  prompt: Pick<PromptDialog, 'ask'>;
  confirm: Pick<ConfirmDialog, 'ask'>;
  reviewStore: { add(file: string, span: SourceSpan, text: string, author: string): void };
  /** Repaint the editors' review marks after a comment lands (editorSession.refreshReviewDecorations). */
  refreshReviewDecorations(): void;
  reviewAuthorName(): string;
  /** Jump the editor to a RAW 1-based source span (the shared gotoSourceSpan). Returns the underlying
   *  promise so navigateToDiagramNode's `await` waits on the buffer-open + caret-move, as it did inline. */
  gotoSourceSpan(span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>): Promise<void> | void;
  /** The #split grid host whose data-mobile-zone attribute mirrors the active mobile zone. */
  splitEl: HTMLElement;
  /** The default canvas zoom seeded from settings (#762). */
  defaultCanvasZoom: number;
  /** The empty BLANK model text — seedConcept treats an untouched BLANK as pristine. */
  blank: string;
}

export interface CanvasWrite {
  /** Open a review thread on the editor's current selection (#259). */
  addReviewComment(span: SourceSpan): void;
  /** Create a canvas-only annotation (note/group) — a VIEW concern, no .koi edit (#255). */
  createCanvasAnnotation(kind: CanvasAnnotationKind): void;
  /** Add a construct skeleton to the active context (the palette's add-type button). */
  applyDiagramAddType(detail?: { kind: AddNodeKind }): Promise<void>;
  /** Add a member inside the selected aggregate (#254). */
  applyDiagramAddAggregateMember(kind: AggregateMemberKind, aggregateQn: string): Promise<void>;
  /** The shared write path for a canvas authoring gesture — apply a StructuredEdit through #91. */
  applyStructuredEdit(edit: StructuredEdit): Promise<boolean>;
  dispose(): void;
}

export function createCanvasWrite(deps: CanvasWriteDeps): CanvasWrite {
  const { editor, workspace, lsp, controller, setStatus, splitEl } = deps;
  // The diagram canvas host — the controller renders into it, but ide.ts owns the authoring gesture
  // listeners (the diagram write-path), which are bound to this node below.
  const diagramsView = domById('center-visual');

  // The currently-open comment composer (#479), if any — only one at a time. Dismissing it (Add, Cancel,
  // Escape, or opening another) tears down its host element via the closure captured at mount.
  let commentComposerClose: (() => void) | null = null;

  // Anchor the composer's host near the editor's live text selection (CodeMirror keeps a real DOM
  // selection), clamped on-screen; fall back to a fixed spot near the top when there is no usable rect
  // (e.g. opened from the command palette). Mirrors the editor action-widget placement (actions.ts).
  function placeComposerNearSelection(host: HTMLElement): void {
    const WIDTH = 320;
    let left = window.innerWidth / 2 - WIDTH / 2;
    let top = 120;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height || rect.top || rect.left)) {
        left = rect.left;
        top = rect.bottom + 6;
      }
    }
    host.style.position = 'fixed';
    host.style.left = Math.max(8, Math.min(left, window.innerWidth - WIDTH - 8)) + 'px';
    host.style.top = Math.min(top, window.innerHeight - 180) + 'px';
  }

  // Open a review thread on the editor's current selection (#259). editorSession already pinned `span.file`
  // to the INVOKING group's uri. Mount a compact, non-blocking inline composer (#479) near the selection;
  // submitting empty/whitespace or cancelling adds no thread; on submit we add the thread, reveal the
  // Review tab, and repaint the editor marks.
  function addReviewComment(span: SourceSpan): void {
    const file = span.file ?? workspace.activeUri();
    if (!file) return;
    commentComposerClose?.(); // only one composer open at a time

    const host = document.createElement('div');
    host.className = 'koi-comment-composer-host';
    document.body.appendChild(host);
    placeComposerNearSelection(host);

    let composer: CommentComposer | null = null;
    // Attached on the next frame so the click/keystroke that opened the composer doesn't dismiss it.
    let onDocMouseDown: ((e: MouseEvent) => void) | null = null;
    const armId = window.setTimeout(() => {
      onDocMouseDown = (e: MouseEvent): void => {
        if (!host.contains(e.target as Node)) close();
      };
      document.addEventListener('mousedown', onDocMouseDown, true);
    }, 0);

    const close = (): void => {
      window.clearTimeout(armId);
      if (onDocMouseDown) document.removeEventListener('mousedown', onDocMouseDown, true);
      composer?.dispose();
      composer = null;
      host.remove();
      if (commentComposerClose === close) commentComposerClose = null;
    };
    commentComposerClose = close;

    composer = createCommentComposer({
      parent: host,
      onSubmit: (text) => {
        close();
        deps.reviewStore.add(file, { ...span, file }, text, deps.reviewAuthorName());
        controller.selectBottomTab('review');
        deps.refreshReviewDecorations();
      },
      onCancel: close,
    });
  }

  // Jump-to-source from a diagram node: the SVG renderer dispatches a bubbling NODE_NAVIGATE_EVENT
  // carrying its RAW 1-based source span; the delegated listener routes it here.
  async function navigateToDiagramNode(detail: DiagramNodeNavigateDetail): Promise<void> {
    await deps.gotoSourceSpan(detail);
  }

  // Map a node gesture to a StructuredEdit, apply it through #91's round-trip, and patch the buffer.
  async function applyDiagramEdit(detail: DiagramNodeEditDetail): Promise<void> {
    if (detail.action === 'delete') {
      // Deleting a node removes the whole type declaration (round-trips through removeType).
      await applyStructuredEdit({ kind: 'removeType', target: detail.qualifiedName });
      return;
    }
    // Renaming a TYPE is a workspace-wide rename (every reference moves), so it uses the editor's
    // cross-file rename at the declaration's name position rather than a span-local member edit.
    if (detail.newName && detail.line != null && detail.column != null) {
      await renameTypeAt(detail.line - 1, detail.column - 1, detail.newName);
    }
  }

  // Cross-file rename of the symbol at a 0-based position (the diagram-node rename gesture).
  async function renameTypeAt(line: number, character: number, newName: string): Promise<void> {
    let edit;
    try {
      edit = await lsp.rename(line, character, newName);
    } catch {
      setStatus('Rename failed', 'error');
      return;
    }
    if (!edit?.changes || Object.keys(edit.changes).length === 0) {
      setStatus('Rename rejected', 'error');
      return;
    }
    workspace.applyWorkspaceEdit(edit);
  }

  // The shared write path for every canvas authoring gesture: apply a StructuredEdit through #91's
  // round-trip, patch the buffer on success (which fires onDocEdited → the diagram AND the inspector
  // re-render in step), or surface the rejecting KOIxxxx and roll back. Returns whether it applied.
  async function applyStructuredEdit(edit: StructuredEdit): Promise<boolean> {
    let result;
    try {
      result = await lsp.applyModelEdit(edit);
    } catch {
      setStatus('Diagram edit failed', 'error');
      return false;
    }
    if (result.diagnostics.length > 0 || result.uri == null || result.edits.length === 0) {
      const reason = result.diagnostics[0];
      setStatus(reason ? `${reason.code}: ${reason.message}` : 'Edit rejected', 'error');
      return false; // rolled back — nothing is patched
    }
    workspace.applyWorkspaceEdit({ changes: { [result.uri]: result.edits } });
    return true;
  }

  // Drawing a relationship on the canvas = adding a field on the source typed as the target. The default
  // field name is the target's lower-cased simple name; the user can refine it (or cancel).
  async function applyDiagramConnect(detail: DiagramConnectDetail): Promise<void> {
    const targetSimple = detail.targetQualifiedName.slice(detail.targetQualifiedName.lastIndexOf('.') + 1);
    const suggested = targetSimple.charAt(0).toLowerCase() + targetSimple.slice(1);
    const fieldName = await deps.prompt.ask({
      title: 'Add field',
      message: `On ${detail.sourceLabel}, referencing ${detail.targetLabel}.`,
      label: 'Field name',
      initialValue: suggested,
      mono: true,
      confirmLabel: 'Add field',
    });
    if (!fieldName) return;
    await applyStructuredEdit({ kind: 'addField', target: detail.sourceQualifiedName, name: fieldName, type: targetSimple });
  }

  // Removing a relationship = removing the field that backs it.
  async function applyDiagramDisconnect(detail: DiagramDisconnectDetail): Promise<void> {
    const ok = await deps.confirm.ask({
      title: `Remove ${detail.label}?`,
      message: 'This rewrites the .koi source.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await applyStructuredEdit({ kind: 'removeMember', target: detail.backingMember });
  }

  // Canvas-only annotations (#255): a note/group is a VIEW concern (persisted in koine.layout.json, never
  // `.koi`), so creation is delegated to the renderer via a document event. No model edit / LSP round-trip.
  function createCanvasAnnotation(kind: CanvasAnnotationKind): void {
    document.dispatchEvent(
      new CustomEvent<DiagramAnnotationCreateDetail>(DIAGRAM_ANNOTATION_CREATE_EVENT, { detail: { kind } }),
    );
  }

  async function applyDiagramAddType(detail?: { kind: AddNodeKind }): Promise<void> {
    let scope = appStore.getState().activeContext;
    if (isAllContexts(scope)) {
      // "All contexts" has no unambiguous home — except when the model has exactly one context, which is
      // then the only possible target (the palette enables its buttons to match). 2+ contexts still need
      // a deliberate pick.
      const all = appStore.getState().contexts;
      if (all.length !== 1) {
        setStatus('Pick a bounded context (top-left) before adding a type', 'error');
        return;
      }
      scope = all[0];
    }
    const kind = detail?.kind ?? 'value';
    const name = await deps.prompt.ask({
      title: `New ${kind}`,
      message: `In ${scope}.`,
      label: 'Name',
      initialValue: ADD_DEFAULT_NAME[kind],
      mono: true,
      confirmLabel: 'Create',
    });
    if (!name) return;
    // The AddNodeKind string IS the construct keyword the server's TryAddType switches on (StructuredEdit.Type).
    await applyStructuredEdit({ kind: 'addType', target: scope, name, type: kind });
  }

  // Insert a construct that lives INSIDE an aggregate (#254). The target is the SELECTED aggregate's
  // qualified name. A rule (an aggregate-scoped `spec`) is named; a repository is anonymous.
  async function applyDiagramAddAggregateMember(kind: AggregateMemberKind, aggregateQn: string): Promise<void> {
    const aggregateName = aggregateQn.split('.').pop() ?? aggregateQn;
    if (kind === 'rule') {
      const name = await deps.prompt.ask({
        title: 'New rule',
        message: `An aggregate-scoped specification over ${aggregateName}.`,
        label: 'Name',
        initialValue: 'NewRule',
        mono: true,
        confirmLabel: 'Create',
      });
      if (!name) return;
      await applyStructuredEdit({ kind: 'addAggregateMember', target: aggregateQn, name, type: 'rule' });
      return;
    }
    await applyStructuredEdit({ kind: 'addAggregateMember', target: aggregateQn, type: 'repository' });
  }

  // Clicking a diagram node both jumps to its declaration AND selects it, so the element inspector (#142)
  // populates from the same gesture. Map `context.simpleName` back to the canonical qualified name.
  async function selectFromDiagram(detail: DiagramNodeNavigateDetail): Promise<void> {
    const index = await controller.ensureModelIndex().catch(() => null);
    const qualifiedName = index ? resolveInspectableQn(index, detail.qualifiedName) : detail.qualifiedName;
    if (qualifiedName) appStore.getState().setSelection({ qualifiedName, context: qualifiedName.split('.')[0] });
    await navigateToDiagramNode(detail);
  }

  // The empty-canvas doorway: seed a validated starter for the picked concept. Non-destructive — an
  // untouched BLANK seed is replaced outright, otherwise the starter is appended so no work is lost.
  function seedConcept(kind: EmptyConceptKind): void {
    const starter = CONCEPT_STARTER[kind];
    const current = editor.getDoc();
    const pristine = current.trim() === '' || current.trim() === deps.blank.trim();
    editor.setDoc(pristine ? starter : `${current.replace(/\s+$/, '')}\n\n${starter}`);
  }

  // --- bind the canvas gesture listeners -----------------------------------
  diagramsView.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramNodeNavigateDetail>).detail;
    if (!detail) return;
    void selectFromDiagram(detail);
    // On a phone the Properties rail is a bottom sheet (#221, Task 2): a node TAP raises it to half.
    if (isNarrowViewport()) openInspectorSheet('half');
  });

  // Drag-to-edit (issue #93): a diagram node gesture round-trips through the model→.koi seam (#91).
  setDiagramEditing(true);
  // Touch (tap-to-edit) presentation for the canvas (#221, Task 3): below $bp-narrow, freehand gestures are
  // swapped for tap-to-navigate + drag-to-pan. Set from the initial viewport, then re-evaluated only when
  // the breakpoint is actually crossed.
  setDiagramTouchMode(isNarrowViewport());
  // The default zoom a freshly-opened domain canvas uses when nothing per-diagram is saved (#762).
  setDefaultCanvasZoom(deps.defaultCanvasZoom);
  let diagramWasNarrow = isNarrowViewport();
  // Named so dispose() can removeEventListener it — otherwise this listener (and its closed-over
  // controller) outlives the IDE and a breakpoint cross would call loadDiagrams() on a torn-down controller.
  const onDiagramViewportResize = (): void => {
    const narrow = isNarrowViewport();
    if (narrow === diagramWasNarrow) return; // act on a CROSS only — not on every resize tick
    diagramWasNarrow = narrow;
    setDiagramTouchMode(narrow);
    void controller.loadDiagrams(); // rebuild the canvas with the now-correct gesture wiring
  };
  window.addEventListener('resize', onDiagramViewportResize);
  diagramsView.addEventListener(NODE_EDIT_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramNodeEditDetail>).detail;
    if (detail) void applyDiagramEdit(detail);
  });

  // Auto-arrange (authoring): the canvas cleared its saved positions; re-render so ELK lays it out fresh.
  diagramsView.addEventListener(DIAGRAM_RELAYOUT_EVENT, () => {
    void controller.loadDiagrams();
  });

  // Connect / disconnect (authoring): drawing or removing a relationship round-trips into `.koi`.
  diagramsView.addEventListener(DIAGRAM_CONNECT_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramConnectDetail>).detail;
    if (detail) void applyDiagramConnect(detail);
  });
  diagramsView.addEventListener(DIAGRAM_DISCONNECT_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramDisconnectDetail>).detail;
    if (detail) void applyDiagramDisconnect(detail);
  });
  // Empty-canvas doorway: seed a validated starter for the picked concept.
  diagramsView.addEventListener(EMPTY_STATE_PICK_EVENT, (e) => {
    const detail = (e as CustomEvent<EmptyStatePickDetail>).detail;
    if (detail) seedConcept(detail.kind);
  });

  // --- mobile zone switcher (#220) -----------------------------------------
  // The bottom mobile zone switcher: a tablist (below $bp-narrow) that picks which of the four zones
  // (Files / Code / Diagram / Props) fills the single-column phone shell. Selecting a zone writes the
  // store; Code/Diagram additionally flip the center tab. The active zone is mirrored onto
  // #split[data-mobile-zone] so the @media rules can show/hide zones without remounting any DOM.
  function selectMobileZone(zone: MobileZone): void {
    // Props is a single inspector surface: the bottom SHEET (#221), an overlay. Write the slice for EVERY
    // zone (including 'props') so the tablist's aria-selected + roving tabIndex reflect the active tab. For
    // 'props' we additionally raise the sheet OVER the current zone; the data-mobile-zone MIRROR keeps the
    // underlying real zone visible for 'props'.
    appStore.getState().setMobileZone(zone);
    if (zone === 'props') openInspectorSheet('half');
    else if (zone === 'diagram') {
      controller.selectCenter('visual');
      // The Diagram zone was hidden (display:none) until this reveal, so the canvas mounted at zero size.
      // Ask the live canvas to re-fit + rebuild its minimap on the NEXT frame, once the CSS reveal applied.
      requestAnimationFrame(() => document.dispatchEvent(new Event(DIAGRAM_REFIT_EVENT)));
    } else if (zone === 'code') controller.selectCenter('technical');
  }
  render(<MobileZoneBar store={appStore} onSelect={selectMobileZone} />, domById('mobile-zone-bar-host'));
  // Mirror the active zone onto #split[data-mobile-zone]. 'props' is the exception: the inspector is a
  // bottom-sheet OVERLAY, so selecting it must KEEP the underlying real zone visible — we only mirror REAL
  // zones, leaving the attribute on the last real zone beneath the sheet.
  function mirrorMobileZone(zone: MobileZone): void {
    if (zone !== 'props') splitEl.dataset.mobileZone = zone;
  }
  mirrorMobileZone(appStore.getState().mobileZone);
  // Mirror only when mobileZone actually changes — the listener fires on every store write, so guard on
  // prevState to avoid rewriting the attribute on unrelated updates.
  const unsubMobileZone = appStore.subscribe((s, prev) => {
    if (s.mobileZone !== prev.mobileZone) mirrorMobileZone(s.mobileZone);
  });
  // On a narrow (phone) first paint, land on the default mobile zone's surface so the bottom bar's active
  // tab and the visible #center surface agree from the start.
  if (isNarrowViewport()) selectMobileZone(appStore.getState().mobileZone);

  return {
    addReviewComment,
    createCanvasAnnotation,
    applyDiagramAddType,
    applyDiagramAddAggregateMember,
    applyStructuredEdit,
    dispose() {
      window.removeEventListener('resize', onDiagramViewportResize);
      unsubMobileZone();
      commentComposerClose?.();
    },
  };
}
