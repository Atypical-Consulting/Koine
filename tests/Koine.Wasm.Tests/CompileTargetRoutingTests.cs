using System.Text.Json.Nodes;
using Koine.Compiler;
using Koine.Compiler.Emit;

namespace Koine.Wasm.Tests;

/// <summary>
/// Guard for <see cref="Koine.Wasm.CompilerInterop.Compile"/>'s target → emitter routing (issue #332).
/// <c>Compile</c> must resolve its emitter from the SAME <see cref="EmitterRegistry"/> that
/// <c>EmitPreview</c> / <c>ListEmitTargets</c> use, so a target registered in
/// <c>BuiltInEmitterProviders.All</c> can never silently fall back to C#. This converts the prose comment
/// #301 left on the hand-written <c>switch</c> into an executable invariant: every known target id routes
/// to its own emitter and emits files of its own kind, and only a genuinely unknown id (or a marshalled-in
/// JS <c>null</c>/empty target) degrades to <c>csharp</c>. It passes against today's switch too — its value
/// is guarding the refactor and any future provider added to the registry.
/// </summary>
public class CompileTargetRoutingTests
{
    // A single-context model that emits at least one file for EVERY target — type files for the language
    // emitters, glossary.md, docs/*.md, asyncapi.yaml and <Context>/openapi.yaml for the doc/spec
    // generators. Mirrors src/Koine.Wasm/smoke-test.mjs so the two stay in step.
    private const string Source = """
        context Billing {
          enum Currency { EUR, USD, GBP }
          value Money {
            amount: Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }
        }
        """;

    // The file extension each known target emits — the "own kind" a non-C# target must produce so a silent
    // C# fallback (.cs) is caught. Keyed by the registry's target id; a newly-registered target with no
    // entry here fails Known_target_routes_to_its_own_emitter loudly, forcing whoever adds it to extend
    // this coverage too.
    private static readonly IReadOnlyDictionary<string, string> ExpectedExtension =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["csharp"] = ".cs",
            ["typescript"] = ".ts",
            ["python"] = ".py",
            ["php"] = ".php",
            ["rust"] = ".rs",
            ["glossary"] = ".md",
            ["docs"] = ".md",
            ["asyncapi"] = ".yaml",
            ["openapi"] = ".yaml",
        };

    // CompilerInterop.Compile is [SupportedOSPlatform("browser")] for the JS-interop boundary, but its body
    // has no JS interop — safe to call off-browser in a test, like the other wasm parity tests.
#pragma warning disable CA1416
    private static string Compile(string source, string? target) => CompilerInterop.Compile(source, target!);
#pragma warning restore CA1416

    /// <summary>Every target the registry resolves — drives the theory so a new provider auto-extends coverage.</summary>
    public static IEnumerable<object[]> KnownTargets() =>
        new EmitterRegistry(BuiltInEmitterProviders.All).SupportedTargets.Select(t => new object[] { t });

    [Theory]
    [MemberData(nameof(KnownTargets))]
    public void Known_target_routes_to_its_own_emitter(string target)
    {
        // The registry is the single source of truth Compile must agree with: resolve the emitter it
        // should pick, and assert Compile reports THAT emitter's TargetName (never a silent csharp).
        new EmitterRegistry(BuiltInEmitterProviders.All).TryCreate(target, EmitterOptions.Empty, out var emitter).ShouldBeTrue();

        var result = JsonNode.Parse(Compile(Source, target))!;

        result["ok"]!.GetValue<bool>().ShouldBeTrue();
        result["target"]!.GetValue<string>().ShouldBe(emitter.TargetName);

        var paths = result["files"]!.AsArray().Select(f => f!["path"]!.GetValue<string>()).ToList();
        paths.ShouldNotBeEmpty();

        ExpectedExtension.ShouldContainKey(target); // a new registry target must declare its kind here
        var ext = ExpectedExtension[target];
        paths.ShouldContain(
            p => p.EndsWith(ext, StringComparison.Ordinal),
            $"target '{target}' should emit at least one '{ext}' file, not fall back to C#");
    }

    [Theory]
    [InlineData("cobol")] // a registered-looking but unknown id
    [InlineData("")] // empty target
    [InlineData(null)] // a JS null/undefined marshalled across the interop boundary
    public void Unknown_or_empty_target_falls_back_to_csharp(string? target)
    {
        var result = JsonNode.Parse(Compile(Source, target))!;

        result["ok"]!.GetValue<bool>().ShouldBeTrue();
        result["target"]!.GetValue<string>().ShouldBe("csharp");

        var paths = result["files"]!.AsArray().Select(f => f!["path"]!.GetValue<string>()).ToList();
        paths.ShouldContain(p => p.EndsWith(".cs", StringComparison.Ordinal));
    }
}
