// Read-only output viewers (#986): the generated-code preview pane (createOutputView) and the compact
// MCP configuration snippet viewer (createJsonView). Both share the shared CodeMirror highlight/theme
// from ./cmTheme rather than importing them back from ./editor — that one-way dependency is what keeps
// the module graph a DAG (see the #986 plan's cycle note).
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { csharp, java, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { typescript } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { php } from '@codemirror/lang-php';
import { json as jsonLang } from '@codemirror/lang-json';
import { koineHighlight, sharedTheme } from '@/editor/cmTheme';

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
  // Java reuses the bundled clike legacy mode (same package as the C# mode above), so highlighting the
  // emitted `.java` files adds no new dependency.
  java: () => StreamLanguage.define(java),
  // Kotlin reuses the same clike legacy mode (which ships a `kotlin` tokenizer), so highlighting the
  // emitted `.kt` files adds no new dependency.
  kotlin: () => StreamLanguage.define(kotlin),
  // JSON powers the read-only MCP configuration recipe in Settings (createJsonView). It uses the
  // Lezer-based `@codemirror/lang-json` (the same grammar the editable settings.json editor uses),
  // NOT the legacy-modes JSON tokenizer: the legacy tokenizer marks object keys with the CM5-era
  // string token style `property`, which `@codemirror/language` can't map (the modern lezer tag is
  // `propertyName`) and so warns `Unknown highlighting tag property` once per session. The Lezer
  // grammar tags keys as `propertyName`, which `koineHighlight` colours directly — no warning.
  json: () => jsonLang(),
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
