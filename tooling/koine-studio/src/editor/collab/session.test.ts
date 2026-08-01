// @vitest-environment happy-dom
// Task 4 of issue #481: the SESSION — the piece that turns a transport (Task 1), a presence layer
// (Task 2) and a CRDT binding (Task 3) into "two people are editing this model together".
//
// These specs run two real sessions against the in-memory reference broker and two real editors, so
// every assertion here is end-to-end within one realm: create → join → live edits → leave. The broker is
// the executable spec the Rust sidecar has to match (#481 Task 5), which is exactly why the session is
// pinned against it rather than against a hand-rolled transport double.
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createKoineEditor, type KoineEditor } from '@/editor/editor';
import { createInMemoryCollabBroker } from '@/host/collabTransport';
import { presenceField } from '@/editor/presence';
import { createCollabSession, type CollabSession } from '@/editor/collab/session';
import type { CollabParticipant, CollabPresence } from '@/host/types';
import { EditorSelection } from '@codemirror/state';

const ADA: CollabParticipant = { id: 'ada', displayName: 'Ada', color: '#e8637c' };
const GRACE: CollabParticipant = { id: 'grace', displayName: 'Grace', color: '#54b8a0' };

const editors: KoineEditor[] = [];
const sessions: CollabSession[] = [];

function editor(doc: string): KoineEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const ed = createKoineEditor({ parent, doc });
  editors.push(ed);
  return ed;
}

afterEach(async () => {
  while (sessions.length) await sessions.pop()?.leave();
  while (editors.length) editors.pop()?.destroy();
  document.body.innerHTML = '';
});

/** One broker, two participants, each with their own editor and session. */
function pair(authorityDoc = 'context Sales {}\n', joinerDoc = 'scratch buffer\n') {
  const broker = createInMemoryCollabBroker();
  const host = { editor: editor(authorityDoc), transport: broker.createTransport() };
  const guest = { editor: editor(joinerDoc), transport: broker.createTransport() };
  const hostSession = createCollabSession({ transport: host.transport, identity: ADA, editor: host.editor });
  const guestSession = createCollabSession({ transport: guest.transport, identity: GRACE, editor: guest.editor });
  sessions.push(hostSession, guestSession);
  return { host, guest, hostSession, guestSession };
}

function decorationCount(ed: KoineEditor): number {
  const field = ed.view.state.field(presenceField, false);
  if (!field) return 0;
  let n = 0;
  field.between(0, Number.MAX_SAFE_INTEGER, () => {
    n++;
  });
  return n;
}

describe('createCollabSession — create', () => {
  it('starts idle, sharing nothing', () => {
    const { hostSession } = pair();
    const state = hostSession.getState();
    expect(state.status).toBe('idle');
    expect(state.token).toBeNull();
    expect(state.authority).toBe(false);
    expect(state.canSave).toBe(false);
  });

  it('opens a session, becomes the document authority, and yields a join token', async () => {
    const { hostSession } = pair();

    const state = await hostSession.create();

    expect(state.status).toBe('live');
    expect(state.sessionId).toBeTruthy();
    expect(state.token).toBeTruthy();
    expect(state.authority).toBe(true);
    expect(state.canSave).toBe(true);
    expect(state.participants).toEqual([ADA]);
  });

  it('shares the creator\'s buffer as the session document (their buffer IS the model)', async () => {
    const { host, hostSession } = pair('context Sales {}\n');

    await hostSession.create();
    host.editor.view.dispatch({ changes: { from: 0, to: 0, insert: '// hi\n' } });

    expect(hostSession.getState().status).toBe('live');
    expect(host.editor.view.state.doc.toString()).toBe('// hi\ncontext Sales {}\n');
  });

  it('notifies subscribers on every state change, and stops after unsubscribe', async () => {
    const { hostSession } = pair();
    const seen: string[] = [];
    const off = hostSession.subscribe((s) => seen.push(s.status));

    await hostSession.create();
    expect(seen).toContain('live');

    off();
    const before = seen.length;
    await hostSession.leave();
    expect(seen).toHaveLength(before);
  });
});

describe('createCollabSession — join', () => {
  it('hydrates the joiner from the authoritative document, discarding their own buffer', async () => {
    const { guest, hostSession, guestSession } = pair('context Billing {}\n', 'scratch buffer\n');
    const created = await hostSession.create();

    const state = await guestSession.join(created.token ?? '');
    await Promise.resolve();

    expect(state.status).toBe('live');
    expect(guest.editor.view.state.doc.toString()).toBe('context Billing {}\n');
  });

  it('is never the authority, and says so through canSave', async () => {
    const { hostSession, guestSession } = pair();
    const created = await hostSession.create();

    const state = await guestSession.join(created.token ?? '');

    expect(state.authority).toBe(false);
    expect(state.canSave).toBe(false);
  });

  it('does NOT grant authority to a joiner presenting the creator\'s identity', async () => {
    // Identity is self-asserted and the token is the only credential, so authority must come from the
    // broker's answer — never from comparing ids. A joiner claiming to be Ada is still just a joiner.
    const broker = createInMemoryCollabBroker();
    const host = createCollabSession({ transport: broker.createTransport(), identity: ADA, editor: editor('a\n') });
    const impostor = createCollabSession({ transport: broker.createTransport(), identity: ADA, editor: editor('b\n') });
    sessions.push(host, impostor);

    const created = await host.create();
    const state = await impostor.join(created.token ?? '');

    expect(state.authority).toBe(false);
    expect(state.canSave).toBe(false);
    expect(host.getState().canSave).toBe(true);
  });

  it('reports an unknown token as an error state rather than throwing at the UI', async () => {
    const { guest, guestSession } = pair('a\n', 'scratch buffer\n');

    const state = await guestSession.join('not-a-real-token');

    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
    expect(state.token).toBeNull();
    // A failed join must not have touched the buffer the user was working in.
    expect(guest.editor.view.state.doc.toString()).toBe('scratch buffer\n');
  });

  it('never puts the join token into the error message (it is a secret)', async () => {
    const { guestSession } = pair();
    const state = await guestSession.join('super-secret-token');
    expect(state.error ?? '').not.toContain('super-secret-token');
  });

  it('sees the peers already in the room', async () => {
    const { hostSession, guestSession } = pair();
    const created = await hostSession.create();

    const state = await guestSession.join(created.token ?? '');

    expect(state.participants.map((p) => p.id).sort()).toEqual(['ada', 'grace']);
    expect(hostSession.getState().participants.map((p) => p.id).sort()).toEqual(['ada', 'grace']);
  });
});

describe('createCollabSession — live editing', () => {
  it('converges edits made on BOTH sides', async () => {
    const { host, guest, hostSession, guestSession } = pair('context Sales {}\n', 'scratch\n');
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');
    await Promise.resolve();

    host.editor.view.dispatch({ changes: { from: 0, to: 0, insert: '// from Ada\n' } });
    const end = guest.editor.view.state.doc.length;
    guest.editor.view.dispatch({ changes: { from: end, to: end, insert: '// from Grace\n' } });

    expect(host.editor.view.state.doc.toString()).toBe(guest.editor.view.state.doc.toString());
    expect(host.editor.view.state.doc.toString()).toContain('// from Ada');
    expect(host.editor.view.state.doc.toString()).toContain('// from Grace');
  });

  it('paints the peer\'s caret from their presence frames', async () => {
    const { host, guest, hostSession, guestSession } = pair('context Sales {}\n', 'scratch\n');
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');
    await Promise.resolve();

    guest.editor.view.dispatch({ selection: EditorSelection.single(2, 9) });

    // A caret widget plus a selection mark for Grace's range.
    expect(decorationCount(host.editor)).toBeGreaterThan(0);
  });

  it('drops a presence frame that claims OUR OWN participant id (no caret spoofing)', async () => {
    // A frame's identity is self-asserted and the token is the only credential, so a participant who
    // holds it can address a frame as anyone — including as you. Painting that would put a caret on
    // Ada's screen labelled "Ada", sitting somewhere she is not.
    const broker = createInMemoryCollabBroker();
    const host = { editor: editor('context Sales {}\n'), transport: broker.createTransport() };
    const hostSession = createCollabSession({ transport: host.transport, identity: ADA, editor: host.editor });
    sessions.push(hostSession);
    const created = await hostSession.create();

    const impostor = broker.createTransport();
    await impostor.start({ mode: 'join', token: created.token ?? '', identity: GRACE });
    const spoof: CollabPresence = { ...ADA, participantId: ADA.id, cursor: 3, selection: [{ from: 0, to: 5 }] };
    await impostor.sendPresence(spoof);

    expect(decorationCount(host.editor)).toBe(0);

    // ...but an honestly-addressed frame from the same peer IS painted, so this is a spoof guard and
    // not a presence layer that simply never renders.
    await impostor.sendPresence({ ...GRACE, participantId: GRACE.id, cursor: 3, selection: [{ from: 0, to: 5 }] });
    expect(decorationCount(host.editor)).toBeGreaterThan(0);
    await impostor.stop();
  });
});

describe('createCollabSession — reconnect', () => {
  it('re-merges edits typed while disconnected, losing nothing', async () => {
    const { host, guest, hostSession, guestSession } = pair('shared\n', 'scratch\n');
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');
    await Promise.resolve();

    // Grace drops off the network but keeps typing. Stopping the TRANSPORT under the session is exactly
    // that: the session still believes it is live, and its sends quietly go nowhere.
    await guest.transport.stop();
    const end = guest.editor.view.state.doc.length;
    guest.editor.view.dispatch({ changes: { from: end, to: end, insert: 'typed offline\n' } });
    expect(host.editor.view.state.doc.toString()).not.toContain('typed offline');

    const state = await guestSession.reconnect();

    expect(state.status).toBe('live');
    expect(host.editor.view.state.doc.toString()).toContain('typed offline');
    expect(host.editor.view.state.doc.toString()).toBe(guest.editor.view.state.doc.toString());
  });

  it('re-reads authority from the broker instead of carrying the old flag over', async () => {
    const { guest, hostSession, guestSession } = pair();
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');

    await guest.transport.stop();
    const state = await guestSession.reconnect();

    expect(state.authority).toBe(false);
    expect(state.canSave).toBe(false);
  });

  it('reports an error rather than throwing when there is no session to reconnect to', async () => {
    const { guestSession } = pair();
    const state = await guestSession.reconnect();
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
  });
});

describe('createCollabSession — leave', () => {
  it('tears the session down locally: presence dropped, buffer kept, token forgotten', async () => {
    const { host, hostSession, guestSession } = pair('context Sales {}\n');
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');
    await Promise.resolve();

    await hostSession.leave();

    const state = hostSession.getState();
    expect(state.status).toBe('left');
    expect(state.token).toBeNull(); // a token is a secret: don't keep it after the session ends
    expect(state.participants).toEqual([]);
    expect(state.canSave).toBe(false);
    expect(decorationCount(host.editor)).toBe(0);
    // The document survives — leaving a session must not cost you your work.
    expect(host.editor.view.state.doc.toString()).toBe('context Sales {}\n');
  });

  it('notifies the peers, who drop the leaver from their participant list', async () => {
    const { hostSession, guestSession } = pair();
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');

    await guestSession.leave();

    expect(hostSession.getState().participants.map((p) => p.id)).toEqual(['ada']);
  });

  it('stops mirroring edits in both directions', async () => {
    const { host, guest, hostSession, guestSession } = pair('shared\n', 'scratch\n');
    const created = await hostSession.create();
    await guestSession.join(created.token ?? '');
    await Promise.resolve();

    await guestSession.leave();
    host.editor.view.dispatch({ changes: { from: 0, to: 0, insert: 'after-leave ' } });

    expect(guest.editor.view.state.doc.toString()).not.toContain('after-leave');
  });

  it('is idempotent, and safe to call on a session that never started', async () => {
    const { hostSession } = pair();
    await hostSession.leave();
    await hostSession.leave();
    expect(hostSession.getState().status).toBe('left');
  });
});

describe('createCollabSession — the replica stays inside the session', () => {
  it('publishes no CRDT handle on its state: the buffer is the only thing anyone else reads', async () => {
    const { host, hostSession } = pair('context Sales {}\n');
    await hostSession.create();

    const values: unknown[] = Object.values({ ...hostSession.getState() });
    expect(values.some((v) => v instanceof Y.Doc || v instanceof Y.Text)).toBe(false);
    expect(host.editor.view.state.doc.toString()).toBe('context Sales {}\n');
  });
});
