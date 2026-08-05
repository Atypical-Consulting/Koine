---
title: "Path containment"
description: "The containment contract for third-party-supplied paths: one primitive per host, a hardened extraction routine, and a build that fails on an unguarded sink."
---

:::note
Koine's extension system is still being built. Nothing on this page is an API you can call from an
extension today — it is the **security contract that system is being built on**, written down before
the features that will depend on it exist, so they can be built against it rather than retrofitted
onto it.
:::

Extensions introduce a class of input Koine has never had: **paths chosen by someone other than the
user.** A manifest naming its theme file, a template pack computing an output layout, a downloaded
archive naming its members. Every one of them eventually reaches a filesystem call in the Koine
Studio Tauri host or the .NET compiler process — and those calls run with the **host's own ambient
authority**, not the extension's. No plugin sandbox constrains them, because the host is performing
the operation on the extension's behalf.

The rule that follows from that is short:

> **Any host API that accepts a path an extension can influence must resolve it through the
> containment primitive, and must use the path the primitive returns.**

## Why this page exists

Zed shipped exactly this surface and failed it twice in one advisory cycle:

- **CVE-2026-27800** — Zip Slip in the extension installer (CVSS 7.4, CWE-22). The destination
  directory the extension passed in *was* validated; the individual entry names inside the ZIP were
  not, so an entry called `../../..` escaped it.
- **CVE-2026-27976** — a symlink inside an extension archive pointing out of it, turned into an
  arbitrary file write and then code execution.

Both are one bug wearing two outfits: a path checked **lexically** and then handed to a filesystem
that **resolves symlinks**. Both were fixed at the call site, which leaves the next new sink exactly
as exposed as the last one was. Koine's answer is one audited primitive per host plus a gate that
fails the build when a sink forgets to call it.

## The primitive

```rust
// tooling/koine-studio/src-tauri/src/paths.rs
pub fn contained_path(root: &Path, candidate: &Path) -> Result<PathBuf, PathEscape>;
```

```csharp
// src/Koine.Compiler/Extensions/ContainedPath.cs
public static bool TryResolve(
    string root, string candidate, out string resolved, out PathEscapeReason reason);
```

Four steps, each load-bearing:

1. **Refuse an anchored candidate.** Absolute (`/etc/passwd`), rooted (`\Windows\…`), or
   prefix-qualified (`C:\…`, the drive-relative `C:evil`, `\\server\share`, the verbatim `\\?\C:\…`).
   The contract is *a relative path under the root*, so an absolute path is refused even when it
   happens to point inside.
2. **Normalize lexically**, without touching the filesystem, so a hostile candidate is rejected
   before it can make the host `stat` anything. This is also where a candidate that is not a usable
   name at all is refused: longer than **4096 UTF-8 bytes** or more than **256 components**, carrying
   a NUL, or — on Windows — carrying a component the OS would silently rewrite (Win32 strips trailing
   dots and spaces).
3. **Resolve against the real filesystem.** The normal case is a file that does not exist yet, so
   this walks up to the nearest **existing** ancestor, canonicalizes *that*, and re-appends the
   missing tail. This is the step a purely lexical check omits, and the one that catches a symlink.
   .NET's `Path.GetFullPath` normalizes lexically and does **not** resolve symlinks — using it alone
   is the CVE-2026-27976 hole verbatim. The walk **fails closed on a level it cannot read**: "I could
   not look" is not "nothing is here", and treating an unreadable directory as a free name is how a
   symlink gets sailed past.
4. **Prove containment** against the canonicalized root, **component-wise** — never a string prefix,
   or `/srv/rootevil` passes a `/srv/root` check. Case-insensitively on Windows, case-sensitively
   elsewhere.

### The contract

| Input (under root `/ext/acme`) | Result |
| --- | --- |
| `themes/dark.json` | `/ext/acme/themes/dark.json` |
| `../../etc/passwd` | **reject** — traversal |
| `/etc/passwd` | **reject** — absolute (even if it pointed inside) |
| `link` → symlink to `/etc` | **reject** — the resolved target escapes |
| `new/dir/out.go` (leaf does not exist yet) | **accept**, resolved via the nearest existing ancestor |
| `a/../b.json` (stays inside) | `/ext/acme/b.json` — normalized, accepted |
| `file.txt:stream`, `CON`, `NUL.txt` (Windows) | **reject** — an alternate data stream or a device |
| over 4096 bytes, over 256 components, or containing a NUL | **reject** — malformed, before any `stat` |
| `trailing. `, `name ` (Windows) | **reject** — malformed; Win32 would rewrite the component |
| a candidate under a directory the process may not read | **reject** — containment could not be proven |

Rejection is a **typed error carrying the offending path** — `PathEscape::{Traversal, Absolute,
SymlinkEscape, Malformed}` in Rust, `PathEscapeReason` in .NET with the same four values. Never a
panic or an exception, and never a silent fallback to the root: a fallback turns a rejected attack
into a write the caller did not expect and never sees.

### Things worth knowing before you call it

- **The root must exist.** Containment is proven against the canonical root, so a root that cannot be
  canonicalized is refused rather than guessed at. Create the root first.
- **A dangling symlink is refused.** Its target does not exist, so containment cannot be proven for
  it; treating it as a not-yet-created name hands back a path that writes wherever the link points.
- **Use the returned path — for the filesystem call.** Symlinks in the existing part are already
  resolved. Re-deriving `root.join(candidate)` afterwards throws away exactly the resolution that made
  the check safe.
- **Do not hand the returned path back to the caller as an identity.** It is *canonical*, so it is
  spelled differently from the path the caller passed: on macOS every temp-dir workspace sits behind
  `/var` → `/private/var`, and on Windows the canonical form carries the `\\?\` verbatim prefix that
  nothing else does. A caller that compares paths by string — Studio's frontend decides which opened
  root a token belongs to exactly that way — then sees a file that belongs to no root at all. The rule
  has two halves: **resolve for the write, re-anchor for the answer.** Once containment is proven,
  join the same relative path onto the caller's own root string and return *that*.
- **The root itself is a valid answer** (from an empty or `.` candidate). A caller that needs a file
  rather than a directory must say so itself; the primitive answers *is it inside*, nothing more.
- **TOCTOU.** The answer describes the filesystem at the moment of the call. An attacker who can swap
  a directory for a symlink between the check and the open wins that race — an inherent limit of
  path-based checks. This shrinks the window to the smallest one a path-based API can offer; it does
  not close it.

## The extraction contract

Archive extraction gets its own hardened routine
(`src/Koine.Compiler/Extensions/SafeArchiveExtractor.cs`), because the CVE was in the *members*, not
the destination:

1. Every **member name** is resolved through the primitive, **per member**, before any join — not
   once on the destination directory.
2. **Link members are rejected wholesale, in both containers.** A symlink or hardlink entry is
   refused whether or not its target escapes. Tar states the member type in a header flag; a zip has
   no such field, so a Unix-authored one puts `S_IFLNK` in the high sixteen bits of the entry's
   external attributes and writes the target as the member's body — both are refused. Resolving them
   and re-checking is defensible, but a link that lands inside the root today can be made to point
   outside it tomorrow by a later member, and no extension format Koine intends to support needs to
   ship links.
3. A **member-count cap, a per-member and a total uncompressed-size cap, and a cap on the container's
   own size** bound decompression-bomb blow-up. The last one is the only cap that can be charged
   before the archive is opened, which matters because a zip's central directory is materialized in
   full before the first member is handed back — an archive declaring 200 000 members against a cap
   of 8 is refused correctly *and* costs several times its own size in allocation getting there.
   Bounding that fully is the caller's job: cap the download, and pass a container cap sized to what
   you expect rather than leaving the generous default in place for untrusted input.
4. On any rejection the **whole extraction aborts and its partial output is removed** — never a
   half-installed extension. That unwind runs on *every* exit path, including a fault the extractor
   does not recognise and deliberately lets propagate: an escaping exception over a half-written
   destination is how a crash becomes a half-installed extension.
5. **Success means "nothing was refused", not "everything present was extracted".** A tar's end is
   spelled by a zeroed header, so an archive cut at — or corrupted into — one is indistinguishable
   from an archive that simply ended: the reader stops, reports no error, and the members after it
   are silently never seen. Detecting a short delivery needs a **signed, out-of-band manifest**,
   obtained through a channel the archive does not control. The installer must verify against one;
   the extraction result is not a substitute.

## The gate

A helper nobody is *required* to call is a helper someone will forget, so the obligation is checked
mechanically rather than culturally:

- **`PathSinkGuardTests`** (`tests/Koine.Compiler.Tests/`) reads both hosts' source and fails, naming
  the file, line and offending text, on a `Path::join` outside the primitive in the Tauri host, on any
  `#[tauri::command]` **parameter** whose type could name a path (`String`, `str`, `Path`) that the
  body does not hand to `resolve_in`/`contained_path`, and on a raw `Path.Combine` / `Path.Join` /
  `Path.GetFullPath` or a concatenated path anywhere under `src/Koine.Compiler/Extensions/`.
- The obligation is **per parameter, and keyed on the type rather than the name**. Both halves are
  the correction of a real miss: a name-shaped rule (`rel`, `path`, …) reported `move_entry` as
  satisfied because it routes `new_rel_path`, while its *other* path parameter went unexamined, and
  never reported `delete_entry` at all. A name rule can only catch the names somebody thought of.
- **`paths::tests`** enforces the same two Rust rules under `cargo test`, so they hold on all three
  operating systems the Studio host is built for.
- Every exception is a **named allowlist row with a written justification**, and an entry whose site
  has disappeared fails too — an allowlist that only ever grows is a rubber stamp.
- Both implementations answer to **one shared accept/reject corpus**
  (`tests/fixtures/path-containment/cases.json`), read by the .NET suite and the Rust suite alike, so
  the two hosts cannot drift apart silently. Archive shapes have their own corpus at
  `tests/fixtures/malicious-archives/cases.json`.

:::caution[The gate is an accounting property, not a safety property]
It proves every path-capable parameter is *accounted for* — routed, or written down with a reason. It
does not prove they are all contained, and some are deliberately not. The absolute explorer tokens
`move_entry`, `delete_entry` and `rename_entry` take are user-chosen paths in the file-dialog trust
class, which this work put out of scope on purpose; their allowlist rows say so in as many words, and
issue #1950 tracks containing them. A row claiming a safety that does not hold would be worse than no
row at all.
:::

## Adding a host API that takes a plugin-supplied path

1. Take the untrusted value as a **relative** path, and keep the root out of the caller's hands.
2. Resolve it through `contained_path` / `ContainedPath.TryResolve` against that root, and use the
   returned path for the filesystem call.
3. If the API returns a path, **re-anchor it on the caller's own root** rather than returning the
   canonical one — see "do not hand the returned path back as an identity" above.
4. Report a rejection as an error naming the rule that was broken — but echo back only the caller's
   own relative path, never the absolute path it resolved to. That path lies outside the root by
   construction, and an extension has no business learning the host's filesystem layout from an error
   string.
4. If the value is genuinely a different trust class — a path the user picked in the OS file dialog,
   a pathspec handed to the `git` binary — add the allowlist row and say why. The build will ask you
   for it either way.

Prefer an **opaque handle** over a path wherever the API allows it: an extension that can only say
"my theme file #2" cannot express a traversal at all. That is not the global rule only because some
consumers legitimately compute output paths from the model.

The decision and its trade-offs are recorded in
[ADR 0021](https://github.com/Atypical-Consulting/Koine/blob/main/adr/0021-one-path-containment-primitive-per-host.md).
