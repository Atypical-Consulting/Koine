using Koine.Cli.Infrastructure;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// Byte-level contract tests for <see cref="OutputWriter"/>: emitted files must be UTF-8 with
/// no BOM, use <c>\n</c> line endings (no <c>\r</c>), and be byte-deterministic across runs so
/// downstream tooling (diffs, hashing, watchers) sees identical output for identical input.
/// </summary>
public class OutputWriterTests
{
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    private static string FreshDir()
        => Directory.CreateTempSubdirectory("koi-outwriter-").FullName;

    [Fact]
    public void WriteOutputAtomic_emits_utf8_without_bom_and_lf_only()
    {
        var dir = FreshDir();
        var files = new[]
        {
            // Deliberately mixed/CRLF content with non-ASCII to exercise encoding + normalization.
            new EmittedFile("Root/A.cs", "// héllo\r\nline two\r\n"),
            new EmittedFile("Root/Sub/B.cs", "x\ny\n"),
        };

        OutputWriter.WriteOutputAtomic(dir, files);

        foreach (var rel in new[] { "Root/A.cs", "Root/Sub/B.cs" })
        {
            var bytes = File.ReadAllBytes(Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar)));
            AssertUtf8NoBom(bytes);
            AssertNoCarriageReturn(bytes);
        }
    }

    [Fact]
    public void WriteOutputAtomic_is_byte_deterministic_across_runs()
    {
        var files = new[]
        {
            new EmittedFile("Root/A.cs", "// héllo\r\nline two\r\n"),
            new EmittedFile("Root/Sub/B.cs", "x\ny\n"),
        };

        var first = FreshDir();
        var second = FreshDir();
        OutputWriter.WriteOutputAtomic(first, files);
        OutputWriter.WriteOutputAtomic(second, files);

        foreach (var rel in new[] { "Root/A.cs", "Root/Sub/B.cs" })
        {
            var p = rel.Replace('/', Path.DirectorySeparatorChar);
            var a = File.ReadAllBytes(Path.Combine(first, p));
            var b = File.ReadAllBytes(Path.Combine(second, p));
            a.ShouldBe(b);
        }
    }

    [Fact]
    public void WriteOutputAtomic_prunes_roots_absent_from_the_current_run()
    {
        var dir = FreshDir();

        // Run 1: two distinct top-level roots (two bounded contexts).
        OutputWriter.WriteOutputAtomic(dir, new[]
        {
            new EmittedFile("Catalog/ValueObjects/Sku.cs", "// catalog\n"),
            new EmittedFile("Shipping/ValueObjects/Weight.cs", "// shipping\n"),
        });

        Directory.Exists(Path.Combine(dir, "Catalog")).ShouldBeTrue();
        Directory.Exists(Path.Combine(dir, "Shipping")).ShouldBeTrue();

        // Run 2: the Shipping context is removed/renamed out of the model.
        OutputWriter.WriteOutputAtomic(dir, new[]
        {
            new EmittedFile("Catalog/ValueObjects/Sku.cs", "// catalog\n"),
        });

        // The abandoned root is pruned; the surviving root is untouched.
        Directory.Exists(Path.Combine(dir, "Shipping")).ShouldBeFalse();
        File.Exists(Path.Combine(dir, "Catalog", "ValueObjects", "Sku.cs")).ShouldBeTrue();
    }

    [Fact]
    public void WriteOutputAtomic_does_not_prune_directories_it_never_recorded()
    {
        var dir = FreshDir();

        OutputWriter.WriteOutputAtomic(dir, new[]
        {
            new EmittedFile("Catalog/A.cs", "// a\n"),
        });

        // A folder the user dropped into --out by hand — Koine never recorded it.
        var userDir = Path.Combine(dir, "UserStuff");
        Directory.CreateDirectory(userDir);
        File.WriteAllText(Path.Combine(userDir, "keep.txt"), "mine");

        // Re-emit the same model.
        OutputWriter.WriteOutputAtomic(dir, new[]
        {
            new EmittedFile("Catalog/A.cs", "// a\n"),
        });

        // Pruning is scoped to roots Koine recorded, so the user's folder survives.
        Directory.Exists(userDir).ShouldBeTrue();
        File.Exists(Path.Combine(userDir, "keep.txt")).ShouldBeTrue();
    }

    [Fact]
    public void WriteFileAtomic_emits_utf8_without_bom_and_lf_only()
    {
        var path = Path.Combine(FreshDir(), "glossary.md");

        OutputWriter.WriteFileAtomic(path, "# Glossary\r\n\r\n- héllo\r\n");

        var bytes = File.ReadAllBytes(path);
        AssertUtf8NoBom(bytes);
        AssertNoCarriageReturn(bytes);
    }

    [Fact]
    public void WriteFileAtomic_is_byte_deterministic_across_runs()
    {
        const string contents = "# Glossary\r\n\r\n- héllo\r\n";
        var p1 = Path.Combine(FreshDir(), "g.md");
        var p2 = Path.Combine(FreshDir(), "g.md");

        OutputWriter.WriteFileAtomic(p1, contents);
        OutputWriter.WriteFileAtomic(p2, contents);

        File.ReadAllBytes(p1).ShouldBe(File.ReadAllBytes(p2));
    }

    private static void AssertUtf8NoBom(byte[] bytes)
    {
        var hasBom = bytes.Length >= 3 && bytes[0] == Utf8Bom[0] && bytes[1] == Utf8Bom[1] && bytes[2] == Utf8Bom[2];
        hasBom.ShouldBeFalse("output must not be prefixed with a UTF-8 BOM");
    }

    private static void AssertNoCarriageReturn(byte[] bytes)
        => bytes.ShouldNotContain((byte)0x0D, "output must use \\n line endings (no \\r)");
}
