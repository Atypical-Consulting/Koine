// CodeMirror 6 setup for Koine Studio: an editable .koi editor (token highlighting,
// keyword autocomplete, bracket closing, search) plus a read-only, syntax-highlighted
// viewer for the generated C#/TypeScript output. Adapted from the website playground;
// the key difference is that diagnostics are PUSH-based (publishDiagnostics → setDiagnostics)
// rather than pull-based (linter()).
import { EditorState, Compartment, Annotation, type ChangeSet, type Extension, type Text } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage,
  syntaxHighlighting,
  indentOnInput,
  indentUnit,
  bracketMatching,
} from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
  completionKeymap,
  completionStatus,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { showMinimap } from '@replit/codemirror-minimap';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  DocumentSymbol,
  Location,
  LspDiagnostic,
  PrepareRenameResult,
  Range as LspRange,
  SourceSpan,
  TextEdit,
  WorkspaceEdit,
} from '@/lsp/lsp';
// The shared CodeMirror highlight style + base theme live in ./cmTheme (#986) — every factory in this
// file (and the sibling outputView.ts / settingsJsonEditor.ts modules) paints with these.
import { koineHighlight, sharedTheme } from '@/editor/cmTheme';
// The LSP-backed CodeMirror extensions (hover, LSP completion source, inlay hints, semantic tokens) and
// their provider function types live in ./lspExtensions (#986); createKoineEditor wires the values
// directly and references the types below. Re-exported (below) so `@/editor/editor` consumers keep
// resolving the whole facade surface unchanged.
import {
  koineHoverTooltip,
  lspCompletionSource,
  inlayHintsExtension,
  semanticTokensExtension,
  type HoverFn,
  type CompletionFn,
  type InlayHintsFn,
  type SemanticTokensFn,
  type DefinitionFn,
  type NavigateFn,
  type FormatFn,
  type PrepareRenameFn,
  type RenameFn,
  type ReferencesFn,
  type CodeActionsFn,
  type PrepareCallHierarchyFn,
  type IncomingCallsFn,
  type OutgoingCallsFn,
  type ApplyWorkspaceEditFn,
  type NavigateLocationFn,
  type UriLabelFn,
} from '@/editor/lspExtensions';
import { dismissFloating, showActionMenu, showRenameInput } from '@/editor/actions';
import { createInlineState } from '@/editor/inlineCompletionState';
import { inlineCompletionExtension, type EditorInlineContext } from '@/editor/inlineCompletion';
import { requestInline } from '@/ai/inlineCompletionClient';
import { loadSettings, resolveKeybindings } from '@/settings/persistence';
import { buildExtraKeys, type BindingId } from '@/editor/keybindings';
// Review-comment rendering (#259): the StateField+gutter that paint review threads over the buffer, plus
// the helper that repaints them after a store change. A Studio-only view concern — never touches the model.
import { reviewDecorationsExtension, dispatchReviewRefresh } from '@/review/reviewDecorations';
import type { ReviewThread } from '@/review/reviewStore';
// The markdown renderer lives in ./markdown (extracted so it can be unit-tested without a CodeMirror
// view). Re-exported below so existing importers keep resolving it from `@/editor/editor`.
import { renderMarkdown } from '@/editor/markdown';
// LSP↔offset converters live in ./positions (pure, tested over a CodeMirror `Text`); call them with
// `view.state.doc`.
import { editsToChanges, lspPosToOffset, lspToCm } from '@/editor/positions';
// The single source of truth for the narrow (phone) breakpoint — the JS mirror of $bp-narrow. Reused
// here for the touch theme's media query and the keyboard-occlusion gate so the editor agrees with the
// shell about what "narrow" means (do NOT re-derive 640 anywhere).
import { BP_NARROW } from '@/shared/breakpoint';
import { basename } from '@/shared/path';

// --- .koi token highlighter -------------------------------------------------

const KEYWORDS = [
  'context', 'module', 'import', 'version', 'value', 'quantity', 'entity', 'aggregate',
  'enum', 'identified', 'by', 'root', 'as', 'natural', 'sequence', 'guid', 'versioned',
  'invariant', 'matches', 'when', 'if', 'then', 'else', 'command', 'create', 'requires',
  'emit', 'states', 'event', 'integration', 'publishes', 'subscribes', 'spec', 'on',
  'service', 'operation', 'usecase', 'policy', 'repository', 'operations', 'find',
  'readmodel', 'from', 'query', 'now',
];
const KEYWORD_SET = new Set(KEYWORDS);

const TYPES = ['String', 'Int', 'Decimal', 'Bool', 'Instant', 'List', 'Set', 'Map', 'Range'];
const TYPE_SET = new Set(TYPES);

const koineLanguage = StreamLanguage.define<{ afterMatches: boolean }>({
  name: 'koine',
  startState: () => ({ afterMatches: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (state.afterMatches && stream.peek() === '/') {
      stream.next();
      let escaped = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (ch === '/' && !escaped) break;
        escaped = ch === '\\' && !escaped;
      }
      state.afterMatches = false;
      return 'regexp';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.afterMatches = false;
      return 'string';
    }
    if (stream.match(/^\d+(\.\d+)?/)) {
      state.afterMatches = false;
      return 'number';
    }
    if (stream.match(/^@[A-Za-z]+/)) {
      state.afterMatches = false;
      return 'meta';
    }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      state.afterMatches = word === 'matches';
      if (KEYWORD_SET.has(word)) return 'keyword';
      if (TYPE_SET.has(word)) return 'typeName';
      if (/^[A-Z]/.test(word)) return 'className';
      return 'variableName';
    }
    if (stream.match(/^(->|<-|=>|==|!=|<=|>=|&&|\|\||[-+*/%<>=!.,:;(){}[\]?])/)) {
      state.afterMatches = false;
      return 'operator';
    }
    stream.next();
    return null;
  },
});

// Keyword/type autocomplete for the editor — the offline fallback used when no LSP
// completion provider is wired.
function koineCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return completeFromList([
    ...KEYWORDS.map((k) => ({ label: k, type: 'keyword' })),
    ...TYPES.map((k) => ({ label: k, type: 'type' })),
  ])(ctx);
}

// Touch tuning for the .koi editor on a phone (#221). Scoped to the narrow breakpoint via a CSS media
// query (interpolated from BP_NARROW so it tracks $bp-narrow), so DESKTOP IS UNTOUCHED — above the
// breakpoint none of these rules match and the editor renders exactly as before. It is appended AFTER
// sharedTheme in the extensions list, so on a narrow viewport these equal-specificity rules win the
// cascade by source order. The font bump to 16px also stops iOS Safari from auto-zooming the page when
// the field gains focus; the fatter caret and roomier line padding make the caret visible and the lines
// comfortable tap targets under a fingertip.
const narrowTouchTheme = EditorView.theme({
  [`@media (max-width: ${BP_NARROW}px)`]: {
    '&': { fontSize: '16px' },
    '.cm-content': { lineHeight: 'var(--koi-editor-line-height, 1.8)' },
    // Roomier rows: a few px of vertical padding so each line is a finger-friendly tap target.
    '.cm-line': { paddingTop: '2px', paddingBottom: '2px' },
    // A fatter caret reads on a high-DPI phone screen where the default 1.2px hairline disappears.
    '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '2px' },
  },
});

// renderMarkdown was extracted to ./markdown (imported at the top of this file) so it can be unit-tested
// without a CodeMirror view; re-export it so `@/editor/editor` consumers keep resolving it here.
export { renderMarkdown };

// The LSP-backed CodeMirror extensions (hover, LSP completion source, inlay hints, semantic tokens) and
// the provider function types live in ./lspExtensions (#986); re-exported so `@/editor/editor` consumers
// keep resolving them here. `koineHoverTooltip` / `lspCompletionSource` are imported below for
// createKoineEditor's own wiring but are NOT part of this facade surface (they were never public).
export { inlayHintsExtension, semanticTokensExtension, decodeSemanticTokens, SEMANTIC_TOKEN_TYPES } from '@/editor/lspExtensions';
export type {
  HoverFn,
  CompletionFn,
  InlayHintsFn,
  SemanticTokensFn,
  DecodedSemanticToken,
  DefinitionFn,
  NavigateFn,
  FormatFn,
  PrepareRenameFn,
  RenameFn,
  ReferencesFn,
  CodeActionsFn,
  PrepareCallHierarchyFn,
  IncomingCallsFn,
  OutgoingCallsFn,
  ApplyWorkspaceEditFn,
  NavigateLocationFn,
  UriLabelFn,
} from '@/editor/lspExtensions';

// --- review-comment decorations ---------------------------------------------

// Theme for the review-thread marks painted by reviewDecorationsExtension (#259): an OPEN thread gets a
// wavy accent underline, a RESOLVED one is dimmed with a faint dotted underline, and the line gutter
// shows a small speech-bubble glyph. Colours reuse the existing `--koi-*` palette so the marks read in
// both themes; this lives with the editor's other `.cm-*` decoration themes (the review PANEL is styled
// separately). The decorations are unit-tested without a view; only these cosmetics live here.
const reviewTheme = EditorView.baseTheme({
  '.cm-review-underline': {
    textDecoration: 'underline wavy color-mix(in srgb, var(--koi-accent) 70%, transparent)',
    textUnderlineOffset: '3px',
  },
  '.cm-review-resolved': {
    opacity: '0.55',
    textDecoration: 'underline dotted var(--koi-muted)',
    textUnderlineOffset: '3px',
  },
  '.cm-review-gutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  '.cm-review-gutter-marker': { cursor: 'default', fontSize: '0.85em', lineHeight: '1' },
});

// --- editable editor --------------------------------------------------------

// Marks a transaction as a PROGRAMMATIC whole-document swap (setDoc — e.g. switching the open file or
// applying a generated model), as opposed to an incremental user edit. `onDocChange` (review-span
// remapping) skips these: a full-buffer replace maps every pinned offset to "deleted", which would
// orphan and persist away every review thread on a mere file switch. `onChange` still fires (the LSP
// re-syncs the new buffer). Incremental edits (typing, paste, LSP format/rename) carry no annotation.
const programmaticDocSwap = Annotation.define<boolean>();

// The @replit/codemirror-minimap extension, driven by its `showMinimap` facet. `create` hands the
// plugin the container element it mounts the overview rail into; `displayText: 'blocks'` keeps the
// thumbnail cheap (coloured blocks rather than rendered glyphs). Built fresh each time the compartment
// is (re)configured so toggling the minimap on installs a live extension and off installs `[]`.
function minimapExtension(): Extension {
  return showMinimap.of({
    create: () => ({ dom: document.createElement('div') }),
    displayText: 'blocks',
    showOverlay: 'always',
  });
}

export interface KoineEditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange?: (doc: string) => void;
  /** Fires with the 1-based caret line/column on every edit or selection move — feeds the status-bar
   *  cursor segment (#923). Not debounced; a plain textContent write per move is cheap. */
  onCursor?: (line: number, col: number) => void;
  /** Soft-wrap long lines on first paint (later toggled via KoineEditor.setLineWrap). */
  lineWrap?: boolean;
  /** Show the document-overview minimap on first paint (later toggled via KoineEditor.setMinimap). */
  minimap?: boolean;
  /** Optional LSP hover provider; when given, hover tooltips are enabled. */
  onHover?: HoverFn;
  /** Optional LSP completion provider; when given, Ctrl-Space / typing yields context-aware completions. */
  onCompletion?: CompletionFn;
  /** Optional go-to-definition provider; when given, Cmd/Ctrl-click and F12 resolve. */
  onDefinition?: DefinitionFn;
  /** Where a resolved definition Location is sent; ide.ts performs the navigation. */
  onNavigate?: NavigateFn;
  /** Optional format provider; when given, Cmd/Ctrl-S formats the document. */
  onFormat?: FormatFn;
  /** Optional prepareRename provider; with onRename, enables F2 rename-symbol. */
  onPrepareRename?: PrepareRenameFn;
  /** Optional rename provider; resolves the workspace edit applied via onApplyWorkspaceEdit. */
  onRename?: RenameFn;
  /** Optional find-references provider; with onNavigateLocation, enables Shift-F12. */
  onReferences?: ReferencesFn;
  /** Navigates to a reference the user picks from the references menu. */
  onNavigateLocation?: NavigateLocationFn;
  /** Maps a reference's uri to a short label (relPath) for the references menu. */
  uriLabel?: UriLabelFn;
  /** Optional code-action provider; when given, Mod-. opens the quickfix/refactor menu. */
  onCodeActions?: CodeActionsFn;
  /** Applies a WorkspaceEdit from a rename/code-action (ide.ts spreads it across buffers). */
  onApplyWorkspaceEdit?: ApplyWorkspaceEditFn;
  /** Optional inlay-hint provider; when given, type/parameter hints render inline. */
  onInlayHints?: InlayHintsFn;
  /** Optional semantic-tokens provider; when given, LSP-driven highlighting paints over the grammar. */
  onSemanticTokens?: SemanticTokensFn;
  /** Optional prepareCallHierarchy provider; with onIncomingCalls/onOutgoingCalls, enables Mod-Alt-h. */
  onPrepareCallHierarchy?: PrepareCallHierarchyFn;
  /** Optional incoming-calls provider (callers of the item under the cursor). */
  onIncomingCalls?: IncomingCallsFn;
  /** Optional outgoing-calls provider (callees of the item under the cursor). */
  onOutgoingCalls?: OutgoingCallsFn;
  /** Optional review-thread provider (the store's `list()`); when given, review marks + a gutter render. */
  getReviewThreads?: () => ReviewThread[];
  /**
   * Invoked by {@link KoineEditor.addCommentAtSelection} (and the Mod-Alt-m chord) with a SourceSpan built
   * from the current selection — `file` is `null`; ide.ts's handler fills in the active uri.
   */
  onAddComment?: (span: SourceSpan) => void;
  /**
   * Fired on every document edit with the CodeMirror {@link ChangeSet} and the new {@link Text} (alongside
   * the string `onChange`), so a review store can re-anchor its pinned spans through the change. Distinct
   * from `onChange`, which only hands back the new full text — span remapping needs the structured change.
   */
  onDocChange?: (change: ChangeSet, doc: Text) => void;
}

export interface KoineEditor {
  view: EditorView;
  getDoc(): string;
  setDoc(doc: string): void;
  goto(line: number, col: number): void;
  /** Jump to (and select through) a 0-based LSP range in the current document. */
  gotoRange(start: { line: number; character: number }, end: { line: number; character: number }): void;
  /** Resolve the definition for the symbol at a CodeMirror offset (delegates navigation to onNavigate). */
  gotoDefinition(pos: number): Promise<void>;
  /** Move the cursor to a 0-based LSP position and open the references picker there — the same Shift-F12
   * surface, driven from outside the editor (the launcher's find-usages action, issue #1165). */
  showReferences(line: number, character: number): void;
  /** Move the cursor to a 0-based LSP position and open the inline rename field there — the same F2
   * surface, driven from outside the editor (the launcher's rename action, issue #1165). */
  showRename(line: number, character: number): void;
  /** Apply LSP TextEdits to the document in one transaction (edits sorted internally). */
  applyEdits(edits: TextEdit[]): void;
  /** Turn editor soft-wrap on/off (reconfigures a compartment; no state loss). */
  setLineWrap(on: boolean): void;
  /** Show/hide the document-overview minimap (reconfigures a compartment; no state loss). */
  setMinimap(on: boolean): void;
  /** Set the editor indent width / tab size in spaces (reconfigures a compartment; no state loss). */
  setTabSize(spaces: number): void;
  /** Rebuild the editor keymap from the persisted keybinding overrides (reconfigures a compartment; no state loss). */
  reconfigureKeybindings(): void;
  /**
   * Open a review comment on the current selection: builds a SourceSpan from the main selection
   * (`file: null` — ide.ts fills the uri) and hands it to `onAddComment`. No-op on an empty selection or
   * when no `onAddComment` is wired.
   */
  addCommentAtSelection(): void;
  /** Repaint the review-thread decorations after the store changed (dispatches the refresh effect). */
  refreshReviewDecorations(): void;
  destroy(): void;
}

/** Apply PUSH-based diagnostics from a publishDiagnostics notification. */
export function setEditorDiagnostics(view: EditorView, diags: LspDiagnostic[]): void {
  view.dispatch(setDiagnostics(view.state, diags.map((d) => lspToCm(view.state.doc, d))));
}

/** Jump the editor to a 0-based {line,character}, selecting through to an end position. */
function jumpToRange(view: EditorView, start: { line: number; character: number }, end: { line: number; character: number }): void {
  const anchor = lspPosToOffset(view.state.doc, start.line, start.character);
  const head = lspPosToOffset(view.state.doc, end.line, end.character);
  view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  view.focus();
}

export function createKoineEditor(opts: KoineEditorOptions): KoineEditor {
  // Resolve the definition for the symbol at a CM offset and hand the Location to ide.ts
  // (onNavigate), which decides whether to switch files before jumping. Degrades silently
  // (no-op) when there is no provider, no result, or the request fails.
  async function gotoDefinition(pos: number): Promise<void> {
    if (!opts.onDefinition) return;
    const lineInfo = view.state.doc.lineAt(pos);
    const lspLine = lineInfo.number - 1; // CM line is 1-based, LSP 0-based
    const character = pos - lineInfo.from;
    let res: Location | Location[] | null;
    try {
      res = await opts.onDefinition(lspLine, character);
    } catch {
      return;
    }
    const loc = Array.isArray(res) ? res[0] : res;
    if (!loc) return;
    if (opts.onNavigate) opts.onNavigate(loc);
    else jumpToRange(view, loc.range.start, loc.range.end); // fallback: same-doc jump
  }

  // Convert a CodeMirror document offset to a 0-based LSP {line, character}.
  function posToLsp(pos: number): { line: number; character: number } {
    const lineInfo = view.state.doc.lineAt(pos);
    return { line: lineInfo.number - 1, character: pos - lineInfo.from };
  }

  // Mod-Alt-m / "Add review comment": open a thread on the current selection (#259). Builds a raw,
  // 1-based SourceSpan (end-exclusive endLine/endColumn — the same convention as remapSpans) with
  // `file: null`; ide.ts's onAddComment handler fills in the active uri. No-op on an empty selection or
  // when no handler is wired.
  function addCommentAtSelection(): void {
    const sel = view.state.selection.main;
    if (sel.empty || !opts.onAddComment) return;
    const startLine = view.state.doc.lineAt(sel.from);
    const endLine = view.state.doc.lineAt(sel.to);
    const span: SourceSpan = {
      file: null,
      line: startLine.number,
      column: sel.from - startLine.from + 1,
      endLine: endLine.number,
      endColumn: sel.to - endLine.from + 1,
      offset: sel.from,
      length: sel.to - sel.from,
    };
    opts.onAddComment(span);
  }

  // F2 rename: prepareRename to find the editable identifier range, show the inline field
  // pre-filled with the current name, then resolve + apply the workspace edit on submit.
  async function startRename(pos: number): Promise<void> {
    if (!opts.onPrepareRename || !opts.onRename) return;
    const at = posToLsp(pos);
    let prep: PrepareRenameResult | null;
    try {
      prep = await opts.onPrepareRename(at.line, at.character);
    } catch {
      return;
    }
    if (!prep) return;
    const anchor = lspPosToOffset(view.state.doc, prep.range.start.line, prep.range.start.character);
    const end = lspPosToOffset(view.state.doc, prep.range.end.line, prep.range.end.character);
    const placeholder = prep.placeholder ?? view.state.sliceDoc(anchor, end);
    const renameAt = prep.range.start;
    showRenameInput(view, anchor, placeholder, (newName) => {
      void (async () => {
        let edit: WorkspaceEdit | null;
        try {
          edit = await opts.onRename!(renameAt.line, renameAt.character, newName);
        } catch {
          return;
        }
        if (edit && opts.onApplyWorkspaceEdit) opts.onApplyWorkspaceEdit(edit);
      })();
    });
  }

  // Shift-F12 find-references: resolve every reference and show a picker at the cursor; picking
  // one navigates via onNavigateLocation (ide.ts switches files when needed).
  async function findReferences(pos: number): Promise<void> {
    if (!opts.onReferences || !opts.onNavigateLocation) return;
    const at = posToLsp(pos);
    let locs: Location[];
    try {
      locs = await opts.onReferences(at.line, at.character);
    } catch {
      return;
    }
    const label = opts.uriLabel ?? basename;
    showActionMenu(
      view,
      pos,
      locs.map((loc) => ({
        label: label(loc.uri),
        detail: `${loc.range.start.line + 1}:${loc.range.start.character + 1}`,
        run: () => opts.onNavigateLocation!(loc),
      })),
      { emptyText: 'No references found.' },
    );
  }

  // Mod-. code actions: resolve quickfixes + refactors for the selection and open the menu.
  async function showCodeActions(): Promise<void> {
    if (!opts.onCodeActions) return;
    const sel = view.state.selection.main;
    const range: LspRange = { start: posToLsp(sel.from), end: posToLsp(sel.to) };
    let actions: CodeAction[];
    try {
      actions = await opts.onCodeActions(range);
    } catch {
      return;
    }
    showActionMenu(
      view,
      sel.head,
      actions.map((a) => ({
        label: a.title,
        detail: a.kind === 'quickfix' ? 'Quick Fix' : a.kind.startsWith('refactor') ? 'Refactor' : a.kind,
        run: () => {
          if (a.edit && opts.onApplyWorkspaceEdit) opts.onApplyWorkspaceEdit(a.edit);
        },
      })),
      { emptyText: 'No quick fixes or refactors here.' },
    );
  }

  // Mod-Alt-h call hierarchy: prepare the item under the cursor, then resolve its incoming + outgoing
  // calls and present a navigable menu. Incoming rows read `← caller (owner)`; outgoing rows `→ callee`.
  // Picking a row navigates to that item's range via onNavigateLocation (ide.ts switches files).
  async function showCallHierarchy(pos: number): Promise<void> {
    if (!opts.onPrepareCallHierarchy || !opts.onNavigateLocation) return;
    if (!opts.onIncomingCalls && !opts.onOutgoingCalls) return;
    const at = posToLsp(pos);
    let items: CallHierarchyItem[];
    try {
      items = await opts.onPrepareCallHierarchy(at.line, at.character);
    } catch {
      return;
    }
    const item = items[0];
    if (!item) {
      showActionMenu(view, pos, [], { emptyText: 'No call hierarchy here.' });
      return;
    }

    let incoming: CallHierarchyIncomingCall[] = [];
    let outgoing: CallHierarchyOutgoingCall[] = [];
    try {
      [incoming, outgoing] = await Promise.all([
        opts.onIncomingCalls ? opts.onIncomingCalls(item) : Promise.resolve([]),
        opts.onOutgoingCalls ? opts.onOutgoingCalls(item) : Promise.resolve([]),
      ]);
    } catch {
      return;
    }

    // One row per caller/callee. The `data` of `from`/`to` is irrelevant for navigation — we jump to
    // the item's own uri+range — so picking a row just forwards a plain Location to onNavigateLocation.
    const owner = (ci: CallHierarchyItem): string => {
      const d = ci.data as { owningType?: string | null } | undefined;
      return d?.owningType ? ` (${d.owningType})` : '';
    };
    const navTo = (ci: CallHierarchyItem) =>
      opts.onNavigateLocation!({ uri: ci.uri, range: ci.range });

    const rows = [
      ...incoming.map((c) => ({
        label: `← ${c.from.name}${owner(c.from)}`,
        detail: `${c.from.range.start.line + 1}:${c.from.range.start.character + 1}`,
        run: () => navTo(c.from),
      })),
      ...outgoing.map((c) => ({
        label: `→ ${c.to.name}${owner(c.to)}`,
        detail: `${c.to.range.start.line + 1}:${c.to.range.start.character + 1}`,
        run: () => navTo(c.to),
      })),
    ];
    showActionMenu(view, pos, rows, { emptyText: `No callers or callees for ${item.name}.` });
  }

  // Cmd/Ctrl-click jumps to definition (only when a provider is wired).
  const definitionClick = opts.onDefinition
    ? [
        EditorView.domEventHandlers({
          mousedown(event, v) {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            event.preventDefault();
            void gotoDefinition(pos);
            return true;
          },
        }),
      ]
    : [];

  // The EDITOR-scope shortcuts are registry-driven (keybindings.ts) and live in a compartment so Settings
  // can remap them live. Each handler keeps its exact provider guard + body from the old literals; they
  // reference `view`/`editorHandle` (declared below) but only fire on keypress, so the late binding is
  // fine — exactly as the prior literals did. This is a Partial<Record<BindingId, …>>: it wires only the
  // editor-scope ids; the global rows (commandPalette / saveAll) carry no editor handler — ide.tsx's
  // window listeners dispatch those by commandId (#432) — and toKeyBindings skips any id without a handler.
  const keybindingHandlers: Partial<Record<BindingId, () => boolean>> = {
    goToDefinition: () => {
      if (!opts.onDefinition) return false;
      void gotoDefinition(view.state.selection.main.head);
      return true;
    },
    format: () => {
      if (!opts.onFormat) return false;
      void opts.onFormat().then((edits) => editorHandle.applyEdits(edits));
      return true;
    },
    rename: () => {
      if (!opts.onPrepareRename || !opts.onRename) return false;
      void startRename(view.state.selection.main.head);
      return true;
    },
    findReferences: () => {
      if (!opts.onReferences || !opts.onNavigateLocation) return false;
      void findReferences(view.state.selection.main.head);
      return true;
    },
    codeActions: () => {
      if (!opts.onCodeActions) return false;
      void showCodeActions();
      return true;
    },
    // Call hierarchy (Mod-Alt-h) is now a rebindable editor row (#432) — folded out of its former literal
    // keymap into the compartment so Settings can remap it like the other editor actions. Same provider
    // guard + body the literal carried.
    callHierarchy: () => {
      if (!opts.onPrepareCallHierarchy || !opts.onNavigateLocation) return false;
      if (!opts.onIncomingCalls && !opts.onOutgoingCalls) return false;
      void showCallHierarchy(view.state.selection.main.head);
      return true;
    },
  };
  // The resolved (defaults + persisted overrides) keymap lives in its own compartment so Settings can
  // reconfigure it live (reconfigureKeybindings, below) without rebuilding the editor — same pattern as
  // lineWrap/minimap.
  const keybindingCompartment = new Compartment();

  // Mod-Alt-m files a review comment on the current selection (#259). Collision-free against the editor's
  // bound chords (Mod-D, Mod-Alt-↑/↓, Mod-., F2, Shift-F12, Mod-Alt-h, Mod-S, Mod-K, F12, Ctrl-Space). The
  // binding is harmless without a handler — addCommentAtSelection no-ops when onAddComment is unset.
  const addCommentKeys = keymap.of([
    {
      key: 'Mod-Alt-m',
      preventDefault: true,
      run: () => {
        addCommentAtSelection();
        return true;
      },
    },
  ]);

  // Soft-wrap lives in its own compartment so Settings can flip it without rebuilding the editor.
  const lineWrap = new Compartment();
  // The minimap lives in its own compartment too (same pattern as lineWrap), so Settings can show/hide
  // the overview rail live without losing editor state.
  const minimap = new Compartment();
  // Indentation (Settings → Editor → Tab size, #750) lives in its own compartment so setTabSize can
  // reconfigure it live. `indentUnit` is the whitespace inserted on indent; `EditorState.tabSize` is
  // the rendered tab width — both follow the configured space count. Round + floor-at-1 so a non-integer
  // or zero value (e.g. a fraction typed into the step-1 Settings number input, which reaches here via
  // onChange before a reload's coerceTabSize would round it) renders a sane integer indent and keeps
  // live-apply == reload (#734) — never an empty indent unit from `' '.repeat(0)`.
  const indent = new Compartment();
  const indentConfig = (n: number): Extension => {
    const width = Math.max(1, Math.round(n));
    return [indentUnit.of(' '.repeat(width)), EditorState.tabSize.of(width)];
  };

  // Inline (ghost-text) AI completions (#263). The pure state machine debounces keystrokes and owns
  // abort/staleness; the AI client (requestInline) talks to the configured provider. Both the master
  // gate and `canSuggest` re-read live settings so the prefs toggle (default off) takes effect at once
  // and the feature simply no-ops when off or when no provider is configured.
  const inlineState = createInlineState<EditorInlineContext>({
    debounceMs: 300,
    isEnabled: () => loadSettings().aiInlineCompletions,
    canSuggest: (ctx) => ctx.atBoundary && !ctx.hasSelection,
    fetch: (ctx, signal) => requestInline(ctx, signal),
  });

  // Keyboard-occlusion handling (#221): on a narrow viewport keep the caret visible above the soft
  // keyboard. Dispatching scrollIntoView synchronously from an updateListener is illegal (an update is
  // already in progress), so defer to the next animation frame — which also lets layout settle after
  // the keyboard slides in. Coalesced (one reveal per frame) and guarded so a queued reveal can't fire
  // on a destroyed view after teardown. `view` is assigned just below; this hoisted declaration only
  // runs from rAF/event callbacks, i.e. always after the assignment.
  let viewDestroyed = false;
  let caretRevealQueued = false;
  function scheduleCaretReveal(): void {
    if (caretRevealQueued) return;
    caretRevealQueued = true;
    requestAnimationFrame(() => {
      caretRevealQueued = false;
      if (viewDestroyed || !view.hasFocus) return;
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
    });
  }

  // Cache narrow-ness via a single matchMedia listener (#221) instead of measuring `window.innerWidth`
  // on EVERY keystroke/selection inside the hot updateListener below. The MediaQueryList re-evaluates on
  // a real viewport cross (its `change` event updates the cached flag); destroy() removes the listener.
  // Falls back to a one-shot innerWidth read where matchMedia is unavailable (older happy-dom).
  const narrowMql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${BP_NARROW}px)`)
      : null;
  let isNarrow = narrowMql ? narrowMql.matches : typeof window !== 'undefined' && window.innerWidth <= BP_NARROW;
  const onNarrowChange = (e: MediaQueryListEvent): void => {
    isNarrow = e.matches;
  };
  narrowMql?.addEventListener('change', onNarrowChange);

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        // CodeMirror's editable surface is an ARIA textbox; give it an accessible name so screen
        // readers (and Lighthouse's aria-input-field-name audit) announce it as the model editor.
        EditorView.contentAttributes.of({ 'aria-label': 'Koine model source editor' }),
        lineWrap.of(opts.lineWrap ? EditorView.lineWrapping : []),
        minimap.of(opts.minimap ? minimapExtension() : []),
        // Indentation width from Settings → Editor → Tab size (#750); reconfigured live via setTabSize.
        indent.of(indentConfig(loadSettings().tabSize)),
        // Multi-cursor (VS Code parity). allowMultipleSelections is the enabling switch: without it
        // CodeMirror reduces every multi-range selection to its main range (.asSingle()), so the
        // add-cursor commands silently collapse to one caret. The familiar bindings are ALREADY wired
        // by the keymaps loaded below — Mod-D → selectNextOccurrence (searchKeymap), Mod-Alt-↑/↓ →
        // addCursorAbove/Below and Escape → simplifySelection (defaultKeymap) — so enabling the facet
        // is what makes them functional. rectangularSelection + crosshairCursor add Alt-drag column
        // selection; drawSelection() (below) renders the extra carets.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        search({ top: true }),
        autocompletion({
          override: [opts.onCompletion ? lspCompletionSource(opts.onCompletion) : koineCompletions],
          icons: false,
        }),
        // Inline AI ghost-text, suppressed while the deterministic LSP popup above is open.
        inlineCompletionExtension({
          state: inlineState,
          isEnabled: () => loadSettings().aiInlineCompletions,
          lspPopupOpen: (v) => completionStatus(v.state) === 'active',
        }),
        // LSP inlay hints (inferred type / parameter-name annotations) over the visible viewport.
        ...(opts.onInlayHints ? [inlayHintsExtension(opts.onInlayHints)] : []),
        keybindingCompartment.of(buildExtraKeys(resolveKeybindings(), keybindingHandlers)),
        addCommentKeys,
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        ...definitionClick,
        koineLanguage,
        syntaxHighlighting(koineHighlight),
        // LSP semantic-token highlighting (paints over the static grammar; falls back to it when the
        // server returns no tokens). After syntaxHighlighting so the mark decorations layer on top.
        ...(opts.onSemanticTokens ? [semanticTokensExtension(opts.onSemanticTokens)] : []),
        // Review-comment marks + gutter (#259), wired only when a thread provider is supplied.
        ...(opts.getReviewThreads ? [reviewDecorationsExtension(opts.getReviewThreads), reviewTheme] : []),
        lintGutter(),
        ...(opts.onHover ? [koineHoverTooltip(opts.onHover)] : []),
        sharedTheme,
        // Phone touch tuning, appended after sharedTheme so its narrow-only rules win the cascade
        // (inert above $bp-narrow — no desktop change).
        narrowTouchTheme,
        EditorView.updateListener.of((u) => {
          // Fire onChange immediately; the LSP client debounces didChange.
          if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
          // Hand the structured change to onDocChange (review-span remapping needs the ChangeSet, not
          // just the new text). The review-decoration field also recomputes on docChanged on its own.
          // Skip a programmatic whole-buffer swap (setDoc on a file switch): remapping a full-replace
          // would orphan every pinned span. Only incremental edits re-anchor review threads.
          const isDocSwap = u.transactions.some((tr) => tr.annotation(programmaticDocSwap));
          if (u.docChanged && !isDocSwap && opts.onDocChange) opts.onDocChange(u.changes, u.state.doc);
          // Keyboard occlusion: on a narrow viewport, keep the caret above the soft keyboard whenever a
          // focused edit or selection move could have pushed it under the keyboard. Gated on the cached
          // narrow flag (not a per-keystroke innerWidth read) so desktop scroll behavior is byte-for-byte
          // unchanged.
          if ((u.docChanged || u.selectionSet) && u.view.hasFocus && isNarrow) {
            scheduleCaretReveal();
          }
          // Status-bar cursor segment (#923): report the 1-based caret line/column on any edit or
          // selection move. The main range's head is the caret; column is the 0-based in-line offset + 1.
          if ((u.docChanged || u.selectionSet) && opts.onCursor) {
            const head = u.state.selection.main.head;
            const ln = u.state.doc.lineAt(head);
            opts.onCursor(ln.number, head - ln.from + 1);
          }
        }),
      ],
    }),
  });

  // The soft keyboard opening/closing resizes the visual viewport; re-reveal the caret so it tracks the
  // shrinking visible area and stays above the keyboard. Guarded for environments without visualViewport
  // (happy-dom has none; some desktop browsers expose it only intermittently).
  const visualViewport = typeof window !== 'undefined' ? window.visualViewport : null;
  const onViewportResize = (): void => {
    if (view.hasFocus && isNarrow) scheduleCaretReveal();
  };
  visualViewport?.addEventListener('resize', onViewportResize);

  const editorHandle: KoineEditor = {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(doc: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        annotations: programmaticDocSwap.of(true), // not a user edit — don't remap/orphan review spans
      });
    },
    goto(line: number, col: number) {
      const ln = Math.min(Math.max(line, 1), view.state.doc.lines);
      const lineInfo = view.state.doc.line(ln);
      const pos = Math.min(lineInfo.from + Math.max(col - 1, 0), lineInfo.to);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    gotoRange(start, end) {
      jumpToRange(view, start, end);
    },
    gotoDefinition,
    showReferences(line: number, character: number) {
      // Move the caret to the position, then reuse the internal Shift-F12 handler so the references
      // picker anchors there — identical surface, driven from the launcher instead of the keymap.
      const pos = lspPosToOffset(view.state.doc, line, character);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
      void findReferences(pos);
    },
    showRename(line: number, character: number) {
      // Move the caret to the position, then reuse the internal F2 handler so the inline rename field
      // anchors there — identical surface, driven from the launcher instead of the keymap.
      const pos = lspPosToOffset(view.state.doc, line, character);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
      void startRename(pos);
    },
    applyEdits(edits: TextEdit[]) {
      if (!edits.length) return;
      // Offset conversion + the descending `from` sort (so earlier edits don't shift later offsets)
      // live in editsToChanges — applied here as a single transaction.
      view.dispatch({ changes: editsToChanges(view.state.doc, edits) });
    },
    setLineWrap(on: boolean) {
      view.dispatch({ effects: lineWrap.reconfigure(on ? EditorView.lineWrapping : []) });
    },
    setMinimap(on: boolean) {
      view.dispatch({ effects: minimap.reconfigure(on ? minimapExtension() : []) });
    },
    setTabSize(spaces: number) {
      view.dispatch({ effects: indent.reconfigure(indentConfig(spaces)) });
    },
    reconfigureKeybindings() {
      view.dispatch({ effects: keybindingCompartment.reconfigure(buildExtraKeys(resolveKeybindings(), keybindingHandlers)) });
    },
    addCommentAtSelection,
    refreshReviewDecorations() {
      dispatchReviewRefresh(view);
    },
    destroy() {
      viewDestroyed = true; // stop any queued caret-reveal frame from touching a torn-down view
      visualViewport?.removeEventListener('resize', onViewportResize);
      narrowMql?.removeEventListener('change', onNarrowChange);
      dismissFloating();
      view.destroy();
    },
  };

  return editorHandle;
}

// --- document outline rendering ---------------------------------------------

// Map common SymbolKind numbers to a short label badge shown before each row.
const SYMBOL_KIND_LABEL: Record<number, string> = {
  3: 'ctx', // Namespace / context
  5: 'class',
  6: 'method',
  8: 'field',
  10: 'enum',
  13: 'val', // Variable
  22: 'case', // EnumMember
  23: 'value', // Struct / value object
};

/**
 * Render a DocumentSymbol[] tree into nested <ul>/<button> rows. Clicking a row calls
 * `goto(line, col)` with the 1-based position of the symbol's selectionRange (falling
 * back to its range) start.
 */
export function renderSymbolTree(
  symbols: DocumentSymbol[],
  goto: (line: number, col: number) => void,
): HTMLElement {
  const build = (nodes: DocumentSymbol[]): HTMLUListElement => {
    const ul = document.createElement('ul');
    ul.className = 'outline-list';
    for (const sym of nodes) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'outline-row';
      const kind = SYMBOL_KIND_LABEL[sym.kind];
      if (kind) {
        const badge = document.createElement('span');
        badge.className = 'outline-kind';
        badge.textContent = kind;
        row.appendChild(badge);
      }
      const name = document.createElement('span');
      name.className = 'outline-name';
      name.textContent = sym.name;
      row.appendChild(name);
      const target = sym.selectionRange ?? sym.range;
      row.addEventListener('click', () => goto(target.start.line + 1, target.start.character + 1));
      li.appendChild(row);
      if (sym.children && sym.children.length) li.appendChild(build(sym.children));
      ul.appendChild(li);
    }
    return ul;
  };
  return build(symbols);
}

// The read-only output viewers (createOutputView / createJsonView / langExt / OutputLang / OutputView /
// ConfigView) live in ./outputView (#986); re-exported so `@/editor/editor` consumers keep resolving
// them here.
export { langExt, createOutputView, createJsonView, type OutputLang, type OutputView, type ConfigView } from '@/editor/outputView';

// The editable settings.json editor (createJsonSettingsEditor / settingsSchemaHover /
// settingsCompletionSource / JsonSettingsEditor) lives in ./settingsJsonEditor (#986); re-exported so
// `@/editor/editor` consumers (settingsPage.tsx) keep resolving it here.
export { settingsSchemaHover, settingsCompletionSource, createJsonSettingsEditor, type JsonSettingsEditor } from '@/editor/settingsJsonEditor';
