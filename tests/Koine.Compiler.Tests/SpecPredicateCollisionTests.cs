using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #419: two specs in the same bounded context whose names normalize to the same emitted
/// predicate (e.g. <c>IsActive</c> + <c>Active</c> → <c>isActive</c> in PHP/TS, or <c>FreeOrder</c> +
/// <c>free_order</c> → <c>isFreeOrder</c> in PHP) are rejected at validation time with a span-anchored
/// <see cref="DiagnosticCodes.DuplicateSpecPredicate"/> diagnostic — once, before any emitter runs.
/// The key is the strictest (PHP-equivalent) fold, so it flags any pair that would collide in at least
/// one shipped emitter instead of silently emitting a duplicate predicate function/method.
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

    [Fact]
    public void Every_collider_after_the_first_is_flagged()
    {
        // Three specs folding to the same key (`active`): the 2nd and 3rd are each flagged against the
        // first-seen, so a triple collision yields two diagnostics — not just one for the first pair.
        const string src = """
            context Acct {
              value Account { balance: Int }
              spec IsActive on Account = balance > 0
              spec Active   on Account = balance > 1
              spec active   on Account = balance > 2
            }
            """;

        Diagnose(src).Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate).ShouldBe(2);
    }

    [Fact]
    public void PascalCase_and_snake_case_spec_names_collide()
    {
        // PHP's PascalCase underscore-folding collides `FreeOrder` and `free_order` (both → `isFreeOrder`).
        const string src = """
            context Promotions {
              value Order { discountedTotal: Int }
              spec FreeOrder  on Order = discountedTotal == 0
              spec free_order on Order = discountedTotal == 0
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate);
    }

    [Fact]
    public void Island_and_Land_do_not_collide_word_boundary_rule()
    {
        // `Island` must NOT have its leading "Is" stripped (the char after "Is" is lowercase 'l'),
        // so its key is `island`, distinct from `Land`'s `land` — no false positive.
        const string src = """
            context Geo {
              value Region { size: Int }
              spec Island on Region = size > 0
              spec Land   on Region = size >= 0
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Single_is_prefixed_spec_is_accepted()
    {
        // `IsActive` alone has no sibling to collide with — accepted.
        const string src = """
            context Acct {
              value Account { balance: Int }
              spec IsActive on Account = balance > 0
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Aggregate_nested_spec_collides_with_context_level_spec()
    {
        // The predicate class is per-context, so an aggregate-nested spec and a context-level spec
        // collide even when their target types differ (`Cart` vs `Order`).
        const string src = """
            context Promotions {
              value Order { discountedTotal: Int }
              aggregate Sales root Cart {
                entity Cart identified by CartId { total: Int }
                spec FreeOrder on Cart = total == 0
              }
              spec IsFreeOrder on Order = discountedTotal == 0
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate);
    }

    [Fact]
    public void Colliding_keys_in_different_contexts_do_not_collide()
    {
        // Predicates live in per-context `<Context>Specifications` classes, so the same key in two
        // different contexts is fine.
        const string src = """
            context Alpha {
              value Order { discountedTotal: Int }
              spec FreeOrder on Order = discountedTotal == 0
            }
            context Beta {
              value Order { discountedTotal: Int }
              spec IsFreeOrder on Order = discountedTotal == 0
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate);
    }
}
