// LSP-backed CodeMirror 6 extensions (#986): hover tooltips, the LSP completion source, inlay hints,
// and semantic-token highlighting, plus the provider function types `createKoineEditor` accepts for
// definition/rename/references/code-actions/call-hierarchy. `koineHoverTooltip` and
// `lspCompletionSource` are exported for `./editor`'s createKoineEditor wiring only — they are NOT part
// of the `@/editor/editor` facade's public re-export surface (they were never public before the split).
import { StateEffect, Prec, type Extension, type Text } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  type Tooltip,
} from '@codemirror/view';
import { type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CompletionItem,
  HoverResult,
  InlayHint,
  Location,
  MarkedString,
  PrepareRenameResult,
  Range as LspRange,
  SemanticTokens,
  TextEdit,
  WorkspaceEdit,
} from '@/lsp/lsp';
// Concept Colors (ADR 0004): the ordered concept-kind slugs, indexed by LSP modifier bit (bit i+1 ⇒
// CONCEPT_SLUGS[i]). Generated from design/concept-colors.json — the code editor paints a kind-tagged
// identifier with its concept color (`--koi-ddd-<slug>`), matching the explorer and canvas.
import { CONCEPT_SLUGS } from '@/model/conceptColors.generated';
// renderMarkdown lives in ./markdown, never re-imported from ./editor (the facade) — that one-way
// dependency is what keeps the module graph a DAG (see the #986 plan's cycle note).
import { renderMarkdown } from '@/editor/markdown';
// LSP↔offset converters live in ./positions (pure, tested over a CodeMirror `Text`); call them with
// `view.state.doc`.
import { lspPosToOffset } from '@/editor/positions';

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
export function lspCompletionSource(onCompletion: CompletionFn) {
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
export function koineHoverTooltip(hover: HoverFn) {
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
        // clamped offset during the debounce window before the fresh fetch lands. Bump the token
        // too: an in-flight answer describes the PRE-edit doc, so resolving its positions against
        // the new doc would paint shifted hints — drop it and let the debounced refetch repaint.
        if (u.docChanged) {
          this.seq++;
          this.decorations = this.decorations.map(u.changes);
        }
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

/**
 * The concept-kind slug carried by a token's modifier bits, or `null` (Concept Colors, ADR 0004).
 * Bits 1–15 are DDD concept kinds: bit `i+1` ⇒ {@link CONCEPT_SLUGS}`[i]`. A token carries at most one
 * kind bit; an out-of-range/unknown bit maps to no slug (defensive — matches the WASM/website mirrors).
 */
function conceptKindSlug(modifiers: number): (typeof CONCEPT_SLUGS)[number] | null {
  for (let i = 0; i < CONCEPT_SLUGS.length; i++) {
    if ((modifiers & (1 << (i + 1))) !== 0) return CONCEPT_SLUGS[i];
  }
  return null;
}

/** One decoded semantic token, resolved to absolute CodeMirror document offsets and a CSS class. */
export interface DecodedSemanticToken {
  from: number;
  to: number;
  /**
   * Space-separated CSS class(es): `cm-st-<type>`, plus `cm-st-declaration` when the declaration bit is
   * set, plus `cm-st-k-<slug>` when the token carries a concept-kind bit (Concept Colors). The kind
   * class is themed last so its concept color wins over the base type color.
   */
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

    let cls = `cm-st-${typeName}`;
    if ((modifiers & SEMANTIC_MODIFIER_DECLARATION) !== 0) cls += ' cm-st-declaration';
    const kind = conceptKindSlug(modifiers);
    if (kind !== null) cls += ` cm-st-k-${kind}`;
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
// other and from value/type. `cm-st-declaration` bolds the declaring occurrence.
//
// Concept Colors (ADR 0004): a kind-tagged identifier also gets `cm-st-k-<slug>`, painting it in its
// DDD concept color (`--koi-ddd-<slug>`) so `PaymentMethod` is the same amber in explorer, canvas, and
// code. These rules are declared AFTER the base `cm-st-*` rules so — at equal specificity — the concept
// color wins over the base type/enum color (this is what retires the ad-hoc `--koi-hl-sem-enum` hue for
// kind-tagged enum identifiers). Structure (keyword/property/parameter/punctuation) stays neutral.
const semanticTokenTheme = EditorView.baseTheme({
  '.cm-st-type': { color: 'var(--koi-hl-type)' },
  '.cm-st-enum': { color: 'var(--koi-hl-sem-enum)' },
  '.cm-st-enumMember': { color: 'var(--koi-hl-sem-enum-member)' },
  '.cm-st-property': { color: 'var(--koi-hl-sem-property)' },
  '.cm-st-keyword': { color: 'var(--koi-hl-keyword)', fontWeight: '600' },
  '.cm-st-parameter': { color: 'var(--koi-hl-sem-parameter)', fontStyle: 'italic' },
  '.cm-st-declaration': { fontWeight: '600' },
  // Concept-kind color rules, generated from CONCEPT_SLUGS — kept last so kind wins the color.
  ...Object.fromEntries(CONCEPT_SLUGS.map((slug) => [`.cm-st-k-${slug}`, { color: `var(--koi-ddd-${slug})` }])),
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
        // Bump the token too: an in-flight answer's delta stream describes the PRE-edit doc, so decoding
        // it against the new doc would paint shifted marks — drop it and let the debounced refetch repaint.
        if (u.docChanged) {
          this.seq++;
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
  // Prec.highest is load-bearing: @codemirror/language registers its syntax highlighter at Prec.high
  // (treeHighlighter), and when two mark decorations overlap the HIGHER-precedence one nests
  // *innermost* — the inner element's `color` is what paints. At default precedence our semantic mark
  // ends up the OUTER span, so the grammar's inner `.ͼ…` span overrides every semantic/concept color
  // (identifiers render in the grammar's type hue, so enum amber / concept colors never showed).
  // Raising the plugin above Prec.high makes the semantic span innermost, so its color wins.
  return [Prec.highest(plugin), semanticTokenTheme];
}

// --- LSP provider function types ---------------------------------------------

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
