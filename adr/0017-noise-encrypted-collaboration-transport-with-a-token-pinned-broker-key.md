---
id: 17
title: Collaboration traffic is Noise-encrypted with the broker's key pinned in the join token
status: proposed
date: 2026-08-02
tags: [studio, collaboration, security]
links:
  [
    { type: relates-to, target: 13 },
    { type: relates-to, target: 16 },
  ]
---

# Collaboration traffic is Noise-encrypted with the broker's key pinned in the join token

## Context and Problem Statement

[ADR 0013](0013-crdt-over-host-brokered-transport-for-studio-collaboration.md) said relay traffic
"should be transport-encrypted".
[ADR 0016](0016-collaboration-broker-is-a-loopback-first-tcp-server-with-connection-bound-authority.md)
shipped the broker without it and recorded the gap honestly: plain TCP, mitigated by defaulting
`collab.bindAddress` to `127.0.0.1`.

So the protection was the **default**, not the protocol — and the default is precisely what a user
changes to do the thing the feature exists for. Set a LAN address to run a modelling workshop and the
session carries the domain model, every participant's identity and cursor position, and the join token
itself in cleartext across the network. The token is a bearer credential for edit access, so anyone on
the same wifi can both read the model and take it over. Issue #1811 is closing that.

Three questions decide the shape, and two of them are easy to answer wrongly:

1. **What provides the encryption?** ADR 0016 bought a broker with no async runtime and no new
   transitive dependency tree, explicitly rejecting `tokio` + `tungstenite` on that basis. Whatever we
   add has to survive the same test on all three CI legs.
2. **Who is authenticated, and by what?** This is where an encrypted transport can be *worse* than an
   honest plaintext one. A tunnel that encrypts to whoever answers the socket invites people to bind a
   LAN address believing they are safe, while a machine in the middle terminates the connection and
   reads everything. Encryption that authenticates nobody is a false floor.
3. **Does this quietly re-introduce trust in client-supplied identity?** PR #1786's review caught
   `authority` being decided by a *self-asserted* participant id; ADR 0016 moved authority onto the
   broker and bound it to the connection. A handshake that started treating a peer's claimed identity
   as authenticated would undo that, so the design has to be explicit that it does not.

## Considered Options

* **TLS with a session-scoped self-signed certificate, its fingerprint pinned in the join token** —
  the shape issue #1811 proposed first; `rustls` + `rcgen`.
* **Noise (`snow`), pattern `Noise_NK_25519_ChaChaPoly_BLAKE2s`, with the responder's static public
  key pinned in the join token** — a vetted library implementing a vetted protocol, over the blocking
  sockets already in use.
* **A Noise `NNpsk0`-style handshake keyed off the join secret itself** — no key to distribute at all.
* **Wait for the WebSocket transport (#1810) and get `wss://` from an existing stack.**
* **Encrypt only when the bind address is not loopback**, keeping the plaintext path for local use.

## Decision Outcome

Chosen option: **Noise `Noise_NK_25519_ChaChaPoly_BLAKE2s` via `snow`, on every connection
unconditionally, with the broker's X25519 static public key pinned by the dialler from the join
token**, because it authenticates the broker without any certificate machinery, needs no async
runtime, and leaves no unencrypted code path to downgrade to.

We will therefore:

* **Encrypt every connection, with no negotiation.** Hosted, joined and relayed connections all run
  the same handshake, loopback included. #1811 asked for a refusal to bind non-loopback without
  encryption; making encryption unconditional satisfies that structurally rather than with a check
  someone can forget or bypass, and there is no version-negotiation step for an attacker to strip.
  A peer that speaks the pre-#1811 plaintext framing is dropped before its first frame is parsed.
* **Pin the responder's static key in the join token**, whose grammar becomes
  `koine-collab://<host>:<port>/<secret>/<public-key>`. A hosted session mints a fresh keypair per
  session; a relay mints one at startup and publishes it in its endpoint. There is no CA, no trust
  prompt, and no key file — the token the host already hands over out-of-band is the trust anchor.
* **Refuse to dial a relay with no pinned key.** `collab.relayUrl` must be `host:port/<public-key>`;
  anything else is an error, not a fallback. A relay belongs to neither participant, so an unpinned
  one is simply "whoever answered".
* **Keep the initiator anonymous at the crypto layer, and say so.** `NK` authenticates the responder
  only. The joiner is authenticated exactly as it was before — by the bearer secret — which now travels
  *inside* the tunnel instead of in the clear on the first frame. Authority stays connection-bound and
  presence stays re-stamped from the admitted identity (ADR 0016); nothing about identity became more
  trusted.
* **Keep the client's authority re-assertion.** Pinning proves you reached the broker named in the
  token; it says nothing about whether whoever sent you that token is honest. A hostile broker mints
  its own keypair and its handshake completes perfectly, so the rule that a participant which asked to
  *join* discards an `authority: true` remains load-bearing and is still tested against a hostile
  broker that now speaks Noise.

`snow` won over `rustls` + `rcgen` on dependency weight for the same guarantee: certificate generation,
parsing and validation are machinery we would carry in order to then ignore the PKI entirely and pin a
fingerprint. Keying the handshake off the join secret (`NNpsk0`) was rejected because a relay hosting
several sessions cannot know which pre-shared key applies before the first message, and a relay
`create` has no secret yet — it would have forced trial decryption or a second, weaker path. Waiting
for #1810 was rejected because the exposure is live now and a WebSocket transport is an additive host
implementation behind the same seam, not a reason to leave this open. Encrypting only off-loopback was
rejected as two code paths where one will do, and as a decision the user has to get right.

## Consequences

**Easier.** One code path, so "is this session encrypted?" has no answer other than yes. The join
token stops being readable on the wire, which was the sharpest edge: it granted edit access and it was
sent in the clear on frame one. Because both handshake messages carry ephemeral keys, sessions are
forward-secret — traffic recorded today stays unreadable if the token leaks tomorrow. And for a hosted
session the broker's key is token-scoped, so an initiator cannot even *form* a valid first message
without the token: a port scanner gets silence rather than a rejection message. The transport stayed
`std` + threads, and the frame codec did not change at all — `NoiseReader`/`NoiseWriter` are a `Read`/
`Write` layer the existing length-prefixed JSON stacks straight onto.

**Harder, and accepted.**

* **One new dependency.** `snow` and its pure-Rust primitives (`curve25519-dalek`,
  `chacha20poly1305`, `blake2`). Only the primitives this pattern names are enabled; in particular
  `snow`'s `std` feature is *not*, because it declares `ring/std` rather than `ring?/std` and would
  otherwise pull a C-compiled crate into the lock on all three CI legs.
* **Tokens got longer** (64 more characters) and the grammar changed, so a token minted by an older
  build is refused. Both ends are the same Studio build in practice, and refusing is the point: the
  alternative is dialling unencrypted.
* **The Noise state cannot be `&mut`-shared**, so the socket layer uses snow's
  `StatelessTransportState` with an explicit per-direction nonce. A connection therefore has exactly
  one writer; two would each restart the nonce run and desynchronise the peer.

**What this protects against.** A passive eavesdropper on the path (the workshop wifi) — the model,
the participant list, cursor positions and the join secret are all confidential. An active attacker on
the path — frames are AEAD-authenticated, so tampering, injection, replay and reordering are refused
rather than delivered. Impersonating the broker — the pinned key means a machine in the middle cannot
answer for it. Reaching a hosted session's port without the token — the handshake cannot be started.

**What this does NOT protect against, stated plainly:**

* **Peers are not authenticated as people.** There is no account system (ADR 0016) and this does not
  add one. Anyone holding the join token is a legitimate participant; forwarding that token to a
  stranger grants them everything it grants you. The token remains the whole credential.
* **A relay is a trusted component.** It terminates the encryption, because it has to read frames to
  fan them out. This is hop-by-hop confidentiality to the broker, **not** end-to-end between
  participants: a relay operator sees the model, the identities and the cursors in the clear. Running
  a session through a relay is trusting whoever runs it. (A hosted session has no such third party —
  the host *is* the broker.)
* **Key distribution is out of band.** The token — and a relay's public key — reach a participant over
  whatever channel the host chose. An attacker who controls that channel controls what gets pinned,
  and pinning the wrong key faithfully authenticates the wrong broker.
* **A malicious participant.** A legitimate token holder can still author bad edits; the CRDT merges
  them. ADR 0016's authority and identity rules bound what such a peer can *pretend to be*, not what
  it can *do*.
* **Traffic analysis.** Frame sizes and timing are visible to anyone on the path, so activity and
  rough document size leak even though content does not.
* **Truncation at a frame boundary.** Noise has no in-band "the stream ends here" marker, so an
  attacker who cuts the connection cleanly between chunks is indistinguishable from a peer that hung
  up: the session reports the peer as having left rather than as having been cut off. Content stays
  confidential and no partial frame is ever delivered, and the same attacker could reset the TCP
  connection regardless — so this is an accuracy limit on *why* a session ended, not a way in.
* **A compromised endpoint.** Session keys live in process memory; the private key is kept out of
  `Debug` renderings, but this is not defence against someone on the machine itself.
* **Denial of service.** ADR 0016's bounds (frame size, member and session caps, connection cap,
  handshake deadline) still apply and are still ceilings rather than prevention.
