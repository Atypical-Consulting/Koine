using System.Diagnostics;
using System.Globalization;
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
[Collection(ScenarioSandboxCollection.Name)]
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

        ScenarioChildRun run = ScenarioExecutionHost.RunDetailed(sources, scenario, RoundTripBudget);
        string sandboxed = ScenarioService.WriteJson(WithoutSandboxNotes(run));

        // The emitted state machine really rejected the transition — proof the child EXECUTED the
        // generated code rather than falling back to an error tree or to the interpreter.
        sandboxed.ShouldContain("illegal transition of status to Cancelled");
        sandboxed.ShouldBe(inProcess);
    }

    /// <summary>
    /// The tree with exactly the notes the HOST appended subtracted (issue #1759). OS-level confinement
    /// degrades to a note on platforms that cannot provide a mechanism, so the sandbox's tree and the
    /// in-process engine's can legitimately differ by those notes and nothing else — subtracting them by
    /// identity, rather than by pattern-matching their wording, is what keeps that comparison honest.
    /// </summary>
    private static IReadOnlyDictionary<string, object?> WithoutSandboxNotes(ScenarioChildRun run)
    {
        if (run.SandboxNotes.Count == 0)
        {
            return run.Result;
        }

        var copy = new Dictionary<string, object?>(run.Result, StringComparer.Ordinal);
        object?[] notes = copy.TryGetValue("notes", out object? value) && value is object?[] array ? array : [];
        copy["notes"] = notes.Where(n => n is not string text || !run.SandboxNotes.Contains(text)).ToArray();
        return copy;
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

    // ------------------------------------------------------------------------
    // OS-level confinement (#1759): resource caps on top of the v1 boundary.
    //
    // These drive a STUB child through KOINE_SCENARIO_EXEC_COMMAND rather than the real
    // `koine scenario-exec`, because the property under test is what the sandbox does TO a child that
    // misbehaves — and the emitter, by design, cannot produce a model that misbehaves in these ways.
    // ------------------------------------------------------------------------

    /// <summary>A wall-clock budget far longer than the caps under test, so a run these tests expect to be
    /// stopped by a RESOURCE ceiling can never be stopped by the deadline instead.</summary>
    private static readonly TimeSpan CapBudget = TimeSpan.FromSeconds(30);

    /// <summary>The processor-time ceiling the cap tests ask for: low enough to be reached in about a
    /// second of spinning, high enough that no start-up cost trips it.</summary>
    private static readonly TimeSpan TightCpuLimit = TimeSpan.FromSeconds(1);

    /// <summary>A model small enough that the request fits a pipe buffer — the stub children never read
    /// stdin, and the content is irrelevant to them.</summary>
    private static IReadOnlyList<SourceFile> TrivialSources() =>
        [new SourceFile("stub.koi", "context Stub {\n}\n")];

    private static Scenario TrivialScenario() =>
        new(
            "Stub",
            "stub",
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal),
            new Dictionary<string, ScenarioValue>(StringComparer.Ordinal));

    [Fact]
    public void The_child_is_started_with_the_sandboxs_managed_heap_ceiling()
    {
        RequireUnixStubs();

        // Reported through the result tree rather than a scratch file: filesystem confinement is exactly
        // what would deny the child that file, so a stub that wrote one would be testing itself.
        string stub = WriteStub(Report("heap=${DOTNET_GCHeapHardLimit-}"));

        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default with { CpuLimit = null });

            run.Result["ok"].ShouldBe(true, ScenarioService.WriteJson(run.Result));

            // The ceiling reached the child THROUGH the environment scrub — the scrub clears the block
            // wholesale, so a confinement variable set before it would silently vanish.
            Probed(run).ShouldBe(
                "heap=" + ScenarioSandboxOptions.DefaultMemoryLimitBytes.ToString("X", CultureInfo.InvariantCulture));
        }
        finally
        {
            Forget(stub);
        }
    }

    [Fact]
    public void A_child_that_burns_past_the_processor_ceiling_is_reported_as_a_cap_not_a_timeout()
    {
        RequireUnixStubs();

        string stub = WriteStub("while :; do :; done\n");
        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default with { CpuLimit = TightCpuLimit });
            string tree = ScenarioService.WriteJson(run.Result);

            run.Result["ok"].ShouldBe(false, tree);

            // The distinction this test exists for: the deadline never expired, so the user must not be
            // told their model loops slowly when what it did was burn processor time against a ceiling.
            run.TimedOut.ShouldBeFalse(tree);
            tree.ShouldContain("PROCESSOR time");
            tree.ShouldNotContain("timed out");
        }
        finally
        {
            Forget(stub);
        }
    }

    [Fact]
    public void Without_a_processor_ceiling_the_same_child_is_only_stopped_by_the_deadline()
    {
        RequireUnixStubs();

        // The control for the test above: SAME child, confinement off. If it still came back as a cap
        // breach, the cap would be proving nothing — the wall-clock deadline would be doing all the work.
        string stub = WriteStub("while :; do :; done\n");
        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.None, TimeSpan.FromSeconds(3));
            string tree = ScenarioService.WriteJson(run.Result);

            run.TimedOut.ShouldBeTrue(tree);
            tree.ShouldContain("timed out");
            tree.ShouldNotContain("PROCESSOR time");
        }
        finally
        {
            Forget(stub);
        }
    }

    [Fact]
    public void Confinement_this_platform_cannot_provide_is_reported_in_the_tree_and_never_fails_the_run()
    {
        RequireUnixStubs();

        string stub = WriteStub(EchoResult);
        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default);

            // Whatever this platform could not enforce, the run still HAPPENED — that is the contract:
            // confinement never turns a working scenario into a failed one.
            run.Result["ok"].ShouldBe(true, ScenarioService.WriteJson(run.Result));

            // …and every degradation is visible to the user, not just to the caller holding the run.
            object?[] notes = (object?[])run.Result["notes"]!;
            foreach (string degradation in run.SandboxNotes)
            {
                notes.ShouldContain(degradation);
            }
        }
        finally
        {
            Forget(stub);
        }
    }

    // ------------------------------------------------------------------------
    // OS-level confinement (#1759): filesystem and network, where the platform has a mechanism.
    // ------------------------------------------------------------------------

    [Fact]
    public void A_confined_child_may_write_inside_its_run_directory_and_nowhere_else()
    {
        RequireUnixStubs();
        if (!ScenarioSandbox.FilesystemConfinementAvailable)
        {
            Assert.Skip("This platform has no filesystem confinement mechanism; degradation is asserted "
                + "by " + nameof(Confinement_this_platform_cannot_provide_is_reported_in_the_tree_and_never_fails_the_run)
                + ".");
        }

        string outside = Path.Combine(Path.GetTempPath(), "koine-outside-" + Guid.NewGuid().ToString("N") + ".txt");
        string stub = WriteStub(
            "inside=denied; outside=allowed\n"
            + "if : > ./inside.txt 2>/dev/null; then inside=allowed; fi\n"
            + "if : > '" + outside + "' 2>/dev/null; then outside=allowed; else outside=denied; fi\n"
            + Report("inside=${inside} outside=${outside}"));

        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default);

            // The run directory is the child's scratch space and must stay writable — a confinement that
            // also broke the legitimate write would be indistinguishable from a broken sandbox.
            Probed(run).ShouldBe("inside=allowed outside=denied");
            File.Exists(outside).ShouldBeFalse(outside);
        }
        finally
        {
            Forget(stub);
            Forget(outside);
        }
    }

    [Fact]
    public void A_confined_child_cannot_open_a_network_connection()
    {
        RequireUnixStubs();
        if (!ScenarioSandbox.NetworkConfinementAvailable)
        {
            Assert.Skip("This platform has no network confinement mechanism; degradation is asserted by "
                + nameof(Confinement_this_platform_cannot_provide_is_reported_in_the_tree_and_never_fails_the_run)
                + ".");
        }

        if (!File.Exists(BashPath))
        {
            // /bin/sh is dash on most Linuxes, and only bash speaks the /dev/tcp pseudo-device this probe
            // needs. Skipping is honest; asserting a connection succeeded would not be.
            Assert.Skip("The network probe needs " + BashPath + ".");
        }

        // 203.0.113.0/24 is TEST-NET-3 (RFC 5737): reserved for documentation, so an UNCONFINED attempt
        // fails by timing out rather than by reaching anything — and the confined one fails INSTANTLY,
        // which is what the short shell timeout below distinguishes.
        string stub = WriteStub(
            "network=allowed\n"
            + "if ! (exec 3<>/dev/tcp/203.0.113.1/80) 2>/dev/null; then network=denied; fi\n"
            + Report("network=${network}"),
            BashPath);

        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default, TimeSpan.FromSeconds(20));
            Probed(run).ShouldBe("network=denied");
        }
        finally
        {
            Forget(stub);
        }
    }

    [Fact]
    public void A_plan_reports_a_degradation_for_exactly_what_this_platform_cannot_enforce()
    {
        string runDirectory = Path.Combine(Path.GetTempPath(), "koine-plan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(runDirectory);
        try
        {
            using ScenarioConfinement full = ScenarioSandbox.Plan(
                "koine", ["scenario-exec"], runDirectory, ScenarioSandboxOptions.Default);

            bool everything = ScenarioSandbox.FilesystemConfinementAvailable
                && ScenarioSandbox.NetworkConfinementAvailable;
            if (everything)
            {
                full.Degradations.ShouldBeEmpty();
            }
            else
            {
                full.Degradations.ShouldNotBeEmpty(
                    "a platform that cannot enforce everything must SAY which part it dropped");
            }

            // Nothing requested, nothing to degrade — and the command comes back untouched, which is what
            // makes "confinement off" a real state rather than a differently-worded confinement.
            using ScenarioConfinement none = ScenarioSandbox.Plan(
                "koine", ["scenario-exec"], runDirectory, ScenarioSandboxOptions.None);
            none.Degradations.ShouldBeEmpty();
            none.FileName.ShouldBe("koine");
            none.Arguments.ShouldBe(["scenario-exec"]);
            none.Environment.ShouldBeEmpty();
        }
        finally
        {
            try
            {
                Directory.Delete(runDirectory, recursive: true);
            }
            catch (Exception)
            {
                // A leftover temp directory is not a test failure.
            }
        }
    }

    private const string BashPath = "/bin/bash";

    /// <summary>What a probing stub reported, carried out in the result tree's <c>result</c> field — the
    /// one channel a confined child is guaranteed to have, since every file it might otherwise write to
    /// is exactly what the confinement is denying.</summary>
    private static string? Probed(ScenarioChildRun run) => run.Result["result"] as string;

    /// <summary>Shell that prints a valid result tree carrying <paramref name="findings"/> as its result.</summary>
    private static string Report(string findings) =>
        "printf '{\"ok\":true,\"target\":\"Stub\",\"operation\":\"stub\",\"mode\":\"executed\","
        + "\"steps\":[],\"resultingState\":{},\"invariants\":[],\"result\":\"%s\",\"notes\":[]}' \""
        + findings + "\"\n";

    /// <summary>A minimal, valid result tree — everything the protocol reader needs from a stub child.</summary>
    private const string EchoResult =
        "printf '%s' '{\"ok\":true,\"target\":\"Stub\",\"operation\":\"stub\",\"mode\":\"executed\","
        + "\"steps\":[],\"resultingState\":{},\"invariants\":[],\"result\":null,\"notes\":[]}'\n";

    /// <summary>Runs a stub child under <paramref name="options"/>, restoring the command override
    /// afterwards so no other test in this class inherits it.</summary>
    private static ScenarioChildRun RunStub(string stub, ScenarioSandboxOptions options, TimeSpan? budget = null)
    {
        string? previous = Environment.GetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable);
        Environment.SetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable, stub);
        try
        {
            return ScenarioExecutionHost.RunDetailed(
                TrivialSources(), TrivialScenario(), budget ?? CapBudget, options);
        }
        finally
        {
            Environment.SetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable, previous);
        }
    }

    /// <summary>Writes an executable stub child, POSIX-sh unless a richer shell is asked for.</summary>
    private static string WriteStub(string body, string interpreter = "/bin/sh")
    {
        string path = Path.Combine(Path.GetTempPath(), "koine-stub-" + Guid.NewGuid().ToString("N") + ".sh");
        File.WriteAllText(path, "#!" + interpreter + "\n" + body);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        return path;
    }

    /// <summary>The stub children are POSIX-sh, and the confinement they exercise is the Unix one. Windows
    /// has its own mechanism (a Job Object) with no shell-scriptable equivalent, so skip rather than
    /// assert something this platform never promised.</summary>
    private static void RequireUnixStubs()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("The sandbox's Unix confinement is exercised with POSIX-sh stub children.");
        }
    }

    private static void Forget(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception)
        {
            // A leftover temp file is not a test failure.
        }
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
