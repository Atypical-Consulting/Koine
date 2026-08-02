using Koine.Cli.Infrastructure;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1841: <c>demo/reference/</c> (see its own README) is a committed, browsable snapshot of
/// what the Koine CLI actually emits — but nothing compared the committed files against the
/// emitter's real output, so a ~700-commit drift (casing/whitespace in the glossary, the whole
/// <c>publish</c>/integration-events shape in <c>Order.cs.txt</c>) went unnoticed. Each fact here
/// regenerates one artifact in-process, from the same source its README regeneration command
/// names, and asserts it is identical (after line-ending normalization, so a checkout with
/// different autocrlf settings never spuriously fails) to the committed file — with that exact
/// command in the failure message, so a red run says precisely what to re-run.
/// </summary>
public class DemoReferenceGuardTests
{
    private static string PizzeriaDir() => TestSupport.RepoPath(Path.Combine("templates", "pizzeria"));

    /// <summary>Compiles the whole <c>templates/pizzeria</c> template in directory mode, exactly as
    /// <c>koine build templates/pizzeria</c> does (and as <see cref="TemplatesValidationTests"/>
    /// already proves compiles clean) — the single validated source of truth (issue #101).</summary>
    private static CompileResult CompilePizzeria()
    {
        var sources = Directory
            .EnumerateFiles(PizzeriaDir(), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();
        return new KoineCompiler().Compile(sources, new CSharpEmitter());
    }

    /// <summary>Mirrors <c>OutputWriter</c>'s own CRLF/CR-to-LF normalization, so a Windows checkout
    /// (autocrlf) comparing against an in-memory LF string never produces a spurious diff.</summary>
    private static string NormalizeLineEndings(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n');

    private static void AssertMatchesCommitted(string actual, string relativePath, string regenerateCommand)
    {
        string committedPath = TestSupport.RepoPath(Path.Combine("demo", "reference", relativePath));
        string committed = File.ReadAllText(committedPath);

        NormalizeLineEndings(actual).ShouldBe(NormalizeLineEndings(committed),
            $"demo/reference/{relativePath} has drifted from the emitter's actual output. " +
            $"Regenerate it and commit the result:\n  {regenerateCommand}");
    }

    [Fact]
    public void Glossary_matches_committed_reference()
    {
        var result = CompilePizzeria();
        result.Model.ShouldNotBeNull();
        string glossary = new GlossaryEmitter().Emit(result.Model!)[0].Contents;

        AssertMatchesCommitted(glossary, "pizzeria.glossary.md",
            "dotnet run --project src/Koine.Cli -- build templates/pizzeria " +
            "--glossary demo/reference/pizzeria.glossary.md");
    }

    /// <summary>
    /// The three emitted-C# snapshots (issue #1841's siblings). The <c>.cs.txt</c> suffix on the
    /// committed side is deliberate (see <c>demo/reference/README.md</c>) — it keeps the demo
    /// project from compiling them as duplicate copies of the live <c>Generated/</c> output — so the
    /// comparison reads the committed <c>.txt</c> against the emitter's real <c>.cs</c> path.
    /// </summary>
    [Theory]
    [InlineData("Ordering/Order.cs", "emitted-cs/Order.cs.txt")]
    [InlineData("Delivery/ValueObjects/Address.cs", "emitted-cs/Address.cs.txt")]
    [InlineData("Payment/Abstractions/IGatewayToPaymentTranslator.cs", "emitted-cs/IGatewayToPaymentTranslator.cs.txt")]
    public void Emitted_csharp_matches_committed_reference(string emittedRelativePath, string committedRelativePath)
    {
        var result = CompilePizzeria();
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        errors.ShouldBeEmpty(string.Join("\n", errors.Select(d => d.ToString())));

        var file = result.Files.SingleOrDefault(f => f.RelativePath.Replace('\\', '/') == emittedRelativePath);
        file.ShouldNotBeNull($"expected templates/pizzeria to emit a file at '{emittedRelativePath}'");

        AssertMatchesCommitted(file!.Contents, committedRelativePath,
            "dotnet run --project src/Koine.Cli -- build templates/pizzeria " +
            "--target csharp --out demo/Pizzeria.Domain/Generated");
    }

    /// <summary>
    /// <c>koine-check.txt</c> is a hand-assembled terminal transcript (command line + interleaved
    /// stdout/stderr + an <c>(exit code: N)</c> footer) of a real <c>koine check</c> run, per
    /// <c>demo/reference/README.md</c>. There is no single emitter call that produces that transcript
    /// text, so this mirrors <see cref="Koine.Cli.Commands.CheckCommand"/>'s own line formatting
    /// (breaking/non-breaking lines, the summary line, the exit code) over the SAME
    /// <see cref="CompatibilityChecker"/> report the real command prints — never re-deriving the
    /// compatibility rules themselves, only the three lines of text formatting around them. Skips
    /// <c>CheckCommand</c>'s <c>koine.config</c>-driven severity overrides: neither
    /// <c>examples/versioning</c> nor the repo root carries one today, so there is nothing to apply.
    /// </summary>
    [Fact]
    public void Koine_check_transcript_matches_committed_reference()
    {
        var baseline = ParseDirectoryOrFail(Path.Combine("examples", "versioning", "v1"));
        var current = ParseDirectoryOrFail(Path.Combine("examples", "versioning", "v2"));

        var report = new CompatibilityChecker().Check(baseline, current);

        var lines = new List<string>
        {
            "$ koine check examples/versioning/v2 --baseline examples/versioning/v1",
        };
        lines.AddRange(report.Changes.Select(change => change.Impact == CompatibilityImpact.Breaking
            ? $"breaking {change.Code}: {change.Message}"
            : $"non-breaking: {change.Message}"));

        int breakingCount = report.Changes.Count(c => c.Impact == CompatibilityImpact.Breaking);
        lines.Add(breakingCount > 0
            ? $"error: {breakingCount} breaking change(s) to published surfaces"
            : "OK: no breaking changes to published surfaces");
        lines.Add($"(exit code: {(breakingCount > 0 ? 1 : 0)})");

        string transcript = string.Join('\n', lines) + "\n";

        AssertMatchesCommitted(transcript, "koine-check.txt",
            "dotnet run --project src/Koine.Cli -- check examples/versioning/v2 --baseline examples/versioning/v1");
    }

    private static KoineModel ParseDirectoryOrFail(string relativeDir)
    {
        var sources = SourceLoader.ReadSources(TestSupport.RepoPath(relativeDir));
        var (model, diagnostics) = new KoineCompiler().Parse(sources);
        model.ShouldNotBeNull(string.Join("\n", diagnostics.Select(d => d.ToString())));
        return model!;
    }
}
