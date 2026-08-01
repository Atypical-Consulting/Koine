// @vitest-environment happy-dom
// Task 2 of issue #481: the PRESENCE layer — remote participants' carets and selections painted into
// the local CodeMirror buffer.
//
// The decoration builder is exported and tested against a bare `Text`, with no live `EditorView`, so the
// position/colour/class mapping is pinned independently of the widget DOM (mirroring how
// reviewDecorations.test.ts reads its StateField straight off an EditorState). The view-level tests then
// cover the two things a builder can't: that a local selection change publishes an outbound frame, and
// that the extension attaches and detaches through a Compartment without rebuilding the view.
import { describe, expect, it, vi } from 'vitest';
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { buildPresenceDecorations, presenceExtension, setRemotePresence, presenceField } from './presence';
import type { CollabPresence } from '@/host/types';

//   offsets: 'value' 0..5, 'Money' 6..11, '\n' 11, line 1 starts at 12 ('  amount Int'), …
const DOC = 'value Money\n  amount Int\nenum Status\n';

function presence(id: string, cursor: number, selection: { from: number; to: number }[] = []): CollabPresence {
  return { participantId: id, displayName: id.toUpperCase(), color: `#${id}c01`, cursor, selection };
}

/** Flatten a DecorationSet to inspectable rows, sorted by position then class. */
function rows(set: DecorationSet): { from: number; to: number; cls?: string; widget: boolean; color?: string }[] {
  const out: { from: number; to: number; cls?: string; widget: boolean; color?: string }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: unknown; attributes?: Record<string, string> };
    out.push({
      from,
      to,
      cls: spec.class,
      widget: spec.widget !== undefined,
      color: spec.attributes?.style,
    });
  });
  return out.sort((a, b) => a.from - b.from || (a.widget ? 1 : 0) - (b.widget ? 1 : 0));
}

const doc = () => EditorState.create({ doc: DOC }).doc;

describe('buildPresenceDecorations', () => {
  it('places a caret widget at each remote cursor offset', () => {
    const set = buildPresenceDecorations([presence('ada', 6)], doc());
    const carets = rows(set).filter((r) => r.widget);
    expect(carets).toHaveLength(1);
    expect(carets[0].from).toBe(6);
    expect(carets[0].to).toBe(6); // zero-width: a caret must not consume a character cell
  });

  it('paints one selection mark per remote range, in that participant’s colour', () => {
    const set = buildPresenceDecorations([presence('ada', 11, [{ from: 6, to: 11 }])], doc());
    const marks = rows(set).filter((r) => !r.widget);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ from: 6, to: 11, cls: 'cm-presence-selection' });
    expect(marks[0].color).toContain('#adac01'); // the colour rides on the decoration, not a per-peer rule
  });

  it('renders every participant, keeping each one’s own colour', () => {
    const set = buildPresenceDecorations(
      [presence('ada', 0, [{ from: 0, to: 5 }]), presence('lin', 12, [{ from: 12, to: 18 }])],
      doc(),
    );
    const colors = rows(set)
      .filter((r) => !r.widget)
      .map((r) => r.color);
    expect(colors).toEqual([expect.stringContaining('#adac01'), expect.stringContaining('#linc01')]);
  });

  it('handles a bare caret with no selection (caret widget only, no marks)', () => {
    const set = buildPresenceDecorations([presence('ada', 3)], doc());
    expect(rows(set).filter((r) => !r.widget)).toEqual([]);
  });

  it('supports a multi-range (multi-cursor) remote selection', () => {
    const set = buildPresenceDecorations(
      [
        presence('ada', 18, [
          { from: 0, to: 5 },
          { from: 12, to: 18 },
        ]),
      ],
      doc(),
    );
    expect(rows(set).filter((r) => !r.widget)).toHaveLength(2);
  });

  // A presence frame is ephemeral and can arrive a beat behind the buffer it describes, so a stale
  // offset must be dropped or clamped — never handed to Decoration.mark, which throws on an empty or
  // inverted range, taking the whole editor down with it.
  it('drops a stale frame whose positions fall outside the document', () => {
    const past = DOC.length + 500;
    const set = buildPresenceDecorations([presence('ada', past, [{ from: past, to: past + 10 }])], doc());
    expect(rows(set)).toEqual([]);
  });

  it('clamps a selection that runs past the end of the document', () => {
    const set = buildPresenceDecorations([presence('ada', 5, [{ from: 6, to: DOC.length + 40 }])], doc());
    const marks = rows(set).filter((r) => !r.widget);
    expect(marks).toHaveLength(1);
    expect(marks[0].to).toBe(DOC.length);
  });

  it('skips a collapsed (zero-length) selection range rather than throwing', () => {
    expect(() => buildPresenceDecorations([presence('ada', 6, [{ from: 6, to: 6 }])], doc())).not.toThrow();
    const set = buildPresenceDecorations([presence('ada', 6, [{ from: 6, to: 6 }])], doc());
    expect(rows(set).filter((r) => !r.widget)).toEqual([]);
  });

  it('ignores an inverted range (from > to) instead of producing a bad decoration', () => {
    const set = buildPresenceDecorations([presence('ada', 6, [{ from: 11, to: 6 }])], doc());
    expect(rows(set).filter((r) => !r.widget)).toEqual([]);
  });

  it('yields nothing at all for an empty participant list', () => {
    expect(buildPresenceDecorations([], doc())).toBe(Decoration.none);
  });
});

/** A view over DOC with the presence extension installed, plus a spy on outbound frames.
 *  `allowMultipleSelections` is on because the real editor enables multi-cursor — without the facet
 *  CodeMirror silently collapses a multi-range selection to its main range, and the multi-cursor
 *  publish case below would be testing the default rather than the publisher. */
function viewWith(publish = vi.fn()) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [EditorState.allowMultipleSelections.of(true), presenceExtension({ publish })],
    }),
    parent,
  });
  return { view, publish, cleanup: () => { view.destroy(); parent.remove(); } };
}

describe('presence field and remote updates', () => {
  it('setRemotePresence puts the entries in the field, and they render as decorations', () => {
    const { view, cleanup } = viewWith();
    setRemotePresence(view, [presence('ada', 6, [{ from: 0, to: 5 }])]);

    expect(rows(view.state.field(presenceField))).toHaveLength(2); // one mark + one caret
    cleanup();
  });

  it('a later frame REPLACES the previous set rather than accumulating stale carets', () => {
    const { view, cleanup } = viewWith();
    setRemotePresence(view, [presence('ada', 6), presence('lin', 12)]);
    setRemotePresence(view, [presence('ada', 8)]); // lin left / went quiet

    const carets = rows(view.state.field(presenceField)).filter((r) => r.widget);
    expect(carets).toHaveLength(1);
    expect(carets[0].from).toBe(8);
    cleanup();
  });

  it('maps remote positions through a local edit so a caret does not drift until the next frame', () => {
    const { view, cleanup } = viewWith();
    setRemotePresence(view, [presence('ada', 12)]);
    view.dispatch({ changes: { from: 0, insert: 'XXX' } }); // 3 chars before the remote caret

    const carets = rows(view.state.field(presenceField)).filter((r) => r.widget);
    expect(carets[0].from).toBe(15);
    cleanup();
  });

  it('drops presence entirely when handed an empty set (everyone left)', () => {
    const { view, cleanup } = viewWith();
    setRemotePresence(view, [presence('ada', 6)]);
    setRemotePresence(view, []);
    expect(rows(view.state.field(presenceField))).toEqual([]);
    cleanup();
  });
});

describe('outbound local presence', () => {
  it('publishes the local caret and selection whenever the selection changes', () => {
    const { view, publish, cleanup } = viewWith();
    view.dispatch({ selection: EditorSelection.single(6, 11) });

    expect(publish).toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0]).toEqual({ cursor: 11, selection: [{ from: 6, to: 11 }] });
    cleanup();
  });

  it('publishes a bare caret with an empty selection list', () => {
    const { view, publish, cleanup } = viewWith();
    view.dispatch({ selection: EditorSelection.cursor(3) });

    expect(publish.mock.calls.at(-1)?.[0]).toEqual({ cursor: 3, selection: [] });
    cleanup();
  });

  it('publishes every range of a multi-cursor local selection', () => {
    const { view, publish, cleanup } = viewWith();
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(12, 18)], 1),
    });

    expect(publish.mock.calls.at(-1)?.[0]).toEqual({
      cursor: 18,
      selection: [
        { from: 0, to: 5 },
        { from: 12, to: 18 },
      ],
    });
    cleanup();
  });

  // An inbound frame must not bounce straight back out as an outbound one — that is the presence-layer
  // shape of the echo loop the CRDT binding has to avoid too.
  it('does NOT publish in response to an inbound remote presence frame', () => {
    const { view, publish, cleanup } = viewWith();
    publish.mockClear();
    setRemotePresence(view, [presence('ada', 6)]);
    expect(publish).not.toHaveBeenCalled();
    cleanup();
  });

  it('works with no publish callback at all (presence is receive-only)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [presenceExtension()] }),
      parent,
    });
    expect(() => view.dispatch({ selection: EditorSelection.cursor(4) })).not.toThrow();
    view.destroy();
    parent.remove();
  });
});

describe('attach / detach through a Compartment', () => {
  it('attaches and detaches without rebuilding the view or losing the document', () => {
    const compartment = new Compartment();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [compartment.of([])] }),
      parent,
    });
    const identity = view; // the same EditorView must survive both reconfigurations

    // attach
    view.dispatch({ effects: compartment.reconfigure(presenceExtension()) });
    setRemotePresence(view, [presence('ada', 6)]);
    expect(rows(view.state.field(presenceField))).toHaveLength(1);

    // detach
    view.dispatch({ effects: compartment.reconfigure([]) });
    expect(view.state.field(presenceField, false)).toBeUndefined(); // field gone with the extension
    expect(view).toBe(identity);
    expect(view.state.doc.toString()).toBe(DOC); // no state loss across either reconfigure

    view.destroy();
    parent.remove();
  });
});
