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

    // --- the shared cross-language corpus -------------------------------------
    //
    // `tests/fixtures/path-containment/cases.json` at the repo root is the accept/reject table
    // BOTH hosts answer to: this module and `ContainedPathTests` in the .NET suite read the same
    // file, materialize the same fixtures, and assert the same outcomes. That is the whole point —
    // two implementations of one security rule drift silently unless something fails when they
    // disagree, and "we wrote similar-looking tests in each language" is not that something.
    //
    // The format is documented once, next to the data, in
    // `tests/fixtures/path-containment/README.md`.

    #[derive(serde::Deserialize)]
    struct Corpus {
        version: u32,
        cases: Vec<CorpusCase>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CorpusCase {
        name: String,
        #[serde(default)]
        setup: Vec<SetupEntry>,
        candidate: String,
        expect: String,
        #[serde(default)]
        resolves_to: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        platforms: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct SetupEntry {
        kind: String,
        path: String,
        #[serde(default)]
        target: Option<String>,
    }

    /// Join a corpus-declared `/`-separated relative path onto a base, component by component, so
    /// the corpus never has to know which separator the running OS uses.
    fn join_rel(base: &Path, rel: &str) -> PathBuf {
        let mut p = base.to_path_buf();
        for segment in rel.split('/') {
            if !segment.is_empty() {
                p.push(segment);
            }
        }
        p
    }

    #[cfg(windows)]
    fn paths_eq(a: &Path, b: &Path) -> bool {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    }

    #[cfg(not(windows))]
    fn paths_eq(a: &Path, b: &Path) -> bool {
        a == b
    }

    #[cfg(unix)]
    fn make_symlink(target: &str, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(not(unix))]
    fn make_symlink(_target: &str, _link: &Path) {
        panic!("a corpus case with a `symlink` setup entry must list only the `unix` platform");
    }

    fn run_corpus_case(case: &CorpusCase) {
        // The root is deliberately named `root` inside a private sandbox, so a corpus case can plant
        // a `../rootevil` sibling whose name is a STRING prefix of the root's — the exact shape a
        // `starts_with` on strings would wave through.
        let sandbox = TempTree::new("corpus");
        let root = sandbox.mkdirs("root");

        for entry in &case.setup {
            let path = join_rel(&root, &entry.path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            match entry.kind.as_str() {
                "dir" => std::fs::create_dir_all(&path).unwrap(),
                "file" => std::fs::write(&path, "koine").unwrap(),
                "symlink" => {
                    let target = entry.target.as_deref().unwrap_or_else(|| {
                        panic!("[{}] a `symlink` entry needs a `target`", case.name)
                    });
                    make_symlink(target, &path);
                }
                other => panic!("[{}] unknown setup kind {other:?}", case.name),
            }
        }

        let actual = contained_path(&root, Path::new(&case.candidate));
        match case.expect.as_str() {
            "accept" => {
                let resolved =
                    actual.unwrap_or_else(|e| panic!("[{}] expected accept, got: {e}", case.name));
                // Each harness derives the canonical root from its OWN primitive (an empty candidate
                // denotes the root), so the corpus can express `resolvesTo` machine-independently.
                let canonical_root = contained_path(&root, Path::new("")).unwrap();
                let expected = join_rel(&canonical_root, case.resolves_to.as_deref().unwrap_or(""));
                assert!(
                    paths_eq(&resolved, &expected),
                    "[{}] resolved to {}, expected {}",
                    case.name,
                    resolved.display(),
                    expected.display()
                );
            }
            "reject" => {
                let err = match actual {
                    Ok(p) => panic!("[{}] expected reject, got {}", case.name, p.display()),
                    Err(e) => e,
                };
                let reason = case
                    .reason
                    .as_deref()
                    .unwrap_or_else(|| panic!("[{}] a `reject` case needs a `reason`", case.name));
                let matched = match reason {
                    "traversal" => matches!(err, PathEscape::Traversal(_)),
                    "absolute" => matches!(err, PathEscape::Absolute(_)),
                    "symlink-escape" => matches!(err, PathEscape::SymlinkEscape(_)),
                    other => panic!("[{}] unknown reason {other:?}", case.name),
                };
                assert!(matched, "[{}] expected {reason}, got {err:?}", case.name);
            }
            other => panic!("[{}] unknown expect {other:?}", case.name),
        }
    }

    #[test]
    fn the_shared_corpus_agrees_with_this_implementation() {
        let corpus_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/path-containment/cases.json");

        // Loud on absence. A corpus test that silently passes when the fixture is missing is a gate
        // that proves nothing — and this one exists specifically to prove something.
        let text = std::fs::read_to_string(&corpus_path).unwrap_or_else(|e| {
            panic!(
                "the shared path-containment corpus is missing at {}: {e}",
                corpus_path.display()
            )
        });
        let corpus: Corpus = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{} is not valid corpus JSON: {e}", corpus_path.display()));

        assert_eq!(
            corpus.version, 1,
            "unknown corpus schema version — update this harness before bumping it"
        );
        assert!(
            !corpus.cases.is_empty(),
            "the shared corpus has zero cases: {}",
            corpus_path.display()
        );

        let platform = if cfg!(windows) { "windows" } else { "unix" };
        let mut ran = 0usize;
        for case in &corpus.cases {
            if !case.platforms.iter().any(|p| p == platform) {
                continue;
            }
            ran += 1;
            run_corpus_case(case);
        }

        assert!(
            ran > 0,
            "no corpus case lists the `{platform}` platform — the corpus cannot gate this OS"
        );
    }

    // --- the mechanical sink guard --------------------------------------------
    //
    // WHY A TEST AND NOT A LINT. The plan for #1942 offered `clippy.toml` as the alternative. It was
    // checked rather than assumed, and it does not work here for two independent reasons:
    //
    //   1. NOTHING RUNS CLIPPY. `.github/workflows/studio-build.yml` runs `cargo build --locked` and
    //      `cargo test --locked`, and `ci.yml`'s only cargo use is the Rust conformance suite's
    //      `cargo check`. No workflow in the repository invokes `cargo clippy` at all, so a
    //      `clippy.toml` would be a file that gates nothing — the worst kind of security control,
    //      one that looks present in a review and is absent in CI.
    //   2. `disallowed-methods` IS TOO BLUNT ANYWAY. It keys on a method path, so banning
    //      `std::path::Path::join` would fire on all ~90 joins in `lib.rs` — fixture setup in its
    //      test module, the internal `copy_recursive` recursion, the `current_exe()`-derived sidecar
    //      lookup — with no way to excuse a single one.
    //
    // A `#[cfg(test)]` scan over `include_str!("lib.rs")` has neither problem: it runs under
    // `cargo test --locked` on all three OSes of the studio-build matrix, and it carries a named
    // allowlist so an exception is a reviewed row rather than a suppressed lint.
    //
    // ITS TWIN, AND WHY THIS ONE IS THE LOAD-BEARING HALF. `PathSinkGuardTests` in the .NET suite
    // enforces these same two rules over this same file (plus a third over the .NET extension layer,
    // which cargo cannot see). But `ci.yml`'s `changes` gate sets `dotnet=false` for a PR that
    // touches only `tooling/koine-studio/**`, which skips BOTH .NET jobs — so for a Rust-only change
    // to `lib.rs`, the test you are reading is the only gate that runs. The allowlists are
    // deliberately duplicated rather than shared: the two tables must AGREE, and each side fails on
    // its own drift — an entry removed here while the site remains reddens this test; a site fixed
    // here while the entry remains reddens the staleness check on both sides.

    /// The host as text. `include_str!` resolves relative to THIS file, so this is `src/lib.rs`, and
    /// it is embedded at compile time — the scan cannot silently pass because a working directory
    /// was not what it expected.
    const HOST_SOURCE: &str = include_str!("lib.rs");

    /// `.join(` outside the containment primitive, in the non-test half of `lib.rs`.
    const RAW_JOIN: &str = "raw-join";
    /// A `#[tauri::command]` taking a caller-supplied relative path that never calls `resolve_in`.
    const UNROUTED_COMMAND: &str = "unrouted-command";

    /// A parameter carries a caller-supplied relative path when one of its underscore-separated name
    /// segments is one of these. Segment-wise rather than substring, so `relay` is not swept in by
    /// the `rel` in its first three letters.
    const PATH_PARAM_SEGMENTS: [&str; 4] = ["rel", "rels", "path", "paths"];

    /// `(function, kind, marker, why it is safe)` — the twin of `PathSinkGuardTests.RustAllowlist`.
    /// The marker must appear in the reported line, so an entry pins WHICH site it excuses while
    /// still surviving a reformat.
    const SINK_ALLOWLIST: &[(&str, &str, &str, &str)] = &[
        // Joins that compose no caller-supplied string.
        (
            "bundled_koine_path",
            RAW_JOIN,
            ".join(format!(\"koine{}\"",
            "a fixed executable name onto current_exe()'s directory — the host's own layout",
        ),
        (
            "git_clone",
            RAW_JOIN,
            ".join(&dest_name)",
            "computes the RETURN value only, and clone_dest_name already reduced dest_name to one segment free of `/`, `\\` and `..`",
        ),
        (
            "rename_entry",
            RAW_JOIN,
            "parent.join(&new_name)",
            "is_safe_name screens new_name to a single separator-free segment, joined onto the token's own parent",
        ),
        (
            "copy_recursive",
            RAW_JOIN,
            "dst.join(entry.file_name())",
            "internal recursion: a file_name() off the SOURCE tree onto a destination move_entry already resolved",
        ),
        // Commands whose path parameter is a different trust class.
        (
            "read_text_file",
            UNROUTED_COMMAND,
            "path: String",
            "an absolute path the user picked in the OS file dialog — there is no root to contain it against",
        ),
        (
            "write_text_file",
            UNROUTED_COMMAND,
            "path: String",
            "the save side of the same user-chosen dialog path",
        ),
        (
            "write_bytes",
            UNROUTED_COMMAND,
            "path: String",
            "the absolute save-zip target the user chose in the OS dialog",
        ),
        (
            "git_diff",
            UNROUTED_COMMAND,
            "rel_path: String",
            "a pathspec handed to the git binary via `git -C <dir> … --`, never joined by the host",
        ),
        (
            "git_stage",
            UNROUTED_COMMAND,
            "rel_paths: Vec<String>",
            "pathspecs handed to the git binary, never joined by the host",
        ),
        (
            "git_unstage",
            UNROUTED_COMMAND,
            "rel_paths: Vec<String>",
            "pathspecs handed to the git binary, never joined by the host",
        ),
        (
            "git_discard",
            UNROUTED_COMMAND,
            "tracked_paths: Vec<String>",
            "pathspecs handed to the git binary; the untracked half goes through the same plumbing",
        ),
        (
            "git_log",
            UNROUTED_COMMAND,
            "rel_path: Option<String>",
            "an optional pathspec narrowing `git -C <dir> log --`, never joined by the host",
        ),
    ];

    /// One reported site: `(line, kind, function, text)`.
    type Site = (usize, &'static str, String, String);

    /// Blank out string literals and drop a trailing line comment, so a `//` inside a string is not
    /// read as a comment and a `.join(` inside a doc comment is not read as code — `resolve_in`'s
    /// own doc comment contains the text `folder.join(rel_path)` as a warning against writing it.
    fn strip_strings_and_comments(line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        let mut in_string = false;
        let mut chars = line.chars().peekable();

        while let Some(c) = chars.next() {
            if in_string {
                match c {
                    '\\' => {
                        chars.next();
                        out.push(' ');
                        out.push(' ');
                    }
                    '"' => {
                        in_string = false;
                        out.push('"');
                    }
                    _ => out.push(' '),
                }
                continue;
            }
            match c {
                '"' => {
                    in_string = true;
                    out.push('"');
                }
                '/' if chars.peek() == Some(&'/') => break,
                _ => out.push(c),
            }
        }

        out
    }

    fn is_ident_byte(b: u8) -> bool {
        b == b'_' || b.is_ascii_alphanumeric()
    }

    /// The byte offset of `word` appearing as a whole token, if it does.
    fn find_word(haystack: &str, word: &str) -> Option<usize> {
        let bytes = haystack.as_bytes();
        let mut from = 0usize;
        while let Some(pos) = haystack[from..].find(word) {
            let i = from + pos;
            let j = i + word.len();
            let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let after_ok = j >= bytes.len() || !is_ident_byte(bytes[j]);
            if before_ok && after_ok {
                return Some(i);
            }
            from = j;
        }
        None
    }

    /// The name of the function this line declares, if it declares one. Everything before the `fn`
    /// token must be a declaration modifier, so `let x = foo.fn_like()` and a `fn` inside an
    /// expression cannot be mistaken for a declaration.
    fn declared_fn_name(code: &str) -> Option<String> {
        let trimmed = code.trim();
        let at = find_word(trimmed, "fn")?;
        let modifiers_only = trimmed[..at].split_whitespace().all(|w| {
            w == "pub"
                || w.starts_with("pub(")
                || w == "async"
                || w == "unsafe"
                || w == "const"
                || w == "extern"
                || w.starts_with('"')
        });
        if !modifiers_only {
            return None;
        }

        let name: String = trimmed[at + 2..]
            .trim_start()
            .chars()
            .take_while(|c| is_ident_byte(*c as u8) && c.is_ascii())
            .collect();
        (!name.is_empty()).then_some(name)
    }

    /// The line index of the `#[cfg(test)] mod tests` attribute — everything below it is fixture
    /// scaffolding, not a sink. Matched as the attribute IMMEDIATELY followed by `mod tests` rather
    /// than the first `#[cfg(test)]` in the file, since a test-only `use` carries the same attribute.
    fn test_module_start(lines: &[&str]) -> usize {
        lines
            .windows(2)
            .position(|w| w[0].trim() == "#[cfg(test)]" && w[1].trim_start().starts_with("mod tests"))
            .expect(
                "lib.rs has no `#[cfg(test)] mod tests` module — this guard scans the file ABOVE that \
                 boundary and cannot tell host code from fixture code without it",
            )
    }

    /// Split a parameter list on top-level commas, so `HashMap<K, V>` stays whole.
    fn split_params(params: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut current = String::new();
        let mut depth = 0i32;
        for c in params.chars() {
            match c {
                '<' | '(' | '[' => depth += 1,
                '>' | ')' | ']' => depth -= 1,
                ',' if depth == 0 => {
                    out.push(current.trim().to_string());
                    current.clear();
                    continue;
                }
                _ => {}
            }
            current.push(c);
        }
        if !current.trim().is_empty() {
            out.push(current.trim().to_string());
        }
        out
    }

    /// True for a parameter carrying a relative path chosen by whoever called the command: a
    /// `rel`/`path`-segmented name over a string-or-path type. Both halves matter — the name alone
    /// would sweep in Tauri's own state handles, the type alone every `String` in the file.
    fn is_caller_supplied_relpath(param: &str) -> bool {
        let Some((name, ty)) = param.split_once(':') else {
            return false;
        };
        let named = name
            .replace("mut ", "")
            .trim()
            .split('_')
            .any(|segment| PATH_PARAM_SEGMENTS.contains(&segment));
        let typed = ty.contains("String") || ty.contains("str") || ty.contains("Path");
        named && typed
    }

    /// Every site in the non-test half of `lib.rs` that composes a filesystem path from a value the
    /// host did not choose itself.
    fn find_sink_sites() -> Vec<Site> {
        let lines: Vec<&str> = HOST_SOURCE.lines().collect();
        let limit = test_module_start(&lines);
        let mut sites: Vec<Site> = Vec::new();
        let mut function = String::from("<file scope>");

        for i in 0..limit {
            let code = strip_strings_and_comments(lines[i]);
            if let Some(name) = declared_fn_name(&code) {
                function = name;
            }
            if code.contains(".join(") {
                sites.push((
                    i + 1,
                    RAW_JOIN,
                    function.clone(),
                    lines[i].trim().to_string(),
                ));
            }
            if lines[i].trim_start().starts_with("#[tauri::command") {
                if let Some(site) = inspect_command(&lines, i, limit) {
                    sites.push(site);
                }
            }
        }

        sites
    }

    /// Report the `#[tauri::command]` starting at `attribute` when it declares a caller-supplied
    /// relative-path parameter and never calls `resolve_in`.
    fn inspect_command(lines: &[&str], attribute: usize, limit: usize) -> Option<Site> {
        let mut i = attribute + 1;
        while i < limit && declared_fn_name(&strip_strings_and_comments(lines[i])).is_none() {
            i += 1;
        }
        if i >= limit {
            return None;
        }

        let declaration = i;
        let name = declared_fn_name(&strip_strings_and_comments(lines[i]))?;

        // The signature: from the first `(` until the parameter list's parens balance.
        let mut params = String::new();
        let mut depth = 0i32;
        let mut started = false;
        'signature: while i < limit {
            for c in strip_strings_and_comments(lines[i]).chars() {
                match c {
                    '(' => {
                        depth += 1;
                        started = true;
                        if depth == 1 {
                            continue;
                        }
                    }
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                if started && depth >= 1 {
                    params.push(c);
                }
            }
            if started && depth == 0 {
                break 'signature;
            }
            params.push(' ');
            i += 1;
        }

        let tainted: Vec<String> = split_params(&params)
            .into_iter()
            .filter(|p| is_caller_supplied_relpath(p))
            .collect();
        if tainted.is_empty() {
            return None;
        }

        // The body: from the opening brace until the braces balance again.
        let mut body = String::new();
        depth = 0;
        started = false;
        while i < limit {
            let code = strip_strings_and_comments(lines[i]);
            body.push_str(&code);
            body.push('\n');
            for c in code.chars() {
                match c {
                    '{' => {
                        depth += 1;
                        started = true;
                    }
                    '}' => depth -= 1,
                    _ => {}
                }
            }
            if started && depth == 0 {
                break;
            }
            i += 1;
        }

        if body.contains("resolve_in(") {
            return None;
        }

        Some((
            declaration + 1,
            UNROUTED_COMMAND,
            name.clone(),
            format!("fn {name}({}) never calls resolve_in", tainted.join(", ")),
        ))
    }

    fn allowlisted(site: &Site) -> bool {
        SINK_ALLOWLIST.iter().any(|(function, kind, marker, _)| {
            *function == site.2 && *kind == site.1 && site.3.contains(marker)
        })
    }

    #[test]
    fn the_host_routes_every_plugin_influenced_path_through_the_primitive() {
        let sites = find_sink_sites();
        let unlisted: Vec<&Site> = sites.iter().filter(|s| !allowlisted(s)).collect();

        assert!(
            unlisted.is_empty(),
            "unguarded filesystem path site(s) in lib.rs. A [{RAW_JOIN}] composes a path with \
             `Path::join` outside the containment primitive; an [{UNROUTED_COMMAND}] takes a \
             caller-supplied relative-path parameter and never calls `resolve_in`. Either is how \
             CVE-2026-27800 and CVE-2026-27976 happened. Route it through `resolve_in(folder, \
             rel_path)` and USE THE PATH IT RETURNS — re-deriving `folder.join(rel_path)` afterwards \
             throws away the symlink resolution that makes it safe. If the site is genuinely a \
             different trust class, add a row to SINK_ALLOWLIST here AND to \
             PathSinkGuardTests.RustAllowlist in the .NET suite, with a real justification:\n{}",
            unlisted
                .iter()
                .map(|(line, kind, function, text)| format!(
                    "  src/lib.rs:{line} [{kind}] in `{function}` — {text}"
                ))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn every_sink_allowlist_entry_still_matches_a_real_site() {
        // The inverse check: an allowlist that only ever grows stops being a list of considered
        // exceptions and becomes a rubber stamp. An entry whose site is gone hides nothing today —
        // say so, and delete it.
        let sites = find_sink_sites();
        let stale: Vec<&(&str, &str, &str, &str)> = SINK_ALLOWLIST
            .iter()
            .filter(|(function, kind, marker, _)| {
                !sites
                    .iter()
                    .any(|s| s.2 == *function && s.1 == *kind && s.3.contains(marker))
            })
            .collect();

        assert!(
            stale.is_empty(),
            "SINK_ALLOWLIST entries that no longer match a real site in lib.rs (the code was \
             removed, renamed, or already routed through the primitive) — delete them:\n{}",
            stale
                .iter()
                .map(|(function, kind, marker, reason)| format!(
                    "  `{function}` [{kind}] marker {marker:?} — {reason}"
                ))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
