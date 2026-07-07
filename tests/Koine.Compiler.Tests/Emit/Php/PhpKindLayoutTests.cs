using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the DDD-stereotype slug the PHP emitter stamps on
/// <see cref="Koine.Compiler.Emit.EmittedFile.Kind"/> — the <c>--koi-ddd-*</c> vocabulary Koine
/// Studio's Output rail tints generated files by. Mirrors <see cref="KindFolderLayoutTests"/> (the C#
/// emitter's equivalent) and shares its slug vocabulary via <c>Koine.Emit.Common</c>'s <c>DddKind</c>.
/// PHP keeps the aggregate root under <c>Entities/</c> and co-locates integration events under
/// <c>Events/</c>, so both the aggregate and integration-event cases are asserted from a file sharing
/// a folder with a sibling stereotype — the slug is semantic, not a folder echo.
/// </summary>
public class PhpKindLayoutTests
{
    private const string Fixture = """
        context Catalog {
          enum Availability { InStock, OutOfStock }
          value Sku { code: String }
          integration event ProductPublished { sku: String }
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
        var result = new KoineCompiler().Compile(Fixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(pathSuffix, StringComparison.Ordinal)).Kind;
    }

    [Fact]
    public void Aggregate_root_is_stamped_with_the_aggregate_kind() =>
        KindOf("Entities/Product.php").ShouldBe("aggregate");

    [Fact]
    public void Non_root_entity_is_stamped_with_the_entity_kind() =>
        KindOf("Entities/ProductReview.php").ShouldBe("entity");

    [Fact]
    public void Value_object_is_stamped_with_the_value_kind() =>
        KindOf("ValueObjects/Sku.php").ShouldBe("value");

    [Fact]
    public void Generated_id_is_stamped_with_the_value_kind() =>
        KindOf("ValueObjects/ProductId.php").ShouldBe("value");

    [Fact]
    public void Enum_is_stamped_with_the_enum_kind() =>
        KindOf("Enums/Availability.php").ShouldBe("enum");

    [Fact]
    public void Domain_event_is_stamped_with_the_event_kind() =>
        KindOf("Events/ProductListed.php").ShouldBe("event");

    [Fact]
    public void Integration_event_is_stamped_with_the_integration_event_kind() =>
        KindOf("Events/ProductPublished.php").ShouldBe("integration-event");

    [Fact]
    public void Repository_interface_is_stamped_with_the_repository_kind() =>
        KindOf("Repositories/ProductRepository.php").ShouldBe("repository");

    [Fact]
    public void Runtime_support_file_has_no_kind_since_it_is_not_a_building_block() =>
        KindOf("composer.json").ShouldBeNull();
}
