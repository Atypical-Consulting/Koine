using System.Diagnostics;
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

    private static readonly Lazy<SemanticModel> Pizzeria = new(() => BuildTemplate("pizzeria"));

    private static SemanticModel BuildTemplate(string template)
    {
        var sources = Directory
            .EnumerateFiles(TemplateFolder(template), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

        var (model, diagnostics) = new KoineCompiler().Parse(sources);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    /// <summary>Compiles an inline model, for a shape no shipped template carries.</summary>
    private static SemanticModel Build(string source)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(source);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    /// <summary>Locates a folder under <c>templates/</c> by walking up to the repo root (the folder
    /// holding <c>Koine.slnx</c>), never a hardcoded path or a CWD assumption.</summary>
    private static string TemplateFolder(string template)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "templates", template);
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

        // Both recorded events — the `emit`ted domain event and the `publish`ed integration event (#1796)
        // — and their payload keys match, in order; `lineCount` is the real computed count.
        List<ScenarioStep.Emit> executedEmits = executed.Steps.OfType<ScenarioStep.Emit>().ToList();
        List<ScenarioStep.Emit> interpretedEmits = interpreted.Steps.OfType<ScenarioStep.Emit>().ToList();
        executedEmits.Select(e => e.EventName).ShouldBe(interpretedEmits.Select(e => e.EventName));
        executedEmits.Select(e => e.Args.Keys).ShouldBe(interpretedEmits.Select(e => e.Args.Keys));
        executedEmits[0].EventName.ShouldBe("OrderPlacedInternally");
        executedEmits[0].Args["lineCount"].ShouldBe("1");
        executedEmits[1].EventName.ShouldBe("OrderPlaced");

        // …including WHICH of the two verbs recorded each: both engines must agree that the second one
        // crossed the context boundary and the first did not, or one Studio timeline would read the same
        // model two different ways depending on which engine answered.
        executedEmits.Select(e => e.Published).ShouldBe(interpretedEmits.Select(e => e.Published));
        executedEmits.Select(e => e.Published).ShouldBe(new[] { false, true });

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

    // ------------------------------------------------------------------------
    // Rule matching: the runner must compare the emitter's OWN rendering of a
    // rule, not a tree walk that drops the operator tokens (#1752).
    // ------------------------------------------------------------------------

    /// <summary>A guard with NO message: the emitter synthesizes the rule from the condition's source
    /// text, which is the only rendering the thrown exception ever carries. Every `requires` in every
    /// shipped template carries a message, which is exactly why this went unnoticed.</summary>
    private const string UnmessagedGuardModel = """
        context Guarding {
          enum OrderStatus { Draft, Placed }

          entity Order identified by OrderId {
            status: OrderStatus = Draft

            invariant status != Placed when status == Draft

            command place {
              requires status == Draft
              status -> Placed
            }
          }
        }
        """;

    [Fact]
    public void An_unmessaged_failing_requires_is_reported_as_a_failed_precondition()
    {
        SemanticModel sema = Build(UnmessagedGuardModel);
        var scenario = new Scenario(
            "Order",
            "place",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal) { ["status"] = ScenarioValue.Enum("Placed") },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();

        // The guard REALLY threw, so it must render as the failed precondition it is — not fall through
        // to a green "Passed" step because the runner rendered the rule differently from the emitter.
        ScenarioStep.Precondition guard = executed.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        guard.Outcome.ShouldBe(CheckOutcome.Failed);
        guard.Message.ShouldBeNull();
        executed.Notes.ShouldContain(n => n.Contains("was rejected by a precondition"));

        // The rejected write never happened, so no transition may be claimed.
        executed.Steps.OfType<ScenarioStep.Transition>().ShouldBeEmpty();
        executed.ResultingState["status"].ShouldBe("Placed");

        // Nothing mutated, so the constructed state's invariants still hold — and no note may claim the
        // rule matched nothing.
        executed.Invariants.ShouldAllBe(i => i.Outcome == CheckOutcome.Passed);
        executed.Notes.ShouldNotContain(n => n.Contains("matches no declared precondition"));
    }

    /// <summary>An unmessaged INVARIANT: the post-command sweep's rule is likewise the synthesized
    /// source text, so the failed invariant must resolve back to its declaration.</summary>
    private const string UnmessagedInvariantModel = """
        context Sweeping {
          entity Counter identified by CounterId {
            value: Int = 0
            step:  Int = 1

            invariant value <= 10

            command bump {
              value -> value + step
            }
          }
        }
        """;

    [Fact]
    public void An_unmessaged_failing_invariant_resolves_back_to_its_declaration()
    {
        SemanticModel sema = Build(UnmessagedInvariantModel);
        var scenario = new Scenario(
            "Counter",
            "bump",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["value"] = ScenarioValue.FromInt(10),
                ["step"] = ScenarioValue.FromInt(5),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();
        InvariantCheck failed = executed.Invariants.ShouldHaveSingleItem();
        failed.Outcome.ShouldBe(CheckOutcome.Failed);
        failed.Message.ShouldBeNull();
        executed.Notes.ShouldNotContain(n => n.Contains("matches no declared precondition"));
    }

    // ------------------------------------------------------------------------
    // Statement ORDER: the emitter hoists every `requires` before any write, so
    // a guard that failed cannot have been preceded by a transition.
    // ------------------------------------------------------------------------

    /// <summary>The grammar permits `commandStmt*` in any order, so a `requires` may be written AFTER a
    /// transition — while the emitter always checks it first.</summary>
    private const string LateRequiresModel = """
        context Checkout {
          enum BasketStatus { Open, CheckedOut }

          entity Basket identified by BasketId {
            itemCount: Int = 0
            status:    BasketStatus = Open

            invariant itemCount >= 0   "a basket cannot hold a negative number of items"

            command checkout {
              status -> CheckedOut
              requires itemCount > 0   "a basket needs at least one item"
            }
          }
        }
        """;

    [Fact]
    public void A_requires_written_after_a_transition_is_still_checked_first()
    {
        SemanticModel sema = Build(LateRequiresModel);
        var scenario = new Scenario(
            "Basket",
            "checkout",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["itemCount"] = ScenarioValue.FromInt(0),
                ["status"] = ScenarioValue.Enum("Open"),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();

        ScenarioStep.Precondition guard = executed.Steps.OfType<ScenarioStep.Precondition>().ShouldHaveSingleItem();
        guard.Outcome.ShouldBe(CheckOutcome.Failed);
        guard.Message.ShouldBe("a basket needs at least one item");

        // The emitted guard threw BEFORE the write, so there is no transition to report …
        executed.Steps.OfType<ScenarioStep.Transition>().ShouldBeEmpty();
        executed.ResultingState["status"].ShouldBe("Open");

        // … and therefore no "halted after a field write" excuse for dropping the invariant outcomes.
        executed.Notes.ShouldNotContain(n => n.Contains("halted after a field write"));
        executed.Invariants.ShouldAllBe(i => i.Outcome == CheckOutcome.Passed);
    }

    // ------------------------------------------------------------------------
    // A `Set<T>` member/parameter really binds (Koine `Set<T>` -> IReadOnlySet<T>,
    // which a List<T> does not satisfy).
    // ------------------------------------------------------------------------

    /// <summary>The shape of <c>templates/starters/values</c>' <c>Product.tags: Set&lt;String&gt;</c> and of
    /// <c>templates/saas-subscription</c>' <c>EntitlementGrant.features: Set&lt;Feature&gt;</c> (a member AND a
    /// command parameter) — inline because neither template is drivable end to end: the <c>values</c>
    /// <c>Product</c> declares no command, and <c>saas-subscription</c>'s emitted C# does not currently
    /// compile (a pre-existing emitter bug on <c>UsageMeter</c>'s derived-member invariant).</summary>
    private const string SetValuedModel = """
        context Access {
          enum Feature { Sso, ApiAccess, AuditLog }

          entity Grant identified by GrantId {
            features: Set<Feature>
            tags:     Set<String>
            active:   Bool = false

            command activate(extra: Set<Feature>) {
              features -> extra
              active   -> true
            }
          }
        }
        """;

    [Fact]
    public void A_set_valued_member_and_parameter_bind_through_the_emitted_read_only_set()
    {
        SemanticModel sema = Build(SetValuedModel);
        var scenario = new Scenario(
            "Grant",
            "activate",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["features"] = ScenarioValue.ListOf(ScenarioValue.Enum("Sso")),
                ["tags"] = ScenarioValue.ListOf(ScenarioValue.FromString("beta")),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["extra"] = ScenarioValue.ListOf(ScenarioValue.Enum("Sso"), ScenarioValue.Enum("AuditLog")),
            });

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.ResultingState["tags"].ShouldBe("[beta]");
        executed.ResultingState["features"].ShouldContain("Sso");
        executed.ResultingState["features"].ShouldContain("AuditLog");
        executed.ResultingState["active"].ShouldBe("true");
    }

    // ------------------------------------------------------------------------
    // A violation raised DURING the operation by a value object is resolved back
    // to its declaration, exactly as the same violation in the given state is.
    // ------------------------------------------------------------------------

    private const string LedgerModel = """
        context Ledger {
          value Money {
            amount: Decimal
            invariant amount >= 0   "an amount cannot be negative"
          }

          entity Account identified by AccountId {
            balance: Money
            fee:     Money

            command settle {
              balance -> balance - fee
            }
          }
        }
        """;

    [Fact]
    public void A_value_object_violation_raised_during_the_operation_is_reported_as_a_failed_invariant()
    {
        SemanticModel sema = Build(LedgerModel);
        var scenario = new Scenario(
            "Account",
            "settle",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["balance"] = ScenarioValue.RecordOf(("amount", ScenarioValue.FromDecimal(5m))),
                ["fee"] = ScenarioValue.RecordOf(("amount", ScenarioValue.FromDecimal(8m))),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();

        // Same domain rule, same rendering as when the very same negative Money arrives in `given`.
        InvariantCheck failed = executed.Invariants.ShouldHaveSingleItem();
        failed.Outcome.ShouldBe(CheckOutcome.Failed);
        failed.Message.ShouldBe("an amount cannot be negative");
        failed.Condition.ShouldContain("amount");
        executed.Notes.ShouldContain(n => n.Contains("an amount cannot be negative"));
    }

    /// <summary>Two contexts declaring a same-named value object, whose invariants share a MESSAGE but
    /// guard different fields — the pizzeria's own shape (Ordering's <c>Money</c> and Payment's are
    /// distinct declarations), pushed to the point where resolving the wrong one is visible.</summary>
    private const string TwoMoniesModel = """
        context Ordering {
          value Money {
            amount: Decimal
            invariant amount >= 0   "an amount cannot be negative"
          }

          entity Order identified by OrderId {
            total: Money
          }
        }

        context Billing {
          value Money {
            balance: Decimal
            invariant balance >= 0   "an amount cannot be negative"
          }

          entity Receipt identified by ReceiptId {
            captured: Money
            settled:  Bool = false

            command settle {
              settled -> true
            }
          }
        }
        """;

    [Fact]
    public void A_value_object_violation_resolves_to_the_declaration_in_the_entitys_own_context()
    {
        SemanticModel sema = Build(TwoMoniesModel);
        var scenario = new Scenario(
            "Receipt",
            "settle",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["captured"] = ScenarioValue.RecordOf(("balance", ScenarioValue.FromDecimal(-1m))),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeFalse();
        InvariantCheck failed = executed.Invariants.ShouldHaveSingleItem();
        failed.Message.ShouldBe("an amount cannot be negative");

        // Billing's Money guards `balance`; Ordering's guards `amount`. A flat by-name walk over the model
        // would hand back Ordering's declaration purely because it comes first.
        failed.Condition.ShouldContain("balance");
        failed.Condition.ShouldNotContain("amount");
    }

    // ------------------------------------------------------------------------
    // Rendering: a type the model does not declare (the emitted Range<T>) is shown
    // by its properties, never as a raw CLR type name.
    // ------------------------------------------------------------------------

    private const string SalePeriodModel = """
        context Catalog {
          value SalePeriod {
            window: Range<Instant>
          }

          entity Campaign identified by CampaignId {
            period: SalePeriod
            live:   Bool = false

            command launch {
              live -> true
            }
          }
        }
        """;

    [Fact]
    public void A_range_valued_member_renders_its_bounds_not_its_clr_type_name()
    {
        SemanticModel sema = Build(SalePeriodModel);
        var scenario = new Scenario(
            "Campaign",
            "launch",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["period"] = ScenarioValue.RecordOf(
                    ("window", ScenarioValue.RecordOf(
                        ("start", ScenarioValue.FromString("2026-01-01T00:00:00.0000000+00:00")),
                        ("end", ScenarioValue.FromString("2026-12-31T00:00:00.0000000+00:00"))))),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.ResultingState["period"].ShouldBe(
            "{window: {Start: 2026-01-01T00:00:00.0000000+00:00, End: 2026-12-31T00:00:00.0000000+00:00}}");
    }

    /// <summary>The other composite with no Koine declaration behind it: a <c>Map</c>'s
    /// <c>KeyValuePair</c>, whose framework <c>ToString()</c> formats a decimal in the CURRENT culture —
    /// the one culture leak left in <c>Display</c>.</summary>
    [Fact]
    public void A_key_value_pair_renders_its_parts_rather_than_a_culture_sensitive_ToString()
    {
        var binder = new ScenarioValueBinder(Pizzeria.Value.Index);

        binder.Display(new KeyValuePair<string, decimal>("EUR", 12.5m)).ShouldBe("{Key: EUR, Value: 12.5}");
    }

    // ------------------------------------------------------------------------
    // Scalar wrappers: a single-field value object binds from every scalar kind,
    // not only from Num/Text.
    // ------------------------------------------------------------------------

    private const string WrapperModel = """
        context Review {
          enum Verdict { Accept, Reject }

          value Approved {
            flag: Bool
          }

          value Ruling {
            verdict: Verdict
          }

          value Stamped {
            at: Instant
          }

          entity Submission identified by SubmissionId {
            decided: Bool = false

            command decide(approved: Approved, ruling: Ruling, stamped: Stamped): Approved {
              requires !decided   "a submission is decided once"
              decided -> true
              result approved
            }
          }
        }
        """;

    [Fact]
    public void A_single_field_wrapper_binds_from_a_bool_an_enum_member_and_an_instant()
    {
        SemanticModel sema = Build(WrapperModel);
        var scenario = new Scenario(
            "Submission",
            "decide",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal) { ["decided"] = ScenarioValue.FromBool(false) },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["approved"] = ScenarioValue.FromBool(true),
                ["ruling"] = ScenarioValue.Enum("Accept"),
                ["stamped"] = new ScenarioValue.Instant(),
            });

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.Result.ShouldBe("{flag: true}");
    }

    // ------------------------------------------------------------------------
    // Fan-out resolution (#1758): an emitted event mapped onto the downstream
    // targets the MODEL declares — the executable policy reactions, and the
    // merely-declared cross-context subscriptions. Pure model reading; no
    // emission, no execution (that is the dispatcher's job).
    // ------------------------------------------------------------------------

    [Fact]
    public void A_policy_reaction_resolves_to_the_target_aggregates_root_entity_and_its_command()
    {
        SemanticModel sema = Pizzeria.Value;

        FanOutResolution fanOut = new ScenarioFanOutResolver(sema).Resolve("Payment", "ChargeCaptured");

        // `policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)`
        FanOutTarget target = fanOut.Executable.ShouldHaveSingleItem();
        target.PolicyName.ShouldBe("PostToLedger");
        target.Context.ShouldBe("Payment");
        // The reaction names the AGGREGATE (`Books`); the executable member lives on its root entity.
        target.AggregateName.ShouldBe("Books");
        target.EntityName.ShouldBe("LedgerEntry");
        target.MemberName.ShouldBe("record");
        target.IsFactory.ShouldBeFalse();
        target.Args.ShouldHaveSingleItem().Parameter.ShouldBe("amount");

        // A domain event crosses no context boundary, so nothing is merely declared.
        fanOut.DeclaredOnly.ShouldBeEmpty();
    }

    [Fact]
    public void A_published_integration_event_resolves_to_its_subscribers_and_to_no_executable_target()
    {
        SemanticModel sema = Pizzeria.Value;

        FanOutResolution fanOut = new ScenarioFanOutResolver(sema).Resolve("Ordering", "OrderPlaced");

        // `Ordering` publishes `OrderPlaced`; Kitchen, Delivery and Payment each subscribe to it. No
        // policy reacts to it, and the C# emitter gives a subscriber only an `IHandle<OrderPlaced>`
        // seam with no body — so there is nothing executable downstream, only a declaration.
        fanOut.Executable.ShouldBeEmpty();
        fanOut.DeclaredOnly.Select(s => s.Context).ShouldBe(new[] { "Delivery", "Kitchen", "Payment" });
        fanOut.DeclaredOnly.ShouldAllBe(s => s.EventName == "OrderPlaced");
    }

    /// <summary>
    /// A policy whose reaction names a FACTORY rather than a command. No shipped template carries that
    /// shape for a reason the next test pins: the VALIDATOR rejects it, so this model is deliberately
    /// only parsed (<see cref="Build"/> runs no semantic pass). The resolver is expected to answer the
    /// question anyway — see <c>FanOutTarget.IsFactory</c>.
    /// </summary>
    private const string FactoryPolicyModel = """
        context Warehouse {
          event StockDepleted {
            sku: String
          }

          entity StockItem identified by StockItemId {
            sku:      String
            quantity: Int

            command consume(amount: Int) {
              quantity -> quantity - amount
              emit StockDepleted(sku: sku)
            }
          }

          aggregate Replenishment root PurchaseOrder {
            event PurchaseOrderRaised {
              sku: String
            }

            entity PurchaseOrder identified by PurchaseOrderId {
              sku: String

              create raise(sku: String) {
                emit PurchaseOrderRaised(sku: sku)
              }
            }
          }

          policy Reorder when StockDepleted then Replenishment.raise(sku: sku)
        }
        """;

    [Fact]
    public void A_policy_reaction_naming_a_factory_resolves_as_a_factory_target()
    {
        SemanticModel sema = Build(FactoryPolicyModel);

        FanOutResolution fanOut = new ScenarioFanOutResolver(sema).Resolve("Warehouse", "StockDepleted");

        FanOutTarget target = fanOut.Executable.ShouldHaveSingleItem();
        target.PolicyName.ShouldBe("Reorder");
        target.Context.ShouldBe("Warehouse");
        target.AggregateName.ShouldBe("Replenishment");
        target.EntityName.ShouldBe("PurchaseOrder");
        target.MemberName.ShouldBe("raise");
        target.IsFactory.ShouldBeTrue();
        target.Args.ShouldHaveSingleItem().Parameter.ShouldBe("sku");
        fanOut.DeclaredOnly.ShouldBeEmpty();
    }

    /// <summary>
    /// Why every <c>IsFactory</c> path in the runner is DEAD CODE today, pinned rather than asserted in
    /// prose: a policy reaction may only name a <c>command</c>, so the model above is one the compiler
    /// refuses. The runner never sees it, and the resolver's factory branch cannot fire for a model that
    /// validates. The day this diagnostic goes away, this test fails and the "unreachable" comments on
    /// <c>FanOutTarget.IsFactory</c>, <c>DownstreamState.StaticTarget</c> and the dispatcher's
    /// <c>StaticTarget</c> branch are due for review — which is the point of pinning it here.
    /// </summary>
    [Fact]
    public void A_policy_reaction_naming_a_factory_is_a_model_the_validator_refuses_today()
    {
        IReadOnlyList<Diagnostics.Diagnostic> diagnostics = new KoineCompiler().Diagnose(FactoryPolicyModel);

        diagnostics.ShouldContain(d =>
            d.Code == Diagnostics.DiagnosticCodes.PolicyUnknownCommand && d.Message.Contains("raise"));
    }

    [Fact]
    public void An_unknown_event_resolves_to_nothing_rather_than_throwing()
    {
        SemanticModel sema = Pizzeria.Value;
        var resolver = new ScenarioFanOutResolver(sema);

        FanOutResolution unknownEvent = resolver.Resolve("Ordering", "NoSuchEventWasEverDeclared");
        unknownEvent.Executable.ShouldBeEmpty();
        unknownEvent.DeclaredOnly.ShouldBeEmpty();

        // An unknown emitting context is equally a non-answer, not an exception.
        FanOutResolution unknownContext = resolver.Resolve("NoSuchContext", "OrderPlaced");
        unknownContext.DeclaredOnly.ShouldBeEmpty();
    }

    // ------------------------------------------------------------------------
    // The downstream aggregate's STARTING state (#1758, D2): a per-aggregate
    // `given` slice, a factory that needs no prior instance, or an honest note —
    // never an invented default instance.
    // ------------------------------------------------------------------------

    private static readonly IReadOnlyDictionary<string, ScenarioValue> NoGiven =
        new Dictionary<string, ScenarioValue>(StringComparer.Ordinal);

    /// <summary>The pizzeria's own downstream shape: <c>policy PostToLedger when ChargeCaptured then
    /// Books.record(...)</c>, whose target aggregate <c>Books</c> is rooted on <c>LedgerEntry</c>.</summary>
    private static FanOutTarget Downstream(string entity, string aggregate, string member, bool isFactory = false) =>
        new(entity, aggregate, "Payment", member, isFactory, [], "PostToLedger");

    /// <summary>A construction that must never run: the rule under test is expected to answer without
    /// touching the emitted code at all.</summary>
    private static DownstreamState NeverConstructs(IReadOnlyDictionary<string, ScenarioValue> _) =>
        throw new InvalidOperationException("the downstream state was constructed when it should not have been");

    [Fact]
    public void A_dotted_given_key_is_routed_to_the_named_entity_with_its_prefix_stripped()
    {
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["status"] = ScenarioValue.Enum("Draft"),                 // bare: the PRIMARY aggregate's
            ["LedgerEntry.amount"] = ScenarioValue.FromDecimal(12m),
            ["ledgerentry.posted"] = ScenarioValue.FromBool(false),   // case-insensitive on the entity
            ["Invoice.number"] = ScenarioValue.FromString("INV-1"),   // a THIRD aggregate's
        };

        IReadOnlyDictionary<string, ScenarioValue> routed = ScenarioDownstreamState.GivenFor(given, "LedgerEntry");

        routed.Keys.OrderBy(k => k, StringComparer.Ordinal).ShouldBe(new[] { "amount", "posted" });
        routed["amount"].ShouldBe(ScenarioValue.FromDecimal(12m));
        routed["posted"].ShouldBe(ScenarioValue.FromBool(false));

        // The prefix is stripped, and nothing that belongs to another aggregate comes along.
        routed.ContainsKey("LedgerEntry.amount").ShouldBeFalse();
        routed.ContainsKey("status").ShouldBeFalse();
        routed.ContainsKey("number").ShouldBeFalse();
    }

    [Fact]
    public void Bare_given_keys_belong_to_the_primary_aggregate_and_never_leak_downstream()
    {
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["status"] = ScenarioValue.Enum("Draft"),
            ["amount"] = ScenarioValue.FromDecimal(12m),
        };

        // Whatever the downstream entity is called, an undotted key is the primary aggregate's.
        ScenarioDownstreamState.GivenFor(given, "LedgerEntry").ShouldBeEmpty();
        ScenarioDownstreamState.GivenFor(given, "Order").ShouldBeEmpty();
        ScenarioDownstreamState.GivenFor(NoGiven, "LedgerEntry").ShouldBeEmpty();
    }

    [Fact]
    public void A_factory_target_needs_no_prior_instance()
    {
        FanOutTarget target = Downstream("PurchaseOrder", "Replenishment", "raise", isFactory: true);

        DownstreamState state = ScenarioDownstreamState.Establish(target, "StockItem", NoGiven, NeverConstructs);

        state.ShouldBeOfType<DownstreamState.StaticTarget>();
    }

    [Fact]
    public void A_downstream_aggregate_with_no_state_to_establish_is_unavailable_with_a_reason_naming_it()
    {
        FanOutTarget target = Downstream("LedgerEntry", "Books", "record");
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["status"] = ScenarioValue.Enum("Draft"),
            ["amount"] = ScenarioValue.FromDecimal(12m),
        };

        DownstreamState state = ScenarioDownstreamState.Establish(target, "Order", given, NeverConstructs);

        DownstreamState.Unavailable unavailable = state.ShouldBeOfType<DownstreamState.Unavailable>();
        unavailable.Reason.ShouldContain("LedgerEntry");     // the aggregate that has no state
        unavailable.Reason.ShouldContain("Order");           // what the given state DOES describe
        unavailable.Reason.ShouldContain("LedgerEntry.");    // the remedy: the key to add
    }

    [Fact]
    public void A_routed_given_slice_is_handed_to_the_construction_stripped_of_its_prefix()
    {
        FanOutTarget target = Downstream("LedgerEntry", "Books", "record");
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["status"] = ScenarioValue.Enum("Draft"),
            ["LedgerEntry.amount"] = ScenarioValue.FromDecimal(12m),
        };
        var built = new object();
        IReadOnlyDictionary<string, ScenarioValue>? seen = null;

        DownstreamState state = ScenarioDownstreamState.Establish(target, "Order", given, routed =>
        {
            seen = routed;
            return new DownstreamState.Instance(built);
        });

        state.ShouldBeOfType<DownstreamState.Instance>().Value.ShouldBeSameAs(built);
        seen.ShouldNotBeNull();
        seen!.Keys.ShouldBe(new[] { "amount" });
    }

    [Fact]
    public void A_given_slice_keyed_by_the_policys_aggregate_name_still_reaches_its_root_entity()
    {
        // A policy reaction names the AGGREGATE (`Books.record`), so keying the slice by that name is
        // what a scenario author reads off the model — it resolves to the same root entity.
        FanOutTarget target = Downstream("LedgerEntry", "Books", "record");
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["Books.amount"] = ScenarioValue.FromDecimal(12m),
        };
        IReadOnlyDictionary<string, ScenarioValue>? seen = null;

        ScenarioDownstreamState.Establish(target, "Order", given, routed =>
        {
            seen = routed;
            return new DownstreamState.Instance(new object());
        });

        seen.ShouldNotBeNull();
        seen!.Keys.ShouldBe(new[] { "amount" });
    }

    [Fact]
    public void A_domain_violation_building_the_downstream_state_is_surfaced_rather_than_reported_as_unavailable()
    {
        FanOutTarget target = Downstream("LedgerEntry", "Books", "record");
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["LedgerEntry.amount"] = ScenarioValue.FromDecimal(-1m),
        };
        var violation = new InvalidOperationException("an amount cannot be negative");

        DownstreamState state = ScenarioDownstreamState.Establish(
            target, "Order", given, _ => new DownstreamState.Rejected(violation));

        // A rejected given state is a real domain outcome the runner must report with its real message,
        // never a swallowed "no state was established" note.
        state.ShouldBeOfType<DownstreamState.Rejected>().Violation.ShouldBeSameAs(violation);
    }

    // ------------------------------------------------------------------------
    // Fan-out DISPATCH (#1758, decisions D1/D3/D4/D5/D6): the resolved downstream
    // reaction really RUNS, its steps are attributed to the aggregate that
    // produced them, its state merges under `<Entity>.<member>` keys, and the
    // cascade is bounded by BOTH a depth cap and a visited set.
    // ------------------------------------------------------------------------

    /// <summary>The pizzeria's own cross-aggregate shape (<c>policy PostToLedger when ChargeCaptured then
    /// Books.record(...)</c>), inline so the downstream aggregate is drivable end to end: the ledger entry
    /// carries a <c>requires</c> the downstream call can violate, which the pizzeria's does not.</summary>
    private const string PostingModel = """
        context Posting {
          event ChargeCaptured {
            capturedAmount: Decimal
          }

          aggregate Billing root Charge {
            entity Charge identified by ChargeId {
              amount:  Decimal
              settled: Bool = false

              command capture {
                requires !settled   "only an unsettled charge can be captured"
                settled -> true
                emit ChargeCaptured(capturedAmount: amount)
              }
            }
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              balance: Decimal
              closed:  Bool = false

              command record(amount: Decimal) {
                requires !closed   "a closed ledger entry cannot be posted to"
                balance -> balance + amount
              }
            }
          }

          policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)
        }
        """;

    private static Scenario CaptureScenario(params (string Key, ScenarioValue Value)[] downstreamGiven)
    {
        var given = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
        {
            ["amount"] = ScenarioValue.FromDecimal(12m),
            ["settled"] = ScenarioValue.FromBool(false),
        };
        foreach ((string key, ScenarioValue value) in downstreamGiven)
        {
            given[key] = value;
        }

        return new Scenario("Charge", "capture", given, new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));
    }

    [Fact]
    public void A_downstream_policy_reaction_runs_from_a_dotted_given_key_and_reports_its_own_steps()
    {
        SemanticModel sema = Build(PostingModel);
        Scenario scenario = CaptureScenario(
            ("LedgerEntry.balance", ScenarioValue.FromDecimal(5m)),
            ("LedgerEntry.closed", ScenarioValue.FromBool(false)));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));

        // The primary aggregate's own steps stay unattributed (D3: `null` is the primary) …
        executed.Steps.Where(s => s.Aggregate is null).ShouldNotBeEmpty();

        // … and the fanned-out ones name the aggregate that produced them.
        var downstream = executed.Steps.Where(s => s.Aggregate == "LedgerEntry").ToList();
        downstream.ShouldNotBeEmpty();
        downstream.OfType<ScenarioStep.Precondition>().ShouldContain(
            p => p.Message == "a closed ledger entry cannot be posted to" && p.Outcome == CheckOutcome.Passed);

        // The downstream command's own write, with the REAL computed value: 5 + 12.
        ScenarioStep.Transition posted = downstream.OfType<ScenarioStep.Transition>().ShouldHaveSingleItem();
        posted.Field.ShouldBe("balance");
        posted.From.ShouldBe("5");
        posted.To.ShouldBe("17");

        // D4: the downstream post-state merges under `<Entity>.<member>`; the primary's bare keys are
        // untouched, and no bare key leaks in from the downstream aggregate.
        executed.ResultingState["LedgerEntry.balance"].ShouldBe("17");
        executed.ResultingState["LedgerEntry.closed"].ShouldBe("false");
        executed.ResultingState["settled"].ShouldBe("true");
        executed.ResultingState["amount"].ShouldBe("12");
        executed.ResultingState.ContainsKey("balance").ShouldBeFalse();
    }

    [Fact]
    public void A_downstream_invariant_failure_is_a_failed_step_carrying_the_models_real_rule_text()
    {
        SemanticModel sema = Build(PostingModel);
        Scenario scenario = CaptureScenario(
            ("LedgerEntry.balance", ScenarioValue.FromDecimal(5m)),
            ("LedgerEntry.closed", ScenarioValue.FromBool(true)));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        // D6: `Ok` answers for the PRIMARY operation, which really did capture the charge.
        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.ResultingState["settled"].ShouldBe("true");

        ScenarioStep.Precondition failed = executed.Steps
            .OfType<ScenarioStep.Precondition>()
            .Where(p => p.Outcome == CheckOutcome.Failed)
            .ShouldHaveSingleItem();
        failed.Aggregate.ShouldBe("LedgerEntry");
        failed.Message.ShouldBe("a closed ledger entry cannot be posted to");
        executed.Notes.ShouldContain(n => n.Contains("a closed ledger entry cannot be posted to"));

        // The guard threw before the write, so nothing was posted — and the downstream state reported is
        // the one it really started from, never a claimed mutation.
        executed.Steps.Where(s => s.Aggregate == "LedgerEntry").OfType<ScenarioStep.Transition>().ShouldBeEmpty();
        executed.ResultingState["LedgerEntry.balance"].ShouldBe("5");
    }

    /// <summary>A cycle a context map really permits: A's event drives B, B's drives A, A's drives B …</summary>
    private const string CyclicModel = """
        context Looping {
          event Ping { n: Int }
          event Pong { n: Int }

          aggregate Left root Alpha {
            entity Alpha identified by AlphaId {
              count: Int = 0

              command ring(amount: Int) {
                count -> count + amount
                emit Ping(n: count)
              }
            }
          }

          aggregate Right root Beta {
            entity Beta identified by BetaId {
              count: Int = 0

              command echo(amount: Int) {
                count -> count + amount
                emit Pong(n: count)
              }
            }
          }

          policy Forward when Ping then Right.echo(amount: n)
          policy Back    when Pong then Left.ring(amount: n)
        }
        """;

    [Fact]
    public void A_cyclic_policy_chain_terminates_on_the_visited_set_with_a_note_well_inside_the_wall_clock()
    {
        SemanticModel sema = Build(CyclicModel);
        var scenario = new Scenario(
            "Alpha",
            "ring",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["count"] = ScenarioValue.FromInt(0),
                ["Alpha.count"] = ScenarioValue.FromInt(0),
                ["Beta.count"] = ScenarioValue.FromInt(0),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal) { ["amount"] = ScenarioValue.FromInt(1) });

        // The COLD run pays the one-off emit + Roslyn compile + JIT, which has nothing to do with the
        // cascade — but a cyclic model must still be diagnosed as a cycle rather than killed by the
        // sandbox's wall clock, so it has to finish inside that budget.
        var cold = Stopwatch.StartNew();
        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);
        cold.Stop();
        cold.Elapsed.ShouldBeLessThan(ScenarioExecutionHost.DefaultTimeout);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));

        // Alpha -> Beta -> Alpha -> (Beta again): the visited set on (aggregate, event) bites BEFORE the
        // depth cap does, so a cycle is reported as the cycle it is.
        executed.Notes.ShouldContain(n => n.Contains("cycle") && n.Contains("Beta") && n.Contains("Ping"));
        executed.Notes.ShouldNotContain(n => n.Contains("maximum depth"));

        executed.Steps.ShouldContain(s => s.Aggregate == "Beta");
        executed.Steps.ShouldContain(s => s.Aggregate == "Alpha");

        // Warm, the whole run — cascade included — is far below the 5 s budget.
        var warm = Stopwatch.StartNew();
        ScenarioExecutor.Run(sema, scenario);
        warm.Stop();
        warm.Elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(2));
    }

    /// <summary>Five hops, no repetition: only the DEPTH cap can stop this one, so it pins that bound
    /// separately from the visited set.</summary>
    private const string DeepChainModel = """
        context Chaining {
          event Step1 { n: Int }
          event Step2 { n: Int }
          event Step3 { n: Int }
          event Step4 { n: Int }

          entity Hop1 identified by Hop1Id {
            count: Int = 0
            command go(amount: Int) {
              count -> count + amount
              emit Step1(n: count)
            }
          }

          entity Hop2 identified by Hop2Id {
            count: Int = 0
            command go(amount: Int) {
              count -> count + amount
              emit Step2(n: count)
            }
          }

          entity Hop3 identified by Hop3Id {
            count: Int = 0
            command go(amount: Int) {
              count -> count + amount
              emit Step3(n: count)
            }
          }

          entity Hop4 identified by Hop4Id {
            count: Int = 0
            command go(amount: Int) {
              count -> count + amount
              emit Step4(n: count)
            }
          }

          entity Hop5 identified by Hop5Id {
            count: Int = 0
            command go(amount: Int) {
              count -> count + amount
            }
          }

          policy P1 when Step1 then Hop2.go(amount: n)
          policy P2 when Step2 then Hop3.go(amount: n)
          policy P3 when Step3 then Hop4.go(amount: n)
          policy P4 when Step4 then Hop5.go(amount: n)
        }
        """;

    [Fact]
    public void A_deep_non_repeating_policy_chain_stops_at_the_depth_cap_with_a_note()
    {
        SemanticModel sema = Build(DeepChainModel);
        var scenario = new Scenario(
            "Hop1",
            "go",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["count"] = ScenarioValue.FromInt(0),
                ["Hop2.count"] = ScenarioValue.FromInt(0),
                ["Hop3.count"] = ScenarioValue.FromInt(0),
                ["Hop4.count"] = ScenarioValue.FromInt(0),
                ["Hop5.count"] = ScenarioValue.FromInt(0),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal) { ["amount"] = ScenarioValue.FromInt(1) });

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));

        // Three downstream hops are explored (the primary's own steps carry no attribution) …
        executed.Steps.Select(s => s.Aggregate).Distinct().ShouldBe(
            new string?[] { null, "Hop2", "Hop3", "Hop4" }, ignoreOrder: true);

        // … and the fourth is refused by the DEPTH cap. Nothing repeats, so the visited set never bites.
        executed.Notes.ShouldContain(n => n.Contains("maximum depth") && n.Contains("Hop5"));
        executed.Notes.ShouldNotContain(n => n.Contains("cycle"));
        executed.ResultingState.ContainsKey("Hop5.count").ShouldBeFalse();
        executed.ResultingState["Hop4.count"].ShouldBe("1");
    }

    [Fact]
    public void A_downstream_aggregate_with_no_given_state_is_a_failed_step_and_a_note_never_a_guess()
    {
        SemanticModel sema = Pizzeria.Value;
        var scenario = new Scenario(
            "Charge",
            "capture",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["order"] = ScenarioValue.FromString("22222222-2222-2222-2222-222222222222"),
                ["amount"] = ScenarioValue.RecordOf(
                    ("amount", ScenarioValue.FromDecimal(10m)),
                    ("currency", ScenarioValue.FromString("EUR"))),
                ["method"] = ScenarioValue.Enum("Card"),
                ["status"] = ScenarioValue.Enum("Authorized"),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.Steps.OfType<ScenarioStep.Emit>().ShouldContain(e => e.EventName == "ChargeCaptured");

        // `policy PostToLedger when ChargeCaptured then Books.record(...)` resolves, but the scenario
        // describes no LedgerEntry — so the run SAYS so instead of inventing an instance.
        ScenarioStep.Precondition unavailable = executed.Steps
            .OfType<ScenarioStep.Precondition>()
            .Where(p => p.Outcome == CheckOutcome.Failed)
            .ShouldHaveSingleItem();
        unavailable.Aggregate.ShouldBe("LedgerEntry");
        executed.Notes.ShouldContain(n => n.Contains("No state was established for LedgerEntry"));
        executed.Notes.ShouldContain(n => n.Contains("LedgerEntry.<member>"));

        // Nothing was constructed, so no downstream state is claimed.
        executed.ResultingState.Keys.ShouldNotContain(k => k.StartsWith("LedgerEntry.", StringComparison.Ordinal));
    }

    /// <summary>
    /// Two policies reacting to the SAME event on the SAME aggregate — an everyday DDD shape ("when the
    /// charge is captured, post it to the ledger AND audit the ledger"). Both are declared, both are
    /// executable, and neither is a cycle.
    /// </summary>
    private const string TwinPolicyModel = """
        context Twinned {
          event ChargeCaptured {
            capturedAmount: Decimal
          }

          aggregate Billing root Charge {
            entity Charge identified by ChargeId {
              amount:  Decimal
              settled: Bool = false

              command capture {
                settled -> true
                emit ChargeCaptured(capturedAmount: amount)
              }
            }
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              balance: Decimal
              audited: Bool = false

              command record(amount: Decimal) {
                balance -> balance + amount
              }

              command audit {
                audited -> true
              }
            }
          }

          policy AuditLedger  when ChargeCaptured then Books.audit
          policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)
        }
        """;

    [Fact]
    public void Two_policies_reacting_to_one_event_on_one_aggregate_both_run_against_the_same_instance()
    {
        SemanticModel sema = Build(TwinPolicyModel);
        var scenario = new Scenario(
            "Charge",
            "capture",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["amount"] = ScenarioValue.FromDecimal(12m),
                ["settled"] = ScenarioValue.FromBool(false),
                ["LedgerEntry.balance"] = ScenarioValue.FromDecimal(5m),
                ["LedgerEntry.audited"] = ScenarioValue.FromBool(false),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));

        // Neither declared reaction is dropped, and nothing here loops: the bound remembers the
        // REACTION it dispatched, not merely the (aggregate, event) pair, so two distinct policies that
        // happen to share a trigger and a target are not mistaken for one repeating itself.
        executed.Notes.ShouldNotContain(n => n.Contains("cycle"), string.Join(" | ", executed.Notes));
        executed.Steps
            .Where(s => s.Aggregate == "LedgerEntry")
            .OfType<ScenarioStep.Transition>()
            .Select(t => t.Field)
            .ShouldBe(new[] { "audited", "balance" });

        // Both ran against ONE LedgerEntry, in order, so the merged state agrees with both steps above
        // it instead of reporting whichever reaction happened to run last against a second instance
        // rebuilt from the same `given`.
        executed.ResultingState["LedgerEntry.audited"].ShouldBe("true");
        executed.ResultingState["LedgerEntry.balance"].ShouldBe("17");
    }

    /// <summary>
    /// The same twin-policy shape, but the aggregate the two reactions land on PUBLISHES — the only
    /// shape in which the per-list resume cursor (<c>RecordedCount</c>) is exercised at a non-zero
    /// value, and therefore the only one that can catch it being read off the wrong list.
    ///
    /// <para>The counts are deliberately ASYMMETRIC (the first reaction leaves 2 domain events and 1
    /// integration event behind) and the second reaction re-publishes the SAME contract with a NEW
    /// payload, so the two ways the split can be wired backwards both become visible:</para>
    /// <list type="bullet">
    ///   <item><description>reading the integration cursor off the domain count (or vice versa) sends
    ///   <c>RecordedStep</c> past the end of the published list, so <c>LedgerSettled</c> is reported as
    ///   "no such event was recorded" with an empty payload instead of the value it really carried;
    ///   </description></item>
    ///   <item><description>resuming the published list at the DOMAIN count drops the second reaction's
    ///   publications from the fan-out, so <c>LedgerSettled</c>'s boundary crossing is never
    ///   noted.</description></item>
    /// </list>
    /// <para><c>settle</c> sorts after <c>post</c>, and the resolver orders executable targets by member
    /// name, so the reactions run in that order deterministically.</para>
    /// </summary>
    private const string TwinPolicyPublishingModel = """
        context Twinned {
          publishes LedgerPosted
          publishes LedgerSettled

          integration event LedgerPosted  { postedAmount:   Decimal }
          integration event LedgerSettled { settledBalance: Decimal }

          event ChargeCaptured        { capturedAmount: Decimal }
          event LedgerBalanceChanged  { entryBalance:   Decimal }
          event LedgerEntryReconciled { entryBalance:   Decimal }

          aggregate Billing root Charge {
            entity Charge identified by ChargeId {
              amount:  Decimal
              settled: Bool = false

              command capture {
                settled -> true
                emit ChargeCaptured(capturedAmount: amount)
              }
            }
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              balance: Decimal
              audited: Bool = false

              command post(amount: Decimal) {
                balance -> balance + amount
                emit LedgerBalanceChanged(entryBalance: balance)
                emit LedgerEntryReconciled(entryBalance: balance)
                publish LedgerPosted(postedAmount: balance)
              }

              command settle {
                audited -> true
                balance -> balance + 1
                publish LedgerSettled(settledBalance: balance)
                publish LedgerPosted(postedAmount: balance)
              }
            }
          }

          policy PostToLedger when ChargeCaptured then Books.post(amount: capturedAmount)
          policy SettleLedger when ChargeCaptured then Books.settle
        }

        context Reporting {
          subscribes Twinned.LedgerPosted
          subscribes Twinned.LedgerSettled
        }

        contextmap {
          Twinned -> Reporting : open-host
        }
        """;

    [Fact]
    public void A_second_reaction_onto_a_publishing_root_reads_its_own_publications_not_the_first_ones()
    {
        SemanticModel sema = Build(TwinPolicyPublishingModel);
        var scenario = new Scenario(
            "Charge",
            "capture",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["amount"] = ScenarioValue.FromDecimal(12m),
                ["settled"] = ScenarioValue.FromBool(false),
                ["LedgerEntry.balance"] = ScenarioValue.FromDecimal(5m),
                ["LedgerEntry.audited"] = ScenarioValue.FromBool(false),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));

        // Both reactions ran against the ONE live LedgerEntry: 5 + 12 = 17, then + 1 = 18.
        executed.ResultingState["LedgerEntry.balance"].ShouldBe("18");

        List<ScenarioStep.Emit> ledger = executed.Steps
            .OfType<ScenarioStep.Emit>()
            .Where(e => e.Aggregate == "LedgerEntry")
            .ToList();
        ledger.Select(e => e.EventName).ShouldBe(new[]
        {
            "LedgerBalanceChanged", "LedgerEntryReconciled", "LedgerPosted", "LedgerSettled", "LedgerPosted",
        });
        ledger.Select(e => e.Published).ShouldBe(new[] { false, false, true, true, true });

        // Every publication is matched to the one THIS invocation recorded. `LedgerSettled` is the
        // second reaction's FIRST publication, so it is only reachable through a published cursor that
        // resumed at 1 — not at the domain count (2), which is past its position.
        ledger[3].Args.ShouldContainKey("settledBalance");
        ledger[3].Args["settledBalance"].ShouldBe("18");

        // …and the re-published `LedgerPosted` carries the SECOND payload, never a re-report of the
        // first reaction's 17.
        ledger[2].Args["postedAmount"].ShouldBe("17");
        ledger[4].Args["postedAmount"].ShouldBe("18");

        executed.Notes.ShouldNotContain(
            n => n.Contains("no such event was recorded", StringComparison.Ordinal),
            string.Join(" | ", executed.Notes));

        // The fan-out resumed the published list at ITS OWN count too, so the second reaction's
        // publications were seen and `LedgerSettled` reached the boundary resolver at all.
        executed.Notes.ShouldContain(
            n => n.Contains("'LedgerPosted' crosses a context boundary", StringComparison.Ordinal),
            string.Join(" | ", executed.Notes));
        executed.Notes.ShouldContain(
            n => n.Contains("'LedgerSettled' crosses a context boundary", StringComparison.Ordinal),
            string.Join(" | ", executed.Notes));
    }

    // ------------------------------------------------------------------------
    // D1's declared-only surface, END TO END (#1796). `publish X(…)` gives a command a way to record a
    // published integration event, so the resolution covered above by
    // A_published_integration_event_resolves_to_its_subscribers_and_to_no_executable_target now really
    // fires from an EXECUTED run: the emitted root keeps `_integrationEvents` beside `_domainEvents`,
    // and the dispatcher reads both.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_published_integration_event_is_reported_as_declared_only_by_an_executed_run()
    {
        SemanticModel sema = Pizzeria.Value;
        Scenario scenario = OrderScenario("place", "Draft", Line("MARG", 2, 10m));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));

        // The published event crosses a boundary to the three contexts that `subscribes
        // Ordering.OrderPlaced` — said exactly once, however many recorded events resolve to it.
        string crossing = executed.Notes
            .Where(n => n.Contains("crosses a context boundary", StringComparison.Ordinal))
            .ShouldHaveSingleItem(string.Join(" | ", executed.Notes));
        crossing.ShouldContain("'OrderPlaced'");
        crossing.ShouldContain("Delivery, Kitchen and Payment");
        crossing.ShouldContain("no downstream step was run for it");

        // `command place` records BOTH lists: the internal domain event, and the published contract —
        // whose payload is read off the REAL recorded integration event (10 x 2 = 20, a figure the
        // interpreter can only report as `?` because `total` is a derived value-object sum).
        List<ScenarioStep.Emit> recorded = executed.Steps.OfType<ScenarioStep.Emit>().ToList();
        recorded.Select(e => e.EventName).ShouldBe(new[] { "OrderPlacedInternally", "OrderPlaced" });
        recorded[1].Args["total"].ShouldBe("20");

        // The timeline says WHICH verb recorded each: without the flag the two steps are shape-identical,
        // and a published contract would read as an ordinary intra-aggregate domain event.
        recorded.Select(e => e.Published).ShouldBe(new[] { false, true });

        // …and nothing was FABRICATED for it: a subscriber is a bodiless handler seam, so no downstream
        // step and no downstream state may appear (ADR 0014 D1/D7).
        executed.Steps.ShouldAllBe(s => s.Aggregate == null);
        executed.ResultingState.Keys.ShouldNotContain(k => k.Contains('.', StringComparison.Ordinal));

        // The INTERNAL event is not mistaken for a boundary crossing: it is nobody's published contract.
        executed.Notes.ShouldNotContain(n => n.Contains("OrderPlacedInternally", StringComparison.Ordinal));
    }

    /// <summary>
    /// The regression half: widening the recorded-event source must be INERT for every model that
    /// publishes nothing. The pizzeria's `Payment` context declares no `publishes`, so the emitted
    /// `Charge` root has no `IntegrationEvents` property at all — and this run must report exactly the
    /// notes it reported before the widening.
    /// </summary>
    [Fact]
    public void A_root_that_publishes_nothing_reports_exactly_the_notes_it_reported_before()
    {
        SemanticModel sema = Pizzeria.Value;
        var scenario = new Scenario(
            "Charge",
            "capture",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["order"] = ScenarioValue.FromString("22222222-2222-2222-2222-222222222222"),
                ["amount"] = ScenarioValue.RecordOf(
                    ("amount", ScenarioValue.FromDecimal(10m)),
                    ("currency", ScenarioValue.FromString("EUR"))),
                ["method"] = ScenarioValue.Enum("Card"),
                ["status"] = ScenarioValue.Enum("Authorized"),
            },
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

        ScenarioResult executed = ScenarioExecutor.Run(sema, scenario);

        executed.Ok.ShouldBeTrue(string.Join(" | ", executed.Notes));
        executed.Steps.OfType<ScenarioStep.Emit>().Select(e => e.EventName).ShouldBe(new[] { "ChargeCaptured" });

        // Exactly the one note the un-widened runner produced: the LedgerEntry state it refused to invent.
        executed.Notes.ShouldHaveSingleItem()
            .ShouldStartWith("No state was established for LedgerEntry");
    }

    /// <summary>
    /// The interpreted (Approach B) arm of the same clause. It reports the publication on the same
    /// timeline as an emitted event — FLAGGED as published, so the two stay distinguishable — and stops
    /// there: ADR 0014 D7 keeps `ScenarioInterpreter` single-aggregate, so it constructs no downstream
    /// aggregate and dispatches no fan-out. The boundary NOTE is a fan-out product, so its absence here
    /// is that documented limit, not the publication going unlabelled.
    /// </summary>
    [Fact]
    public void The_interpreter_flags_a_publication_without_following_it()
    {
        SemanticModel sema = Pizzeria.Value;
        Scenario scenario = OrderScenario("place", "Draft", Line("MARG", 2, 10m));

        ScenarioResult interpreted = ScenarioInterpreter.Run(sema, scenario);

        interpreted.Steps.OfType<ScenarioStep.Emit>().Select(e => e.EventName)
            .ShouldBe(new[] { "OrderPlacedInternally", "OrderPlaced" });

        // The distinction the timeline could NOT previously make: an intra-aggregate `emit` and a
        // published-language `publish` produce shape-identical steps, told apart only by this flag.
        interpreted.Steps.OfType<ScenarioStep.Emit>().Select(e => e.Published).ShouldBe(new[] { false, true });

        ScenarioStep.Emit published = interpreted.Steps.OfType<ScenarioStep.Emit>().Last();
        published.Args.Keys.OrderBy(k => k, StringComparer.Ordinal)
            .ShouldBe(new[] { "customer", "fulfillment", "orderId", "placedAt", "total" });
        published.Args["fulfillment"].ShouldBe("Delivery");

        // D7: no attribution, no downstream state, no fan-out note — the interpreter did not grow a
        // second execution engine.
        interpreted.Steps.ShouldAllBe(s => s.Aggregate == null);
        interpreted.ResultingState.Keys.ShouldNotContain(k => k.Contains('.', StringComparison.Ordinal));
        interpreted.Notes.ShouldNotContain(n => n.Contains("crosses a context boundary", StringComparison.Ordinal));
    }
}
