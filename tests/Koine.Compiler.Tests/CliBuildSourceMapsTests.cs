using Koine.Cli;

namespace Koine.Compiler.Tests;

/// <summary>
/// End-to-end tests for the <c>--source-maps</c> build flag (production-grade emit, Task 5). They
/// drive the real CLI entry point (<see cref="Program.Run"/>) so the whole flag path is exercised:
/// <c>BuildSettings.SourceMaps</c> → <c>BuildPlan</c> → the CLI <c>EmitterRegistry</c> → the neutral
/// <c>EmitterOptions</c> → each backend's option type. With the flag off, the emitted artifacts must
/// be byte-identical to a plain build (no <c>#line</c>, no <c>*.map</c> sidecar).
/// </summary>
public class CliBuildSourceMapsTests
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
        var dir = Directory.CreateTempSubdirectory("koi-srcmap-").FullName;
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, content);
        return (path, dir);
    }

    private static IEnumerable<string> CsFiles(string outDir) =>
        Directory.EnumerateFiles(outDir, "*.cs", SearchOption.AllDirectories);

    [Fact]
    public void Csharp_with_source_maps_emits_line_directives()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var outDir = Path.Combine(dir, "generated");

            var (code, _, _) = Run("build", src, "--target", "csharp", "--out", outDir, "--source-maps");

            code.ShouldBe(0);
            var anyLineDirective = CsFiles(outDir).Any(f => File.ReadAllText(f).Contains("#line"));
            anyLineDirective.ShouldBeTrue();
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Csharp_without_source_maps_emits_no_line_directives()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var outDir = Path.Combine(dir, "generated");

            var (code, _, _) = Run("build", src, "--target", "csharp", "--out", outDir);

            code.ShouldBe(0);
            var anyLineDirective = CsFiles(outDir).Any(f => File.ReadAllText(f).Contains("#line"));
            anyLineDirective.ShouldBeFalse();
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Typescript_with_source_maps_writes_a_map_sidecar()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var outDir = Path.Combine(dir, "generated");

            var (code, _, _) = Run("build", src, "--target", "typescript", "--out", outDir, "--source-maps");

            code.ShouldBe(0);
            Directory.EnumerateFiles(outDir, "*.map", SearchOption.AllDirectories).Any().ShouldBeTrue();
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void Typescript_without_source_maps_writes_no_map_sidecar()
    {
        var (src, dir) = TempModel(Program.ScaffoldModel);
        try
        {
            var outDir = Path.Combine(dir, "generated");

            var (code, _, _) = Run("build", src, "--target", "typescript", "--out", outDir);

            code.ShouldBe(0);
            Directory.EnumerateFiles(outDir, "*.ts", SearchOption.AllDirectories).Any().ShouldBeTrue();
            Directory.EnumerateFiles(outDir, "*.map", SearchOption.AllDirectories).Any().ShouldBeFalse();
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
