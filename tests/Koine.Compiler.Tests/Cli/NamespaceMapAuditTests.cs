using Koine.Cli;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1255: a <c>koine.config</c> <c>targets.&lt;target&gt;.namespaces.&lt;Context&gt;</c> key that
/// can never match any real context (a typo, or — per #1239/PR #1251's review — a non-ASCII name)
/// used to silently no-op. Once the model is compiled and its context names are known, the CLI now
/// cross-checks every target's namespace-map keys against them and warns (not errors — a config staged
/// ahead of a future <c>.koi</c> addition is legitimate) on any key that can't possibly match.
/// </summary>
[Collection(CliConsoleCollection.Name)]
public class NamespaceMapAuditTests
{
    /// <summary>Runs the CLI with <paramref name="args"/>, capturing stdout/stderr and the exit code.</summary>
    private static (int Code, string Stderr) Run(params string[] args)
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
            return (code, serr.ToString());
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
        var dir = Directory.CreateTempSubdirectory("koi-nsmap-").FullName;
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, content);
        return (path, dir);
    }

    [Fact]
    public void Unmatched_namespace_map_key_warns_naming_the_key_and_target()
    {
        // Program.ScaffoldModel's only context is "Catalog" — "Orderng" (a typo) can never match.
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var configPath = Path.Combine(dir, KoineConfig.FileName);
            File.WriteAllText(configPath, "targets.csharp.namespaces.Orderng = Acme.Ordering\n");

            var (code, stderr) = Run("build", src, "--config", configPath, "--target", "csharp");

            code.ShouldBe(0);
            stderr.ShouldContain("Orderng");
            stderr.ShouldContain("csharp");
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Matching_namespace_map_key_produces_no_warning()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var configPath = Path.Combine(dir, KoineConfig.FileName);
            File.WriteAllText(configPath, "targets.csharp.namespaces.Catalog = Acme.Catalog\n");

            var (code, stderr) = Run("build", src, "--config", configPath, "--target", "csharp");

            code.ShouldBe(0);
            stderr.ShouldBeEmpty();
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void No_namespace_map_produces_no_warning()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var (code, stderr) = Run("build", src, "--target", "csharp");

            code.ShouldBe(0);
            stderr.ShouldBeEmpty();
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
