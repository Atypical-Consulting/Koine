using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #419: two specs in the same bounded context whose names normalize to the same emitted
/// predicate (e.g. <c>IsActive</c> + <c>Active</c> → <c>isActive</c>, or <c>FreeOrder</c> +
/// <c>free_order</c> → <c>isFreeOrder</c>) are rejected at validation time with a span-anchored
/// <see cref="DiagnosticCodes.DuplicateSpecPredicate"/> diagnostic — caught once for every emitter —
/// instead of silently emitting a duplicate predicate function/method.
/// </summary>
public class SpecPredicateCollisionTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Is_prefixed_and_bare_spec_on_same_type_collide()
    {
        const string src = """
            context Promotions {
              value Order { discountedTotal: Int }
              spec IsFreeOrder on Order = discountedTotal == 0
              spec FreeOrder   on Order = discountedTotal == 0
            }
            """;

        Diagnose(src).ShouldContain(d =>
            d.Code == DiagnosticCodes.DuplicateSpecPredicate
            && d.Message.Contains("FreeOrder")
            && d.Message.Contains("IsFreeOrder")
            && d.Message.Contains("isFreeOrder"));
    }
}
