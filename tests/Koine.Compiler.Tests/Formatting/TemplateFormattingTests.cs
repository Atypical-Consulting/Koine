using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Safety net for reformatting <c>templates/</c> (issue #1842): pins that <c>koine fmt</c> stays
/// idempotent and, per shipped template (directory-mode, so cross-file imports/context maps
/// resolve — mirrors <see cref="TemplatesValidationTests"/>), model-preserving — formatting every
/// file in a template must not change the emitted C#. This must hold BEFORE the bulk reformat in
/// Task 4 lands, so that reformat is provably a pure whitespace change.
/// </summary>
public class TemplateFormattingTests
{
    private static readonly KoineFormatter Fmt = new();

    private static string TemplatesRoot()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "templates");
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) walking up from {AppContext.BaseDirectory}");
    }

    public static IEnumerable<object[]> TemplateFiles() =>
        Directory.EnumerateFiles(TemplatesRoot(), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new object[] { p });

    public static IEnumerable<object[]> TemplateFolders() =>
        Directory.EnumerateFiles(TemplatesRoot(), "template.json", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new object[] { Path.GetDirectoryName(p)! });

    [Theory]
    [MemberData(nameof(TemplateFiles))]
    public void Formatting_a_template_file_is_idempotent(string path)
    {
        var once = Fmt.Format(File.ReadAllText(path)).Text;
        var twice = Fmt.Format(once).Text;
        twice.ShouldBe(once);
    }

    [Theory]
    [MemberData(nameof(TemplateFolders))]
    public void Formatting_every_file_in_a_template_preserves_the_emitted_csharp(string folder)
    {
        var paths = Directory.EnumerateFiles(folder, "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();
        paths.ShouldNotBeEmpty();

        var before = new KoineCompiler().Compile(
            paths.Select(p => new SourceFile(p, File.ReadAllText(p))).ToList(),
            new CSharpEmitter());
        var after = new KoineCompiler().Compile(
            paths.Select(p => new SourceFile(p, Fmt.Format(File.ReadAllText(p)).Text)).ToList(),
            new CSharpEmitter());

        string name = Path.GetFileName(folder);
        before.Success.ShouldBeTrue($"template '{name}' did not compile before formatting");
        after.Success.ShouldBeTrue($"template '{name}' did not compile after formatting");

        var beforeFiles = before.Files
            .OrderBy(f => f.RelativePath, StringComparer.Ordinal)
            .ToDictionary(f => f.RelativePath, f => f.Contents);
        var afterFiles = after.Files
            .OrderBy(f => f.RelativePath, StringComparer.Ordinal)
            .ToDictionary(f => f.RelativePath, f => f.Contents);

        afterFiles.Keys.ShouldBe(beforeFiles.Keys, ignoreOrder: true);
        foreach (var relativePath in beforeFiles.Keys)
        {
            afterFiles[relativePath].ShouldBe(
                beforeFiles[relativePath],
                $"formatting template '{name}' changed the emitted output of {relativePath}");
        }
    }
}
