import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { jsonSchema } from 'codemirror-json-schema';
import { createJsonSettingsEditor, settingsSchemaHover } from './editor';
import { SETTINGS_JSON_SCHEMA, settingsToJsonDoc } from '@/settings/settingsSchema';
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
});

// The hover/completion surfaces (#765) drive title/description from SETTINGS_JSON_SCHEMA. They can't be
// exercised through real mouse events in happy-dom (no layout → no posAtCoords), so we mount a view with
// the same schema-aware extensions the editor installs and invoke the source at an explicit offset — the
// document position is what the source resolves, exactly as a real hover would.
describe('settings.json schema hover (#765)', () => {
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
});
