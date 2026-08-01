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
}
