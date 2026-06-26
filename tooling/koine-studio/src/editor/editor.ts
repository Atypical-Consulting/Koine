// CodeMirror 6 setup for Koine Studio: an editable .koi editor (token highlighting,
// keyword autocomplete, bracket closing, search) plus a read-only, syntax-highlighted
// viewer for the generated C#/TypeScript output. Adapted from the website playground;
// the key difference is that diagnostics are PUSH-based (publishDiagnostics → setDiagnostics)
// rather than pull-based (linter()).
import { EditorState, Compartment, StateEffect, Annotation, type ChangeSet, type Extension, type Text } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  type Tooltip,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
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
  completionKeymap,
  completionStatus,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { showMinimap } from '@replit/codemirror-minimap';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { typescript, json } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { php } from '@codemirror/lang-php';
import { tags as t } from '@lezer/highlight';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CompletionItem,
  DocumentSymbol,
  HoverResult,
  InlayHint,
  Location,
  LspDiagnostic,
  MarkedString,
  PrepareRenameResult,
  Range as LspRange,
  SemanticTokens,
  SourceSpan,
  TextEdit,
  WorkspaceEdit,
} from '@/lsp/lsp';
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

/** Map a numeric LSP CompletionItemKind to a CodeMirror completion `type` (drives icon/colour). */
function cmCompletionType(kind?: number): string {
  switch (kind) {
    case 14: // Keyword
      return 'keyword';
    case 7: // Class
      return 'class';
    case 13: // Enum
    case 20: // EnumMember
      return 'enum';
    case 5: // Field
    case 10: // Property
      return 'property';
    case 2: // Method
      return 'method';
    default:
      return 'variable';
  }
}

/**
 * LSP-backed completion source. Fires on an explicit Ctrl-Space, while typing an identifier, or
 * right after a `.`/`:` trigger; converts the cursor to a 0-based line/character, asks the language
 * service, and maps the items to CodeMirror completions.
 */
function lspCompletionSource(onCompletion: CompletionFn) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
    const trigger = ctx.matchBefore(/[.:]\s*/);
    if (!ctx.explicit && !word && !trigger) return null;

    const docLine = ctx.state.doc.lineAt(ctx.pos);
    const items = await onCompletion(docLine.number - 1, ctx.pos - docLine.from);
    if (!items.length) return null;

    const options: Completion[] = items.map((i) => ({
      label: i.label,
      type: cmCompletionType(i.kind),
      detail: i.detail ?? undefined,
      info: i.documentation ?? undefined,
    }));
    return { from: word ? word.from : ctx.pos, options, validFor: /^[A-Za-z0-9_]*$/ };
  };
}

const sharedTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--koi-editor-font-size, 13.5px)' },
  '.cm-scroller': { fontFamily: 'var(--koi-font-mono)', lineHeight: 'var(--koi-editor-line-height, 1.6)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--koi-muted)', border: 'none' },
  '.cm-content': { caretColor: 'var(--koi-accent)' },
  // drawSelection() hides the native caret and paints its own .cm-cursor via border-left, which
  // otherwise falls back to CodeMirror's default black — invisible on the dark theme's background.
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--koi-accent)' },
  // drawSelection() also paints the selection range as .cm-selectionBackground in a layer behind
  // the text. With no rule of our own CodeMirror uses its built-in light-grey defaults
  // (#d9d9d9, focused #d7d4f0) for both themes — a near-white box that washes out the already
  // light text in dark mode (the contrast bug). Tint the theme accent instead so the highlight
  // reads in both themes and keeps syntax colours legible on top. The focused selector mirrors
  // CodeMirror's own 5-class chain so our rule wins the cascade by source order (equal specificity,
  // our theme is registered after the low-priority base theme).
  '.cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    { backgroundColor: 'color-mix(in srgb, var(--koi-accent) 30%, transparent)' },
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

// --- hover tooltips ---------------------------------------------------------

export type HoverFn = (line: number, character: number) => Promise<HoverResult | null>;

/** Completion provider; resolves the LSP completion items at a 0-based position. */
export type CompletionFn = (line: number, character: number) => Promise<CompletionItem[]>;

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

// --- inlay hints ------------------------------------------------------------

/** Inlay-hint provider; resolves the type/parameter annotations for a 0-based range. */
export type InlayHintsFn = (
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
) => Promise<InlayHint[]>;

// InlayHintKind: 1 = Type (rendered AFTER the position, like `: T`), 2 = Parameter (rendered BEFORE
// the position, like `name:`). Anything else defaults to the Type side.
const INLAY_KIND_PARAMETER = 2;

/** Convert a CodeMirror document offset to a 0-based LSP {line, character} (pure; no view needed). */
function posToLspPos(doc: Text, pos: number): { line: number; character: number } {
  const lineInfo = doc.lineAt(pos);
  return { line: lineInfo.number - 1, character: pos - lineInfo.from };
}

// Dispatched purely to make the inlay ViewPlugin re-evaluate its decorations once an async fetch
// resolves — that resolution happens outside any transaction (mirrors inlineCompletion's redrawEffect).
const inlayRedrawEffect = StateEffect.define<null>();

/** The dimmed inline widget that paints one inlay hint. */
class InlayWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: number,
  ) {
    super();
  }
  eq(other: InlayWidget): boolean {
    return other.label === this.label && other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-inlay-hint';
    span.textContent = this.label;
    return span;
  }
}

const inlayTheme = EditorView.baseTheme({
  '.cm-inlay-hint': {
    color: 'var(--koi-muted)',
    fontStyle: 'normal',
    // A hair smaller so the annotation reads as metadata, not source.
    fontSize: '0.92em',
    padding: '0 1px',
  },
});

/**
 * Build the inlay-hint extension: a ViewPlugin that, for the visible viewport, asks the language
 * service for type/parameter hints and renders each as a dimmed inline widget. The first paint
 * fetches immediately; subsequent scroll/edit-driven refetches are DEBOUNCED (each fetch recompiles
 * the whole workspace, so one-per-scroll-tick / keystroke would jank the UI thread). Between an edit
 * and the next fetch resolving, existing widgets are mapped through the change so they track their
 * text instead of jumping to a clamped offset. Stale async results are dropped via a per-request
 * token (mirrors inlineCompletion's race handling).
 */
export function inlayHintsExtension(provider: InlayHintsFn, debounceMs = 200): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private hints: InlayHint[] = [];
      private seq = 0;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(view: EditorView) {
        this.fetch(view); // first paint is immediate — the debounce only throttles refetches
      }

      update(u: ViewUpdate): void {
        // Keep existing widgets attached to their text through an edit so they don't flash at a
        // clamped offset during the debounce window before the fresh fetch lands.
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        // Coalesce rapid viewport/doc changes into one debounced fetch.
        if (u.viewportChanged || u.docChanged) this.scheduleFetch(u.view);
        // Rebuild from the freshest hints once an async fetch resolved (it dispatched the redraw
        // effect outside any transaction).
        const redrawn = u.transactions.some((tr) => tr.effects.some((e) => e.is(inlayRedrawEffect)));
        if (redrawn) this.decorations = this.build(u.view);
      }

      private scheduleFetch(view: EditorView): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.fetch(view);
        }, debounceMs);
      }

      /** Ask the provider for hints over the visible range; redraw when the freshest answer lands. */
      private fetch(view: EditorView): void {
        const token = ++this.seq;
        const { from, to } = view.viewport;
        const start = posToLspPos(view.state.doc, from);
        const end = posToLspPos(view.state.doc, to);
        void provider(start.line, start.character, end.line, end.character)
          .then((hints) => {
            // Ignore a stale answer (a newer fetch superseded it) or one for a destroyed plugin.
            if (token !== this.seq) return;
            this.hints = hints;
            view.dispatch({ effects: inlayRedrawEffect.of(null) });
          })
          .catch(() => {
            // Request failed/timed out — leave the previous hints in place rather than flashing.
          });
      }

      private build(view: EditorView): DecorationSet {
        const doc = view.state.doc;
        const decos = this.hints.map((h) => {
          const at = lspPosToOffset(doc, h.position.line, h.position.character);
          // Parameter hints sit BEFORE the value (side -1); type hints AFTER it (side 1).
          const side = h.kind === INLAY_KIND_PARAMETER ? -1 : 1;
          return Decoration.widget({ widget: new InlayWidget(h.label, h.kind), side }).range(at);
        });
        // CodeMirror requires the decoration set sorted by `from` (then side) — `true` sorts it.
        return Decoration.set(decos, true);
      }

      destroy(): void {
        // Bump the token so any in-flight fetch's resolution is ignored after teardown; cancel any
        // pending debounced fetch.
        this.seq++;
        if (this.timer !== null) clearTimeout(this.timer);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, inlayTheme];
}

// --- semantic tokens --------------------------------------------------------

/** Semantic-tokens provider; resolves the LSP delta-encoded int stream for the active document. */
export type SemanticTokensFn = () => Promise<SemanticTokens>;

/**
 * The semantic-token-type legend, indexed by `tokenType` in the LSP `data` stream. This MUST stay in
 * lock-step with `SemanticTokenProvider.TokenTypeNames` in C# (do not reorder) — the server emits the
 * index, the editor maps it to a class here. Each name becomes the CSS class `cm-st-<name>` (themed in
 * `semanticTokenTheme` below). An out-of-range index maps to no class (the token is simply not painted).
 */
export const SEMANTIC_TOKEN_TYPES = [
  'type', // 0
  'enum', // 1
  'enumMember', // 2
  'property', // 3
  'keyword', // 4
  'parameter', // 5
] as const;

/** The `tokenModifiers` bitset (`SemanticTokenModifier.TokenModifierNames` in C#); bit 0 = declaration. */
const SEMANTIC_MODIFIER_DECLARATION = 1 << 0;

/** One decoded semantic token, resolved to absolute CodeMirror document offsets and a CSS class. */
export interface DecodedSemanticToken {
  from: number;
  to: number;
  /** Space-separated CSS class(es): `cm-st-<type>` plus `cm-st-declaration` when the declaration bit is set. */
  cls: string;
}

/**
 * Decode the LSP semantic-tokens `data` stream (groups of 5 ints, delta-encoded) into absolute,
 * offset-resolved tokens ready to become CodeMirror mark decorations. PURE — it runs on a CodeMirror
 * `Text` (no EditorView), so it is unit-tested directly. The wire encoding (per the LSP spec):
 *   - `data[i..i+4]` = `[deltaLine, deltaStartChar, length, tokenType, tokenModifiers]`.
 *   - Tokens are sorted; deltaLine is relative to the previous token's line; deltaStartChar is relative
 *     to the previous token's start column when on the SAME line, else absolute; the first token's
 *     deltas are absolute from (0,0).
 *   - `tokenType` indexes {@link SEMANTIC_TOKEN_TYPES}; `tokenModifiers` is a bitset (bit 0 = declaration).
 * Tokens with an unknown type index, zero/negative length, or a position past the document are dropped
 * (defensive — a malformed stream must never throw or paint a bogus range).
 */
export function decodeSemanticTokens(data: number[], doc: Text): DecodedSemanticToken[] {
  const out: DecodedSemanticToken[] = [];
  let line = 0;
  let startChar = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaStartChar = data[i + 1];
    const length = data[i + 2];
    const typeIndex = data[i + 3];
    const modifiers = data[i + 4];

    // Apply the deltas: a new line resets the column to the absolute deltaStartChar; same line adds it.
    line += deltaLine;
    startChar = deltaLine === 0 ? startChar + deltaStartChar : deltaStartChar;

    const typeName = SEMANTIC_TOKEN_TYPES[typeIndex];
    if (typeName === undefined || length <= 0) continue;
    if (line < 0 || line >= doc.lines) continue; // past the document — drop defensively

    const lineInfo = doc.line(line + 1); // doc.line() is 1-based; LSP line is 0-based
    const from = lineInfo.from + startChar;
    const to = from + length;
    if (from < 0 || from > lineInfo.to) continue; // start past the line end — drop
    const clampedTo = Math.min(to, lineInfo.to); // never run a mark past the line end
    if (clampedTo <= from) continue;

    const cls =
      (modifiers & SEMANTIC_MODIFIER_DECLARATION) !== 0
        ? `cm-st-${typeName} cm-st-declaration`
        : `cm-st-${typeName}`;
    out.push({ from, to: clampedTo, cls });
  }
  return out;
}

/** Build the sorted CodeMirror mark-decoration set for a decoded token stream. */
function semanticTokensToDecorations(tokens: DecodedSemanticToken[]): DecorationSet {
  if (tokens.length === 0) return Decoration.none;
  const decos = tokens.map((tok) => Decoration.mark({ class: tok.cls }).range(tok.from, tok.to));
  // CodeMirror requires the decoration set sorted by `from` — `true` sorts it.
  return Decoration.set(decos, true);
}

// Dispatched purely to make the semantic-tokens ViewPlugin re-evaluate its decorations once an async
// fetch resolves outside any transaction (mirrors inlayRedrawEffect / inlineCompletion's redrawEffect).
const semanticTokensRedrawEffect = StateEffect.define<null>();

// Each token-type class reuses or extends the existing `--koi-hl-*` palette so semantic highlighting
// reads consistently with the static grammar; the new `--koi-hl-sem-*` vars (themed in
// _dark.scss / _light.scss) keep enum / enumMember / property / parameter visually distinct from each
// other and from value/type. `cm-st-declaration` (the only modifier) bolds the declaring occurrence.
const semanticTokenTheme = EditorView.baseTheme({
  '.cm-st-type': { color: 'var(--koi-hl-type)' },
  '.cm-st-enum': { color: 'var(--koi-hl-sem-enum)' },
  '.cm-st-enumMember': { color: 'var(--koi-hl-sem-enum-member)' },
  '.cm-st-property': { color: 'var(--koi-hl-sem-property)' },
  '.cm-st-keyword': { color: 'var(--koi-hl-keyword)', fontWeight: '600' },
  '.cm-st-parameter': { color: 'var(--koi-hl-sem-parameter)', fontStyle: 'italic' },
  '.cm-st-declaration': { fontWeight: '600' },
});

/**
 * Build the semantic-tokens extension: a ViewPlugin that, on each (debounced) doc change, asks the
 * language service for the document's semantic tokens, decodes the delta stream, and paints each as a
 * mark decoration with its token-type class. The first paint fetches immediately; edit-driven refetches
 * are DEBOUNCED (each fetch recompiles the document). When the stream is empty the plugin returns
 * `Decoration.none`, so the static StreamLanguage grammar stays in charge — graceful degradation, never
 * a cleared/overridden buffer. Stale async results are dropped via a per-request token (mirrors
 * inlayHintsExtension). The redraw on resolution rides a state effect (resolution is outside any txn).
 */
export function semanticTokensExtension(provider: SemanticTokensFn, debounceMs = 200): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private tokens: SemanticTokens = { data: [] };
      private seq = 0;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(view: EditorView) {
        this.fetch(view); // first paint is immediate — the debounce only throttles refetches
      }

      update(u: ViewUpdate): void {
        // Keep existing decorations attached to their text through an edit so highlighting tracks the
        // buffer (no flash at a clamped offset) during the debounce window before the fresh fetch lands.
        if (u.docChanged) {
          this.decorations = this.decorations.map(u.changes);
          this.scheduleFetch(u.view);
        }
        // Rebuild from the freshest tokens once an async fetch resolved (it dispatched the redraw effect
        // outside any transaction).
        const redrawn = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(semanticTokensRedrawEffect)),
        );
        if (redrawn) this.decorations = this.build(u.view);
      }

      private scheduleFetch(view: EditorView): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.fetch(view);
        }, debounceMs);
      }

      /** Ask the provider for the document's tokens; redraw when the freshest answer lands. */
      private fetch(view: EditorView): void {
        const token = ++this.seq;
        void provider()
          .then((tokens) => {
            // Ignore a stale answer (a newer fetch superseded it) or one for a destroyed plugin.
            if (token !== this.seq) return;
            this.tokens = tokens ?? { data: [] };
            view.dispatch({ effects: semanticTokensRedrawEffect.of(null) });
          })
          .catch(() => {
            // Request failed/timed out — leave the previous decorations in place rather than flashing.
          });
      }

      private build(view: EditorView): DecorationSet {
        // An empty/absent stream decodes to [], which semanticTokensToDecorations turns into
        // Decoration.none — so the static grammar highlighting stays authoritative (single source of
        // truth for the empty-stream contract; no separate early return needed).
        return semanticTokensToDecorations(decodeSemanticTokens(this.tokens?.data ?? [], view.state.doc));
      }

      destroy(): void {
        // Bump the token so any in-flight fetch's resolution is ignored after teardown; cancel any
        // pending debounced fetch.
        this.seq++;
        if (this.timer !== null) clearTimeout(this.timer);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, semanticTokenTheme];
}

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
/** prepareCallHierarchy provider; resolves the call-hierarchy item(s) at a 0-based position. */
export type PrepareCallHierarchyFn = (line: number, character: number) => Promise<CallHierarchyItem[]>;
/** incomingCalls provider; resolves the callers of a prepared item (item echoed back verbatim). */
export type IncomingCallsFn = (item: CallHierarchyItem) => Promise<CallHierarchyIncomingCall[]>;
/** outgoingCalls provider; resolves the callees of a prepared item (item echoed back verbatim). */
export type OutgoingCallsFn = (item: CallHierarchyItem) => Promise<CallHierarchyOutgoingCall[]>;
/** Applies a resolved WorkspaceEdit; ide.ts spreads the edits across its open buffers. */
export type ApplyWorkspaceEditFn = (edit: WorkspaceEdit) => void;
/** Navigates to a picked reference Location; ide.ts switches files if needed and jumps. */
export type NavigateLocationFn = (location: Location) => void;
/** Maps a file:// uri to a short label for the references picker (e.g. its relPath). */
export type UriLabelFn = (uri: string) => string;

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
  /** Apply LSP TextEdits to the document in one transaction (edits sorted internally). */
  applyEdits(edits: TextEdit[]): void;
  /** Turn editor soft-wrap on/off (reconfigures a compartment; no state loss). */
  setLineWrap(on: boolean): void;
  /** Show/hide the document-overview minimap (reconfigures a compartment; no state loss). */
  setMinimap(on: boolean): void;
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

  // The five LSP-action shortcuts are now registry-driven (keybindings.ts) and live in a compartment so
  // Settings can remap them live. Each handler keeps its exact provider guard + body from the old literals;
  // they reference `view`/`editorHandle` (declared below) but only fire on keypress, so the late binding is
  // fine — exactly as the prior literals did.
  const keybindingHandlers: Record<BindingId, () => boolean> = {
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
  };
  // The resolved (defaults + persisted overrides) keymap lives in its own compartment so Settings can
  // reconfigure it live (reconfigureKeybindings, below) without rebuilding the editor — same pattern as
  // lineWrap/minimap.
  const keybindingCompartment = new Compartment();
  // Call hierarchy (Mod-Alt-h) is NOT user-customizable yet (#266 scopes the five LSP actions); keep it
  // as its own literal keymap so it survives the move to the registry-driven compartment.
  const callHierarchyKeys = keymap.of([
    {
      key: 'Mod-Alt-h',
      preventDefault: true,
      run: () => {
        if (!opts.onPrepareCallHierarchy || !opts.onNavigateLocation) return false;
        if (!opts.onIncomingCalls && !opts.onOutgoingCalls) return false;
        void showCallHierarchy(view.state.selection.main.head);
        return true;
      },
    },
  ]);

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
        callHierarchyKeys,
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

// --- read-only output viewer ------------------------------------------------

// An emit-target id (e.g. 'csharp') or 'plain' for unhighlighted text. A plain `string`, not a closed
// union: a backend-only target the registry reports but Studio has no CodeMirror mode for still previews
// — `langExt` degrades it to plain text rather than treating this list as a second source of truth (#282).
export type OutputLang = string;

// The bundled CodeMirror modes, keyed by target id. This map is intentionally static (a mode must be
// bundled per language) and is a graceful FALLBACK, not a target list: an id with no entry — including
// 'plain' and any backend-only target — highlights as plain text.
const LANG_MODES: Record<string, () => Extension> = {
  csharp: () => StreamLanguage.define(csharp),
  typescript: () => StreamLanguage.define(typescript),
  python: () => StreamLanguage.define(python),
  rust: () => StreamLanguage.define(rust),
  // JSON powers the read-only MCP configuration recipe in Settings (createJsonView); the
  // legacy-modes JSON tokenizer is already bundled, so highlighting it adds no new dependency.
  json: () => StreamLanguage.define(json),
  // PHP uses the Lezer-based grammar (lang-php); emitted files open with `<?php`, so the
  // default mixed-mode config highlights them correctly.
  php: () => php(),
};

export const langExt = (lang: OutputLang): Extension => LANG_MODES[lang]?.() ?? [];

export interface OutputView {
  setContent(text: string, lang: OutputLang): void;
  /** Turn soft-wrap on/off so the generated-output pane honours the Word wrap setting too. */
  setLineWrap(on: boolean): void;
  destroy(): void;
}

/** A read-only, syntax-highlighted, line-numbered viewer for generated output. */
export function createOutputView(parent: HTMLElement, lineWrap = false): OutputView {
  const language = new Compartment();
  const wrap = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        EditorView.contentAttributes.of({ 'aria-label': 'Generated code preview (read-only)' }),
        wrap.of(lineWrap ? EditorView.lineWrapping : []),
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
    setLineWrap(on: boolean) {
      view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) });
    },
    destroy: () => view.destroy(),
  };
}

export interface ConfigView {
  setContent(text: string): void;
  getText(): string;
  destroy(): void;
}

/**
 * A compact, read-only JSON viewer for config snippets — the Settings → MCP recipe. Unlike
 * `createOutputView` it drops line numbers, search and selection-match decorations (it's a small
 * display/copy surface, not a code pane), but shares the same `koineHighlight` style so the JSON is
 * coloured from the existing `--koi-hl-*` theme tokens. `getText()` returns the document verbatim,
 * which is what the recipe's Copy button writes to the clipboard.
 */
export function createJsonView(parent: HTMLElement): ConfigView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        EditorView.contentAttributes.of({ 'aria-label': 'MCP client configuration snippet' }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        langExt('json'),
        syntaxHighlighting(koineHighlight),
        syntaxHighlighting(defaultHighlightStyle),
        sharedTheme,
      ],
    }),
  });

  return {
    setContent(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    getText: () => view.state.doc.toString(),
    destroy: () => view.destroy(),
  };
}
