---
id: 15
title: Yjs is the CRDT runtime, with a Studio-owned CodeMirror binding
status: proposed
date: 2026-08-01
tags: [studio, collaboration, dependencies]
links: [{type: relates-to, target: 13}]
---

# Yjs is the CRDT runtime, with a Studio-owned CodeMirror binding

## Context and Problem Statement

[ADR 0013](0013-crdt-over-host-brokered-transport-for-studio-collaboration.md) settled the *shape* of
Koine Studio's real-time collaboration (issue #481): CRDT replicas over a host-brokered, opaque
transport, presence first and the shared document second. It deliberately did not name a library — at
the time the presence layer carried no document authority and needed none.

The shared-document half (#481 Task 3) cannot be written without answering two questions ADR 0013 left
open, and both are hard to reverse once a session format is on the wire:

1. **Which CRDT implementation?** This is the first CRDT runtime dependency in the repo, it ships in
   every Studio bundle (web and desktop), and its binary update format becomes the thing the Tauri/Rust
   broker (#481 Task 5) and any user-configured relay carry between machines.
2. **Who owns the CodeMirror binding?** Yjs ships an official CodeMirror 6 binding,
   `y-codemirror.next`, which bundles both document sync *and* an awareness-based presence layer. Koine
   Studio already shipped its own presence layer in PR #1786 — decorations, a `StateField`, hostile-frame
   validation, and a reconfigurable `Compartment` — built on the `Platform` transport seam rather than
   on Yjs awareness.

## Considered Options

* **Yjs + a Studio-owned binding** — take `yjs` for the replica and write the ~200-line
  CodeMirror↔`Y.Text` translation in-repo, keeping the presence layer that already shipped.
* **Yjs + `y-codemirror.next`** — take the official binding wholesale, including its awareness-based
  presence.
* **Automerge** — the other mature text CRDT, with a richer document model and a Rust core compiled to
  WASM.
* **A hand-rolled CRDT** — no runtime dependency at all.

## Decision Outcome

Chosen option: **Yjs (`yjs` 13.x) as the CRDT runtime, with the CodeMirror binding owned in this
repo**, because it is the smallest dependency that gets convergence right, and because the binding is
the one part that has to answer to Koine's own seams rather than to Yjs's.

Yjs over Automerge on weight and fit: `yjs` pulls one small pure-JS dependency (`lib0`) and no WASM,
which matters for a browser host that already loads a WASM compiler — Automerge's WASM core would be a
second, larger one, and its richer document model buys nothing for a feature whose shared state is
exactly one plain-text buffer. A hand-rolled CRDT was never seriously in play: convergence under
concurrent edits is precisely the part that is easy to get subtly, silently wrong, and ADR 0013 chose a
CRDT to *stop* owning that problem.

`y-codemirror.next` was rejected for a narrower reason than quality: it is two features, and Koine needs
one. Its presence half is built on Yjs awareness, which would mean a second presence path alongside the
one PR #1786 already shipped over the `Platform` transport — two wire formats, two renderers, and a
`canCollaborate` capability gate that only governs one of them. Taking only its document half is not
supported. The translation we write instead is small, and owning it keeps attach/detach on the same
`Compartment` discipline as every other Studio editor feature.

We will therefore:

* Depend on **`yjs`** from `tooling/koine-studio` only. It is a Studio runtime dependency: no compiler
  project, emitter, or CLI references it, per ADR 0013's containment rule.
* Bind the buffer through **`src/editor/collab/crdtBinding.ts`**, installed in its own `Compartment`
  (`KoineEditor.setCrdtEnabled`) so a session attaches and detaches mid-edit without rebuilding the view.
* Keep the **presence layer from PR #1786** as the only presence path. Yjs awareness is not used.
* Agree **one shared-text key** (`SHARED_TEXT_KEY = 'koi'`) across every replica, reached only through
  `sharedText(doc)` — replicas reading different keys would silently never see each other.
* Treat the delta↔`ChangeSet` translation as **untrusted arithmetic**: the binding tags both directions
  to break echo loops, and after every inbound update it checks that the buffer still equals the replica,
  resynchronising wholesale when it does not. A silently drifting document is the failure mode that
  matters here, and it is cheap to rule out at `.koi` sizes.

## Consequences

**Easier.** Convergence, offline merge, and reconnect are the library's problem, not ours; the binding
is small enough to read in one sitting and is pinned by tests that drive two live editors through
concurrent edits. Keeping one presence path means the `canCollaborate` capability gate governs the whole
feature, and the broker in #481 Task 5 has exactly one wire format to carry.

**Harder.** Studio takes on a runtime dependency whose binary update format is effectively part of the
session protocol: changing CRDT libraries later would break compatibility with any deployed broker or
relay, so this is a one-way door in practice. Owning the binding means owning the coordinate translation
between CodeMirror's original-document offsets and Yjs's sequential ops — the class of bug the
buffer-equals-replica check exists to catch — and it means re-reading `y-codemirror.next` ourselves when
Yjs changes, rather than getting fixes for free. Yjs metadata also grows monotonically over a long
session; compaction is not addressed here and is left to the session/broker work.
