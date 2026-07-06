using System.Reflection;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #69 — the public analyzer platform: <see cref="IModelAnalyzer"/> / <see cref="AnalyzerContext"/>,
/// the built-in analyzer set, and external discovery through <see cref="AnalyzerLoader"/>.
/// </summary>
public class AnalyzerPlatformTests
{
    /// <summary>
    /// A hand-written external analyzer (public, parameterless ctor) used to exercise the loader and
    /// the <see cref="IModelAnalyzer"/> contract end-to-end: it requires every aggregate to declare an
    /// explicit <c>repository { }</c> block, raising <see cref="Code"/> when one is missing.
    /// </summary>
    public sealed class RequireRepositoryAnalyzer : IModelAnalyzer
    {
        public const string Code = "TEST0001";

        public string Id => "test.require-repository";

        public void Analyze(AnalyzerContext context)
        {
            foreach (ContextNode ctx in context.Model.Contexts)
            {
                foreach (TypeDecl type in ctx.Types)
                {
                    if (type is AggregateDecl { Repository: null } agg)
                    {
                        context.Report(Diagnostic.Warning(
                            Code, $"aggregate '{agg.Name}' must declare a repository", agg.Span));
                    }
                }
            }
        }
    }

    /// <summary>
    /// A misbehaving external analyzer that throws on every model — used to prove the host isolates
    /// it (the <see cref="IModelAnalyzer"/> contract: "the host isolates a misbehaving external
    /// analyzer regardless") instead of letting the throw crash the whole compile.
    /// </summary>
    public sealed class ThrowingAnalyzer : IModelAnalyzer
    {
        public string Id => "test.throwing";

        public void Analyze(AnalyzerContext context) =>
            throw new InvalidOperationException("boom — a buggy third-party analyzer");
    }

    // ---- built-in analyzer set ---------------------------------------------

    [Fact]
    public void Built_in_analyzers_are_ordered_and_non_empty()
    {
        SemanticValidator.BuiltInAnalyzers.ShouldNotBeEmpty();
        SemanticValidator.BuiltInAnalyzers.Select(a => a.Id).ShouldBe(new[]
        {
            "koine.unique-type-names",
            "koine.unique-spec-predicate-names",
            "koine.context-map",
            "koine.per-context",
            "koine.reference-discipline",
            "koine.satisfiability",
            "koine.cross-context-type",
        });
    }

    // ---- external discovery via the loader ---------------------------------

    [Fact]
    public void Loader_discovers_a_public_analyzer_from_a_named_assembly()
    {
        var loaded = AnalyzerLoader.Load(new[] { ThisAssemblyName });
        loaded.ShouldContain(a => a is RequireRepositoryAnalyzer);
    }

    [Fact]
    public void Loader_returns_empty_for_no_paths()
    {
        AnalyzerLoader.Load(null).ShouldBeEmpty();
        AnalyzerLoader.Load(Array.Empty<string>()).ShouldBeEmpty();
    }

    [Fact]
    public void Loader_skips_an_unresolvable_assembly_without_crashing()
    {
        AnalyzerLoader.Load(new[] { "this-assembly-does-not-exist-12345" }).ShouldBeEmpty();
    }

    // ---- end-to-end: a custom analyzer raises / stays silent ----------------

    /// <summary>A valid aggregate WITHOUT a repository block (the default repository is implied).</summary>
    private const string NoRepositorySource = """
        context Sales {
          aggregate Order root Order {
            entity Order identified by OrderId {
              total: Int
            }
          }
        }
        """;

    /// <summary>The same aggregate, now declaring an explicit repository block.</summary>
    private const string WithRepositorySource = """
        context Sales {
          aggregate Order root Order {
            repository {
              operations: getById, add
            }
            entity Order identified by OrderId {
              total: Int
            }
          }
        }
        """;

    [Fact]
    public void Custom_analyzer_raises_when_an_aggregate_has_no_repository()
    {
        var diags = DiagnoseWith(NoRepositorySource, ThisAssemblyName);

        // The model itself is clean (no errors), and the external analyzer raises its custom code.
        diags.ShouldNotContain(d => d.Severity == DiagnosticSeverity.Error);
        diags.ShouldContain(d => d.Code == RequireRepositoryAnalyzer.Code);
    }

    [Fact]
    public void Custom_analyzer_is_silent_when_the_aggregate_declares_a_repository()
    {
        var diags = DiagnoseWith(WithRepositorySource, ThisAssemblyName);

        diags.ShouldNotContain(d => d.Code == RequireRepositoryAnalyzer.Code);
    }

    [Fact]
    public void Without_the_external_analyzer_the_custom_code_never_fires()
    {
        // The default compiler (no externals) must never raise the custom code.
        var diags = new KoineCompiler().Diagnose(NoRepositorySource);

        diags.ShouldNotContain(d => d.Code == RequireRepositoryAnalyzer.Code);
    }

    // ---- external analyzer isolation ----------------------------------------

    [Fact]
    public void A_throwing_external_analyzer_is_isolated_and_does_not_crash_the_compile()
    {
        // A model carrying a real built-in diagnostic (unknown type), plus a throwing external analyzer.
        const string source = "context S { value V { x: Nope } }";
        var externals = new IModelAnalyzer[] { new ThrowingAnalyzer() };

        // The throw must NOT escape — the compile completes and still reports the built-in diagnostic.
        IReadOnlyList<Diagnostic> diags = Should.NotThrow(() => new KoineCompiler(externals).Diagnose(source));
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType);
    }

    private static readonly string ThisAssemblyName =
        Assembly.GetExecutingAssembly().GetName().Name!;

    /// <summary>Compiles <paramref name="source"/> with the external analyzers loaded from <paramref name="assembly"/>.</summary>
    private static IReadOnlyList<Diagnostic> DiagnoseWith(string source, string assembly)
    {
        var externals = AnalyzerLoader.Load(new[] { assembly });
        return new KoineCompiler(externals).Diagnose(source);
    }
}
