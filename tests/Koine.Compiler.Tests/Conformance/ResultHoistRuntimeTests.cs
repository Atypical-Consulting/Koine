using System.Reflection;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Issue #1838, the BEHAVIORAL half: for a command whose <c>result</c> expression is also a whole
/// <c>emit</c>/<c>publish</c> payload argument, the value the command RETURNS and the value the events
/// RECORD must be the SAME value — asserted by EXECUTING the emitted code, on every target whose
/// conformance harness runs it.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="ResultHoistParityTests"/> pins the emitted TEXT (exactly one clock read per command body,
/// across all seven code targets). That is a proxy: it says the shape is right, not that the shape
/// produces the right answer. This suite states the contract the shape exists to satisfy, as a runtime
/// EQUALITY over a genuinely non-deterministic expression (<c>now</c>) — the assertion that actually
/// fails when a target re-renders the expression instead of reading the hoisted local.
/// </para>
/// <para>
/// The model's <c>close</c> command shares ONE <c>now</c> across three sites — a domain event payload, an
/// integration event payload, and the return — so each target's driver reads all three back and demands
/// that the two recorded instants equal the returned one. Two renderings of <c>now</c> are two reads of
/// the clock, so a regressed emitter yields a recorded instant strictly BEFORE the returned one: the
/// recorded history and the caller's answer would then be different facts. Every driver repeats the
/// exercise <see cref="Iterations"/> times, because the divergence is a race with the host clock's tick
/// and one attempt can land inside a tick — the pre-fix ad-hoc measurement on Java saw 193 of 200
/// iterations diverge, so a run of this size makes the detector reliable rather than lucky.
/// </para>
/// <para>
/// <b>Which targets are here, and why not the other two.</b> Five of the seven code backends have a
/// conformance harness that EXECUTES emitted code: C# (Roslyn compile + reflective invoke — always runs,
/// no external toolchain), TypeScript (<c>tsc</c> + <c>node</c>), Python (<c>python</c>), PHP
/// (<c>php</c>) and Rust (<c>cargo test</c>). Java and Kotlin are absent on purpose: their harnesses
/// (<see cref="TestSupport.CompileJava"/>, <see cref="TestSupport.CompileKotlin"/>) only COMPILE, so
/// there is no place to assert a runtime equality for them — the textual parity suite plus their own
/// compile checks remain their coverage. Each toolchain-dependent half funnels its absence through
/// <see cref="TestSupport.RequireOrSkip(bool, string)"/>, so a missing toolchain is Skipped locally and
/// a hard Failed under <c>KOINE_REQUIRE_CONFORMANCE</c> (as in CI) — never a silent pass.
/// </para>
/// <para>
/// <b>Detection strength differs by target, the contract does not.</b> The clock resolution behind each
/// target's <c>now</c> sets how often a duplicated rendering is actually observable: Rust
/// (<c>SystemTime::now</c>, nanoseconds), Python/PHP (microseconds) and C# (<c>DateTimeOffset.UtcNow</c>)
/// diverge readily, while TypeScript's <c>Instant.now()</c> is an ISO-8601 string at MILLISECOND
/// resolution and would often round two adjacent reads to the same text. So the TypeScript case is a
/// weaker detector by nature — it is still the correct statement of the contract, and the textual
/// one-clock-read guarantee for TypeScript is asserted unconditionally by
/// <see cref="ResultHoistParityTests"/>.
/// </para>
/// </remarks>
public class ResultHoistRuntimeTests
{
    /// <summary>
    /// How many times each driver re-runs the command. Large enough that a duplicated clock read is
    /// observed rather than hidden inside a single tick (see the class remarks).
    /// </summary>
    private const int Iterations = 200;

    private const string NoNodeToolchainNotice =
        "No Node/TypeScript toolchain (tsc + node) available locally; the TypeScript half of the " +
        "result-hoist runtime equality was not executed. Install Node + TypeScript (or set KOINE_TSC/" +
        "KOINE_NODE) — CI runs it for real.";

    private const string NoPythonInterpreterNotice =
        "No Python interpreter available locally; the Python half of the result-hoist runtime equality " +
        "was not executed. Install Python (or set KOINE_PYTHON) — CI runs it for real.";

    private const string NoPhpInterpreterNotice =
        "No php interpreter available locally; the PHP half of the result-hoist runtime equality was not " +
        "executed. Install PHP (or set KOINE_PHP) — CI runs it for real.";

    private const string NoCargoToolchainNotice =
        "No Rust toolchain (cargo) available locally; the Rust half of the result-hoist runtime equality " +
        "was not executed. Install Rust (or set KOINE_CARGO) — CI runs it for real.";

    /// <summary>
    /// One command sharing a single <c>now</c> across a domain event payload, an integration event
    /// payload and the return value — the (c) sub-shape of <see cref="ResultHoistParityTests"/>, chosen
    /// here because it is the shape where a regression makes THREE facts disagree at once.
    /// </summary>
    private const string Model = """
        context Sales {
          publishes Settled

          integration event Settled {
            at: Instant
          }

          aggregate Ordering root Order {
            event ClosedInternally { at: Instant }

            entity Order identified by OrderId {
              note: String

              command close: Instant {
                emit ClosedInternally(at: now)
                publish Settled(at: now)
                result now
              }
            }
          }
        }
        """;

    // ---- C#: Roslyn compile + reflective invoke (no external toolchain, always runs) ---------------

    /// <summary>
    /// The unconditional half of the proof: the emitted C# is compiled in-memory by Roslyn and the
    /// command is actually invoked, so this assertion runs on every machine and every CI leg regardless
    /// of which foreign toolchains are installed. The driver returns an empty string on success and a
    /// diagnostic naming the two disagreeing instants otherwise, so a failure reports the divergence
    /// itself rather than a bare boolean.
    /// </summary>
    [Fact]
    public void Csharp_records_the_instant_it_returns()
    {
        CompileResult emit = new KoineCompiler().Compile(Model, new CSharpEmitter());
        emit.Success.ShouldBeTrue("C# emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        string driver = $$"""
            namespace __ResultHoist;

            public static class Driver
            {
                public static string Run()
                {
                    for (int i = 0; i < {{Iterations}}; i++)
                    {
                        var order = new Sales.Order(Sales.OrderId.New(), "note");
                        var returned = order.Close();
                        var recorded = ((Sales.ClosedInternally)order.DomainEvents[0]).At;
                        var published = ((Sales.Settled)order.IntegrationEvents[0]).At;

                        if (recorded != returned)
                        {
                            return $"iteration {i}: the domain event recorded {recorded:O} but the command returned {returned:O}";
                        }

                        if (published != returned)
                        {
                            return $"iteration {i}: the integration event recorded {published:O} but the command returned {returned:O}";
                        }
                    }

                    return "";
                }
            }
            """;

        var files = emit.Files.ToList();
        files.Add(new EmittedFile("__ResultHoistDriver.cs", driver));

        var (assembly, errors) = TestSupport.Compile(files);
        (assembly is not null).ShouldBeTrue(
            "generated C# (with the result-hoist driver) failed to compile:\n" + string.Join("\n", errors));

        MethodInfo run = assembly.GetType("__ResultHoist.Driver")!
            .GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!;

        ((string)run.Invoke(null, null)!).ShouldBe(
            string.Empty,
            "C#: a result expression shared with an emit and a publish payload must be evaluated ONCE, " +
            "so the recorded payload and the returned value are the same instant.");
    }

    // ---- TypeScript: tsc transpile + node run ------------------------------------------------------

    /// <summary>
    /// The TypeScript half, executed under <c>node</c> after a <c>tsc --strict</c> transpile. Weaker as a
    /// detector than the other four (this target's <c>Instant</c> is a millisecond-resolution ISO string —
    /// see the class remarks), but the same contract, and it also proves the hoisted local is genuinely
    /// readable at all three sites rather than merely present in the text.
    /// </summary>
    [Fact]
    public void TypeScript_records_the_instant_it_returns()
    {
        CompileResult emit = new KoineCompiler().Compile(Model, new TypeScriptEmitter());
        emit.Success.ShouldBeTrue("TS emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        string driver = $$"""
            import { Order } from './Sales/Order';
            import { OrderIdNew } from './Sales/value-objects/OrderId';
            import { ClosedInternally } from './Sales/events/ClosedInternally';
            import { Settled } from './Sales/integration-events/Settled';

            for (let i = 0; i < {{Iterations}}; i++) {
              const order = new Order(OrderIdNew(), 'note');
              const returned = order.close();
              const recorded = (order.domainEvents[0] as ClosedInternally).at;
              const published = (order.integrationEvents[0] as Settled).at;

              if (recorded !== returned) {
                throw new Error(`iteration ${i}: the domain event recorded ${recorded} but the command returned ${returned}`);
              }

              if (published !== returned) {
                throw new Error(`iteration ${i}: the integration event recorded ${published} but the command returned ${returned}`);
              }
            }
            """;

        TestSupport.NodeRun run = TestSupport.RunTypeScript(emit.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoNodeToolchainNotice);

        run.Ok.ShouldBeTrue(
            "TypeScript: the recorded payload and the returned value must be the same instant:\n" +
            string.Join("\n", run.Errors));
    }

    // ---- Python: interpreter run ------------------------------------------------------------------

    /// <summary>
    /// The Python half. Its <c>Instant.now()</c> is a microsecond-resolution <c>datetime</c>, so a
    /// duplicated rendering diverges readily — this is one of the two targets whose ad-hoc pre-fix
    /// measurement showed the defect directly.
    /// </summary>
    [Fact]
    public void Python_records_the_instant_it_returns()
    {
        CompileResult emit = new KoineCompiler().Compile(Model, new PythonEmitter());
        emit.Success.ShouldBeTrue("Python emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        string driver = $$"""
            from sales.order import Order
            from sales.value_objects.order_id import OrderId

            for i in range({{Iterations}}):
                order = Order(OrderId.new(), "note")
                returned = order.close()
                recorded = order.domain_events[0].at
                published = order.integration_events[0].at

                assert recorded == returned, (
                    f"iteration {i}: the domain event recorded {recorded} "
                    f"but the command returned {returned}"
                )
                assert published == returned, (
                    f"iteration {i}: the integration event recorded {published} "
                    f"but the command returned {returned}"
                )
            """;

        TestSupport.PythonCheck run = TestSupport.RunPython(emit.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoPythonInterpreterNotice);

        run.Ok.ShouldBeTrue(
            "Python: the recorded payload and the returned value must be the same instant:\n" +
            string.Join("\n", run.Errors));
    }

    // ---- PHP: interpreter run ---------------------------------------------------------------------

    /// <summary>
    /// The PHP half. <c>new \DateTimeImmutable('now')</c> carries microseconds, and the pre-fix ad-hoc
    /// measurement here showed an 8µs gap between the recorded payload and the returned value — exactly
    /// the divergence this assertion now forbids permanently.
    /// </summary>
    [Fact]
    public void Php_records_the_instant_it_returns()
    {
        CompileResult emit = new KoineCompiler().Compile(Model, new PhpEmitter());
        emit.Success.ShouldBeTrue("PHP emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        string driver = $$"""
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Sales/ValueObjects/OrderId.php';
            require __DIR__ . '/src/Sales/Events/ClosedInternally.php';
            require __DIR__ . '/src/Sales/Events/Settled.php';
            require __DIR__ . '/src/Sales/Entities/Order.php';

            for ($i = 0; $i < {{Iterations}}; $i++) {
                $order = new Koine\Sales\Entities\Order(
                    Koine\Sales\ValueObjects\OrderId::generate(),
                    'note'
                );
                $returned = $order->close();
                $recorded = $order->domainEvents()[0]->at;
                $published = $order->integrationEvents()[0]->at;

                if ($recorded->format('Y-m-d\TH:i:s.u') !== $returned->format('Y-m-d\TH:i:s.u')) {
                    fwrite(STDERR, "iteration {$i}: the domain event recorded "
                        . $recorded->format('Y-m-d\TH:i:s.u') . " but the command returned "
                        . $returned->format('Y-m-d\TH:i:s.u') . "\n");
                    exit(1);
                }

                if ($published->format('Y-m-d\TH:i:s.u') !== $returned->format('Y-m-d\TH:i:s.u')) {
                    fwrite(STDERR, "iteration {$i}: the integration event recorded "
                        . $published->format('Y-m-d\TH:i:s.u') . " but the command returned "
                        . $returned->format('Y-m-d\TH:i:s.u') . "\n");
                    exit(1);
                }
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(emit.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoPhpInterpreterNotice);

        run.Ok.ShouldBeTrue(
            "PHP: the recorded payload and the returned value must be the same instant:\n" +
            string.Join("\n", run.Errors));
    }

    // ---- Rust: cargo test -------------------------------------------------------------------------

    /// <summary>
    /// The Rust half, run as a real <c>cargo test</c>. Its <c>Instant</c> is a nanosecond-resolution
    /// <c>SystemTime</c>, making it the sharpest detector of the five; it is also the target where the
    /// hoist had to make a borrow-checker decision (a <c>Copy</c> <c>Instant</c> is read directly, a
    /// non-<c>Copy</c> payload clones — see <c>RustConformanceTests</c>), so executing it proves the
    /// chosen reads observe one value rather than merely satisfying <c>cargo check</c>.
    /// </summary>
    [Fact]
    public void Rust_records_the_instant_it_returns()
    {
        CompileResult emit = new KoineCompiler().Compile(Model, new RustEmitter());
        emit.Success.ShouldBeTrue("Rust emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        string integrationTest = $$"""
            use koine_domain::sales::{DomainEvent, Order, OrderId};

            #[test]
            fn recorded_payload_equals_the_returned_value() {
                for i in 0..{{Iterations}} {
                    let mut order = Order::new(OrderId::new("o"), "note".to_string()).expect("valid Order");
                    let returned = order.close().expect("close succeeds");

                    let recorded = match &order.events()[0] {
                        DomainEvent::ClosedInternally(e) => e.at,
                        other => panic!("expected a ClosedInternally, got {other:?}"),
                    };
                    let published = match &order.integration_events()[0] {
                        DomainEvent::Settled(e) => e.at,
                        other => panic!("expected a Settled, got {other:?}"),
                    };

                    assert_eq!(recorded, returned, "iteration {i}: the domain event recorded a different instant");
                    assert_eq!(published, returned, "iteration {i}: the integration event recorded a different instant");
                }
            }
            """;

        TestSupport.RustCheck run = TestSupport.RunRust(emit.Files, integrationTest);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoCargoToolchainNotice);

        run.Ok.ShouldBeTrue(
            "Rust: the recorded payload and the returned value must be the same instant:\n" +
            string.Join("\n", run.Errors));
    }
}
