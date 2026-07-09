import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';
import { CompletionContext } from '@codemirror/autocomplete';
import { jsonSchema, getJSONSchema } from 'codemirror-json-schema';
import { createJsonSettingsEditor, settingsSchemaHover, settingsCompletionSource } from './editor';
import { SETTINGS_JSON_SCHEMA, WORKSPACE_SETTINGS_JSON_SCHEMA, settingsToJsonDoc } from '@/settings/settingsSchema';
import { DEFAULT_SETTINGS } from '@/settings/persistence';

describe('createJsonSettingsEditor', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('mounts an editable CodeMirror instance seeded with the initial text', () => {
    const ed = createJsonSettingsEditor(host, { onChange: () => {}, initial: '{\n  "theme": "dark"\n}' });
    expect(ed.getText()).toContain('"theme": "dark"');
    expect(host.querySelector('.cm-editor')).not.toBeNull();
    expect(host.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');
    ed.destroy();
  });

  it('fires onChange with the new document text when edited', () => {
    const onChange = vi.fn();
    const ed = createJsonSettingsEditor(host, { onChange, initial: '{}' });
    ed.setContent('{ "fontSize": 14 }');
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('fontSize');
    ed.destroy();
  });

  it('destroy removes the editor from the DOM', () => {
    const ed = createJsonSettingsEditor(host, { onChange: () => {} });
    ed.destroy();
    expect(host.querySelector('.cm-editor')).toBeNull();
  });

  // The content element carries the distinctive aria-label; setInvalid mutates the field-level
  // invalid/error relationship on that same element.
  const content = (h: HTMLElement): HTMLElement =>
    h.querySelector<HTMLElement>('[aria-label="Settings JSON document"]')!;

  it('setInvalid(id) marks the content aria-invalid and points aria-errormessage at the id', () => {
    const ed = createJsonSettingsEditor(host, { onChange: () => {}, initial: '{}' });
    ed.setInvalid('settings-json-diagnostics');
    const cm = content(host);
    expect(cm.getAttribute('aria-invalid')).toBe('true');
    expect(cm.getAttribute('aria-errormessage')).toBe('settings-json-diagnostics');
    // The name is preserved alongside the new state.
    expect(cm.getAttribute('aria-label')).toBe('Settings JSON document');
    ed.destroy();
  });

  it('setInvalid(null) clears aria-invalid and aria-errormessage, keeping the aria-label', () => {
    const ed = createJsonSettingsEditor(host, { onChange: () => {}, initial: '{}' });
    ed.setInvalid('settings-json-diagnostics');
    ed.setInvalid(null);
    const cm = content(host);
    expect(cm.hasAttribute('aria-invalid')).toBe(false);
    expect(cm.hasAttribute('aria-errormessage')).toBe(false);
    expect(cm.getAttribute('aria-label')).toBe('Settings JSON document');
    ed.destroy();
  });

  it('repeated invalid → valid → invalid toggles leave no attribute residue', () => {
    const ed = createJsonSettingsEditor(host, { onChange: () => {}, initial: '{}' });
    ed.setInvalid('first-id');
    ed.setInvalid(null);
    ed.setInvalid('second-id');
    const cm = content(host);
    expect(cm.getAttribute('aria-invalid')).toBe('true');
    // No residue from the first id — the compartment fully replaced its contents.
    expect(cm.getAttribute('aria-errormessage')).toBe('second-id');
    ed.setInvalid(null);
    expect(cm.hasAttribute('aria-invalid')).toBe(false);
    expect(cm.hasAttribute('aria-errormessage')).toBe(false);
    ed.destroy();
  });

  // Fix 2: setSchema swaps the active inline JSON schema (scope User ↔ Workspace toggle).
  it('setSchema swaps the active JSON schema in the editor state', () => {
    // Create with the flat Workspace schema.
    const ed = createJsonSettingsEditor(host, {
      onChange: () => {},
      initial: '{}',
      schema: WORKSPACE_SETTINGS_JSON_SCHEMA,
    });
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
    // Initial schema in state matches what was passed.
    expect(getJSONSchema(view.state)).toBe(WORKSPACE_SETTINGS_JSON_SCHEMA);
    // Swap to the full user schema.
    ed.setSchema(SETTINGS_JSON_SCHEMA);
    expect(getJSONSchema(view.state)).toBe(SETTINGS_JSON_SCHEMA);
    ed.destroy();
  });
});

// The hover/completion surfaces (#765) drive title/description from SETTINGS_JSON_SCHEMA. They can't be
// exercised through real mouse events in happy-dom (no layout → no posAtCoords), so we mount a view with
// the same schema-aware extensions the editor installs and invoke the source at an explicit offset — the
// document position is what the source resolves, exactly as a real hover would.
describe('settings.json schema hover + completion (#765)', () => {
  const views: EditorView[] = [];
  const mount = (doc: string): EditorView => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [jsonSchema(SETTINGS_JSON_SCHEMA as unknown as Parameters<typeof jsonSchema>[0])],
      }),
    });
    views.push(view);
    // `jsonPointerForPosition` (which both settingsSchemaHover and settingsCompletionSource resolve
    // through) reads `syntaxTree(state)` — CodeMirror's NON-blocking accessor, which only returns
    // whatever the language's incremental Lezer parse has completed SO FAR. A fresh EditorState only
    // guarantees the first `Work.Apply` (20ms) budget of parsing before yielding the rest to a
    // background `requestIdleCallback`-style continuation (@codemirror/language's `parseWorker`,
    // gated behind a 100ms+ setTimeout) — a budget a real hover clears easily (the user has to move the
    // mouse and dwell first) but that a synchronous call immediately after `mount()` can race under
    // CPU contention (e.g. the full suite's ~200 files sharing the machine), returning a still-partial
    // tree and an empty/short JSON pointer. `forceParsing` (also from @codemirror/language) blocks
    // until the tree is complete and dispatches the resulting state onto the view, so every caller of
    // `mount()` sees a fully-parsed document — deterministic regardless of what else is running.
    forceParsing(view, view.state.doc.length);
    return view;
  };
  afterEach(() => {
    while (views.length) views.pop()!.destroy();
    document.body.innerHTML = '';
  });

  it('a hover over a field key surfaces its schema title + description', async () => {
    const doc = settingsToJsonDoc(DEFAULT_SETTINGS);
    const view = mount(doc);
    const pos = doc.indexOf('"tabSize"') + 3; // inside the `tabSize` key
    const tip = await settingsSchemaHover(view, pos, 1);
    expect(tip).not.toBeNull();
    const dom = tip!.create(view).dom as HTMLElement;
    expect(dom.className).toContain('koi-hover');
    // The title (which the bundled extension never surfaces) and the description both reach the user.
    expect(dom.textContent).toContain('Tab size');
    expect(dom.textContent).toContain('Indent width in spaces.');
    expect(dom.querySelector('strong')?.textContent).toBe('Tab size'); // title rendered bold
  });

  it('degrades silently (no tooltip) on a group key, the root, and an unknown key', async () => {
    const doc = settingsToJsonDoc(DEFAULT_SETTINGS);
    const view = mount(doc);
    expect(await settingsSchemaHover(view, doc.indexOf('"editor"') + 3, 1)).toBeNull(); // group key
    expect(await settingsSchemaHover(view, 1, 1)).toBeNull(); // document root

    const typo = mount('{\n  "editor": {\n    "tabSiz": 2\n  }\n}');
    expect(await settingsSchemaHover(typo, '{\n  "editor": {\n    "tabSiz'.length - 2, 1)).toBeNull();
  });

  it('a completion inside a group carries the field title as detail + description as info', async () => {
    const doc = '{\n  "editor": {\n    "tab"\n  }\n}';
    const view = mount(doc);
    const caret = doc.indexOf('"tab"') + 4; // inside the partial key
    const result = await settingsCompletionSource(new CompletionContext(view.state, caret, true));
    expect(result).not.toBeNull();
    const opt = result!.options.find((o) => o.label === 'tabSize');
    expect(opt, 'tabSize completion offered').toBeDefined();
    // The bundled source puts the JSON type ("integer") in detail; we overlay the human-readable title.
    expect(opt!.detail).toBe('Tab size');
    // The description is still carried as the info panel (unchanged from the bundled source).
    const infoEl = typeof opt!.info === 'function' ? await opt!.info(opt!) : opt!.info;
    const infoText =
      infoEl && typeof infoEl === 'object' && 'textContent' in infoEl
        ? (infoEl as HTMLElement).textContent
        : String(infoEl);
    expect(infoText).toContain('Indent width in spaces.');
  });
});
