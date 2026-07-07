using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Documents and locks the Rust emitter's <see cref="Koine.Compiler.Emit.EmittedFile.Kind"/> contract
/// (#1170): unlike the C#/TypeScript/Python/PHP backends — which emit one file per type and tint it
/// with a DDD-stereotype slug — Rust emits ONE module file per bounded context (all its value objects,
/// entities, enums, events, … flat in <c>src/&lt;context&gt;.rs</c>). A context module is a mix of
/// building blocks with no single stereotype, so every Rust file carries a <c>null</c> Kind by design;
/// the Studio Output rail shows neutral dots for Rust because that is semantically correct, not a gap.
/// </summary>
public class RustKindLayoutTests
{
    private const string Fixture = """
        context Catalog {
          enum Availability { InStock, OutOfStock }
          value Sku { code: String }
          aggregate Product root Product {
            entity Product identified by ProductId {
              sku:          Sku
              availability: Availability
            }
            entity ProductReview identified by ReviewId {
              rating: Int
            }
            event ProductListed { product: ProductId }
          }
        }
        """;

    private static IReadOnlyList<Koine.Compiler.Emit.EmittedFile> Emit()
    {
        var result = new KoineCompiler().Compile(Fixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    [Fact]
    public void The_per_context_module_carries_no_kind_since_it_mixes_stereotypes()
    {
        var module = Emit().Single(f => f.RelativePath == "src/catalog.rs");
        module.Kind.ShouldBeNull();
    }

    [Fact]
    public void No_rust_file_carries_a_ddd_kind_by_design()
    {
        Emit().ShouldAllBe(f => f.Kind == null);
    }
}
