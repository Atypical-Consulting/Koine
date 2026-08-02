---
id: 16
title: The collaboration broker is a loopback-first TCP server with connection-bound authority
status: proposed
date: 2026-08-01
tags: [studio, collaboration, security]
links:
  [
    { type: relates-to, target: 13 },
    { type: relates-to, target: 15 },
    { type: relates-to, target: 17 },
  ]
---

# The collaboration broker is a loopback-first TCP server with connection-bound authority

## Context and Problem Statement

[ADR 0013](0013-crdt-over-host-brokered-transport-for-studio-collaboration.md) chose CRDT replicas over
a **host-brokered** transport and [ADR 0015](0015-yjs-as-the-crdt-runtime-with-a-studio-owned-codemirror-binding.md)
chose Yjs as the replica. Neither says what the broker *is*. Both increments shipped with
`canCollaborate` `false` on every host, precisely because "the broker exists" was still an English
description rather than a running process: the seam, the presence layer, the CRDT binding and the
session lifecycle were all written against `createInMemoryCollabBroker()`, an in-process reference
implementation that no second machine can reach.

Task 5 of issue #481 is that process. Deciding it means answering three questions that are expensive
to reverse, because a session format and a trust model are what every future participant speaks:

1. **What carries the frames?** Studio's Rust host has, deliberately, no async runtime and no network
   stack — it is `std::process` + `std::thread` + `std::io`, and the only socket in it is a port probe.
   A broker is the first thing here that listens.
2. **Who is the document authority, and how is that decided?** PR #1786's review caught a
   self-asserted-identity flaw and PR #1803 answered it by making the *broker* the sole source of
   `authority`. That moves the burden here: the broker is now the thing that must not trust a client's
   claim about who it is.
3. **Who can reach the listener?** A join token grants edit access to somebody's domain model. The
   difference between binding loopback and binding every interface is the difference between a session
   and an open door on conference wifi.

## Considered Options

* **Length-prefixed JSON over plain TCP, `std::net` + threads, loopback by default** — one wire
  protocol, no new async runtime, no new transitive dependencies.
* **WebSocket (via `tungstenite`/`tokio`)** — the same topology over a protocol a browser tab could
  also speak.
* **WebRTC data channels** — direct peer-to-peer, NAT traversal via STUN/TURN.
* **A hosted relay service as the default path** — Koine operates the broker; both participants dial it.

## Decision Outcome

Chosen option: **length-prefixed JSON frames over plain TCP, served by `std::net::TcpListener` and a
thread per connection, bound to loopback unless the user says otherwise**, because it is the smallest
thing that actually connects two people and it stays inside the architecture the Rust host already
has. The frame codec is a 4-byte big-endian length plus a `serde` tagged-enum body — the same
"length header, then a body" shape `lib.rs` already uses for LSP `Content-Length` framing.

WebSocket was the close call, and it was rejected on cost against a benefit this task cannot bank: its
one real advantage is that a *browser* tab could dial a relay, but a browser participant also needs a
relay to exist, and Koine ships none — so paying for `tokio` + `tungstenite` (a first async runtime and
a new dependency tree across three OS legs of CI) buys a capability with nothing at the other end of it.
When a relay service is on the table, a WebSocket transport is an additive host implementation behind
the same `CollabTransport` seam, not a rewrite. WebRTC was rejected outright: NAT traversal means
signalling infrastructure and STUN/TURN servers, which is more operational surface than the hosted
backend ADR 0013 already declined. A hosted default was settled by ADR 0013 and is not reopened here.

We will therefore:

* **Bind the authority to the connection, never to a claimed identity.** A session's authority is the
  broker-minted `MemberId` of the connection that created it. `join` returns `authority: false`
  unconditionally — there is no code path, and no identity, that can produce a second authority. The
  *client* re-asserts the same thing rather than believing the answer: a participant that asked to join
  discards an `authority: true` it is handed, because a hostile broker reached through an invitation
  link would otherwise make that editor seed the shared document from its own buffer and broadcast it.
* **Let a participant speak only as the identity it was admitted under.** Every outbound presence frame
  is re-stamped from the sender's admitted identity, and a join is refused if either the participant id
  *or* the display name is already in the session — the display name and colour swatch are the only
  identity signal the UI shows, so a second "Ada Lovelace" would let a token-holder author edits everyone
  attributes to the session owner. Identity stays self-asserted (there is no account system in Phase 2)
  but it is no longer *forgeable at another participant's expense*.
* **Bound the syntax of what the renderer will interpolate, not just its length.** A participant colour
  ends up inside a `style` attribute, which parses a whole declaration list, in a webview that ships no
  CSP — so a colour is constrained to hex or a bare colour keyword at the broker, at the client's inbound
  edge (a joined broker is only as trustworthy as whoever the user pointed at), and once more at the sink
  itself.
* **Treat the join token as a bearer credential**: 128 bits from the OS CSPRNG, compared in constant
  time, never echoed into an error message or a log line. It carries the endpoint too
  (`koine-collab://host:port/secret` — extended to `…/secret/public-key` by
  [ADR 0017](0017-noise-encrypted-collaboration-transport-with-a-token-pinned-broker-key.md)), so a
  joiner needs exactly one string.
* **Default the listener to `127.0.0.1`**, with the bind address a user setting that is also the address
  advertised in the token. Opening a session must not put a listener on the local network as a side
  effect; inviting the LAN in is a deliberate edit.
* **Bound everything an unauthenticated peer controls** — frame length, identity field lengths, presence
  selection count, members per session, sessions per host, live connections, and a handshake deadline.
* **Make a relay the same program in a different role.** A relay is this broker with `Create` honoured
  over the wire and no local participant; a hosted session refuses `Create`, so reaching someone's
  desktop listener never lets you open a session on their machine. One protocol serves "the desktop
  brokers" and "a configured relay brokers", and `run_relay` in `collab.rs` is both the reference
  implementation and what makes the relay path testable end-to-end.
* **End the session when the authority leaves.** ADR 0013 explicitly left "end or hand off" open; this is
  the answer. Handing authority to a survivor means electing a winner across a network that may already
  be partitioned, and two hosts each believing they own the canonical save is exactly the lost-write bug
  the authority rule exists to prevent.

## Consequences

**Easier.** The broker is a few hundred lines of `std` with no new transitive dependencies, so
`cargo build --locked` stays honest on all three CI legs and the Rust host keeps its "no async runtime"
property. Because the broker core is pure — it returns a list of `(member, frame)` deliveries and
performs no I/O — every rule above is a unit test rather than a claim, and the socket layer on top is
tested against real loopback connections. The relay being the same code means the protocol has exactly
one implementation to keep correct.

**Harder, and accepted.** JSON-encoding CRDT bytes as a number array costs roughly 3–4× on the wire;
`.koi` models are kilobytes, so this is a knowingly-taken inefficiency that a binary frame type can fix
later without touching the trust model. A thread per connection is fine at workshop scale and would not
be at internet scale — the connection cap makes that explicit rather than implicit. Plain TCP is **not
encrypted**: on loopback that is moot, and ADR 0013's "relay traffic should be transport-encrypted"
remains outstanding for anyone binding a LAN address, which is why the default is loopback and why
widening it is a deliberate act. *(Closed by
[ADR 0017](0017-noise-encrypted-collaboration-transport-with-a-token-pinned-broker-key.md): every
connection now runs a Noise handshake against a public key pinned in the join token, so the token
grammar gained a fourth part and there is no plaintext path left. Everything else on this page — the
connection-bound authority, the identity rules, the bounds — is unchanged; ADR 0017 is additive, not a
supersession.)* Two people on different networks still need a relay to exist, and this
task ships the protocol and the client for one without shipping a service. Finally, a browser tab
remains unable to collaborate even with a relay configured, because it cannot open a TCP socket — that
gap closes with a WebSocket transport, not with configuration.
