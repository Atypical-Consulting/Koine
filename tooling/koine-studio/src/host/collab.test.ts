// Task 1 of issue #481 (Phase 2 collaboration): the `Platform` collaboration-transport seam.
//
// Two things are under test here. First the CAPABILITY GATE — `canCollaborate` is the single source of
// truth for "this host can broker a co-editing session", and (per the Platform capability convention)
// `createCollabTransport` exists iff that flag is true; a host that can't broker omits the factory
// entirely so the UI degrades instead of throwing. Second the TRANSPORT CONTRACT itself, exercised
// against the in-memory reference broker: it is what a broker-capable host must behave like, so the
// desktop sidecar (Task 5) has a spec to match rather than an English description.
import { describe, it, expect, vi } from 'vitest';
import { BrowserPlatform } from '@/host/browser';
import { TauriPlatform } from '@/host/tauri';
import { createInMemoryCollabBroker } from '@/host/collabTransport';
import type { CollabParticipant, CollabPresence, Platform } from '@/host/types';

// Typed as the PORT, not the concrete classes: `createCollabTransport` is an optional member of
// `Platform` that neither host declares, so only the interface view can ask whether it is present —
// which is exactly the question a caller in the UI asks.
const browserHost = (): Platform => new BrowserPlatform();
const desktopHost = (): Platform => new TauriPlatform();

const ada: CollabParticipant = { id: 'ada', displayName: 'Ada', color: '#e8637c' };
const linus: CollabParticipant = { id: 'linus', displayName: 'Linus', color: '#4fb0c6' };

const presenceOf = (p: CollabParticipant, cursor: number): CollabPresence => ({
  participantId: p.id,
  displayName: p.displayName,
  color: p.color,
  cursor,
  selection: [],
});

describe('Platform.canCollaborate (the capability gate)', () => {
  it('is false in a browser tab, which cannot broker a session', () => {
    expect(browserHost().canCollaborate).toBe(false);
  });

  it('omits createCollabTransport in the browser, so callers must gate on the flag', () => {
    expect(browserHost().createCollabTransport).toBeUndefined();
  });

  // The desktop CAN broker in principle (it already brokers a PTY and the LSP child), but the Rust
  // session broker is Task 5 of #481 and is not implemented yet. Reporting `true` before the factory
  // exists would break the Platform convention "the optional method exists iff the flag is true" and
  // hand the UI an affordance that cannot work — so the desktop sits behind the same honest gate until
  // the broker lands, at which point THIS assertion flips alongside it.
  it('is false on the desktop until the session broker ships (#481 Task 5)', () => {
    const tauri = desktopHost();
    expect(tauri.canCollaborate).toBe(false);
    expect(tauri.createCollabTransport).toBeUndefined();
  });

  it('keeps flag and factory consistent on every host (flag true iff factory present)', () => {
    for (const platform of [browserHost(), desktopHost()]) {
      expect(platform.canCollaborate).toBe(platform.createCollabTransport !== undefined);
    }
  });
});

describe('CollabTransport contract (in-memory reference broker)', () => {
  it('creates a session and yields a join token the creator owns as the document authority', async () => {
    const broker = createInMemoryCollabBroker();
    const transport = broker.createTransport();

    const info = await transport.start({ mode: 'create', identity: ada });

    expect(info.token).toBeTruthy();
    expect(info.sessionId).toBeTruthy();
    expect(info.authority).toBe(true);
    expect(info.self).toEqual(ada);
    await transport.stop();
  });

  it('lets a second participant join by token and reports the existing peers to it', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const guest = broker.createTransport();
    const { token } = await host.start({ mode: 'create', identity: ada });

    const joined: CollabParticipant[] = [];
    guest.onPeerJoin((p) => joined.push(p));
    const info = await guest.start({ mode: 'join', token, identity: linus });

    expect(info.authority).toBe(false); // only the creator is the document authority
    expect(joined).toEqual([ada]); // the joiner learns who is already in the room
    await host.stop();
    await guest.stop();
  });

  it('rejects a join with an unknown token rather than silently opening a new room', async () => {
    const broker = createInMemoryCollabBroker();
    const guest = broker.createTransport();
    await expect(guest.start({ mode: 'join', token: 'not-a-real-token', identity: linus })).rejects.toThrow(
      /unknown|invalid/i,
    );
  });

  it('notifies the existing participants when a peer joins', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const guest = broker.createTransport();
    const peers: CollabParticipant[] = [];
    host.onPeerJoin((p) => peers.push(p));

    const { token } = await host.start({ mode: 'create', identity: ada });
    await guest.start({ mode: 'join', token, identity: linus });

    expect(peers).toEqual([linus]);
    await host.stop();
    await guest.stop();
  });

  it('fans an update out to every OTHER participant but never echoes it to the sender', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const guest = broker.createTransport();
    const { token } = await host.start({ mode: 'create', identity: ada });
    await guest.start({ mode: 'join', token, identity: linus });

    const toHost = vi.fn();
    const toGuest = vi.fn();
    host.onUpdate(toHost);
    guest.onUpdate(toGuest);

    await host.send(Uint8Array.from([1, 2, 3]));

    expect(toGuest).toHaveBeenCalledTimes(1);
    expect(toGuest.mock.calls[0][0]).toEqual(Uint8Array.from([1, 2, 3]));
    expect(toHost).not.toHaveBeenCalled(); // no echo loop back to the originator
    await host.stop();
    await guest.stop();
  });

  it('fans presence out on its own channel, also without echoing the sender', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const guest = broker.createTransport();
    const { token } = await host.start({ mode: 'create', identity: ada });
    await guest.start({ mode: 'join', token, identity: linus });

    const toHost = vi.fn();
    const toGuest = vi.fn();
    host.onPresence(toHost);
    guest.onPresence(toGuest);

    await guest.sendPresence(presenceOf(linus, 12));

    expect(toHost).toHaveBeenCalledWith(presenceOf(linus, 12));
    expect(toGuest).not.toHaveBeenCalled();
    await host.stop();
    await guest.stop();
  });

  it('drops the participant and notifies peers on stop()', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const guest = broker.createTransport();
    const { token } = await host.start({ mode: 'create', identity: ada });
    await guest.start({ mode: 'join', token, identity: linus });
    const left: string[] = [];
    host.onPeerLeave((id) => left.push(id));

    await guest.stop();

    expect(left).toEqual([linus.id]);
    // …and the departed participant no longer receives fan-out.
    const afterLeave = vi.fn();
    guest.onUpdate(afterLeave);
    await host.send(Uint8Array.from([9]));
    expect(afterLeave).not.toHaveBeenCalled();
    await host.stop();
  });

  // `identity` is self-asserted by the client and the join token is the only credential, so authority
  // must key off the member that CREATED the room, never off a participant id anyone can present. Two
  // participants both believing they own the canonical `.koi` save is a lost-write bug.
  it('does not grant authority to a joiner presenting the creator’s identity', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const impostor = broker.createTransport();
    const { token } = await host.start({ mode: 'create', identity: ada });

    const info = await impostor.start({ mode: 'join', token, identity: { ...ada, displayName: 'Impostor' } });

    expect(info.authority).toBe(false);
    await host.stop();
    await impostor.stop();
  });

  // These handlers end in `view.dispatch`, which CodeMirror can throw out of. One bad participant must
  // not abort the fan-out loop and silently starve everyone after it — that is permanent divergence once
  // these frames carry CRDT updates.
  it('keeps delivering to the remaining peers when one peer’s handler throws', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const bad = broker.createTransport();
    const good = broker.createTransport();
    const { token } = await host.start({ mode: 'create', identity: ada });
    await bad.start({ mode: 'join', token, identity: linus });
    await good.start({ mode: 'join', token, identity: { id: 'grace', displayName: 'Grace', color: '#7ac' } });

    bad.onUpdate(() => {
      throw new Error('this peer’s editor blew up');
    });
    const delivered = vi.fn();
    good.onUpdate(delivered);

    await expect(host.send(Uint8Array.from([7]))).resolves.toBeUndefined(); // never throws at the sender
    expect(delivered).toHaveBeenCalledTimes(1);
    await host.stop();
    await bad.stop();
    await good.stop();
  });

  it('does not let a throwing peer-leave handler hide a departure from the other peers', async () => {
    const broker = createInMemoryCollabBroker();
    const leaver = broker.createTransport();
    const bad = broker.createTransport();
    const good = broker.createTransport();
    const { token } = await leaver.start({ mode: 'create', identity: ada });
    await bad.start({ mode: 'join', token, identity: linus });
    await good.start({ mode: 'join', token, identity: { id: 'grace', displayName: 'Grace', color: '#7ac' } });

    bad.onPeerLeave(() => {
      throw new Error('boom');
    });
    const sawLeave = vi.fn();
    good.onPeerLeave(sawLeave);

    await expect(leaver.stop()).resolves.toBeUndefined();
    expect(sawLeave).toHaveBeenCalledWith(ada.id);
    await bad.stop();
    await good.stop();
  });

  // A reconnect that re-`start`s without an intervening `stop` would otherwise leave the member in BOTH
  // rooms, with `stop()` only ever able to remove it from the newer one.
  it('leaves the current session when start() is called again, with no ghost membership behind', async () => {
    const broker = createInMemoryCollabBroker();
    const first = broker.createTransport();
    const second = broker.createTransport();
    const mover = broker.createTransport();
    const a = await first.start({ mode: 'create', identity: ada });
    const b = await second.start({ mode: 'create', identity: linus });
    await mover.start({ mode: 'join', token: a.token, identity: { id: 'grace', displayName: 'Grace', color: '#7ac' } });

    // Re-start into the OTHER session without stopping first.
    await mover.start({ mode: 'join', token: b.token, identity: { id: 'grace', displayName: 'Grace', color: '#7ac' } });

    const stale = vi.fn();
    mover.onUpdate(stale);
    await first.send(Uint8Array.from([1])); // the abandoned room must no longer reach it
    expect(stale).not.toHaveBeenCalled();

    await mover.stop();
    await second.send(Uint8Array.from([2])); // …and stop() really removed it from the current room too
    expect(stale).not.toHaveBeenCalled();
    await first.stop();
    await second.stop();
  });

  it('tells the abandoned session’s peers that the re-starting participant left', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    const other = broker.createTransport();
    const mover = broker.createTransport();
    const a = await host.start({ mode: 'create', identity: ada });
    const b = await other.start({ mode: 'create', identity: linus });
    await mover.start({ mode: 'join', token: a.token, identity: { id: 'grace', displayName: 'Grace', color: '#7ac' } });

    const left = vi.fn();
    host.onPeerLeave(left);
    await mover.start({ mode: 'join', token: b.token, identity: { id: 'grace', displayName: 'Grace', color: '#7ac' } });

    expect(left).toHaveBeenCalledWith('grace');
    await host.stop();
    await other.stop();
    await mover.stop();
  });

  it('is idempotent on stop() and inert on send() after leaving (no throw in the UI path)', async () => {
    const broker = createInMemoryCollabBroker();
    const host = broker.createTransport();
    await host.start({ mode: 'create', identity: ada });

    await host.stop();
    await expect(host.stop()).resolves.toBeUndefined();
    await expect(host.send(Uint8Array.from([1]))).resolves.toBeUndefined();
    await expect(host.sendPresence(presenceOf(ada, 0))).resolves.toBeUndefined();
  });
});
