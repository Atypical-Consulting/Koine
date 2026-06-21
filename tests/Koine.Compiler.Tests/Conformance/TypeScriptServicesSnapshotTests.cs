using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R10 (behavioral declarations) snapshot coverage for the TypeScript backend, the TS counterpart of
/// the C# emitter's specification/domain-service slice. The fixture carries a <c>service</c> with a
/// pure <c>operation</c> (a body computing from its parameters) and a <c>spec</c> (a boolean
/// condition over a value object's fields) — so the reviewed <c>.verified.txt</c> locks in the
/// emitted domain-service class (with its computed method body) and the specifications module (a
/// boolean predicate function) exactly.
/// </summary>
public class TypeScriptServicesSnapshotTests
{
    /// <summary>A focused behavioral cross-section (a domain service + a spec), emitted to TypeScript.</summary>
    internal const string Fixture = """
        context Pricing {
          value Order {
            subtotal: Int
            discount: Int
            invariant subtotal >= 0 "a subtotal cannot be negative"
          }

          /// R10.1 — a reusable specification: a large order.
          spec large on Order = subtotal >= 100

          /// R10.2 — a stateless domain service computing pure results.
          service PricingService {
            /// The net total after applying the order's discount.
            operation net(order: Order): Int = order.subtotal - order.discount
          }
        }
        """;

    /// <summary>The emitted TypeScript for the behavioral fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_services_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
