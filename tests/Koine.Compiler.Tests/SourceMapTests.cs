using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
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
}
