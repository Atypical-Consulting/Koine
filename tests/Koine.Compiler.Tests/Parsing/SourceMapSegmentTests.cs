using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// The optional <see cref="EmittedFile.SourceMap"/> member and the
/// <see cref="SourceMapSegment"/> shape: back-compat default is null, and a
/// supplied segment list round-trips with its fields intact.
/// </summary>
public class SourceMapSegmentTests
{
    [Fact]
    public void EmittedFile_without_source_map_defaults_to_null()
    {
        var file = new EmittedFile("Foo.cs", "// contents");

        file.RelativePath.ShouldBe("Foo.cs");
        file.Contents.ShouldBe("// contents");
        file.SourceMap.ShouldBeNull();
    }

    [Fact]
    public void EmittedFile_with_source_map_round_trips()
    {
        var source = new SourceSpan(3, 5, 3, 12, 40, 7, "billing.koi");
        var segment = new SourceMapSegment(
            GeneratedStartLine: 10,
            GeneratedEndLine: 14,
            SourceFile: "billing.koi",
            Source: source);

        var file = new EmittedFile(
            "Foo.cs",
            "// contents",
            new[] { segment });

        file.SourceMap.ShouldNotBeNull();
        file.SourceMap!.Count.ShouldBe(1);

        var read = file.SourceMap[0];
        read.GeneratedStartLine.ShouldBe(10);
        read.GeneratedEndLine.ShouldBe(14);
        read.SourceFile.ShouldBe("billing.koi");
        read.Source.ShouldBe(source);
    }
}
