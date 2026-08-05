using System.Formats.Tar;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Koine.Compiler.Extensions;

namespace Koine.Compiler.Tests;

/// <summary>
/// The gate on <see cref="SafeArchiveExtractor"/> (issue #1942).
/// <para>
/// Most of this class is a harness. The corpus itself — every hostile archive shape, in a form you can
/// read in a diff — lives at <c>tests/fixtures/malicious-archives/cases.json</c>, next to the
/// path-containment corpus that gates the primitive underneath. That folder's <c>README.md</c>
/// documents the schema, the sandbox layout and why no <c>.zip</c> or <c>.tar</c> file is committed.
/// </para>
/// <para>
/// Two properties are asserted for every hostile case, and the second is the one that matters: the
/// call fails, <b>and</b> the sandbox is byte-for-byte what it was before — nothing written outside
/// the destination root, nothing left inside it. A gate that merely returns <c>false</c> while a file
/// sits in <c>/etc</c> has not gated anything. And every escape target is inside a sandbox this test
/// owns and deletes, never a shared path like <c>/tmp/evil.txt</c> where a stale file from an earlier
/// run would make the assertion lie.
/// </para>
/// </summary>
public class SafeArchiveExtractorTests
{
    private static readonly Lazy<CorpusFile> Corpus = new(LoadCorpus);

    private static int _sandboxCounter;

    /// <summary>The platform token this OS answers to in a case's <c>platforms</c> list.</summary>
    private static string Platform => OperatingSystem.IsWindows() ? "windows" : "unix";

    // --- the corpus ------------------------------------------------------------

    /// <summary>
    /// Locates the corpus by walking up from the test assembly to the repo root (the directory holding
    /// <c>Koine.slnx</c>) — the same mechanism <see cref="ContainedPathTests"/> and
    /// <see cref="TemplatesValidationTests"/> use, rather than a third invented one.
    /// </summary>
    private static string CorpusPath()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "tests", "fixtures", "malicious-archives", "cases.json");
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) walking up from {AppContext.BaseDirectory}");
    }

    private static CorpusFile LoadCorpus()
    {
        string path = CorpusPath();
        if (!File.Exists(path))
        {
            // Loud on absence: a harness that silently passes when its fixtures are missing is a gate
            // that proves nothing.
            throw new FileNotFoundException($"the malicious-archive corpus is missing: {path}", path);
        }

        return JsonSerializer.Deserialize<CorpusFile>(
            File.ReadAllText(path),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException($"{path} deserialized to null");
    }

    /// <summary>Every corpus case whose <c>platforms</c> list includes the running OS, by name.</summary>
    public static IEnumerable<object[]> ApplicableCases()
    {
        foreach (CorpusCase c in Corpus.Value.Cases)
        {
            if (c.Platforms.Contains(Platform, StringComparer.Ordinal))
            {
                yield return [c.Name];
            }
        }
    }

    [Fact]
    public void The_corpus_is_present_and_declares_the_expected_schema_version()
    {
        CorpusFile corpus = Corpus.Value;

        corpus.Version.ShouldBe(1, "unknown corpus schema version — update this harness before bumping it");
        corpus.Cases.ShouldNotBeEmpty($"the malicious-archive corpus has zero cases: {CorpusPath()}");
        corpus.Cases.Select(c => c.Name).Distinct(StringComparer.Ordinal).Count()
            .ShouldBe(corpus.Cases.Count, "corpus case names must be unique — they identify failures");
        corpus.Cases.Count(c => c.Expect == "accept")
            .ShouldBeGreaterThanOrEqualTo(2, "a gate that only ever rejects proves nothing — keep the benign rows");
    }

    [Fact]
    public void The_corpus_gates_this_platform()
    {
        ApplicableCases().ShouldNotBeEmpty(
            $"no corpus case lists the `{Platform}` platform — the corpus cannot gate this OS");
    }

    /// <summary>
    /// The corpus is only worth anything if the archives really carry the names it declares. If
    /// <see cref="ZipArchive"/> or <see cref="TarWriter"/> ever started sanitizing names on write,
    /// every hostile row would quietly become a benign archive that passes for the wrong reason — so
    /// this reads each built archive back and compares.
    /// </summary>
    [Theory]
    [MemberData(nameof(ApplicableCases))]
    public void Case_archive_carries_its_declared_member_names_verbatim(string name)
    {
        CorpusCase c = Case(name);
        if (c.Members.Any(m => m.Type is "meta" or "corrupt-header"))
        {
            // A raw header block is written by hand precisely because no container writer will
            // produce it, so there is no "did the writer rewrite my name" question to answer — and
            // reading one back is the very failure the case exists to pin.
            return;
        }

        Sandbox sandbox = CreateSandbox();
        try
        {
            using MemoryStream archive = BuildArchive(c, sandbox);
            IReadOnlyList<string> actual = ReadBackMemberNames(c, archive);

            actual.ShouldBe(
                c.Members.Select(m => m.Name).ToList(),
                $"[{c.Name}] the container rewrote the member names — the corpus no longer tests what it claims to");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Theory]
    [MemberData(nameof(ApplicableCases))]
    public void Corpus_case(string name)
    {
        CorpusCase c = Case(name);
        Sandbox sandbox = CreateSandbox();
        try
        {
            Materialize(sandbox, c);
            IReadOnlyList<string> before = Snapshot(sandbox.Root);

            using MemoryStream archive = BuildArchive(c, sandbox);
            ExtractResult result = Run(c, archive, sandbox);

            switch (c.Expect)
            {
                case "reject":
                    AssertRejected(c, sandbox, result, before);
                    break;
                case "accept":
                    AssertAccepted(c, sandbox, result);
                    break;
                default:
                    throw new InvalidDataException($"[{c.Name}] unknown expect {c.Expect}");
            }
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    private static void AssertRejected(
        CorpusCase c, Sandbox sandbox, ExtractResult result, IReadOnlyList<string> before)
    {
        result.Succeeded.ShouldBeFalse($"[{c.Name}] expected a refusal — {c.Why}");
        result.Reason.ShouldBe(ExpectedReason(c), $"[{c.Name}]");
        result.OffendingMember.ShouldBe(c.OffendingMember, $"[{c.Name}]");

        // A refusal reports no work, because a refusal did no work.
        result.FilesWritten.ShouldBe(0, $"[{c.Name}]");
        result.DirectoriesCreated.ShouldBe(0, $"[{c.Name}]");
        result.BytesWritten.ShouldBe(0, $"[{c.Name}]");

        foreach (string declared in c.MustNotExist ?? [])
        {
            string target = ResolveEscapeTarget(declared, sandbox);
            File.Exists(target).ShouldBeFalse($"[{c.Name}] the escape landed: {target}");
            Directory.Exists(target).ShouldBeFalse($"[{c.Name}] the escape landed: {target}");
        }

        // Nothing written outside the destination root, and no partial output left inside it — one
        // assertion, because "the sandbox is exactly as we found it" says both at once.
        Snapshot(sandbox.Root).ShouldBe(
            before, $"[{c.Name}] the sandbox changed — the extraction was not unwound");

        if (c.Setup is null or { Count: 0 })
        {
            Directory.EnumerateFileSystemEntries(sandbox.Destination)
                .ShouldBeEmpty($"[{c.Name}] the destination root is not empty");
        }
    }

    private static void AssertAccepted(CorpusCase c, Sandbox sandbox, ExtractResult result)
    {
        result.Succeeded.ShouldBeTrue($"[{c.Name}] refused with {result.Reason} at `{result.OffendingMember}`");
        result.Reason.ShouldBe(ArchiveRejectionReason.None, $"[{c.Name}]");
        result.OffendingMember.ShouldBeNull($"[{c.Name}]");
        result.FilesWritten.ShouldBe(c.FilesWritten ?? -1, $"[{c.Name}]");
        result.DirectoriesCreated.ShouldBe(c.DirectoriesCreated ?? -1, $"[{c.Name}]");
        result.BytesWritten.ShouldBe(c.BytesWritten ?? -1, $"[{c.Name}]");

        foreach (ExpectedFile expected in c.ExpectedFiles ?? [])
        {
            string full = JoinRelative(sandbox.Destination, expected.Path);
            File.Exists(full).ShouldBeTrue($"[{c.Name}] missing {expected.Path}");
            File.ReadAllText(full).ShouldBe(expected.Text, $"[{c.Name}] {expected.Path} came out altered");
        }

        foreach (string dir in c.ExpectedDirs ?? [])
        {
            Directory.Exists(JoinRelative(sandbox.Destination, dir))
                .ShouldBeTrue($"[{c.Name}] missing directory {dir}");
        }

        // Complete AND exact: no extra member smuggled in, nothing dropped.
        ActualFiles(sandbox.Destination).ShouldBe(
            (c.ExpectedFiles ?? []).Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToList(),
            $"[{c.Name}] the extracted file set does not match the declared one");

        Snapshot(sandbox.Outside).ShouldBeEmpty($"[{c.Name}] something landed outside the destination root");
    }

    // --- what the per-archive corpus schema cannot express ---------------------

    [Fact]
    public void Malformed_zip_bytes_are_a_failed_result_rather_than_an_exception()
    {
        // The call sites this is aimed at are a Tauri host and a CLI sidecar: an escaping
        // InvalidDataException there is an unhandled crash, and a caller forced to wrap extraction in
        // a try/catch will eventually catch too much.
        Sandbox sandbox = CreateSandbox();
        try
        {
            using var garbage = new MemoryStream([0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFF, 0xFF, 0xFF]);

            ExtractResult result = SafeArchiveExtractor.Extract(garbage, ArchiveKind.Zip, sandbox.Destination);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(ArchiveRejectionReason.MalformedArchive);
            Directory.EnumerateFileSystemEntries(sandbox.Destination).ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_truncated_tar_is_a_failed_result_rather_than_an_exception()
    {
        Sandbox sandbox = CreateSandbox();
        try
        {
            // A real tar, cut off mid-member: the header promises bytes the archive does not carry.
            using var whole = new MemoryStream();
            using (var writer = new TarWriter(whole, TarEntryFormat.Pax, leaveOpen: true))
            {
                var entry = new PaxTarEntry(TarEntryType.RegularFile, "a.txt")
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes(new string('x', 4096))),
                };
                writer.WriteEntry(entry);
            }

            using var truncated = new MemoryStream(whole.ToArray()[..1024]);

            ExtractResult result = SafeArchiveExtractor.Extract(truncated, ArchiveKind.Tar, sandbox.Destination);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(ArchiveRejectionReason.MalformedArchive);

            // The important half: the partially-written member was taken back.
            Directory.EnumerateFileSystemEntries(sandbox.Destination)
                .ShouldBeEmpty("a truncated archive must not leave a half-written member behind");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_gnu_long_name_header_that_lies_about_its_size_is_refused_and_unwound()
    {
        // The shape a corpus row cannot express, because it needs a REAL `TarWriter`-produced GNU
        // archive patched after the fact. `TarReader` reads a metadata header ('L'/'K'/'x'/'g') eagerly
        // and throws `InvalidOperationException` — a type nothing else in the BCL's tar path raises —
        // when the declared size is larger than it will read. Before the fix that exception escaped
        // `Extract` entirely, which meant BOTH halves of the contract broke at once: the caller got a
        // crash instead of a typed refusal, and the members already on disk stayed there because the
        // rollback sits on the non-throwing path.
        Sandbox sandbox = CreateSandbox();
        try
        {
            using var tar = new MemoryStream(GnuTarWithALongNameHeaderThatLiesAboutItsSize());

            ExtractResult result = SafeArchiveExtractor.Extract(tar, ArchiveKind.Tar, sandbox.Destination);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(ArchiveRejectionReason.MalformedArchive);
            Directory.EnumerateFileSystemEntries(sandbox.Destination).ShouldBeEmpty(
                "the member written before the malformed header must be taken back");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void An_unexpected_fault_still_unwinds_before_it_propagates()
    {
        // The rollback must not depend on WHICH arm of `Extract` runs. A fault this class does not
        // recognise is a bug rather than a hostile archive, so it is deliberately NOT swallowed — but
        // letting it escape over a half-written destination is how a crash becomes a half-installed
        // extension. A source stream that fails with a type this class does not enumerate stands in for
        // the general case (the concrete instance found in review was `TarReader`'s
        // `InvalidOperationException`, now recognised, so it can no longer play this part).
        Sandbox sandbox = CreateSandbox();
        try
        {
            // A ustar member is one 512-byte header plus its data padded to 512, so the SECOND
            // member's header starts at 1024 — read only after `good.txt` is already on disk.
            using var whole = new MemoryStream();
            using (var writer = new TarWriter(whole, TarEntryFormat.Ustar, leaveOpen: true))
            {
                writer.WriteEntry(new UstarTarEntry(TarEntryType.RegularFile, "good.txt")
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes("good")),
                });
                writer.WriteEntry(new UstarTarEntry(TarEntryType.RegularFile, "boom.txt")
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes("boom")),
                });
            }

            whole.Position = 0;
            using var faulting = new FaultingStream(whole, faultFrom: 1024);

            Should.Throw<BadImageFormatException>(
                () => SafeArchiveExtractor.Extract(faulting, ArchiveKind.Tar, sandbox.Destination));

            Directory.EnumerateFileSystemEntries(sandbox.Destination).ShouldBeEmpty(
                "an escaping fault must still leave the destination as it found it");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_member_the_filesystem_will_not_open_is_not_reported_as_a_duplicate()
    {
        // Every failure to OPEN the destination file used to come back as `DuplicateMember`, which for
        // anything other than a collision is a straightforwardly false statement — and a rejection
        // reason a caller cannot trust is worse than a vague one: `DuplicateMember` invites "retry
        // into a clean directory", which will fail identically forever.
        //
        // A destination the process may not write to is the shape that reaches the open reliably on
        // every Unix: the member name is impeccable, containment is proven, the parent directory
        // exists — and `CreateNew` fails with EACCES.
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        Sandbox sandbox = CreateSandbox();
        try
        {
            string readOnly = Path.Combine(sandbox.Destination, "locked");
            Directory.CreateDirectory(readOnly);
            File.SetUnixFileMode(
                readOnly,
                UnixFileMode.UserRead | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);

            if (CanStillWriteInto(readOnly))
            {
                // Running as root, where the mode is advisory. Nothing to prove here.
                return;
            }

            using MemoryStream archive = Zip(("a.txt", "x"));
            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, readOnly);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(
                ArchiveRejectionReason.DestinationUnusable,
                "a destination the process cannot write to is not a collision with an existing member");
            result.OffendingMember.ShouldBe("a.txt");
        }
        finally
        {
            string readOnly = Path.Combine(sandbox.Destination, "locked");
            if (Directory.Exists(readOnly))
            {
                File.SetUnixFileMode(readOnly, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_member_name_the_filesystem_cannot_store_is_refused_by_containment()
    {
        // The other half of the same review finding, and the more interesting one: a 300-character
        // member name does NOT reach the file open at all any more. `ContainedPath` now fails closed
        // on a probe it cannot answer, and a name past the volume's per-component limit makes the
        // ancestor walk's `stat` fail with ENAMETOOLONG — "I could not look", not "nothing is here".
        // So it is refused as an escape rather than mislabelled as a duplicate. Pinned so that a
        // future loosening of the probe silently routes this back into the open's catch.
        Sandbox sandbox = CreateSandbox();
        try
        {
            using MemoryStream archive = Zip((new string('a', 300), "x"));

            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, sandbox.Destination);

            result.Succeeded.ShouldBeFalse();

            // The finding, and the part that holds everywhere: whatever refuses it, it is not a
            // collision.
            result.Reason.ShouldNotBe(
                ArchiveRejectionReason.DuplicateMember,
                "a name the filesystem cannot store is not a collision with an existing member");

            if (!OperatingSystem.IsWindows())
            {
                // WHICH stage refuses it is a per-platform detail of where the volume's name limit
                // bites, so it is pinned only where it was measured. On Unix the probe's ENAMETOOLONG
                // is what fails closed; a Windows run that reached the file open instead would report
                // DestinationUnusable, which the assertion above already allows.
                result.Reason.ShouldBe(ArchiveRejectionReason.MemberEscapesRoot);
            }

            Directory.EnumerateFileSystemEntries(sandbox.Destination).ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    /// <summary>Whether the running process can still create a file in <paramref name="directory"/>
    /// despite its mode — true when the tests run as root, where the mode is advisory.</summary>
    private static bool CanStillWriteInto(string directory)
    {
        string probe = Path.Combine(directory, "koine-write-probe");
        try
        {
            File.WriteAllText(probe, "x");
            File.Delete(probe);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    [Fact]
    public void A_container_cap_is_not_charged_against_a_stream_with_no_length()
    {
        // The cap is charged from `Stream.Length`, which a forward-only stream does not have. That is
        // a documented residual, not a silent one: a caller handing this a network stream was told to
        // bound the bytes itself, and refusing every non-seekable stream would break the case the
        // extractor exists for. (The seekable half is pinned by the `zip-container-size-cap` corpus
        // row.)
        Sandbox sandbox = CreateSandbox();
        try
        {
            using var backing = new MemoryStream();
            using (var writer = new TarWriter(backing, TarEntryFormat.Ustar, leaveOpen: true))
            {
                writer.WriteEntry(new UstarTarEntry(TarEntryType.RegularFile, "a.txt")
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes("aaaaaaaaaaaaaaaaaaaa")),
                });
            }

            backing.Position = 0;
            using var forwardOnly = new ForwardOnlyStream(backing);

            // Far under the cap in bytes, and the cap is 1 — so a cap charged here would refuse it.
            ExtractResult result = SafeArchiveExtractor.Extract(
                forwardOnly, ArchiveKind.Tar, sandbox.Destination, maxArchiveBytes: 1);

            result.Succeeded.ShouldBeTrue(
                $"a stream with no length cannot be measured and is not refused for lacking one "
                + $"(got {result.Reason})");
            File.ReadAllText(Path.Combine(sandbox.Destination, "a.txt")).ShouldBe("aaaaaaaaaaaaaaaaaaaa");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_destination_root_that_did_not_exist_is_created_on_success()
    {
        Sandbox sandbox = CreateSandbox();
        try
        {
            string fresh = Path.Combine(sandbox.Destination, "made", "up");

            using MemoryStream archive = Zip(("a.txt", "a"));
            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, fresh);

            result.Succeeded.ShouldBeTrue($"refused with {result.Reason}");
            File.ReadAllText(Path.Combine(fresh, "a.txt")).ShouldBe("a");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_destination_root_the_call_created_is_removed_again_on_abort()
    {
        // Never a half-installed extension — and never a directory the caller did not have before.
        Sandbox sandbox = CreateSandbox();
        try
        {
            string fresh = Path.Combine(sandbox.Destination, "made", "up");

            using MemoryStream archive = Zip(("good.txt", "good"), ("../../evil.txt", "pwned"));
            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, fresh);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(ArchiveRejectionReason.MemberNameTraversal);
            Directory.Exists(fresh).ShouldBeFalse("the destination root this call created must be removed again");
            Directory.EnumerateFileSystemEntries(sandbox.Destination).ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_destination_root_that_already_holds_content_keeps_it_when_the_archive_is_refused()
    {
        Sandbox sandbox = CreateSandbox();
        try
        {
            string keeper = Path.Combine(sandbox.Destination, "keeper.txt");
            File.WriteAllText(keeper, "mine");

            using MemoryStream archive = Zip(("fresh.txt", "fresh"), ("/etc/passwd", "pwned"));
            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, sandbox.Destination);

            result.Succeeded.ShouldBeFalse();
            File.ReadAllText(keeper).ShouldBe("mine", "the rollback deleted something the caller owned");
            File.Exists(Path.Combine(sandbox.Destination, "fresh.txt")).ShouldBeFalse();
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_member_that_would_overwrite_pre_existing_content_is_refused_and_the_content_survives()
    {
        // The rollback can delete what this call created; it cannot un-overwrite what it clobbered.
        // So clobbering is refused, which is what makes "all or nothing" true rather than aspirational.
        Sandbox sandbox = CreateSandbox();
        try
        {
            string existing = Path.Combine(sandbox.Destination, "config.json");
            File.WriteAllText(existing, "mine");

            using MemoryStream archive = Zip(("config.json", "theirs"));
            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, sandbox.Destination);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(ArchiveRejectionReason.DuplicateMember);
            result.OffendingMember.ShouldBe("config.json");
            File.ReadAllText(existing).ShouldBe("mine");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void An_empty_destination_root_is_refused_rather_than_resolved_against_the_working_directory()
    {
        using MemoryStream archive = Zip(("a.txt", "a"));

        ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, string.Empty);

        result.Succeeded.ShouldBeFalse();
        result.Reason.ShouldBe(ArchiveRejectionReason.DestinationUnusable);
        result.OffendingMember.ShouldBeNull();
    }

    [Fact]
    public void A_destination_root_that_is_an_existing_file_is_refused()
    {
        Sandbox sandbox = CreateSandbox();
        try
        {
            string file = Path.Combine(sandbox.Destination, "not-a-directory");
            File.WriteAllText(file, "x");

            using MemoryStream archive = Zip(("a.txt", "a"));
            ExtractResult result = SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, file);

            result.Succeeded.ShouldBeFalse();
            result.Reason.ShouldBe(ArchiveRejectionReason.DestinationUnusable);
            File.ReadAllText(file).ShouldBe("x");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    [Fact]
    public void A_null_archive_stream_is_a_caller_bug_rather_than_a_result()
    {
        // The no-throw promise covers what an ARCHIVE can do. A null stream is not an archive.
        Should.Throw<ArgumentNullException>(
            () => SafeArchiveExtractor.Extract(null!, ArchiveKind.Zip, Path.GetTempPath()));
    }

    [Fact]
    public void A_non_positive_cap_is_a_caller_bug_rather_than_a_silent_reject_everything()
    {
        using MemoryStream archive = Zip(("a.txt", "a"));

        Should.Throw<ArgumentOutOfRangeException>(
            () => SafeArchiveExtractor.Extract(archive, ArchiveKind.Zip, Path.GetTempPath(), maxMemberCount: 0));
    }

    [Fact]
    public void A_tar_member_carrying_a_setuid_bit_is_extracted_without_it()
    {
        // Nothing about permissions or ownership survives the extraction. A tar can carry a setuid
        // bit, and an extractor that reproduced one would be handing the archive's author a
        // privilege-escalation primitive for free.
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        Sandbox sandbox = CreateSandbox();
        try
        {
            using var tar = new MemoryStream();
            using (var writer = new TarWriter(tar, TarEntryFormat.Pax, leaveOpen: true))
            {
                var entry = new PaxTarEntry(TarEntryType.RegularFile, "tool")
                {
                    DataStream = new MemoryStream(Encoding.UTF8.GetBytes("#!/bin/sh\n")),
                    Mode = UnixFileMode.SetUser | UnixFileMode.SetGroup
                        | UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                        | UnixFileMode.GroupRead | UnixFileMode.GroupExecute
                        | UnixFileMode.OtherRead | UnixFileMode.OtherExecute,
                };
                writer.WriteEntry(entry);
            }

            tar.Position = 0;
            ExtractResult result = SafeArchiveExtractor.Extract(tar, ArchiveKind.Tar, sandbox.Destination);

            result.Succeeded.ShouldBeTrue($"refused with {result.Reason}");

            UnixFileMode mode = File.GetUnixFileMode(Path.Combine(sandbox.Destination, "tool"));
            mode.HasFlag(UnixFileMode.SetUser).ShouldBeFalse("the setuid bit was carried over from the archive");
            mode.HasFlag(UnixFileMode.SetGroup).ShouldBeFalse("the setgid bit was carried over from the archive");
            mode.HasFlag(UnixFileMode.UserExecute).ShouldBeFalse("an execute bit was carried over from the archive");
            mode.HasFlag(UnixFileMode.GroupExecute).ShouldBeFalse("an execute bit was carried over from the archive");
            mode.HasFlag(UnixFileMode.OtherExecute).ShouldBeFalse("an execute bit was carried over from the archive");
        }
        finally
        {
            Cleanup(sandbox.Root);
        }
    }

    // --- harness: the sandbox --------------------------------------------------

    /// <summary>
    /// One test's private world. <see cref="Destination"/> is nested four levels below
    /// <see cref="Root"/> so that every <c>..</c> chain in the corpus lands inside a directory this
    /// test created and will delete — never in a shared location where a leftover from an earlier run
    /// could make "the escape target does not exist" pass or fail for the wrong reason.
    /// </summary>
    private sealed record Sandbox(string Root, string Destination, string Outside);

    private static Sandbox CreateSandbox()
    {
        int n = Interlocked.Increment(ref _sandboxCounter);
        string root = Path.Combine(Path.GetTempPath(), $"koine_archives_{Environment.ProcessId}_{n}");
        if (Directory.Exists(root))
        {
            Cleanup(root);
        }

        string outside = Path.Combine(root, "outside");
        string destination = Path.Combine(root, "n1", "n2", "n3", "dest");
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(destination);
        return new Sandbox(root, destination, outside);
    }

    private static void Cleanup(string dir)
    {
        try
        {
            // .NET's recursive delete unlinks a symlinked directory rather than descending into it,
            // so a fixture that plants a link never deletes the link's target.
            Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
            // A leftover temp directory is not worth failing a green test over.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// Every entry under <paramref name="root"/>, sorted, with a file's length included so a modified
    /// file shows up as a difference. Symbolic links are listed but not descended into — following one
    /// would make the snapshot depend on wherever it points.
    /// </summary>
    private static IReadOnlyList<string> Snapshot(string root)
    {
        var entries = new List<string>();
        Walk(root, root, entries);
        entries.Sort(StringComparer.Ordinal);
        return entries;
    }

    private static void Walk(string root, string directory, List<string> into)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            string relative = Path.GetRelativePath(root, entry).Replace(Path.DirectorySeparatorChar, '/');

            if (new FileInfo(entry).LinkTarget is not null)
            {
                into.Add($"link {relative}");
                continue;
            }

            if (Directory.Exists(entry))
            {
                into.Add($"dir  {relative}");
                Walk(root, entry, into);
                continue;
            }

            into.Add($"file {relative} {new FileInfo(entry).Length}");
        }
    }

    private static IReadOnlyList<string> ActualFiles(string root)
        => Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(p => Path.GetRelativePath(root, p).Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();

    // --- harness: building an archive from a case ------------------------------

    private static CorpusCase Case(string name) => Corpus.Value.Cases.Single(x => x.Name == name);

    private static MemoryStream BuildArchive(CorpusCase c, Sandbox sandbox)
    {
        var buffer = new MemoryStream();
        switch (c.Kind)
        {
            case "zip":
                BuildZip(buffer, c);
                break;
            case "tar":
                BuildTar(buffer, c, sandbox);
                break;
            default:
                throw new InvalidDataException($"[{c.Name}] unknown archive kind {c.Kind}");
        }

        buffer.Position = 0;
        return buffer;
    }

    private static void BuildZip(Stream target, CorpusCase c)
    {
        using var zip = new ZipArchive(target, ZipArchiveMode.Create, leaveOpen: true);
        foreach (CorpusMember member in c.Members)
        {
            switch (member.Type)
            {
                case "dir":
                    // A zip directory member is a zero-length entry whose name ends in the separator.
                    zip.CreateEntry(member.Name);
                    break;
                case "file":
                    using (Stream data = zip.CreateEntry(member.Name, CompressionLevel.Optimal).Open())
                    {
                        WriteContent(data, member);
                    }

                    break;
                case "symlink":
                    {
                        // Zip has no member-type field. A Unix-authored archive puts the member's
                        // `st_mode` in the HIGH sixteen bits of the external attributes and writes the
                        // link target as the member's BODY — the convention `zip -y` writes and
                        // `unzip` reads. 0xA1FF is S_IFLNK | 0777.
                        ZipArchiveEntry entry = zip.CreateEntry(member.Name, CompressionLevel.Optimal);
                        entry.ExternalAttributes = unchecked((int)0xA1FF0000);
                        using Stream data = entry.Open();
                        data.Write(Encoding.UTF8.GetBytes(
                            member.LinkTarget
                            ?? throw new InvalidDataException($"[{c.Name}] a link member needs a linkTarget")));
                        break;
                    }

                default:
                    throw new InvalidDataException($"[{c.Name}] a zip cannot carry a `{member.Type}` member");
            }
        }
    }

    private static void BuildTar(Stream target, CorpusCase c, Sandbox sandbox)
    {
        // `TarWriter` writes each entry straight through to the stream, so a hand-built raw block can
        // be interleaved between `WriteEntry` calls — which is what the `meta` and `corrupt-header`
        // members need, since no writer will produce them. They must land BEFORE the writer is
        // disposed, or the two zero blocks it appends would end the archive ahead of them.
        using var writer = new TarWriter(target, TarEntryFormat.Pax, leaveOpen: true);
        foreach (CorpusMember member in c.Members)
        {
            switch (member.Type)
            {
                case "meta":
                    {
                        char flag = (member.MetaType ?? string.Empty).Length == 1
                            ? member.MetaType![0]
                            : throw new InvalidDataException(
                                $"[{c.Name}] a `meta` member needs a single-character metaType ('L', 'K', 'x' or 'g')");
                        target.Write(RawTarHeaderBlock(
                            member.Name,
                            flag,
                            member.DeclaredSize ?? throw new InvalidDataException(
                                $"[{c.Name}] a `meta` member needs a declaredSize"),
                            zeroChecksum: false));
                        break;
                    }

                case "corrupt-header":
                    target.Write(RawTarHeaderBlock(member.Name, '0', declaredSize: 0, zeroChecksum: true));
                    break;

                case "dir":
                    writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, member.Name));
                    break;
                case "file":
                    {
                        var data = new MemoryStream();
                        WriteContent(data, member);
                        data.Position = 0;
                        writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, member.Name) { DataStream = data });
                        break;
                    }

                case "symlink":
                    writer.WriteEntry(new PaxTarEntry(TarEntryType.SymbolicLink, member.Name)
                    {
                        LinkName = Expand(member.LinkTarget, sandbox, c),
                    });
                    break;
                case "hardlink":
                    writer.WriteEntry(new PaxTarEntry(TarEntryType.HardLink, member.Name)
                    {
                        LinkName = Expand(member.LinkTarget, sandbox, c),
                    });
                    break;
                case "fifo":
                    writer.WriteEntry(new PaxTarEntry(TarEntryType.Fifo, member.Name));
                    break;
                default:
                    throw new InvalidDataException($"[{c.Name}] unknown member type {member.Type}");
            }
        }
    }

    private static void WriteContent(Stream destination, CorpusMember member)
    {
        if (member.Zeros is { } count)
        {
            // Streamed in chunks rather than allocated whole: `zip-bomb-member` declares 32 MiB, and
            // a corpus that needed 32 MiB of RAM to describe a bomb would be its own small joke.
            byte[] chunk = new byte[64 * 1024];
            long remaining = count;
            while (remaining > 0)
            {
                int take = (int)Math.Min(chunk.Length, remaining);
                destination.Write(chunk, 0, take);
                remaining -= take;
            }

            return;
        }

        if (!string.IsNullOrEmpty(member.Text))
        {
            destination.Write(Encoding.UTF8.GetBytes(member.Text));
        }
    }

    private static IReadOnlyList<string> ReadBackMemberNames(CorpusCase c, MemoryStream archive)
    {
        archive.Position = 0;
        var names = new List<string>();

        if (c.Kind == "zip")
        {
            using var zip = new ZipArchive(archive, ZipArchiveMode.Read, leaveOpen: true);
            names.AddRange(zip.Entries.Select(e => e.FullName));
        }
        else
        {
            using var reader = new TarReader(archive, leaveOpen: true);
            while (reader.GetNextEntry() is { } entry)
            {
                if (entry.EntryType != TarEntryType.GlobalExtendedAttributes)
                {
                    names.Add(entry.Name);
                }
            }
        }

        archive.Position = 0;
        return names;
    }

    // --- harness: setup, invocation, expectations ------------------------------

    private static void Materialize(Sandbox sandbox, CorpusCase c)
    {
        foreach (SetupEntry entry in c.Setup ?? [])
        {
            string full = JoinRelative(sandbox.Destination, entry.Path);
            string parent = Path.GetDirectoryName(full)
                ?? throw new InvalidDataException($"[{c.Name}] setup path has no parent: {entry.Path}");
            Directory.CreateDirectory(parent);

            switch (entry.Kind)
            {
                case "dir":
                    Directory.CreateDirectory(full);
                    break;
                case "file":
                    File.WriteAllText(full, "koine");
                    break;
                case "symlink":
                    if (OperatingSystem.IsWindows())
                    {
                        throw new InvalidDataException(
                            $"[{c.Name}] a case with a symlink setup entry must list only the `unix` platform");
                    }

                    Directory.CreateSymbolicLink(
                        full,
                        entry.Target ?? throw new InvalidDataException($"[{c.Name}] a symlink entry needs a target"));
                    break;
                default:
                    throw new InvalidDataException($"[{c.Name}] unknown setup kind {entry.Kind}");
            }
        }
    }

    private static ExtractResult Run(CorpusCase c, Stream archive, Sandbox sandbox)
    {
        ArchiveKind kind = c.Kind switch
        {
            "zip" => ArchiveKind.Zip,
            "tar" => ArchiveKind.Tar,
            _ => throw new InvalidDataException($"[{c.Name}] unknown archive kind {c.Kind}"),
        };

        CaseLimits limits = c.Limits ?? new CaseLimits(null, null, null, null);
        return SafeArchiveExtractor.Extract(
            archive,
            kind,
            sandbox.Destination,
            limits.MaxMemberCount ?? SafeArchiveExtractor.DefaultMaxMemberCount,
            limits.MaxTotalBytes ?? SafeArchiveExtractor.DefaultMaxTotalBytes,
            limits.MaxMemberBytes ?? SafeArchiveExtractor.DefaultMaxMemberBytes,
            limits.MaxArchiveBytes ?? SafeArchiveExtractor.DefaultMaxArchiveBytes);
    }

    private static ArchiveRejectionReason ExpectedReason(CorpusCase c) => c.Reason switch
    {
        "malformed-archive" => ArchiveRejectionReason.MalformedArchive,
        "member-name-invalid" => ArchiveRejectionReason.MemberNameInvalid,
        "member-name-anchored" => ArchiveRejectionReason.MemberNameAnchored,
        "member-name-backslash" => ArchiveRejectionReason.MemberNameBackslash,
        "member-name-traversal" => ArchiveRejectionReason.MemberNameTraversal,
        "member-escapes-root" => ArchiveRejectionReason.MemberEscapesRoot,
        "link-member" => ArchiveRejectionReason.LinkMember,
        "unsupported-member-type" => ArchiveRejectionReason.UnsupportedMemberType,
        "duplicate-member" => ArchiveRejectionReason.DuplicateMember,
        "too-many-members" => ArchiveRejectionReason.TooManyMembers,
        "member-too-large" => ArchiveRejectionReason.MemberTooLarge,
        "archive-too-large" => ArchiveRejectionReason.ArchiveTooLarge,
        "destination-unusable" => ArchiveRejectionReason.DestinationUnusable,
        null => throw new InvalidDataException($"[{c.Name}] a reject case needs a reason"),
        _ => throw new InvalidDataException($"[{c.Name}] unknown reason {c.Reason}"),
    };

    /// <summary>
    /// A declared escape target: <c>{sandbox}/…</c> is resolved against the sandbox, anything else
    /// <em>lexically</em> against the destination root — so <c>../../evil.txt</c> names the place the
    /// traversal was aiming at, computed the naive way an unguarded extractor would have computed it.
    /// </summary>
    private static string ResolveEscapeTarget(string declared, Sandbox sandbox)
    {
        const string token = "{sandbox}/";
        return declared.StartsWith(token, StringComparison.Ordinal)
            ? JoinRelative(sandbox.Root, declared[token.Length..])
            : Path.GetFullPath(JoinRelative(sandbox.Destination, declared));
    }

    private static string Expand(string? value, Sandbox sandbox, CorpusCase c)
        => (value ?? throw new InvalidDataException($"[{c.Name}] a link member needs a linkTarget"))
            .Replace("{sandbox}", sandbox.Root, StringComparison.Ordinal);

    /// <summary>
    /// Joins a corpus-declared <c>/</c>-separated relative path onto a base, component by component,
    /// so the corpus never has to know which separator the running OS uses.
    /// </summary>
    private static string JoinRelative(string basePath, string relative)
    {
        string result = basePath;
        foreach (string segment in relative.Split('/'))
        {
            if (segment.Length > 0)
            {
                result = Path.Join(result, segment);
            }
        }

        return result;
    }

    // --- harness: raw tar blocks the container writers will not produce ---------

    /// <summary>
    /// A real <see cref="TarWriter"/>-produced GNU archive whose <c>@LongLink</c> metadata header has
    /// been patched to declare a size larger than the data behind it.
    /// </summary>
    /// <remarks>
    /// Written by .NET's own writer and then patched by twelve bytes, rather than hand-rolled, so the
    /// case cannot pass because a hand-built header was subtly wrong in some other way. The first
    /// member lands on disk before the bad header is reached — which is what makes this a rollback
    /// test and not merely an exception-type test.
    /// </remarks>
    private static byte[] GnuTarWithALongNameHeaderThatLiesAboutItsSize()
    {
        using var buffer = new MemoryStream();
        using (var writer = new TarWriter(buffer, TarEntryFormat.Gnu, leaveOpen: true))
        {
            writer.WriteEntry(new GnuTarEntry(TarEntryType.RegularFile, "installed.txt")
            {
                DataStream = new MemoryStream(Encoding.UTF8.GetBytes("PAYLOAD")),
            });

            // A name past the header's 100-byte name field forces GNU's `@LongLink` ('L') block.
            writer.WriteEntry(new GnuTarEntry(TarEntryType.RegularFile, new string('n', 250) + ".txt"));
        }

        byte[] bytes = buffer.ToArray();

        for (int block = 0; block + TarBlockSize <= bytes.Length; block += TarBlockSize)
        {
            if (bytes[block + TarTypeFlagOffset] != (byte)'L')
            {
                continue;
            }

            // 0o17777777777 == 0x7FFFFFFF, one past `Array.MaxLength` — so `TarReader` refuses it at
            // the size check rather than trying to allocate two gigabytes to read it.
            Encoding.ASCII.GetBytes("17777777777\0").CopyTo(bytes, block + TarSizeOffset);
            return bytes;
        }

        throw new InvalidOperationException(
            "TarWriter no longer emits a GNU '@LongLink' block for a >100-character member name — "
            + "this fixture can no longer build the archive it is named after");
    }

    private const int TarBlockSize = 512;
    private const int TarSizeOffset = 124;
    private const int TarChecksumOffset = 148;
    private const int TarTypeFlagOffset = 156;
    private const int TarMagicOffset = 257;

    /// <summary>
    /// One raw 512-byte tar header block — the shapes <see cref="TarWriter"/> will not write for you:
    /// a metadata header ('L', 'K', 'x', 'g') declaring a size the archive does not carry, and a
    /// header whose checksum field is zeroed.
    /// </summary>
    /// <remarks>
    /// Fields are at their POSIX offsets: name 0, mode 100, uid 108, gid 116, size 124, mtime 136,
    /// checksum 148, type flag 156, magic 257. The checksum is the sum of every byte with the checksum
    /// field itself read as eight spaces — <see cref="TarReader"/> does not verify it, but a checksum
    /// of ZERO is how the format spells "end of archive", so writing one deliberately is the whole
    /// point of <paramref name="zeroChecksum"/>.
    /// </remarks>
    private static byte[] RawTarHeaderBlock(string name, char typeFlag, long declaredSize, bool zeroChecksum)
    {
        byte[] block = new byte[TarBlockSize];

        void Field(int offset, string value) => Encoding.ASCII.GetBytes(value).CopyTo(block, offset);

        Field(0, name);
        Field(100, "0000644\0");
        Field(108, "0000000\0");
        Field(116, "0000000\0");
        Field(TarSizeOffset, Convert.ToString(declaredSize, 8).PadLeft(11, '0') + "\0");
        Field(136, "00000000000\0");
        block[TarTypeFlagOffset] = (byte)typeFlag;

        // GNU's own magic for its two metadata blocks ('L'/'K'), POSIX's for the pax pair ('x'/'g').
        Field(TarMagicOffset, typeFlag is 'L' or 'K' ? "ustar  \0" : "ustar\0" + "00");

        if (zeroChecksum)
        {
            Field(TarChecksumOffset, "\0\0\0\0\0\0\0\0");
            return block;
        }

        Field(TarChecksumOffset, "        ");
        int checksum = block.Sum(b => b);
        Field(TarChecksumOffset, Convert.ToString(checksum, 8).PadLeft(6, '0') + "\0 ");
        return block;
    }

    /// <summary>A read-only stream that admits to no length — a network download's shape.</summary>
    private sealed class ForwardOnlyStream(Stream inner) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() => inner.Flush();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
    }

    /// <summary>A source stream that fails, past <paramref name="faultFrom"/>, in a way nothing in
    /// <c>IsArchiveFault</c> covers — so the failure is an escaping bug rather than a refusal.</summary>
    private sealed class FaultingStream(Stream inner, long faultFrom) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => inner.CanSeek;

        public override bool CanWrite => false;

        public override long Length => inner.Length;

        public override long Position
        {
            get => inner.Position;
            set => inner.Position = value;
        }

        public override void Flush() => inner.Flush();

        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (inner.Position >= faultFrom)
            {
                throw new BadImageFormatException("a fault SafeArchiveExtractor does not enumerate");
            }

            return inner.Read(buffer, offset, count);
        }
    }

    /// <summary>A minimal zip built in memory, for the facts that do not need a whole corpus row.</summary>
    private static MemoryStream Zip(params (string Name, string Text)[] members)
    {
        var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string name, string text) in members)
            {
                using Stream data = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
                data.Write(Encoding.UTF8.GetBytes(text));
            }
        }

        buffer.Position = 0;
        return buffer;
    }

    // --- the corpus, as read ---------------------------------------------------

    private sealed record CorpusFile(int Version, IReadOnlyList<CorpusCase> Cases);

    private sealed record CorpusCase(
        string Name,
        string Kind,
        string Why,
        IReadOnlyList<SetupEntry>? Setup,
        CaseLimits? Limits,
        IReadOnlyList<CorpusMember> Members,
        string Expect,
        string? Reason,
        string? OffendingMember,
        IReadOnlyList<string>? MustNotExist,
        int? FilesWritten,
        int? DirectoriesCreated,
        long? BytesWritten,
        IReadOnlyList<ExpectedFile>? ExpectedFiles,
        IReadOnlyList<string>? ExpectedDirs,
        IReadOnlyList<string> Platforms);

    private sealed record CaseLimits(int? MaxMemberCount, long? MaxTotalBytes, long? MaxMemberBytes, long? MaxArchiveBytes);

    private sealed record CorpusMember(
        string Type, string Name, string? Text, long? Zeros, string? LinkTarget, string? MetaType, long? DeclaredSize);

    private sealed record ExpectedFile(string Path, string Text);

    private sealed record SetupEntry(string Kind, string Path, string? Target);
}
