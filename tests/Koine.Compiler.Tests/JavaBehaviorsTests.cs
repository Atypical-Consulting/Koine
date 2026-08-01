using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The behaviors / state-machine slice of the Java backend (issue #1090, Phase 2 Task 3). Phase 1
/// (PR #1069) already emitted a Koine <c>command</c> as an invariant-guarded mutating method, but it
/// ignored the entity's <c>states</c> block entirely — so a transition the state machine forbids was
/// emitted as an unguarded assignment, silently losing the lifecycle rule the model declares. This suite
/// locks the <b>reachability guard</b> the other backends emit (the C# <c>WriteStateMachineGuard</c> and
/// its Python port): before assigning a literal target state, the current state must be one of the
/// declared legal sources, else <c>DomainException</c>.
/// </summary>
public class JavaBehaviorsTests
{
    /// <summary>
    /// An order lifecycle with several sources for one target (<c>Cancelled</c>), a guarded rule, and a
    /// command whose precondition already restates its transition's only legal source.
    /// </summary>
    internal const string Fixture = """
        context Sales {
          /// The lifecycle state of an order; the `states` machine below fixes the legal transitions.
          enum OrderStatus { Draft, Placed, InKitchen, Completed, Cancelled }

          aggregate Ordering root Order {
            entity Order identified by OrderId {
              status:  OrderStatus = Draft
              paid:    Bool        = false

              states status {
                Draft     -> Placed, Cancelled
                Placed    -> InKitchen, Cancelled
                InKitchen -> Completed when paid
                Completed
                Cancelled
              }

              /// Places a draft order. The precondition already states the only legal source.
              command place {
                requires status == Draft "only a draft order can be placed"
                status -> Placed
              }

              /// Cancels an order — legal from two different source states.
              command cancel {
                status -> Cancelled
              }

              /// Completes an order — legal only from InKitchen, and only when paid.
              command complete {
                status -> Completed
              }
            }
          }
        }
        """;

    /// <summary>
    /// A transition whose target is reachable from several source states guards on the De Morgan
    /// negation — "the current state is none of the legal sources" — so the emitted Java rejects an
    /// illegal lifecycle move at runtime instead of performing it.
    /// </summary>
    [Fact]
    public void Transition_with_several_legal_sources_guards_on_all_of_them()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal)).Contents;

        order.ShouldContain(
            "if (!java.util.Objects.equals(this.status, OrderStatus.Draft) "
            + "&& !java.util.Objects.equals(this.status, OrderStatus.Placed)) {");
        order.ShouldContain(
            "throw new koine.runtime.DomainException(\"illegal transition of status to Cancelled\");");
    }

    /// <summary>
    /// A per-rule <c>when</c> guard is part of the reachability test: reaching <c>Completed</c> requires
    /// being <c>InKitchen</c> <em>and</em> the guard holding, so the negation wraps the whole conjunction.
    /// </summary>
    [Fact]
    public void Guarded_state_rule_folds_its_guard_into_the_reachability_test()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal)).Contents;

        order.ShouldContain(
            "if (!(java.util.Objects.equals(this.status, OrderStatus.InKitchen) && (this.paid))) {");
        order.ShouldContain(
            "throw new koine.runtime.DomainException(\"illegal transition of status to Completed\");");
    }

    /// <summary>
    /// A single-source guard that would merely restate a <c>requires</c> precondition is suppressed —
    /// the same redundancy suppression the C#/Python emitters apply — so <c>place()</c> keeps only its
    /// own, better-worded precondition rather than throwing two near-identical guards.
    /// </summary>
    [Fact]
    public void Reachability_guard_that_restates_a_precondition_is_suppressed()
    {
        var result = new KoineCompiler().Compile(Fixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal)).Contents;

        order.ShouldContain("throw new koine.runtime.DomainException(\"only a draft order can be placed\");");
        order.ShouldNotContain("illegal transition of status to Placed");
    }

    /// <summary>
    /// A model with no <c>states</c> block must be unaffected: the transition stays a bare assignment, so
    /// Phase 1's emitted behaviors do not churn.
    /// </summary>
    [Fact]
    public void Entity_without_a_state_machine_emits_an_unguarded_transition()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }

              entity Order identified by OrderId {
                status: OrderStatus = Draft

                command place {
                  status -> Placed
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("Order.java", StringComparison.Ordinal)).Contents;

        order.ShouldContain("this.status = OrderStatus.Placed;");
        order.ShouldNotContain("illegal transition");
    }
}
