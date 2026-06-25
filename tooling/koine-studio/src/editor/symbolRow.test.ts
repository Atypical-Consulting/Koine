// @vitest-environment happy-dom
// The focus-gated DSL symbol accessory row (mobile, #221). `insertToken` drops a Koine token at the
// caret of a real CM6 EditorView; `mountSymbolRow` renders a role="toolbar" strip of token buttons
// whose taps insert without stealing editor focus (mousedown is preventDefault'd). The @codemirror/*
// packages construct fine under happy-dom (see multiCursor.test.ts), so these tests drive a real view.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { EditorView } from '@codemirror/view';
import { insertToken, mountSymbolRow } from '@/editor/symbolRow';

const views: EditorView[] = [];

function makeView(doc = ''): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ doc, parent });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('insertToken', () => {
  it('inserts the token at the caret and advances the caret past it', () => {
    const view = makeView('value');
    view.dispatch({ selection: { anchor: 2 } }); // caret between "va" and "lue"
    insertToken(view, '->');
    expect(view.state.doc.toString()).toBe('va->lue');
    expect(view.state.selection.main.head).toBe(4); // 2 + '->'.length
    expect(view.state.selection.main.empty).toBe(true); // collapsed caret, not a selection
  });

  it('replaces the current selection with the token', () => {
    const view = makeView('value');
    view.dispatch({ selection: { anchor: 0, head: 5 } }); // select all of "value"
    insertToken(view, '->');
    expect(view.state.doc.toString()).toBe('->');
    expect(view.state.selection.main.head).toBe(2);
  });
});

describe('mountSymbolRow', () => {
  it('renders a role="toolbar" strip of aria-labelled token buttons', () => {
    const view = makeView('');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountSymbolRow(view, host);

    const toolbar = host.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();
    const buttons = Array.from(toolbar!.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    // Every button carries an accessible name (the symbol glyph alone is not descriptive).
    for (const b of buttons) expect(b.getAttribute('aria-label')).toBeTruthy();
    // The full DSL token set is offered — the GLYPH lives in textContent (data-token is an
    // attribute-safe slug, never the raw glyph). textContent is the user-visible insert literal.
    const glyphs = buttons.map((b) => b.textContent);
    for (const tok of ['->', '=>', ':', '{', '}', '«', '»', '/', '@', '|', '(', ')', '"']) {
      expect(glyphs).toContain(tok);
    }
  });

  it('inserts the token at the caret when its button is tapped', () => {
    const view = makeView('');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountSymbolRow(view, host);

    const arrow = host.querySelector<HTMLButtonElement>('button[data-token="arrow"]')!;
    fireEvent.click(arrow);
    expect(view.state.doc.toString()).toBe('->');
    expect(view.state.selection.main.head).toBe(2);
  });

  it('preventDefaults mousedown so the editor keeps focus on tap', () => {
    const view = makeView('');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountSymbolRow(view, host);

    const arrow = host.querySelector<HTMLButtonElement>('button[data-token="arrow"]')!;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    arrow.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('destroy() removes the toolbar from the host', () => {
    const view = makeView('');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountSymbolRow(view, host);
    expect(host.querySelector('[role="toolbar"]')).not.toBeNull();
    handle.destroy();
    expect(host.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const view = makeView('');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountSymbolRow(view, host);
    expect(await axe(host)).toHaveNoViolations();
  });
});
