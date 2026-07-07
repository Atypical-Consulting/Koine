using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the DDD-stereotype slug the Python emitter stamps on
/// <see cref="Koine.Compiler.Emit.EmittedFile.Kind"/> — the <c>--koi-ddd-*</c> vocabulary Koine
/// Studio's Output rail tints generated files by. Mirrors <see cref="KindFolderLayoutTests"/> (the C#
/// emitter's equivalent) and shares its slug vocabulary via <c>Koine.Emit.Common</c>'s <c>DddKind</c>.
/// Python co-locates domain and integration events in <c>events/</c>, so the integration-event case is
/// asserted explicitly (it must still read <c>integration-event</c>, not <c>event</c>).
/// </summary>
public class PythonKindLayoutTests
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
        var result = new KoineCompiler().Compile(Fixture, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(pathSuffix, StringComparison.Ordinal)).Kind;
    }

    [Fact]
    public void Aggregate_root_is_stamped_with_the_aggregate_kind() =>
        KindOf("catalog/product.py").ShouldBe("aggregate");

    [Fact]
    public void Non_root_entity_is_stamped_with_the_entity_kind() =>
        KindOf("entities/product_review.py").ShouldBe("entity");

    [Fact]
    public void Value_object_is_stamped_with_the_value_kind() =>
        KindOf("value_objects/sku.py").ShouldBe("value");

    [Fact]
    public void Generated_id_is_stamped_with_the_value_kind() =>
        KindOf("value_objects/product_id.py").ShouldBe("value");

    [Fact]
    public void Enum_is_stamped_with_the_enum_kind() =>
        KindOf("enums/availability.py").ShouldBe("enum");

    [Fact]
    public void Domain_event_is_stamped_with_the_event_kind() =>
        KindOf("events/product_listed.py").ShouldBe("event");

    [Fact]
    public void Integration_event_is_stamped_with_the_integration_event_kind() =>
        KindOf("events/product_published.py").ShouldBe("integration-event");

    [Fact]
    public void Repository_protocol_is_stamped_with_the_repository_kind() =>
        KindOf("repositories/product_repository.py").ShouldBe("repository");

    [Fact]
    public void Package_init_has_no_kind_since_it_is_not_a_building_block() =>
        KindOf("catalog/__init__.py").ShouldBeNull();
}
