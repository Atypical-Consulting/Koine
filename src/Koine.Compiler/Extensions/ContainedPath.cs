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
// It fails CLOSED. Anything it cannot prove contained is refused, and it never throws: a caller that
// has to wrap this in a try/catch will eventually catch too much.

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
    /// outside the root through a symlink, the root itself cannot be canonicalized, or a component
    /// cannot be resolved at all (a dangling symlink).
    /// </summary>
    SymlinkEscape = 3,
}

/// <summary>
/// Resolves a path chosen by someone we do not trust to a real path under a root we do — or refuses
/// it with a typed reason.
/// </summary>
public static class ContainedPath
{
    /// <summary>
    /// A symlink chain longer than this is treated as a loop and refused. Matches the classic
    /// <c>MAXSYMLINKS</c> budget, and exists so a link cycle costs a rejection rather than a hang.
    /// </summary>
    private const int MaxSymlinkHops = 40;

    /// <summary>The reserved DOS device stems Win32 resolves in every directory.</summary>
    private static readonly string[] ReservedDeviceNames = ["CON", "PRN", "AUX", "NUL"];

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
    /// would pop above the root is a traversal.
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

        string normalized = absoluteRoot;
        foreach (string segment in relative)
        {
            // `Path.Join`, not `Path.Combine`: Combine discards everything to its left when the
            // right-hand side looks rooted, which would turn a component into an anchor.
            normalized = Path.Join(normalized, segment);
        }

        // (3) Walk up to the nearest ancestor that exists, remembering the tail we skipped past.
        // The existence test must NOT follow links: a check that follows reports "missing" for a
        // DANGLING symlink, which would let the walk sail past it and treat it as a free name inside
        // the root.
        var tail = new List<string>();
        string ancestor = normalized;
        while (!EntryExists(ancestor))
        {
            string? parent = Path.GetDirectoryName(ancestor);
            string name = Path.GetFileName(ancestor);
            if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(name))
            {
                // Ran out of ancestors without finding one that exists. Unreachable in practice (the
                // canonicalized root above proves at least the root exists), but there is no safe
                // guess to make here.
                reason = PathEscapeReason.SymlinkEscape;
                return false;
            }

            tail.Add(name);
            ancestor = parent;
        }

        // An entry that exists but cannot be canonicalized is a dangling symlink.
        if (!TryCanonicalize(ancestor, out string resolvedPath))
        {
            reason = PathEscapeReason.SymlinkEscape;
            return false;
        }

        // The tail was collected leaf-first; every segment is a plain name (step 2 removed the `.`
        // and `..` ones), so re-appending them cannot re-introduce traversal.
        for (int i = tail.Count - 1; i >= 0; i--)
        {
            resolvedPath = Path.Join(resolvedPath, tail[i]);
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
    /// denotes relative to the root, rejecting any <c>..</c> that would pop above it.
    /// </summary>
    private static bool TryLexicalComponents(string candidate, out List<string> components, out PathEscapeReason reason)
    {
        components = [];
        reason = PathEscapeReason.None;
        bool windows = OperatingSystem.IsWindows();

        if (IsAnchored(candidate, windows))
        {
            reason = PathEscapeReason.Absolute;
            return false;
        }

        foreach (string segment in SplitComponents(candidate, windows))
        {
            if (segment == ".")
            {
                continue;
            }

            if (segment == "..")
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

            if (windows && IsWindowsReinterpreted(segment))
            {
                reason = PathEscapeReason.Absolute;
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

        // `COM<digit>` / `LPT<digit>`.
        return stem.Length == 4
            && char.IsAsciiDigit(stem[3])
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
            string? target = LinkTargetOf(next);
            if (target is null)
            {
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

    /// <summary>
    /// The raw target of a symbolic link, or <see langword="null"/> if the path is not a link (which
    /// includes not existing at all). Reports the target of a DANGLING link too, which is the whole
    /// reason this is used instead of an existence check.
    /// </summary>
    private static string? LinkTargetOf(string path)
    {
        try
        {
            return new FileInfo(path).LinkTarget;
        }
        catch (Exception ex) when (ex is IOException
                                      or UnauthorizedAccessException
                                      or ArgumentException
                                      or NotSupportedException
                                      or System.Security.SecurityException)
        {
            return null;
        }
    }

    /// <summary>
    /// Does something exist at this exact path, without following a link out of it? True for a
    /// dangling symlink — that is the point: the ancestor walk must stop AT the link rather than
    /// treating it as a free name inside the root.
    /// </summary>
    private static bool EntryExists(string path)
        => File.Exists(path) || Directory.Exists(path) || LinkTargetOf(path) is not null;

    /// <summary>
    /// Does the fully-resolved path exist? Everything the descent touched has already had its
    /// symlinks followed, so a plain stat is the right question — but a link is re-checked for
    /// anyway, because <see cref="File.Exists(string)"/> reports <see langword="true"/> for a
    /// dangling symlink on some platforms, and calling one "resolved" is exactly the hole this closes.
    /// </summary>
    private static bool ResolvedTargetExists(string path)
        => LinkTargetOf(path) is null && (File.Exists(path) || Directory.Exists(path));

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
