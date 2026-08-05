using System.Text.Json;
using Koine.Compiler.Extensions;

namespace Koine.Compiler.Tests;

/// <summary>
/// The .NET half of the cross-language path-containment gate (issue #1942).
/// <para>
/// Most of this class is a harness rather than assertions: the accept/reject table itself lives in
/// <c>tests/fixtures/path-containment/cases.json</c> at the repository root, and the Rust host's
/// <c>paths::tests::the_shared_corpus_agrees_with_this_implementation</c> drives the very same file.
/// Two hand-written implementations of one security rule drift silently; two hand-written test
/// suites that merely look alike drift silently too. One corpus read by both does not — a
/// divergence in either implementation reddens a build. The corpus format is documented next to the
/// data, in that folder's <c>README.md</c>.
/// </para>
/// <para>
/// The conditions the per-candidate corpus schema cannot express — a root that does not exist, an
/// absolute candidate that happens to point inside the root, a symlink to an absolute path — are
/// covered by the facts at the bottom of this file (and by the Rust module's own tests).
/// </para>
/// </summary>
public class ContainedPathTests
{
    private static readonly Lazy<CorpusFile> Corpus = new(LoadCorpus);

    private static int _sandboxCounter;

    /// <summary>The platform token this OS answers to in a case's <c>platforms</c> list.</summary>
    private static string Platform => OperatingSystem.IsWindows() ? "windows" : "unix";

    /// <summary>
    /// Component-wise path comparison rule, matching what the primitive itself uses: Windows
    /// filesystems are case-insensitive, everyone else's are not.
    /// </summary>
    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>
    /// Locates the shared corpus by walking up from the test assembly's location to the repo root
    /// (the directory holding <c>Koine.slnx</c>) — the same mechanism
    /// <see cref="TemplatesValidationTests"/> uses to find <c>templates/</c>, rather than a second
    /// invented one, so neither a hardcoded absolute path nor a CWD assumption creeps in.
    /// </summary>
    private static string CorpusPath()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "tests", "fixtures", "path-containment", "cases.json");
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
            // Loud on absence. A corpus harness that silently passes when the fixture is missing is
            // a gate that proves nothing — and this one exists specifically to prove something.
            throw new FileNotFoundException($"the shared path-containment corpus is missing: {path}", path);
        }

        CorpusFile corpus = JsonSerializer.Deserialize<CorpusFile>(
            File.ReadAllText(path),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException($"{path} deserialized to null");

        return corpus;
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
    public void The_shared_corpus_is_present_and_declares_the_expected_schema_version()
    {
        CorpusFile corpus = Corpus.Value;

        corpus.Version.ShouldBe(1, "unknown corpus schema version — update this harness before bumping it");
        corpus.Cases.ShouldNotBeEmpty($"the shared corpus has zero cases: {CorpusPath()}");
        corpus.Cases.Select(c => c.Name).Distinct(StringComparer.Ordinal).Count()
            .ShouldBe(corpus.Cases.Count, "corpus case names must be unique — they identify failures");
    }

    [Fact]
    public void The_shared_corpus_gates_this_platform()
    {
        ApplicableCases().ShouldNotBeEmpty(
            $"no corpus case lists the `{Platform}` platform — the corpus cannot gate this OS");
    }

    [Theory]
    [MemberData(nameof(ApplicableCases))]
    public void Corpus_case(string name)
    {
        CorpusCase c = Corpus.Value.Cases.Single(x => x.Name == name);

        string sandbox = CreateSandbox();
        List<(string Path, UnixFileMode Previous, UnixFileMode Applied)> restricted = [];
        try
        {
            // The root is deliberately named `root` inside the sandbox, so a case can plant a
            // `../rootevil` sibling whose name is a STRING prefix of the root's — the exact shape a
            // string StartsWith would wave through.
            string root = Path.Combine(sandbox, "root");
            Directory.CreateDirectory(root);
            Materialize(root, c, restricted);

            if (restricted.Count > 0 && !ModesAreEnforced(restricted))
            {
                // Running as root, or on a filesystem that ignores Unix modes: the row would "pass"
                // without ever producing the denial it exists to pin, which proves nothing.
                return;
            }

            bool ok = ContainedPath.TryResolve(root, CandidateOf(c), out string resolved, out PathEscapeReason reason);

            switch (c.Expect)
            {
                case "accept":
                    ok.ShouldBeTrue($"[{c.Name}] expected accept, got {reason}");
                    reason.ShouldBe(PathEscapeReason.None, $"[{c.Name}]");
                    // Each harness derives the canonical root from its OWN primitive (an empty
                    // candidate denotes the root), which is what lets `resolvesTo` stay
                    // machine-independent across two languages and three OSes.
                    string expected = JoinRelative(CanonicalRoot(root), c.ResolvesTo ?? string.Empty);
                    string.Equals(resolved, expected, PathComparison)
                        .ShouldBeTrue($"[{c.Name}] resolved to {resolved}, expected {expected}");
                    break;

                case "reject":
                    ok.ShouldBeFalse($"[{c.Name}] expected reject, got {resolved}");
                    reason.ShouldBe(ExpectedReason(c), $"[{c.Name}]");
                    resolved.ShouldBeEmpty($"[{c.Name}] a refused candidate must not hand back a path");
                    break;

                default:
                    throw new InvalidDataException($"[{c.Name}] unknown expect {c.Expect}");
            }
        }
        finally
        {
            // Modes come off BEFORE the cleanup: a directory left at `000` defeats a recursive delete.
            RestoreModes(restricted);
            Cleanup(sandbox);
        }
    }

    // --- what the per-candidate corpus schema cannot express ------------------

    [Fact]
    public void A_nonexistent_root_is_refused_rather_than_assumed()
    {
        // Documented behaviour: containment is proven against the CANONICAL root, so a root that
        // cannot be canonicalized fails closed rather than guessing.
        string sandbox = CreateSandbox();
        try
        {
            bool ok = ContainedPath.TryResolve(
                Path.Combine(sandbox, "not-created"), "a.txt", out string resolved, out PathEscapeReason reason);

            ok.ShouldBeFalse();
            reason.ShouldBe(PathEscapeReason.SymlinkEscape);
            resolved.ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox);
        }
    }

    [Fact]
    public void An_empty_root_is_refused_rather_than_resolved_against_the_working_directory()
    {
        ContainedPath.TryResolve(string.Empty, "a.txt", out string resolved, out PathEscapeReason reason)
            .ShouldBeFalse();

        reason.ShouldBe(PathEscapeReason.SymlinkEscape);
        resolved.ShouldBeEmpty();
    }

    [Fact]
    public void An_absolute_candidate_inside_the_root_is_still_refused()
    {
        // Containment is not the only rule: the contract is "a RELATIVE path under the root", so an
        // absolute path is refused even when it happens to point inside. A caller that accepted it
        // would be accepting an anchored path from a third party.
        string sandbox = CreateSandbox();
        try
        {
            string root = Path.Combine(sandbox, "root");
            Directory.CreateDirectory(root);
            string inside = Path.Combine(root, "a.json");
            File.WriteAllText(inside, "{}");

            ContainedPath.TryResolve(root, inside, out string resolved, out PathEscapeReason reason).ShouldBeFalse();

            reason.ShouldBe(PathEscapeReason.Absolute);
            resolved.ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox);
        }
    }

    [Fact]
    public void A_symlink_to_an_absolute_path_outside_the_root_is_refused()
    {
        // The corpus keeps its symlink targets relative so no case depends on a machine-specific
        // directory existing; this covers the spec's `/etc` row directly.
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string sandbox = CreateSandbox();
        try
        {
            string root = Path.Combine(sandbox, "root");
            Directory.CreateDirectory(root);
            Directory.CreateSymbolicLink(Path.Combine(root, "link"), "/etc");

            ContainedPath.TryResolve(root, "link/passwd", out string resolved, out PathEscapeReason reason)
                .ShouldBeFalse();

            reason.ShouldBe(PathEscapeReason.SymlinkEscape);
            resolved.ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox);
        }
    }

    [Fact]
    public void A_symlink_chain_is_followed_up_to_the_hop_budget_and_refused_past_it()
    {
        // The one place the two implementations cannot be held to a shared corpus row: Rust lets the
        // OS resolve a chain (macOS refuses past 32 links, Linux past 40, Windows past 63 reparse
        // points) while this half hand-rolls the descent with a fixed budget. The budget is set to
        // the SMALLEST of those numbers precisely so this half can never accept a chain Rust would
        // refuse — a false reject in the band above it is the price, and it is the safe direction.
        // See this class's file header and the corpus README.
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string sandbox = CreateSandbox();
        try
        {
            string root = Path.Combine(sandbox, "root");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "target.txt"), "koine");

            // A short chain resolves, all the way to the file it names.
            Chain(root, "short", 8);
            ContainedPath.TryResolve(root, "short0", out string resolved, out PathEscapeReason reason)
                .ShouldBeTrue($"an 8-link chain is well inside the budget, got {reason}");
            resolved.ShouldBe(Path.Combine(CanonicalRoot(root), "target.txt"));

            // 33 links is past every platform's own ceiling as well as this budget, so both halves
            // refuse it and no divergence is being pinned here — only the fail-closed behaviour.
            Chain(root, "long", 33);
            ContainedPath.TryResolve(root, "long0", out string overBudget, out PathEscapeReason overReason)
                .ShouldBeFalse();
            overReason.ShouldBe(PathEscapeReason.SymlinkEscape);
            overBudget.ShouldBeEmpty();
        }
        finally
        {
            Cleanup(sandbox);
        }
    }

    /// <summary>
    /// Plants <paramref name="length"/> links named <c>&lt;prefix&gt;0 … &lt;prefix&gt;N-1</c> under
    /// the root, each pointing at the next and the last at <c>target.txt</c>.
    /// </summary>
    private static void Chain(string root, string prefix, int length)
    {
        for (int i = 0; i < length; i++)
        {
            string next = i == length - 1 ? "target.txt" : $"{prefix}{i + 1}";
            File.CreateSymbolicLink(Path.Combine(root, $"{prefix}{i}"), next);
        }
    }

    [Fact]
    public void A_resolved_path_is_reported_under_the_canonicalized_root()
    {
        // On macOS the temp directory itself sits under a /var -> /private/var symlink, so "the root
        // as passed in" and "the root as reported" genuinely differ — and every accept case's
        // expected value depends on the primitive resolving that for itself.
        string sandbox = CreateSandbox();
        try
        {
            string root = Path.Combine(sandbox, "root");
            Directory.CreateDirectory(root);

            ContainedPath.TryResolve(root, "themes/dark.json", out string resolved, out PathEscapeReason reason)
                .ShouldBeTrue();

            reason.ShouldBe(PathEscapeReason.None);
            string canonicalRoot = CanonicalRoot(root);
            resolved.ShouldBe(Path.Combine(canonicalRoot, "themes", "dark.json"));
            Path.IsPathFullyQualified(resolved).ShouldBeTrue();
        }
        finally
        {
            Cleanup(sandbox);
        }
    }

    // --- harness --------------------------------------------------------------

    /// <summary>
    /// The untrusted path a case hands to the primitive. <c>candidateRepeat</c> repeats
    /// <c>candidate</c> that many times, which is the only way to state a size limit without
    /// inlining kilobytes of filler into the fixture.
    /// </summary>
    private static string CandidateOf(CorpusCase c) => c.CandidateRepeat is { } times
        ? string.Concat(Enumerable.Repeat(c.Candidate, times))
        : c.Candidate;

    private static string CanonicalRoot(string root)
    {
        ContainedPath.TryResolve(root, string.Empty, out string canonical, out PathEscapeReason reason)
            .ShouldBeTrue($"the root itself must resolve, got {reason}");
        return canonical;
    }

    private static PathEscapeReason ExpectedReason(CorpusCase c) => c.Reason switch
    {
        "traversal" => PathEscapeReason.Traversal,
        "absolute" => PathEscapeReason.Absolute,
        "symlink-escape" => PathEscapeReason.SymlinkEscape,
        "malformed" => PathEscapeReason.Malformed,
        null => throw new InvalidDataException($"[{c.Name}] a reject case needs a reason"),
        _ => throw new InvalidDataException($"[{c.Name}] unknown reason {c.Reason}"),
    };

    /// <summary>
    /// Materializes a case's fixture. Any <c>mode</c> a setup entry declares is applied in a SECOND
    /// pass, after every entry exists — a case that makes a directory unreadable still has to be able
    /// to plant the symlink inside it first — and each one is recorded in
    /// <paramref name="restricted"/> so the caller can put it back before deleting the sandbox.
    /// </summary>
    private static void Materialize(
        string root,
        CorpusCase c,
        List<(string Path, UnixFileMode Previous, UnixFileMode Applied)> restricted)
    {
        foreach (SetupEntry entry in c.Setup ?? [])
        {
            string full = JoinRelative(root, entry.Path);
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

                    File.CreateSymbolicLink(
                        full,
                        entry.Target ?? throw new InvalidDataException($"[{c.Name}] a symlink entry needs a target"));
                    break;
                default:
                    throw new InvalidDataException($"[{c.Name}] unknown setup kind {entry.Kind}");
            }
        }

        foreach (SetupEntry entry in c.Setup ?? [])
        {
            if (entry.Mode is null)
            {
                continue;
            }

            if (OperatingSystem.IsWindows())
            {
                throw new InvalidDataException(
                    $"[{c.Name}] a case with a `mode` field must list only the `unix` platform");
            }

            string full = JoinRelative(root, entry.Path);
            var applied = (UnixFileMode)Convert.ToInt32(entry.Mode, 8);
            restricted.Add((full, File.GetUnixFileMode(full), applied));
            File.SetUnixFileMode(full, applied);
        }
    }

    /// <summary>
    /// True when the modes a case applied actually deny THIS process. A suite running as root — or on
    /// a filesystem that ignores Unix modes — would otherwise "pass" a fail-closed row without ever
    /// producing the denial the row exists to pin, which is worse than skipping it. A mode that still
    /// grants read is not making an access claim, so it is taken at face value.
    /// </summary>
    private static bool ModesAreEnforced(
        IReadOnlyList<(string Path, UnixFileMode Previous, UnixFileMode Applied)> restricted)
    {
        foreach ((string path, _, UnixFileMode applied) in restricted)
        {
            if ((applied & UnixFileMode.UserRead) != 0)
            {
                continue;
            }

            try
            {
                if (Directory.Exists(path))
                {
                    Directory.GetFileSystemEntries(path);
                }
                else
                {
                    using FileStream _ = File.OpenRead(path);
                }

                return false;
            }
            catch (UnauthorizedAccessException)
            {
            }
            catch (IOException)
            {
            }
        }

        return true;
    }

    private static void RestoreModes(
        IReadOnlyList<(string Path, UnixFileMode Previous, UnixFileMode Applied)> restricted)
    {
        if (OperatingSystem.IsWindows())
        {
            // Unreachable — `Materialize` refuses a `mode` entry there — but it is what tells the
            // platform-compatibility analyzer that the Unix-only call below cannot run on Windows.
            return;
        }

        foreach ((string path, UnixFileMode previous, _) in restricted)
        {
            try
            {
                File.SetUnixFileMode(path, previous);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

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

    private static string CreateSandbox()
    {
        int n = Interlocked.Increment(ref _sandboxCounter);
        string dir = Path.Combine(Path.GetTempPath(), $"koine_containment_{Environment.ProcessId}_{n}");
        if (Directory.Exists(dir))
        {
            Cleanup(dir);
        }

        Directory.CreateDirectory(dir);
        return dir;
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

    // --- the corpus, as read ---------------------------------------------------

    private sealed record CorpusFile(int Version, IReadOnlyList<CorpusCase> Cases);

    private sealed record CorpusCase(
        string Name,
        IReadOnlyList<SetupEntry>? Setup,
        string Candidate,
        int? CandidateRepeat,
        string Expect,
        string? ResolvesTo,
        string? Reason,
        IReadOnlyList<string> Platforms);

    private sealed record SetupEntry(string Kind, string Path, string? Target, string? Mode);
}
