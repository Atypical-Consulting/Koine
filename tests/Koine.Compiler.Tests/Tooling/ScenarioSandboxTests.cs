using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
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
        // Reported through the result tree rather than a scratch file: filesystem confinement is exactly
        // what would deny the child that file, so a stub that wrote one would be testing itself.
        string stub = WriteStub(Report("heap=" + EnvRef("DOTNET_GCHeapHardLimit")));

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

    /// <summary>A ceiling the real child cannot finish a compile under, but can still START under — so the
    /// run reaches the executor and fails there, which is where the ceiling has to be recognised.</summary>
    private const long ExhaustibleMemoryLimitBytes = 16L << 20;

    [Fact]
    public void A_run_that_exhausts_the_memory_ceiling_names_it_instead_of_reporting_a_generic_fault()
    {
        // The REAL child, not a stub: the ceiling surfaces as an OutOfMemoryException deep inside the
        // executor, which catches every exception around both the emit/compile step and the reflective
        // invoke — so a handler placed anywhere further out never sees it and the ceiling goes unnamed.
        ScenarioChildRun run = ScenarioExecutionHost.RunDetailed(
            Pizzeria.Value,
            CancelACancelledOrder(),
            RoundTripBudget,
            ScenarioSandboxOptions.Default with { MemoryLimitBytes = ExhaustibleMemoryLimitBytes });

        string tree = ScenarioService.WriteJson(run.Result);
        run.Result["ok"].ShouldBe(false, tree);
        run.TimedOut.ShouldBeFalse(tree);

        // Named, and named with the ceiling that was actually in force — not "OutOfMemoryException", which
        // reads as a machine problem rather than a model-derived allocation meeting its budget.
        tree.ShouldContain("memory ceiling of 16 MiB");
        tree.ShouldNotContain("timed out");
    }

    [Fact]
    public void A_child_that_burns_past_the_processor_ceiling_is_reported_as_a_cap_not_a_timeout()
    {
        string stub = WriteStub(SpinLoop());
        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default with { CpuLimit = TightCpuLimit });
            string tree = ScenarioService.WriteJson(run.Result);

            run.Result["ok"].ShouldBe(false, tree);

            // The distinction this test exists for: the deadline never expired, so the user must not be
            // told their model loops slowly when what it did was burn processor time against a ceiling.
            // The whole tree is the failure message — which shell and kernel a platform uses decides
            // whether the child is signalled or killed outright, and the note names the exit code.
            run.TimedOut.ShouldBeFalse(tree);
            tree.ShouldContain("PROCESSOR time", customMessage: tree);
            tree.ShouldNotContain("timed out", customMessage: tree);
        }
        finally
        {
            Forget(stub);
        }
    }

    [Fact]
    public void Without_a_processor_ceiling_the_same_child_is_only_stopped_by_the_deadline()
    {
        // The control for the test above: SAME child, confinement off. If it still came back as a cap
        // breach, the cap would be proving nothing — the wall-clock deadline would be doing all the work.
        string stub = WriteStub(SpinLoop());
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
        string stub = WriteStub(EchoResult);
        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default);

            // Whatever this platform could not enforce, the run still HAPPENED — that is the contract:
            // confinement never turns a working scenario into a failed one.
            run.Result["ok"].ShouldBe(true, ScenarioService.WriteJson(run.Result));

            // …and every degradation is visible to the user, not just to the caller holding the run.
            // Exactly the degradations, nothing invented: the stub reports no notes of its own, so the
            // tree's note count IS the confinement's — an over-append would fail here just as a missing
            // one would.
            object?[] notes = (object?[])run.Result["notes"]!;
            notes.Length.ShouldBe(run.SandboxNotes.Count, ScenarioService.WriteJson(run.Result));
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
        RequireFilesystemConfinement();

        string outside = Path.Combine(Path.GetTempPath(), "koine-outside-" + Guid.NewGuid().ToString("N") + ".txt");
        string stub = WriteStub(WriteProbe("./inside.txt", outside) + Report("inside=${inside} outside=${outside}"));

        try
        {
            ScenarioChildRun run = RunStub(stub, ScenarioSandboxOptions.Default);

            // The run directory is the child's scratch space and must stay writable — a confinement that
            // also broke the legitimate write would be indistinguishable from a broken sandbox.
            Probed(run).ShouldBe("inside=allowed outside=denied");
            File.Exists(outside).ShouldBeFalse(outside);

            // The control: the SAME child, confinement off, gets the write it was just denied. Without
            // this the assertion above would also pass if the write had failed for some unrelated reason.
            Forget(outside);
            Probed(RunStub(stub, ScenarioSandboxOptions.None)).ShouldBe("inside=allowed outside=allowed");
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
        RequireNetworkConfinement();

        if (!File.Exists(BashPath))
        {
            // /bin/sh is dash on most Linuxes, and only bash speaks the /dev/tcp pseudo-device this probe
            // needs. Skipping is honest; asserting a connection succeeded would not be.
            Assert.Skip("The network probe needs " + BashPath + ".");
        }

        // A socket this test OWNS, listening on loopback. Reaching a real address would make "denied" and
        // "there is no route from this machine" the same observation; a listener we know is accepting
        // makes the control below meaningful — unconfined, the connection MUST succeed.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;

        string stub = WriteStub(
            "network=allowed\n"
            + "if ! (exec 3<>/dev/tcp/127.0.0.1/" + port.ToString(CultureInfo.InvariantCulture)
            + ") 2>/dev/null; then network=denied; fi\n"
            + Report("network=${network}"),
            BashPath);

        try
        {
            Probed(RunStub(stub, ScenarioSandboxOptions.Default)).ShouldBe("network=denied");

            // The control: same child, same listener, confinement off — it connects.
            Probed(RunStub(stub, ScenarioSandboxOptions.None)).ShouldBe("network=allowed");
        }
        finally
        {
            Forget(stub);
            listener.Stop();
        }
    }

    /// <summary>
    /// A POSIX-sh probe that tries to create <paramref name="inside"/> and <paramref name="outside"/> and
    /// leaves the verdicts in <c>$inside</c> / <c>$outside</c>.
    ///
    /// <para>Each redirection runs in a SUBSHELL on purpose. <c>:</c> is a POSIX special built-in, and a
    /// redirection error on one of those makes a conforming shell exit — which <c>dash</c>, the
    /// <c>/bin/sh</c> of most Linuxes, actually does. Written the obvious way, the very denial this probe
    /// exists to observe would kill the probe before it could report it, and the test would read a broken
    /// shell as a broken sandbox.</para>
    /// </summary>
    private static string WriteProbe(string inside, string outside) =>
        "inside=denied; outside=denied\n"
        + "if ( : > '" + inside + "' ) 2>/dev/null; then inside=allowed; fi\n"
        + "if ( : > '" + outside + "' ) 2>/dev/null; then outside=allowed; fi\n";

    /// <summary>
    /// Gates the filesystem-enforcement test. Deliberately NOT a bare skip on
    /// <see cref="ScenarioSandbox.FilesystemConfinementAvailable"/>: that is the very predicate the
    /// production path consults, so skipping on it would turn a broken probe — confinement silently lost
    /// everywhere — into a green run with a skip. On macOS, which always ships <c>sandbox-exec</c>, and on
    /// a Linux whose kernel reports a Landlock ABI, an unavailable mechanism is a REGRESSION and fails here.
    /// </summary>
    private static void RequireFilesystemConfinement()
    {
        if (OperatingSystem.IsMacOS())
        {
            ScenarioSandbox.FilesystemConfinementAvailable.ShouldBeTrue(
                "macOS ships /usr/bin/sandbox-exec, so filesystem confinement being unavailable here is a "
                + "regression in the sandbox, not a fact about the platform");
            return;
        }

        if (OperatingSystem.IsLinux())
        {
            if (LinuxLandlock.AbiVersion < 1)
            {
                Assert.Skip("This kernel reports no Landlock ABI (needs 5.13+ with Landlock enabled), so "
                    + "the degradation reported instead is asserted by "
                    + nameof(Confinement_this_platform_cannot_provide_is_reported_in_the_tree_and_never_fails_the_run)
                    + ".");
                return;
            }

            ScenarioSandbox.FilesystemConfinementAvailable.ShouldBeTrue(
                "this kernel reports Landlock ABI v" + LinuxLandlock.AbiVersion
                + ", so filesystem confinement being unavailable here is a regression in the sandbox "
                + "(most likely the launcher verb no longer resolving), not a fact about the platform");
            return;
        }

        Assert.Skip("Only macOS and Landlock-capable Linux have a filesystem confinement mechanism today; "
            + "the degradation every other platform reports instead is asserted by "
            + nameof(Confinement_this_platform_cannot_provide_is_reported_in_the_tree_and_never_fails_the_run)
            + ".");
    }

    // ------------------------------------------------------------------------
    // Linux write confinement (#1781): a Landlock ruleset installed by a launcher that execs the command.
    // ------------------------------------------------------------------------

    [Fact]
    public void The_Landlock_ABI_this_kernel_speaks_is_settled_and_costs_no_child_process()
    {
        if (!OperatingSystem.IsLinux())
        {
            Assert.Skip("Landlock is a Linux mechanism; this suite is running on "
                + RuntimeInformation.OSDescription + ".");
            return;
        }

        // NOTE: nothing here may call LinuxLandlock.TryRestrict. A ruleset is irrevocable and inherited
        // across every exec, so installing one in the test process would confine the whole run — which is
        // exactly why the production path installs it in a launcher CHILD. TryRestrict is exercised for
        // real by the launcher tests below.
        int abi = LinuxLandlock.AbiVersion;
        abi.ShouldBeGreaterThanOrEqualTo(-1);
        abi.ShouldNotBe(0, "a kernel either speaks a Landlock ABI (1 or later) or none at all (-1)");
        LinuxLandlock.AbiVersion.ShouldBe(abi, "the ABI is settled once and cached for the process");
    }

    [Fact]
    public void The_Landlock_launcher_confines_writes_to_the_directory_it_was_given()
    {
        var (launcher, arguments) = RequireLandlockLauncher();

        string runDirectory = NewDirectory("koine-landlock-");
        string outside = Path.Combine(Path.GetTempPath(), "koine-outside-" + Guid.NewGuid().ToString("N") + ".txt");
        string inside = Path.Combine(runDirectory, "inside.txt");
        string probe = WriteStub(
            WriteProbe(inside, outside) + "printf 'inside=%s outside=%s' \"$inside\" \"$outside\"\n");

        try
        {
            // The control FIRST: unconfined, the same probe writes both files. Without it, "denied" below
            // would also be satisfied by a probe that never managed to write anything at all.
            Capture(probe, []).ShouldBe("inside=allowed outside=allowed");
            Forget(inside);
            Forget(outside);

            Capture(launcher, [.. arguments, "--run", runDirectory, "--", probe])
                .ShouldBe("inside=allowed outside=denied");
            File.Exists(outside).ShouldBeFalse(outside);
            File.Exists(inside).ShouldBeTrue("the run directory is the child's scratch space and must stay "
                + "writable — a confinement that broke the legitimate write would be a broken sandbox");
        }
        finally
        {
            Forget(probe);
            Forget(outside);
            Discard(runDirectory);
        }
    }

    [Fact]
    public void The_Landlock_launcher_refuses_to_run_the_command_when_it_cannot_confine()
    {
        var (launcher, arguments) = RequireLandlockLauncher();

        // A run directory that does not exist: the ruleset has nowhere to allow writes, so the launcher
        // cannot honour what it was asked for.
        string missing = Path.Combine(Path.GetTempPath(), "koine-absent-" + Guid.NewGuid().ToString("N"));
        string marker = Path.Combine(Path.GetTempPath(), "koine-marker-" + Guid.NewGuid().ToString("N") + ".txt");
        string probe = WriteStub(": > '" + marker + "'\n");

        try
        {
            (int exitCode, string _, string error) =
                Run(launcher, [.. arguments, "--run", missing, "--", probe]);

            // Failing LOUD is the whole contract: a launcher that quietly exec'd the command anyway would
            // run unconfined code while the result tree said it was confined — worse than no sandbox,
            // because the notes would be a lie rather than a warning.
            exitCode.ShouldNotBe(0, "the launcher must not report success it did not achieve");
            error.ShouldContain(ScenarioSandbox.LandlockLauncherVerb);
            File.Exists(marker).ShouldBeFalse("the command must not have run at all");
        }
        finally
        {
            Forget(probe);
            Forget(marker);
        }
    }

    [Fact]
    public void The_Linux_write_confinement_is_planned_inside_the_namespaces_and_the_processor_ceiling()
    {
        if (!OperatingSystem.IsLinux())
        {
            Assert.Skip("This asserts the composition of the LINUX wrappers; running on "
                + RuntimeInformation.OSDescription + ".");
            return;
        }

        if (!ScenarioSandbox.FilesystemConfinementAvailable)
        {
            Assert.Skip("This Linux host cannot install a Landlock ruleset (ABI "
                + LinuxLandlock.AbiVersion + "), so there is no launcher in the plan to order.");
            return;
        }

        string runDirectory = NewDirectory("koine-plan-");
        try
        {
            using ScenarioConfinement plan = ScenarioSandbox.Plan(
                "koine", ["scenario-exec"], runDirectory, ScenarioSandboxOptions.Default);

            plan.Degradations.ShouldNotContain(
                note => note.StartsWith("Filesystem confinement was not applied", StringComparison.Ordinal),
                "the launcher IS the mechanism this platform was said to be missing");

            IReadOnlyList<string> argv = plan.Arguments;
            int launcher = argv.ToList().IndexOf(ScenarioSandbox.LandlockLauncherVerb);
            int command = argv.ToList().IndexOf("scenario-exec");

            // The order is load-bearing, and every wrong version of it is silent: a launcher outside the
            // ulimit shell loses RLIMIT_CPU, and one outside `unshare` installs an irrevocable ruleset
            // before the namespaces that need mount and /proc writes have been created.
            plan.FileName.ShouldBe("/bin/sh", "the processor-time ceiling is the outermost wrapper");
            launcher.ShouldBeGreaterThan(-1, string.Join(' ', argv));
            launcher.ShouldBeLessThan(command, "the launcher execs INTO the real command");
            argv[argv.ToList().IndexOf("--run") + 1].ShouldBe(runDirectory);

            if (ScenarioSandbox.NetworkConfinementAvailable)
            {
                int unshare = argv.ToList().IndexOf("--map-root-user");
                unshare.ShouldBeGreaterThan(-1, string.Join(' ', argv));
                unshare.ShouldBeLessThan(launcher,
                    "a Landlock ruleset is irrevocable, so it must be installed INSIDE the namespaces "
                    + "unshare has not created yet");
            }
        }
        finally
        {
            Discard(runDirectory);
        }
    }

    /// <summary>Gates the launcher tests on a kernel that can actually enforce a ruleset, and on the verb
    /// resolving to a real binary — skipping with the reason, never silently.</summary>
    private static (string FileName, IReadOnlyList<string> Arguments) RequireLandlockLauncher()
    {
        if (!OperatingSystem.IsLinux())
        {
            Assert.Skip("The Landlock launcher is a Linux mechanism; this suite is running on "
                + RuntimeInformation.OSDescription + ".");
        }
        else if (LinuxLandlock.AbiVersion < 1)
        {
            Assert.Skip("This kernel reports no Landlock ABI (needs 5.13+ with Landlock enabled).");
        }

        return ScenarioExecutionHost.ResolveSelfCommand(ScenarioSandbox.LandlockLauncherVerb)
            ?? throw new InvalidOperationException(
                "the koine binary under test could not be located for the launcher verb");
    }

    private static string NewDirectory(string prefix)
    {
        string directory = Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void Discard(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (Exception)
        {
            // A leftover temp directory is not a test failure.
        }
    }

    /// <summary>Runs a command to completion and returns its exit code and both streams.</summary>
    private static (int ExitCode, string Output, string Error) Run(string fileName, IReadOnlyList<string> arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("could not start " + fileName);
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        process.WaitForExit((int)TimeSpan.FromSeconds(60).TotalMilliseconds);
        return (process.ExitCode, output.Result.Trim(), error.Result.Trim());
    }

    /// <summary>The stdout of a command that must have succeeded — its stderr is folded into the failure
    /// message, because a launcher that could not confine says why there and nowhere else.</summary>
    private static string Capture(string fileName, IReadOnlyList<string> arguments)
    {
        (int exitCode, string output, string error) = Run(fileName, arguments);
        exitCode.ShouldBe(0, fileName + " exited " + exitCode + ": " + error);
        return output;
    }

    /// <summary>Gates the network-enforcement test, on the same principle as
    /// <see cref="RequireFilesystemConfinement"/>. Linux keeps a real skip: an unprivileged network
    /// namespace genuinely depends on the kernel's configuration, so its absence is a platform fact.</summary>
    private static void RequireNetworkConfinement()
    {
        if (OperatingSystem.IsMacOS())
        {
            ScenarioSandbox.NetworkConfinementAvailable.ShouldBeTrue(
                "macOS ships /usr/bin/sandbox-exec, so network confinement being unavailable here is a "
                + "regression in the sandbox, not a fact about the platform");
            return;
        }

        if (!ScenarioSandbox.NetworkConfinementAvailable)
        {
            Assert.Skip("This host cannot create an unprivileged network namespace; the degradation "
                + "reported instead is asserted by "
                + nameof(Confinement_this_platform_cannot_provide_is_reported_in_the_tree_and_never_fails_the_run)
                + ".");
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

    // ------------------------------------------------------------------------
    // Windows Job Object (#1782): 194 lines of kernel32 P/Invoke over three hand-mirrored ABI structs
    // (field order and widths ARE the ABI) that shipped manually verified on macOS 26 but had never
    // executed against a real Windows kernel — an invisible-by-construction defect class per ADR 0012.
    // This is the floor: it asserts the interop itself works, not any behavioural ceiling (that is
    // Task 4's job, once a Windows stub child exists).
    // ------------------------------------------------------------------------

    [Fact]
    public void The_Windows_Job_Object_creates_and_confines_a_real_child_for_the_first_time_on_a_real_kernel()
    {
        if (!OperatingSystem.IsWindows())
        {
            Assert.Skip("The Job Object is a Windows mechanism; this suite is running on "
                + RuntimeInformation.OSDescription + ".");
            return;
        }

        using WindowsJobObject? job = WindowsJobObject.TryCreate(
            1L << 30, TimeSpan.FromSeconds(30), out string? creationFailure);

        // A generous ceiling pair no trivial child can trip — this proves the ABI structs marshal
        // correctly and the job accepts them, not that the ceilings themselves are enforced.
        job.ShouldNotBeNull(creationFailure);
        creationFailure.ShouldBeNull();

        using Process child = Process.Start(new ProcessStartInfo
        {
            FileName = "cmd.exe",
            ArgumentList = { "/c", "exit 0" },
            UseShellExecute = false,
            CreateNoWindow = true,
        }) ?? throw new InvalidOperationException("could not start cmd.exe");

        // Assigned immediately after start, mirroring ScenarioExecutionHost.RunDetailed's own ordering
        // (confinement.Attach(child) right after Process.Start, before any wait) — the same race the
        // production path accepts (WindowsJobObject's doc comment), exercised for real rather than
        // assumed safe by never running.
        bool assigned = job.TryAssign(child, out string? assignFailure);

        child.WaitForExit((int)TimeSpan.FromSeconds(10).TotalMilliseconds);

        assigned.ShouldBeTrue(assignFailure);
        assignFailure.ShouldBeNull();
    }

    private const string BashPath = "/bin/bash";

    /// <summary>What a probing stub reported, carried out in the result tree's <c>result</c> field — the
    /// one channel a confined child is guaranteed to have, since every file it might otherwise write to
    /// is exactly what the confinement is denying.</summary>
    private static string? Probed(ScenarioChildRun run) => run.Result["result"] as string;

    /// <summary>The POSIX-shell (or, on Windows, batch) form of a reference to environment variable
    /// <paramref name="name"/> — cmd.exe and POSIX shells spell this differently, and the JSON contract
    /// the two <see cref="Report"/> forms below produce has to embed whichever is native.</summary>
    private static string EnvRef(string name) =>
        OperatingSystem.IsWindows() ? "%" + name + "%" : "${" + name + "}";

    /// <summary>Shell (or, on Windows, batch) that prints a valid result tree carrying <paramref
    /// name="findings"/> as its result. Both forms produce byte-identical JSON shapes (issue #1782 Task
    /// 4) so the assertions that read them are shared, never duplicated per platform.</summary>
    private static string Report(string findings) =>
        OperatingSystem.IsWindows()
            ? "@echo {\"ok\":true,\"target\":\"Stub\",\"operation\":\"stub\",\"mode\":\"executed\","
              + "\"steps\":[],\"resultingState\":{},\"invariants\":[],\"result\":\"" + findings + "\",\"notes\":[]}\r\n"
            : "printf '{\"ok\":true,\"target\":\"Stub\",\"operation\":\"stub\",\"mode\":\"executed\","
              + "\"steps\":[],\"resultingState\":{},\"invariants\":[],\"result\":\"%s\",\"notes\":[]}' \""
              + findings + "\"\n";

    /// <summary>A minimal, valid result tree — everything the protocol reader needs from a stub child.
    /// Not a <c>const</c>: which form it renders as depends on the platform running it.</summary>
    private static string EchoResult =>
        OperatingSystem.IsWindows()
            ? "@echo {\"ok\":true,\"target\":\"Stub\",\"operation\":\"stub\",\"mode\":\"executed\","
              + "\"steps\":[],\"resultingState\":{},\"invariants\":[],\"result\":null,\"notes\":[]}\r\n"
            : "printf '%s' '{\"ok\":true,\"target\":\"Stub\",\"operation\":\"stub\",\"mode\":\"executed\","
              + "\"steps\":[],\"resultingState\":{},\"invariants\":[],\"result\":null,\"notes\":[]}'\n";

    /// <summary>The spinning body <see cref="A_child_that_burns_past_the_processor_ceiling_is_reported_as_a_cap_not_a_timeout"/>
    /// and its control need — a tight loop with no syscall a shell/batch interpreter could block on.</summary>
    private static string SpinLoop() =>
        OperatingSystem.IsWindows() ? ":loop\r\ngoto loop\r\n" : "while :; do :; done\n";

    /// <summary>Runs a stub child under <paramref name="options"/>, restoring the command override
    /// afterwards so no other test in this class inherits it.</summary>
    private static ScenarioChildRun RunStub(string stub, ScenarioSandboxOptions options, TimeSpan? budget = null)
    {
        string? previousCommand = Environment.GetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable);
        string? previousArgs = Environment.GetEnvironmentVariable(ScenarioExecutionHost.ArgumentsOverrideVariable);
        if (OperatingSystem.IsWindows())
        {
            // CreateProcess cannot launch a .cmd directly with UseShellExecute false (the sandbox always
            // spawns that way) — cmd.exe has to be the executable, with the stub as its /c argument. The
            // leading-argument override exists for exactly this "muxer plus a path" shape. /q turns off
            // command echo, which is ON by default for a batch file NOT started interactively — without
            // it, cmd.exe writes its own "<cwd>>command" line to stdout ahead of anything the stub prints,
            // and the protocol reader sees that instead of JSON.
            string comspec = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe";
            Environment.SetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable, comspec);
            Environment.SetEnvironmentVariable(ScenarioExecutionHost.ArgumentsOverrideVariable, "/q /c " + stub);
        }
        else
        {
            Environment.SetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable, stub);
        }

        try
        {
            return ScenarioExecutionHost.RunDetailed(
                TrivialSources(), TrivialScenario(), budget ?? CapBudget, options);
        }
        finally
        {
            Environment.SetEnvironmentVariable(ScenarioExecutionHost.CommandOverrideVariable, previousCommand);
            Environment.SetEnvironmentVariable(ScenarioExecutionHost.ArgumentsOverrideVariable, previousArgs);
        }
    }

    /// <summary>Writes an executable stub child — POSIX-sh unless a richer shell is asked for, or (on
    /// Windows) a <c>.cmd</c> invoked BY EXTENSION, never by a shebang line, which means nothing there.</summary>
    private static string WriteStub(string body, string interpreter = "/bin/sh")
    {
        if (OperatingSystem.IsWindows())
        {
            string cmdPath = Path.Combine(Path.GetTempPath(), "koine-stub-" + Guid.NewGuid().ToString("N") + ".cmd");
            File.WriteAllText(cmdPath, body);

            // RunStub carries this path through ArgumentsOverrideVariable, which — per its own documented
            // contract — splits on spaces; Path.GetTempPath() is under the user profile and a space there
            // ("C:\Users\Jane Doe\...") is ordinary, not exotic. The 8.3 short form has none, by
            // construction. A failure (8dot3 generation disabled on this volume) falls back to the long
            // path — no worse than before this existed, just not improved.
            return WindowsShortPath(cmdPath) ?? cmdPath;
        }

        string path = Path.Combine(Path.GetTempPath(), "koine-stub-" + Guid.NewGuid().ToString("N") + ".sh");
        File.WriteAllText(path, "#!" + interpreter + "\n" + body);
        File.SetUnixFileMode(
            path,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        return path;
    }

    /// <summary>The 8.3 short form of <paramref name="path"/>, or <c>null</c> if it could not be resolved
    /// (8dot3 name generation disabled on the volume, or any other failure) — callers fall back to the
    /// long path in that case.</summary>
    private static string? WindowsShortPath(string path)
    {
        var buffer = new System.Text.StringBuilder(260);
        uint length = GetShortPathNameW(path, buffer, (uint)buffer.Capacity);
        return length > 0 && length < buffer.Capacity ? buffer.ToString() : null;
    }

#pragma warning disable SYSLIB1054 // no source-generated LibraryImport for this one Windows-only helper.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathNameW(string longPath, System.Text.StringBuilder shortPath, uint bufferLength);
#pragma warning restore SYSLIB1054

    /// <summary>Gates the genuinely POSIX-specific stub tests: the network probe (needs bash's
    /// <c>/dev/tcp</c> pseudo-device) and the filesystem-write probe (its POSIX-only <see
    /// cref="WriteProbe"/> body was not given a Windows form). Every OTHER stub-based behavioural
    /// assertion now has a Windows form too (issue #1782 Task 4): <see cref="WriteStub"/>, <see
    /// cref="Report"/> and <see cref="EchoResult"/> all branch on platform instead of assuming POSIX.</summary>
    private static void RequireUnixStubs()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("This probe needs a POSIX shell feature (bash's /dev/tcp) with no Windows equivalent.");
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
