using Koine.Compiler.Emit.AsyncApi;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R18 — the AsyncAPI 3.0 emitter (<c>--target asyncapi</c>): one YAML document
/// describing a domain's integration-event contracts and their pub/sub flow.
/// </summary>
public class R18AsyncApiEmitterTests
{
    [Fact]
    public void Target_name_is_asyncapi()
    {
        new AsyncApiEmitter().TargetName.ShouldBe("asyncapi");
    }

    [Fact]
    public void Emits_a_single_asyncapi_yaml_with_a_valid_3_0_header()
    {
        const string source = """
            context Sales {
              integration event OrderPlaced {
                orderId:  String
                placedAt: Instant
              }
              publishes OrderPlaced
            }
            """;

        var result = new KoineCompiler().Compile(source, new AsyncApiEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var file = result.Files.ShouldHaveSingleItem();
        file.RelativePath.ShouldEndWith("asyncapi.yaml");
        file.Contents.ShouldContain("asyncapi: 3.0.0");
    }
}
