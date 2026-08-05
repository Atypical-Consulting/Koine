# The shared path-containment corpus

`cases.json` is the accept/reject table that **both** of Koine's path-containment implementations
answer to:

| Implementation | Harness |
|---|---|
| Rust (Tauri host) — `contained_path` in `tooling/koine-studio/src-tauri/src/paths.rs` | `paths::tests::the_shared_corpus_agrees_with_this_implementation` in the same file |
| .NET — `ContainedPath.TryResolve` in `src/Koine.Compiler/Extensions/ContainedPath.cs` | `ContainedPathTests` in `tests/Koine.Compiler.Tests/` |

Two hand-written implementations of one security rule drift silently. Two hand-written test suites
that merely *look* similar drift silently too. One corpus, read by both, does not: a divergence in
either implementation reddens a build. That is the entire reason this file lives at the repository
root rather than inside either project — issue #1942, and the CVE pair (CVE-2026-27800,
CVE-2026-27976) that motivates it.

**Adding a case is the normal way to fix a containment bug.** Write the row, watch both suites go
red, fix whichever implementation is wrong.

## Schema

```jsonc
{
  "version": 1,          // bump only alongside both harnesses; they assert on it
  "cases": [
    {
      "name": "relative-under-root",              // unique; used in failure messages
      "setup": [ /* see below; may be omitted or [] */ ],
      "candidate": "themes/dark.json",            // the untrusted path handed to the primitive
      "candidateRepeat": 257,                     // optional — repeat `candidate` this many times
      "expect": "accept",                         // "accept" | "reject"
      "resolvesTo": "themes/dark.json",           // accept only — relative to the CANONICAL root
      "reason": "traversal",                      // reject only — see the reasons table
      "platforms": ["unix", "windows"]            // which OSes run this row
    }
  ]
}
```

`candidateRepeat` exists for exactly one purpose: stating a **size limit**. `{"candidate": "a/",
"candidateRepeat": 257}` is a 257-component path, and spelling that out inline would put half a
kilobyte of filler in a file people have to read. Omit it and the candidate is used as written.

### `setup` — what the harness materializes before the call

Each harness creates a private sandbox directory and, inside it, the root at **`<sandbox>/root`**.
The name `root` is load-bearing: it lets a case plant a `../rootevil` sibling whose name is a *string*
prefix of the root's, which is exactly the shape a `startsWith`/`starts_with` on strings waves
through.

| `kind` | Fields | Meaning |
|---|---|---|
| `dir` | `path`, `mode`? | `mkdir -p <root>/<path>` |
| `file` | `path`, `mode`? | write a small file at `<root>/<path>`, creating parents |
| `symlink` | `path`, `target` | create a symbolic link at `<root>/<path>` whose raw target string is `target` |

`path` is relative to the **root** and uses `/` as its separator on every OS — each harness splits it
and joins the components with the platform's own separator. It may start with `../` to reach the
sandbox *around* the root; that is how "something exists outside the root" is expressed without
naming a machine-specific directory.

`target` is handed to the OS verbatim and, per POSIX, is resolved relative to the **link's own
directory**. The corpus keeps every target relative on purpose, so no case depends on `/etc` (or any
other absolute path) existing. A symlink target pointing at an absolute path outside the root is
covered by each suite's own tests instead.

`mode` is an **octal permission string** (`"000"`, `"500"`, …) applied in a **second pass**, after
every entry in the list exists — a case that makes a directory unreadable still has to be able to
plant the symlink inside it first, so the order of the entries does not matter. It exists to express
the one condition a plain `dir`/`file`/`symlink` vocabulary cannot: *an unreadable level is not an
absent one*. Both hosts once walked straight past a directory they were denied entry to, treating a
symlink they could not read as a free name inside the root; `an-unreadable-ancestor-is-not-walked-past`
is that row. Two guarantees come with it:

- each harness **restores** the previous mode before tearing the sandbox down (a `000` directory
  defeats a recursive delete) — and before asserting, so a red row still cleans up;
- if the mode does **not** actually deny the running process — the suite is running as root, or the
  filesystem ignores Unix modes — the harness **skips** the row rather than passing it. A fail-closed
  row that "passes" without ever producing the denial proves nothing.

Symlink and `mode` cases are `unix`-only: `std::os::unix::fs::symlink` and `chmod` are Unix-gated in
the Rust harness, and creating a symlink on Windows needs Developer Mode or
`SeCreateSymbolicLinkPrivilege`, which CI runners do not reliably grant.

### `resolvesTo` — machine-independent expected output

Expressed relative to the **canonical** root (symlinks already resolved: on macOS the temp directory
sits under a `/var` → `/private/var` link, so the canonical root is not the root as passed in). Each
harness derives its own canonical root by calling **its own primitive with an empty candidate** — the
empty candidate denotes the root — and joins `resolvesTo` onto it component-wise. `""` therefore means
"the root itself".

That indirection is what lets Rust and .NET compare against the same declared value even though
`std::fs::canonicalize` returns a `\\?\`-prefixed path on Windows and .NET does not.

Comparison is case-sensitive on Unix and case-**in**sensitive on Windows, matching what each platform's
filesystem itself guarantees. This is why `windows-containment-is-case-insensitive` can declare
`Themes/Dark.json` while the candidate says `themes\dark.json`.

### `reason` — the rejection variants

| Corpus value | Rust | .NET |
|---|---|---|
| `traversal` | `PathEscape::Traversal` | `PathEscapeReason.Traversal` |
| `absolute` | `PathEscape::Absolute` | `PathEscapeReason.Absolute` |
| `symlink-escape` | `PathEscape::SymlinkEscape` | `PathEscapeReason.SymlinkEscape` |
| `malformed` | `PathEscape::Malformed` | `PathEscapeReason.Malformed` |

`malformed` is the candidate being unusable *in its own right*, decided in the lexical step before the
filesystem is touched: over the size caps (4096 UTF-8 bytes / 256 components, enforced identically by
both hosts), containing a NUL, or — on Windows — containing a component Win32 would silently rewrite.
It is deliberately not filed under `traversal`: a length limit is not a traversal, and a security
control that mislabels its own refusals teaches its callers to distrust the labels.

### `platforms`

`"unix"` and `"windows"`. A harness skips any row that does not list the OS it is running on; a row
listing both must pass on both. Each harness also asserts that *some* row applies to its platform, so
a corpus that accidentally gates everything away fails loudly instead of passing vacuously.

A row that lists **one** platform is making a claim about that platform, and every such row has a
counterpart or a reason:

| Row family | Why it is one-sided |
|---|---|
| `symlink-*`, `*-unreadable-ancestor-*` | needs `symlink(2)` / `chmod(2)`; see `setup` above |
| `a-backslash-…`, `a-colon-…`, `a-reserved-dos-device-…`, `a-triple-dot-…`, `a-trailing-space-…` (unix) | the same spelling means different things on the two platforms; each has an explicit `windows-…` twin asserting the *other* answer |
| `windows-…` | Win32-only surfaces: drive/UNC/verbatim prefixes, alternate data streams, device names, and the trailing dot/space rewrite |

`.../asset.png` is the clearest example: on Unix `...` is an ordinary directory name and the row
accepts, while on Windows Win32 strips a component's trailing dots and spaces, so `...` is a name the
OS would rewrite and `windows-a-triple-dot-is-refused` demands `malformed`.

## Where the two implementations knowingly differ

Everything above is pinned by the corpus. Three things are not, because no per-candidate row can
express them. They are recorded here, and in both implementations' header comments, so the divergence
is on the record rather than discovered:

1. **Deep symlink chains.** Rust delegates to the OS (`canonicalize` is `realpath`), so its ceiling is
   the kernel's `MAXSYMLINKS`: 32 on macOS, 40 on Linux, 63 reparse points on Windows. .NET has no
   realpath and hand-rolls the descent with a fixed budget of **32 hops** — deliberately the smallest
   of those numbers, so the .NET half can never *accept* a chain Rust would refuse. In the band above
   it (a 33–40 link chain on Linux) .NET refuses what Rust accepts. That is a false reject, not a
   containment gap: the OS refuses the caller's subsequent `open` in either case. .NET's budget is
   also spent on the **root's own** symlinks, so the effective allowance depends on where the root
   lives.
2. **Unicode normalization.** Rust's `canonicalize` reads real directory entries, so it returns the
   **on-disk** spelling — hand it an NFC name stored as NFD and NFD comes back. .NET re-joins the
   caller's own strings and never consults a directory entry, so it returns the **caller's** spelling.
   .NET compares containment with `Ordinal`, which is stricter than the filesystem's own rule (macOS
   compares normalization-insensitively), so the difference can only make .NET *refuse* a legitimate
   path — never accept an escaping one. The false reject is real: a symlink target inside the root
   stored in the other normalization form resolves to a spelling that no longer compares equal.
   **Neither host normalizes, and neither should** — normalization inside a security primitive is its
   own correctness minefield (which form? whose table version? what about a normalization-*preserving*
   filesystem?), and getting it subtly wrong turns a comparison into a hole. A caller de-duplicating
   on the returned string is comparing *spellings*, not files.
   `a-non-ascii-name-is-an-ordinary-name` pins the ASCII-equivalent behaviour — a non-ASCII name with
   no canonical decomposition, which both hosts can satisfy — so at least the shared half is gated.
3. **Returned-path form on Windows.** Rust returns `canonicalize`'s `\\?\` verbatim path, which
   suppresses further Win32 normalization; .NET returns a plain path that Win32 normalizes *again* at
   open time. That asymmetry is why the trailing dot/space rule has to exist in the lexical step
   rather than being left to the OS — see `windows-a-parent-component-with-a-trailing-space`.

## What deliberately is **not** here

Some conditions are about the *root* or about an absolute path only the harness can know, and
contorting the per-candidate schema to express them would cost more clarity than it buys. Each suite
tests these itself:

- **A root that does not exist** (must fail closed as a symlink-escape) — there is no candidate involved.
- **An absolute candidate that happens to point inside the root** (still refused: the contract is "a
  relative path under the root") — the expected value is the harness's own temp path.
- **A symlink whose target is an absolute path outside the root** (e.g. `/etc`) — machine-specific.
- **`is_contained` in isolation** (component-wise, never a string prefix; case rules per platform) —
  a unit-level property of a helper, not a call to the primitive.

Three further behaviours are consistent across both hosts but are about the **root**, not the
candidate, so no row can state them. Recorded here so they are decisions rather than accidents:

- A root that is a regular **file** is accepted as a root. The primitive answers "is it inside", and
  `<file>` is inside `<file>`; a caller that needs a directory checks that itself.
- A **relative** root (`"."`) is resolved against the process's current directory. That is a real
  boundary, just not one the primitive chose — pass an absolute root.
- The root's own symlinks are resolved first, so a root reached through a link (macOS' `/var` →
  `/private/var`) is compared, and reported, at its canonical location. Every `resolvesTo` in this
  file depends on that.

## Coverage of this platform in CI

`cargo test --locked` runs the Rust harness on ubuntu, macOS **and** windows-latest
(`.github/workflows/studio-build.yml`). The .NET harness runs on ubuntu-latest in `ci.yml`'s
`build-and-test`, and — since the `sandbox-confinement` job was added — on **macos-latest and
windows-latest** as well, filtered to `ContainedPathTests` and its neighbours. So every row is
exercised by **both** implementations on the platforms it lists, and a `windows` row is now a real
gate on the .NET half rather than a Rust-only claim: write the Windows row.
