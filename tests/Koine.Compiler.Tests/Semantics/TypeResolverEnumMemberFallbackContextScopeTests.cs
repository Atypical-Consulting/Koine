using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1792 — <c>TypeResolver.InferVisitor.VisitIdentifier</c>'s bare-enum-member fallback resolves
/// through the flat, last-write-wins <see cref="Koine.Compiler.Ast.ModelIndex.EnumMemberToType"/>
/// dictionary rather than the context-scoped <see cref="Koine.Compiler.Ast.ModelIndex.EnumsDeclaring(string?, string)"/>
/// overload #1739 added for every OTHER enum-ambiguity call site. A bare member passed as a call
/// argument with no sibling operand to hint against (e.g. <c>tags.contains(Red)</c>) reaches this
/// fallback directly, so it alone can still resolve against an unrelated, later-declared context's
/// enum purely by <c>.koi</c> source order.
/// </summary>
public class TypeResolverEnumMemberFallbackContextScopeTests
{
    private static IReadOnlyList<Diagnostic> Validate(string source)
    {
        var (model, syntax) = new KoineCompiler().Parse(source);
        syntax.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticValidator().Validate(model);
    }

    /// <summary>
    /// <c>Trailing</c> is declared LAST purely to control <c>EnumMemberToType</c>'s last-write-wins
    /// outcome pre-fix (<c>_enumMemberToType["Red"]</c> ends up <c>Trailing</c>, not <c>Flag</c>).
    /// <c>Red</c> is unambiguous from <c>C</c>'s own perspective: <c>Flag</c> is its only enum
    /// declaring that member, and neither <c>A</c> nor <c>Z</c> is imported.
    /// </summary>
    [Fact]
    public void Bare_enum_member_in_a_collection_contains_call_resolves_against_the_referencing_contexts_own_enum()
    {
        const string src =
            """
            context A {
              enum Status { Red }
            }

            context C {
              enum Flag { Red, Blue }
              entity Item identified by ItemId {
                tags: List<Flag>
                invariant tags.contains(Red)
              }
            }

            context Z {
              enum Trailing { Red }
            }
            """;

        Validate(src).ShouldNotContain(d => d.Code == DiagnosticCodes.OperationArgument);
    }

    /// <summary>
    /// Same three contexts, reordered so <c>C</c> is no longer the LAST declaration — under the flat,
    /// last-write-wins <c>EnumMemberToType</c> map this makes <c>A</c>'s <c>Status</c> win instead of
    /// <c>Trailing</c>, a different wrong answer than the primary fixture's, but still wrong pre-fix.
    /// The model must validate clean regardless of which context happens to be declared last.
    /// </summary>
    [Fact]
    public void Bare_enum_member_resolution_is_order_independent()
    {
        const string src =
            """
            context Z {
              enum Trailing { Red }
            }

            context C {
              enum Flag { Red, Blue }
              entity Item identified by ItemId {
                tags: List<Flag>
                invariant tags.contains(Red)
              }
            }

            context A {
              enum Status { Red }
            }
            """;

        Validate(src).ShouldNotContain(d => d.Code == DiagnosticCodes.OperationArgument);
    }
}
