---
id: 13
title: Studio real-time collaboration uses a CRDT over a host-brokered transport
status: proposed
date: 2026-08-01
tags: [studio, collaboration]
links: [{type: relates-to, target: 9}]
---

# Studio real-time collaboration uses a CRDT over a host-brokered transport

## Context and Problem Statement

Domain-Driven Design is a workshop discipline: a ubiquitous language is argued out between a Domain
Developer and an Architect, together, in front of one model. Koine Studio is single-user. Two people
who want to model a `.koi` side by side today export a share link or a `.zip`, paste diffs into chat,
or screen-share and dictate edits — one-way, point-in-time, reconciled by hand.

Issue #259 split that gap in two. **Phase 1** — span-anchored review comments persisted to a
`.koine/reviews.json` sidecar — shipped in PR #454 and is asynchronous. **Phase 2** (issue #481) is
synchronous co-editing, and it is the half that needs infrastructure the repo does not have: there is
no WebSocket, CRDT, or OT machinery anywhere in the codebase, and no notion of a second participant.

Three constraints shape the answer, and none of them is negotiable:

1. **The browser sandbox.** A plain tab can neither listen as a server nor dial an arbitrary peer.
   Whatever carries edits between participants must be brokered by a host that can — the Tauri desktop
   shell (which already brokers a PTY and the `koine lsp` child) or an external relay.
2. **The `Platform` seam.** Studio's UI never imports Tauri APIs or the WASM runtime directly; every
   host capability arrives through `src/host/types.ts` as a `canX` flag plus an optional factory, and
   the UI degrades gracefully rather than throwing where the flag is false.
3. **The compiler boundary.** Collaboration is a Studio *runtime* concern. `Ast/` is target-agnostic
   and the compiler must never learn that sessions, participants, or cursors exist.

The decision to record is what the convergence mechanism and the transport topology are, because both
are expensive to reverse: they determine whether Koine must operate a server, and they are baked into
the editor binding, the session lifecycle, and the desktop host all at once.

## Considered Options

* **CRDT (Yjs-style) replicas over a host-brokered transport** — each participant holds a replica; the
  host (desktop sidecar, or a user-configured relay) fans opaque update blobs and presence frames
  between them; merge logic is entirely client-side.
* **Operational Transformation (OT) with a central authoritative server** — the Google-Docs model: a
  server receives, transforms, and totally orders every operation.
* **A fully-hosted SaaS collaboration backend** — one multi-tenant service owns the document, auth,
  storage, and session state.
* **Screen-sharing instead of co-editing** — no new infrastructure; one person edits and the others
  watch over an existing call tool.

## Decision Outcome

Chosen option: **CRDT replicas over a host-brokered transport**, because it is the only option that
converges without requiring Koine to operate a server, and it is the only one whose failure modes suit
a desktop-first tool: replicas merge peer-wise, so a participant who drops offline keeps editing
locally and re-merges on reconnect instead of losing keystrokes or hitting a manual merge.

OT was rejected as the default because its central authority is not an implementation detail — it is a
*requirement*. Adopting it would mandate an always-on server for a capability #259 itself classifies as
a differentiator rather than table-stakes, and it makes offline and reconnect awkward exactly where the
CRDT is strongest. It only wins when you already run the server, which we do not. A hosted SaaS backend
has the simplest conflict story but adds an operational, auth, and privacy surface — someone's domain
model streaming to our servers — out of proportion to the feature; it is retained as an *optional relay*
a user may configure, never the default path. Screen-sharing is the status-quo workaround, not a
product answer: no shared cursor authority, no convergence, and the model lives on one machine.

We will therefore:

* Expose collaboration as a `Platform` capability: `readonly canCollaborate: boolean` gating an optional
  `createCollabTransport?(): CollabTransport`, exactly as `canRunShell` gates `createTerminal`. The
  factory exists **iff** the flag is true; a host that cannot broker omits it and the UI renders a
  graceful "desktop only / configure a relay" placeholder. A bare browser tab is always `false`.
* Keep the transport **opaque**: it moves CRDT-update bytes and presence frames and does not understand
  `.koi`. Merge logic lives in the client; the broker only fans out, never transforms.
* Ship in two layers, **presence first**. Presence — remote carets and selections, rendered as
  CodeMirror decorations — is ephemeral and carries **no document authority**, so a lost or stale frame
  can only mis-paint a decoration that the next frame supersedes. It is independently useful and cannot
  corrupt a buffer, which makes it the right thing to land before the shared document.
* Make the **session creator the document authority**: it owns the canonical `.koi` save. Other
  participants edit a replica, and the UI states who can save.
* Treat the **join token as a secret** — short-lived, never logged. It grants edit access to the model,
  so brokering defaults to the desktop host or a *user-configured* relay, never a default public
  service, and relay traffic is transport-encrypted.
* Keep every part of this inside `tooling/koine-studio` and the desktop host. Nothing about sessions,
  participants, or presence reaches `Ast/`, the validators, or any emitter.

## Consequences

**Easier.** Convergence stops being an application concern: concurrent edits merge by construction, so
there is no lock, no server-side transform, and no manual reconciliation to build or debug. Offline and
flaky-network behaviour comes for free — a replica accepts edits while disconnected and re-merges on
reconnect. Because the broker is behind the `Platform` seam and moves opaque bytes, the Tauri sidecar
and an optional relay are interchangeable, and a future transport is a new host implementation rather
than a change to the editor. Presence, having no document authority, can ship and be tested on its own.
And a browser tab that cannot collaborate is a *supported* state, not a broken one.

**Harder, and accepted.** A CRDT is a real dependency with real weight: its metadata grows over a long
session, and "compact or restart the session" becomes a question we will eventually have to answer.
Debugging a convergence bug means reasoning about replica state across machines, which is harder than
inspecting one server's ordered log — the OT option's genuine advantage, given up deliberately. Every
client must run the CRDT, so a thin relay cannot offload work from a weak participant. Some questions
this ADR deliberately does not settle, because they belong to the implementing tasks: what happens when
the authority leaves (end the session or hand authority off — pick one and stick to it), and whether
co-editing extends past the single active document. Finally, `canCollaborate` stays `false` on **every**
host, desktop included, until the session broker actually ships: the capability convention makes the
flag a promise the UI acts on, and claiming a capability with no factory behind it would be worse than
not having it.
