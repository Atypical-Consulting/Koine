using System.Diagnostics;
using System.Reflection;
using System.Text;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Cross-emitter BEHAVIORAL conformance: for a small corpus of <c>.koi</c> models the C# and
/// TypeScript backends must AGREE on observable domain semantics — for the same input, both must
/// either accept it (no invariant violation) or reject it (a <c>DomainInvariantViolation*</c> is
/// thrown). Per-backend snapshots can prove each emitter is stable, but only running the SAME model
/// through BOTH targets can prove they encode the SAME domain.
/// </summary>
/// <remarks>
/// <para>
/// Each <see cref="Scenario"/> is expressed twice — once as a C# expression, once as a TypeScript
/// expression — that exercises the emitted domain and returns <c>true</c> when the operation was
/// accepted. The harness:
/// </para>
/// <list type="number">
///   <item>emits C# for the model, injects a generated driver, compiles it in-memory with Roslyn
///   (the existing meta-test plumbing) and invokes the driver via reflection to get accept/reject
///   per scenario;</item>
///   <item>emits TypeScript for the same model, writes a generated driver module, transpiles
///   everything with <c>tsc</c> and runs the driver under <c>node</c> (an ESM resolve hook supplies
///   the <c>.js</c> extension the emitted extensionless imports omit), reading accept/reject from
///   stdout;</item>
///   <item>asserts, per scenario, that the C# outcome, the TypeScript outcome, and the declared
///   expected outcome all agree.</item>
/// </list>
/// <para>
/// The C# half always runs (Roslyn ships with the test host). The TypeScript half needs a Node +
/// <c>tsc</c> toolchain; when none is present locally the TS comparison is funneled through
/// <see cref="TestSupport.RequireOrSkip"/>, which reports the test as <c>Skipped</c> (not a false
/// Passed) so <c>dotnet test</c> stays green without a Node toolchain — but the C#-vs-expected
/// assertions still run first, and a real cross-emitter divergence is asserted whenever the toolchain
/// IS present (as it is in CI, which also sets <c>KOINE_REQUIRE_CONFORMANCE</c> to make a missing
/// toolchain a hard <c>Failed</c>). It NEVER silently passes a genuine mismatch.
/// </para>
/// </remarks>
public class CrossEmitterConformanceTests
{
    private const string NoToolchainNotice =
        "No Node/TypeScript toolchain (tsc + node) available locally; the TypeScript " +
        "half of the cross-emitter comparison was not run. The C#-vs-expected outcomes were still " +
        "asserted. Install Node + TypeScript (or set KOINE_TSC) — CI runs the full comparison.";

    private const string NoPythonToolchainNotice =
        "No mypy toolchain available locally; the Python half of the cross-emitter comparison was not " +
        "run. The C# (and, where available, TypeScript) outcomes were still asserted. Install mypy " +
        "(or set KOINE_MYPY) — CI runs the full comparison.";

    // ---- The corpus -----------------------------------------------------------------------------

    /// <summary>
    /// A value object whose constructor enforces an invariant. The simplest cross-emitter contract:
    /// the same numeric input must be accepted or rejected identically by both backends.
    /// </summary>
    private const string MoneyModel = """
        context Sales {
          value Money {
            amount: Int
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// An aggregate with a state-machine command that BOTH guards a precondition AND raises a domain
    /// event (the rec #2 event-raising case). Exercises: factory invariant, command guard accept,
    /// command guard reject, and that a successful command records exactly one event in both targets.
    /// </summary>
    private const string OrderModel = """
        context Sales {
          enum OrderStatus { Draft, Placed }

          aggregate Order root Order {
            event OrderPlaced {
              lineCount: Int
            }

            entity Order identified by OrderId {
              lineCount: Int
              status:    OrderStatus = Draft

              invariant lineCount >= 1 "an order must have at least one line"

              command place {
                requires status == Draft "only a draft order can be placed"
                status -> Placed
                emit OrderPlaced(lineCount: lineCount)
              }
            }
          }
        }
        """;

    /// <summary>
    /// A command that BOTH returns a <c>result</c> AND <c>emit</c>s a domain event whose payload
    /// reuses that result (<c>tax</c>) ALONGSIDE a sibling argument whose rendering shares the
    /// result's prefix (<c>taxRate</c>). This is the result/emit hoisting case (issue #60) plus the
    /// regression guard for the substring-splice bug found in review: the hoist must rewrite only
    /// the whole-argument match (<c>tax</c> → the hoisted local) and leave <c>taxRate</c> intact. A
    /// blind substring replace would emit <c>__resultRate</c> and the generated code would not
    /// compile — so this fixture fails the harness in BOTH backends if the bug ever returns.
    /// </summary>
    private const string QuoteModel = """
        context Sales {
          event Quoted {
            amount: Int
            rate:   Int
          }

          aggregate Order root Order {
            entity Order identified by OrderId {
              tax:     Int = 0
              taxRate: Int = 0

              command quote(): Int {
                emit Quoted(amount: tax, rate: taxRate)
                result tax
              }
            }
          }
        }
        """;

    /// <summary>
    /// A read model (R12.3) projected from an entity, exercising the CQRS application layer's runtime
    /// behavior: the projection mapper copies direct fields (<c>id</c>, <c>status</c>) and computes a
    /// derived field (<c>lineCount = lines.count</c>). Both backends must produce the SAME projected
    /// value — the read-model parity case. The service/use-case interface and the query DTO are
    /// interface-only (no runtime behavior) so they are locked by the snapshot + tsc-compile alone;
    /// the projection mapper is the one CQRS construct that CAN be behaviorally exercised, so it is.
    /// </summary>
    private const string ReadModelModel = """
        context Sales {
          enum OrderStatus { Draft, Placed }

          value OrderLine {
            sku:      String
            quantity: Int
            invariant quantity >= 1 "a line needs at least one unit"
          }

          aggregate Order root Order {
            entity Order identified by OrderId {
              lines:  List<OrderLine>
              status: OrderStatus = Draft
            }
          }

          readmodel OrderSummary from Order {
            id
            status
            lineCount: Int = lines.count
          }
        }
        """;

    /// <summary>
    /// A reusable specification (R10.1) and a stateless domain service (R10.2), exercising the
    /// behavioral layer's runtime: the <c>large</c> spec is a boolean predicate over an order's
    /// subtotal, and the service's pure <c>net</c> operation computes <c>subtotal - discount</c>.
    /// Both backends must agree — the spec must return the SAME truth value and the operation the SAME
    /// computed number for the same order. These are the R10 parity cases (the only behavioral CQRS
    /// counterpart not yet covered cross-emitter).
    /// </summary>
    private const string BehaviorModel = """
        context Pricing {
          value Order {
            subtotal: Int
            discount: Int
            invariant subtotal >= 0 "a subtotal cannot be negative"
          }

          spec large on Order = subtotal >= 100

          service PricingService {
            operation net(order: Order): Int = order.subtotal - order.discount
          }
        }
        """;

    public static IEnumerable<object[]> Corpus()
    {
        yield return ["Money invariant", MoneyModel, MoneyScenarios()];
        yield return ["Order command + event", OrderModel, OrderScenarios()];
        yield return ["Quote result + emit hoist (prefix-safe)", QuoteModel, QuoteScenarios()];
        yield return ["Read-model projection mapper", ReadModelModel, ReadModelScenarios()];
        yield return ["Specification + domain service", BehaviorModel, BehaviorScenarios()];
    }

    /// <summary>
    /// The <c>large</c> spec and the <c>net</c> domain-service operation. An order of subtotal 150
    /// satisfies <c>large</c>; one of subtotal 50 does not — both backends must agree on the predicate.
    /// The service's <c>net</c> must compute <c>subtotal - discount</c> identically. A scenario is
    /// ACCEPTED only when the backend's spec/operation outcome matches the asserted expectation, so an
    /// accept means C# and TS computed the SAME behavioral result.
    /// </summary>
    private static IReadOnlyList<Scenario> BehaviorScenarios()
    {
        const string tsImports =
            "import { Order } from './Pricing/value-objects/Order';\n" +
            "import { isLarge } from './Pricing/specifications/PricingSpecifications';\n" +
            "import { PricingService } from './Pricing/services/PricingService';";

        return
        [
            // Specification: subtotal 150 is large.
            new("large(subtotal=150) is true", Accept: true,
                Cs: "{ var o = new Pricing.Order(150, 10); " +
                    "if (!Pricing.PricingSpecifications.Large(o)) throw new System.Exception(\"expected large\"); }",
                Ts: "{ const o = new Order(150, 10); " +
                    "if (!isLarge(o)) throw new Error('expected large'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),

            // Specification: subtotal 50 is NOT large (assert the false branch agrees).
            new("large(subtotal=50) is false", Accept: true,
                Cs: "{ var o = new Pricing.Order(50, 10); " +
                    "if (Pricing.PricingSpecifications.Large(o)) throw new System.Exception(\"expected not large\"); }",
                Ts: "{ const o = new Order(50, 10); " +
                    "if (isLarge(o)) throw new Error('expected not large'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),

            // Domain service: net = subtotal - discount = 150 - 10 = 140 in both targets.
            new("net(order) computes subtotal - discount = 140", Accept: true,
                Cs: "{ var o = new Pricing.Order(150, 10); " +
                    "if (new Pricing.PricingService().Net(o) != 140) throw new System.Exception(\"wrong net\"); }",
                Ts: "{ const o = new Order(150, 10); " +
                    "if (new PricingService().net(o) !== 140) throw new Error('wrong net'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
        ];
    }

    /// <summary>
    /// Project an Order with two lines to an OrderSummary; the derived <c>lineCount</c> must be 2 in
    /// both targets, and the direct <c>status</c> must round-trip. A wrong projection (e.g. mapping
    /// the wrong field or miscounting) is REJECTED — so accept means both backends projected the same
    /// values from the same Order.
    /// </summary>
    private static IReadOnlyList<Scenario> ReadModelScenarios()
    {
        const string tsImports =
            "import { Order } from './Sales/Order';\n" +
            "import { OrderIdNew } from './Sales/value-objects/OrderId';\n" +
            "import { OrderLine } from './Sales/value-objects/OrderLine';\n" +
            "import { OrderStatus } from './Sales/enums/OrderStatus';\n" +
            "import { OrderSummaryProjection } from './Sales/read-models/OrderSummary';";

        return
        [
            new("projection computes lineCount=2 and carries status", Accept: true,
                Cs: "{ var id = Sales.OrderId.New(); " +
                    "var lines = new System.Collections.Generic.List<Sales.OrderLine> { new Sales.OrderLine(\"a\", 1), new Sales.OrderLine(\"b\", 3) }; " +
                    "var o = new Sales.Order(id, lines); " +
                    "var rm = Sales.OrderSummaryProjection.ToOrderSummary(o); " +
                    "if (rm.LineCount != 2) throw new System.Exception(\"wrong count\"); " +
                    "if (rm.Status != Sales.OrderStatus.Draft) throw new System.Exception(\"wrong status\"); " +
                    "if (!rm.Id.Equals(id)) throw new System.Exception(\"wrong id\"); }",
                Ts: "{ const id = OrderIdNew(); " +
                    "const lines = [new OrderLine('a', 1), new OrderLine('b', 3)]; " +
                    "const o = new Order(id, lines); " +
                    "const rm = OrderSummaryProjection(o); " +
                    "if (rm.lineCount !== 2) throw new Error('wrong count'); " +
                    "if (rm.status !== OrderStatus.Draft) throw new Error('wrong status'); " +
                    "if (!rm.id.equals(id)) throw new Error('wrong id'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
        ];
    }

    /// <summary>Money(amount): accepted iff amount &gt;= 0.</summary>
    private static IReadOnlyList<Scenario> MoneyScenarios() =>
    [
        new("Money(0) accepted", Accept: true,
            Cs: "new Sales.Money(0)",
            Ts: "new Money(0)",
            TsImports: "import { Money } from './Sales/value-objects/Money';"),
        new("Money(5) accepted", Accept: true,
            Cs: "new Sales.Money(5)",
            Ts: "new Money(5)",
            TsImports: "import { Money } from './Sales/value-objects/Money';"),
        new("Money(-1) rejected", Accept: false,
            Cs: "new Sales.Money(-1)",
            Ts: "new Money(-1)",
            TsImports: "import { Money } from './Sales/value-objects/Money';"),
    ];

    /// <summary>
    /// Order construction + the <c>place</c> command. The "place records one event" scenario asserts
    /// the event-raising parity from rec #2: a successful command must leave exactly one domain event
    /// recorded in BOTH targets (the expression evaluates to that boolean, which must be <c>true</c>).
    /// </summary>
    private static IReadOnlyList<Scenario> OrderScenarios()
    {
        // In C# the identity factory is a static `OrderId.New()`; in TS it is a standalone function
        // `OrderIdNew()` (emitted alongside the OrderId class) — both mint a fresh identity.
        const string tsImports =
            "import { Order } from './Sales/Order';\n" +
            "import { OrderIdNew } from './Sales/value-objects/OrderId';";

        return
        [
            // Factory/constructor invariant: an order needs at least one line.
            new("Order(1 line) accepted", Accept: true,
                Cs: "new Sales.Order(Sales.OrderId.New(), 1)",
                Ts: "new Order(OrderIdNew(), 1)",
                TsImports: tsImports),
            new("Order(0 lines) rejected", Accept: false,
                Cs: "new Sales.Order(Sales.OrderId.New(), 0)",
                Ts: "new Order(OrderIdNew(), 0)",
                TsImports: tsImports),

            // Command guard: a Draft order can be placed; a non-Draft order cannot.
            new("place() on Draft accepted", Accept: true,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 1); o.Place(); }",
                Ts: "{ const o = new Order(OrderIdNew(), 1); o.place(); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
            new("place() twice rejected", Accept: false,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 1); o.Place(); o.Place(); }",
                Ts: "{ const o = new Order(OrderIdNew(), 1); o.place(); o.place(); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),

            // Event-raising parity (rec #2): a successful place() records exactly one domain event.
            new("place() records exactly one event", Accept: true,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 1); o.Place(); " +
                    "if (o.DomainEvents.Count != 1) throw new System.Exception(\"expected one event\"); }",
                Ts: "{ const o = new Order(OrderIdNew(), 1); o.place(); " +
                    "if (o.domainEvents.length !== 1) throw new Error('expected one event'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
        ];
    }

    /// <summary>
    /// The <c>quote</c> command (result + emit reusing <c>tax</c>, beside the prefix-sharing sibling
    /// <c>taxRate</c>). The scenario reads BOTH event payload fields back: the hoisted result must
    /// flow into <c>amount</c> while <c>rate</c> keeps the un-rewritten <c>taxRate</c>. A
    /// substring-splice regression would emit uncompilable code or the wrong <c>rate</c>: the C#
    /// half (Roslyn) catches it on every run, and the TypeScript half catches it whenever the
    /// Node/tsc toolchain is present (CI). The unconditional TS guard is the text-shape unit test in
    /// <c>TypeScriptCommandReturnTests</c>.
    /// </summary>
    private static IReadOnlyList<Scenario> QuoteScenarios()
    {
        const string tsImports =
            "import { Order } from './Sales/Order';\n" +
            "import { OrderIdNew } from './Sales/value-objects/OrderId';\n" +
            "import { Quoted } from './Sales/events/Quoted';";

        return
        [
            // The returned result is `tax`; the event records `amount: tax` (hoisted) and
            // `rate: taxRate` (NOT hoisted). All three must read back uncorrupted in both targets.
            new("quote() returns tax and records both args uncorrupted", Accept: true,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 5, 2); var r = o.Quote(); " +
                    "if (r != 5) throw new System.Exception(\"wrong result\"); " +
                    "var ev = (Sales.Quoted)o.DomainEvents[0]; " +
                    "if (ev.Amount != 5 || ev.Rate != 2) throw new System.Exception(\"payload corrupted\"); }",
                Ts: "{ const o = new Order(OrderIdNew(), 5, 2); const r = o.quote(); " +
                    "if (r !== 5) throw new Error('wrong result'); " +
                    "const ev = o.domainEvents[0] as Quoted; " +
                    "if (ev.amount !== 5 || ev.rate !== 2) throw new Error('payload corrupted'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
        ];
    }

    // ---- The test -------------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Csharp_and_typescript_agree_on_domain_semantics(
        string name, string koi, IReadOnlyList<Scenario> scenarios)
    {
        _ = name; // surfaced in the test display name only.

        bool[] csOutcomes = RunCsharp(koi, scenarios);
        TsRun ts = RunTypeScript(koi, scenarios);

        for (int i = 0; i < scenarios.Count; i++)
        {
            Scenario s = scenarios[i];

            // 1) C# must match the declared expected outcome.
            (csOutcomes[i] == s.Accept).ShouldBeTrue($"C#: scenario '{s.Name}' expected {Verb(s.Accept)} but got {Verb(csOutcomes[i])}.");

            // 2) When the TS toolchain ran, TS must match C# (the cross-emitter assertion).
            if (ts.ToolchainAvailable)
            {
                (ts.Outcomes[i] == csOutcomes[i]).ShouldBeTrue($"CROSS-EMITTER DIVERGENCE on '{s.Name}': C# {Verb(csOutcomes[i])} but " +
                    $"TypeScript {Verb(ts.Outcomes[i])} the same input.");
            }
        }

        // The C#-vs-expected assertions above always run; only the cross-emitter (TypeScript) half
        // needs the toolchain. Funnel the absence through RequireOrSkip AFTER them, so a missing
        // toolchain reports the test as Skipped (or, under KOINE_REQUIRE_CONFORMANCE, fails) without
        // ever weakening the C# guarantee.
        TestSupport.RequireOrSkip(ts.ToolchainAvailable, NoToolchainNotice);
    }

    /// <summary>
    /// Issue #834 regression net: the canonical plain value-object arithmetic case —
    /// <c>combined: Money = base + base</c> and <c>diff: Money = base - base</c> over a non-quantity
    /// <c>Money</c> — must emit compiling / type-checking code on C#, TypeScript, AND Python in one
    /// place (PHP already proves this in <c>PhpConformanceTests</c>). The C# half always runs (Roslyn
    /// ships with the test host); the TS (<c>tsc</c>) and Python (<c>mypy --strict</c>) halves assert
    /// when their toolchain is present and are otherwise skipped — never a false pass on a missing
    /// toolchain, always a real assertion where one exists (as in CI). A regression on any of the
    /// three demand-driven operators (<c>operator +/-</c>, <c>add/subtract</c>, <c>__add__/__sub__</c>)
    /// is caught here.
    /// </summary>
    [Fact]
    public void Plain_value_object_arithmetic_compiles_across_targets()
    {
        const string koi = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0 "an amount cannot be negative"
              }
              value Line {
                base: Money
                combined: Money = base + base
                diff: Money = base - base
              }
            }
            """;

        // C#: emit + Roslyn compile. Always runs and always asserts (the strongest guarantee).
        CompileResult cs = new KoineCompiler().Compile(koi, new CSharpEmitter());
        cs.Success.ShouldBeTrue("C# emit failed:\n" + string.Join("\n", cs.Diagnostics.Select(d => d.ToString())));
        var (asm, csErrors) = TestSupport.Compile(cs.Files.ToList());
        (asm is not null).ShouldBeTrue("generated C# (plain VO arithmetic) failed to compile:\n" + string.Join("\n", csErrors));

        // TypeScript: emit + tsc --strict, asserted when the Node/tsc toolchain is present.
        CompileResult ts = new KoineCompiler().Compile(koi, new TypeScriptEmitter());
        ts.Success.ShouldBeTrue("TS emit failed:\n" + string.Join("\n", ts.Diagnostics.Select(d => d.ToString())));
        TestSupport.TypeScriptCheck tsCheck = TestSupport.TypeCheckTypeScript(ts.Files);
        if (tsCheck.ToolchainAvailable)
        {
            tsCheck.Ok.ShouldBeTrue("plain VO arithmetic should type-check under tsc --strict:\n" + string.Join("\n", tsCheck.Errors));
        }

        // Python: emit + mypy --strict, asserted when the mypy toolchain is present.
        CompileResult py = new KoineCompiler().Compile(koi, new PythonEmitter());
        py.Success.ShouldBeTrue("Python emit failed:\n" + string.Join("\n", py.Diagnostics.Select(d => d.ToString())));
        TestSupport.PythonCheck pyCheck = TestSupport.TypeCheckPython(py.Files);
        if (pyCheck.ToolchainAvailable)
        {
            pyCheck.Ok.ShouldBeTrue("plain VO arithmetic should type-check under mypy --strict:\n" + string.Join("\n", pyCheck.Errors));
        }

        // The C# half always asserts above; the TS and Python halves only assert when their toolchain
        // ran. Funnel each absence through RequireOrSkip AFTER the assertions (mirrors the Theory and
        // satisfies the NoSilentToolchainGate meta-test) so a missing toolchain reports Skipped — or, under
        // KOINE_REQUIRE_CONFORMANCE, Failed — instead of silently passing.
        TestSupport.RequireOrSkip(tsCheck.ToolchainAvailable, NoToolchainNotice);
        TestSupport.RequireOrSkip(pyCheck.ToolchainAvailable, NoPythonToolchainNotice);
    }

    private static string Verb(bool accepted) => accepted ? "ACCEPTED" : "REJECTED";

    // ---- C# side: Roslyn compile + reflective invoke --------------------------------------------

    private static bool[] RunCsharp(string koi, IReadOnlyList<Scenario> scenarios)
    {
        CompileResult emit = new KoineCompiler().Compile(koi, new CSharpEmitter());
        emit.Success.ShouldBeTrue("C# emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        var driver = new StringBuilder();
        driver.Append("namespace __Conformance { public static class Driver {\n");
        driver.Append("  public static bool[] Run() => new bool[] {\n");
        foreach (Scenario s in scenarios)
        {
            // Each scenario becomes a lambda that returns true if no exception escaped.
            string body = s.CsIsStatement ? s.Cs : "_ = " + s.Cs + ";";
            driver.Append("    ((System.Func<bool>)(() => { try { ")
                  .Append(body)
                  .Append(" return true; } catch { return false; } }))(),\n");
        }
        driver.Append("  };\n} }\n");

        var files = emit.Files.ToList();
        files.Add(new EmittedFile("__ConformanceDriver.cs", driver.ToString()));

        var (asm, errors) = TestSupport.Compile(files);
        (asm is not null).ShouldBeTrue("generated C# (with driver) failed to compile:\n" + string.Join("\n", errors));

        MethodInfo run = asm.GetType("__Conformance.Driver")!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!;
        return (bool[])run.Invoke(null, null)!;
    }

    // ---- TypeScript side: tsc transpile + node run ----------------------------------------------

    private readonly record struct TsRun(bool ToolchainAvailable, bool[] Outcomes);

    private static TsRun RunTypeScript(string koi, IReadOnlyList<Scenario> scenarios)
    {
        CompileResult emit = new KoineCompiler().Compile(koi, new TypeScriptEmitter());
        emit.Success.ShouldBeTrue("TS emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        // The driver prints one ACCEPT/REJECT line per scenario, in order. A scenario that throws (any
        // error — invariant violation or an explicit assertion failure) is a REJECT. Delegates the
        // transpile-with-tsc + run-with-node pipeline to the shared TestSupport helper (issue #938).
        TestSupport.NodeRun run = TestSupport.RunTypeScript(emit.Files, BuildTsDriver(scenarios));
        if (!run.ToolchainAvailable)
        {
            return new TsRun(ToolchainAvailable: false, Outcomes: Array.Empty<bool>());
        }

        run.Ok.ShouldBeTrue("TS transpile/run failed:\n" + string.Join("\n", run.Errors));

        bool[] outcomes = ParseDriverOutput(run.Stdout, scenarios.Count);
        return new TsRun(ToolchainAvailable: true, Outcomes: outcomes);
    }

    private static string BuildTsDriver(IReadOnlyList<Scenario> scenarios)
    {
        // Collect the union of imports the scenarios need (dedupe identical import lines).
        var imports = scenarios
            .SelectMany(s => s.TsImports.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct()
            .ToList();

        var sb = new StringBuilder();
        foreach (string imp in imports)
        {
            sb.Append(imp).Append('\n');
        }
        sb.Append('\n');
        sb.Append("const results: string[] = [];\n");
        foreach (Scenario s in scenarios)
        {
            string body = s.TsIsStatement ? s.Ts : "void (" + s.Ts + ");";
            sb.Append("try { ").Append(body).Append(" results.push('ACCEPT'); } ")
              .Append("catch { results.push('REJECT'); }\n");
        }
        sb.Append("console.log(results.join('\\n'));\n");
        return sb.ToString();
    }

    private static bool[] ParseDriverOutput(string stdout, int expected)
    {
        var lines = stdout
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(l => l is "ACCEPT" or "REJECT")
            .ToList();

        (lines.Count == expected).ShouldBeTrue($"TS driver printed {lines.Count} ACCEPT/REJECT lines, expected {expected}. Raw output:\n{stdout}");

        return lines.Select(l => l == "ACCEPT").ToArray();
    }

    /// <summary>
    /// One cross-emitter scenario: a domain operation expressed in both C# and TypeScript, plus the
    /// outcome (<see cref="Accept"/>) both backends are expected to produce for it.
    /// </summary>
    public sealed record Scenario(
        string Name,
        bool Accept,
        string Cs,
        string Ts,
        string TsImports,
        bool CsIsStatement = false,
        bool TsIsStatement = false);
}
