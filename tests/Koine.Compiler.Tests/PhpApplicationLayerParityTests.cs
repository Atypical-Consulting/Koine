using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// End-to-end parity guard (issue #242): compiling a full multi-context domain (the <c>pizzeria</c>
/// template — six contexts plus an external gateway) to <c>--target php</c> must now emit the whole
/// application / CQRS layer — read models, query handler seams, application services / use cases /
/// domain operations, specifications, policy reactor seams, anti-corruption-layer translators, and
/// integration-event subscriber seams — reaching the breadth the Python and TypeScript backends already
/// ship. Before this issue the PHP loop dropped every one of these constructs, so each assertion below
/// is a genuinely new guarantee, not a restatement of the per-construct unit tests.
/// </summary>
public class PhpApplicationLayerParityTests
{
    /// <summary>Walks up from the test assembly to the repo root (the directory holding
    /// <c>Koine.slnx</c>), then returns the <c>templates/pizzeria</c> folder — never a CWD assumption.</summary>
    private static string PizzeriaTemplate()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "templates", "pizzeria");
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) from {AppContext.BaseDirectory}");
    }

    private static IReadOnlyList<EmittedFile> EmitPizzeriaPhp()
    {
        var sources = Directory
            .EnumerateFiles(PizzeriaTemplate(), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();
        sources.ShouldNotBeEmpty("the pizzeria template has no .koi files to compile");

        var result = new KoineCompiler().Compile(sources, new PhpEmitter());
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        errors.ShouldBeEmpty(
            "pizzeria did not compile cleanly to PHP:\n" +
            string.Join("\n", errors.Select(d => $"{d.File}:{d.Line}:{d.Column}: {d.Code}: {d.Message}")));
        return result.Files;
    }

    [Fact]
    public void Pizzeria_php_emits_the_full_application_layer()
    {
        var files = EmitPizzeriaPhp();
        bool HasUnder(string kindFolder) => files.Any(f => f.RelativePath.Contains($"/{kindFolder}/"));

        // CQRS (Task 1)
        HasUnder("ReadModels").ShouldBeTrue("PHP must now emit read-model DTOs + projections");
        HasUnder("Queries").ShouldBeTrue("PHP must now emit query criteria DTOs + handler seams");

        // Application services / use cases / operations / specifications (Task 2)
        HasUnder("Services").ShouldBeTrue("PHP must now emit application services / use cases / operations");
        HasUnder("Specifications").ShouldBeTrue("PHP must now emit specification predicate classes");

        // Policies (Task 3)
        HasUnder("Policies").ShouldBeTrue("PHP must now emit policy reactor seams");

        // Context map: ACL translators + integration subscribers (Task 4) — both land in Abstractions/.
        HasUnder("Abstractions").ShouldBeTrue("PHP must now emit context-map seams");
        files.Any(f => f.RelativePath.Contains("/Abstractions/") && f.RelativePath.EndsWith("Translator.php"))
            .ShouldBeTrue("PHP must now emit an anti-corruption-layer translator interface");
        files.Any(f => f.RelativePath.Contains("/Abstractions/")
                       && Path.GetFileName(f.RelativePath).StartsWith("Handle"))
            .ShouldBeTrue("PHP must now emit an integration-event subscriber interface");
    }

    [Fact]
    public void Pizzeria_php_application_layer_files_declare_strict_types()
    {
        var files = EmitPizzeriaPhp();
        foreach (EmittedFile f in files.Where(f =>
            f.RelativePath.Contains("/ReadModels/") || f.RelativePath.Contains("/Queries/")
            || f.RelativePath.Contains("/Services/") || f.RelativePath.Contains("/Specifications/")
            || f.RelativePath.Contains("/Policies/") || f.RelativePath.Contains("/Abstractions/")))
        {
            f.Contents.Contains("declare(strict_types=1)")
                .ShouldBeTrue($"{f.RelativePath} must be strict-typed PHP 8.1");
        }
    }
}
