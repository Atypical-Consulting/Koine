using System.Collections.Concurrent;
using Koine.Cli;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R17.3 — <c>koine init</c>, <c>koine watch</c>, and <c>koine.config</c>.</summary>
public class R17ToolingTests
{
    // ---- koine.config ------------------------------------------------------

    [Fact]
    public void Config_parses_target_and_out()
    {
        var config = KoineConfig.Parse("# header\ntarget = glossary\nout = ./gen\n");
        Assert.Equal("glossary", config.Target);
        Assert.Equal("./gen", config.OutDir);
    }

    [Fact]
    public void Config_ignores_unknown_and_structured_keys()
    {
        // The R16 `targets.*` block and any other key must be tolerated, not rejected.
        var config = KoineConfig.Parse("target = csharp\ntargets.csharp = { namespaces = { A = \"B\" } }\nfuture = 1\n");
        Assert.Equal("csharp", config.Target);
        Assert.Null(config.OutDir);
    }

    [Fact]
    public void Config_strips_inline_comments_and_blank_lines()
    {
        var config = KoineConfig.Parse("\n  target = csharp   # the default target\n\n");
        Assert.Equal("csharp", config.Target);
    }

    // ---- koine init --------------------------------------------------------

    [Fact]
    public void Init_scaffold_builds_end_to_end()
    {
        // The acceptance criterion: the scaffold must compile via `koine build` immediately.
        var result = new KoineCompiler().Compile(Program.ScaffoldModel, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        Assert.NotEmpty(result.Files);
    }

    [Fact]
    public void Init_scaffold_config_points_build_at_the_scaffold()
    {
        var config = KoineConfig.Parse(Program.ScaffoldConfig);
        Assert.Equal("csharp", config.Target);
        Assert.Equal("generated", config.OutDir);
    }

    [Fact]
    public void Init_writes_the_three_starter_files()
    {
        var dir = Directory.CreateTempSubdirectory("koi-init-");
        try
        {
            var ok = Program.InitProject(dir.FullName, force: false, TextWriter.Null, TextWriter.Null);
            Assert.True(ok);
            Assert.True(File.Exists(Path.Combine(dir.FullName, "domain.koi")));
            Assert.True(File.Exists(Path.Combine(dir.FullName, "koine.config")));
            Assert.True(File.Exists(Path.Combine(dir.FullName, "README.md")));
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Init_refuses_to_overwrite_without_force()
    {
        var dir = Directory.CreateTempSubdirectory("koi-init-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "domain.koi"), "context Mine {}\n");

            var error = new StringWriter();
            var ok = Program.InitProject(dir.FullName, force: false, TextWriter.Null, error);

            Assert.False(ok);
            Assert.Contains("refusing to overwrite", error.ToString());
            Assert.Equal("context Mine {}\n", File.ReadAllText(Path.Combine(dir.FullName, "domain.koi")));
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Init_force_overwrites_existing_files()
    {
        var dir = Directory.CreateTempSubdirectory("koi-init-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "domain.koi"), "context Mine {}\n");
            var ok = Program.InitProject(dir.FullName, force: true, TextWriter.Null, TextWriter.Null);

            Assert.True(ok);
            Assert.Equal(Program.ScaffoldModel, File.ReadAllText(Path.Combine(dir.FullName, "domain.koi")));
        }
        finally { dir.Delete(recursive: true); }
    }

    // ---- koine watch -------------------------------------------------------

    [Fact]
    public void Watch_builds_once_up_front_then_on_each_change()
    {
        var builds = 0;
        var session = new WatchSession(() => { builds++; return true; }, TextWriter.Null, TimeSpan.Zero);

        var changes = new BlockingCollection<object> { new object() };
        changes.CompleteAdding();

        var rebuilds = session.Run(changes);

        Assert.Equal(1, rebuilds);   // one change → one rebuild
        Assert.Equal(2, builds);     // initial build + the rebuild
    }

    [Fact]
    public void Watch_debounces_a_burst_of_changes_into_one_rebuild()
    {
        var builds = 0;
        var session = new WatchSession(() => { builds++; return true; }, TextWriter.Null, TimeSpan.FromMilliseconds(20));

        var changes = new BlockingCollection<object> { new object(), new object(), new object() };
        changes.CompleteAdding();

        var rebuilds = session.Run(changes);

        Assert.Equal(1, rebuilds);   // three rapid saves collapse into a single rebuild
        Assert.Equal(2, builds);
    }

    [Fact]
    public void Watch_keeps_running_after_a_throwing_build()
    {
        var builds = 0;
        var log = new StringWriter();
        // The initial build throws; the loop must survive and still process the change.
        var session = new WatchSession(() => { builds++; if (builds == 1) throw new InvalidOperationException("boom"); return true; },
            log, TimeSpan.Zero);

        var changes = new BlockingCollection<object> { new object() };
        changes.CompleteAdding();

        var rebuilds = session.Run(changes);

        Assert.Equal(1, rebuilds);
        Assert.Equal(2, builds);
        Assert.Contains("build error: boom", log.ToString());
    }

    [Fact]
    public void Watch_reports_a_failed_build_but_keeps_watching()
    {
        var log = new StringWriter();
        var session = new WatchSession(() => false, log, TimeSpan.Zero);

        var changes = new BlockingCollection<object> { new object() };
        changes.CompleteAdding();

        session.Run(changes);

        Assert.Contains("build failed", log.ToString());
    }
}
