import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { inlayHintsExtension, type InlayHintsFn } from './editor';
import type { InlayHint } from '@/lsp/lsp';

// CodeMirror glue test for the inlay-hint extension, driven against a REAL EditorView (the @codemirror/*
// packages construct fine under happy-dom — see inlineCompletion.test.ts / actions.test.ts). The async
// provider's resolution happens outside any transaction, so the plugin dispatches a redraw effect; we
// await a microtask flush then assert the widget(s) rendered.
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeView(provider: InlayHintsFn): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: 'value Money\n  amount\n',
      extensions: [inlayHintsExtension(provider)],
    }),
  });
}

const widgets = (view: EditorView) => Array.from(view.dom.querySelectorAll('.cm-inlay-hint'));

describe('inlay-hints editor extension', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders each resolved hint as a dimmed inline widget with its label', async () => {
    const hints: InlayHint[] = [
      { position: { line: 0, character: 11 }, label: ': Money', kind: 1 },
      { position: { line: 1, character: 8 }, label: ': Decimal', kind: 1 },
    ];
    const view = makeView(() => Promise.resolve(hints));
    expect(widgets(view)).toHaveLength(0); // nothing before the async fetch resolves
    await flush();
    const labels = widgets(view).map((w) => w.textContent);
    expect(labels).toEqual([': Money', ': Decimal']);
    view.destroy();
  });

  it('renders nothing when the provider returns no hints', async () => {
    const view = makeView(() => Promise.resolve([]));
    await flush();
    expect(widgets(view)).toHaveLength(0);
    view.destroy();
  });

  it('survives a provider rejection (leaves the editor without hints, no throw)', async () => {
    const view = makeView(() => Promise.reject(new Error('boom')));
    await flush();
    expect(widgets(view)).toHaveLength(0);
    view.destroy();
  });

  it('ignores a stale fetch resolving after a newer one (the latest hints win)', async () => {
    // First fetch resolves slowly with stale hints; a doc edit triggers a second, fast fetch.
    let call = 0;
    const provider: InlayHintsFn = () => {
      call++;
      return call === 1
        ? new Promise((r) => setTimeout(() => r([{ position: { line: 0, character: 0 }, label: 'STALE', kind: 1 }]), 30))
        : Promise.resolve([{ position: { line: 0, character: 0 }, label: 'FRESH', kind: 1 }]);
    };
    const view = makeView(provider);
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n' } }); // triggers fetch #2
    await new Promise((r) => setTimeout(r, 50)); // let the stale (slow) fetch resolve too
    const labels = widgets(view).map((w) => w.textContent);
    expect(labels).toContain('FRESH');
    expect(labels).not.toContain('STALE');
    view.destroy();
  });
});
