using Koine.Cli.Infrastructure;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1903: the polyglot analogue of #1841/<see cref="DemoReferenceGuardTests"/>. The
/// TypeScript/Python/PHP/Rust demos (#1073) each commit a browsable <c>reference/</c> snapshot of the
/// emitter's real output for reviewers, but nothing compared it against a fresh regeneration — so
/// <c>demo/typescript/reference/OrderLine.ts.txt</c> silently drifted from #1888/#1894's
/// <c>Decimal</c> reconciliation fix. Each fact here regenerates <c>templates/starters/ordering</c>
/// in-process for one target and asserts every committed <c>reference/*.txt</c> file is identical
/// (after line-ending normalization) to the emitter's live output — with that demo's README
/// regeneration command in the failure message, exactly mirroring <see cref="DemoReferenceGuardTests"/>.
/// </summary>
public class PolyglotDemoReferenceGuardTests
{
    private static string OrderingTemplateDir() =>
        TestSupport.RepoPath(Path.Combine("templates", "starters", "ordering"));

    /// <summary>Compiles the ordering starter for <paramref name="emitter"/>'s target, exactly as
    /// `koine build templates/starters/ordering --target &lt;target&gt;` does.</summary>
    private static CompileResult CompileOrdering(IEmitter emitter)
    {
        var sources = SourceLoader.ReadSources(OrderingTemplateDir());
        return new KoineCompiler().Compile(sources, emitter);
    }

    /// <summary>Mirrors <c>OutputWriter</c>'s own CRLF/CR-to-LF normalization (and
    /// <see cref="DemoReferenceGuardTests"/>'s identical helper), so a Windows checkout (autocrlf)
    /// comparing against an in-memory LF string never produces a spurious diff.</summary>
    private static string NormalizeLineEndings(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n');

    private static void AssertMatchesCommitted(
        CompileResult result, string emittedRelativePath, string demoDir, string committedFileName, string regenerateCommand)
    {
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        errors.ShouldBeEmpty(string.Join("\n", errors.Select(d => d.ToString())));

        var file = result.Files.SingleOrDefault(f => f.RelativePath.Replace('\\', '/') == emittedRelativePath);
        file.ShouldNotBeNull($"expected templates/starters/ordering to emit a file at '{emittedRelativePath}'");

        string committedPath = TestSupport.RepoPath(Path.Combine("demo", demoDir, "reference", committedFileName));
        string committed = File.ReadAllText(committedPath);

        NormalizeLineEndings(file!.Contents).ShouldBe(NormalizeLineEndings(committed),
            $"demo/{demoDir}/reference/{committedFileName} has drifted from the emitter's actual output. " +
            $"Regenerate it and commit the result:\n  {regenerateCommand}");
    }

    [Fact]
    public void TypeScript_reference_matches_committed_snapshot()
    {
        var result = CompileOrdering(new TypeScriptEmitter());
        const string cmd = "dotnet run --project src/Koine.Cli -- build templates/starters/ordering " +
            "--target typescript --out /tmp/ordering-ts";

        AssertMatchesCommitted(result, "Ordering/Order.ts", "typescript", "Order.ts.txt", cmd);
        AssertMatchesCommitted(result, "Ordering/value-objects/OrderLine.ts", "typescript", "OrderLine.ts.txt", cmd);
    }

    [Fact]
    public void Python_reference_matches_committed_snapshot()
    {
        var result = CompileOrdering(new PythonEmitter());
        const string cmd = "dotnet run --project src/Koine.Cli -- build templates/starters/ordering " +
            "--target python --out /tmp/ordering-py";

        AssertMatchesCommitted(result, "ordering/order.py", "python", "order.py.txt", cmd);
        AssertMatchesCommitted(result, "ordering/value_objects/order_line.py", "python", "order_line.py.txt", cmd);
    }

    [Fact]
    public void Php_reference_matches_committed_snapshot()
    {
        var result = CompileOrdering(new PhpEmitter());
        const string cmd = "dotnet run --project src/Koine.Cli -- build templates/starters/ordering " +
            "--target php --out /tmp/ordering-php";

        AssertMatchesCommitted(result, "src/Ordering/Entities/Order.php", "php", "Order.php.txt", cmd);
        AssertMatchesCommitted(result, "src/Ordering/ValueObjects/OrderLine.php", "php", "OrderLine.php.txt", cmd);
    }

    [Fact]
    public void Rust_reference_matches_committed_snapshot()
    {
        var result = CompileOrdering(new RustEmitter());
        const string cmd = "dotnet run --project src/Koine.Cli -- build templates/starters/ordering " +
            "--target rust --out /tmp/ordering-rs";

        AssertMatchesCommitted(result, "src/ordering.rs", "rust", "ordering.rs.txt", cmd);
    }
}
