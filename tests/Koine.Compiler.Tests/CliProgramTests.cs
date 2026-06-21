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

        code.ShouldBe(0);
        stdout.Trim().ShouldBe(Program.GetVersion());
        // Regression: it must not fall back to the four-part AssemblyVersion default.
        stdout.Trim().ShouldNotBe("1.0.0.0");
        stdout.Trim().ShouldBe("0.17.3");
    }

    // ---- global help / no args / unknown command ---------------------------

    [Fact]
    public void No_args_prints_help_to_stdout()
    {
        var (code, stdout, _) = Run();

        // Spectre prints the root help when no command is given.
        code.ShouldBe(0);
        stdout.ShouldContain("USAGE:");
        stdout.ShouldContain("build");
    }

    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    public void Global_help_prints_usage_to_stdout_and_exits_zero(string flag)
    {
        var (code, stdout, _) = Run(flag);

        code.ShouldBe(0);
        stdout.ShouldContain("USAGE:");
        stdout.ShouldContain("build");
        stdout.ShouldContain("lsp");
    }

    [Fact]
    public void Unknown_command_reports_the_command_and_exits_nonzero()
    {
        var (code, stdout, _) = Run("frobnicate");

        code.ShouldBe(1);
        stdout.ShouldContain("Unknown command 'frobnicate'");
    }

    // ---- per-command help --------------------------------------------------

    [Theory]
    [InlineData("build")]
    [InlineData("check")]
    [InlineData("fmt")]
    [InlineData("init")]
    [InlineData("watch")]
    [InlineData("mcp")]
    public void Per_command_help_exits_zero_with_a_focused_usage_block(string command)
    {
        var (code, stdout, _) = Run(command, "--help");

        code.ShouldBe(0);
        stdout.ShouldContain($"koine {command}");
        stdout.ShouldContain("USAGE:");
        stdout.ShouldContain("EXAMPLES:");
    }

    [Fact]
    public void Per_command_help_short_flag_also_works()
    {
        var (code, stdout, _) = Run("build", "-h");

        code.ShouldBe(0);
        stdout.ShouldContain("koine build");
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

            code.ShouldBe(1);
            stdout.ShouldContain("Unknown option 'bogus'");
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Missing_required_argument_is_a_parse_error()
    {
        var (code, stdout, _) = Run("build");

        code.ShouldBe(1);
        stdout.ShouldContain("missing required argument");
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

            code.ShouldBe(0);
            stdout.ShouldContain("already formatted");
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

            code.ShouldBe(1);
            stderr.ShouldContain("not formatted");
            File.ReadAllText(path).ShouldBe(messy);   // --check never writes
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

            code.ShouldBe(1);
            stderr.ShouldContain("could not be parsed");
            stderr.ShouldContain($"{path}:");            // file:line:col diagnostic
            File.ReadAllText(path).ShouldBe(broken);   // never modified
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

            code.ShouldBe(1);
            File.ReadAllText(path).ShouldBe(broken);   // fmt does not fix unparseable files
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    // ---- runtime errors are plain on stderr (no help dump) -----------------

    [Fact]
    public void Missing_input_file_reports_a_runtime_error_with_a_hint_on_stderr()
    {
        var (code, _, stderr) = Run("build", "/no/such/file.koi");

        code.ShouldBe(1);
        stderr.ShouldContain("not found");
        stderr.ShouldContain("koine init");    // actionable hint
        stderr.ShouldNotContain("USAGE");   // not a help dump
    }

    [Fact]
    public void Unsupported_target_reports_a_runtime_error_on_stderr()
    {
        var (path, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var (code, _, stderr) = Run("build", path, "--target", "ruby");

            code.ShouldBe(1);
            stderr.ShouldContain("unsupported target 'ruby'");
            stderr.ShouldContain("csharp");        // lists the supported targets
            stderr.ShouldNotContain("USAGE");
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

            code.ShouldBe(0);
            stdout.ShouldContain("wrote");
            Directory.EnumerateFiles(outDir, "*.cs", SearchOption.AllDirectories).Any().ShouldBeTrue();
            // The swap must leave no staging directories behind.
            Directory.EnumerateDirectories(outDir).ShouldNotContain(d => Path.GetFileName(d).Contains("koine-tmp"));
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

            code.ShouldBe(0);
            stdout.ShouldContain("parsed and validated");
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

        var changes = new BlockingCollection<object>();
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.CompleteAdding();

        session.Run(changes, TestContext.Current.CancellationToken);

        beforeBuilds.ShouldBe(2);   // initial build + the one rebuild
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

        (builds >= 3).ShouldBeTrue();
    }

    // ---- check: per-rule severity config (issue #73, A3) -------------------

    [Fact]
    public void Check_SeverityConfig_DowngradesRenameToNonBreaking()
    {
        // An open-host value object: renaming its field is a published-surface rename (KOI1515) with no
        // event-shape coupling, so the severity override is the only thing that can clear the gate.
        const string baselineSrc = """
            context Sales {
              value Money { total: Decimal }
            }
            context Shipping { }
            contextmap { Sales -> Shipping : open-host }
            """;
        const string currentSrc = """
            context Sales {
              value Money { amount: Decimal }
            }
            context Shipping { }
            contextmap { Sales -> Shipping : open-host }
            """;
        var (_, baseDir) = TempModel(baselineSrc, "baseline.koi");
        var (currentFile, _) = TempModel(currentSrc, "current.koi");

        // Renaming a published field (KOI1515) is breaking by default → non-zero exit.
        var (code1, _, _) = Run("check", currentFile, "--baseline", baseDir);
        code1.ShouldBe(1);

        // A koine.config that downgrades the rename to NonBreaking clears the gate → exit 0.
        var (configFile, _) = TempModel("check.severity.KOI1515 = NonBreaking\n", "koine.config");
        var (code2, _, _) = Run("check", currentFile, "--baseline", baseDir, "--config", configFile);
        code2.ShouldBe(0);
    }
}
