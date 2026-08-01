using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// The anti-drift guard #1748's whole design rests on: the C# <c>api</c> layer and the
/// <c>openapi</c> target must resolve a <c>@route</c> <c>{token}</c> to the SAME member and the SAME
/// type, because both read one shared source (<c>RouteInfo.TokenBindings</c>,
/// <c>Koine.Emit.Common/RouteDerivation</c>) rather than re-deriving the binding independently. Per-target
/// tests prove each emitter is internally consistent; only compiling the SAME model through BOTH
/// targets in one run proves they never silently diverge.
/// </summary>
public class RouteTokenBindingConformanceTests
{
    private const string OrderingFixture = """
        context Ordering {
          enum OrderStatus { Draft, Submitted }

          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft

              @route("/orders/{id}")
              @put
              command submit(note: String) {
                requires status == Draft "order must be a draft to submit"
                status -> Submitted
              }
            }
          }
        }
        """;

    [Fact]
    public void The_csharp_and_openapi_targets_agree_on_an_identity_bound_route_token()
    {
        var csharpOptions = CSharpEmitterOptions.Empty with
        {
            Layers = new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Application, CSharpLayer.Api },
        };
        var csharpResult = new KoineCompiler().Compile(OrderingFixture, new CSharpEmitter(csharpOptions));
        csharpResult.Success.ShouldBeTrue(string.Join("\n", csharpResult.Diagnostics.Select(d => d.ToString())));

        var openApiResult = new KoineCompiler().Compile(OrderingFixture, new OpenApiEmitter());
        openApiResult.Success.ShouldBeTrue(string.Join("\n", openApiResult.Diagnostics.Select(d => d.ToString())));

        var endpoints = csharpResult.Files.Single(f => f.RelativePath.EndsWith("OrderingEndpoints.cs", StringComparison.Ordinal)).Contents;
        var yaml = openApiResult.Files.Single(f => f.RelativePath.EndsWith("openapi.yaml", StringComparison.Ordinal)).Contents;

        // Same name: both resolve the token "id" (no argument of `submit` is named `id`, so it falls
        // back to the aggregate identity on both sides).
        endpoints.ShouldContain("[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] OrderId id");
        yaml.ShouldContain("name: id\n          in: path");

        // Same type: OrderId is a Guid-strategy identity in C#, and the openapi document types the
        // identical token as the corresponding JSON Schema representation of a Guid.
        yaml.ShouldContain("type: string\n            format: uuid");
    }
}
