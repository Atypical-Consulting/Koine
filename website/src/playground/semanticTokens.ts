// LSP semantic-token highlighting for the docs-site Playground editor (issue #367).
//
// The decode + legend are mirrored 1:1 from Koine Studio's proven implementation (#361,
// tooling/koine-studio/src/editor/editor.ts). The website/ and tooling/koine-studio/ are separate Vite
// build roots, so a cross-package import would resolve against the wrong root — the same reason
// koine.worker.ts is a sanctioned playground-local copy. The function is PURE and pinned by the
// wire-parity contract (the server legend is unit-tested against these constants in #361), so the copy
// can't silently drift. This module owns ONLY the decode → CodeMirror-decoration glue; the worker
// facade lives in koine.ts (`semanticTokens()`).

import { type Extension, StateEffect, type Text } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type { SemanticTokens } from './koine';

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

/**
 * Decode the `data` stream and build the CodeMirror mark-decoration set in one step — the exact path the
 * editor's ViewPlugin paints from. Exported (and DOM-free, since it never touches an EditorView) so the
 * decode → decoration pipeline can be unit-tested without a browser: an empty stream yields
 * `Decoration.none` (size 0), so the static grammar stays authoritative.
 */
export function buildSemanticDecorations(data: number[], doc: Text): DecorationSet {
  return semanticTokensToDecorations(decodeSemanticTokens(data, doc));
}

// Dispatched purely to make the semantic-tokens ViewPlugin re-evaluate its decorations once an async
// fetch resolves outside any transaction.
const semanticTokensRedrawEffect = StateEffect.define<null>();

// Each token-type class maps to a `--koi-hl-*` var from the playground palette (tokens.css) so semantic
// highlighting reads consistently with the static grammar; value/type reuses `--koi-hl-type`, keyword
// reuses `--koi-hl-keyword`, and enum / enumMember / property / parameter get their own `--koi-hl-sem-*`
// hues (distinct in both themes). `cm-st-declaration` (the only modifier) bolds the declaring occurrence.
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
 * provider for the document's semantic tokens, decodes the delta stream, and paints each as a mark
 * decoration with its token-type class. The first paint fetches immediately; edit-driven refetches are
 * DEBOUNCED (each fetch recompiles the document). When the stream is empty the plugin returns
 * `Decoration.none`, so the static StreamLanguage grammar stays in charge — graceful degradation, never
 * a cleared/overridden buffer. Stale async results are dropped via a per-request token. The redraw on
 * resolution rides a state effect (resolution is outside any txn).
 */
export function semanticTokensExtension(provider: SemanticTokensFn, debounceMs = 250): Extension {
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
        // An empty/absent stream decodes to [], which buildSemanticDecorations turns into
        // Decoration.none — so the static grammar highlighting stays authoritative (single source of
        // truth for the empty-stream contract; no separate early return needed).
        return buildSemanticDecorations(this.tokens?.data ?? [], view.state.doc);
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
