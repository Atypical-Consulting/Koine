using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the DDD-stereotype slug the TypeScript emitter stamps on
/// <see cref="Koine.Compiler.Emit.EmittedFile.Kind"/> — the <c>--koi-ddd-*</c> vocabulary Koine
/// Studio's Output rail tints generated files by. Mirrors <see cref="KindFolderLayoutTests"/> (the C#
/// emitter's equivalent) over the same fixture, and shares its slug vocabulary via
/// <c>Koine.Emit.Common</c>'s <c>DddKind</c>. Files match on a path suffix so the assertions don't
/// depend on the context-folder shape, only on the kind subfolder + file name.
/// </summary>
public class TypeScriptKindLayoutTests
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

    private static string? KindOf(string pathSuffix)
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(pathSuffix, StringComparison.Ordinal)).Kind;
    }

    [Fact]
    public void Aggregate_root_is_stamped_with_the_aggregate_kind() =>
        KindOf("Catalog/Product.ts").ShouldBe("aggregate");

    [Fact]
    public void Non_root_entity_is_stamped_with_the_entity_kind() =>
        KindOf("entities/ProductReview.ts").ShouldBe("entity");

    [Fact]
    public void Value_object_is_stamped_with_the_value_kind() =>
        KindOf("value-objects/Sku.ts").ShouldBe("value");

    [Fact]
    public void Generated_id_is_stamped_with_the_value_kind() =>
        KindOf("value-objects/ProductId.ts").ShouldBe("value");

    [Fact]
    public void Enum_is_stamped_with_the_enum_kind() =>
        KindOf("enums/Availability.ts").ShouldBe("enum");

    [Fact]
    public void Domain_event_is_stamped_with_the_event_kind() =>
        KindOf("events/ProductListed.ts").ShouldBe("event");

    [Fact]
    public void Repository_interface_is_stamped_with_the_repository_kind() =>
        KindOf("repositories/IProductRepository.ts").ShouldBe("repository");

    [Fact]
    public void Unit_of_work_has_no_kind_since_it_is_a_pure_abstraction() =>
        KindOf("abstractions/IUnitOfWork.ts").ShouldBeNull();
}
