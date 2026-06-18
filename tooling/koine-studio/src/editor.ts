// CodeMirror 6 setup for Koine Studio: an editable .koi editor (token highlighting,
// keyword autocomplete, bracket closing, search) plus a read-only, syntax-highlighted
// viewer for the generated C#/TypeScript output. Adapted from the website playground;
// the key difference is that diagnostics are PUSH-based (publishDiagnostics → setDiagnostics)
// rather than pull-based (linter()).
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  hoverTooltip,
  type Tooltip,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { typescript } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { tags as t } from '@lezer/highlight';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type {
  CodeAction,
  DocumentSymbol,
  HoverResult,
  Location,
  LspDiagnostic,
  MarkedString,
  PrepareRenameResult,
  Range as LspRange,
  TextEdit,
  WorkspaceEdit,
} from './lsp';
import { dismissFloating, showActionMenu, showRenameInput } from './actions';

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

const koineHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--koi-hl-keyword)', fontWeight: '600' },
  { tag: t.typeName, color: 'var(--koi-hl-type)' },
  { tag: t.className, color: 'var(--koi-hl-type)' },
  { tag: t.string, color: 'var(--koi-hl-string)' },
  { tag: t.regexp, color: 'var(--koi-hl-regex)' },
  { tag: t.number, color: 'var(--koi-hl-number)' },
  { tag: t.comment, color: 'var(--koi-hl-comment)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--koi-hl-meta)' },
  { tag: t.operator, color: 'var(--koi-hl-punct)' },
  { tag: t.punctuation, color: 'var(--koi-hl-punct)' },
  { tag: t.propertyName, color: 'var(--koi-hl-type)' },
  { tag: t.variableName, color: 'var(--koi-fg)' },
  { tag: t.definitionKeyword, color: 'var(--koi-hl-keyword)', fontWeight: '600' },
]);

// Keyword/type autocomplete for the editor.
function koineCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return completeFromList([
    ...KEYWORDS.map((k) => ({ label: k, type: 'keyword' })),
    ...TYPES.map((k) => ({ label: k, type: 'type' })),
  ])(ctx);
}

const sharedTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--koi-editor-font-size, 13.5px)' },
  '.cm-scroller': { fontFamily: 'var(--koi-font-mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--koi-muted)', border: 'none' },
  '.cm-content': { caretColor: 'var(--koi-accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--koi-accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--koi-accent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--koi-cyan) 22%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--koi-cyan) 28%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--koi-accent) 40%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--koi-paper-2)', color: 'var(--koi-fg)', borderColor: 'var(--koi-line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--koi-line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--koi-line)' },
  '.cm-panel.cm-search': {
    padding: '8px 10px',
    fontFamily: 'var(--koi-font-body)',
    fontSize: '0.82rem',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
  },
  '.cm-panel.cm-search label': {
    color: 'var(--koi-muted)',
    fontSize: '0.78rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--koi-surface)',
    color: 'var(--koi-fg)',
    border: '1px solid var(--koi-line)',
    borderRadius: '6px',
    padding: '4px 8px',
    fontFamily: 'var(--koi-font-mono)',
    fontSize: '0.8rem',
  },
  '.cm-textfield:focus-visible': { outline: 'none', borderColor: 'var(--koi-accent)' },
  '.cm-button': {
    backgroundColor: 'var(--koi-surface)',
    backgroundImage: 'none',
    color: 'var(--koi-fg)',
    border: '1px solid var(--koi-line)',
    borderRadius: '6px',
    padding: '4px 9px',
    fontFamily: 'var(--koi-font-mono)',
    fontSize: '0.76rem',
    cursor: 'pointer',
  },
  '.cm-button:hover': { borderColor: 'var(--koi-accent)', color: 'var(--koi-fg)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--koi-surface)',
    border: '1px solid var(--koi-line)',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--koi-accent)',
    color: 'var(--koi-on-accent)',
  },
});

// --- tiny markdown renderer -------------------------------------------------
// Shared by the hover tooltip here and the Glossary pane in ide.ts. We render only
// the small subset of markdown the language server produces (headings, lists,
// fenced/inline code, bold/italic, paragraphs) rather than pulling in a dependency.
// Source is trusted (the LSP server) but still HTML-escaped before assembly.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(text: string): string {
  let out = text;
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, c) => `${p}<em>${c}</em>`);
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, (_m, p, c) => `${p}<em>${c}</em>`);
  return out;
}

// GFM tables. The glossary emitter produces `| Field | Type | Description |` blocks, so split a row
// into trimmed cells (honoring an escaped `\|` inside a cell) and recognise the `|---|:--:|`
// separator row that promotes the preceding row to a header.
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** Render a small subset of markdown to an HTML string. */
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md.replace(/\r\n/g, '\n')).split('\n');
  const html: string[] = [];
  let i = 0;
  let listOpen = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMd(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushParagraph();
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      html.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMd(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // GFM table: a row immediately followed by a `|---|---|` separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      closeList();
      const headerCells = splitTableRow(line);
      i += 2; // consume the header row + the separator row
      const bodyRows: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitTableRow(lines[i]);
        bodyRows.push('<tr>' + cells.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>');
        i++;
      }
      const head = '<thead><tr>' + headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead>';
      html.push(`<table>${head}<tbody>${bodyRows.join('')}</tbody></table>`);
      continue;
    }

    const item = line.match(/^\s*[-*+]\s+(.*)$/);
    if (item) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${inlineMd(item[1])}</li>`);
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      closeList();
      i++;
      continue;
    }

    closeList();
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}

// --- hover tooltips ---------------------------------------------------------

export type HoverFn = (line: number, character: number) => Promise<HoverResult | null>;

/** Flatten an LSP Hover's `contents` (MarkupContent | MarkedString | array) into markdown. */
function hoverToMarkdown(hover: HoverResult): string {
  const fromMarked = (m: MarkedString): string =>
    typeof m === 'string' ? m : '```' + m.language + '\n' + m.value + '\n```';
  const c = hover.contents;
  if (Array.isArray(c)) return c.map(fromMarked).join('\n\n');
  if (typeof c === 'string') return c;
  if ('kind' in c) return c.value; // MarkupContent
  return fromMarked(c); // {language,value} MarkedString
}

/**
 * CodeMirror hover tooltip backed by `lsp.hover()`. Converts the CM offset to a 0-based
 * {line,character}, requests a hover, and renders the returned markup. Degrades silently
 * (no tooltip) when hover returns null/empty or the request fails.
 */
function koineHoverTooltip(hover: HoverFn) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const lineInfo = view.state.doc.lineAt(pos);
    const lspLine = lineInfo.number - 1; // CM line is 1-based, LSP 0-based
    const character = pos - lineInfo.from;
    let res: HoverResult | null;
    try {
      res = await hover(lspLine, character);
    } catch {
      return null; // request failed/timed out — show nothing
    }
    if (!res || !res.contents) return null;
    const markdown = hoverToMarkdown(res).trim();
    if (!markdown) return null;

    // Anchor to the word under the cursor when the doc has not changed shape.
    const word = view.state.wordAt(pos);
    return {
      pos: word?.from ?? pos,
      end: word?.to ?? pos,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'koi-hover koi-md';
        dom.innerHTML = renderMarkdown(markdown);
        return { dom };
      },
    };
  });
}

// --- editable editor --------------------------------------------------------

/** Go-to-definition provider; resolves a 0-based position to a Location (or array/null). */
export type DefinitionFn = (line: number, character: number) => Promise<Location | Location[] | null>;

/**
 * Navigation handler invoked once a definition resolves. ide.ts decides what to do: a
 * cross-file Location switches the active file before jumping; a same-file Location just
 * jumps. The editor only resolves the Location and hands it off — it does NOT navigate itself.
 */
export type NavigateFn = (loc: Location) => void;

/** Format provider; resolves to the LSP TextEdits to apply to the whole document. */
export type FormatFn = () => Promise<TextEdit[]>;

/** prepareRename provider; resolves the editable identifier range under the cursor (or null). */
export type PrepareRenameFn = (line: number, character: number) => Promise<PrepareRenameResult | null>;
/** rename provider; resolves the workspace edit renaming the symbol under the cursor (or null). */
export type RenameFn = (line: number, character: number, newName: string) => Promise<WorkspaceEdit | null>;
/** find-references provider; resolves every reference to the symbol under the cursor. */
export type ReferencesFn = (line: number, character: number) => Promise<Location[]>;
/** code-action provider; resolves the quickfixes + refactors for a 0-based selection range. */
export type CodeActionsFn = (range: LspRange) => Promise<CodeAction[]>;
/** Applies a resolved WorkspaceEdit; ide.ts spreads the edits across its open buffers. */
export type ApplyWorkspaceEditFn = (edit: WorkspaceEdit) => void;
/** Navigates to a picked reference Location; ide.ts switches files if needed and jumps. */
export type NavigateLocationFn = (location: Location) => void;
/** Maps a file:// uri to a short label for the references picker (e.g. its relPath). */
export type UriLabelFn = (uri: string) => string;

export interface KoineEditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange?: (doc: string) => void;
  /** Optional LSP hover provider; when given, hover tooltips are enabled. */
  onHover?: HoverFn;
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
  /** Apply LSP TextEdits to the document in one transaction (edits sorted internally). */
  applyEdits(edits: TextEdit[]): void;
  destroy(): void;
}

/** Map a 0-based LSP diagnostic to a CodeMirror diagnostic (offset-based). */
function lspToCm(view: EditorView, d: LspDiagnostic): CmDiagnostic {
  const doc = view.state.doc;
  const clampLine0 = (l: number) => Math.min(Math.max(l, 0), doc.lines - 1); // LSP line is 0-based
  const startLine = doc.line(clampLine0(d.range.start.line) + 1); // doc.line() is 1-based
  const endLine = doc.line(clampLine0(d.range.end.line) + 1);
  const from = Math.min(startLine.from + d.range.start.character, startLine.to);
  let to = Math.min(endLine.from + d.range.end.character, endLine.to);
  if (to <= from) to = Math.min(from + 1, doc.length);
  return {
    from,
    to,
    severity: d.severity === 2 ? 'warning' : 'error',
    message: (d.code != null ? d.code + ': ' : '') + d.message,
  };
}

/** Apply PUSH-based diagnostics from a publishDiagnostics notification. */
export function setEditorDiagnostics(view: EditorView, diags: LspDiagnostic[]): void {
  view.dispatch(setDiagnostics(view.state, diags.map((d) => lspToCm(view, d))));
}

/** Convert a 0-based LSP {line,character} to a CodeMirror document offset (clamped). */
function lspPosToOffset(view: EditorView, line: number, character: number): number {
  const doc = view.state.doc;
  const ln = Math.min(Math.max(line, 0), doc.lines - 1) + 1; // doc.line() is 1-based
  const lineInfo = doc.line(ln);
  return Math.min(lineInfo.from + Math.max(character, 0), lineInfo.to);
}

/** Jump the editor to a 0-based {line,character}, selecting through to an end position. */
function jumpToRange(view: EditorView, start: { line: number; character: number }, end: { line: number; character: number }): void {
  const anchor = lspPosToOffset(view, start.line, start.character);
  const head = lspPosToOffset(view, end.line, end.character);
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
    const anchor = lspPosToOffset(view, prep.range.start.line, prep.range.start.character);
    const end = lspPosToOffset(view, prep.range.end.line, prep.range.end.character);
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
    const label = opts.uriLabel ?? ((uri: string) => uri.split('/').pop() ?? uri);
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

  // F12 (go-to-definition) and Cmd/Ctrl-S (format) keybindings.
  const extraKeys = keymap.of([
    {
      key: 'F12',
      run: () => {
        if (!opts.onDefinition) return false;
        void gotoDefinition(view.state.selection.main.head);
        return true;
      },
    },
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        if (!opts.onFormat) return false;
        void opts.onFormat().then((edits) => editorHandle.applyEdits(edits));
        return true;
      },
    },
    {
      key: 'F2',
      preventDefault: true,
      run: () => {
        if (!opts.onPrepareRename || !opts.onRename) return false;
        void startRename(view.state.selection.main.head);
        return true;
      },
    },
    {
      key: 'Shift-F12',
      preventDefault: true,
      run: () => {
        if (!opts.onReferences || !opts.onNavigateLocation) return false;
        void findReferences(view.state.selection.main.head);
        return true;
      },
    },
    {
      key: 'Mod-.',
      preventDefault: true,
      run: () => {
        if (!opts.onCodeActions) return false;
        void showCodeActions();
        return true;
      },
    },
  ]);

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        search({ top: true }),
        autocompletion({ override: [koineCompletions], icons: false }),
        extraKeys,
        keymap.of([...closeBracketsKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        ...definitionClick,
        koineLanguage,
        syntaxHighlighting(koineHighlight),
        lintGutter(),
        ...(opts.onHover ? [koineHoverTooltip(opts.onHover)] : []),
        sharedTheme,
        EditorView.updateListener.of((u) => {
          // Fire onChange immediately; the LSP client debounces didChange.
          if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });

  const editorHandle: KoineEditor = {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(doc: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
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
    applyEdits(edits: TextEdit[]) {
      if (!edits.length) return;
      // Convert each LSP range to offsets, then apply sorted by `from` descending so
      // earlier edits don't shift the offsets of later ones.
      const changes = edits
        .map((e) => ({
          from: lspPosToOffset(view, e.range.start.line, e.range.start.character),
          to: lspPosToOffset(view, e.range.end.line, e.range.end.character),
          insert: e.newText,
        }))
        .sort((a, b) => b.from - a.from);
      view.dispatch({ changes });
    },
    destroy() {
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

// --- read-only output viewer ------------------------------------------------

export type OutputLang = 'csharp' | 'typescript' | 'python' | 'plain';

const langExt = (lang: OutputLang): Extension => {
  if (lang === 'csharp') return StreamLanguage.define(csharp);
  if (lang === 'typescript') return StreamLanguage.define(typescript);
  if (lang === 'python') return StreamLanguage.define(python);
  return [];
};

export interface OutputView {
  setContent(text: string, lang: OutputLang): void;
  destroy(): void;
}

/** A read-only, syntax-highlighted, line-numbered viewer for generated output. */
export function createOutputView(parent: HTMLElement): OutputView {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of(searchKeymap),
        language.of(langExt('csharp')),
        syntaxHighlighting(koineHighlight),
        syntaxHighlighting(defaultHighlightStyle),
        sharedTheme,
      ],
    }),
  });

  return {
    setContent(text, lang) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: language.reconfigure(langExt(lang)),
      });
    },
    destroy: () => view.destroy(),
  };
}
