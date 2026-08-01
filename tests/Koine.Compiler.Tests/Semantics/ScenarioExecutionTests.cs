using Koine.Compiler.Ast;
using Koine.Compiler.Semantics.Scenarios;
using Koine.Compiler.Services;
using Koine.Execution;

namespace Koine.Compiler.Tests;

/// <summary>
/// The executed scenario runner (#236, Approach A): instead of interpreting the semantic model, it
/// emits the model's C#, Roslyn-compiles it, and drives the REAL generated types reflectively — then
/// maps the outcome onto the very same <see cref="ScenarioResult"/> contract Approach B
/// (<see cref="ScenarioInterpreter"/>) returns, so one Studio timeline renders either mode.
///
/// <para>The fixture is the pizzeria <c>Ordering</c> template (<c>templates/pizzeria</c>), compiled in
/// directory mode so the shared-kernel <c>Currency</c> and the context map resolve. It exercises all four
/// gaps Approach B cannot close on its own: a derived value-object sum (<c>total</c>), a value object with
/// its own invariant (<c>Money.amount &gt;= 0</c>), a state machine with an illegal transition
/// (<c>cancel</c> from <c>Cancelled</c>), and a happy-path command whose timeline must stay
/// shape-compatible with the interpreter's.</para>
/// </summary>
public class ScenarioExecutionTests
{
    // ------------------------------------------------------------------------
    // Fixture: the pizzeria template, parsed once per test class.
    // ------------------------------------------------------------------------

    private static readonly Lazy<SemanticModel> Pizzeria = new(BuildPizzeria);

    private static SemanticModel BuildPizzeria()
    {
        var sources = Directory
            .EnumerateFiles(PizzeriaFolder(), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

        var (model, diagnostics) = new KoineCompiler().Parse(sources);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    /// <summary>Locates <c>templates/pizzeria</c> by walking up to the repo root (the folder holding
    /// <c>Koine.slnx</c>), never a hardcoded path or a CWD assumption.</summary>
    private static string PizzeriaFolder()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "templates", "pizzeria");
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) walking up from {AppContext.BaseDirectory}");
    }

    // ------------------------------------------------------------------------
    // Scenario builders.
    // ------------------------------------------------------------------------

    private static ScenarioValue Line(string pizza, int quantity, decimal unitAmount) =>
        ScenarioValue.RecordOf(
            ("pizza", ScenarioValue.FromString(pizza)),
            ("quantity", ScenarioValue.FromInt(quantity)),
            ("unitPrice", ScenarioValue.RecordOf(
                ("amount", ScenarioValue.FromDecimal(unitAmount)),
                ("currency", ScenarioValue.Enum("EUR")))));

    private static Scenario OrderScenario(string operation, string status, params ScenarioValue[] lines) =>
        new(
            Target: "Order",
            Operation: operation,
            Given: new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["customer"] = ScenarioValue.FromString("11111111-1111-1111-1111-111111111111"),
                ["fulfillment"] = ScenarioValue.Enum("Delivery"),
                ["lines"] = ScenarioValue.ListOf(lines),
                ["status"] = ScenarioValue.Enum(status),
            },
            Args: new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

    // ------------------------------------------------------------------------
    // Gap #1 — a derived value-object sum is COMPUTED, not indeterminate.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_derived_value_object_total_is_computed_where_the_interpreter_is_indeterminate()
    {
        SemanticModel sema = Pizzeria.Value;
        Scenario scenario = OrderScenario("place", "Draft", Line("MARG", 2, 10m), Line("PEPP", 1, 5m));

        // Approach B cannot evaluate `total = lines.sum(l => l.payable)`: `payable` is itself a derived
        // member of the OrderLine value object, so the interpreter degrades to an unknown value.
        ScenarioResult interpreted = ScenarioInterpreter.Run(sema, scenario);
        interpreted.ResultingState["total"].ShouldBe("?");

        // Approach A runs the emitted `Order.Total` property, so the real Money is computed:
        // 10 x 2 + 5 x 1 = 25 EUR (no 5+ discount applies on either line).
        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);
        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.ResultingState["total"].ShouldBe("{amount: 25, currency: EUR}");
        executed.ResultingState["lineCount"].ShouldBe("2");

        // Indeterminate disappears by construction in executed mode.
        executed.Steps.OfType<ScenarioStep.Precondition>()
            .ShouldAllBe(p => p.Outcome != CheckOutcome.Indeterminate);
        executed.Invariants.ShouldAllBe(i => i.Outcome != CheckOutcome.Indeterminate);
    }

    // ------------------------------------------------------------------------
    // Gap #2 — a value object's own invariant fires on the GIVEN state, and the
    // real DomainInvariantViolationException message is surfaced.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_negative_money_in_the_given_state_fails_the_value_objects_own_invariant()
    {
        SemanticModel sema = Pizzeria.Value;
        Scenario scenario = OrderScenario("place", "Draft", Line("MARG", 1, -5m));

        // Approach B never constructs a Money, so the negative amount goes unnoticed.
        ScenarioResult interpreted = ScenarioInterpreter.Run(sema, scenario);
        interpreted.Ok.ShouldBeTrue();

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();
        InvariantCheck failed = executed.Invariants.ShouldHaveSingleItem();
        failed.Outcome.ShouldBe(CheckOutcome.Failed);
        failed.Message.ShouldBe("an amount cannot be negative");
        // The check is resolved back to the DECLARED invariant on Money, so it carries the modelled
        // condition text — not merely the rule string the exception happened to carry.
        failed.Condition.ShouldContain("amount");
        failed.Condition.ShouldNotBe(failed.Message);
        executed.Notes.ShouldContain(n => n.Contains("an amount cannot be negative"));
    }

    // ------------------------------------------------------------------------
    // Gap #3 — the emitted state machine rejects an illegal transition.
    // ------------------------------------------------------------------------

    [Fact]
    public void An_illegal_state_transition_produces_a_failed_step()
    {
        SemanticModel sema = Pizzeria.Value;
        // `cancel` only guards against OutForDelivery/Completed, so its two `requires` both pass from
        // Cancelled — but `Cancelled` is a terminal state, so `status -> Cancelled` is illegal.
        Scenario scenario = OrderScenario("cancel", "Cancelled", Line("MARG", 1, 10m));

        // Approach B does not model the state machine: it happily applies the transition.
        ScenarioResult interpreted = ScenarioInterpreter.Run(sema, scenario);
        interpreted.Ok.ShouldBeTrue();
        interpreted.Steps.OfType<ScenarioStep.Transition>().ShouldNotBeEmpty();

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();
        var checks = executed.Steps.OfType<ScenarioStep.Precondition>().ToList();
        checks.Count.ShouldBe(3);
        checks[0].Outcome.ShouldBe(CheckOutcome.Passed);
        checks[1].Outcome.ShouldBe(CheckOutcome.Passed);
        checks[2].Outcome.ShouldBe(CheckOutcome.Failed);
        checks[2].Message.ShouldBe("illegal transition of status to Cancelled");
        checks[2].Condition.ShouldBe("status -> Cancelled");

        // The rejected transition never happened, so no transition/emit step is recorded.
        executed.Steps.OfType<ScenarioStep.Transition>().ShouldBeEmpty();
        executed.Steps.OfType<ScenarioStep.Emit>().ShouldBeEmpty();
        executed.Notes.ShouldContain(n => n.Contains("illegal transition of status to Cancelled"));
    }

    // ------------------------------------------------------------------------
    // Gap #4 — the happy-path timeline is shape-compatible with the interpreter's.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_happy_path_command_timeline_matches_the_interpreters_shape()
    {
        SemanticModel sema = Pizzeria.Value;
        Scenario scenario = OrderScenario("place", "Draft", Line("MARG", 2, 10m));

        ScenarioResult interpreted = ScenarioInterpreter.Run(sema, scenario);
        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.Ok.ShouldBe(interpreted.Ok);
        executed.Target.ShouldBe(interpreted.Target);
        executed.Operation.ShouldBe(interpreted.Operation);

        // Same steps, in the same order, of the same kinds.
        executed.Steps.Select(s => s.Kind).ShouldBe(interpreted.Steps.Select(s => s.Kind));

        // `requires` steps are identical field-for-field.
        executed.Steps.OfType<ScenarioStep.Precondition>()
            .Select(p => (p.Message, p.Condition, p.Outcome))
            .ShouldBe(interpreted.Steps.OfType<ScenarioStep.Precondition>()
                .Select(p => (p.Message, p.Condition, p.Outcome)));

        // Transitions agree on field, prior value and initialization flag. (`placedAt -> now` differs on
        // `To` by design: Approach B prints the unpinned marker `now`, Approach A the real clock stamp.)
        executed.Steps.OfType<ScenarioStep.Transition>()
            .Select(t => (t.Field, t.From, t.IsInitialization))
            .ShouldBe(interpreted.Steps.OfType<ScenarioStep.Transition>()
                .Select(t => (t.Field, t.From, t.IsInitialization)));
        executed.Steps.OfType<ScenarioStep.Transition>().First(t => t.Field == "status").To.ShouldBe("Placed");

        // The emitted event and its payload keys match; `lineCount` is the real computed count.
        ScenarioStep.Emit executedEmit = executed.Steps.OfType<ScenarioStep.Emit>().ShouldHaveSingleItem();
        ScenarioStep.Emit interpretedEmit = interpreted.Steps.OfType<ScenarioStep.Emit>().ShouldHaveSingleItem();
        executedEmit.EventName.ShouldBe(interpretedEmit.EventName);
        executedEmit.Args.Keys.ShouldBe(interpretedEmit.Args.Keys);
        executedEmit.Args["lineCount"].ShouldBe("1");

        // Invariants and resulting-state keys are identical.
        executed.Invariants.Select(i => (i.Message, i.Condition, i.Outcome))
            .ShouldBe(interpreted.Invariants.Select(i => (i.Message, i.Condition, i.Outcome)));
        executed.ResultingState.Keys.ShouldBe(interpreted.ResultingState.Keys);
        executed.ResultingState["status"].ShouldBe("Placed");
    }

    // ------------------------------------------------------------------------
    // The contract: Run NEVER throws — an undrivable scenario is a not-ok result
    // with an honest note.
    // ------------------------------------------------------------------------

    [Fact]
    public void An_unknown_target_returns_a_not_ok_result_with_a_note()
    {
        ScenarioResult executed = ScenarioExecutor.Run(
            Pizzeria.Value,
            new Scenario("Ghost", "place", new Dictionary<string, ScenarioValue>(), new Dictionary<string, ScenarioValue>()));

        executed.Ok.ShouldBeFalse();
        executed.Notes.ShouldNotBeEmpty();
        executed.Steps.ShouldBeEmpty();
    }

    [Fact]
    public void A_required_field_with_no_given_value_is_a_not_ok_result_with_a_note()
    {
        ScenarioResult executed = ScenarioExecutor.Run(
            Pizzeria.Value,
            new Scenario("Order", "place", new Dictionary<string, ScenarioValue>(), new Dictionary<string, ScenarioValue>()));

        executed.Ok.ShouldBeFalse();
        executed.Notes.ShouldContain(n => n.Contains("customer"));
    }
}
