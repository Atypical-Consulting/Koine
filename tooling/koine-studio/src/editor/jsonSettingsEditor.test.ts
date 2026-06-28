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
