// Task 5 of issue #481: the desktop `CollabTransport`, bridged over Tauri IPC onto the Rust session
// broker (`collab_start`/`collab_send`/`collab_send_presence`/`collab_leave` + the `collab://*` events).
//
// Two levels are under test. The WIRE CONTRACT — command names, argument shapes, event names, and the
// `Uint8Array` ↔ JSON-array encoding — is what has to agree with `src-tauri/src/collab.rs`; get one of
// those wrong and the two halves compile perfectly and never speak. And the ROUND TRIP: two bridged
// transports, wired through a fake IPC layer onto the reference broker
// (`createInMemoryCollabBroker` — the same executable spec the Rust broker is written against), have to
// carry an update and a presence frame between two participants.
//
// The fake IPC needs a notion of "which window is calling", which real Tauri gets for free (one session
// per process). `as(peer, …)` supplies it: every operation is awaited to completion under one peer, and
// nothing runs concurrently, so the current-peer marker is unambiguous for the whole call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInMemoryCollabBroker } from '@/host/collabTransport';
import type { CollabParticipant, CollabPresence, CollabTransport, Platform } from '@/host/types';

const { listenMock, invokeMock, settingsOverride } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  invokeMock: vi.fn(),
  settingsOverride: { current: {} },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/settings/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/settings/persistence')>();
  return { ...actual, loadSettings: () => ({ ...actual.loadSettings(), ...settingsOverride.current }) };
});

import { TauriPlatform } from '@/host/tauri';
import { BrowserPlatform } from '@/host/browser';

const ADA: CollabParticipant = { id: 'ada', displayName: 'Ada', color: '#e8637c' };
const GRACE: CollabParticipant = { id: 'grace', displayName: 'Grace', color: '#54b8a0' };

const presenceOf = (p: CollabParticipant, cursor: number): CollabPresence => ({
  participantId: p.id,
  displayName: p.displayName,
  color: p.color,
  cursor,
  selection: [],
});

type EventHandler = (event: { payload: unknown }) => void;

/** One participant's end of the fake IPC: the `collab://*` handlers, plus its reference-broker leg. */
interface FakePeer {
  handlers: Map<string, EventHandler>;
  leg?: CollabTransport;
}

let peers: Map<string, FakePeer>;
let currentPeer: string;
let broker: ReturnType<typeof createInMemoryCollabBroker>;

/** Run one transport operation as `peer`, exactly as a second Studio window would. */
async function as<T>(peer: string, run: () => Promise<T>): Promise<T> {
  currentPeer = peer;
  return await run();
}

function peerOf(id: string): FakePeer {
  const existing = peers.get(id);
  if (existing) return existing;
  const fresh: FakePeer = { handlers: new Map() };
  peers.set(id, fresh);
  return fresh;
}

beforeEach(() => {
  peers = new Map();
  currentPeer = 'ada';
  broker = createInMemoryCollabBroker();
  settingsOverride.current = {};
  listenMock.mockReset();
  invokeMock.mockReset();

  listenMock.mockImplementation(async (event: string, cb: EventHandler) => {
    const peer = peerOf(currentPeer);
    peer.handlers.set(event, cb);
    return () => peer.handlers.delete(event);
  });

  // Stand in for the Rust host: one broker leg per window, its inbound frames re-emitted as the
  // `collab://*` events the real host emits (payloads shaped exactly as Rust serializes them —
  // note the update arrives as a JSON number array, never a Uint8Array).
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    const peer = peerOf(currentPeer);
    const emit = (event: string, payload: unknown) => peer.handlers.get(event)?.({ payload });

    switch (command) {
      case 'collab_start': {
        const leg = broker.createTransport();
        peer.leg = leg;
        leg.onUpdate((update) => emit('collab://update', Array.from(update)));
        leg.onPresence((presence) => emit('collab://presence', presence));
        leg.onPeerJoin((joined) => emit('collab://peer-join', joined));
        leg.onPeerLeave((participantId) => emit('collab://peer-leave', participantId));
        return await leg.start({
          mode: args?.mode as 'create' | 'join',
          token: (args?.token as string | null) ?? undefined,
          identity: args?.identity as CollabParticipant,
        });
      }
      case 'collab_send':
        return await peer.leg?.send(Uint8Array.from(args?.update as number[]));
      case 'collab_send_presence':
        return await peer.leg?.sendPresence(args?.presence as CollabPresence);
      case 'collab_leave':
        return await peer.leg?.stop();
      default:
        return undefined;
    }
  });
});

describe('Platform.canCollaborate once the broker has shipped (#481 Task 5)', () => {
  it('is true on the desktop, which now brokers the session itself', () => {
    const desktop: Platform = new TauriPlatform();
    expect(desktop.canCollaborate).toBe(true);
    expect(desktop.createCollabTransport).toBeDefined();
  });

  it('stays true on the desktop with a relay configured — the relay changes WHICH broker, not whether', () => {
    settingsOverride.current = { collabRelayUrl: 'relay.example:4321' };
    expect(new TauriPlatform().canCollaborate).toBe(true);
  });

  // A browser tab can neither listen nor dial a TCP socket, so a configured relay does NOT make it
  // broker-capable: reaching one from the browser needs a WebSocket relay client, which this task does
  // not ship. The gate stays honest rather than offering an affordance that cannot work.
  it('stays false in a browser tab even with a relay configured', () => {
    settingsOverride.current = { collabRelayUrl: 'relay.example:4321' };
    const browser: Platform = new BrowserPlatform();
    expect(browser.canCollaborate).toBe(false);
    expect(browser.createCollabTransport).toBeUndefined();
  });
});

describe('TauriCollabTransport — the wire contract with the Rust broker', () => {
  it('subscribes to every collab:// event BEFORE opening the session', async () => {
    const transport = new TauriPlatform().createCollabTransport();
    await transport.start({ mode: 'create', identity: ADA });

    for (const event of ['collab://update', 'collab://presence', 'collab://peer-join', 'collab://peer-leave']) {
      expect(listenMock).toHaveBeenCalledWith(event, expect.any(Function));
    }
    const firstInvoke = invokeMock.mock.invocationCallOrder[0];
    for (const call of listenMock.mock.invocationCallOrder) {
      expect(call).toBeLessThan(firstInvoke);
    }
  });

  it('passes the configured bind address and relay through to collab_start', async () => {
    settingsOverride.current = { collabBindAddress: '192.168.1.42', collabRelayUrl: 'relay.example:4321' };
    const transport = new TauriPlatform().createCollabTransport();
    await transport.start({ mode: 'create', identity: ADA });

    expect(invokeMock).toHaveBeenCalledWith('collab_start', {
      mode: 'create',
      token: null,
      identity: ADA,
      bindAddress: '192.168.1.42',
      relay: 'relay.example:4321',
    });
  });

  it('forwards the join token on a join, and defaults to loopback with no relay', async () => {
    const host = new TauriPlatform().createCollabTransport();
    const created = await as('ada', () => host.start({ mode: 'create', identity: ADA }));

    const guest = new TauriPlatform().createCollabTransport();
    await as('grace', () => guest.start({ mode: 'join', token: created.token, identity: GRACE }));

    expect(invokeMock).toHaveBeenLastCalledWith('collab_start', {
      mode: 'join',
      token: created.token,
      identity: GRACE,
      bindAddress: '127.0.0.1',
      relay: '',
    });
  });

  it('encodes an update as a JSON number array, which is what Tauri IPC can carry', async () => {
    const transport = new TauriPlatform().createCollabTransport();
    await transport.start({ mode: 'create', identity: ADA });
    await transport.send(Uint8Array.from([0, 255, 17]));

    expect(invokeMock).toHaveBeenLastCalledWith('collab_send', { update: [0, 255, 17] });
  });

  it('detaches its listeners and leaves the session on stop', async () => {
    const transport = new TauriPlatform().createCollabTransport();
    await transport.start({ mode: 'create', identity: ADA });
    expect(peerOf('ada').handlers.size).toBe(4);

    await transport.stop();

    expect(invokeMock).toHaveBeenLastCalledWith('collab_leave');
    expect(peerOf('ada').handlers.size).toBe(0);
  });

  it('leaves no listeners behind when the broker refuses the session', async () => {
    invokeMock.mockImplementationOnce(async () => {
      throw new Error('unknown or expired collaboration session token');
    });
    const transport = new TauriPlatform().createCollabTransport();

    await expect(transport.start({ mode: 'join', token: 'nope', identity: GRACE })).rejects.toThrow(
      /unknown or expired/,
    );
    expect(peerOf('ada').handlers.size).toBe(0);
  });
});

describe('TauriCollabTransport — round trip between two participants', () => {
  /** Two bridged transports on one broker: the creator (authority) and a joiner. */
  async function pair() {
    const host = new TauriPlatform().createCollabTransport();
    const guest = new TauriPlatform().createCollabTransport();
    const hostSeen = { updates: [] as Uint8Array[], presence: [] as CollabPresence[], peers: [] as CollabParticipant[], left: [] as string[] };
    const guestSeen = { updates: [] as Uint8Array[], presence: [] as CollabPresence[], peers: [] as CollabParticipant[], left: [] as string[] };

    for (const [transport, seen] of [
      [host, hostSeen],
      [guest, guestSeen],
    ] as const) {
      transport.onUpdate((u) => seen.updates.push(u));
      transport.onPresence((p) => seen.presence.push(p));
      transport.onPeerJoin((p) => seen.peers.push(p));
      transport.onPeerLeave((id) => seen.left.push(id));
    }

    const created = await as('ada', () => host.start({ mode: 'create', identity: ADA }));
    const joined = await as('grace', () => guest.start({ mode: 'join', token: created.token, identity: GRACE }));
    return { host, guest, created, joined, hostSeen, guestSeen };
  }

  it('carries an update from the authority to the joiner, and back', async () => {
    const { host, guest, created, joined, hostSeen, guestSeen } = await pair();

    expect(created.authority).toBe(true);
    expect(joined.authority).toBe(false);
    expect(joined.sessionId).toBe(created.sessionId);

    await as('ada', () => host.send(Uint8Array.from([1, 2, 3])));
    expect(guestSeen.updates).toEqual([Uint8Array.from([1, 2, 3])]);
    expect(hostSeen.updates).toEqual([]);

    await as('grace', () => guest.send(Uint8Array.from([9])));
    expect(hostSeen.updates).toEqual([Uint8Array.from([9])]);
  });

  it('carries a presence frame, and announces peers joining and leaving', async () => {
    const { guest, hostSeen, guestSeen } = await pair();

    expect(hostSeen.peers).toEqual([GRACE]);
    expect(guestSeen.peers).toEqual([ADA]);

    await as('grace', () => guest.sendPresence(presenceOf(GRACE, 12)));
    expect(hostSeen.presence).toEqual([presenceOf(GRACE, 12)]);

    await as('grace', () => guest.stop());
    expect(hostSeen.left).toEqual([GRACE.id]);
  });
});
