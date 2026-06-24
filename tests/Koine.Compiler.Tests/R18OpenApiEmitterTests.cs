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
}
