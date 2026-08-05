---
id: 0020
title: One path-containment primitive per host, enforced by a build gate
status: proposed
date: 2026-08-05
tags: [security, studio, extensions, ci]
links: [{type: relates-to, target: 0012}]
---

# One path-containment primitive per host, enforced by a build gate

## Context and Problem Statement

The extension system (#1936) introduces an input class Koine has never had: **paths chosen by
someone other than the user.** Manifest asset paths (#1937), template-pack output layouts (#1938),
and archive members on install (#1941) are all strings a third party picks, and every one of them
ends at a filesystem call in the Koine Studio Tauri host or in the .NET compiler process. Those calls
run with the **host's** ambient authority. No plugin sandbox constrains them, because the host is
performing the operation on the extension's behalf — which is why WASI preopens, capability grants
(#1939) and ADR 0012's scenario confinement all miss this surface entirely.

Zed shipped exactly this surface and failed it twice in one advisory cycle. **CVE-2026-27800** (Zip
Slip, CVSS 7.4, CWE-22) validated the destination directory an extension passed in and then joined
each raw ZIP entry name onto it; the advisory names the gap in as many words — *"this validation only
applies to the destination directory parameter passed by the extension, not to individual filenames
within the ZIP archive."* **CVE-2026-27976** was a symlink inside an extension archive, turned into
an arbitrary file write and then RCE. Both are one defect: a path checked **lexically** and then
handed to a filesystem that **resolves symlinks**. Both were fixed in place, at the site, leaving the
architecture — and therefore the next new sink — unchanged.

Koine's starting position was worse than Zed's post-fix one and better than its pre-fix one: the
Tauri host had **zero** `canonicalize` calls anywhere, while `rel_path: String` parameters flowed
into filesystem operations in a dozen commands. Not a live vulnerability — those values originate in
Studio's own UI — but the mechanism was absent, and #1937/#1941 are what turn the input untrusted.
Koine also has *two* hosts with ambient authority where Zed has one, so whatever is decided has to
hold in both Rust and C# without the two drifting apart.

## Considered Options

* **A — One containment primitive per host, plus a hardened extraction routine, plus a shared fixture
  corpus.** `contained_path` in Rust and `ContainedPath.TryResolve` in .NET, both implementing
  normalize → resolve-to-nearest-existing-ancestor → canonicalize → prove-containment; a
  `SafeArchiveExtractor` built on the .NET one that validates every member; and a single accept/reject
  corpus both test suites read, so the two implementations cannot disagree silently.
* **B — Validate at each call site as extensions are added.** No shared primitive; each new sink
  checks its own input.
* **C — Reject plugin-supplied paths entirely; expose opaque handles only.** An extension that can
  only say "my theme file #2" cannot express a traversal at all.

## Decision Outcome

Chosen option: **A, with C applied wherever an API allows it**, because B is not a hypothetical
failure mode — it is the documented cause of both Zed CVEs, where the code that got it wrong and the
code that got it right sat in the same function. Per-call-site validation is a checklist humans
forget; the checklist is exactly what failed.

C was taken seriously and is genuinely stronger where it fits, and it is the recommended shape for
any new API that can express its input as a handle. It is rejected as the *global* rule because
template-pack emitters (#1938) legitimately compute output paths from the model, and no handle
vocabulary expresses "the path this emitter just derived".

We will:

1. Keep **one primitive per host** — `contained_path` (`tooling/koine-studio/src-tauri/src/paths.rs`)
   and `ContainedPath.TryResolve` (`src/Koine.Compiler/Extensions/ContainedPath.cs`) — as the only
   way a third-party-influenced path becomes a real path. Both fail closed, both return a **typed**
   rejection carrying the offending path, and neither ever falls back to the root.
2. Resolve **to the nearest existing ancestor** before canonicalizing, so a not-yet-created leaf —
   the normal case when writing output — is accepted while a symlink anywhere above it is still
   caught. This is the step Zed's first version lacked.
3. Extract archives through **`SafeArchiveExtractor`**, which resolves **every member** through the
   primitive before any join, **rejects link members wholesale**, caps member count and total
   uncompressed size, and removes partial output on any rejection.
4. Hold both implementations to **one shared corpus**
   (`tests/fixtures/path-containment/cases.json`), read by `ContainedPathTests` and by
   `paths::tests::the_shared_corpus_agrees_with_this_implementation`.
5. Make the obligation **mechanical**: `PathSinkGuardTests` and its Rust twin fail the build on a raw
   join or an unrouted command handler, with a named allowlist whose every row carries a written
   justification and whose stale rows fail too.
6. Run the platform-dependent half of this on **macOS and Windows**, not only Linux, by widening the
   existing `sandbox-confinement` CI job's filter — Windows path semantics (`\\?\`, drive-relative
   `C:evil`, alternate data streams, reserved device names, case-insensitive comparison) are where
   this class of bug hides, and 20 corpus rows exist for exactly those.

## Consequences

**Easier.** A new host API has one obvious right answer and a build that asks for it by name, instead
of a convention in a review comment. The two hosts cannot drift, because a divergence reddens a build
rather than producing a second, subtly different rule. And the awkward case — a partially-nonexistent
path — is handled once, in the place that was tested for it, rather than rediscovered at every sink.

**Slower, measurably.** Containment costs O(members × depth) filesystem calls: each member walks its
components resolving links, and the .NET side hand-rolls `realpath` (the BCL has none —
`Path.GetFullPath` is lexical and `ResolveLinkTarget` misses intermediate components). Extracting a
large archive is therefore materially more expensive than `ZipFile.ExtractToDirectory`. Accepted: an
install happens once, and the alternative is the CVE.

**Some legitimate archives are refused.** Link members are rejected wholesale rather than resolved
and re-checked. A link that lands inside the root today can be made to point outside it by a later
member, and no extension format Koine intends to support needs to ship links — but this *is* a real
restriction, taken deliberately and documented in the extraction contract rather than discovered by
whoever packages one.

**The gate needs tending.** The allowlist is the whole design's soft spot: rows are matched on
(enclosing function, text marker), so a rename asks for an edit, and a genuinely new trust class asks
for a row. That friction is the point — but a reviewer who waves rows through turns the gate back
into the culture it replaced. The stale-entry check keeps the table honest about size; only review
keeps it honest about content.

**It does not close TOCTOU.** The answer describes the filesystem at the moment of the call. An
attacker who can swap a directory for a symlink between the check and the open still wins that race.
This shrinks the window to the smallest one a path-based API can offer; a handle-based API (option C)
is what actually closes it, which is why C stays the preferred shape for new surfaces.

**It does not replace ADR 0012.** That ADR confines *scenario child processes* with each platform's
native mechanism. The sinks here run in the Tauri host and the compiler process themselves, which are
not confined and cannot be — they must serve the whole workspace. The two are complementary layers,
and this one must hold even when a capability (#1939) was legitimately granted.
