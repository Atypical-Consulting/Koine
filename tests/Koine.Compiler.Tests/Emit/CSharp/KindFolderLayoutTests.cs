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

    private static string? KindOf(string relativePath)
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath == relativePath).Kind;
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

    // ---- EmittedFile.Kind: the DDD-stereotype slug a UI tints generated files by ----

    [Fact]
    public void Aggregate_root_is_stamped_with_the_aggregate_kind()
    {
        KindOf("Catalog/Product.cs").ShouldBe("aggregate");
    }

    [Fact]
    public void Non_root_entity_is_stamped_with_the_entity_kind()
    {
        KindOf("Catalog/Entities/ProductReview.cs").ShouldBe("entity");
    }

    [Fact]
    public void Value_object_is_stamped_with_the_value_kind()
    {
        KindOf("Catalog/ValueObjects/Sku.cs").ShouldBe("value");
    }

    [Fact]
    public void Enum_is_stamped_with_the_enum_kind()
    {
        KindOf("Catalog/Enums/Availability.cs").ShouldBe("enum");
    }

    [Fact]
    public void Domain_event_is_stamped_with_the_event_kind()
    {
        KindOf("Catalog/Events/ProductListed.cs").ShouldBe("event");
    }

    [Fact]
    public void Repository_interface_is_stamped_with_the_repository_kind()
    {
        KindOf("Catalog/Repositories/IProductRepository.cs").ShouldBe("repository");
    }

    [Fact]
    public void Unit_of_work_has_no_kind_since_it_is_a_pure_abstraction()
    {
        KindOf("Catalog/Abstractions/IUnitOfWork.cs").ShouldBeNull();
    }
}
