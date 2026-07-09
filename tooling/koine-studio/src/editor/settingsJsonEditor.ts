// The editable settings.json editor (#986): schema-aware JSON editing for Settings' raw-JSON view. We
// use the SAME pieces codemirror-json-schema's bundled `jsonSchema()` wires (JSON language +
// JSON-parse/schema linters + schema-aware completion + hover + schema-in-state), but compose them
// ourselves so we can swap in our own hover/completion sources — the bundled ones surface a field's
// schema `description` but drop its `title`, and the bundled helper exposes no hook to add it (#765).
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, hoverTooltip, type Tooltip } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import { json as cmJson, jsonLanguage, jsonParseLinter } from '@codemirror/lang-json';
import {
  jsonSchemaLinter,
  jsonCompletion,
  handleRefresh,
  stateExtensions,
  updateSchema,
  jsonPointerForPosition,
} from 'codemirror-json-schema';
// The Draft 2020-12 schema for the settings.json document — drives the editable editor's lint/hover/completion.
import { SETTINGS_JSON_SCHEMA, settingsFieldMeta } from '@/settings/settingsSchema';
// renderMarkdown lives in ./markdown, never re-imported from ./editor (the facade) — that one-way
// dependency is what keeps the module graph a DAG (see the #986 plan's cycle note).
import { renderMarkdown } from '@/editor/markdown';
import { koineHighlight, sharedTheme } from '@/editor/cmTheme';

export interface JsonSettingsEditor {
  setContent(text: string): void;
  getText(): string;
  /**
   * Drive the field-level WCAG AA invalid/error relationship on the editor content. With a non-null
   * `diagnosticsId` the content gains `aria-invalid="true"` + `aria-errormessage=<id>` (alongside its
   * aria-label); with `null` both are cleared, leaving just the aria-label. The host (settingsPage) calls
   * this from its validate path so a screen-reader user re-entering an invalid document is told it is
   * invalid and pointed at the diagnostics strip — unlike the one-shot `role="alert"` announcement.
   */
  setInvalid(diagnosticsId: string | null): void;
  /**
   * Swap the active inline JSON schema (lint/completion/hover) without rebuilding the editor. Call when
   * the settings scope switches between User (full grouped schema) and Workspace (flat overrides schema)
   * so the inline linter/completions stay aligned with the document being edited.
   */
  setSchema(schema: Record<string, unknown>): void;
  destroy(): void;
}

/**
 * Hover tooltip for the editable settings.json editor: resolves the field under the cursor via the
 * schema's JSON pointer and renders its `title` + `description` (from {@link settingsFieldMeta}) using
 * the `.koi` editor's `koi-hover koi-md` styling. codemirror-json-schema's bundled hover surfaces only
 * the `description`; this adds the human-readable title (#765). Degrades silently (returns null) for a
 * group key, the document root, or an unknown/typo'd key. Exported for unit testing.
 */
export const settingsSchemaHover = (view: EditorView, pos: number, side: -1 | 1): Tooltip | null => {
  // 'json4' is codemirror-json-schema's MODES.JSON token (not re-exported): selects JSON (vs json5/yaml)
  // pointer resolution. The pointer is '' at the root, '/group' on a group key, '/group/docKey' on a leaf.
  const pointer = jsonPointerForPosition(view.state, pos, side, 'json4');
  const [group, docKey, ...rest] = pointer.split('/').filter(Boolean);
  if (!group || !docKey || rest.length > 0) return null; // only leaf fields get a tooltip
  const meta = settingsFieldMeta(group, docKey);
  if (!meta) return null; // unknown/typo'd key — show nothing
  const word = view.state.wordAt(pos);
  return {
    pos: word?.from ?? pos,
    end: word?.to ?? pos,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'koi-hover koi-md';
      dom.innerHTML = renderMarkdown(`**${meta.title}**\n\n${meta.description}`);
      return { dom };
    },
  };
};

// codemirror-json-schema's property completion: built once, reused per request (it reads the schema
// from the editor state, not from this closure).
const baseJsonCompletion = jsonCompletion();

/**
 * Completion source for the editable settings.json editor: delegates to codemirror-json-schema's
 * property completion, then overlays each field's schema `title` onto the option `detail`. The bundled
 * source puts the JSON type there and carries the `description` only as the info panel, so the
 * human-readable name was never visible in the picker (#765). Exported for unit testing.
 */
export const settingsCompletionSource = (ctx: CompletionContext): CompletionResult | null => {
  const result = baseJsonCompletion(ctx);
  if (!result || Array.isArray(result) || !('options' in result)) return null; // never[] → no completions
  // The group the cursor sits in (`/editor/ta` → `editor`); option labels are that group's doc keys.
  const [group] = jsonPointerForPosition(ctx.state, ctx.pos, -1, 'json4').split('/').filter(Boolean);
  if (!group) return result;
  const options = result.options.map((o) => {
    const meta = settingsFieldMeta(group, String(o.label));
    return meta?.title ? { ...o, detail: meta.title } : o;
  });
  return { ...result, options };
};

/**
 * The schema-aware extensions for the editable settings.json editor. Mirrors codemirror-json-schema's
 * bundled `jsonSchema()` (JSON language + JSON-parse/schema linters + schema-aware completion + hover +
 * schema-in-state) but swaps in {@link settingsSchemaHover} and {@link settingsCompletionSource} so the
 * per-field `title` reaches the user — the only behavioural change is the hover/completion content; the
 * lint surface is preserved exactly (#765).
 */
function settingsSchemaExtensions(schema: Parameters<typeof stateExtensions>[0]): Extension[] {
  return [
    cmJson(),
    linter(jsonParseLinter()),
    linter(jsonSchemaLinter(), { needsRefresh: handleRefresh }),
    jsonLanguage.data.of({ autocomplete: settingsCompletionSource }),
    hoverTooltip(settingsSchemaHover),
    stateExtensions(schema),
  ];
}

/**
 * An EDITABLE settings.json editor: the JSON language plus schema-driven lint/completion/hover from
 * SETTINGS_JSON_SCHEMA (via {@link settingsSchemaExtensions}, our composition of codemirror-json-schema's
 * pieces), reporting every document change through `onChange`. It reuses the same `koineHighlight` +
 * `sharedTheme` setup as the other editors so it looks native. The host (settingsPage) owns
 * parse/validate/persist; this factory is just the editing surface.
 */
export function createJsonSettingsEditor(
  parent: HTMLElement,
  opts: { onChange: (text: string) => void; initial?: string; schema?: Record<string, unknown> },
): JsonSettingsEditor {
  // The content's ARIA name. Kept aside so both the initial config and every setInvalid reconfigure
  // re-apply it (a reconfigure REPLACES the compartment's contents, so the name must be re-listed).
  const ariaLabel = { 'aria-label': 'Settings JSON document' };
  // The content attributes live in their own compartment so setInvalid can toggle the field-level
  // invalid/error relationship without rebuilding the editor (same pattern as the .koi editor's
  // lineWrap/minimap compartments). Initially: just the aria-label, no invalid state.
  const contentAttributes = new Compartment();
  // The active JSON schema, seeded from opts.schema (or the full user schema when not given).
  const activeSchema = opts.schema ?? SETTINGS_JSON_SCHEMA;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.initial ?? '',
      extensions: [
        contentAttributes.of(EditorView.contentAttributes.of({ ...ariaLabel })),
        lineNumbers(),
        // The JSON language, JSON-parse + schema linters, schema-aware completion and our title-aware
        // hover — the whole schema-aware editing surface, composed so the hover can surface field titles.
        ...settingsSchemaExtensions(activeSchema as unknown as Parameters<typeof stateExtensions>[0]),
        syntaxHighlighting(koineHighlight),
        syntaxHighlighting(defaultHighlightStyle),
        sharedTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    setContent(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    getText: () => view.state.doc.toString(),
    setInvalid(diagnosticsId) {
      // Fully replace the compartment's contents each call so toggling leaves no attribute residue:
      // invalid → aria-label + aria-invalid + aria-errormessage; valid → aria-label only.
      const attrs =
        diagnosticsId != null
          ? { ...ariaLabel, 'aria-invalid': 'true', 'aria-errormessage': diagnosticsId }
          : { ...ariaLabel };
      view.dispatch({ effects: contentAttributes.reconfigure(EditorView.contentAttributes.of(attrs)) });
    },
    setSchema(schema) {
      updateSchema(view, schema as unknown as Parameters<typeof stateExtensions>[0]);
    },
    destroy: () => view.destroy(),
  };
}
