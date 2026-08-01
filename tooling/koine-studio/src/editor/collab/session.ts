// The collaboration SESSION for Koine Studio (issue #481 Task 4, Phase 2 of #259) — the object that
// composes the three pieces that shipped before it into an actual co-editing session:
//
//   * the `Platform` transport (#481 Task 1) — moves opaque CRDT updates and presence frames,
//   * the presence layer (#481 Task 2) — paints remote carets and publishes the local one,
//   * the CRDT binding (#481 Task 3) — keeps this buffer and the shared replica converged.
//
// It owns the `Y.Doc`, the session lifecycle (create / join / reconnect / leave), the participant list,
// and the one question the UI cares about most: **who owns the canonical save.**
//
// Three rules earn their own note, because each of them is a way a session can quietly go wrong:
//
//   1. **Authority is what the BROKER said, never what a client claims.** `CollabSessionInfo.authority`
//      is the only source; nothing here ever compares participant ids to decide who owns the document.
//      Identity is self-asserted and the join token is the only credential, so id-comparison would hand
//      authority to anyone who echoed the creator's id — and two participants each believing they own
//      the canonical save is a lost-write bug. Re-read on every (re)connect, never carried over.
//   2. **The token is a secret.** It grants edit access to the model. It is never logged, never put in
//      an error message, and dropped from the session state the moment the session ends.
//   3. **Nothing in here reaches the compiler.** Sessions are a Studio runtime concern; the `.koi`
//      semantic model and the emitters never learn they exist.
//
// The session never rejects. Every failure (an unknown token, a transport that won't start) resolves to
// a state with `status: 'error'` and a human-readable `error`, so a UI path can render it and no
// collaboration affordance can ever throw at the user — the same contract `CollabGate` applies to a
// host that cannot broker at all.
import * as Y from 'yjs';
import type { EditorView } from '@codemirror/view';
import type { CollabParticipant, CollabPresence, CollabTransport } from '@/host/types';
import { setRemotePresence, type PresenceSource } from '@/editor/presence';
import { sharedText, type CrdtBinding } from '@/editor/collab/crdtBinding';

/**
 * The Yjs origin the session stamps on updates that arrived FROM a peer, so its own `doc.on('update')`
 * relay can tell "someone else's change, already on the wire" from "our change, needs broadcasting".
 * Without it every inbound update is immediately rebroadcast and the session floods itself.
 */
const REMOTE_ORIGIN = Symbol('koine.collab.remote');

/** Where a session lives out its life. `error` is terminal for the attempt, not for the object. */
export type CollabSessionStatus = 'idle' | 'connecting' | 'live' | 'left' | 'error';

/** Everything the UI renders a session from. Immutable; a new object is published on every change. */
export interface CollabSessionState {
  readonly status: CollabSessionStatus;
  /** Opaque session id, for diagnostics. Null unless live. */
  readonly sessionId: string | null;
  /** The join token to hand a second participant. A SECRET — never log it. Null unless live. */
  readonly token: string | null;
  /** True iff the BROKER admitted this participant as the session creator. */
  readonly authority: boolean;
  /**
   * Whether this participant may write the canonical `.koi` to disk. Today that is exactly
   * {@link authority} — a separate field because "who owns the save" is the question the UI asks, and
   * it is the one that must stay true if authority handoff ever lands.
   */
  readonly canSave: boolean;
  /** Everyone in the session, this participant included. */
  readonly participants: readonly CollabParticipant[];
  /** Why the last attempt failed, in the user's terms. Never contains the token. */
  readonly error: string | null;
}

export interface CollabSession {
  /** The current state. Cheap; safe to call in a render. */
  getState(): CollabSessionState;
  /** Observe state changes. Returns the unsubscribe function. */
  subscribe(listener: (state: CollabSessionState) => void): () => void;
  /**
   * Open a session over this participant's buffer and become the document authority. Their buffer IS
   * the session document — it is seeded into the replica as-is.
   */
  create(): Promise<CollabSessionState>;
  /**
   * Join an existing session by token. The joiner's own buffer is DISCARDED and replaced by the
   * session's document (the spec's late-join rule: hydrate from the authoritative state, not from
   * update history) — the authority answers the join by broadcasting its full replica.
   */
  join(token: string): Promise<CollabSessionState>;
  /**
   * Re-attach after the transport dropped. Re-joins with the session's token and re-broadcasts the whole
   * local replica, so everything typed while offline merges into every peer with nothing lost. Authority
   * is re-read from the broker's answer, never carried over.
   */
  reconnect(): Promise<CollabSessionState>;
  /**
   * Leave: peers are notified, remote carets are dropped, the replica is released and the token
   * forgotten. The local buffer is left exactly as it is — leaving a session must never cost you work.
   * Idempotent.
   */
  leave(): Promise<void>;
}

/**
 * The slice of the editor a session drives. `KoineEditor` satisfies it structurally; declaring the
 * narrow port keeps the session testable and stops it reaching for editor features it has no business
 * touching.
 */
export interface CollabEditorPort {
  readonly view: EditorView;
  setPresenceEnabled(on: boolean, source?: PresenceSource): void;
  setCrdtEnabled(on: boolean, bind?: CrdtBinding): void;
}

export interface CollabSessionOptions {
  /** The transport the host brokered — one per session (`Platform.createCollabTransport`). */
  readonly transport: CollabTransport;
  /** How this participant introduces itself to its peers. */
  readonly identity: CollabParticipant;
  /** The editor whose buffer is shared. */
  readonly editor: CollabEditorPort;
}

const IDLE: CollabSessionState = {
  status: 'idle',
  sessionId: null,
  token: null,
  authority: false,
  canSave: false,
  participants: [],
  error: null,
};

/** A presence frame is untrusted wire data; anything malformed is dropped before it reaches the editor. */
function isRenderablePresence(frame: CollabPresence | null | undefined): frame is CollabPresence {
  return !!frame && typeof frame.participantId === 'string' && frame.participantId.length > 0;
}

export function createCollabSession({ transport, identity, editor }: CollabSessionOptions): CollabSession {
  let state: CollabSessionState = IDLE;
  const listeners = new Set<(state: CollabSessionState) => void>();
  /** Peers only — `identity` is added when the participant list is published. */
  const peers = new Map<string, CollabParticipant>();
  /** The latest frame per peer. Presence is a snapshot, so a newer frame simply replaces the last. */
  const presence = new Map<string, CollabPresence>();
  let doc: Y.Doc | null = null;
  let handlersAttached = false;

  function publish(patch: Partial<CollabSessionState>): CollabSessionState {
    state = { ...state, ...patch };
    // Copy first: a listener that unsubscribes (or subscribes) while being notified must not mutate the
    // set mid-iteration.
    for (const listener of [...listeners]) listener(state);
    return state;
  }

  function participantList(): readonly CollabParticipant[] {
    return [identity, ...peers.values()];
  }

  function paintPresence(): void {
    setRemotePresence(editor.view, [...presence.values()]);
  }

  /** Broadcast the entire replica. How a late joiner is hydrated, and how a reconnect re-merges. */
  function broadcastFullState(): void {
    if (!doc) return;
    void transport.send(Y.encodeStateAsUpdate(doc));
  }

  /** Register the transport handlers once — they outlive an individual connection, exactly as the
   *  transport contract promises ("the `on*` handlers stay registered so a reconnect can `start` again"). */
  function attachHandlers(): void {
    if (handlersAttached) return;
    handlersAttached = true;

    transport.onUpdate((update) => {
      if (!doc) return;
      Y.applyUpdate(doc, update, REMOTE_ORIGIN);
    });

    transport.onPresence((frame) => {
      if (!isRenderablePresence(frame)) return;
      // A peer holding the token can address a frame as anyone — including as us. Rendering that would
      // put a caret labelled with our own name somewhere we are not, so our id is ours alone.
      if (frame.participantId === identity.id) return;
      presence.set(frame.participantId, frame);
      paintPresence();
    });

    transport.onPeerJoin((peer) => {
      if (!peer || typeof peer.id !== 'string') return;
      peers.set(peer.id, peer);
      // The authority answers a join with the whole document: that is what makes a late joiner hydrate
      // from the authoritative state rather than from a replay of update history. Only the authority
      // does it, so N participants don't each send a full copy for every arrival.
      if (state.authority) broadcastFullState();
      publish({ participants: participantList() });
    });

    transport.onPeerLeave((participantId) => {
      peers.delete(participantId);
      // Their caret goes with them — presence carries no authority and must never outlive its owner.
      if (presence.delete(participantId)) paintPresence();
      publish({ participants: participantList() });
    });
  }

  /** Start a fresh replica and relay every locally-originated update onto the wire. */
  function openReplica(): Y.Doc {
    doc?.destroy();
    const fresh = new Y.Doc();
    fresh.on('update', (update: Uint8Array, origin: unknown) => {
      // What we just received from a peer is already on the wire; re-sending it is the session-level
      // echo loop (the binding guards the editor-level one).
      if (origin === REMOTE_ORIGIN) return;
      void transport.send(update);
    });
    doc = fresh;
    return fresh;
  }

  /** Bind the editor to the replica and start publishing this participant's presence. */
  function attachEditor(authority: boolean): void {
    if (!doc) return;
    editor.setCrdtEnabled(true, { text: sharedText(doc), hydrate: authority ? 'editor' : 'crdt' });
    editor.setPresenceEnabled(true, {
      publish: (local) => {
        void transport.sendPresence({
          participantId: identity.id,
          displayName: identity.displayName,
          color: identity.color,
          cursor: local.cursor,
          selection: local.selection,
        });
      },
    });
  }

  /** Unbind the editor and drop every remote caret. Shared by `leave` and by re-entering a session. */
  function detachEditor(): void {
    presence.clear();
    paintPresence(); // repaint (to nothing) while the layer is still attached to receive it
    editor.setPresenceEnabled(false);
    editor.setCrdtEnabled(false);
    peers.clear();
  }

  /**
   * Report a failed attempt. `keepSession` is the difference between "this session is over" and "this
   * connection dropped": a failed RECONNECT must keep the replica and the token, because the replica
   * holds everything typed while offline and the token is the only way back in.
   */
  function fail(message: string, keepSession = false): CollabSessionState {
    return keepSession
      ? publish({ status: 'error', error: message })
      : publish({ status: 'error', error: message, sessionId: null, token: null, authority: false, canSave: false });
  }

  /** The shared body of create/join/reconnect: connect, then reflect the broker's answer. */
  async function connect(
    request: { mode: 'create' | 'join'; token?: string },
    reuseReplica: boolean,
  ): Promise<CollabSessionState> {
    attachHandlers();
    if (!reuseReplica) {
      // Entering a session always starts from a clean editor: re-binding without detaching would leave
      // the buffer mirroring the replica we are about to discard.
      detachEditor();
      openReplica();
    } else {
      // A reconnect re-enters the same room, and the broker replays its membership — so drop what we
      // remember rather than keeping peers who left while we were away.
      peers.clear();
      presence.clear();
      paintPresence();
    }
    publish({ status: 'connecting', error: null, participants: participantList() });
    try {
      const info = await transport.start({ mode: request.mode, token: request.token, identity });
      const next = publish({
        status: 'live',
        sessionId: info.sessionId,
        token: info.token,
        // Straight from the broker. Never inferred, never carried over from a previous connection.
        authority: info.authority,
        canSave: info.authority,
        participants: participantList(),
        error: null,
      });
      // A reconnect keeps its binding and pushes the whole replica, so anything typed while the
      // transport was down merges into every peer; a fresh session binds the editor instead.
      if (reuseReplica) broadcastFullState();
      else attachEditor(info.authority);
      return next;
    } catch (err) {
      // The message may name the token on some transports, so it is never surfaced verbatim.
      void err;
      if (reuseReplica) {
        return fail('Lost the connection to this session. Try reconnecting.', true);
      }
      detachEditor();
      doc?.destroy();
      doc = null;
      return fail(
        request.mode === 'create'
          ? 'Could not open a collaboration session on this host.'
          : 'Could not join that session — the invitation may have expired.',
      );
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    create() {
      return connect({ mode: 'create' }, false);
    },

    join(token: string) {
      if (!token) return Promise.resolve(fail('Paste the invitation you were given to join a session.'));
      return connect({ mode: 'join', token }, false);
    },

    async reconnect() {
      // Reconnecting needs both the replica (the offline edits live in it) and the token; without either
      // there is nothing to rejoin, and re-`create`ing would silently mint a DIFFERENT session.
      if (!doc || !state.token) {
        return fail('There is no session to reconnect to — start or join one first.');
      }
      return connect({ mode: 'join', token: state.token }, true);
    },

    async leave() {
      detachEditor();
      await transport.stop();
      doc?.destroy();
      doc = null;
      publish({
        status: 'left',
        sessionId: null,
        token: null, // the token is a secret; it does not outlive the session
        authority: false,
        canSave: false,
        participants: [],
        error: null,
      });
    },
  };
}
