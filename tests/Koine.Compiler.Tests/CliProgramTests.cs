using System.Collections.Concurrent;
using Koine.Cli;

namespace Koine.Compiler.Tests;

/// <summary>
/// Process-level / argv tests for the CLI entry point (<see cref="Program.Run"/>), driven
/// through the internal entry point (InternalsVisibleTo) so we can assert exit codes and the
/// exact text printed to stdout/stderr. Covers version, global &amp; per-command help, unknown
/// commands, and fmt --check on good and broken input.
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
    public void No_args_prints_usage_to_stderr_and_exits_nonzero()
    {
        var (code, _, stderr) = Run();

        Assert.Equal(1, code);
        Assert.Contains("Usage:", stderr);
    }

    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    [InlineData("help")]
    public void Global_help_prints_usage_to_stdout_and_exits_zero(string flag)
    {
        var (code, stdout, _) = Run(flag);

        Assert.Equal(0, code);
        Assert.Contains("Usage:", stdout);
        Assert.Contains("koine build", stdout);
    }

    [Fact]
    public void Unknown_command_reports_the_command_and_exits_nonzero()
    {
        var (code, _, stderr) = Run("frobnicate");

        Assert.Equal(1, code);
        Assert.Contains("unknown command 'frobnicate'", stderr);
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
        Assert.Contains("Usage:", stdout);
        Assert.Contains("Examples:", stdout);
    }

    [Fact]
    public void Per_command_help_short_flag_also_works()
    {
        var (code, stdout, _) = Run("build", "-h");

        Assert.Equal(0, code);
        Assert.Contains("koine build", stdout);
    }

    // ---- usage errors show command help ------------------------------------

    [Fact]
    public void Unknown_option_on_a_subcommand_shows_that_commands_help()
    {
        var (code, _, stderr) = Run("fmt", "--bogus");

        Assert.Equal(1, code);
        Assert.Contains("unknown option '--bogus'", stderr);
        Assert.Contains("koine fmt", stderr);
    }

    // ---- fmt --check on good and broken files ------------------------------

    [Fact]
    public void Fmt_check_passes_on_a_canonically_formatted_file()
    {
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        try
        {
            // A canonical model formats to itself, so --check must be clean (exit 0).
            var formatted = new Formatting.KoineFormatter().Format(Program.ScaffoldModel).Text;
            var path = Path.Combine(dir, "domain.koi");
            File.WriteAllText(path, formatted);

            var (code, stdout, _) = Run("fmt", path, "--check");

            Assert.Equal(0, code);
            Assert.Contains("already formatted", stdout);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Fmt_check_flags_an_unformatted_file_without_writing()
    {
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        try
        {
            const string messy = "context C {\n  value Money{amount:Decimal}\n}\n";
            var path = Path.Combine(dir, "messy.koi");
            File.WriteAllText(path, messy);

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
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        try
        {
            // Missing closing brace etc. — the formatter cannot fix this; fmt must report it.
            const string broken = "context C {\n  value Money { amount: \n";
            var path = Path.Combine(dir, "broken.koi");
            File.WriteAllText(path, broken);

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
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        try
        {
            const string broken = "context C {\n  value Money { amount: \n";
            var path = Path.Combine(dir, "broken.koi");
            File.WriteAllText(path, broken);

            var (code, _, _) = Run("fmt", path);

            Assert.Equal(1, code);
            Assert.Equal(broken, File.ReadAllText(path));   // fmt does not fix unparseable files
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ---- runtime errors do not dump the global usage -----------------------

    [Fact]
    public void Missing_input_file_reports_a_runtime_error_with_a_hint_not_global_usage()
    {
        var (code, _, stderr) = Run("build", "/no/such/file.koi");

        Assert.Equal(1, code);
        Assert.Contains("not found", stderr);
        Assert.Contains("koine init", stderr);   // actionable hint
        Assert.DoesNotContain("Usage:", stderr);  // not the full global usage dump
    }

    [Fact]
    public void Unsupported_target_reports_a_runtime_error_not_global_usage()
    {
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        try
        {
            var path = Path.Combine(dir, "domain.koi");
            File.WriteAllText(path, Program.ScaffoldModel);

            var (code, _, stderr) = Run("build", path, "--target", "rust");

            Assert.Equal(1, code);
            Assert.Contains("unsupported target 'rust'", stderr);
            Assert.DoesNotContain("Usage:", stderr);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Bad_flag_on_build_is_a_usage_error_that_shows_build_help()
    {
        var (code, _, stderr) = Run("build", "--nope");

        Assert.Equal(1, code);
        Assert.Contains("unknown option '--nope'", stderr);
        Assert.Contains("koine build", stderr);
    }

    // ---- build success writes output atomically ----------------------------

    [Fact]
    public void Build_with_out_writes_generated_files_and_exits_zero()
    {
        var dir = Directory.CreateTempSubdirectory("koi-cli-").FullName;
        try
        {
            var src = Path.Combine(dir, "domain.koi");
            File.WriteAllText(src, Program.ScaffoldModel);
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
