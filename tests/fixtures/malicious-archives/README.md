# The malicious-archive corpus

`cases.json` is the accept/reject table for **`SafeArchiveExtractor`**
(`src/Koine.Compiler/Extensions/SafeArchiveExtractor.cs`), driven by `SafeArchiveExtractorTests` in
`tests/Koine.Compiler.Tests/`. It is the sibling of [`../path-containment/`](../path-containment/),
which gates the primitive this extractor is built on.

The two corpora divide the problem the way the two CVEs do:

| Corpus | Question it answers |
|---|---|
| `path-containment/cases.json` | Given a root and one untrusted path, does it stay inside? |
| `malicious-archives/cases.json` | Given an archive nobody vouched for, does *every member* stay inside — and is nothing left behind when one does not? |

Zed shipped extraction with a check on the destination and none on the members, and got
**CVE-2026-27800** (Zip Slip) and **CVE-2026-27976** (a symlink member turned into arbitrary file
write, then RCE). Every row below is one of the shapes that bug takes.

## Why there are no `.zip` / `.tar` files here

The archives are **built from this table at test time**, not committed.

- The hostile names are unproducible by an ordinary archiver — `zip` will not write you a member
  called `../../evil.txt` — so a committed artifact would be a black box whose interesting property
  is invisible in the diff and unverifiable by review.
- Committing runnable exploit archives to a public repository is worse ergonomics than committing the
  recipe: every scanner, every `git clone`, every downstream mirror inherits them.
- A recipe is reviewable and reproducible. `SafeArchiveExtractorTests` also asserts that each built
  archive *really carries* the names declared here — because if `ZipArchive`/`TarWriter` ever started
  sanitizing names on write, the whole corpus would quietly become a set of benign archives that pass
  for the wrong reason.

## The sandbox each case runs in

```
<sandbox>/
  outside/               an empty directory; a traversal aimed here must never land
  n1/n2/n3/dest/         the destination root handed to Extract
```

The destination is nested four deep on purpose: every `..` chain in this corpus lands **inside the
sandbox the test owns**, so "the escape target does not exist" is an assertion about a directory this
test created and will delete — never about `/tmp/evil.txt` or any other shared location a stale file
from an earlier run could make lie.

For every `reject` case the harness snapshots the whole sandbox before the call and requires it
byte-for-byte identical after: nothing written outside the root, nothing left inside it.

## Schema

```jsonc
{
  "version": 1,          // bump only alongside the harness; it asserts on this
  "cases": [
    {
      "name": "zip-slip-basic",              // unique; identifies failures
      "kind": "zip",                         // "zip" | "tar"
      "why": "…",                            // prose; quoted in the failure message
      "setup": [ /* optional — see below */ ],
      "limits": { "maxMemberCount": 3 },     // optional; omitted fields keep the shipped default
                                             // (maxMemberCount, maxTotalBytes, maxMemberBytes,
                                             //  maxArchiveBytes)
      "members": [ /* see below */ ],
      "expect": "reject",                    // "reject" | "accept"

      // reject only
      "reason": "member-name-traversal",
      "offendingMember": "../../evil.txt",
      "mustNotExist": ["../../evil.txt"],

      // accept only
      "filesWritten": 3,
      "directoriesCreated": 2,
      "bytesWritten": 26,
      "expectedFiles": [ { "path": "README.md", "text": "koine\n" } ],
      "expectedDirs": ["assets", "src"],

      "platforms": ["unix", "windows"]
    }
  ]
}
```

### `members` — what goes into the archive

| `type` | Fields | Written as |
|---|---|---|
| `file` | `name`, and either `text` (UTF-8) or `zeros` (a count of zero bytes, for the bombs) | a regular file member |
| `dir` | `name` | a directory member |
| `symlink` | `name`, `linkTarget` | a `TarEntryType.SymbolicLink` member in a tar; in a **zip**, an entry whose external attributes carry `S_IFLNK \| 0777` in their high sixteen bits and whose body is the target — the convention `zip -y` writes and `unzip` reads, since zip has no member-type field |
| `hardlink` | `name`, `linkTarget` | **tar only** — a `TarEntryType.HardLink` member |
| `fifo` | `name` | **tar only** — a `TarEntryType.Fifo` member |
| `meta` | `name`, `metaType` (`L`, `K`, `x` or `g`), `declaredSize` | **tar only** — a raw 512-byte metadata header block with that type flag and that size in its size field, and **no data behind it** |
| `corrupt-header` | `name` | **tar only** — a raw 512-byte member header whose **checksum field is zeroed**, which is how the format spells end-of-archive |

`name` is written into the container **verbatim**, backslashes and all. That is the whole point: these
names are the attack.

`linkTarget` may contain `{sandbox}`, replaced with the sandbox's absolute path — which is how
`tar-symlink-then-write-through` aims a link at a directory the test owns instead of at a real system
path.

The last two types are written by **hand**, straight into the stream between `TarWriter` entries,
because no container writer will produce them — that is exactly why they were missing and why the
`InvalidOperationException` a size-lying metadata header raises went unnoticed. They are skipped by
`Case_archive_carries_its_declared_member_names_verbatim`: a hand-built block is not subject to "did
the writer rewrite my name", and reading one back is the very failure the case exists to pin.

### `setup` — the filesystem as it stands before the call

Same idea as the path-containment corpus, and the reason `zip-member-under-a-pre-existing-symlink`
can exist at all: some escapes are not in the archive, they are in the destination.

| `kind` | Fields | Meaning |
|---|---|---|
| `dir` | `path` | `mkdir -p <dest>/<path>` |
| `file` | `path` | a small file at `<dest>/<path>` |
| `symlink` | `path`, `target` | a symbolic link at `<dest>/<path>` whose raw target string is `target`, resolved by the OS relative to the link's own directory |

`path` is relative to the **destination root** and always uses `/`. Setup entries are part of the
before-snapshot, so a `reject` case must leave them exactly as it found them.

A case with a `symlink` setup entry must list only the `unix` platform: creating a symlink on Windows
needs Developer Mode or `SeCreateSymbolicLinkPrivilege`, which CI runners do not reliably grant.
Note that *archive* symlink members need no such gate — they are refused before anything reaches the
filesystem, so `tar-symlink-escape` and `tar-symlink-then-write-through` run on every platform.

### `mustNotExist` — the escape targets

Each entry is a path that must not exist after the call. `{sandbox}/…` is resolved against the
sandbox; anything else is resolved **lexically** against the destination root, so `../../evil.txt`
means the place the traversal was aiming at. The blanket before/after snapshot already covers these;
they are named individually so a failure says *which* escape landed.

### `reason` — the rejection variants

| Corpus value | `ArchiveRejectionReason` |
|---|---|
| `malformed-archive` | `MalformedArchive` |
| `member-name-invalid` | `MemberNameInvalid` |
| `member-name-anchored` | `MemberNameAnchored` |
| `member-name-backslash` | `MemberNameBackslash` |
| `member-name-traversal` | `MemberNameTraversal` |
| `member-escapes-root` | `MemberEscapesRoot` |
| `link-member` | `LinkMember` |
| `unsupported-member-type` | `UnsupportedMemberType` |
| `duplicate-member` | `DuplicateMember` |
| `too-many-members` | `TooManyMembers` |
| `member-too-large` | `MemberTooLarge` |
| `archive-too-large` | `ArchiveTooLarge` |
| `destination-unusable` | `DestinationUnusable` |

### `platforms`

`"unix"` and `"windows"`. The harness skips a row that does not list the OS it is running on, and
asserts that *some* row applies — a corpus that accidentally gates everything away must fail loudly
rather than pass vacuously.

## The rows

| Case | Shape |
|---|---|
| `zip-slip-basic` | `../../evil.txt` |
| `zip-slip-nested` | `a/b/c/../../../../../evil.txt` — buried and over-popped |
| `zip-absolute-member` | `/etc/passwd`, with no `..` anywhere |
| `zip-backslash-traversal` | `..\..\evil.txt` — a traversal on Windows, a filename on Unix |
| `zip-drive-qualified-member` | `C:\evil.txt` — anchored without being rooted |
| `zip-verbatim-prefix-member` | `\\?\C:\evil.txt` — normalization bypassed |
| `zip-dot-file-member` | a file member named `.` |
| `zip-duplicate-member` | the same path twice |
| `zip-member-count-cap` | four members against a cap of three |
| `zip-bomb-member` | 32 MiB of zeros in ~32 KiB, against the **shipped** default |
| `zip-bomb-total` | three members, each legal, summing past the total cap |
| `zip-partial-then-escape` | three good members, then an escape — the rollback proof |
| `zip-member-under-a-pre-existing-symlink` | a blameless name landing under a link already on disk |
| `zip-symlink-member` | a **zip** member declaring `S_IFLNK` in its external attributes |
| `zip-symlink-then-write-through` | CVE-2026-27976's shape in the zip container |
| `zip-container-size-cap` | a container larger than the cap, refused before it is opened |
| `zip-benign` | must extract whole |
| `tar-slip-basic` | Zip Slip through the other reader |
| `tar-absolute-member` | `/etc/passwd` in a tar |
| `tar-symlink-escape` | a symlink member pointing at `/etc` |
| `tar-symlink-then-write-through` | **CVE-2026-27976 itself**: plant a link, then write through it |
| `tar-hardlink-escape` | a hard link aliasing a path outside |
| `tar-fifo-member` | a member that is not a file, directory or link |
| `tar-gnu-longname-header-size-lie` | a `'L'` header declaring more data than follows it |
| `tar-gnu-longlink-header-size-lie` | the same lie in the `'K'` header |
| `tar-pax-extended-header-size-lie` | the same lie in the pax per-entry `'x'` header |
| `tar-pax-global-header-size-lie` | the same lie in the pax global `'g'` header |
| `tar-truncated-at-a-corrupt-header-cannot-be-detected` | an **accept** row documenting a limit: a truncation the reader cannot see |
| `tar-benign` | must extract whole, including the leading `./` member |

### Why the four metadata rows exist

`TarReader` reads a metadata header ( `'L'`/`'K'` GNU long names, `'x'`/`'g'` pax attributes) eagerly,
and raises **`InvalidOperationException`** — not `InvalidDataException` — when its declared size
overruns the data behind it. That type was not on the extractor's recognised-fault list, so the
exception escaped `Extract` altogether *and* skipped the rollback (which sat on the non-throwing
path): a crafted tar both crashed the caller and left its already-written members on disk. The corpus
had **zero** tar metadata-header rows, which is exactly why it was missed. Each row keeps an innocent
first member ahead of the bad header, so a green run proves the unwind rather than only the exception
type.

### And why one row expects `accept`

`tar-truncated-at-a-corrupt-header-cannot-be-detected` is not a capability, it is a **limit written
down**. A tar's end is a zeroed header, so a header corrupted into one is indistinguishable from the
archive simply ending — the reader stops, reports no error, and the members after it are silently
never seen. `ExtractResult.Succeeded` therefore means *nothing was refused*, never *everything the
author packed came out*. Detecting a short delivery needs a signed out-of-band manifest, which is the
installer's job (#1941). The row exists so that if the semantics ever change, they change visibly.

## Adding a case

Write the row and watch it go red. That is the normal way to fix an extraction bug here — and if the
fix belongs in the *containment* rule rather than in the extractor, the row goes in
[`../path-containment/cases.json`](../path-containment/cases.json) instead, where the Rust host is
held to it too.
