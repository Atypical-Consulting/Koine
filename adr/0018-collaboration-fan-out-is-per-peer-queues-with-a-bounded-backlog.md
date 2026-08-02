---
id: 18
title: Collaboration fan-out is per-peer queues with a bounded backlog
status: proposed
date: 2026-08-02
tags: [studio, collaboration, availability]
links:
  [
    { type: relates-to, target: 13 },
    { type: relates-to, target: 16 },
    { type: relates-to, target: 17 },
  ]
---

# Collaboration fan-out is per-peer queues with a bounded backlog

## Context and Problem Statement

[ADR 0016](0016-collaboration-broker-is-a-loopback-first-tcp-server-with-connection-bound-authority.md)
settled the broker's shape: `std::net` plus a thread per connection, no async runtime. The fan-out it
shipped with held one mutex over the table of per-member writers and wrote to the socket **under that
lock**, and no collaboration socket carried `set_write_timeout`.

That makes one member's reading speed everybody's problem. A participant that stops reading fills its
own receive buffer, then the broker's send buffer; the next `write_frame` to it blocks; and because
the lock is held, *every* other participant's deliveries queue behind it — along with the local user's
own `send_update`/`send_presence`, since those take the same path. With no write deadline there is no
way out except that peer closing the connection.

Two things made it worth fixing now rather than filing as a latency nit:

1. [ADR 0017](0017-noise-encrypted-collaboration-transport-with-a-token-pinned-broker-key.md) encrypted
   the transport precisely so the broker could be used **off loopback**, for LAN workshops. A peer that
   stalls is unremarkable on loopback and routine on wifi — a laptop that sleeps mid-session will do
   it. The code did not change; the exposure did.
2. Holding a session hostage needs nothing but the join token. A member is authenticated as an
   *invitee*, never as trustworthy, so this is reachable by anyone who was invited — deliberately or by
   accident. On a network-facing component that is a denial of service, not a slow path.

The constraint that shapes every option is ADR 0017's: a Noise channel counts its own messages per
direction, so a connection must have **exactly one writer**, driven by exactly one thread. Any fan-out
that hands the same connection to two writers desynchronises the nonce run and every subsequent frame
fails to authenticate.

## Considered Options

* **A write deadline only.** Arm `set_write_timeout` and let a wedged peer surface as an ordinary write
  error, which `dispatch` already handles by removing and hanging up on it.
* **Take the writer out of the map for the duration of the write and put it back.** Keeps one writer per
  connection and releases the lock, at the cost of a member being briefly absent from the table.
* **A non-blocking socket plus a per-member backlog buffer**, retried on the next delivery.
* **A queue and a writer thread per connection**, with everyone else enqueueing and a bounded backlog
  deciding when a peer has fallen too far behind.

## Decision Outcome

Chosen option: **a queue and a writer thread per connection, with a bounded backlog** — and the write
deadline as well, since it costs nothing and is what bounds the writer thread itself.

We will give every accepted or dialled collaboration socket a `WRITE_TIMEOUT`, and give every
connection an `Outbound`: an `mpsc` queue whose receiving end is owned by one thread that owns that
connection's single `NoiseWriter`. `Hub::dispatch` enqueues under the links mutex and never writes to a
socket while holding it.

The backlog is charged in bytes and capped at `MAX_OUTBOUND_BACKLOG_BYTES`, with an empty queue always
admitting so that no member is ever dropped for one large update it could have absorbed. A member that
exceeds it is **disconnected**, not buffered further and not silently starved: its link is dropped,
which hangs up its socket, which wakes its connection thread into the ordinary `Hub::depart` — so the
rest of the session receives a `PeerLeave` and the dropped participant's own `read_loop` announces the
peers it lost.

A write deadline alone was rejected as the whole answer: it caps the stall instead of removing it, so
the broker would still go deaf for the length of the timeout every time a peer wedges, and it does
nothing for a peer that is merely *slow*. Taking the writer out of the map re-opens the "no writer,
delivery dropped" window this same change closes. A non-blocking socket with retry-on-next-delivery
needs a backlog buffer anyway, and then owns partial-frame state on top of a chunked Noise stream.

The same reasoning applies to the client half, where the peer is the broker: `RemoteSession::send` no
longer swallows a write error. Best-effort delivery is a property of a *lost* frame, not of a *failed*
one — a failed one, with a deadline armed, is what a wedged broker looks like, and continuing to edit
against a document nobody is receiving is the failure this change exists to prevent.

## Consequences

**Easier.** One slow peer is one peer's problem. A wedged participant no longer stalls the session, and
the local user's own edits never queue behind a remote socket. Memory is now bounded per member rather
than by whatever the kernel will buffer. Because publishing a member's link no longer covers a socket
write, it became cheap enough to do under the same hold of the broker lock that admitted it, closing
the window where a delivery addressed to a just-joined member found no writer and vanished.

**Harder / accepted trade-offs.**

* **A second thread per connection.** ADR 0016 budgeted a thread per connection at workshop scale; this
  doubles that. At `MAX_CONNECTIONS` it is still a low-hundreds thread count with no runtime added, so
  the "std + threads only" property holds — but it is a real increase, not a free one.
* **A participant can now be disconnected for being slow.** That is a new way to be removed from a
  session, and the cap is a judgement call: too low and a bad minute on wifi ends your session, too
  high and the memory bound stops meaning much. It is set to `MAX_FRAME_BYTES` and stated as a
  constant so it can be revisited against real use rather than guessed at twice.
* **Delivery is now asynchronous to `dispatch`.** A frame that `dispatch` accepted may still fail on
  the wire afterwards, so "enqueued" is not "delivered". Nothing in the protocol depended on the
  stronger reading — the CRDT replica is the source of truth and re-merges on reconnect (ADR 0013) —
  but the ordering guarantee is now "one queue per connection, in order", which is what the admission
  frame relies on to precede every delivery.
* **The tests that prove this cost real seconds.** Wedging a socket means filling a kernel buffer, and
  tripping a write deadline means waiting for it. Two tests dominate the Rust suite's runtime as a
  result; the alternative was asserting the shape of the code rather than the behaviour.
