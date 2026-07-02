using System.Collections.Concurrent;
using Koine.Cli;
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
        config.Target.ShouldBe("glossary");
        config.OutDir.ShouldBe("./gen");
    }

    [Fact]
    public void Config_ignores_unknown_and_structured_keys()
    {
        // The R16 `targets.*` block and any other key must be tolerated, not rejected.
        var config = KoineConfig.Parse("target = csharp\ntargets.csharp = { namespaces = { A = \"B\" } }\nfuture = 1\n");
        config.Target.ShouldBe("csharp");
        config.OutDir.ShouldBeNull();
    }

    [Fact]
    public void Config_strips_inline_comments_and_blank_lines()
    {
        var config = KoineConfig.Parse("\n  target = csharp   # the default target\n\n");
        config.Target.ShouldBe("csharp");
    }

    // ---- koine init --------------------------------------------------------

    [Fact]
    public void Init_scaffold_builds_end_to_end()
    {
        // The acceptance criterion: the scaffold must compile via `koine build` immediately.
        var result = new KoineCompiler().Compile(Program.ScaffoldModel, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        result.Files.ShouldNotBeEmpty();
    }

    [Fact]
    public void Init_scaffold_config_points_build_at_the_scaffold()
    {
        var config = KoineConfig.Parse(Program.ScaffoldConfig);
        config.Target.ShouldBe("csharp");
        config.OutDir.ShouldBe("generated");
    }

    [Fact]
    public void Init_writes_the_three_starter_files()
    {
        var dir = Directory.CreateTempSubdirectory("koi-init-");
        try
        {
            var ok = Program.InitProject(dir.FullName, force: false, TextWriter.Null, TextWriter.Null);
            ok.ShouldBeTrue();
            File.Exists(Path.Combine(dir.FullName, "domain.koi")).ShouldBeTrue();
            File.Exists(Path.Combine(dir.FullName, "koine.config")).ShouldBeTrue();
            File.Exists(Path.Combine(dir.FullName, "README.md")).ShouldBeTrue();
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

            ok.ShouldBeFalse();
            error.ToString().ShouldContain("refusing to overwrite");
            File.ReadAllText(Path.Combine(dir.FullName, "domain.koi")).ShouldBe("context Mine {}\n");
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

            ok.ShouldBeTrue();
            File.ReadAllText(Path.Combine(dir.FullName, "domain.koi")).ShouldBe(Program.ScaffoldModel);
        }
        finally { dir.Delete(recursive: true); }
    }

    // ---- koine watch -------------------------------------------------------

    [Fact]
    public void Watch_builds_once_up_front_then_on_each_change()
    {
        var builds = 0;
        var session = new WatchSession(() => { builds++; return true; }, TextWriter.Null, TimeSpan.Zero);

        var changes = new BlockingCollection<object>();
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.CompleteAdding();

        var rebuilds = session.Run(changes, TestContext.Current.CancellationToken);

        rebuilds.ShouldBe(1);   // one change → one rebuild
        builds.ShouldBe(2);     // initial build + the rebuild
    }

    [Fact]
    public void Watch_debounces_a_burst_of_changes_into_one_rebuild()
    {
        var builds = 0;
        var session = new WatchSession(() => { builds++; return true; }, TextWriter.Null, TimeSpan.FromMilliseconds(20));

        var changes = new BlockingCollection<object>();
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.CompleteAdding();

        var rebuilds = session.Run(changes, TestContext.Current.CancellationToken);

        rebuilds.ShouldBe(1);   // three rapid saves collapse into a single rebuild
        builds.ShouldBe(2);
    }

    [Fact]
    public void Watch_keeps_running_after_a_throwing_build()
    {
        var builds = 0;
        var log = new StringWriter();
        // The initial build throws; the loop must survive and still process the change.
        var session = new WatchSession(() => { builds++; if (builds == 1) { throw new InvalidOperationException("boom"); } return true; },
            log, TimeSpan.Zero);

        var changes = new BlockingCollection<object>();
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.CompleteAdding();

        var rebuilds = session.Run(changes, TestContext.Current.CancellationToken);

        rebuilds.ShouldBe(1);
        builds.ShouldBe(2);
        log.ToString().ShouldContain("build error: boom");
    }

    [Fact]
    public void Watch_reports_a_failed_build_but_keeps_watching()
    {
        var log = new StringWriter();
        var session = new WatchSession(() => false, log, TimeSpan.Zero);

        var changes = new BlockingCollection<object>();
        changes.Add(new object(), TestContext.Current.CancellationToken);
        changes.CompleteAdding();

        session.Run(changes, TestContext.Current.CancellationToken);

        log.ToString().ShouldContain("build failed");
    }
}
