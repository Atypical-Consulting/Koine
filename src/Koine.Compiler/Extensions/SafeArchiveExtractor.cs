// Koine — archive extraction that treats every archive MEMBER as untrusted (#1942).
//
// WHY THIS EXISTS. Zed shipped extension-archive extraction twice with a check on the DESTINATION
// and none on the members, and got CVE-2026-27800 (Zip Slip — a member named `../../…` written
// outside the destination) and CVE-2026-27976 (a tar carrying a symlink member, followed by a member
// written THROUGH that link, turned into arbitrary file write and then RCE) for it. The lesson is one
// sentence: the archive's members are the attack surface, not the destination parameter. A caller who
// validated `destinationRoot` and then called `ZipFile.ExtractToDirectory` has validated the one input
// the attacker does not control.
//
// So this type resolves EVERY member through `ContainedPath.TryResolve` against the live filesystem —
// the same primitive the Tauri host uses (`tooling/koine-studio/src-tauri/src/paths.rs`) — on top of a
// cheap syntactic pre-filter, refuses link members outright, caps what a member and an archive may
// decompress to, and unwinds everything it created the moment any of that says no.
//
// It fails CLOSED and it does not throw. Hostile or merely corrupt bytes come back as a failed
// `ExtractResult`, because at the call sites this is aimed at — the Tauri host and the CLI sidecar —
// an escaping exception is an unhandled crash, and a caller forced to wrap an extraction in a
// try/catch will eventually catch too much.

using System.Buffers;
using System.Formats.Tar;
using System.IO.Compression;

namespace Koine.Compiler.Extensions;

/// <summary>The archive container formats <see cref="SafeArchiveExtractor"/> can read.</summary>
/// <remarks>
/// Both are read with the BCL's own readers (<see cref="ZipArchive"/> and <see cref="TarReader"/>);
/// this deliberately takes no third-party archive dependency, because a decompressor is exactly the
/// kind of code you do not want to be the first to find a bug in.
/// </remarks>
public enum ArchiveKind
{
    /// <summary>A PKZIP container, read with <see cref="ZipArchive"/>.</summary>
    Zip = 1,

    /// <summary>An uncompressed tar container, read with <see cref="TarReader"/>.</summary>
    Tar = 2,
}

/// <summary>
/// Why <see cref="SafeArchiveExtractor.Extract"/> refused an archive. Every value except
/// <see cref="None"/> means nothing was left behind: the extraction was unwound.
/// </summary>
public enum ArchiveRejectionReason
{
    /// <summary>No rejection — the only value reported alongside a successful result.</summary>
    None = 0,

    /// <summary>
    /// The bytes are not a readable archive of the declared kind, or they stop mid-member. Corruption
    /// and a deliberately truncated container are indistinguishable from here, and both are refused.
    /// </summary>
    MalformedArchive = 1,

    /// <summary>
    /// The member name cannot denote a member: it is empty or whitespace, carries a NUL, or resolves
    /// to the destination root itself (a file entry named <c>.</c> would have to overwrite the root
    /// directory). A <em>directory</em> entry denoting the root is not this — it is a no-op, because
    /// <c>tar -cf x.tar .</c> legitimately emits one.
    /// </summary>
    MemberNameInvalid = 2,

    /// <summary>
    /// The member name is anchored somewhere of its own choosing rather than relative to the
    /// destination: <c>/etc/passwd</c>, <c>\Windows\…</c>, a drive qualifier (<c>C:\…</c>, and the
    /// drive-RELATIVE <c>C:evil</c>), a UNC path, or the verbatim <c>\\?\C:\…</c> prefix.
    /// </summary>
    MemberNameAnchored = 3,

    /// <summary>
    /// The member name contains a backslash. Both container specs mandate <c>/</c>, so a backslash is
    /// either a non-conforming Windows-authored archive or an attack — and its meaning is
    /// platform-dependent (<c>..\..\evil.txt</c> is a traversal on Windows and one legal filename on
    /// Unix), which is precisely how an extractor ends up safe on the developer's machine and not on
    /// the user's.
    /// </summary>
    MemberNameBackslash = 4,

    /// <summary>The member name contains a <c>..</c> component — Zip Slip, CVE-2026-27800's shape.</summary>
    MemberNameTraversal = 5,

    /// <summary>
    /// The member's name survived the syntactic filter but does not resolve to a path under the
    /// destination root once the filesystem has its say — it lands beyond a symbolic link. This is the
    /// check a lexical-only extractor omits.
    /// </summary>
    MemberEscapesRoot = 6,

    /// <summary>
    /// The member is a symbolic link or a hard link. Refused wholesale — see the remarks on
    /// <see cref="SafeArchiveExtractor"/> for why, and for what it would take to support them.
    /// </summary>
    LinkMember = 7,

    /// <summary>
    /// The member is neither a regular file nor a directory nor a link — a device node, a FIFO, a
    /// sparse or multi-volume entry. Nothing an extension archive needs, and each one is a way to ask
    /// the extractor to do something other than write a file.
    /// </summary>
    UnsupportedMemberType = 8,

    /// <summary>
    /// Two members resolve to the same path, or a member's path already exists in the destination.
    /// Refused rather than overwritten: an extraction that clobbers cannot be unwound (the previous
    /// contents are gone), which would make <see cref="SafeArchiveExtractor"/>'s all-or-nothing
    /// promise a lie, and "the last member wins" is an easy way to smuggle a payload past a reviewer
    /// who read the first one.
    /// </summary>
    DuplicateMember = 9,

    /// <summary>The archive declares more members than the member cap allows.</summary>
    TooManyMembers = 10,

    /// <summary>A single member decompressed past the per-member cap — a zip bomb.</summary>
    MemberTooLarge = 11,

    /// <summary>The members together decompressed past the whole-archive cap — a zip bomb.</summary>
    ArchiveTooLarge = 12,

    /// <summary>
    /// The destination root is unusable: empty, an existing file rather than a directory, not
    /// creatable, or not canonicalizable — so there is nothing to prove containment against.
    /// </summary>
    DestinationUnusable = 13,
}

/// <summary>
/// The outcome of a <see cref="SafeArchiveExtractor.Extract"/> call: either everything was written or
/// nothing was.
/// </summary>
/// <param name="Succeeded">
/// <see langword="true"/> if every member was extracted. <see langword="false"/> means the extraction
/// was unwound — no file it created survives, and a destination root it created is gone too.
/// </param>
/// <param name="Reason">
/// <see cref="ArchiveRejectionReason.None"/> on success, otherwise why the archive was refused.
/// </param>
/// <param name="OffendingMember">
/// The member name that caused the rejection, verbatim as the archive spelled it, or
/// <see langword="null"/> when no single member is to blame (malformed bytes, an unusable
/// destination). Attacker-controlled text: log it, do not interpolate it into a shell or a path.
/// </param>
/// <param name="FilesWritten">Regular files created. Zero on any failure.</param>
/// <param name="DirectoriesCreated">
/// Directories created on disk — both explicit directory members and the parents implied by a file
/// member's path. Directories that already existed are not counted. Zero on any failure.
/// </param>
/// <param name="BytesWritten">
/// Uncompressed bytes actually written, counted as they streamed. Zero on any failure. This is a
/// measurement, never <c>ZipArchiveEntry.Length</c> — that number is attacker-controlled metadata.
/// </param>
public sealed record ExtractResult(
    bool Succeeded,
    ArchiveRejectionReason Reason,
    string? OffendingMember,
    int FilesWritten,
    int DirectoriesCreated,
    long BytesWritten);

/// <summary>
/// Extracts a zip or tar archive supplied by someone we do not trust into a directory we do — or
/// refuses it and leaves nothing behind.
/// </summary>
/// <remarks>
/// <para>
/// <b>The contract, in five parts.</b>
/// </para>
/// <list type="number">
/// <item><description>
/// <b>A syntactic pre-filter, before any join.</b> A member name that is empty, anchored, carries a
/// backslash, or contains a <c>..</c> component is refused without touching the filesystem. This is
/// cheap, platform-independent, and reviewable — but it is deliberately <em>in addition to</em> the
/// next step, never instead of it.
/// </description></item>
/// <item><description>
/// <b>Every member resolves through <see cref="ContainedPath.TryResolve"/></b> against the destination
/// root, on the live filesystem. That is what catches what syntax cannot: a member landing under a
/// symbolic link. The write then goes to the path the primitive handed back, not to a path
/// re-derived from the root and the member name — re-deriving throws the resolution away.
/// </description></item>
/// <item><description>
/// <b>Link members are refused wholesale.</b> See below.
/// </description></item>
/// <item><description>
/// <b>Caps on member count, per-member size and total size</b>, all enforced against bytes counted as
/// they stream. Nothing is decompressed into memory, and no declared length is believed.
/// </description></item>
/// <item><description>
/// <b>Any rejection unwinds the whole extraction.</b> There is no half-installed state: every file
/// and directory this call created is removed, and if the destination root itself did not exist
/// beforehand it is removed too.
/// </description></item>
/// </list>
/// <para>
/// <b>Why link members are refused wholesale, and not validated.</b> The spec allowed either; this
/// takes the strict option. A symlink or hardlink member is not something an extension archive needs,
/// and admitting one buys a subtle obligation: CVE-2026-27976's shape is a member that creates an
/// in-root symlink followed by a <em>later</em> member written through it, so an extractor that
/// accepts link members is only safe for as long as every subsequent member keeps being re-resolved
/// against the live filesystem. This extractor does exactly that today — step 2 runs per member,
/// after the earlier ones have already hit the disk, so a member landing under a link an earlier
/// member created is caught by the primitive. But that safety would then be a <em>dynamic</em>
/// property, one that a refactor moving resolution out of the loop (or caching it) silently deletes,
/// with no test able to name the invariant it broke. Refusing the member type is a <em>static</em>
/// property instead: the archive either declares a link or it does not, and the check cannot rot.
/// A hard link is refused for the same reason plus one of its own — its target is an already-written
/// member, so it can alias a file into a second name after that file passed review.
/// If link support is ever genuinely required, the work is to validate the link's target through the
/// same primitive AND to write a test that fails if per-member re-resolution is ever hoisted.
/// </para>
/// <para>
/// <b>Nothing about permissions or ownership is preserved.</b> A tar member carries a Unix mode, a
/// uid and a gid; a zip member can carry external attributes. All of it is discarded, and every file
/// is created with the process's default permissions. A tar can carry a setuid bit, and an extractor
/// that faithfully reproduced one would be handing an archive author a privilege-escalation
/// primitive for free. If executability ever matters, it belongs in a manifest the caller reads —
/// not in metadata the attacker writes.
/// </para>
/// <para>
/// <b>Platform-specific member names.</b> The syntactic filter is identical on every OS, so a corpus
/// case behaves the same everywhere. Names whose <em>effect</em> is platform-specific — an alternate
/// data stream (<c>file.txt:hidden</c>), a reserved DOS device name (<c>NUL.txt</c>) — are the
/// primitive's business and are refused by it on Windows, where they mean something, and treated as
/// ordinary filenames elsewhere, where they do not.
/// </para>
/// <para>
/// <b>TOCTOU.</b> Containment is proven against the filesystem as it stands at the moment of the
/// check. An attacker who can swap a directory for a symlink between the resolve and the write wins
/// that race — the inherent limit of every path-based check, inherited from
/// <see cref="ContainedPath"/>. This shrinks the window; it does not close it. A caller who can
/// arrange for the destination root to be private to the extraction (a fresh directory, moved into
/// place afterwards) should.
/// </para>
/// </remarks>
public static class SafeArchiveExtractor
{
    /// <summary>
    /// Default cap on how many members an archive may declare. Conservative on purpose: a caller who
    /// knows its archives are small should pass something smaller still.
    /// </summary>
    public const int DefaultMaxMemberCount = 4096;

    /// <summary>Default cap on the total uncompressed bytes an archive may expand to (64 MiB).</summary>
    public const long DefaultMaxTotalBytes = 64L * 1024 * 1024;

    /// <summary>Default cap on the uncompressed bytes a single member may expand to (16 MiB).</summary>
    public const long DefaultMaxMemberBytes = 16L * 1024 * 1024;

    /// <summary>Streaming copy buffer size. Rented, so a large archive does not churn the LOH.</summary>
    private const int CopyBufferSize = 81920;

    /// <summary>Paths compare the way the running platform's filesystem compares them.</summary>
    private static StringComparer PathComparer => OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase
        : StringComparer.Ordinal;

    /// <summary>
    /// Extracts <paramref name="archive"/> into <paramref name="destinationRoot"/>, refusing any
    /// member that could write outside it and unwinding everything on the first refusal.
    /// </summary>
    /// <param name="archive">
    /// The archive bytes. Read forward-only; the stream is left open and its position is not restored.
    /// </param>
    /// <param name="kind">Which container <paramref name="archive"/> holds.</param>
    /// <param name="destinationRoot">
    /// The directory every member must land inside. Created if it does not exist — and removed again
    /// if the extraction is refused, so a rejected archive leaves the filesystem as it found it.
    /// </param>
    /// <param name="maxMemberCount">
    /// Cap on declared members. Defaults to <see cref="DefaultMaxMemberCount"/>.
    /// </param>
    /// <param name="maxTotalBytes">
    /// Cap on total uncompressed bytes. Defaults to <see cref="DefaultMaxTotalBytes"/>.
    /// </param>
    /// <param name="maxMemberBytes">
    /// Cap on one member's uncompressed bytes. Defaults to <see cref="DefaultMaxMemberBytes"/>.
    /// </param>
    /// <returns>
    /// A result that is either a complete extraction or a typed refusal. <b>It never reports a partial
    /// one</b>, and it never throws for hostile or corrupt archive content.
    /// </returns>
    /// <exception cref="ArgumentNullException"><paramref name="archive"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentOutOfRangeException">A cap is zero or negative.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="kind"/> is not a declared value.</exception>
    /// <remarks>
    /// The argument checks above are the only exceptions this can raise, and each is a caller bug
    /// rather than anything an archive can provoke. Everything the <em>archive</em> can do — a
    /// traversal, a link, a bomb, truncated bytes, an unreadable deflate stream — comes back as a
    /// failed <see cref="ExtractResult"/>.
    /// </remarks>
    public static ExtractResult Extract(
        Stream archive,
        ArchiveKind kind,
        string destinationRoot,
        int maxMemberCount = DefaultMaxMemberCount,
        long maxTotalBytes = DefaultMaxTotalBytes,
        long maxMemberBytes = DefaultMaxMemberBytes)
    {
        ArgumentNullException.ThrowIfNull(archive);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxMemberCount);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxTotalBytes);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxMemberBytes);
        if (kind is not (ArchiveKind.Zip or ArchiveKind.Tar))
        {
            throw new ArgumentOutOfRangeException(nameof(kind), kind, "unknown archive kind");
        }

        var session = new Session(maxMemberCount, maxTotalBytes, maxMemberBytes);
        ExtractResult result;
        try
        {
            result = Run(archive, kind, destinationRoot, session);
        }
        catch (Exception ex) when (IsArchiveFault(ex))
        {
            // Corrupt bytes, a truncated container, a deflate stream that does not decode — all
            // indistinguishable from a deliberately malformed archive, and all a result rather than
            // an exception. The catch list is enumerated rather than `catch (Exception)`: swallowing
            // everything around a security check is how a check stops being one.
            result = Fail(ArchiveRejectionReason.MalformedArchive, null);
        }

        if (!result.Succeeded)
        {
            session.Rollback();
        }

        return result;
    }

    private static ExtractResult Run(Stream archive, ArchiveKind kind, string destinationRoot, Session session)
    {
        if (string.IsNullOrWhiteSpace(destinationRoot))
        {
            // Fail closed, exactly as `ContainedPath` does for an empty root: resolving against the
            // working directory would silently widen the boundary to wherever the process happens to
            // be running.
            return Fail(ArchiveRejectionReason.DestinationUnusable, null);
        }

        if (!session.TryPrepareRoot(destinationRoot, out string canonicalRoot))
        {
            return Fail(ArchiveRejectionReason.DestinationUnusable, null);
        }

        ExtractResult? failure = kind == ArchiveKind.Zip
            ? ExtractZip(archive, session, canonicalRoot)
            : ExtractTar(archive, session, canonicalRoot);

        return failure ?? new ExtractResult(
            Succeeded: true,
            Reason: ArchiveRejectionReason.None,
            OffendingMember: null,
            FilesWritten: session.FilesWritten,
            DirectoriesCreated: session.DirectoriesCreated,
            BytesWritten: session.BytesWritten);
    }

    // --- the two readers -------------------------------------------------------

    private static ExtractResult? ExtractZip(Stream archive, Session session, string root)
    {
        using var zip = new ZipArchive(archive, ZipArchiveMode.Read, leaveOpen: true);

        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            string name = entry.FullName;

            // The zip spec says a directory member is one whose name ends in the separator. `Length`
            // is not consulted for anything: it is read straight out of the central directory and is
            // whatever the archive author felt like writing.
            bool isDirectory = name.EndsWith('/');

            ExtractResult? failure = isDirectory
                ? ProcessDirectory(session, root, name)
                // `entry.Open()` hands back a decompressing stream this call owns and must dispose.
                : ProcessFile(session, root, name, entry.Open, ownsData: true);

            if (failure is not null)
            {
                return failure;
            }
        }

        return null;
    }

    private static ExtractResult? ExtractTar(Stream archive, Session session, string root)
    {
        using var reader = new TarReader(archive, leaveOpen: true);

        while (reader.GetNextEntry() is { } entry)
        {
            if (entry.EntryType == TarEntryType.GlobalExtendedAttributes)
            {
                // A pax global header. It has no filesystem effect, and its name is synthesized by the
                // writer (GNU tar and .NET both put a temp path there), so validating that name would
                // reject perfectly ordinary archives. It still costs a slot against the member cap —
                // a million of them is still a million headers to read.
                if (!session.CountMember())
                {
                    return Fail(ArchiveRejectionReason.TooManyMembers, entry.Name);
                }

                continue;
            }

            ExtractResult? failure = entry.EntryType switch
            {
                TarEntryType.Directory => ProcessDirectory(session, root, entry.Name),
                // `entry.DataStream` belongs to the reader — it is a window onto the archive stream
                // that `TarReader` advances and disposes itself, so this call must not dispose it.
                // It is null for a zero-length member.
                TarEntryType.RegularFile or TarEntryType.V7RegularFile =>
                    ProcessFile(session, root, entry.Name, () => entry.DataStream ?? Stream.Null, ownsData: false),
                TarEntryType.SymbolicLink or TarEntryType.HardLink =>
                    CountThen(session, entry.Name, ArchiveRejectionReason.LinkMember),
                _ => CountThen(session, entry.Name, ArchiveRejectionReason.UnsupportedMemberType),
            };

            if (failure is not null)
            {
                return failure;
            }
        }

        return null;
    }

    /// <summary>
    /// Charges a member against the count cap and then refuses it for <paramref name="reason"/> — used
    /// for member types that are rejected on sight, so that a link-stuffed archive still trips the
    /// count cap rather than being read to the end.
    /// </summary>
    private static ExtractResult CountThen(Session session, string name, ArchiveRejectionReason reason)
        => session.CountMember() ? Fail(reason, name) : Fail(ArchiveRejectionReason.TooManyMembers, name);

    // --- the two member shapes -------------------------------------------------

    private static ExtractResult? ProcessDirectory(Session session, string root, string name)
    {
        if (!session.CountMember())
        {
            return Fail(ArchiveRejectionReason.TooManyMembers, name);
        }

        if (!TryValidateName(name, out ArchiveRejectionReason syntax))
        {
            return Fail(syntax, name);
        }

        if (!ContainedPath.TryResolve(root, name, out string resolved, out _))
        {
            return Fail(ArchiveRejectionReason.MemberEscapesRoot, name);
        }

        if (PathComparer.Equals(resolved, root))
        {
            // `tar -cf x.tar .` emits a `./` member. It denotes the destination root, which already
            // exists — a no-op, not an error.
            return null;
        }

        if (session.IsWrittenFile(resolved))
        {
            return Fail(ArchiveRejectionReason.DuplicateMember, name);
        }

        return session.TryEnsureDirectory(resolved) ? null : Fail(ArchiveRejectionReason.DestinationUnusable, name);
    }

    private static ExtractResult? ProcessFile(
        Session session, string root, string name, Func<Stream> openData, bool ownsData)
    {
        if (!session.CountMember())
        {
            return Fail(ArchiveRejectionReason.TooManyMembers, name);
        }

        if (!TryValidateName(name, out ArchiveRejectionReason syntax))
        {
            return Fail(syntax, name);
        }

        if (!ContainedPath.TryResolve(root, name, out string resolved, out _))
        {
            return Fail(ArchiveRejectionReason.MemberEscapesRoot, name);
        }

        if (PathComparer.Equals(resolved, root))
        {
            // A file member whose name reduces to nothing (`.`, `./`) would have to overwrite the
            // destination root itself with a file. It names no member.
            return Fail(ArchiveRejectionReason.MemberNameInvalid, name);
        }

        // Refuse rather than overwrite. Anything already at this path is either an earlier member
        // (a shadowing trick) or content the destination already held — and neither can be restored
        // by the rollback, which would quietly turn "all or nothing" into "all or most".
        if (session.IsWrittenFile(resolved) || File.Exists(resolved) || Directory.Exists(resolved))
        {
            return Fail(ArchiveRejectionReason.DuplicateMember, name);
        }

        string? parent = Path.GetDirectoryName(resolved);
        if (string.IsNullOrEmpty(parent) || !session.TryEnsureDirectory(parent))
        {
            return Fail(ArchiveRejectionReason.DestinationUnusable, name);
        }

        return session.TryWriteFile(resolved, name, openData, ownsData);
    }

    // --- the syntactic pre-filter ---------------------------------------------

    /// <summary>
    /// The cheap, platform-independent half of the check: refuse a member name that is malformed,
    /// anchored, backslash-separated, or carries a <c>..</c> component — before any path is joined
    /// and before the filesystem is touched at all.
    /// </summary>
    /// <remarks>
    /// This deliberately duplicates rules <see cref="ContainedPath"/> also enforces. It is not
    /// redundant: it runs the same way on every OS (the primitive's backslash and drive-letter rules
    /// are Windows-gated, because a backslash is a legal filename character on Unix), it names the
    /// specific shape in the result rather than collapsing everything into "escaped", and it means a
    /// hostile name never reaches a filesystem probe. It is a pre-filter, never a substitute: only
    /// step 2 can see a symlink.
    /// </remarks>
    private static bool TryValidateName(string name, out ArchiveRejectionReason reason)
    {
        reason = ArchiveRejectionReason.None;

        if (string.IsNullOrWhiteSpace(name) || name.Contains('\0', StringComparison.Ordinal))
        {
            reason = ArchiveRejectionReason.MemberNameInvalid;
            return false;
        }

        // `/etc/passwd`, `\Windows\…`, `\\server\share`, and the verbatim `\\?\C:\…`.
        if (name[0] is '/' or '\\')
        {
            reason = ArchiveRejectionReason.MemberNameAnchored;
            return false;
        }

        // `C:\…` and the drive-RELATIVE `C:evil`, which resolves against the process's per-drive
        // current directory and so is anchored despite not looking rooted.
        if (name.Length >= 2 && name[1] == ':' && char.IsAsciiLetter(name[0]))
        {
            reason = ArchiveRejectionReason.MemberNameAnchored;
            return false;
        }

        if (name.Contains('\\', StringComparison.Ordinal))
        {
            reason = ArchiveRejectionReason.MemberNameBackslash;
            return false;
        }

        foreach (string segment in name.Split('/'))
        {
            if (segment == "..")
            {
                reason = ArchiveRejectionReason.MemberNameTraversal;
                return false;
            }
        }

        return true;
    }

    // --- plumbing --------------------------------------------------------------

    private static ExtractResult Fail(ArchiveRejectionReason reason, string? member)
        => new(Succeeded: false, reason, member, FilesWritten: 0, DirectoriesCreated: 0, BytesWritten: 0);

    /// <summary>
    /// The faults an archive's own content can raise, enumerated so that a bug in this file surfaces
    /// as a test failure instead of being reported as "malformed archive".
    /// </summary>
    private static bool IsArchiveFault(Exception ex) => ex is InvalidDataException
        or IOException                   // EndOfStreamException (a truncated tar) lives under this
        or UnauthorizedAccessException
        or NotSupportedException
        or ObjectDisposedException
        or ArgumentException             // a BCL reader rejecting a name before we see it
        or OverflowException
        or FormatException;

    /// <summary>
    /// Everything one <see cref="Extract"/> call created, so that it can all be taken back — plus the
    /// running counters the caps are enforced against.
    /// </summary>
    private sealed class Session(int maxMemberCount, long maxTotalBytes, long maxMemberBytes)
    {
        /// <summary>Directories created by this call, in creation order — unwound in reverse.</summary>
        private readonly List<string> _createdDirectories = [];

        /// <summary>Files created by this call.</summary>
        private readonly List<string> _createdFiles = [];

        /// <summary>Resolved paths already written as regular files, for the duplicate check.</summary>
        private readonly HashSet<string> _writtenFiles = new(PathComparer);

        /// <summary>
        /// The levels this call had to create to reach the destination root, in creation order.
        /// Plural, and that is the point: a caller asking for <c>…/extensions/foo/1.0</c> when only
        /// <c>…/extensions</c> exists gets three new directories, and unwinding only the last of them
        /// leaves two behind that the caller never had.
        /// </summary>
        private readonly List<string> _createdRootLevels = [];

        private int _memberCount;

        internal int FilesWritten { get; private set; }

        /// <summary>
        /// Directories created for the archive's own members. Levels created to reach the destination
        /// root are not the archive's doing and are not counted.
        /// </summary>
        internal int DirectoriesCreated => _createdDirectories.Count;

        internal long BytesWritten { get; private set; }

        internal bool IsWrittenFile(string resolved) => _writtenFiles.Contains(resolved);

        /// <summary>Charges one member against the count cap. False once the cap is exceeded.</summary>
        internal bool CountMember() => ++_memberCount <= maxMemberCount;

        /// <summary>
        /// Makes the destination root usable and hands back its canonical form, recording every
        /// directory level it had to create — because a refused extraction must not leave behind a
        /// directory the caller never had.
        /// </summary>
        internal bool TryPrepareRoot(string destinationRoot, out string canonicalRoot)
        {
            canonicalRoot = string.Empty;

            try
            {
                if (File.Exists(destinationRoot))
                {
                    // An existing FILE at the destination: creating the directory would fail anyway,
                    // and there is no reading of this that ends well.
                    return false;
                }

                if (!TryCreateChain(Path.GetFullPath(destinationRoot), _createdRootLevels))
                {
                    return false;
                }
            }
            catch (Exception ex) when (ex is IOException
                                          or UnauthorizedAccessException
                                          or ArgumentException
                                          or NotSupportedException)
            {
                return false;
            }

            // The yardstick every member is measured against, canonicalized by the primitive itself —
            // an empty candidate denotes the root. On macOS the temp directory sits under a
            // `/var` -> `/private/var` link, so "the root as passed in" and "the root as resolved"
            // genuinely differ, and comparing a resolved member against the un-canonicalized root
            // would reject every legitimate member.
            return ContainedPath.TryResolve(destinationRoot, string.Empty, out canonicalRoot, out _);
        }

        /// <summary>
        /// Creates <paramref name="resolved"/> and any missing ancestors, recording each level this
        /// call actually created so the rollback removes those and only those.
        /// </summary>
        /// <remarks>
        /// <paramref name="resolved"/> came from <see cref="ContainedPath.TryResolve"/>, so it is
        /// already canonical and already proven contained; its ancestors are therefore contained too,
        /// component-wise, and none of them can be a symbolic link (canonicalization resolved them).
        /// </remarks>
        internal bool TryEnsureDirectory(string resolved)
        {
            try
            {
                return TryCreateChain(resolved, _createdDirectories);
            }
            catch (Exception ex) when (ex is IOException
                                          or UnauthorizedAccessException
                                          or ArgumentException
                                          or NotSupportedException)
            {
                return false;
            }
        }

        /// <summary>
        /// Streams one member to disk, counting the bytes as they go and stopping the moment a cap is
        /// passed.
        /// </summary>
        /// <remarks>
        /// The counting is the point. A zip's declared uncompressed length is metadata the archive
        /// author wrote, so a bomb declares a modest one; only bytes measured coming out of the
        /// decompressor can enforce a cap. Nothing is buffered whole in memory either — a 4 GiB member
        /// under a 16 MiB cap costs 16 MiB of writes and a rejection, not 4 GiB of RAM.
        /// </remarks>
        internal ExtractResult? TryWriteFile(string resolved, string name, Func<Stream> openData, bool ownsData)
        {
            FileStream destination;
            try
            {
                // `CreateNew`, not `Create`: the existence check in `ProcessFile` is advisory, and
                // this is the one that actually holds. A file appearing between the two is a lost
                // race, refused rather than overwritten. Opening is kept in its own `try` so that
                // only THIS failure is read as a duplicate — an I/O fault later, while copying, is a
                // different thing and must not be mislabelled as one.
                destination = new FileStream(
                    resolved, FileMode.CreateNew, FileAccess.Write, FileShare.None, CopyBufferSize);
            }
            catch (IOException)
            {
                return Fail(ArchiveRejectionReason.DuplicateMember, name);
            }

            // Recorded the instant the file exists on disk, before a single byte goes in, so a copy
            // that fails halfway still leaves the rollback something to delete.
            _createdFiles.Add(resolved);

            byte[] buffer = ArrayPool<byte>.Shared.Rent(CopyBufferSize);
            Stream? source = null;
            try
            {
                // Inside the `try`: opening a zip member decompresses its first block, so a corrupt
                // entry throws here — and the destination handle must still be closed before the
                // rollback tries to delete the file it points at.
                source = openData();

                long memberBytes = 0;
                int read;
                while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (memberBytes + read > maxMemberBytes)
                    {
                        return Fail(ArchiveRejectionReason.MemberTooLarge, name);
                    }

                    if (BytesWritten + memberBytes + read > maxTotalBytes)
                    {
                        return Fail(ArchiveRejectionReason.ArchiveTooLarge, name);
                    }

                    destination.Write(buffer, 0, read);
                    memberBytes += read;
                }

                BytesWritten += memberBytes;
                _writtenFiles.Add(resolved);
                FilesWritten++;
                return null;
            }
            finally
            {
                if (ownsData)
                {
                    source?.Dispose();
                }

                destination.Dispose();
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        /// <summary>
        /// Takes back everything this call created — files first, then member directories in reverse
        /// creation order, then every level it had to create to reach the destination root, likewise
        /// in reverse.
        /// </summary>
        /// <remarks>
        /// Every delete is non-recursive and targets a path this call recorded creating, so the
        /// unwind cannot descend through a symbolic link into somebody else's tree — the failure mode
        /// of a `rm -rf $DEST` cleanup. Nothing that existed before the call is touched, which is why
        /// <see cref="TryWriteFile"/> refuses to overwrite: a clobbered file could not be given back.
        /// Best-effort by design — a directory the OS will not release is not worth converting a
        /// clean rejection into an exception, and the security-relevant part (the files) is done
        /// first.
        /// </remarks>
        internal void Rollback()
        {
            for (int i = _createdFiles.Count - 1; i >= 0; i--)
            {
                TryDelete(() => File.Delete(_createdFiles[i]));
            }

            for (int i = _createdDirectories.Count - 1; i >= 0; i--)
            {
                TryDelete(() => Directory.Delete(_createdDirectories[i], recursive: false));
            }

            for (int i = _createdRootLevels.Count - 1; i >= 0; i--)
            {
                TryDelete(() => Directory.Delete(_createdRootLevels[i], recursive: false));
            }

            _createdFiles.Clear();
            _createdDirectories.Clear();
            _createdRootLevels.Clear();
            _writtenFiles.Clear();
            FilesWritten = 0;
            BytesWritten = 0;
        }

        /// <summary>
        /// Creates <paramref name="path"/> and every missing level above it, appending each level it
        /// actually created to <paramref name="record"/>.
        /// </summary>
        /// <remarks>
        /// One level at a time, deliberately. <see cref="Directory.CreateDirectory(string)"/> would
        /// make the whole chain in a single call but would not say which levels were already there —
        /// and a rollback that has to guess is a rollback that deletes something the caller owned.
        /// </remarks>
        private static bool TryCreateChain(string path, List<string> record)
        {
            if (Directory.Exists(path))
            {
                return true;
            }

            var missing = new List<string>();
            string current = path;
            while (!Directory.Exists(current))
            {
                missing.Add(current);
                string? parent = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(parent) || PathComparer.Equals(parent, current))
                {
                    return false;
                }

                current = parent;
            }

            for (int i = missing.Count - 1; i >= 0; i--)
            {
                Directory.CreateDirectory(missing[i]);
                record.Add(missing[i]);
            }

            return true;
        }

        private static void TryDelete(Action delete)
        {
            try
            {
                delete();
            }
            catch (Exception ex) when (ex is IOException
                                          or UnauthorizedAccessException
                                          or ArgumentException
                                          or NotSupportedException)
            {
            }
        }
    }
}
