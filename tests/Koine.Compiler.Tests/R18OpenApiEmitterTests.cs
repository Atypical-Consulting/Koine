using Koine.Compiler.Emit.OpenApi;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// OpenAPI 3.1 spec emitter (issue #126): proves <c>--target openapi</c> turns a validated model into
/// a deterministic OpenAPI YAML document per bounded context. Schema/path output is snapshot-tested via
/// Verify; structural facts are asserted directly. Changes to emitter output must be reviewed through
/// the <c>.verified.txt</c> diff.
/// </summary>
public class R18OpenApiEmitterTests
{
    [Fact]
    public void Target_name_is_openapi() =>
        new OpenApiEmitter().TargetName.ShouldBe("openapi");

    [Fact]
    public void Emits_an_openapi_3_1_document_per_context()
    {
        const string src = """
            context Billing {
              value Money { amount: Decimal }
            }
            """;

        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("billing.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var file = result.Files.ShouldHaveSingleItem();
        file.RelativePath.ShouldEndWith("openapi.yaml");
        file.Contents.ShouldContain("openapi: 3.1.0");
        file.Contents.ShouldContain("info:");
    }

    /// <summary>The §catalog fixture exercises every Task 2 schema kind in one document.</summary>
    private const string CatalogFixture = """
        context Catalog {
          /// A supported settlement currency.
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
          }

          value Money {
            amount: Decimal
            currency: Currency
          }

          value Product {
            sku: String
            name: String
            price: Money
            tags: List<String>
            discount: Decimal?
          }

          aggregate Catalog root Item {
            entity Item identified by ItemId {
              sku: String
              price: Money
            }
          }

          readmodel ItemRow from Item {
            sku
            price
          }
        }
        """;

    [Fact]
    public Task Schemas_from_value_objects_read_models_and_enums()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("catalog.koi", CatalogFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("components:");
        yaml.ShouldContain("schemas:");

        // One named schema per value object, read model, and enum.
        yaml.ShouldContain("Currency:");
        yaml.ShouldContain("Money:");
        yaml.ShouldContain("Product:");
        yaml.ShouldContain("ItemRow:");

        // The smart enum lowers to a string enum of its member names.
        yaml.ShouldContain("enum:");
        yaml.ShouldContain("- EUR");
        yaml.ShouldContain("- USD");

        // Nested value objects / enums are referenced, collections become arrays, optional is nullable.
        yaml.ShouldContain("$ref: \"#/components/schemas/Money\"");
        yaml.ShouldContain("type: array");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }
}
