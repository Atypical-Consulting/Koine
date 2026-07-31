using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1702 — audits <c>OpenApiEmitter.Schemas.cs</c>'s read-model DIRECT field handling for the
/// same cross-context misclassification shape #1638 fixed in the TypeScript/Python/PHP/Rust emitters.
/// <c>ReadModelSchema</c> resolved a direct field's type via the fully context-blind 2-arg
/// <c>ModelIndex.TryGetMemberType(rm.SourceType, field.Name, out …)</c> overload — no context argument
/// at all — then <c>BaseSchema</c> emitted a local <c>$ref</c> whenever <paramref name="emitted"/>
/// (this CONTEXT's own schema names) happened to contain the bare type name, regardless of whether that
/// locally-declared schema is actually the SOURCE type's own field. Confirmed via this repro (identical
/// to the TS sibling test): <c>Billing.OrderSummary.status</c> emitted <c>$ref: '#/components/schemas/Status'</c>
/// resolving to <c>Billing.Status</c> (a value-object schema, <c>{ code: string }</c>) instead of
/// <c>Ordering.Status</c> (the actual source field's enum, <c>{ enum: [Pending, Shipped, Delivered] }</c>)
/// — a silently wrong schema, not a hard failure, but a real one: any client generated off Billing's
/// document would deserialize <c>status</c> against the wrong shape. The fix resolves the SOURCE type's
/// own owning context via <c>ModelIndex.ResolveOwner</c> and only treats the field's type as a local
/// <c>$ref</c> candidate when it is actually declared in THIS schema's own context — otherwise it
/// degrades like any other foreign-context reference (an opaque <c>{ type: object }</c>, matching how a
/// cross-context read model field already degrades today when there is no local schema at all).
/// </summary>
public class OpenApiCrossContextTests
{
    private const string ReadModelDirectFieldFixture = """
        context Billing {
          value Status {
            code: String
          }

          import Ordering.{ Order }

          readmodel OrderSummary from Order {
            status
          }
        }

        context Ordering {
          enum Status {
            Pending
            Shipped
            Delivered
          }

          entity Order identified by OrderId {
            status: Status = Pending
          }
        }
        """;

    [Fact]
    public void Read_model_direct_field_from_a_foreign_context_does_not_ref_a_same_named_local_schema()
    {
        var result = new KoineCompiler().Compile(ReadModelDirectFieldFixture, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var billing = result.Files.Single(f => f.RelativePath == "Billing/openapi.yaml");

        // Billing's OWN Status schema (the value object) is still emitted, correctly.
        billing.Contents.ShouldContain("code:");

        // OrderSummary.status must NOT ref Billing's own (differently-kinded) same-named Status —
        // it belongs to Ordering, a context Billing's own document carries no schema for.
        billing.Contents.ShouldNotContain("$ref: \"#/components/schemas/Status\"");
    }
}
