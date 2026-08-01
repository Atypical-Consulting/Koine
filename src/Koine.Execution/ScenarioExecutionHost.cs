using System.Buffers;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Koine.Compiler.Semantics.Scenarios;
using Koine.Compiler.Services;

namespace Koine.Execution;

/// <summary>
/// One scenario-execution request, as it crosses the sandbox boundary (ADR 0011). The boundary is drawn
/// BEFORE emit: the request carries the model's <c>.koi</c> <see cref="Sources"/>, so parsing, emitting,
/// Roslyn-compiling and executing all happen in the child — the editor backend runs no model-derived
/// work in its own process, not even the compile.
///
/// <para>The model travels as source rather than as a <c>SemanticModel</c> because a parsed model cannot
/// be losslessly rendered back to <c>.koi</c> (Koine has no <c>SyntaxToken</c> layer, so
/// <c>AstPrinter</c> needs the original source for structural keywords/punctuation), and source is what
/// the far side needs to rebuild the model the executor drives.</para>
/// </summary>
internal sealed record ScenarioExecRequest(
    IReadOnlyList<SourceFile> Sources,
    string Target,
    string Operation,
    IReadOnlyDictionary<string, ScenarioValue> Given,
    IReadOnlyDictionary<string, ScenarioValue> Args)
{
    /// <summary>The scenario this request describes, ready for the executor.</summary>
    public Scenario ToScenario() => new(Target, Operation, Given, Args);
}

/// <summary>
/// The stdio wire format shared by <see cref="ScenarioExecutionHost"/> (which writes the request and
/// reads the result) and the hidden <c>koine scenario-exec</c> command (which does the reverse) — one
/// definition, so the two sides cannot drift.
///
/// <para>Reading and writing are done with <see cref="Utf8JsonWriter"/>/<see cref="JsonDocument"/>
/// directly: reflection-free, so a trimmed/single-file <c>koine</c> publish keeps working, and free of
/// any serializer configuration that could differ between host and child.</para>
/// </summary>
internal static class ScenarioExecutionProtocol
{
    /// <summary>The hidden CLI verb that runs one scenario in the sandbox.</summary>
    public const string CommandName = "scenario-exec";

    /// <summary>Serializes a request for the child's stdin.</summary>
    public static string WriteRequest(IReadOnlyList<SourceFile> sources, Scenario scenario)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            writer.WriteStartObject();

            writer.WriteStartArray("sources");
            foreach (SourceFile source in sources)
            {
                writer.WriteStartObject();
                writer.WriteString("path", source.Path);
                writer.WriteString("text", source.Source);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();

            writer.WriteString("target", scenario.Target);
            writer.WriteString("operation", scenario.Operation);
            WriteMap(writer, "given", scenario.Given);
            WriteMap(writer, "args", scenario.Args);

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    /// <summary>
    /// Parses a request read from stdin. <c>given</c>/<c>args</c> go through
    /// <see cref="ScenarioService.ParseMap"/> — the SAME JSON → value mapping the interpreted-mode LSP
    /// request uses, so a given state means one thing in both modes.
    /// </summary>
    public static ScenarioExecRequest ReadRequest(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;

        var sources = new List<SourceFile>();
        if (root.TryGetProperty("sources", out JsonElement files) && files.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement file in files.EnumerateArray())
            {
                sources.Add(new SourceFile(
                    file.TryGetProperty("path", out JsonElement path) ? path.GetString() ?? "<source>" : "<source>",
                    file.TryGetProperty("text", out JsonElement text) ? text.GetString() ?? string.Empty : string.Empty));
            }
        }

        return new ScenarioExecRequest(
            sources,
            Text(root, "target"),
            Text(root, "operation"),
            ScenarioService.ParseMap(Property(root, "given")),
            ScenarioService.ParseMap(Property(root, "args")));
    }

    /// <summary>Parses the child's stdout back into the result tree the host hands its caller.</summary>
    public static IReadOnlyDictionary<string, object?> ReadResult(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return ReadValue(document.RootElement) as IReadOnlyDictionary<string, object?>
               ?? throw new JsonException("the scenario child did not return a JSON object");
    }

    private static void WriteMap(Utf8JsonWriter writer, string name, IReadOnlyDictionary<string, ScenarioValue> map)
    {
        writer.WriteStartObject(name);
        foreach (var (key, value) in map)
        {
            writer.WritePropertyName(key);
            WriteScenarioValue(writer, value);
        }

        writer.WriteEndObject();
    }

    /// <summary>
    /// Writes one scenario value as plain JSON — the same vocabulary
    /// <see cref="ScenarioService.ParseMap"/> reads back. An enum member travels as its name (a string),
    /// which is exactly how a Studio/LSP request expresses one; the two markers JSON has no form for
    /// (<c>now</c> and an indeterminate value) degrade to <c>"now"</c> and <c>null</c> rather than
    /// inventing wire syntax — neither ever appears in a request built from JSON in the first place.
    /// </summary>
    private static void WriteScenarioValue(Utf8JsonWriter writer, ScenarioValue value)
    {
        switch (value)
        {
            case ScenarioValue.Num num:
                writer.WriteNumberValue(num.Value);
                break;
            case ScenarioValue.Bool b:
                writer.WriteBooleanValue(b.Value);
                break;
            case ScenarioValue.Text text:
                writer.WriteStringValue(text.Value);
                break;
            case ScenarioValue.EnumMember member:
                writer.WriteStringValue(member.Member);
                break;
            case ScenarioValue.List list:
                writer.WriteStartArray();
                foreach (ScenarioValue item in list.Items)
                {
                    WriteScenarioValue(writer, item);
                }

                writer.WriteEndArray();
                break;
            case ScenarioValue.Record record:
                writer.WriteStartObject();
                foreach (var (field, child) in record.Fields)
                {
                    writer.WritePropertyName(field);
                    WriteScenarioValue(writer, child);
                }

                writer.WriteEndObject();
                break;
            case ScenarioValue.Instant:
                writer.WriteStringValue("now");
                break;
            default:
                writer.WriteNullValue();
                break;
        }
    }

    /// <summary>Reads a JSON value into the same object shapes <see cref="ScenarioService.WriteJson"/>
    /// serializes, so a round-tripped tree re-serializes byte-for-byte.</summary>
    private static object? ReadValue(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => (IReadOnlyDictionary<string, object?>)element.EnumerateObject()
            .ToDictionary(p => p.Name, p => ReadValue(p.Value), StringComparer.Ordinal),
        JsonValueKind.Array => element.EnumerateArray().Select(ReadValue).ToArray(),
        JsonValueKind.String => element.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => element.TryGetInt64(out long i) ? i : element.GetDecimal(),
        _ => null
    };

    private static JsonElement Property(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) ? value : default;

    private static string Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) ? value.GetString() ?? string.Empty : string.Empty;
}

/// <summary>
/// One sandboxed run, with the facts a caller (and the sandbox's own tests) need beyond the result
/// tree: which process ran it, where its scratch directory was, whether the deadline expired, and which
/// pieces of the requested OS-level confinement this platform could not provide.
/// </summary>
/// <param name="SandboxNotes">The confinement degradations the host APPENDED to the result tree's
/// <c>notes</c> (issue #1759). Reported separately as well as in the tree so a caller comparing this
/// run against another engine can subtract exactly the notes the sandbox added, rather than guessing
/// which of the tree's notes came from the scenario itself.</param>
internal readonly record struct ScenarioChildRun(
    IReadOnlyDictionary<string, object?> Result,
    int ChildProcessId,
    string RunDirectory,
    bool TimedOut,
    IReadOnlyList<string> SandboxNotes);

/// <summary>
/// Runs a scenario in a SANDBOXED child process (issue #236, ADR 0011): it spawns the hidden
/// <c>koine scenario-exec</c> verb of the very binary the caller is running, streams the request in over
/// stdin, reads the <see cref="ScenarioService"/> result tree back off stdout, and enforces a wall-clock
/// deadline it can actually meet — killing the child's whole process tree on expiry.
///
/// <para>Why a process and not a thread: .NET cannot abort a runaway managed thread
/// (<c>Thread.Abort</c> is unsupported), so an in-process runner has no cure for an infinite loop in an
/// emitted derived member — the thread burns a core inside the editor backend for the rest of the
/// session, and an allocation storm takes the whole host down with it. A process can simply be killed.</para>
///
/// <para><see cref="Run"/> NEVER throws: a child that will not start, will not stop, or does not answer
/// in the protocol comes back as an <c>ok: false</c> tree with a note that says which.</para>
/// </summary>
internal static class ScenarioExecutionHost
{
    /// <summary>The wall-clock budget one scenario gets when the caller does not pick one.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Overrides how the child is launched. Its WHOLE value is the executable path — never split, so a
    /// real install path with a space in it (<c>C:\Program Files\Koine\koine.exe</c>,
    /// <c>/Applications/Koine Studio.app/Contents/MacOS/koine</c>) works, which is exactly the packaging
    /// case this escape hatch exists for. Leading arguments, if a setup needs them, go in
    /// <see cref="ArgumentsOverrideVariable"/>.
    /// </summary>
    public const string CommandOverrideVariable = "KOINE_SCENARIO_EXEC_COMMAND";

    /// <summary>
    /// Optional space-separated leading arguments for <see cref="CommandOverrideVariable"/> — for a
    /// packaging setup whose entry point needs them (e.g. a muxer plus an assembly path). The
    /// <c>scenario-exec</c> verb is always appended after them. Only read when the command override is
    /// set; individual arguments are passed verbatim, so an argument that itself contains a space cannot
    /// be expressed here (the path — the thing that realistically has one — lives in the command).
    /// </summary>
    public const string ArgumentsOverrideVariable = "KOINE_SCENARIO_EXEC_ARGS";

    /// <summary>How long a killed child gets to die before the host stops waiting on it. Callers that
    /// advertise a latency ceiling must add this to their timeout: it is the tail a run can spend after
    /// the deadline itself expires.</summary>
    internal static readonly TimeSpan KillGrace = TimeSpan.FromSeconds(5);

    /// <summary>The encoding pinned on all three pipes (see <see cref="RunDetailed"/>).</summary>
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>How much of the child's stderr a failure note quotes.</summary>
    private const int MaxQuotedStdErr = 500;

    /// <summary>How many times <see cref="Delete"/> tries to remove the run directory before giving up.</summary>
    private const int DeleteAttempts = 20;

    /// <summary>The pause between <see cref="Delete"/> attempts — 20 × 100 ms bounds cleanup at ~2 s.</summary>
    private static readonly TimeSpan DeleteRetryDelay = TimeSpan.FromMilliseconds(100);

    /// <summary>
    /// The environment variables the child keeps. Everything else is dropped: the child needs only
    /// enough to start a .NET process, and inherits none of the editor host's ambient configuration
    /// (tokens, proxies, build state) it has no business seeing.
    /// </summary>
    private static readonly string[] KeptEnvironmentVariables =
    [
        "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP",
        // Every variable hostfxr consults to locate the runtime, not just the classic pair: the
        // architecture-specific DOTNET_ROOT_* forms take PRECEDENCE over plain DOTNET_ROOT, and
        // ProgramFiles/ProgramFiles(x86) are what its Windows default-install-dir probe reads. Drop any
        // of them and a portable/zip .NET install answers a scrubbed child with "You must install .NET".
        "DOTNET_ROOT", "DOTNET_ROOT(x86)", "DOTNET_ROOT_X64", "DOTNET_ROOT_ARM64", "DOTNET_ROOT_X86",
        "DOTNET_HOST_PATH", "ProgramFiles", "ProgramFiles(x86)",
        "SystemRoot", "windir", "COMSPEC", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
        "LANG", "LC_ALL", "LD_LIBRARY_PATH",
    ];

    /// <summary>Runs <paramref name="scenario"/> against <paramref name="sources"/> in a sandboxed child,
    /// with the <see cref="DefaultTimeout"/>.</summary>
    public static IReadOnlyDictionary<string, object?> Run(IReadOnlyList<SourceFile> sources, Scenario scenario) =>
        Run(sources, scenario, DefaultTimeout);

    /// <summary>Runs <paramref name="scenario"/> against <paramref name="sources"/> in a sandboxed child,
    /// killed after <paramref name="timeout"/>. Returns the scenario result tree; never throws.</summary>
    public static IReadOnlyDictionary<string, object?> Run(
        IReadOnlyList<SourceFile> sources, Scenario scenario, TimeSpan timeout) =>
        RunDetailed(sources, scenario, timeout).Result;

    /// <summary>
    /// <see cref="Run(IReadOnlyList{SourceFile}, Scenario, TimeSpan)"/>, also reporting which process ran
    /// the scenario, its scratch directory, and whether the deadline expired. Confinement is the default
    /// for this budget (<see cref="ScenarioSandboxOptions.For"/>).
    /// </summary>
    public static ScenarioChildRun RunDetailed(
        IReadOnlyList<SourceFile> sources, Scenario scenario, TimeSpan timeout) =>
        RunDetailed(sources, scenario, timeout, ScenarioSandboxOptions.For(timeout));

    /// <summary>
    /// <see cref="RunDetailed(IReadOnlyList{SourceFile}, Scenario, TimeSpan)"/> with an explicit
    /// confinement request (issue #1759). Anything <paramref name="sandbox"/> asks for that this platform
    /// cannot provide is REPORTED, never fatal: the run still happens with ADR 0011's v1 guarantees and
    /// the result carries a note saying which confinement was skipped.
    /// </summary>
    public static ScenarioChildRun RunDetailed(
        IReadOnlyList<SourceFile> sources, Scenario scenario, TimeSpan timeout, ScenarioSandboxOptions sandbox)
    {
        // The child's working directory: a disposable scratch space, so anything the run leaves on disk
        // lands somewhere we delete rather than in the user's workspace. Cleanup is attempted on EVERY
        // path below — and is best-effort by design, see Delete.
        string runDirectory = Path.Combine(Path.GetTempPath(), "koine-scenario-" + Guid.NewGuid().ToString("N"));
        int childId = 0;

        try
        {
            Directory.CreateDirectory(runDirectory);

            (string FileName, IReadOnlyList<string> Arguments)? command = ResolveChildCommand();
            if (command is null)
            {
                return Failure(scenario, runDirectory, childId, timedOut: false,
                    "The scenario sandbox could not locate the koine binary to run the scenario in. Set "
                    + CommandOverrideVariable + " to its absolute path.");
            }

            string fileName = command.Value.FileName;

            // OS-level confinement (issue #1759), planned BEFORE the spawn because on Unix it IS the
            // spawn: the child becomes the confining wrapper, which execs into the command below. Every
            // piece the platform cannot provide comes back as a note, never as a failure.
            using var confinement = ScenarioSandbox.Plan(
                fileName, command.Value.Arguments, runDirectory, sandbox);

            var startInfo = new ProcessStartInfo
            {
                FileName = confinement.FileName,
                WorkingDirectory = runDirectory,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                // Pin UTF-8 on all three pipes: the result tree carries non-ASCII markers (∅, ⚠, …), which
                // a console's default code page would mangle on the way across.
                StandardInputEncoding = Utf8,
                StandardOutputEncoding = Utf8,
                StandardErrorEncoding = Utf8,
            };
            foreach (string argument in confinement.Arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            Scrub(startInfo);

            // After the scrub, never before: the scrub clears the whole block, so confinement variables
            // set ahead of it would be thrown away.
            foreach (var (name, value) in confinement.Environment)
            {
                startInfo.Environment[name] = value;
            }

            using Process? child = Process.Start(startInfo);
            if (child is null)
            {
                return Failure(scenario, runDirectory, childId, timedOut: false,
                    $"The scenario sandbox child ('{fileName}') could not be started.", confinement.Degradations);
            }

            childId = child.Id;

            // The Job Object can only exist once the process does — a race the sandbox accepts and
            // documents (see WindowsJobObject). Everything else was already applied at spawn.
            confinement.Attach(child);

            // Drain both pipes CONCURRENTLY: reading one to EOF before touching the other deadlocks the
            // moment the child fills the second stream's buffer.
            Task<string> stdout = child.StandardOutput.ReadToEndAsync();
            Task<string> stderr = child.StandardError.ReadToEndAsync();

            // Write the request off the calling thread as well. A large model can exceed the pipe buffer,
            // and a blocking write to a child that is not reading would hang the host BEFORE it ever
            // reached the deadline below — the one place a watchdog cannot help itself.
            Task request = Task.Run(() =>
            {
                try
                {
                    child.StandardInput.Write(ScenarioExecutionProtocol.WriteRequest(sources, scenario));
                }
                catch (Exception)
                {
                    // The child died before (or while) reading. The exit handling below reports it.
                }
                finally
                {
                    // The child gets the request and nothing more: stdin is closed immediately, so it can
                    // never block reading input a caller was never going to send. In a `finally` because
                    // a FAILED write must close it too — otherwise the child sits in `ReadToEnd()` waiting
                    // for an EOF nobody will send, burns the whole budget, and a host-side IO fault gets
                    // reported as "the emitted code may not terminate".
                    try
                    {
                        child.StandardInput.Close();
                    }
                    catch (Exception)
                    {
                        // The pipe is already gone — there is nothing left to close.
                    }
                }
            });

            if (!child.WaitForExit((int)Math.Max(0, Math.Min(timeout.TotalMilliseconds, int.MaxValue))))
            {
                Kill(child);
                return Failure(scenario, runDirectory, childId, timedOut: true,
                    $"The scenario timed out after {Format(timeout)} and was stopped. The emitted code may not "
                    + "terminate (an unbounded loop or runaway allocation in a derived member or invariant); "
                    + "nothing of the run survives.", confinement.Degradations);
            }

            // The child has exited, but its pipes may not have: `WaitForExit(int)` does not drain the
            // redirected streams, and the parameterless overload — which does — waits for EOF, which a
            // process the child started and left behind could withhold forever. Wait for the readers
            // ourselves, BOUNDED, so no path out of here is unbounded.
            Drain([stdout, stderr, request]);

            string output = Text(stdout);
            if (string.IsNullOrWhiteSpace(output))
            {
                // A child killed at a RESOURCE ceiling looks, from here, exactly like any other silent
                // death — the exit code is the only witness, so ask the confinement to read it before
                // falling back to the generic note.
                return Failure(scenario, runDirectory, childId, timedOut: false,
                    confinement.DescribeExit(child.ExitCode)
                    ?? $"The scenario sandbox child exited with code {child.ExitCode} and produced no result"
                    + Quote(Text(stderr)), confinement.Degradations);
            }

            try
            {
                return new ScenarioChildRun(
                    WithNotes(ScenarioExecutionProtocol.ReadResult(output), confinement.Degradations),
                    childId,
                    runDirectory,
                    TimedOut: false,
                    confinement.Degradations);
            }
            catch (JsonException ex)
            {
                return Failure(scenario, runDirectory, childId, timedOut: false,
                    $"The scenario sandbox child did not answer in the protocol ({ex.Message})" + Quote(Text(stderr)),
                    confinement.Degradations);
            }
        }
        catch (Exception ex)
        {
            return Failure(scenario, runDirectory, childId, timedOut: false,
                $"The scenario could not be run in the sandbox: {ex.Message}");
        }
        finally
        {
            Delete(runDirectory);
        }
    }

    /// <summary>
    /// Locates the child command. The sandbox re-uses the very <c>koine</c> binary the host is running
    /// (ADR 0011) rather than shipping a second executable, which means resolving BOTH shapes that
    /// binary takes:
    /// <list type="number">
    ///   <item><description>an explicit <see cref="CommandOverrideVariable"/>, for packaging setups that
    ///   know better than any heuristic;</description></item>
    ///   <item><description>the host process itself, when it IS <c>koine</c> (the published apphost, the
    ///   single-file build, or the installed global tool) — re-exec it with the hidden verb;</description></item>
    ///   <item><description><c>dotnet &lt;dir&gt;/Koine.Cli.dll</c>, when the host runs framework-dependent
    ///   or is not the CLI at all (the common dev/test case: the host process is <c>dotnet</c> or a test
    ///   runner, with the CLI's assembly sitting in the same output directory);</description></item>
    ///   <item><description>a <c>koine</c> apphost next to us, then a <c>koine</c> resolved to an
    ///   ABSOLUTE path off PATH.</description></item>
    /// </list>
    /// Returns <c>null</c> when nothing resolves — the caller reports that as a failed run rather than
    /// handing a bare relative name to the OS: on Windows <c>CreateProcess</c>'s search for a bare name
    /// includes a current directory, so an embedding could otherwise execute an unexpected
    /// <c>koine.exe</c> that happens to sit in its working directory.
    /// </summary>
    private static (string FileName, IReadOnlyList<string> Arguments)? ResolveChildCommand()
    {
        if (Environment.GetEnvironmentVariable(CommandOverrideVariable) is { Length: > 0 } overridden)
        {
            // The WHOLE variable is the executable — never split on spaces, or every install path with a
            // space in it ("C:\Program Files\…") would resolve to a nonexistent "C:\Program".
            string[] leading = Environment.GetEnvironmentVariable(ArgumentsOverrideVariable) is { Length: > 0 } extra
                ? extra.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                : [];
            return (overridden.Trim(), [.. leading, ScenarioExecutionProtocol.CommandName]);
        }

        if (Environment.ProcessPath is { Length: > 0 } self
            && Path.GetFileNameWithoutExtension(self) is "koine" or "Koine.Cli")
        {
            return (self, [ScenarioExecutionProtocol.CommandName]);
        }

        string library = Path.Combine(AppContext.BaseDirectory, "Koine.Cli.dll");
        if (File.Exists(library))
        {
            return (DotnetMuxer(), [library, ScenarioExecutionProtocol.CommandName]);
        }

        string apphost = Path.Combine(AppContext.BaseDirectory, Executable("koine"));
        if (File.Exists(apphost))
        {
            return (apphost, [ScenarioExecutionProtocol.CommandName]);
        }

        return OnPath(Executable("koine")) is { } found
            ? (found, [ScenarioExecutionProtocol.CommandName])
            : null;
    }

    /// <summary>
    /// The first <paramref name="name"/> found on <c>PATH</c>, as an absolute path — or <c>null</c>.
    /// Resolving it ourselves is the point: handing a bare name to <c>CreateProcess</c> lets its own
    /// search include a current directory, which is not a directory this host chose.
    /// </summary>
    private static string? OnPath(string name)
    {
        if (Environment.GetEnvironmentVariable("PATH") is not { Length: > 0 } path)
        {
            return null;
        }

        foreach (string entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                string candidate = Path.Combine(entry.Trim('"'), name);
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
            catch (Exception)
            {
                // A malformed PATH entry (invalid characters, a too-long path) is skipped, not fatal.
            }
        }

        return null;
    }

    /// <summary>The <c>dotnet</c> host that can run a framework-dependent <c>Koine.Cli.dll</c>: this
    /// process's own muxer when it is one, the SDK's <c>DOTNET_HOST_PATH</c>, the muxer next to the
    /// running shared framework, or plain <c>dotnet</c> off PATH.</summary>
    private static string DotnetMuxer()
    {
        string muxer = Executable("dotnet");

        if (Environment.ProcessPath is { Length: > 0 } self
            && string.Equals(Path.GetFileName(self), muxer, StringComparison.OrdinalIgnoreCase))
        {
            return self;
        }

        if (Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host && File.Exists(host))
        {
            return host;
        }

        // <root>/shared/Microsoft.NETCore.App/<version>/System.Private.CoreLib.dll -> <root>/dotnet
        string? framework = Path.GetDirectoryName(typeof(object).Assembly.Location);
        string? root = framework is null ? null : Directory.GetParent(framework)?.Parent?.Parent?.FullName;
        return root is not null && File.Exists(Path.Combine(root, muxer)) ? Path.Combine(root, muxer) : muxer;
    }

    private static string Executable(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;

    /// <summary>Replaces the inherited environment with the minimum a .NET child needs to start.</summary>
    private static void Scrub(ProcessStartInfo startInfo)
    {
        var kept = new List<KeyValuePair<string, string>>();
        foreach (string name in KeptEnvironmentVariables)
        {
            if (Environment.GetEnvironmentVariable(name) is { Length: > 0 } value)
            {
                kept.Add(new KeyValuePair<string, string>(name, value));
            }
        }

        startInfo.Environment.Clear();
        foreach (var (name, value) in kept)
        {
            startInfo.Environment[name] = value;
        }

        startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        startInfo.Environment["DOTNET_NOLOGO"] = "1";
        startInfo.Environment["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1";

        // Shut the diagnostics IPC channel (issue #1759). It is a named pipe / Unix socket the runtime
        // opens on start, through which anything on the machine can attach a profiler to the child or
        // make it dump — a control surface the sandbox has no use for, and one whose socket file is the
        // single write outside the run directory the child would otherwise still need.
        startInfo.Environment["DOTNET_EnableDiagnostics"] = "0";
    }

    /// <summary>Kills the child AND everything it started — a scenario that spawned helpers must not
    /// leave them behind — then waits (bounded) for it to be reaped.</summary>
    private static void Kill(Process child)
    {
        try
        {
            child.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // Already gone, or the OS refused: either way there is nothing left to stop.
        }

        try
        {
            child.WaitForExit((int)KillGrace.TotalMilliseconds);
        }
        catch (Exception)
        {
            // Best effort — the caller gets its timeout result regardless.
        }
    }

    /// <summary>
    /// Removes the run directory, retrying BRIEFLY: on Windows the run directory is the killed child's
    /// current directory, and the OS holds a handle on a process's cwd that is released only once the
    /// process is fully reaped — a moment after the kill returns. A few attempts turn that race from a
    /// leaked temp directory into a deleted one.
    ///
    /// <para>Still best-effort by design: a file some other process locked must not turn a completed run
    /// into a failure, so exhausting the attempts leaves the directory for the OS to reclaim.</para>
    /// </summary>
    private static void Delete(string directory)
    {
        for (int attempt = 1; attempt <= DeleteAttempts; attempt++)
        {
            try
            {
                if (!Directory.Exists(directory))
                {
                    return;
                }

                Directory.Delete(directory, recursive: true);
                return;
            }
            catch (Exception)
            {
                // Locked (or racing a reap): wait a beat and try again, up to the bounded attempt count.
            }

            if (attempt < DeleteAttempts)
            {
                Thread.Sleep(DeleteRetryDelay);
            }
        }
    }

    /// <summary>A not-ok run the host itself decided (the child never started, never answered, or blew
    /// its deadline). Reported as EXECUTED mode: the request went down the execution path and that path
    /// failed — calling it "interpreted" would credit an engine that never ran.</summary>
    private static ScenarioChildRun Failure(
        Scenario scenario,
        string runDirectory,
        int childId,
        bool timedOut,
        string note,
        IReadOnlyList<string>? sandboxNotes = null) =>
        new(
            WithNotes(
                ScenarioService.Error(scenario.Target, scenario.Operation, note, ScenarioService.ExecutedMode),
                sandboxNotes ?? []),
            childId,
            runDirectory,
            timedOut,
            sandboxNotes ?? []);

    /// <summary>
    /// Appends the confinement's degradation notes to a result tree's <c>notes</c>, leaving the tree
    /// untouched when there are none — so a fully confined run is byte-identical to what the child sent,
    /// and only a run that lost some confinement pays for saying so.
    /// </summary>
    private static IReadOnlyDictionary<string, object?> WithNotes(
        IReadOnlyDictionary<string, object?> result, IReadOnlyList<string> extra)
    {
        if (extra.Count == 0)
        {
            return result;
        }

        var copy = new Dictionary<string, object?>(result, StringComparer.Ordinal);
        object?[] existing = copy.TryGetValue("notes", out object? notes) && notes is object?[] array ? array : [];
        copy["notes"] = (object?[])[.. existing, .. extra];
        return copy;
    }

    /// <summary>Waits (bounded) for the stdio pumps to finish. A pump that faulted or never ended leaves
    /// its text empty, which the caller reports — it never blocks the host.</summary>
    private static void Drain(Task[] pumps)
    {
        try
        {
            Task.WaitAll(pumps, KillGrace);
        }
        catch (Exception)
        {
            // A faulted pipe read is as final as a completed one; Text() falls back to empty.
        }
    }

    private static string Text(Task<string> stream) =>
        stream.IsCompletedSuccessfully ? stream.Result : string.Empty;

    private static string Quote(string stderr) =>
        string.IsNullOrWhiteSpace(stderr)
            ? "."
            : ": " + stderr.Trim()[..Math.Min(stderr.Trim().Length, MaxQuotedStdErr)];

    private static string Format(TimeSpan timeout) =>
        timeout.TotalSeconds >= 1
            ? timeout.TotalSeconds.ToString("0.##", CultureInfo.InvariantCulture) + "s"
            : timeout.TotalMilliseconds.ToString("0", CultureInfo.InvariantCulture) + "ms";
}
