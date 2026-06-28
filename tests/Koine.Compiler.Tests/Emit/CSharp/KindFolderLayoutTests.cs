using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the kind-based output layout: each DDD building block lands in its
/// subfolder, aggregate roots sit at the context root, and namespaces are
/// unchanged. Guards against accidental regression to a flat layout.
/// </summary>
public class KindFolderLayoutTests
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

    private static IReadOnlyList<string> Paths()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Select(f => f.RelativePath).ToList();
    }

    [Fact]
    public void Aggregate_root_sits_at_the_context_root()
    {
        Paths().ShouldContain("Catalog/Product.cs");
    }

    [Fact]
    public void Non_root_entity_goes_under_Entities()
    {
        Paths().ShouldContain("Catalog/Entities/ProductReview.cs");
    }

    [Fact]
    public void Value_objects_and_generated_ids_go_under_ValueObjects()
    {
        var paths = Paths();
        paths.ShouldContain("Catalog/ValueObjects/Sku.cs");
        paths.ShouldContain("Catalog/ValueObjects/ProductId.cs");
        paths.ShouldContain("Catalog/ValueObjects/ReviewId.cs");
    }

    [Fact]
    public void Enums_go_under_Enums()
    {
        Paths().ShouldContain("Catalog/Enums/Availability.cs");
    }

    [Fact]
    public void Domain_events_go_under_Events()
    {
        Paths().ShouldContain("Catalog/Events/ProductListed.cs");
    }

    [Fact]
    public void Repository_interfaces_go_under_Repositories()
    {
        Paths().ShouldContain("Catalog/Repositories/IProductRepository.cs");
    }

    [Fact]
    public void Unit_of_work_goes_under_Abstractions()
    {
        Paths().ShouldContain("Catalog/Abstractions/IUnitOfWork.cs");
    }

    [Fact]
    public void Namespace_is_still_the_bare_context()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        var sku = result.Files.Single(f => f.RelativePath == "Catalog/ValueObjects/Sku.cs").Contents;
        sku.ShouldContain("namespace Catalog;");
    }
}
