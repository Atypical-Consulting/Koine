// Koine Studio — path containment for third-party-supplied paths (#1942).
//
// WHY THIS EXISTS. Koine Studio's Tauri host runs with the user's ambient authority: every
// `std::fs` call in `lib.rs` can write anywhere that user can. That was tolerable while every path
// came from the user's own file dialog. It stops being tolerable the moment an EXTENSION supplies
// one — a third party then chooses a string that reaches a filesystem sink, and "the extension is
// confined to its own directory" becomes a claim the host has to actually enforce rather than
// assume.
//
// Zed learned this the expensive way, twice in one advisory cycle: CVE-2026-27800 (Zip Slip — an
// archive entry named `../../..` escaping the extraction directory) and CVE-2026-27976 (a symlink
// inside an extension archive pointing out of it, turned into arbitrary file write and then code
// execution). Both are the same bug wearing different clothes: a path was validated LEXICALLY and
// then used against a filesystem that resolves symlinks. This module is the primitive their
// hardened `writeable_path_from_extension` ended up being — and it does the step their first
// version lacked, which is resolving symlinks before deciding.
//
// THE SHAPE. `contained_path(root, candidate)` either returns a real, resolved path under `root`
// or a typed `PathEscape` naming the offending path. There is deliberately no third outcome: no
// panic, and no silent "fall back to the root", because a fallback turns a rejected attack into a
// write the caller did not expect and never sees.
//
// It fails CLOSED. Anything it cannot prove contained is refused: a root it cannot canonicalize, a
// dangling symlink, a name Windows would reinterpret as a device or a stream. Refusing a legitimate
// path is an annoyance; accepting a malicious one is the CVE.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// Why a candidate path was refused. Each variant carries the offending path so the call site can
/// say something useful — flatten it into an `io::Error` or a Tauri command's `String` error via
/// [`Display`], which is how the rest of this crate reports failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathEscape {
    /// The candidate walked out of the root with `..`. Carries the candidate as supplied.
    Traversal(PathBuf),
    /// The candidate was anchored rather than relative — absolute, rooted, or (on Windows)
    /// drive/prefix-qualified, an alternate data stream, or a reserved device name. Carries the
    /// candidate as supplied.
    Absolute(PathBuf),
    /// Containment could not be established once the filesystem had its say: the candidate resolves
    /// outside the root through a symlink, the root itself cannot be canonicalized, or a component
    /// cannot be resolved at all (a dangling symlink). Carries the path that could not be proven
    /// contained — the resolved path where one exists, otherwise the root or the normalized
    /// candidate.
    SymlinkEscape(PathBuf),
}

impl fmt::Display for PathEscape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathEscape::Traversal(p) => {
                write!(f, "path escapes the root with `..`: {}", p.display())
            }
            PathEscape::Absolute(p) => {
                write!(f, "path must be relative to the root: {}", p.display())
            }
            PathEscape::SymlinkEscape(p) => {
                write!(f, "path resolves outside the root: {}", p.display())
            }
        }
    }
}

impl std::error::Error for PathEscape {}

/// Resolve `candidate` — a path chosen by someone we do not trust — to a real path under `root`,
/// or explain why it does not belong there.
///
/// The steps, in order, and each one is load-bearing:
///
/// 1. **Refuse an anchored candidate.** Absolute (`/etc/passwd`), rooted (`\Windows\…`), or
///    prefix-qualified (`C:\…`, the drive-RELATIVE `C:evil`, `\\server\share`, the verbatim
///    `\\?\C:\…`) — all [`PathEscape::Absolute`]. The contract is "a relative path under the root",
///    so an absolute path is refused even when it happens to point inside.
/// 2. **Normalize lexically, without touching the filesystem.** `.` is dropped and `..` pops, so
///    `a/../b.json` legitimately means `<root>/b.json`; a `..` that would pop above the root is
///    [`PathEscape::Traversal`]. An empty candidate, or one that is just `.`, or a `../` chain that
///    lands exactly back on the root, all denote the root itself and are accepted as such.
/// 3. **Resolve against the real filesystem.** `canonicalize` requires the path to exist, and the
///    normal case here is a file that does not exist yet — so this walks up to the nearest existing
///    ancestor, canonicalizes THAT, and re-appends the non-existing tail. This is the step a purely
///    lexical check omits, and it is the one that catches a symlink.
/// 4. **Prove containment against the canonicalized root.** Component-wise ([`Path::starts_with`]
///    semantics), never a string prefix — `/srv/rootevil` must not pass a `/srv/root` check.
///    Case-insensitively on Windows, case-sensitively elsewhere.
///
/// Returns the **resolved** path: symlinks in the existing part are already followed, so a link
/// inside the root pointing elsewhere inside the root is accepted and reported at its target. Feed
/// the returned path to the filesystem call — re-deriving one from `root` and `candidate` throws
/// away the resolution.
///
/// # Behaviour worth knowing before you call it
///
/// * **The root must exist.** Containment is proven against the canonical root, so a root that
///   cannot be canonicalized yields `Err(PathEscape::SymlinkEscape(root))` — fail closed rather
///   than guess. Create the root before resolving paths under it.
/// * **A dangling symlink is refused.** Its target does not exist, so no containment can be proven
///   for it; treating it as a not-yet-created name would hand back a path that writes wherever the
///   link points. That is CVE-2026-27976 in miniature.
/// * **The root itself is a valid answer** (from an empty or `.` candidate). Callers that need a
///   file rather than a directory should say so themselves; this primitive answers "is it inside".
/// * **On Windows** a component containing `:` is refused as [`PathEscape::Absolute`] — a colon is
///   never legal in a Windows filename, and it means either a drive (`C:evil`, resolved against the
///   process's per-drive cwd) or an alternate data stream (`file.txt:hidden`). So is a reserved
///   device name (`CON`, `NUL`, `COM1`, …, with or without an extension), which Win32 resolves to a
///   device in the global namespace regardless of the directory it appears in. Returned paths carry
///   the `\\?\` verbatim prefix that `std::fs::canonicalize` produces.
/// * **TOCTOU.** The answer describes the filesystem at the moment of the call. An attacker who can
///   swap a directory for a symlink between this returning and the caller opening the path wins
///   that race — an inherent limit of path-based checks. It shrinks the window to the smallest one
///   a path-based API can offer; it does not close it.
pub fn contained_path(root: &Path, candidate: &Path) -> Result<PathBuf, PathEscape> {
    // (1) + (2) — pure lexical work, no filesystem access, so a hostile candidate is rejected
    // before it can make us stat anything.
    let relative = lexical_relative_components(candidate)?;

    // (4a) The yardstick. Canonicalizing the root first means a root that does not exist fails here
    // rather than after a pile of pointless filesystem probes.
    let canonical_root =
        std::fs::canonicalize(root).map_err(|_| PathEscape::SymlinkEscape(root.to_path_buf()))?;

    let mut normalized = root.to_path_buf();
    for segment in &relative {
        normalized.push(segment);
    }

    // (3) Walk up to the nearest ancestor that exists, remembering the tail we skipped past.
    // `symlink_metadata` rather than `exists()` on purpose: `exists()` follows the link and so
    // reports `false` for a DANGLING symlink, which would let the walk sail past it and treat it as
    // a free name inside the root.
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut ancestor: &Path = normalized.as_path();
    let existing = loop {
        if std::fs::symlink_metadata(ancestor).is_ok() {
            break ancestor;
        }
        match (ancestor.parent(), ancestor.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                ancestor = parent;
            }
            // Ran out of ancestors without finding one that exists. Unreachable in practice (the
            // canonicalized root above proves at least the root exists), but there is no safe
            // guess to make here.
            _ => return Err(PathEscape::SymlinkEscape(normalized.clone())),
        }
    };

    // A `symlink_metadata` hit that `canonicalize` cannot resolve is a dangling symlink.
    let mut resolved = std::fs::canonicalize(existing)
        .map_err(|_| PathEscape::SymlinkEscape(normalized.clone()))?;
    // The tail was collected leaf-first; and every segment is a `Normal` component (step 2 removed
    // the `.` and `..` ones), so pushing them back cannot re-introduce traversal.
    for segment in tail.iter().rev() {
        resolved.push(segment);
    }

    // (4b)
    if !is_contained(&canonical_root, &resolved) {
        return Err(PathEscape::SymlinkEscape(resolved));
    }
    Ok(resolved)
}

/// Steps 1 and 2: reject an anchored candidate, then reduce the rest to the plain components it
/// denotes relative to the root, rejecting any `..` that would pop above it.
fn lexical_relative_components(candidate: &Path) -> Result<Vec<&OsStr>, PathEscape> {
    let mut stack: Vec<&OsStr> = Vec::new();

    for component in candidate.components() {
        match component {
            // `RootDir` covers `/etc/passwd` everywhere and `\Windows\…` on Windows; `Prefix`
            // covers `C:\…`, the drive-relative `C:evil`, `\\server\share` and `\\?\…`. Between
            // them they are exactly "this path is anchored somewhere of its own choosing".
            Component::Prefix(_) | Component::RootDir => {
                return Err(PathEscape::Absolute(candidate.to_path_buf()))
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    // Nothing left to pop: this `..` leaves the root.
                    return Err(PathEscape::Traversal(candidate.to_path_buf()));
                }
            }
            Component::Normal(name) => {
                if is_windows_reinterpreted(name) {
                    return Err(PathEscape::Absolute(candidate.to_path_buf()));
                }
                stack.push(name);
            }
        }
    }

    Ok(stack)
}

/// True if Windows would read `name` as something other than a plain file in the current directory.
///
/// Two families, both of which turn a "contained" path into an uncontained effect:
///
/// * a `:` makes it a drive qualifier (`C:evil`) or an alternate data stream (`file.txt:hidden`) —
///   and a colon is not a legal character in a Windows filename anyway, so nothing legitimate is
///   lost by refusing it;
/// * a reserved DOS device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`) resolves
///   to a device in the global namespace no matter which directory it is written in, and keeps
///   doing so with an extension (`NUL.txt`) or trailing spaces/dots (`CON `), which Win32 strips.
///
/// Off Windows these are ordinary filenames — a Unix file may legitimately be called `a:b` or
/// `NUL` — so the screen is `#[cfg]`-gated rather than applied everywhere.
#[cfg(windows)]
fn is_windows_reinterpreted(name: &OsStr) -> bool {
    // Lossy rather than `to_str()`: a name that is not valid Unicode can still contain an ASCII
    // colon, and lossy conversion preserves every ASCII byte.
    let text = name.to_string_lossy();
    if text.contains(':') {
        return true;
    }

    // Win32 strips trailing spaces and dots, and looks only at the part before the first `.`.
    let stem = text.split('.').next().unwrap_or("").trim_end_matches(' ');
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    if RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
        return true;
    }
    // `COM<digit>` / `LPT<digit>`. Compared as bytes so a multi-byte leading char cannot panic on a
    // slice that is not a char boundary.
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && (bytes[..3].eq_ignore_ascii_case(b"COM") || bytes[..3].eq_ignore_ascii_case(b"LPT"))
        && bytes[3].is_ascii_digit()
}

#[cfg(not(windows))]
fn is_windows_reinterpreted(_name: &OsStr) -> bool {
    false
}

/// True if `path` is `root` or lies beneath it, compared **component-wise** — `/srv/rootevil` is not
/// under `/srv/root`, however much the strings agree.
///
/// Case-sensitively off Windows, matching those filesystems' own rule.
#[cfg(not(windows))]
fn is_contained(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// True if `path` is `root` or lies beneath it, compared **component-wise** — `C:\srv\rootevil` is
/// not under `C:\srv\root`, however much the strings agree.
///
/// Case-INsensitively, matching Windows' own rule: `Path::starts_with` compares components exactly,
/// which would call a legitimately-cased path an escape. A component that is not valid Unicode is
/// compared byte-exactly rather than folded — folding it would mean a lossy conversion in which two
/// distinct names can collapse onto the same replacement characters, and a false *equal* here is a
/// false accept.
#[cfg(windows)]
fn is_contained(root: &Path, path: &Path) -> bool {
    let mut root_components = root.components();
    let mut path_components = path.components();
    loop {
        match (root_components.next(), path_components.next()) {
            // The root ran out first: everything it had, `path` matched.
            (None, _) => return true,
            // `path` ran out first: it is an ancestor of the root, not a descendant.
            (Some(_), None) => return false,
            (Some(a), Some(b)) => {
                if !component_eq_ignore_case(a.as_os_str(), b.as_os_str()) {
                    return false;
                }
            }
        }
    }
}

#[cfg(windows)]
fn component_eq_ignore_case(a: &OsStr, b: &OsStr) -> bool {
    if a == b {
        return true;
    }
    match (a.to_str(), b.to_str()) {
        (Some(a), Some(b)) => a.to_lowercase() == b.to_lowercase(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    // --- test scaffolding -----------------------------------------------------
    //
    // A throwaway directory under `temp_dir()`, unique per (pid, counter), removed on Drop — the
    // same mechanism the filesystem tests in `lib.rs` use, so this module adds no `tempfile`
    // dependency (see the CRITICAL constraints note there).

    struct TempTree {
        dir: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "koine_paths_{tag}_{}_{}",
                std::process::id(),
                n
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempTree { dir }
        }

        /// The root as the caller passes it (NOT canonicalized — on macOS `temp_dir()` itself sits
        /// under a `/var` -> `/private/var` symlink, which is exactly the case the primitive must
        /// resolve for itself).
        fn root(&self) -> &Path {
            &self.dir
        }

        /// The root as `contained_path` will report it.
        fn canonical(&self) -> PathBuf {
            std::fs::canonicalize(&self.dir).unwrap()
        }

        /// `mkdir -p <root>/<rel>`.
        fn mkdirs(&self, rel: &str) -> PathBuf {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            p
        }

        /// Write a file under the root, creating intermediate directories.
        fn write(&self, rel: &str, contents: &str) -> PathBuf {
            let p = self.dir.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, contents).unwrap();
            p
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            // `remove_dir_all` unlinks symlinks rather than following them, so a test that plants a
            // link to /etc does not delete /etc.
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn ok(root: &Path, candidate: &str) -> PathBuf {
        contained_path(root, Path::new(candidate))
            .unwrap_or_else(|e| panic!("{candidate:?} should be contained, got {e}"))
    }

    fn err(root: &Path, candidate: &str) -> PathEscape {
        contained_path(root, Path::new(candidate))
            .map(|p| {
                panic!(
                    "{candidate:?} should have been refused, got {}",
                    p.display()
                )
            })
            .unwrap_err()
    }

    // --- the contract table ---------------------------------------------------

    #[test]
    fn plain_relative_path_resolves_under_the_root() {
        let t = TempTree::new("plain");
        t.write("themes/dark.json", "{}");

        assert_eq!(
            ok(t.root(), "themes/dark.json"),
            t.canonical().join("themes").join("dark.json")
        );
    }

    #[test]
    fn parent_traversal_is_refused() {
        let t = TempTree::new("trav");

        assert!(matches!(
            err(t.root(), "../../etc/passwd"),
            PathEscape::Traversal(_)
        ));
    }

    #[test]
    fn a_bare_parent_component_is_refused() {
        let t = TempTree::new("bare_parent");

        assert!(matches!(err(t.root(), ".."), PathEscape::Traversal(_)));
    }

    #[test]
    fn an_absolute_candidate_is_refused() {
        let t = TempTree::new("abs");

        // `/etc/passwd` is absolute on Unix and rooted (RootDir, no drive) on Windows; both are
        // anchored rather than relative, so both are refused.
        assert!(matches!(
            err(t.root(), "/etc/passwd"),
            PathEscape::Absolute(_)
        ));
    }

    #[test]
    fn an_absolute_candidate_inside_the_root_is_still_refused() {
        // Containment is not the only rule: the contract is "a RELATIVE path under the root", so an
        // absolute path is refused even when it happens to point inside. A caller that accepted it
        // would be accepting an anchored path from a third party.
        let t = TempTree::new("abs_inside");
        let inside = t.write("a.json", "{}");

        assert!(matches!(
            contained_path(t.root(), &inside),
            Err(PathEscape::Absolute(_))
        ));
    }

    #[test]
    fn a_nonexisting_leaf_resolves_through_its_nearest_existing_ancestor() {
        let t = TempTree::new("newleaf");
        t.mkdirs("new/dir");

        assert_eq!(
            ok(t.root(), "new/dir/out.go"),
            t.canonical().join("new").join("dir").join("out.go")
        );
    }

    #[test]
    fn interior_dot_dot_that_stays_inside_is_normalized() {
        let t = TempTree::new("interior");
        t.write("b.json", "{}");

        assert_eq!(ok(t.root(), "a/../b.json"), t.canonical().join("b.json"));
    }

    // --- Zed's awkward partially-nonexistent regressions -----------------------

    #[test]
    fn a_fully_nonexisting_tail_is_accepted() {
        // Nothing below the root exists yet: the walk has to fall all the way back to the root and
        // re-append `new-dir/nested/binary`. Writing a new file is the NORMAL case.
        let t = TempTree::new("newdir");

        assert_eq!(
            ok(t.root(), "new-dir/nested/binary"),
            t.canonical().join("new-dir").join("nested").join("binary")
        );
    }

    #[test]
    fn a_directory_merely_named_escape_is_accepted() {
        // "escape" is a plain directory name, not an escape. Containment is about where a path
        // lands, never about what it is called.
        let t = TempTree::new("escapename");

        assert_eq!(
            ok(t.root(), "escape/deep/nested/file.txt"),
            t.canonical()
                .join("escape")
                .join("deep")
                .join("nested")
                .join("file.txt")
        );
    }

    #[test]
    fn an_empty_candidate_yields_the_root() {
        let t = TempTree::new("empty");

        assert_eq!(ok(t.root(), ""), t.canonical());
    }

    #[test]
    fn a_bare_current_dir_candidate_yields_the_root() {
        let t = TempTree::new("curdir");

        assert_eq!(ok(t.root(), "."), t.canonical());
        assert_eq!(ok(t.root(), "./a/.."), t.canonical());
    }

    #[test]
    fn a_dot_dot_chain_landing_exactly_on_the_root_is_accepted() {
        let t = TempTree::new("chain");

        assert_eq!(ok(t.root(), "a/b/c/../../.."), t.canonical());
    }

    #[test]
    fn a_dot_dot_chain_one_step_past_the_root_is_refused() {
        let t = TempTree::new("chain_past");

        assert!(matches!(
            err(t.root(), "a/b/c/../../../.."),
            PathEscape::Traversal(_)
        ));
    }

    #[test]
    fn a_nonexisting_root_is_refused_rather_than_assumed() {
        // Documented behaviour: containment is proven against the CANONICAL root, so a root that
        // cannot be canonicalized (it does not exist, or is unreadable) fails closed.
        let t = TempTree::new("noroot");
        let missing = t.root().join("not-created");

        assert!(matches!(
            contained_path(&missing, Path::new("a.txt")),
            Err(PathEscape::SymlinkEscape(_))
        ));
    }

    #[test]
    fn the_error_carries_the_offending_path_and_renders() {
        let t = TempTree::new("display");
        let e = err(t.root(), "../../etc/passwd");

        let text = e.to_string();
        assert!(text.contains("passwd"), "unhelpful message: {text}");
        // It is a real `std::error::Error`, so a call site can box it or flatten it into an
        // `io::Error` / a Tauri command's `String`.
        let boxed: Box<dyn std::error::Error> = Box::new(e);
        assert!(boxed.to_string().contains("passwd"));
    }

    // --- symlinks (Unix only: `std::os::unix::fs::symlink`) --------------------

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let t = TempTree::new("symesc");
        std::os::unix::fs::symlink("/etc", t.root().join("link")).unwrap();

        assert!(matches!(
            err(t.root(), "link/passwd"),
            PathEscape::SymlinkEscape(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_another_temp_tree_is_refused() {
        let t = TempTree::new("symesc2");
        let outside = TempTree::new("outside");
        outside.write("secret.txt", "s3cret");
        std::os::unix::fs::symlink(outside.root(), t.root().join("link")).unwrap();

        assert!(matches!(
            err(t.root(), "link/secret.txt"),
            PathEscape::SymlinkEscape(_)
        ));
        // ...and the same for a leaf that does not exist yet: the escape is the DIRECTORY link, so
        // the nearest-existing-ancestor walk has to catch it too.
        assert!(matches!(
            err(t.root(), "link/brand-new.txt"),
            PathEscape::SymlinkEscape(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_root_is_accepted() {
        // Containment, not symlink-phobia: a link that lands back inside the root is fine, and the
        // returned path is the RESOLVED one.
        let t = TempTree::new("symin");
        let target = t.mkdirs("target");
        t.write("target/file.txt", "hi");
        std::os::unix::fs::symlink(&target, t.root().join("inner")).unwrap();

        assert_eq!(
            ok(t.root(), "inner/file.txt"),
            t.canonical().join("target").join("file.txt")
        );
        assert_eq!(
            ok(t.root(), "inner/not-yet.txt"),
            t.canonical().join("target").join("not-yet.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_refused() {
        // `exists()` is false for a dangling link, so a naive walk would treat `link` as a
        // not-yet-created name inside the root and hand back `<root>/link/x` — writing through
        // which would land wherever the link points. Fail closed instead.
        let t = TempTree::new("dangling");
        let outside = TempTree::new("dangling_target");
        let missing = outside.root().join("not-created");
        std::os::unix::fs::symlink(&missing, t.root().join("link")).unwrap();

        assert!(matches!(
            err(t.root(), "link"),
            PathEscape::SymlinkEscape(_)
        ));
        assert!(matches!(
            err(t.root(), "link/child.txt"),
            PathEscape::SymlinkEscape(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_sibling_whose_name_merely_prefixes_the_root_is_refused() {
        // `/tmp/x/rootevil` is a STRING prefix match against the root `/tmp/x/root`, but not a
        // component-wise one. A `starts_with` on strings would let this through.
        let parent = TempTree::new("sibling");
        let root = parent.mkdirs("root");
        let evil = parent.mkdirs("rootevil");
        std::fs::write(evil.join("loot.txt"), "loot").unwrap();
        std::os::unix::fs::symlink(&evil, root.join("link")).unwrap();

        assert!(matches!(
            contained_path(&root, Path::new("link/loot.txt")),
            Err(PathEscape::SymlinkEscape(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_backslash_separated_name_is_an_ordinary_name_on_unix() {
        // `\` is a legal filename character on Unix, so `..\..\evil` is ONE ordinary component
        // here — which is precisely why the backslash-traversal check below is Windows-gated.
        let t = TempTree::new("backslash_unix");

        assert_eq!(
            ok(t.root(), "..\\..\\evil"),
            t.canonical().join("..\\..\\evil")
        );
    }

    // --- Windows-only surfaces (the CI matrix runs windows-latest) -------------

    #[cfg(windows)]
    #[test]
    fn a_verbatim_prefixed_candidate_is_refused() {
        let t = TempTree::new("verbatim");

        assert!(matches!(
            err(t.root(), r"\\?\C:\Windows\System32\drivers\etc\hosts"),
            PathEscape::Absolute(_)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_qualified_candidate_is_refused() {
        let t = TempTree::new("drive");

        // Fully absolute...
        assert!(matches!(
            err(t.root(), r"C:\Windows\System32\evil.dll"),
            PathEscape::Absolute(_)
        ));
        // ...drive-RELATIVE (`C:evil` resolves against the process's per-drive cwd, so it is not
        // `is_absolute()` yet is emphatically not contained)...
        assert!(matches!(err(t.root(), "C:evil"), PathEscape::Absolute(_)));
        // ...rooted without a drive...
        assert!(matches!(
            err(t.root(), r"\Windows\evil.dll"),
            PathEscape::Absolute(_)
        ));
        // ...and a UNC share.
        assert!(matches!(
            err(t.root(), r"\\attacker\share\evil.dll"),
            PathEscape::Absolute(_)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn an_alternate_data_stream_candidate_is_refused() {
        let t = TempTree::new("ads");

        assert!(matches!(
            err(t.root(), "file.txt:stream"),
            PathEscape::Absolute(_)
        ));
        assert!(matches!(
            err(t.root(), r"themes\dark.json:evil"),
            PathEscape::Absolute(_)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_reserved_device_name_is_refused() {
        let t = TempTree::new("devices");

        for name in ["CON", "NUL", "nul", "PRN", "AUX", "COM1", "LPT9"] {
            assert!(
                matches!(err(t.root(), name), PathEscape::Absolute(_)),
                "{name} should be refused"
            );
        }
        // An extension does not make it a file: `NUL.txt` is still the null device.
        assert!(matches!(err(t.root(), "NUL.txt"), PathEscape::Absolute(_)));
        // Nor does a trailing space, which Win32 strips.
        assert!(matches!(err(t.root(), "CON "), PathEscape::Absolute(_)));
        // ...but a name that merely starts with one is an ordinary name.
        assert_eq!(ok(t.root(), "CONFIG"), t.canonical().join("CONFIG"));
        assert_eq!(ok(t.root(), "COMMON.txt"), t.canonical().join("COMMON.txt"));
    }

    #[cfg(windows)]
    #[test]
    fn a_backslash_separated_traversal_is_refused() {
        let t = TempTree::new("backslash");

        assert!(matches!(
            err(t.root(), r"..\..\evil"),
            PathEscape::Traversal(_)
        ));
        assert!(matches!(
            err(t.root(), r"themes\..\..\evil"),
            PathEscape::Traversal(_)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn containment_is_case_insensitive_on_windows() {
        assert!(is_contained(
            Path::new(r"\\?\C:\Root"),
            Path::new(r"\\?\C:\rOOt\themes\dark.json")
        ));
        // ...but still component-wise: a sibling that shares a string prefix is out.
        assert!(!is_contained(
            Path::new(r"\\?\C:\Root"),
            Path::new(r"\\?\C:\RootEvil\loot.txt")
        ));
        assert!(is_contained(
            Path::new(r"\\?\C:\Root"),
            Path::new(r"\\?\C:\Root")
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn containment_is_case_sensitive_off_windows() {
        assert!(!is_contained(
            Path::new("/srv/Root"),
            Path::new("/srv/root/themes/dark.json")
        ));
        assert!(is_contained(
            Path::new("/srv/Root"),
            Path::new("/srv/Root/themes/dark.json")
        ));
        // Component-wise, never a string prefix.
        assert!(!is_contained(
            Path::new("/srv/root"),
            Path::new("/srv/rootevil/loot.txt")
        ));
        assert!(is_contained(Path::new("/srv/root"), Path::new("/srv/root")));
    }
}
