using System.Text.Json;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Production-grade emit, Task 3: the C# emitter can optionally stamp <c>#line</c> directives and
/// build a per-declaration <see cref="SourceMapSegment"/> map back to the originating <c>.koi</c>
/// source. The feature is gated on <see cref="CSharpEmitterOptions.EmitSourceMaps"/> (default
/// <c>false</c>); with the flag off the emitted text MUST be byte-identical to the default emitter.
/// </summary>
public class SourceMapTests
{
    private const string ValueObjectFixture = """
        context Catalog {
          value Money {
            amount: Decimal
            currency: String
          }
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(CSharpEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("values.koi", ValueObjectFixture) },
            new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static EmittedFile MoneyFile(IReadOnlyList<EmittedFile> files) =>
        files.Single(f => f.RelativePath.EndsWith("Money.cs", StringComparison.Ordinal));

    [Fact]
    public void EmitSourceMaps_stamps_line_directives_and_a_non_empty_source_map()
    {
        var files = Emit(CSharpEmitterOptions.Empty with { EmitSourceMaps = true });
        var money = MoneyFile(files);

        // A `#line N "values.koi"` directive is stamped before the declaration.
        money.Contents.ShouldContain("#line ");
        money.Contents.ShouldContain("\"values.koi\"");

        // The returned file carries a non-null, non-empty source map.
        money.SourceMap.ShouldNotBeNull();
        money.SourceMap.ShouldNotBeEmpty();

        var segment = money.SourceMap.Single();
        segment.SourceFile.ShouldBe("values.koi");
        segment.Source.File.ShouldBe("values.koi");
        // The generated range is well-formed and within the file.
        var lineCount = money.Contents.Split('\n').Length;
        segment.GeneratedStartLine.ShouldBeGreaterThan(0);
        segment.GeneratedEndLine.ShouldBeGreaterThanOrEqualTo(segment.GeneratedStartLine);
        segment.GeneratedEndLine.ShouldBeLessThanOrEqualTo(lineCount);
    }

    [Fact]
    public void EmitSourceMaps_segment_starts_on_the_line_after_the_directive()
    {
        // Regression: the segment's generated start line must be exactly the physical line where the
        // body begins — i.e. the line immediately after the `#line` directive (not one past it).
        var files = Emit(CSharpEmitterOptions.Empty with { EmitSourceMaps = true });
        var money = MoneyFile(files);

        var lines = money.Contents.Split('\n');
        var directiveIndex = Array.FindIndex(
            lines, l => l.StartsWith("#line ", StringComparison.Ordinal) && l.Contains("values.koi", StringComparison.Ordinal));
        directiveIndex.ShouldBeGreaterThanOrEqualTo(0);

        // 1-based: the directive is on line (directiveIndex + 1); the body starts on the next line.
        var expectedStart = directiveIndex + 2;
        money.SourceMap!.Single().GeneratedStartLine.ShouldBe(expectedStart);
    }

    [Fact]
    public void EmitSourceMaps_escapes_backslashes_and_quotes_in_the_line_path()
    {
        // A Windows-style path (backslashes) must be escaped so the `#line` string literal stays
        // valid C#; the raw unescaped separators must not appear in the directive.
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile(@"models\sub\values.koi", ValueObjectFixture) },
            new CSharpEmitter(CSharpEmitterOptions.Empty with { EmitSourceMaps = true }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var money = MoneyFile(result.Files);

        money.Contents.ShouldContain(@"#line ");
        money.Contents.ShouldContain(@"models\\sub\\values.koi");   // escaped
        // The emitted C# (with the escaped path) still compiles.
        var (assembly, errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void EmitSourceMaps_output_still_roslyn_compiles()
    {
        var files = Emit(CSharpEmitterOptions.Empty with { EmitSourceMaps = true });

        var (assembly, errors) = TestSupport.Compile(files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Default_options_are_byte_identical_to_the_default_emitter()
    {
        // The flag-off path produces exactly what the unconfigured emitter does, with no
        // `#line` directives and a null source map.
        var defaultOff = Emit(CSharpEmitterOptions.Empty);
        var unconfigured = new KoineCompiler().Compile(
            new[] { new SourceFile("values.koi", ValueObjectFixture) },
            new CSharpEmitter()).Files;

        TestSupport.Render(defaultOff).ShouldBe(TestSupport.Render(unconfigured));

        foreach (var f in defaultOff)
        {
            f.Contents.ShouldNotContain("#line ");
            f.SourceMap.ShouldBeNull();
        }
    }

    // ------------------------------------------------------------------
    // TypeScript backend (Task 4): a Source Map v3 sidecar + sourceMappingURL,
    // gated on TsEmitterOptions.EmitSourceMaps. Off path stays byte-identical.
    // ------------------------------------------------------------------

    private static IReadOnlyList<EmittedFile> EmitTs(TsEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("values.koi", ValueObjectFixture) },
            new TypeScriptEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static EmittedFile MoneyTsFile(IReadOnlyList<EmittedFile> files) =>
        files.Single(f => f.RelativePath.EndsWith("Money.ts", StringComparison.Ordinal));

    [Fact]
    public void Ts_EmitSourceMaps_writes_a_v3_sidecar_and_sourceMappingURL()
    {
        var files = EmitTs(new TsEmitterOptions { EmitSourceMaps = true });
        var money = MoneyTsFile(files);

        // The module ends with a sourceMappingURL comment pointing at the sidecar.
        money.Contents.TrimEnd().ShouldEndWith("//# sourceMappingURL=Money.ts.map");

        // A sidecar *.map file exists alongside the module.
        var sidecar = files.SingleOrDefault(f =>
            f.RelativePath.EndsWith("Money.ts.map", StringComparison.Ordinal));
        sidecar.ShouldNotBeNull();

        // It parses as a Source Map v3 object with version 3 and a non-empty mappings.
        using var doc = JsonDocument.Parse(sidecar.Contents);
        JsonElement root = doc.RootElement;
        root.GetProperty("version").GetInt32().ShouldBe(3);
        root.GetProperty("file").GetString().ShouldBe("Money.ts");
        root.GetProperty("sources").EnumerateArray().Select(e => e.GetString())
            .ShouldContain("values.koi");
        root.GetProperty("mappings").GetString().ShouldNotBeNullOrEmpty();
    }

    [Fact]
    public void Ts_default_options_are_byte_identical_to_the_default_emitter()
    {
        var defaultOff = EmitTs(new TsEmitterOptions());
        var unconfigured = new KoineCompiler().Compile(
            new[] { new SourceFile("values.koi", ValueObjectFixture) },
            new TypeScriptEmitter()).Files;

        TestSupport.Render(defaultOff).ShouldBe(TestSupport.Render(unconfigured));

        foreach (var f in defaultOff)
        {
            f.Contents.ShouldNotContain("//# sourceMappingURL=");
            f.RelativePath.ShouldNotEndWith(".map");
            f.SourceMap.ShouldBeNull();
        }
    }
}
