using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// A cyclic derived-member chain must be rejected in Semantics/ (KOI0110): every emitter would
/// otherwise emit mutually-recursive get-only accessors that StackOverflow at runtime, from a model
/// the compiler accepted green.
/// </summary>
public class DerivedMemberCycleTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void A_two_member_derived_cycle_is_reported_on_both_members()
    {
        const string src = """
            context Shop {
              value Loop {
                a: Int = b + 1
                b: Int = a + 1
                invariant a > 0   "a stays positive"
              }
            }
            """;

        var cycles = Diagnose(src).Where(d => d.Code == DiagnosticCodes.DerivedMemberCycle).ToList();
        cycles.Count.ShouldBe(2);
    }

    [Fact]
    public void A_two_member_derived_cycle_without_an_invariant_is_still_reported()
    {
        const string src = """
            context Shop {
              value Loop {
                a: Int = b + 1
                b: Int = a + 1
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DerivedMemberCycle);
    }

    [Fact]
    public void A_three_member_derived_cycle_is_reported_on_all_three()
    {
        const string src = """
            context Shop {
              value Ring {
                a: Int = b + 1
                b: Int = c + 1
                c: Int = a + 1
              }
            }
            """;

        Diagnose(src).Count(d => d.Code == DiagnosticCodes.DerivedMemberCycle).ShouldBe(3);
    }

    // A self-reference is NOT derived: MemberAnalysis.IsDerived skips the member's own name, so
    // 'a = a + 1' is a constant DEFAULT (a constructor-parameter default), never a recursive
    // accessor. Behaviour-preservation lock: KOI0110 must not fire on it.
    [Fact]
    public void A_self_referencing_member_is_not_reported_as_a_cycle()
    {
        const string src = """
            context Shop {
              value SelfRef {
                a: Int = a + 1
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DerivedMemberCycle);
    }

    [Fact]
    public void An_acyclic_diamond_of_derived_members_is_accepted()
    {
        const string src = """
            context Shop {
              value Diamond {
                d: Int
                b: Int = d + 1
                c: Int = d + 2
                a: Int = b + c
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DerivedMemberCycle);
    }

    [Fact]
    public void A_derived_cycle_inside_an_entity_is_reported_too()
    {
        const string src = """
            context Shop {
              entity Widget identified by WidgetId {
                a: Int = b + 1
                b: Int = a + 1
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DerivedMemberCycle);
    }
}
