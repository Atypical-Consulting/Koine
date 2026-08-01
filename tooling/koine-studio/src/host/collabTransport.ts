// The in-memory REFERENCE broker for Koine Studio's real-time collaboration transport (issue #481,
// Phase 2 of #259).
//
// A `CollabTransport` needs something to broker it, and the real brokers — the Tauri sidecar and an
// optional user-configured relay (#481 Task 5) — live outside the front end. This module implements the
// same session semantics in-process: a session registry keyed by join token, peer bookkeeping, and
// sender-excluded fan-out of CRDT updates and presence frames. It exists for two reasons.
//
//   1. It is the EXECUTABLE SPEC for the broker contract. `collab.test.ts` exercises it, so the Rust
//      sidecar has behaviour to match — "fan out to every other participant, never echo the sender",
//      "an unknown token is rejected", "leaving drops the participant and notifies peers" — rather than
//      an English description that drifts.
//   2. It lets the presence layer and (later) the CRDT binding be tested end-to-end between two
//      participants with no process, socket, or Tauri IPC involved.
//
// It brokers only within ONE JavaScript realm, so it is deliberately NOT wired into `BrowserPlatform`:
// a browser tab genuinely cannot collaborate with another machine, and reporting `canCollaborate = true`
// on the strength of a same-realm broker would be a lie the UI acts on. `Platform` wiring belongs to the
// hosts that can really broker.
//
// Payloads are opaque here, exactly as they are on the wire: this module never learns what a CRDT update
// contains, and collaboration state never reaches the `.koi` semantic model or the emitters.
import type {
  CollabParticipant,
  CollabPresence,
  CollabSessionInfo,
  CollabSessionRequest,
  CollabTransport,
} from '@/host/types';

/** A transport factory bound to one broker instance — the seam a host's `createCollabTransport` fills. */
export interface CollabBroker {
  /** A fresh, unstarted transport. Attach its `on*` handlers, then `start` to create or join. */
  createTransport(): CollabTransport;
}

/** One connected participant, as the broker tracks it. */
interface Member {
  identity: CollabParticipant;
  onUpdate: ((update: Uint8Array) => void) | null;
  onPresence: ((presence: CollabPresence) => void) | null;
  onPeerJoin: ((peer: CollabParticipant) => void) | null;
  onPeerLeave: ((participantId: string) => void) | null;
}

interface Session {
  id: string;
  token: string;
  /** The creator's participant id — the document authority that owns the canonical save. */
  authorityId: string;
  members: Set<Member>;
}

/**
 * Create an in-process broker. Sessions live only as long as the broker object, so each test (or each
 * host instance) gets an isolated room registry rather than sharing module-level state.
 */
export function createInMemoryCollabBroker(): CollabBroker {
  const sessions = new Map<string, Session>();
  let seq = 0;
  // Deterministic, monotonic ids: a broker is per-instance, and tests must not depend on randomness.
  // Real brokers MUST use unguessable tokens — a token grants edit access to the model (see #481's
  // security notes) — which is a property of the transport's own id generation, not of this contract.
  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  /** Deliver to every member of `session` except `sender`, skipping any that hasn't registered `pick`. */
  function fanOut<T>(
    session: Session,
    sender: Member,
    pick: (m: Member) => ((payload: T) => void) | null,
    payload: T,
  ): void {
    for (const member of session.members) {
      if (member === sender) continue; // never echo the originator — that is how update loops start
      pick(member)?.(payload);
    }
  }

  function createTransport(): CollabTransport {
    const member: Member = {
      identity: { id: '', displayName: '', color: '' },
      onUpdate: null,
      onPresence: null,
      onPeerJoin: null,
      onPeerLeave: null,
    };
    // Null until `start` succeeds and again after `stop`, which is what makes a post-leave `send` inert
    // rather than a throw in the UI path.
    let session: Session | null = null;

    return {
      start(request: CollabSessionRequest): Promise<CollabSessionInfo> {
        member.identity = request.identity;

        if (request.mode === 'create') {
          const created: Session = {
            id: nextId('session'),
            token: nextId('token'),
            authorityId: request.identity.id,
            members: new Set([member]),
          };
          sessions.set(created.token, created);
          session = created;
          return Promise.resolve({
            sessionId: created.id,
            token: created.token,
            authority: true,
            self: request.identity,
          });
        }

        const target = request.token ? sessions.get(request.token) : undefined;
        if (!target) {
          // Deliberately does not name the token in the message — it is a secret, and this string can
          // reach a log or a toast.
          return Promise.reject(new Error('unknown or expired collaboration session token'));
        }

        // Replay the room to the joiner BEFORE announcing it, so the newcomer never sees itself listed
        // and the existing members' join events all describe someone genuinely new.
        const existing = [...target.members].map((m) => m.identity);
        target.members.add(member);
        session = target;
        for (const peer of existing) member.onPeerJoin?.(peer);
        fanOut(target, member, (m) => m.onPeerJoin, request.identity);

        return Promise.resolve({
          sessionId: target.id,
          token: target.token,
          authority: target.authorityId === request.identity.id,
          self: request.identity,
        });
      },

      send(update: Uint8Array): Promise<void> {
        if (session) fanOut(session, member, (m) => m.onUpdate, update);
        return Promise.resolve();
      },

      sendPresence(presence: CollabPresence): Promise<void> {
        if (session) fanOut(session, member, (m) => m.onPresence, presence);
        return Promise.resolve();
      },

      onUpdate(cb) {
        member.onUpdate = cb;
      },
      onPresence(cb) {
        member.onPresence = cb;
      },
      onPeerJoin(cb) {
        member.onPeerJoin = cb;
      },
      onPeerLeave(cb) {
        member.onPeerLeave = cb;
      },

      stop(): Promise<void> {
        const leaving = session;
        session = null; // first, so a re-entrant stop() from a peer-leave handler is a no-op
        if (!leaving) return Promise.resolve();
        leaving.members.delete(member);
        fanOut(leaving, member, (m) => m.onPeerLeave, member.identity.id);
        // Reclaim the room once empty, so a stale token can never re-open an abandoned session.
        if (leaving.members.size === 0) sessions.delete(leaving.token);
        return Promise.resolve();
      },
    };
  }

  return { createTransport };
}
