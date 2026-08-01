using System.Diagnostics;
using Koine.Compiler.Ast;
using Koine.Compiler.Semantics.Scenarios;
using Koine.Compiler.Services;
using Koine.Execution;

namespace Koine.Compiler.Tests;

/// <summary>
/// The scenario-execution SANDBOX (#236, ADR 0011): executed mode never runs the model's emitted C#
/// inside the editor backend. <see cref="ScenarioExecutionHost"/> spawns the hidden
/// <c>koine scenario-exec</c> child, streams the request over stdio, and enforces a wall-clock deadline
/// it can actually meet — because a runaway managed thread cannot be aborted in-process, only a process
/// can be killed.
///
/// <para>Three properties are pinned here: the child returns EXACTLY the tree the in-process
/// <see cref="ScenarioExecutor"/> returns (so the sandbox is invisible to the contract), a child that
/// outlives its deadline is killed and reported as a not-ok result with a timeout note, and the per-run
/// temp directory is gone afterwards even on the kill path.</para>
/// </summary>
public class ScenarioSandboxTests
{
    /// <summary>A generous budget for the honest round-trip: the child parses, emits, Roslyn-compiles and
    /// runs the whole pizzeria model in a cold process.</summary>
    private static readonly TimeSpan RoundTripBudget = TimeSpan.FromMinutes(2);

    /// <summary>A deadline no child can meet: starting a .NET process and compiling the pizzeria model
    /// takes seconds, so the watchdog path is deterministic rather than timing-sensitive.</summary>
    private static readonly TimeSpan ImpossibleBudget = TimeSpan.FromMilliseconds(250);

    // ------------------------------------------------------------------------
    // Fixture: the pizzeria template's sources (the request carries SOURCE, so the
    // child owns parsing, emitting and compiling too — the host runs none of it).
    // ------------------------------------------------------------------------

    private static readonly Lazy<IReadOnlyList<SourceFile>> Pizzeria = new(LoadPizzeria);

    private static IReadOnlyList<SourceFile> LoadPizzeria() =>
        Directory
            .EnumerateFiles(PizzeriaFolder(), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

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

    /// <summary>
    /// A fully DETERMINISTIC scenario: cancelling an already-<c>Cancelled</c> order. Its two
    /// <c>requires</c> pass and the emitted state machine then rejects <c>status -&gt; Cancelled</c>, so the
    /// timeline carries no clock stamp (unlike <c>place</c>, which writes <c>placedAt = now</c>) and the
    /// child's tree can be compared byte-for-byte with the in-process one.
    /// </summary>
    private static Scenario CancelACancelledOrder() =>
        new(
            Target: "Order",
            Operation: "cancel",
            Given: new Dictionary<string, ScenarioValue>(StringComparer.Ordinal)
            {
                ["customer"] = ScenarioValue.FromString("11111111-1111-1111-1111-111111111111"),
                ["fulfillment"] = ScenarioValue.Enum("Delivery"),
                ["lines"] = ScenarioValue.ListOf(ScenarioValue.RecordOf(
                    ("pizza", ScenarioValue.FromString("MARG")),
                    ("quantity", ScenarioValue.FromInt(1)),
                    ("unitPrice", ScenarioValue.RecordOf(
                        ("amount", ScenarioValue.FromDecimal(10m)),
                        ("currency", ScenarioValue.Enum("EUR")))))),
                ["status"] = ScenarioValue.Enum("Cancelled"),
            },
            Args: new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

    // ------------------------------------------------------------------------
    // The sandbox is invisible to the contract.
    // ------------------------------------------------------------------------

    [Fact]
    public void The_child_process_returns_the_same_result_tree_as_the_in_process_executor()
    {
        IReadOnlyList<SourceFile> sources = Pizzeria.Value;
        Scenario scenario = CancelACancelledOrder();

        var (model, diagnostics) = new KoineCompiler().Parse(sources);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        string inProcess = ScenarioService.WriteJson(
            ScenarioService.Shape(
                ScenarioExecutor.Run(new SemanticModel(model), scenario), ScenarioService.ExecutedMode));

        IReadOnlyDictionary<string, object?> viaChild = ScenarioExecutionHost.Run(sources, scenario, RoundTripBudget);
        string sandboxed = ScenarioService.WriteJson(viaChild);

        // The emitted state machine really rejected the transition — proof the child EXECUTED the
        // generated code rather than falling back to an error tree or to the interpreter.
        sandboxed.ShouldContain("illegal transition of status to Cancelled");
        sandboxed.ShouldBe(inProcess);
    }

    // ------------------------------------------------------------------------
    // The watchdog: a child that outlives its deadline is killed, not waited on.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_child_that_outlives_its_deadline_is_killed_and_reported_as_not_ok()
    {
        IReadOnlyList<SourceFile> sources = Pizzeria.Value;
        Scenario scenario = CancelACancelledOrder();

        var elapsed = Stopwatch.StartNew();
        ScenarioChildRun run = ScenarioExecutionHost.RunDetailed(sources, scenario, ImpossibleBudget);
        elapsed.Stop();

        run.TimedOut.ShouldBeTrue(ScenarioService.WriteJson(run.Result));
        run.Result["ok"].ShouldBe(false);
        ScenarioService.WriteJson(run.Result).ShouldContain("timed out");

        // The deadline is a real deadline: the host returned in a bounded time, nowhere near the
        // seconds a full emit + compile + run would have taken.
        elapsed.Elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(30));

        // The child is really gone (process tree killed and reaped), not merely abandoned.
        run.ChildProcessId.ShouldBeGreaterThan(0);
        ProcessIsGone(run.ChildProcessId).ShouldBeTrue($"process {run.ChildProcessId} outlived the kill");

        // …and the HOST is unaffected: it still runs scenarios on the same model right afterwards.
        var (model, _) = new KoineCompiler().Parse(sources);
        model.ShouldNotBeNull();
        ScenarioInterpreter.Run(new SemanticModel(model), scenario).Target.ShouldBe("Order");
    }

    // ------------------------------------------------------------------------
    // Cleanup happens on every path — including the kill path.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_killed_child_leaves_no_temp_run_directory_behind()
    {
        ScenarioChildRun run = ScenarioExecutionHost.RunDetailed(
            Pizzeria.Value, CancelACancelledOrder(), ImpossibleBudget);

        run.TimedOut.ShouldBeTrue(ScenarioService.WriteJson(run.Result));
        run.RunDirectory.ShouldNotBeNullOrEmpty();
        // POLLED, like ProcessIsGone: cleanup is deliberately best-effort with a bounded retry, because
        // on Windows the run directory is the killed child's cwd and the OS holds a handle on it until
        // the process is fully reaped. Asserting once, immediately, would be asserting a guarantee the
        // code does not make — and would flake on Windows only, where CI never looks.
        DirectoryIsGone(run.RunDirectory).ShouldBeTrue(run.RunDirectory);
    }

    /// <summary>Polls (bounded) until <paramref name="directory"/> is gone — the host's own cleanup retries
    /// for a couple of seconds, so the assertion waits at least as long before calling it a leak.</summary>
    private static bool DirectoryIsGone(string directory)
    {
        for (int attempt = 0; attempt < 50; attempt++)
        {
            if (!Directory.Exists(directory))
            {
                return true;
            }

            Thread.Sleep(100);
        }

        return false;
    }

    /// <summary>Polls (bounded) until <paramref name="pid"/> names no live process.</summary>
    private static bool ProcessIsGone(int pid)
    {
        for (int attempt = 0; attempt < 50; attempt++)
        {
            try
            {
                using Process process = Process.GetProcessById(pid);
                if (process.HasExited)
                {
                    return true;
                }
            }
            catch (ArgumentException)
            {
                return true; // no process with that id — the kill landed
            }
            catch (InvalidOperationException)
            {
                return true;
            }

            Thread.Sleep(100);
        }

        return false;
    }
}
