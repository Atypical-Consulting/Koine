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
      "expect": "accept",                         // "accept" | "reject"
      "resolvesTo": "themes/dark.json",           // accept only — relative to the CANONICAL root
      "reason": "traversal",                      // reject only — see the reasons table
      "platforms": ["unix", "windows"]            // which OSes run this row
    }
  ]
}
```

### `setup` — what the harness materializes before the call

Each harness creates a private sandbox directory and, inside it, the root at **`<sandbox>/root`**.
The name `root` is load-bearing: it lets a case plant a `../rootevil` sibling whose name is a *string*
prefix of the root's, which is exactly the shape a `startsWith`/`starts_with` on strings waves
through.

| `kind` | Fields | Meaning |
|---|---|---|
| `dir` | `path` | `mkdir -p <root>/<path>` |
| `file` | `path` | write a small file at `<root>/<path>`, creating parents |
| `symlink` | `path`, `target` | create a symbolic link at `<root>/<path>` whose raw target string is `target` |

`path` is relative to the **root** and uses `/` as its separator on every OS — each harness splits it
and joins the components with the platform's own separator. It may start with `../` to reach the
sandbox *around* the root; that is how "something exists outside the root" is expressed without
naming a machine-specific directory.

`target` is handed to the OS verbatim and, per POSIX, is resolved relative to the **link's own
directory**. The corpus keeps every target relative on purpose, so no case depends on `/etc` (or any
other absolute path) existing. A symlink target pointing at an absolute path outside the root is
covered by each suite's own tests instead.

Symlink cases are `unix`-only: `std::os::unix::fs::symlink` is Unix-gated in the Rust harness, and
creating a symlink on Windows needs Developer Mode or `SeCreateSymbolicLinkPrivilege`, which CI
runners do not reliably grant.

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

### `platforms`

`"unix"` and `"windows"`. A harness skips any row that does not list the OS it is running on; a row
listing both must pass on both. Each harness also asserts that *some* row applies to its platform, so
a corpus that accidentally gates everything away fails loudly instead of passing vacuously.

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

## Coverage of this platform in CI

`cargo test --locked` runs the Rust harness on ubuntu, macOS **and** windows-latest
(`.github/workflows/studio-build.yml`), so every row is exercised by at least one implementation. The
.NET suite runs on ubuntu-latest, so the `windows`-only rows are currently proven for the Rust host
only; extending a Windows .NET leg to `ContainedPathTests` would close that gap.
