using Koine.Compiler.Ast;
using Koine.Compiler.Semantics.Scenarios;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The model-level scenario interpreter (#149, Approach B): given a compiled <see cref="SemanticModel"/>
/// and a <see cref="Scenario"/> (given state → when command(args) → then events/invariants), it evaluates
/// the aggregate command directly against a runtime state map — no code generation, no <c>Ast/</c> leakage.
/// This suite is the behavioural guard (the interpreter is off the emit path, so Verify/Roslyn are blind).
/// </summary>
public class ScenarioRunnerTests
{
    private const string OrderingModel = """
        context Ordering {
          enum OrderStatus { Draft, Placed, Shipped, Cancelled }

          aggregate Sales root Order {

            event OrderPlaced {
              orderId:   OrderId
              lineCount: Int
            }

            value OrderLine {
              product:  ProductId
              quantity: Int
            }

            entity Order identified by OrderId {
              lines:  List<OrderLine>
              status: OrderStatus = Draft

              invariant lines.all(l => l.quantity >= 1)   "every line needs a positive quantity"
              invariant status == Draft when lines.isEmpty

              states status {
                Draft  -> Placed, Cancelled
                Placed -> Shipped
              }

              command place {
                requires status == Draft   "only a draft order can be placed"
                requires !lines.isEmpty    "cannot place an empty order"
                status -> Placed
                emit OrderPlaced(orderId: id, lineCount: lines.count)
              }
            }
          }
        }
        """;

    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    private static ScenarioValue Line(int quantity) =>
        ScenarioValue.RecordOf(("product", ScenarioValue.FromString("P1")), ("quantity", ScenarioValue.FromInt(quantity)));

    // ----------------------------------------------------------------------
    // The headline: place a valid draft order → events + invariants.
    // ----------------------------------------------------------------------

    [Fact]
    public void Placing_a_valid_draft_order_emits_OrderPlaced_and_keeps_invariants()
    {
        var sema = Build(OrderingModel);
        var scenario = new Scenario(
            Target: "Order",
            Operation: "place",
            Given: new Dictionary<string, ScenarioValue>
            {
                ["status"] = ScenarioValue.Enum("Draft"),
                ["lines"] = ScenarioValue.ListOf(Line(2)),
            },
            Args: new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        result.Ok.ShouldBeTrue();

        // Both preconditions pass.
        var requires = result.Steps.OfType<ScenarioStep.Precondition>().ToList();
        requires.Count.ShouldBe(2);
        requires.ShouldAllBe(p => p.Outcome == CheckOutcome.Passed);

        // status transitions Draft -> Placed.
        var transition = result.Steps.OfType<ScenarioStep.Transition>().ShouldHaveSingleItem();
        transition.Field.ShouldBe("status");
        transition.To.ShouldBe("Placed");

        // OrderPlaced is emitted, lineCount reflects the single line.
        var emit = result.Steps.OfType<ScenarioStep.Emit>().ShouldHaveSingleItem();
        emit.EventName.ShouldBe("OrderPlaced");
        emit.Args["lineCount"].ShouldBe("1");

        // Resulting state and invariants.
        result.ResultingState["status"].ShouldBe("Placed");
        result.Invariants.Count.ShouldBe(2);
        result.Invariants.ShouldAllBe(i => i.Outcome == CheckOutcome.Passed);
    }

    [Fact]
    public void Placing_a_non_draft_order_fails_the_precondition_and_halts()
    {
        var sema = Build(OrderingModel);
        var scenario = new Scenario(
            "Order", "place",
            new Dictionary<string, ScenarioValue>
            {
                ["status"] = ScenarioValue.Enum("Placed"),
                ["lines"] = ScenarioValue.ListOf(Line(1)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        result.Ok.ShouldBeFalse();
        var first = result.Steps.OfType<ScenarioStep.Precondition>().First();
        first.Message.ShouldBe("only a draft order can be placed");
        first.Outcome.ShouldBe(CheckOutcome.Failed);

        // A failed precondition halts the command: no transition, no emit.
        result.Steps.OfType<ScenarioStep.Transition>().ShouldBeEmpty();
        result.Steps.OfType<ScenarioStep.Emit>().ShouldBeEmpty();
    }

    [Fact]
    public void Placing_an_empty_order_fails_the_not_empty_precondition()
    {
        var sema = Build(OrderingModel);
        var scenario = new Scenario(
            "Order", "place",
            new Dictionary<string, ScenarioValue>
            {
                ["status"] = ScenarioValue.Enum("Draft"),
                ["lines"] = ScenarioValue.ListOf(),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        result.Ok.ShouldBeFalse();
        var failed = result.Steps.OfType<ScenarioStep.Precondition>()
            .Single(p => p.Outcome == CheckOutcome.Failed);
        failed.Message.ShouldBe("cannot place an empty order");
    }

    [Fact]
    public void A_line_with_zero_quantity_reports_a_violated_invariant()
    {
        var sema = Build(OrderingModel);
        var scenario = new Scenario(
            "Order", "place",
            new Dictionary<string, ScenarioValue>
            {
                ["status"] = ScenarioValue.Enum("Draft"),
                ["lines"] = ScenarioValue.ListOf(Line(0)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        // The command still runs (preconditions are about emptiness/status, not quantity)…
        result.Ok.ShouldBeTrue();
        // …but the positive-quantity invariant is now violated.
        var violated = result.Invariants.Single(i => i.Message == "every line needs a positive quantity");
        violated.Outcome.ShouldBe(CheckOutcome.Failed);
    }

    [Fact]
    public void An_unknown_target_returns_a_not_ok_result_with_a_note()
    {
        var sema = Build(OrderingModel);
        var scenario = new Scenario(
            "Ghost", "place",
            new Dictionary<string, ScenarioValue>(),
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        result.Ok.ShouldBeFalse();
        result.Notes.ShouldNotBeEmpty();
    }
}
