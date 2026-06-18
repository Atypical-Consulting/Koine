using System.Collections.Concurrent;
using Koine.Cli;

namespace Koine.Compiler.Tests;

/// <summary>
/// Process-level / argv tests for the CLI entry point (<see cref="Program.Run"/>), driven
/// through the internal entry point (InternalsVisibleTo) so we can assert exit codes and the
/// text printed to stdout/stderr. The CLI is built on Spectre.Console.Cli, so framework
/// concerns (command dispatch, unknown command/option, missing argument, help) are rendered by
/// Spectre to <em>stdout</em>; the CLI's own runtime errors (missing input, unsupported target)
/// stay plain on <em>stderr</em>.
/// </summary>
public class CliProgramTests
{
    /// <summary>Runs the CLI with <paramref name="args"/>, capturing stdout/stderr and the exit code.</summary>
    private static (int Code, string Out, string Err) Run(params string[] args)
    {
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        var sout = new StringWriter();
        var serr = new StringWriter();
        try
        {
            Console.SetOut(sout);
            Console.SetError(serr);
            var code = Program.Run(args);
            return (code, sout.ToString(), serr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    /// <summary>Writes <paramref name="content"/> to a fresh temp dir and returns the file path and its dir.</summary>
    private static (string File, string Dir) TempModel(string content, string name = "domain.koi")
    {
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, content);
        return (path, dir);
    }

    // ---- version -----------------------------------------------------------

    [Theory]
    [InlineData("--version")]
    [InlineData("-v")]
    public void Version_prints_the_informational_version_not_1_0_0_0(string flag)
    {
        var (code, stdout, _) = Run(flag);

        Assert.Equal(0, code);
        Assert.Equal(Program.GetVersion(), stdout.Trim());
        // Regression: it must not fall back to the four-part AssemblyVersion default.
        Assert.NotEqual("1.0.0.0", stdout.Trim());
        Assert.Equal("0.17.3", stdout.Trim());
    }

    // ---- global help / no args / unknown command ---------------------------

    [Fact]
    public void No_args_prints_help_to_stdout()
    {
        var (code, stdout, _) = Run();

        // Spectre prints the root help when no command is given.
        Assert.Equal(0, code);
        Assert.Contains("USAGE:", stdout);
        Assert.Contains("build", stdout);
    }

    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    public void Global_help_prints_usage_to_stdout_and_exits_zero(string flag)
    {
        var (code, stdout, _) = Run(flag);

        Assert.Equal(0, code);
        Assert.Contains("USAGE:", stdout);
        Assert.Contains("build", stdout);
        Assert.Contains("lsp", stdout);
    }

    [Fact]
    public void Unknown_command_reports_the_command_and_exits_nonzero()
    {
        var (code, stdout, _) = Run("frobnicate");

        Assert.Equal(1, code);
        Assert.Contains("Unknown command 'frobnicate'", stdout);
    }

    // ---- per-command help --------------------------------------------------

    [Theory]
    [InlineData("build")]
    [InlineData("check")]
    [InlineData("fmt")]
    [InlineData("init")]
    [InlineData("watch")]
    public void Per_command_help_exits_zero_with_a_focused_usage_block(string command)
    {
        var (code, stdout, _) = Run(command, "--help");

        Assert.Equal(0, code);
        Assert.Contains($"koine {command}", stdout);
        Assert.Contains("USAGE:", stdout);
        Assert.Contains("EXAMPLES:", stdout);
    }

    [Fact]
    public void Per_command_help_short_flag_also_works()
    {
        var (code, stdout, _) = Run("build", "-h");

        Assert.Equal(0, code);
        Assert.Contains("koine build", stdout);
    }

    // ---- usage errors (Spectre, on stdout) ---------------------------------

    [Fact]
    public void Unknown_option_on_a_subcommand_is_a_parse_error()
    {
        // A valid positional first, so the unknown-option error (not "missing argument") wins.
        var (file, dir) = TempModel("context C { value Money { amount: Decimal } }\n");
        try
        {
            var (code, stdout, _) = Run("fmt", file, "--bogus");

            Assert.Equal(1, code);
            Assert.Contains("Unknown option 'bogus'", stdout);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Missing_required_argument_is_a_parse_error()
    {
        var (code, stdout, _) = Run("build");

        Assert.Equal(1, code);
        Assert.Contains("missing required argument", stdout);
    }

    // ---- fmt --check on good and broken files ------------------------------

    [Fact]
    public void Fmt_check_passes_on_a_canonically_formatted_file()
    {
        // A canonical model formats to itself, so --check must be clean (exit 0).
        var formatted = new Formatting.KoineFormatter().Format(Program.ScaffoldModel).Text;
        var (path, dir) = TempModel(formatted);
        try
        {
            var (code, stdout, _) = Run("fmt", path, "--check");

            Assert.Equal(0, code);
            Assert.Contains("already formatted", stdout);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Fmt_check_flags_an_unformatted_file_without_writing()
    {
        const string messy = "context C {\n  value Money{amount:Decimal}\n}\n";
        var (path, dir) = TempModel(messy, "messy.koi");
        try
        {
            var (code, _, stderr) = Run("fmt", path, "--check");

            Assert.Equal(1, code);
            Assert.Contains("not formatted", stderr);
            Assert.Equal(messy, File.ReadAllText(path));   // --check never writes
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Fmt_check_reports_an_unparseable_file_with_a_file_line_message()
    {
        // Missing closing brace etc. — the formatter cannot fix this; fmt must report it.
        const string broken = "context C {\n  value Money { amount: \n";
        var (path, dir) = TempModel(broken, "broken.koi");
        try
        {
            var (code, _, stderr) = Run("fmt", path, "--check");

            Assert.Equal(1, code);
            Assert.Contains("could not be parsed", stderr);
            Assert.Contains($"{path}:", stderr);            // file:line:col diagnostic
            Assert.Equal(broken, File.ReadAllText(path));   // never modified
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Fmt_write_mode_refuses_an_unparseable_file_and_exits_nonzero()
    {
        const string broken = "context C {\n  value Money { amount: \n";
        var (path, dir) = TempModel(broken, "broken.koi");
        try
        {
            var (code, _, _) = Run("fmt", path);

            Assert.Equal(1, code);
            Assert.Equal(broken, File.ReadAllText(path));   // fmt does not fix unparseable files
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ---- runtime errors are plain on stderr (no help dump) -----------------

    [Fact]
    public void Missing_input_file_reports_a_runtime_error_with_a_hint_on_stderr()
    {
        var (code, _, stderr) = Run("build", "/no/such/file.koi");

        Assert.Equal(1, code);
        Assert.Contains("not found", stderr);
        Assert.Contains("koine init", stderr);    // actionable hint
        Assert.DoesNotContain("USAGE", stderr);   // not a help dump
    }

    [Fact]
    public void Unsupported_target_reports_a_runtime_error_on_stderr()
    {
        var (path, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var (code, _, stderr) = Run("build", path, "--target", "rust");

            Assert.Equal(1, code);
            Assert.Contains("unsupported target 'rust'", stderr);
            Assert.Contains("csharp", stderr);        // lists the supported targets
            Assert.DoesNotContain("USAGE", stderr);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ---- build success writes output atomically ----------------------------

    [Fact]
    public void Build_with_out_writes_generated_files_and_exits_zero()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var outDir = Path.Combine(dir, "generated");

            var (code, stdout, _) = Run("build", src, "--out", outDir);

            Assert.Equal(0, code);
            Assert.Contains("wrote", stdout);
            Assert.True(Directory.EnumerateFiles(outDir, "*.cs", SearchOption.AllDirectories).Any());
            // The swap must leave no staging directories behind.
            Assert.DoesNotContain(Directory.EnumerateDirectories(outDir),
                d => Path.GetFileName(d).Contains("koine-tmp"));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Build_without_out_only_validates_and_exits_zero()
    {
        // An isolated dir (no koine.config beside it) so nothing supplies a default --out.
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var (code, stdout, _) = Run("build", src);

            Assert.Equal(0, code);
            Assert.Contains("parsed and validated", stdout);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ---- watch: --clear hook & dropped-event safety net --------------------

    [Fact]
    public void Watch_runs_the_before_build_hook_before_every_build()
    {
        var beforeBuilds = 0;
        var session = new WatchSession(
            () => true, TextWriter.Null, TimeSpan.Zero,
            beforeBuild: () => beforeBuilds++);

        var changes = new BlockingCollection<object> { new object() };
        changes.CompleteAdding();

        session.Run(changes);

        Assert.Equal(2, beforeBuilds);   // initial build + the one rebuild
    }

    [Fact]
    public void Watch_does_a_safety_net_rebuild_when_the_interval_elapses_with_no_change()
    {
        var builds = 0;
        // A tiny full-rebuild interval and no incoming changes: the loop must still rebuild
        // periodically (guarding against dropped FileSystemWatcher events), then we cancel.
        using var cts = new CancellationTokenSource();
        var session = new WatchSession(
            () =>
            {
                builds++;
                if (builds >= 3)
                {
                    cts.Cancel();   // initial build + at least two interval-driven rebuilds
                }

                return true;
            },
            TextWriter.Null,
            TimeSpan.Zero,
            fullRebuildInterval: TimeSpan.FromMilliseconds(10));

        var changes = new BlockingCollection<object>();   // never completed, never fed
        session.Run(changes, cts.Token);

        Assert.True(builds >= 3);
    }
}
