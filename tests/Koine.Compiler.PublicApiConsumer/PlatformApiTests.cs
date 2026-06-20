using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.PublicApiConsumer;

/// <summary>
/// Compiles against the PUBLIC Koine.Compiler API only (this project has no InternalsVisibleTo
/// grant). It exercises the four platform seams frozen in issue #69 — embed the compiler, run an
/// external <see cref="IModelAnalyzer"/>, resolve an emitter through <see cref="EmitterRegistry"/>,
/// and read an <see cref="EmittedFile"/>. The fact that this builds and passes IS the proof that the
/// public surface is sufficient for a real third-party consumer.
/// </summary>
public sealed class PlatformApiTests
{
    private const string Model = """
        context Catalog {
          value Sku { code: String }
          entity Product identified by ProductId {
            name: String
            sku: Sku
          }
        }
        """;

    [Fact]
    public void Embeds_the_compiler_and_resolves_an_emitter_through_the_registry()
    {
        // Resolve the C# emitter through the public registry (built-in providers).
        var registry = new EmitterRegistry();
        registry.IsSupported("csharp").ShouldBeTrue();
        registry.TryCreate("csharp", EmitterOptions.Empty, out IEmitter emitter).ShouldBeTrue();

        // Compile the model with the public compiler entry point.
        var result = new KoineCompiler().Compile(Model, emitter);

        result.Success.ShouldBeTrue();
        result.Model.ShouldNotBeNull();
        result.Files.ShouldNotBeEmpty();

        // Read an EmittedFile off the public CompileResult.
        EmittedFile product = result.Files.First(f => f.RelativePath.Contains("Product"));
        product.Contents.ShouldContain("class Product");
    }

    [Fact]
    public void Runs_an_external_IModelAnalyzer_through_the_public_pipeline()
    {
        // A consumer-authored analyzer, wired purely through public API.
        var analyzer = new NoLowercaseTypeNamesAnalyzer();
        var compiler = new KoineCompiler([analyzer]);

        // A model whose type name is lowercase trips the consumer analyzer.
        var result = compiler.Compile(
            "context Catalog { value money { amount: Decimal } }",
            new EmitterRegistry().TryCreate("csharp", EmitterOptions.Empty, out var e) ? e : throw new InvalidOperationException());

        result.Diagnostics.ShouldContain(d => d.Code == "CONSUMER001");
    }

    /// <summary>A trivial external analyzer that only touches public API surface.</summary>
    private sealed class NoLowercaseTypeNamesAnalyzer : IModelAnalyzer
    {
        public string Id => "consumer.no-lowercase-type-names";

        public void Analyze(AnalyzerContext context)
        {
            foreach (var ctx in context.Model.Contexts)
            {
                foreach (var type in ctx.Types)
                {
                    if (type.Name.Length > 0 && char.IsLower(type.Name[0]))
                    {
                        context.Report(Diagnostic.Warning(
                            "CONSUMER001",
                            $"type '{type.Name}' should be PascalCase",
                            type.Span));
                    }
                }
            }
        }
    }
}
