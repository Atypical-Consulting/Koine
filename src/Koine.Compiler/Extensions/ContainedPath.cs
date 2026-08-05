// Koine — path containment for third-party-supplied paths (#1942), the .NET half.
//
// WHY THIS EXISTS. This is the exact counterpart of `contained_path` in the Tauri host
// (`tooling/koine-studio/src-tauri/src/paths.rs`); read that file's header for the full rationale.
// The short version: Koine will soon accept paths chosen by an EXTENSION rather than by the user,
// and every one of them eventually reaches a filesystem sink running with the process's own ambient
// authority. Zed shipped that surface twice with a lexical-only check and got CVE-2026-27800 (Zip
// Slip) and CVE-2026-27976 (a symlink escaping an extension archive, turned into arbitrary file
// write and then RCE) for it. Both are one bug: a path validated LEXICALLY and then handed to a
// filesystem that resolves symlinks.
//
// TWO IMPLEMENTATIONS, ONE RULE. Rust and .NET both need this, and two hand-written implementations
// of one security rule drift silently. So they answer to a single shared accept/reject corpus at
// `tests/fixtures/path-containment/cases.json`, driven by `ContainedPathTests` here and by
// `paths::tests::the_shared_corpus_agrees_with_this_implementation` there. If the two ever disagree,
// a build goes red rather than a CVE getting filed. Change the algorithm here and you must change it
// there — the corpus makes that mechanical rather than a matter of remembering.
//
// It fails CLOSED. Anything it cannot prove contained is refused — including a level of the tree it
// could not READ, since an unreadable directory is not an absent one — and it never throws: a caller
// that has to wrap this in a try/catch will eventually catch too much.
//
// WHERE THE TWO IMPLEMENTATIONS KNOWINGLY DIFFER. The corpus pins everything it can express; two
// things it cannot, documented here and in the Rust file's twin of this header so the divergence is
// on the record rather than discovered:
//
//   1. DEEP SYMLINK CHAINS. Rust resolves them with the OS (`canonicalize` is `realpath`), so its
//      ceiling is the kernel's MAXSYMLINKS — 32 on macOS, 40 on Linux, 63 reparse points on Windows.
//      .NET has no realpath, so `TryCanonicalize` below hand-rolls the descent with a fixed budget
//      (`MaxSymlinkHops`). A hand-rolled counter cannot equal a per-OS kernel constant, so the budget
//      is set to the SMALLEST of them — this half can then never accept a chain the Rust half would
//      refuse. In the band between (a 33-40 link chain on Linux) this half refuses what Rust accepts.
//      That is a false reject, not a containment gap, and the OS refuses the caller's subsequent open
//      in either case. Note the budget is spent on the ROOT's own symlinks too, so the effective
//      allowance for the candidate depends on where the root lives.
//   2. UNICODE NORMALIZATION. Rust's `canonicalize` reads real directory entries, so it returns the
//      ON-DISK spelling: hand it an NFC name stored on disk as NFD and NFD comes back. This half
//      re-joins the caller's own strings and never consults a directory entry, so it hands back the
//      CALLER's spelling. Containment here is compared with `Ordinal`, which is stricter than the
//      filesystem's own rule (macOS compares normalization-insensitively), so the difference can only
//      make this half REFUSE a legitimate path — never accept an escaping one. The false reject is
//      real though: a symlink target inside the root stored in the other normalization form resolves
//      to a path that no longer compares equal to the root's spelling. Neither half normalizes, and
//      neither should — Unicode normalization inside a security primitive is its own correctness
//      minefield (which form? whose table version? what about a normalization-preserving filesystem?),
//      and getting it subtly wrong turns a comparison into a hole. A caller that de-duplicates on the
//      returned string is comparing SPELLINGS, not files.
//
// And three consistent-but-unpinned behaviours worth knowing (both halves agree; no corpus row can
// express them because they are about the ROOT, not the candidate):
//
//   * A root that is a regular FILE is accepted as a root. This answers "is it inside", and `<file>`
//     is inside `<file>`; a caller that needs a directory checks that itself.
//   * A relative root (".") is resolved against the PROCESS's current directory. That is a real
//     boundary, just not one this primitive chose — pass an absolute root.
//   * The root's own symlinks are resolved first, so a root reached through a link (macOS' /var ->
//     /private/var) is compared, and reported, at its canonical location.

using System.Text;

namespace Koine.Compiler.Extensions;

/// <summary>
/// Why a candidate path was refused by <see cref="ContainedPath.TryResolve"/>. Mirrors the Rust
/// host's <c>PathEscape</c> variants one-for-one so both implementations can be held to the single
/// shared corpus described in <c>tests/fixtures/path-containment/README.md</c>.
/// </summary>
public enum PathEscapeReason
{
    /// <summary>
    /// No escape — the only value reported alongside a <see langword="true"/> result from
    /// <see cref="ContainedPath.TryResolve"/>. Callers that want a plain "did it escape?" can test
    /// <c>reason != PathEscapeReason.None</c>.
    /// </summary>
    None = 0,

    /// <summary>The candidate walked out of the root with <c>..</c>.</summary>
    Traversal = 1,

    /// <summary>
    /// The candidate was anchored rather than relative — absolute (<c>/etc/passwd</c>), rooted
    /// (<c>\Windows\…</c>), or, on Windows, drive/prefix-qualified (<c>C:\…</c>, the drive-RELATIVE
    /// <c>C:evil</c>, <c>\\server\share</c>, the verbatim <c>\\?\C:\…</c>), an alternate data stream
    /// (<c>file.txt:hidden</c>), or a reserved DOS device name (<c>CON</c>, <c>NUL.txt</c>, …).
    /// </summary>
    Absolute = 2,

    /// <summary>
    /// Containment could not be established once the filesystem had its say: the candidate resolves
    /// outside the root through a symlink, the root itself cannot be canonicalized, a component
    /// cannot be resolved at all (a dangling symlink), or a level of the tree could not be READ.
    /// </summary>
    SymlinkEscape = 3,

    /// <summary>
    /// The candidate is not a usable relative path in its own right, independently of where it would
    /// land: it is longer, or names more components, than
    /// <see cref="ContainedPath.MaxCandidateBytes"/> /
    /// <see cref="ContainedPath.MaxCandidateComponents"/> allow; it contains a NUL character, which
    /// no filesystem this ships on can store; or, on Windows, it contains a component the OS would
    /// silently REWRITE, because Win32 strips trailing dots and spaces from every path component.
    /// Refused in the lexical step, before the filesystem is touched at all.
    /// <para>
    /// Distinct from <see cref="Traversal"/> and <see cref="Absolute"/> on purpose: neither of those
    /// is what happened, and a security control that files a size limit under "traversal" teaches its
    /// callers to distrust its own labels.
    /// </para>
    /// </summary>
    Malformed = 4,
}

/// <summary>
/// Resolves a path chosen by someone we do not trust to a real path under a root we do — or refuses
/// it with a typed reason.
/// </summary>
public static class ContainedPath
{
    /// <summary>
    /// The largest candidate this will look at, in UTF-8 bytes.
    /// </summary>
    /// <remarks>
    /// The reference is the filesystem's own ceiling: Linux's <c>PATH_MAX</c> is 4096 and Windows'
    /// <c>MAX_PATH</c> is 260 (32767 only with the long-path opt-in), so no path a caller could
    /// actually create is refused by this. What it refuses is a candidate whose only purpose is to be
    /// <em>walked</em>: the nearest-existing-ancestor loop costs one probe per component, and a ZIP
    /// filename may be 64 KiB — <c>SafeArchiveExtractor</c> caps member count and bytes but not name
    /// length. Measured before this cap existed, a 50,000-component candidate cost 23 seconds of CPU
    /// in this method alone. Counted in UTF-8 bytes because that is what the Rust half's
    /// <c>OsStr::len()</c> counts, so the two agree on every input rather than only on ASCII.
    /// </remarks>
    public const int MaxCandidateBytes = 4096;

    /// <summary>
    /// The most components a candidate may name, counting every component AS WRITTEN — a <c>..</c>
    /// that pops still counts, or <c>a/../a/../…</c> would buy an unbounded walk for a bounded depth.
    /// </summary>
    /// <remarks>
    /// Deliberately stricter than any filesystem: real trees are tens of levels deep, not hundreds,
    /// and the point of a cap is to refuse hostile input rather than to describe what a filesystem
    /// tolerates. The Rust half enforces the same number.
    /// </remarks>
    public const int MaxCandidateComponents = 256;

    /// <summary>
    /// A symlink chain longer than this is treated as a loop and refused, so a link cycle costs a
    /// rejection rather than a hang.
    /// </summary>
    /// <remarks>
    /// 32 is the SMALLEST <c>MAXSYMLINKS</c> among the platforms this ships on (macOS 32, Linux 40,
    /// Windows' reparse-point limit 63), chosen deliberately rather than the classic 40: the Rust
    /// half delegates to the OS, and a budget at the minimum is the only way a hand-rolled counter
    /// can promise never to ACCEPT a chain the OS — and therefore the Rust half — would refuse. The
    /// price is a false reject in the band above it on Linux and Windows; see this file's header.
    /// </remarks>
    private const int MaxSymlinkHops = 32;

    /// <summary>
    /// The reserved DOS device stems Win32 resolves in every directory, as Microsoft enumerates them:
    /// the four classics, the two console handles, and the superscript spellings of the first three
    /// serial/parallel ports. <c>COM1</c>–<c>COM9</c> and <c>LPT1</c>–<c>LPT9</c> are matched by rule
    /// below; <c>COM0</c> and <c>LPT0</c> are NOT reserved — there is no such device.
    /// </summary>
    private static readonly string[] ReservedDeviceNames =
        ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"];

    /// <summary>
    /// Resolves <paramref name="candidate"/> — a path chosen by someone we do not trust — to a real
    /// path under <paramref name="root"/>, or explains why it does not belong there.
    /// </summary>
    /// <param name="root">
    /// The directory the result must stay inside. It must already exist: containment is proven
    /// against the canonicalized root, so a root that cannot be canonicalized is refused with
    /// <see cref="PathEscapeReason.SymlinkEscape"/> rather than guessed at.
    /// </param>
    /// <param name="candidate">
    /// The untrusted path, interpreted relative to <paramref name="root"/>. An empty candidate, a
    /// bare <c>.</c>, or a <c>..</c> chain landing exactly back on the root all denote the root
    /// itself and are accepted as such.
    /// </param>
    /// <param name="resolved">
    /// On success, the resolved absolute path: symlinks in the existing part are already followed,
    /// so a link inside the root pointing elsewhere inside the root is accepted and reported at its
    /// target. Feed <em>this</em> to the filesystem call — re-deriving one from
    /// <paramref name="root"/> and <paramref name="candidate"/> throws away the resolution. Empty on
    /// failure; a refused candidate never hands back a path.
    /// </param>
    /// <param name="reason">
    /// <see cref="PathEscapeReason.None"/> on success, otherwise why the candidate was refused.
    /// </param>
    /// <returns><see langword="true"/> if the candidate resolves to a path under the root.</returns>
    /// <remarks>
    /// The steps, in order, and each one is load-bearing:
    /// <list type="number">
    /// <item><description>
    /// <b>Refuse an anchored candidate.</b> The contract is "a relative path under the root", so an
    /// absolute path is refused even when it happens to point inside.
    /// </description></item>
    /// <item><description>
    /// <b>Normalize lexically, without touching the filesystem.</b> <c>.</c> is dropped and <c>..</c>
    /// pops, so <c>a/../b.json</c> legitimately means <c>&lt;root&gt;/b.json</c>; a <c>..</c> that
    /// would pop above the root is a traversal. This step also enforces the size caps
    /// (<see cref="MaxCandidateBytes"/>, <see cref="MaxCandidateComponents"/>) and refuses a name no
    /// filesystem could store, both as <see cref="PathEscapeReason.Malformed"/> — hostile input is
    /// rejected here, before it can make the next step probe anything.
    /// </description></item>
    /// <item><description>
    /// <b>Resolve against the real filesystem.</b> The normal case is a file that does not exist yet,
    /// so this walks up to the nearest existing ancestor, canonicalizes THAT, and re-appends the
    /// non-existing tail. This is the step a purely lexical check omits, and the one that catches a
    /// symlink. <see cref="Path.GetFullPath(string)"/> normalizes lexically and does <em>not</em>
    /// resolve symlinks — using it alone is exactly the hole CVE-2026-27976 exploited.
    /// </description></item>
    /// <item><description>
    /// <b>Prove containment against the canonicalized root</b>, component-wise — never a string
    /// prefix, or <c>/srv/rootevil</c> passes a <c>/srv/root</c> check. Case-insensitively on
    /// Windows, case-sensitively elsewhere.
    /// </description></item>
    /// </list>
    /// <para>
    /// <b>A dangling symlink is refused.</b> Its target does not exist, so no containment can be
    /// proven for it; treating it as a not-yet-created name would hand back a path that writes
    /// wherever the link points. That is CVE-2026-27976 in miniature.
    /// </para>
    /// <para>
    /// <b>An unreadable level is not an absent one.</b> The ancestor walk continues only past a level
    /// the OS reported as <em>missing</em>; anything else — <c>EACCES</c> on a directory whose mode
    /// forbids traversal, above all — is <see cref="PathEscapeReason.SymlinkEscape"/>. A walk that
    /// treats "I could not look" as "nothing is there" sails straight past the symlink it could not
    /// read.
    /// </para>
    /// <para>
    /// <b>The two implementations knowingly differ</b> on deep symlink chains and on Unicode
    /// normalization. Both divergences are spelled out in this file's header comment and in
    /// <c>tests/fixtures/path-containment/README.md</c>.
    /// </para>
    /// <para>
    /// <b>TOCTOU.</b> The answer describes the filesystem at the moment of the call. An attacker who
    /// can swap a directory for a symlink between this returning and the caller opening the path wins
    /// that race — an inherent limit of path-based checks. This shrinks the window to the smallest
    /// one a path-based API can offer; it does not close it.
    /// </para>
    /// </remarks>
    public static bool TryResolve(string root, string candidate, out string resolved, out PathEscapeReason reason)
    {
        resolved = string.Empty;

        if (string.IsNullOrEmpty(root))
        {
            // Fail closed: with no root there is nothing to prove containment against, and resolving
            // against the working directory would silently widen the boundary to wherever the
            // process happens to be running.
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }

        try
        {
            return TryResolveCore(root, candidate ?? string.Empty, out resolved, out reason);
        }
        catch (Exception ex) when (ex is IOException
                                      or UnauthorizedAccessException
                                      or ArgumentException
                                      or NotSupportedException
                                      or System.Security.SecurityException)
        {
            // Malformed input is a rejection, not an exception: a caller forced to wrap this in a
            // try/catch would eventually catch too much, and a swallowed exception around a
            // containment check is how a check stops being one.
            resolved = string.Empty;
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }
    }

    private static bool TryResolveCore(string root, string candidate, out string resolved, out PathEscapeReason reason)
    {
        resolved = string.Empty;

        // (1) + (2) — pure lexical work, no filesystem access, so a hostile candidate is rejected
        // before it can make us stat anything.
        if (!TryLexicalComponents(candidate, out List<string> relative, out reason))
        {
            return false;
        }

        // `GetFullPath` on the ROOT only, and only to absolutize it. The root is ours, not the
        // untrusted input; it is the candidate that must never be trusted to a lexical check.
        string absoluteRoot = Path.GetFullPath(root);

        // (4a) The yardstick. Canonicalizing the root first means a root that does not exist fails
        // here rather than after a pile of pointless filesystem probes.
        if (!TryCanonicalize(absoluteRoot, out string canonicalRoot))
        {
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }

        // Build `<absoluteRoot>/<relative…>` once, remembering where each ancestor ENDS. The walk
        // below then slices a prefix instead of calling `Path.GetDirectoryName` per level: that
        // allocates a fresh O(n) string every iteration, which made the loop O(n²) over the
        // candidate — 23 seconds of CPU for a 50,000-component name, from a sink (an archive member,
        // a plugin-supplied relative path) that ships. `MaxCandidateComponents` is the real fix; this
        // shape is what stops the next caller from re-earning the same bill under a higher cap.
        var builder = new StringBuilder(absoluteRoot);
        int[] ancestorEnds = new int[relative.Count + 1];
        ancestorEnds[0] = builder.Length;
        for (int i = 0; i < relative.Count; i++)
        {
            // The separator rule `Path.Join` applies, applied once per component instead of
            // re-parsing the whole accumulated path each time.
            if (builder.Length > 0
                && builder[^1] != Path.DirectorySeparatorChar
                && builder[^1] != Path.AltDirectorySeparatorChar)
            {
                builder.Append(Path.DirectorySeparatorChar);
            }

            builder.Append(relative[i]);
            ancestorEnds[i + 1] = builder.Length;
        }

        string joined = builder.ToString();

        // (3) Walk up to the nearest ancestor that exists. The existence test must NOT follow links:
        // a check that follows reports "missing" for a DANGLING symlink, which would let the walk
        // sail past it and treat it as a free name inside the root. And it must distinguish "nothing
        // is here" from "I could not look": `File.Exists`/`Directory.Exists` answer `false` to both,
        // so a directory whose mode forbids traversal used to look exactly like a free name — the
        // walk sailed past a symlink it could not read and handed back a path that writes through it
        // the moment the mode is restored. `CannotTell` fails closed.
        int depth = relative.Count;
        while (depth >= 0)
        {
            Existence existence = ProbeEntry(joined[..ancestorEnds[depth]]).Existence;
            if (existence == Existence.Exists)
            {
                break;
            }

            if (existence == Existence.CannotTell)
            {
                reason = PathEscapeReason.SymlinkEscape;
                return false;
            }

            depth--;
        }

        if (depth < 0)
        {
            // Ran out of ancestors without finding one that exists. Unreachable in practice (the
            // canonicalized root above proves at least the root exists), but there is no safe guess
            // to make here.
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }

        // An entry that exists but cannot be canonicalized is a dangling symlink.
        if (!TryCanonicalize(joined[..ancestorEnds[depth]], out string resolvedPath))
        {
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }

        // Every skipped segment is a plain name (step 2 removed the `.` and `..` ones), so
        // re-appending them cannot re-introduce traversal. `Path.Join`, not `Path.Combine`: Combine
        // discards everything to its left when the right-hand side looks rooted, which would turn a
        // component into an anchor.
        for (int i = depth; i < relative.Count; i++)
        {
            resolvedPath = Path.Join(resolvedPath, relative[i]);
        }

        // (4b)
        if (!IsContained(canonicalRoot, resolvedPath))
        {
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }

        resolved = resolvedPath;
        reason = PathEscapeReason.None;
        return true;
    }

    /// <summary>
    /// Steps 1 and 2: reject an anchored candidate, then reduce the rest to the plain components it
    /// denotes relative to the root, rejecting any <c>..</c> that would pop above it — and, first of
    /// all, refusing a candidate too big to be worth walking.
    /// </summary>
    private static bool TryLexicalComponents(string candidate, out List<string> components, out PathEscapeReason reason)
    {
        components = [];
        reason = PathEscapeReason.None;
        bool windows = OperatingSystem.IsWindows();

        // The size cap comes before the split, not inside the loop: the whole point is that no
        // hostile candidate reaches the filesystem, and even splitting a 64 KiB name is work we owe
        // nobody.
        if (Encoding.UTF8.GetByteCount(candidate) > MaxCandidateBytes)
        {
            reason = PathEscapeReason.Malformed;
            return false;
        }

        if (IsAnchored(candidate, windows))
        {
            reason = PathEscapeReason.Absolute;
            return false;
        }

        int seen = 0;
        foreach (string segment in SplitComponents(candidate, windows))
        {
            if (++seen > MaxCandidateComponents)
            {
                reason = PathEscapeReason.Malformed;
                return false;
            }

            // A NUL cannot be stored in a name on any filesystem this ships on, and every filesystem
            // API here rejects it with an error that is NOT "not found" — so without this screen the
            // walk would fail closed with a `SymlinkEscape` naming a symlink nobody wrote. Say what
            // actually happened instead.
            if (segment.Contains('\0', StringComparison.Ordinal))
            {
                reason = PathEscapeReason.Malformed;
                return false;
            }

            // On Windows the device screen runs BEFORE the `.`/`..` classification, so `CON ` stays
            // the `Absolute` it has always been rather than being reclassified by its trailing space.
            // It never fires on a `.`/`..` disguise: their stem — the text before the first `.` — is
            // empty.
            if (windows && IsWindowsReinterpreted(segment))
            {
                reason = PathEscapeReason.Absolute;
                return false;
            }

            // Win32 strips trailing SPACES from every path component before resolving it, so `.. ` is
            // a parent reference wearing a disguise — and this half hands back a NON-verbatim path
            // that Win32 normalizes again when the caller opens it, which is how `<root>\.. \evil.txt`
            // would otherwise become `<sandbox>\evil.txt`: Zip Slip straight past the primitive.
            // Comparing against the exact string `".."` is what misses it. Dots are structural, so
            // only spaces are stripped for this test: `...` is not a parent reference by any reading.
            string classified = windows ? segment.TrimEnd(' ') : segment;

            if (classified == ".")
            {
                continue;
            }

            if (classified == "..")
            {
                if (components.Count == 0)
                {
                    // Nothing left to pop: this `..` leaves the root.
                    reason = PathEscapeReason.Traversal;
                    return false;
                }

                components.RemoveAt(components.Count - 1);
                continue;
            }

            // Anything else ending in a dot or a space (`a `, `evil.txt.`, `...`, `   `) is a name
            // Win32 will silently REWRITE. Refused rather than guessed at: a primitive whose answer
            // means one thing to the caller and another to the filesystem is the entire bug class
            // this file exists to close, and Microsoft's own guidance is not to end a name with a
            // space or a period. Nothing legitimate is lost — such a name can only be created through
            // a `\\?\` verbatim path in the first place. Off Windows they are ordinary names, which is
            // why `.../asset.png` is accepted there and refused here.
            if (windows && (segment[^1] == '.' || segment[^1] == ' '))
            {
                reason = PathEscapeReason.Malformed;
                return false;
            }

            components.Add(segment);
        }

        return true;
    }

    /// <summary>
    /// True if the candidate is anchored somewhere of its own choosing rather than relative to the
    /// root.
    /// </summary>
    private static bool IsAnchored(string candidate, bool windows)
    {
        if (candidate.Length == 0)
        {
            return false;
        }

        // A leading `/` is a root on every platform (and on Windows also covers `//server/share`).
        if (candidate[0] == '/')
        {
            return true;
        }

        if (!windows)
        {
            return false;
        }

        // `\Windows\…`, `\\server\share`, and the verbatim `\\?\C:\…`.
        if (candidate[0] == '\\')
        {
            return true;
        }

        // `C:\…` and the drive-RELATIVE `C:evil`, which resolves against the process's per-drive
        // current directory and so is emphatically not contained despite not being `IsPathRooted`.
        return candidate.Length >= 2 && candidate[1] == ':' && char.IsAsciiLetter(candidate[0]);
    }

    /// <summary>
    /// Splits on the separators the running platform recognizes, dropping empty segments so repeated
    /// and trailing separators collapse the way both platforms' own path parsers do.
    /// </summary>
    /// <remarks>
    /// A backslash is a separator on Windows and an ordinary, legal filename character everywhere
    /// else — so <c>..\..\evil</c> is a traversal on one platform and a single innocuous filename on
    /// the other. Hardcoding <see cref="Path.DirectorySeparatorChar"/> here is precisely how the .NET
    /// and Rust implementations would come to disagree.
    /// </remarks>
    private static IEnumerable<string> SplitComponents(string path, bool windows)
    {
        char[] separators = windows ? ['/', '\\'] : ['/'];
        return path.Split(separators, StringSplitOptions.RemoveEmptyEntries);
    }

    /// <summary>
    /// True if Windows would read <paramref name="name"/> as something other than a plain file in the
    /// current directory.
    /// </summary>
    /// <remarks>
    /// Two families, both of which turn a "contained" path into an uncontained effect: a <c>:</c>
    /// makes it a drive qualifier (<c>C:evil</c>) or an alternate data stream
    /// (<c>file.txt:hidden</c>) — and a colon is not a legal character in a Windows filename anyway,
    /// so nothing legitimate is lost by refusing it; and a reserved DOS device name resolves to a
    /// device in the global namespace no matter which directory it is written in, and keeps doing so
    /// with an extension (<c>NUL.txt</c>) or trailing spaces (<c>CON&#160;</c>), which Win32 strips.
    /// Off Windows these are ordinary filenames — a Unix file may legitimately be called <c>a:b</c>
    /// or <c>NUL</c> — so callers gate this on the running platform.
    /// <para>
    /// A trailing dot or space that does NOT make the name a device is handled by the caller, as
    /// <see cref="PathEscapeReason.Malformed"/>: this predicate answers "is it a device or a stream",
    /// which is a different question with a different answer.
    /// </para>
    /// </remarks>
    private static bool IsWindowsReinterpreted(string name)
    {
        if (name.Contains(':', StringComparison.Ordinal))
        {
            return true;
        }

        // Win32 looks only at the part before the first `.`, and strips trailing spaces.
        int dot = name.IndexOf('.', StringComparison.Ordinal);
        string stem = (dot < 0 ? name : name[..dot]).TrimEnd(' ');

        foreach (string reserved in ReservedDeviceNames)
        {
            if (string.Equals(stem, reserved, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        // `COM<1-9>` / `LPT<1-9>`. Win32 reserves neither `COM0` nor `LPT0` — there is no such
        // device — so refusing them would cost a legitimate name for nothing.
        return stem.Length == 4
            && char.IsAsciiDigit(stem[3])
            && stem[3] != '0'
            && (stem.AsSpan(0, 3).Equals("COM", StringComparison.OrdinalIgnoreCase)
                || stem.AsSpan(0, 3).Equals("LPT", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The equivalent of Rust's <c>std::fs::canonicalize</c> / POSIX <c>realpath</c>: resolves every
    /// symlink on the way down and requires the final path to exist.
    /// </summary>
    /// <remarks>
    /// Hand-rolled because .NET has no realpath. <see cref="Path.GetFullPath(string)"/> normalizes
    /// lexically only, and <c>ResolveLinkTarget</c> resolves the leaf of a chain but not links in the
    /// intermediate components — and it is precisely an intermediate component
    /// (<c>&lt;root&gt;/link/passwd</c>) that the CVEs turned into an escape. Descending
    /// component-by-component also gets the awkward cases right for free: a relative link target
    /// (macOS' own <c>/var</c> → <c>private/var</c>) is re-expanded against the link's directory, and
    /// a <c>..</c> pops the already-RESOLVED path rather than the lexical one.
    /// </remarks>
    private static bool TryCanonicalize(string absolutePath, out string canonical)
    {
        canonical = string.Empty;

        string pathRoot = Path.GetPathRoot(absolutePath) ?? string.Empty;
        if (pathRoot.Length == 0)
        {
            return false;
        }

        bool windows = OperatingSystem.IsWindows();

        // A stack of components still to consume: the last entry is the next one out, so expanding a
        // symlink target means pushing its components (reversed) on top of what remains.
        var pending = new List<string>();
        PushReversed(pending, absolutePath[pathRoot.Length..], windows);

        string current = pathRoot;
        int hops = 0;

        while (pending.Count > 0)
        {
            string component = pending[^1];
            pending.RemoveAt(pending.Count - 1);

            if (component == ".")
            {
                continue;
            }

            if (component == "..")
            {
                current = ParentOf(current, pathRoot);
                continue;
            }

            string next = Path.Join(current, component);
            EntryProbe probe = ProbeEntry(next);
            if (probe.Existence == Existence.CannotTell)
            {
                // We could not read this level, so we cannot say what is at it. Fail closed rather
                // than adopt it as a plain name — that is the same "could not look" / "nothing there"
                // confusion the ancestor walk had.
                return false;
            }

            string? target = probe.LinkTarget;
            if (target is null)
            {
                // A plain entry, or a name that does not exist yet: adopt it and let the final
                // existence check below have the last word.
                current = next;
                continue;
            }

            if (++hops > MaxSymlinkHops)
            {
                return false;
            }

            string targetRoot = Path.GetPathRoot(target) ?? string.Empty;
            if (targetRoot.Length > 0)
            {
                // An absolute link target restarts the descent from its own root.
                current = targetRoot;
                PushReversed(pending, target[targetRoot.Length..], windows);
            }
            else
            {
                // A relative target is resolved against the link's own directory — which is
                // `current`, since `next` has not been adopted.
                PushReversed(pending, target, windows);
            }
        }

        if (!ResolvedTargetExists(current))
        {
            return false;
        }

        canonical = current;
        return true;
    }

    private static void PushReversed(List<string> pending, string relative, bool windows)
    {
        string[] parts = relative.Split(windows ? ['/', '\\'] : ['/'], StringSplitOptions.RemoveEmptyEntries);
        for (int i = parts.Length - 1; i >= 0; i--)
        {
            pending.Add(parts[i]);
        }
    }

    private static string ParentOf(string current, string pathRoot)
    {
        string? parent = Path.GetDirectoryName(current);
        return string.IsNullOrEmpty(parent) ? pathRoot : parent;
    }

    /// <summary>What the filesystem was able to say about a path.</summary>
    private enum Existence
    {
        /// <summary>The OS said there is nothing here.</summary>
        DoesNotExist,

        /// <summary>Something is here — a file, a directory, or a symlink, dangling or not.</summary>
        Exists,

        /// <summary>
        /// The OS refused to answer: the containing directory denies traversal, the name is too long,
        /// the path is malformed. Never treat this as absence — the whole failure this closes is a
        /// walk that read <c>EACCES</c> as <c>ENOENT</c> and sailed past a symlink it could not read.
        /// </summary>
        CannotTell,
    }

    /// <summary>What a probe found: whether anything is there, and the raw link target if it is a link.</summary>
    private readonly record struct EntryProbe(Existence Existence, string? LinkTarget);

    /// <summary>
    /// Asks the filesystem about one path, without following a link out of it, and reports which of
    /// the three answers it got.
    /// </summary>
    /// <remarks>
    /// <see cref="File.GetAttributes(string)"/> rather than
    /// <see cref="File.Exists(string)"/>/<see cref="Directory.Exists(string)"/> because those two
    /// return <see langword="false"/> for BOTH "nothing is here" and "I was not allowed to look", and
    /// this walk must not confuse them. <c>GetAttributes</c> throws distinguishably —
    /// <see cref="FileNotFoundException"/>/<see cref="DirectoryNotFoundException"/> for the first,
    /// <see cref="UnauthorizedAccessException"/> (and <see cref="PathTooLongException"/>,
    /// <see cref="ArgumentException"/>, …) for the second — and it does not follow links: a dangling
    /// symlink reports <see cref="FileAttributes.ReparsePoint"/> rather than "missing", which is what
    /// lets the ancestor walk stop AT the link.
    /// <para>
    /// Note <c>ENOTDIR</c> (an intermediate component is a file) arrives as
    /// <see cref="DirectoryNotFoundException"/>, indistinguishable from <c>ENOENT</c>. That is
    /// deliberate on both sides: nothing can exist below a regular file either, and the Rust half
    /// lets <c>ErrorKind::NotADirectory</c> continue its walk for the same reason.
    /// </para>
    /// </remarks>
    private static EntryProbe ProbeEntry(string path)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) == 0)
            {
                return new EntryProbe(Existence.Exists, null);
            }

            // A reparse point whose target cannot be read is not a plain entry and is not absent
            // either — it is a link we cannot follow, so we cannot prove where it lands.
            string? target = new FileInfo(path).LinkTarget;
            return target is null
                ? new EntryProbe(Existence.CannotTell, null)
                : new EntryProbe(Existence.Exists, target);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return new EntryProbe(Existence.DoesNotExist, null);
        }
        catch (Exception ex) when (ex is IOException
                                      or UnauthorizedAccessException
                                      or ArgumentException
                                      or NotSupportedException
                                      or System.Security.SecurityException)
        {
            return new EntryProbe(Existence.CannotTell, null);
        }
    }

    /// <summary>
    /// Does the fully-resolved path exist as something other than a link? Everything the descent
    /// touched has already had its symlinks followed, so anything still reporting as a link here is
    /// one the descent could not resolve — and calling that "resolved" is exactly the hole this
    /// closes. A path the filesystem would not answer about is refused for the same reason.
    /// </summary>
    private static bool ResolvedTargetExists(string path)
    {
        EntryProbe probe = ProbeEntry(path);
        return probe.Existence == Existence.Exists && probe.LinkTarget is null;
    }

    /// <summary>
    /// True if <paramref name="path"/> is <paramref name="root"/> or lies beneath it, compared
    /// component-wise — <c>/srv/rootevil</c> is not under <c>/srv/root</c>, however much the strings
    /// agree. Case-insensitively on Windows, case-sensitively elsewhere, matching each platform's own
    /// filesystem rule.
    /// </summary>
    private static bool IsContained(string root, string path)
    {
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        List<string> rootParts = SplitAll(root);
        List<string> pathParts = SplitAll(path);
        if (pathParts.Count < rootParts.Count)
        {
            // `path` ran out first: it is an ancestor of the root, not a descendant.
            return false;
        }

        for (int i = 0; i < rootParts.Count; i++)
        {
            if (!string.Equals(rootParts[i], pathParts[i], comparison))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// An absolute path as its comparable components: the root prefix (<c>/</c>, <c>C:</c>,
    /// <c>\\server\share</c>) followed by each named component.
    /// </summary>
    private static List<string> SplitAll(string path)
    {
        bool windows = OperatingSystem.IsWindows();
        var parts = new List<string>();

        string pathRoot = Path.GetPathRoot(path) ?? string.Empty;
        string rest = path;
        if (pathRoot.Length > 0)
        {
            string trimmed = pathRoot.TrimEnd('/', '\\');
            parts.Add(trimmed.Length > 0 ? trimmed : "/");
            rest = path[pathRoot.Length..];
        }

        parts.AddRange(SplitComponents(rest, windows));
        return parts;
    }
}
