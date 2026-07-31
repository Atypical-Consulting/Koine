using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1702 — audits <c>CSharpEmitter.Cqrs.cs</c>'s read-model DIRECT field handling for the same
/// cross-context misclassification shape #1638 fixed in the TypeScript/Python/PHP/Rust emitters
/// (<see cref="Conformance.TypeScriptConformanceTests.Read_model_direct_field_from_a_foreign_context_resolves_against_the_source_s_own_context"/>
/// is the sibling test for TS). A read model's direct field copies a like-named member straight off its
/// SOURCE type, which per R12.3 may live in a DIFFERENT bounded context than the read model itself. The
/// old call site resolved the field's bare type via <c>index.TryGetMemberType(context, rm.SourceType, ...)</c>
/// then <c>typeMapper.Map(t)</c> with NO context at all — so when the read model's OWN context also
/// declares a same-named, differently-kinded sibling type, <c>CSharpTypeMapper.MapBase</c>'s bare-name
/// branch (no <see cref="Ast.TypeRef.Qualifier"/>, so no forced namespace qualification) emits the bare
/// name into the read model's own namespace, where C# name resolution binds a same-namespace
/// declaration over anything brought in by a <c>using</c> — silently rebinding the property to the
/// WRONG type. Confirmed via this repro: <c>Billing.OrderSummary.Status</c> bound to
/// <c>Billing.Status</c> (a value object) instead of <c>Ordering.Status</c> (the enum the source field
/// actually declares), a hard <c>CS1503</c> (<c>cannot convert from 'Ordering.Status' to 'Billing.Status'</c>)
/// in the generated mapper body. The fix resolves the SOURCE type's own owning context via
/// <c>ModelIndex.ResolveOwner</c> and threads it into <c>typeMapper.Map</c> as the referencing context for
/// a direct field only — mirroring #1638's pattern, adapted to how <c>CSharpTypeMapper</c> qualifies
/// (forcing <see cref="Ast.TypeRef.Qualifier"/> rather than a <c>Classify</c> fallback).
/// </summary>
public class CSharpCrossContextTests
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

    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    [Fact]
    public void Read_model_direct_field_from_a_foreign_context_compiles_against_the_source_s_own_type()
    {
        IReadOnlyList<EmittedFile> files = Emit(ReadModelDirectFieldFixture);

        EmittedFile orderSummary = files.Single(f => f.RelativePath == "Billing/ReadModels/OrderSummary.cs");
        orderSummary.Contents.ShouldContain("public sealed record OrderSummary(Ordering.Status Status);");

        var (_, errors) = TestSupport.Compile(files);
        errors.ShouldBeEmpty(
            "a read model's direct field must resolve the SOURCE type's own bare member reference against "
            + "the source's own owning context, not the read model's:\n" + string.Join("\n", errors));
    }
}
