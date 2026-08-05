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

    // A command whose precondition matches a field against a catastrophic-backtracking pattern.
    // `(x+)+y` over a long run of x's with no trailing y forces the .NET backtracking engine down an
    // exponential number of partitions — the regex never completes without a match timeout (#626).
    private const string MatchModel = """
        context Reg {
          aggregate Docs root Document {
            entity Document identified by DocId {
              body: String

              command check {
                requires body matches /(x+)+y/   "body must look like x's then a y"
              }
            }
          }
        }
        """;

    // A `requires` clause (not just an `invariant`) driven by a lambda-taking collection op
    // (#1071/#1082): the interpreter must evaluate every lambda-taking collection op usable in a
    // `requires` clause to a real Passed/Failed outcome, not silently degrade to Indeterminate.
    // One command per operator, all sharing the same Order/Line fixture shape.
    private const string RepricingModel = """
        context Pricing {
          value Line {
            qty: Int
          }

          entity Order identified by OrderId {
            lines: List<Line>

            command reprice {
              requires lines.all(l => l.qty > 0) "every line needs a positive quantity"
            }

            command flagHighValue {
              requires lines.any(l => l.qty > 5) "at least one line must exceed the high-value threshold"
            }

            command auditSafetyCap {
              requires lines.none(l => l.qty > 100) "no line may exceed the safety cap"
            }

            command checkBudget {
              requires lines.sum(l => l.qty) <= 10 "total quantity must not exceed the budget"
            }

            command checkMinimum {
              requires lines.min(l => l.qty) >= 1 "the smallest line must be at least 1"
            }

            command checkCeiling {
              requires lines.max(l => l.qty) <= 10 "the largest line must not exceed the ceiling"
            }

            command checkUniqueQuantities {
              requires lines.distinctBy(l => l.qty) "no two lines may share the same quantity"
            }
          }
        }
        """;

    // A `requires` clause over a field with no given value: the interpreter cannot evaluate
    // it (an `Unknown` operand), so the precondition reports Indeterminate — and, per #1071,
    // that must gate the scenario closed the same way a Failed precondition does.
    private const string GateModel = """
        context Gate {
          entity Widget identified by WidgetId {
            qty: Int

            command check {
              requires qty > 0 "qty must be positive"
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

    /// <summary>Like <see cref="Build"/>, but also returns the file→source lookup a source-backed
    /// condition rendering needs (#1752) — most tests don't care how a condition renders and stay on
    /// <see cref="Build"/>; this is for the ones that assert the exact rendered text.</summary>
    private static (SemanticModel Sema, IReadOnlyDictionary<string, string> Sources) BuildSourced(
        string src, string file = "scenario.koi")
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src, file);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return (new SemanticModel(model), new Dictionary<string, string>(StringComparer.Ordinal) { [file] = src });
    }

    // A `requires` clause and an `invariant`, both built from a binary operator — the shape that
    // exposed #1752: `KoineNode.ToFullString()` walks NODES only, so `amount >= 0` came back as
    // `" amount 0"` with the operator and a space silently dropped.
    private const string MoneyGuardModel = """
        context Billing {
          entity Account identified by AccountId {
            amount: Decimal
            count:  Int

            invariant amount >= 0 "amount must not be negative"

            command touch {
              requires count >= 0 "count must not be negative"
            }
          }
        }
        """;

    private static ScenarioValue Line(int quantity) =>
        ScenarioValue.RecordOf(("product", ScenarioValue.FromString("P1")), ("quantity", ScenarioValue.FromInt(quantity)));

    private static ScenarioValue QtyLine(int qty) =>
        ScenarioValue.RecordOf(("qty", ScenarioValue.FromInt(qty)));

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

    // ----------------------------------------------------------------------
    // A model-authored regex with catastrophic backtracking must not hang the
    // interpreter (which runs synchronously inside the LSP / single-threaded WASM
    // host). It is bounded by a match timeout and degrades to an indeterminate
    // outcome instead of wedging the run forever (#626).
    // ----------------------------------------------------------------------

    [Fact]
    public async Task A_catastrophic_backtracking_matches_pattern_is_bounded_not_hung()
    {
        var sema = Build(MatchModel);
        var scenario = new Scenario(
            "Document", "check",
            new Dictionary<string, ScenarioValue>
            {
                // 64 'x's and no trailing 'y': `(x+)+y` backtracks exponentially over this non-match.
                ["body"] = ScenarioValue.FromString(new string('x', 64)),
            },
            new Dictionary<string, ScenarioValue>());

        // Run off-thread and race it against a generous wall-clock budget so a genuine hang fails this
        // assertion fast rather than wedging the whole test run (the pre-fix behaviour). The 1s match
        // timeout means a bounded run completes in ~1s, comfortably inside the budget.
        var run = Task.Run(() => ScenarioInterpreter.Run(sema, scenario));
        await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken));
        run.IsCompleted.ShouldBeTrue(
            "a catastrophic-backtracking `matches` pattern must be bounded by a match timeout, not hang the interpreter");

        // The runaway match degrades to an indeterminate precondition (Unknown), not a crash or a hang.
        ScenarioResult result = await run;
        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Indeterminate);
    }

    // ----------------------------------------------------------------------
    // #1071: a `requires` clause built from a lambda-taking collection op must evaluate
    // to a real Passed/Failed outcome, and an Indeterminate outcome must gate the scenario
    // closed (like Failed) rather than silently letting it proceed.
    // ----------------------------------------------------------------------

    [Fact]
    public void Requires_lambda_all_predicate_passes_when_every_line_has_a_positive_quantity()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "reprice",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(3)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_all_predicate_fails_when_a_line_has_a_non_positive_quantity()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "reprice",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(0)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    [Fact]
    public void An_indeterminate_requires_outcome_blocks_the_scenario_like_a_failed_one()
    {
        var sema = Build(GateModel);
        var scenario = new Scenario(
            "Widget", "check",
            new Dictionary<string, ScenarioValue>(), // no 'qty' given -> Unknown -> Indeterminate
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Indeterminate);
        result.Ok.ShouldBeFalse(
            "an indeterminate requires outcome must fail the scenario closed, not silently pass it open");
    }

    // ----------------------------------------------------------------------
    // #1082: the other six lambda-taking collection ops usable in a `requires` clause
    // (any/none/sum/min/max/distinctBy) get the same interpreter-level coverage #1071 gave
    // `.all` — each must evaluate to a real Passed/Failed outcome, never Indeterminate.
    // ----------------------------------------------------------------------

    [Fact]
    public void Requires_lambda_any_predicate_passes_when_a_line_exceeds_the_threshold()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "flagHighValue",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(6)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_any_predicate_fails_when_no_line_exceeds_the_threshold()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "flagHighValue",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(1), QtyLine(2)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    [Fact]
    public void Requires_lambda_none_predicate_passes_when_no_line_exceeds_the_safety_cap()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "auditSafetyCap",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(3)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_none_predicate_fails_when_a_line_exceeds_the_safety_cap()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "auditSafetyCap",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(101)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    [Fact]
    public void Requires_lambda_sum_selector_passes_when_the_total_is_within_budget()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkBudget",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(3)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_sum_selector_fails_when_the_total_exceeds_the_budget()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkBudget",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(6), QtyLine(7)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    [Fact]
    public void Requires_lambda_min_selector_passes_when_the_smallest_line_meets_the_floor()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkMinimum",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(1), QtyLine(4)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_min_selector_fails_when_the_smallest_line_is_below_the_floor()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkMinimum",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(0), QtyLine(4)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    [Fact]
    public void Requires_lambda_max_selector_passes_when_the_largest_line_is_within_the_ceiling()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkCeiling",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(3), QtyLine(9)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_max_selector_fails_when_the_largest_line_exceeds_the_ceiling()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkCeiling",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(3), QtyLine(11)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    [Fact]
    public void Requires_lambda_distinctBy_selector_passes_when_every_quantity_is_unique()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkUniqueQuantities",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(3)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Passed);
        result.Ok.ShouldBeTrue();
    }

    [Fact]
    public void Requires_lambda_distinctBy_selector_fails_when_two_lines_share_a_quantity()
    {
        var sema = Build(RepricingModel);
        var scenario = new Scenario(
            "Order", "checkUniqueQuantities",
            new Dictionary<string, ScenarioValue>
            {
                ["lines"] = ScenarioValue.ListOf(QtyLine(2), QtyLine(2)),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario);

        var precondition = result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        precondition.Outcome.ShouldBe(CheckOutcome.Failed);
        result.Ok.ShouldBeFalse();
    }

    // ------------------------------------------------------------------------
    // #1752: requires/invariant conditions render with their operators intact.
    // ------------------------------------------------------------------------

    [Fact]
    public void Requires_and_invariant_conditions_render_with_their_operators_intact()
    {
        var (sema, sources) = BuildSourced(MoneyGuardModel);
        var scenario = new Scenario(
            "Account", "touch",
            new Dictionary<string, ScenarioValue>
            {
                ["amount"] = ScenarioValue.FromDecimal(5m),
                ["count"] = ScenarioValue.FromInt(3),
            },
            new Dictionary<string, ScenarioValue>());

        var result = ScenarioInterpreter.Run(sema, scenario, sources);

        result.Ok.ShouldBeTrue();
        result.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem().Condition.ShouldBe("count >= 0");
        result.Invariants.ShouldHaveSingleItem().Condition.ShouldBe("amount >= 0");
    }
}
