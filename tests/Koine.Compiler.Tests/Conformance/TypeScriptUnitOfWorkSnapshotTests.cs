using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R12.1 Unit-of-Work snapshot coverage for the TypeScript backend, the TS counterpart of the C#
/// emitter's <c>IUnitOfWork</c>. The fixture carries TWO aggregates (each with a root entity and
/// therefore a generated repository) in one context, so the reviewed <c>.verified.txt</c> locks in
/// the emitted <c>IUnitOfWork</c> interface: one <c>readonly</c> repository-typed property per
/// aggregate root (camelCased, pluralized name), each imported from its repository module, plus an
/// async <c>saveChangesAsync</c>.
/// </summary>
public class TypeScriptUnitOfWorkSnapshotTests
{
    /// <summary>Two aggregates in one context — so the UoW exposes both repositories.</summary>
    internal const string Fixture = """
        context Sales {

          aggregate Order root Order {
            entity Order identified by OrderId {
              total: Int
            }
          }

          aggregate Customer root Customer {
            entity Customer identified by CustomerId {
              name: String
            }
          }
        }
        """;

    /// <summary>The emitted TypeScript for the two-aggregate fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_unit_of_work_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
