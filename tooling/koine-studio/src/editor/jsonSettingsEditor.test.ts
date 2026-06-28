import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJsonSettingsEditor } from './editor';

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
});
