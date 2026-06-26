using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
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

    /// <summary>
    /// Validates <paramref name="source"/> telling the semantic pass which emit target(s) are enabled
    /// (issue #495). The no-target <see cref="Diagnose(string)"/> path stays conservative (all targets).
    /// </summary>
    private static IReadOnlyList<Diagnostic> Diagnose(string source, EmitTargetSet targets)
    {
        (KoineModel? model, _) = new KoineCompiler().Parse(source);
        return new SemanticValidator().Validate(new SemanticModel(model!), targets);
    }

    [Fact]
    public void Validator_accepts_enabled_targets_and_the_all_targets_default_stays_strict()
    {
        // Issue #495, Task 1: the validator can be *told* the enabled targets, and being told "all
        // shipped targets" (the default when no target context exists) reproduces today's strict
        // KOI1007 error — byte-identical to the no-target path.
        const string src = """
            context Promotions {
              value Order { discountedTotal: Int }
              spec FreeOrder  on Order = discountedTotal == 0
              spec free_order on Order = discountedTotal == 0
            }
            """;

        Diagnose(src, EmitTargetSet.All).ShouldContain(d =>
            d.Code == DiagnosticCodes.DuplicateSpecPredicate && d.Severity == DiagnosticSeverity.Error);

        // The no-target default must match the explicit all-targets request exactly.
        Diagnose(src).Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate)
            .ShouldBe(Diagnose(src, EmitTargetSet.All).Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate));
    }

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
        // Three *distinct* spec names folding to the same key (`freeorder`): the 2nd and 3rd are each
        // flagged against the first-seen, so a triple collision yields two diagnostics — not just one for
        // the first pair. (Distinct names, so none is a KOI1005 exact duplicate that #494 would suppress.)
        const string src = """
            context Promotions {
              value Order { discountedTotal: Int }
              spec FreeOrder   on Order = discountedTotal == 0
              spec free_order  on Order = discountedTotal == 1
              spec IsFreeOrder on Order = discountedTotal == 2
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

    [Fact]
    public void Exact_case_insensitive_same_target_duplicate_does_not_also_emit_KOI1007()
    {
        // Issue #494: `Active` + `active` on the same target is already an exact/case-insensitive
        // duplicate that KOI1005 (`DuplicateSpec`) owns with the clearer message. KOI1007 folds case
        // too, so it would double-report the very same span — suppress it here. KOI1005 still fires.
        const string src = """
            context Acct {
              value Account { balance: Int }
              spec Active on Account = balance > 0
              spec active on Account = balance > 1
            }
            """;

        IReadOnlyList<Diagnostic> diagnostics = Diagnose(src);
        diagnostics.Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate).ShouldBe(0);
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpec);
    }

    [Fact]
    public void Distinct_names_folding_to_same_predicate_on_same_target_still_emit_KOI1007()
    {
        // `IsActive` + `Active` are *distinct* names (not a KOI1005 duplicate) that nonetheless fold to
        // the same predicate (`isActive`) — exactly what KOI1007 exists to catch, so it must still fire.
        const string src = """
            context Acct {
              value Account { balance: Int }
              spec IsActive on Account = balance > 0
              spec Active   on Account = balance > 1
            }
            """;

        Diagnose(src).Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate).ShouldBe(1);
    }

    [Fact]
    public void Exact_duplicate_buried_mid_fold_chain_is_suppressed_order_independently()
    {
        // Issue #494: `IsActive`, `Active`, `active` all fold to `isActive`. `active` is an exact
        // case-insensitive duplicate of `Active` — KOI1005 owns it regardless of where it sits in the
        // chain — so KOI1007 must NOT also fire on it. Only `Active` (genuinely distinct from `IsActive`)
        // gets KOI1007 → exactly one, not two. This pins order-independent suppression.
        const string src = """
            context Acct {
              value Account { balance: Int }
              spec IsActive on Account = balance > 0
              spec Active   on Account = balance > 1
              spec active   on Account = balance > 2
            }
            """;

        IReadOnlyList<Diagnostic> diagnostics = Diagnose(src);
        diagnostics.Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate).ShouldBe(1);
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpec);
    }

    [Fact]
    public void Exact_duplicate_name_on_different_targets_in_one_context_still_emits_KOI1007()
    {
        // Same exact name on two *different* targets is NOT a KOI1005 duplicate (KOI1005 groups by
        // target), yet both emit `isFreeOrder` into the one per-context predicate class — a real
        // collision KOI1007 owns. The suppression is gated on same-target, so it must still fire here.
        const string src = """
            context Promotions {
              value Order { discountedTotal: Int }
              value Cart  { total: Int }
              spec FreeOrder on Order = discountedTotal == 0
              spec FreeOrder on Cart  = total == 0
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate);
    }

    // ---------------------------------------------------------------------------------------------
    // Issue #495 — target-aware severity. A pair that collides only under the conservative all-targets
    // (PHP-strict) fold, but not under any *enabled* target's own identifier rule, is relaxed from a
    // hard error to a warning. Pairs that genuinely break an enabled target keep the error.
    // ---------------------------------------------------------------------------------------------

    private const string UnderscoreFoldPair = """
        context Promotions {
          value Order { discountedTotal: Int }
          spec FreeOrder  on Order = discountedTotal == 0
          spec free_order on Order = discountedTotal == 1
        }
        """;

    private const string IsStripPair = """
        context Acct {
          value Account { balance: Int }
          spec IsActive on Account = balance > 0
          spec Active   on Account = balance > 1
        }
        """;

    private static bool HasError(IReadOnlyList<Diagnostic> diags) =>
        diags.Any(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate && d.Severity == DiagnosticSeverity.Error);

    private static bool HasWarning(IReadOnlyList<Diagnostic> diags) =>
        diags.Any(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate && d.Severity == DiagnosticSeverity.Warning);

    [Fact]
    public void CSharp_only_relaxes_the_underscore_fold_collision_to_a_warning()
    {
        // `FreeOrder` + `free_order` collide only under PHP's underscore fold; C# emits `FreeOrder` and
        // `Free_order` (distinct), so a C#-only build must not be hard-blocked — downgraded to a warning.
        IReadOnlyList<Diagnostic> diags = Diagnose(UnderscoreFoldPair, EmitTargetSet.CSharp);
        HasError(diags).ShouldBeFalse();
        HasWarning(diags).ShouldBeTrue();
    }

    [Fact]
    public void CSharp_only_relaxes_the_is_strip_collision_to_a_warning()
    {
        // `IsActive` + `Active` collide in PHP/TS (both → `isActive`) but never in C# (`IsActive` vs
        // `Active`). A C#-only build is therefore valid — warn, don't error.
        IReadOnlyList<Diagnostic> diags = Diagnose(IsStripPair, EmitTargetSet.CSharp);
        HasError(diags).ShouldBeFalse();
        HasWarning(diags).ShouldBeTrue();
    }

    [Fact]
    public void Php_enabled_keeps_the_hard_error_on_both_axes()
    {
        // PHP folds case AND separators, so both pairs genuinely break a PHP build — still a hard error.
        HasError(Diagnose(UnderscoreFoldPair, EmitTargetSet.Php)).ShouldBeTrue();
        HasError(Diagnose(IsStripPair, EmitTargetSet.Php)).ShouldBeTrue();
    }

    [Fact]
    public void All_targets_default_keeps_the_hard_error_on_both_axes()
    {
        // The conservative default (every shipped predicate emitter) keeps today's strict error.
        HasError(Diagnose(UnderscoreFoldPair, EmitTargetSet.All)).ShouldBeTrue();
        HasError(Diagnose(IsStripPair, EmitTargetSet.All)).ShouldBeTrue();
    }

    [Fact]
    public void TypeScript_only_errors_on_the_is_strip_axis_but_warns_on_the_underscore_axis()
    {
        // TS strips a leading `Is` word (so `IsActive`+`Active` both emit `isActive` → real collision),
        // but keeps underscores (so `FreeOrder`+`free_order` emit `isFreeOrder`/`isFree_order` → distinct).
        HasError(Diagnose(IsStripPair, EmitTargetSet.TypeScript)).ShouldBeTrue();

        IReadOnlyList<Diagnostic> underscore = Diagnose(UnderscoreFoldPair, EmitTargetSet.TypeScript);
        HasError(underscore).ShouldBeFalse();
        HasWarning(underscore).ShouldBeTrue();
    }

    [Fact]
    public void Mixing_a_case_sensitive_target_with_php_still_hard_errors()
    {
        // The pair breaks PHP, and PHP is enabled — a mixed C#+PHP build keeps the error (PHP breaks).
        HasError(Diagnose(UnderscoreFoldPair, EmitTargetSet.CSharp | EmitTargetSet.Php)).ShouldBeTrue();
    }

    [Fact]
    public void CSharp_only_still_lets_KOI1005_own_the_exact_duplicate_without_KOI1007()
    {
        // The #494 contract holds regardless of target: an exact same-target duplicate (`Active`+`active`)
        // is KOI1005's, so KOI1007 stays silent at *every* severity — the relaxation must not resurrect it.
        const string src = """
            context Acct {
              value Account { balance: Int }
              spec Active on Account = balance > 0
              spec active on Account = balance > 1
            }
            """;

        IReadOnlyList<Diagnostic> diags = Diagnose(src, EmitTargetSet.CSharp);
        diags.Count(d => d.Code == DiagnosticCodes.DuplicateSpecPredicate).ShouldBe(0);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateSpec);
    }

    // ---------------------------------------------------------------------------------------------
    // Issue #539 — collisions that fold into *different* strict-key groups. The conservative strict
    // fold collapses underscores *before* stripping a leading `Is` word, so `IsIs_active` and
    // `Is_active` land in different strict groups (`isactive` vs `active`) and the single-strict-key
    // grouping never compared them — yet both emit the *same* TypeScript predicate `isIs_active` (TS
    // keeps underscores, then strips the leading `Is` word). Detection is now per emitted-target
    // keyspace, so this TypeScript collision is caught. PHP's own fold *is* the strict key, so for this
    // pair PHP emits distinct methods (`isIsActive` / `isActive`) — confirmed by emitting the pair — so
    // a PHP-only build sees only an advisory cross-target warning, never a false hard error.
    // ---------------------------------------------------------------------------------------------

    private const string CrossStrictGroupTsPair = """
        context Acct {
          value Account { balance: Int }
          spec IsIs_active on Account = balance > 0
          spec Is_active   on Account = balance > 1
        }
        """;

    [Fact]
    public void Cross_strict_group_TypeScript_collision_is_caught()
    {
        // `IsIs_active` and `Is_active` fold to *different* strict keys (`isactive` vs `active`), so the
        // historical single-strict-key grouping never compared them — yet TypeScript emits `isIs_active`
        // for BOTH (a duplicate function → TS compile error). Per-target detection catches it: a hard
        // error whenever TypeScript is enabled (explicitly, and via the all-targets default).
        HasError(Diagnose(CrossStrictGroupTsPair, EmitTargetSet.TypeScript)).ShouldBeTrue();
        HasError(Diagnose(CrossStrictGroupTsPair, EmitTargetSet.All)).ShouldBeTrue();

        // The no-target default is the conservative all-targets path, so it errors too.
        HasError(Diagnose(CrossStrictGroupTsPair)).ShouldBeTrue();
    }

    [Fact]
    public void Cross_strict_group_pair_is_only_a_warning_for_a_php_only_build()
    {
        // PHP's predicate fold *is* the strict key, so for this pair PHP emits distinct methods
        // (`isIsActive` / `isActive`) — it does NOT duplicate. A PHP-only build must therefore NOT be
        // hard-blocked; the TypeScript-only collision survives as an advisory warning (issue #495),
        // never a false error — pinning that the per-target keyspace does not over-report on a target
        // that genuinely emits distinct predicates.
        IReadOnlyList<Diagnostic> diags = Diagnose(CrossStrictGroupTsPair, EmitTargetSet.Php);
        HasError(diags).ShouldBeFalse();
        HasWarning(diags).ShouldBeTrue();
    }
}
