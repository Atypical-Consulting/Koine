// Shared CodeMirror 6 highlight style + base theme (#986). Every editor factory in this directory —
// the editable .koi editor (editor.ts), the read-only output/JSON viewers (outputView.ts), and the
// editable settings.json editor (settingsJsonEditor.ts) — paints with the same `koineHighlight`
// syntax colours and the same `sharedTheme` chrome, so this tiny leaf is what those sibling modules
// depend on instead of each other (keeps the module graph a DAG — see the #986 plan's cycle note).
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const koineHighlight = HighlightStyle.define([
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
  // Literal atoms — true/false/null. Chiefly the JSON views (the settings.json editor + the read-only
  // MCP recipe snippet) which share this style: without these, those tokens fall through to CodeMirror's
  // light-oriented defaultHighlightStyle, whose near-navy renders at ~1.4:1 on the dark editor (fails AA).
  // A theme-aware keyword colour keeps them legible in both themes.
  { tag: t.bool, color: 'var(--koi-hl-keyword)' },
  { tag: t.null, color: 'var(--koi-hl-keyword)' },
  { tag: t.atom, color: 'var(--koi-hl-keyword)' },
]);

export const sharedTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--koi-editor-font-size, 13.5px)' },
  // The editor font stack comes from Settings → Appearance → Editor font (#750) via the
  // --koi-editor-font-family CSS var, falling back to the theme's default mono font when unset.
  '.cm-scroller': {
    fontFamily: 'var(--koi-editor-font-family, var(--koi-font-mono))',
    lineHeight: 'var(--koi-editor-line-height, 1.6)',
  },
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
