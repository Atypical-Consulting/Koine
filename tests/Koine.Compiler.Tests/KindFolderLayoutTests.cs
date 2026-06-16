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
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Select(f => f.RelativePath).ToList();
    }

    [Fact]
    public void Aggregate_root_sits_at_the_context_root()
    {
        Assert.Contains("Catalog/Product.cs", Paths());
    }

    [Fact]
    public void Non_root_entity_goes_under_Entities()
    {
        Assert.Contains("Catalog/Entities/ProductReview.cs", Paths());
    }

    [Fact]
    public void Value_objects_and_generated_ids_go_under_ValueObjects()
    {
        var paths = Paths();
        Assert.Contains("Catalog/ValueObjects/Sku.cs", paths);
        Assert.Contains("Catalog/ValueObjects/ProductId.cs", paths);
        Assert.Contains("Catalog/ValueObjects/ReviewId.cs", paths);
    }

    [Fact]
    public void Enums_go_under_Enums()
    {
        Assert.Contains("Catalog/Enums/Availability.cs", Paths());
    }

    [Fact]
    public void Domain_events_go_under_Events()
    {
        Assert.Contains("Catalog/Events/ProductListed.cs", Paths());
    }

    [Fact]
    public void Repository_interfaces_go_under_Repositories()
    {
        Assert.Contains("Catalog/Repositories/IProductRepository.cs", Paths());
    }

    [Fact]
    public void Unit_of_work_goes_under_Abstractions()
    {
        Assert.Contains("Catalog/Abstractions/IUnitOfWork.cs", Paths());
    }

    [Fact]
    public void Namespace_is_still_the_bare_context()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        var sku = result.Files.Single(f => f.RelativePath == "Catalog/ValueObjects/Sku.cs").Contents;
        Assert.Contains("namespace Catalog;", sku);
    }
}
