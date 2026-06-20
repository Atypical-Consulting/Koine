using System.Text.Json;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// CI guard for the repository <c>templates/</c> directory (issue #101): the single validated
/// source of truth for Koine's example domains. Every template folder must compile green in
/// directory mode and ship a <c>template.json</c> manifest that obeys the documented shape
/// (mirrored in <c>templates/template.schema.json</c>). This is the harness every later
/// template author's work runs through, so it validates the structure rather than any one
/// template's contents.
/// </summary>
public class TemplatesValidationTests
{
    /// <summary>The valid <c>difficulty</c> values, kept in lockstep with the JSON schema enum.</summary>
    private static readonly string[] Difficulties = ["starter", "beginner", "intermediate", "advanced"];

    /// <summary>
    /// Locates the repository <c>templates/</c> directory by walking up from the test assembly's
    /// location to the repo root (the directory holding <c>Koine.slnx</c>) — never a hardcoded
    /// absolute path or a CWD assumption, so the harness runs the same from any working directory
    /// or build layout.
    /// </summary>
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

    /// <summary>
    /// Every template folder: a leaf folder under <c>templates/</c> that carries a
    /// <c>template.json</c> manifest. Returned as xUnit theory data so each template is an
    /// individually-reported test case.
    /// </summary>
    public static IEnumerable<object[]> TemplateFolders()
    {
        string root = TemplatesRoot();
        if (!Directory.Exists(root))
        {
            yield break;
        }

        foreach (string manifest in Directory
            .EnumerateFiles(root, "template.json", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal))
        {
            yield return [Path.GetDirectoryName(manifest)!];
        }
    }

    [Fact]
    public void Templates_directory_exists_and_contains_at_least_one_template()
    {
        string root = TemplatesRoot();
        Directory.Exists(root).ShouldBeTrue($"the repository templates/ directory is missing: {root}");
        TemplateFolders().ShouldNotBeEmpty("templates/ must contain at least one folder with a template.json");
    }

    [Theory]
    [MemberData(nameof(TemplateFolders))]
    public void Template_compiles_green_in_directory_mode(string folder)
    {
        var sources = Directory
            .EnumerateFiles(folder, "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

        sources.ShouldNotBeEmpty($"template '{Path.GetFileName(folder)}' has no .koi files to compile");

        var result = new KoineCompiler().Compile(sources, new CSharpEmitter());
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();

        errors.ShouldBeEmpty(
            $"template '{Path.GetFileName(folder)}' did not compile cleanly:\n" +
            string.Join("\n", errors.Select(d => $"{d.File}:{d.Line}:{d.Column}: {d.Code}: {d.Message}")));
        result.Files.ShouldNotBeEmpty($"template '{Path.GetFileName(folder)}' emitted no C# files");
    }

    [Theory]
    [MemberData(nameof(TemplateFolders))]
    public void Template_manifest_is_valid(string folder)
    {
        string manifestPath = Path.Combine(folder, "template.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var root = doc.RootElement;
        string folderName = Path.GetFileName(folder);

        // --- required string fields -------------------------------------------------
        string id = RequiredString(root, "id", folderName);
        RequiredString(root, "name", folderName);
        RequiredString(root, "tagline", folderName);
        RequiredString(root, "description", folderName);
        RequiredString(root, "coreAggregate", folderName);
        RequiredString(root, "icon", folderName);
        string difficulty = RequiredString(root, "difficulty", folderName);
        string entryFile = RequiredString(root, "entryFile", folderName);

        // --- id must equal the folder name (so discovery and identity never drift) --
        id.ShouldBe(folderName, $"template id must equal its folder name in '{folderName}'");

        // --- difficulty must be one of the documented values ------------------------
        Difficulties.ShouldContain(difficulty, $"template '{folderName}' has an unknown difficulty '{difficulty}'");

        // --- entryFile must name a file present in the folder -----------------------
        File.Exists(Path.Combine(folder, entryFile))
            .ShouldBeTrue($"template '{folderName}' entryFile '{entryFile}' does not exist in the folder");

        // --- non-empty string arrays ------------------------------------------------
        NonEmptyStringArray(root, "tags", folderName);
        NonEmptyStringArray(root, "contexts", folderName);
        NonEmptyStringArray(root, "teaches", folderName);

        // --- no unknown properties (mirrors the schema's additionalProperties: false) -
        string[] knownFields =
        [
            "id", "name", "tagline", "description", "difficulty",
            "tags", "contexts", "coreAggregate", "entryFile", "teaches", "icon",
        ];
        foreach (var property in root.EnumerateObject())
        {
            knownFields.ShouldContain(
                property.Name,
                $"template '{folderName}' manifest has an unknown property '{property.Name}' (the schema forbids additionalProperties)");
        }
    }

    private static string RequiredString(JsonElement obj, string property, string folderName)
    {
        obj.TryGetProperty(property, out var value)
            .ShouldBeTrue($"template '{folderName}' is missing required field '{property}'");
        value.ValueKind.ShouldBe(JsonValueKind.String, $"template '{folderName}' field '{property}' must be a string");
        string text = value.GetString()!;
        text.ShouldNotBeNullOrWhiteSpace($"template '{folderName}' field '{property}' must not be empty");
        return text;
    }

    private static void NonEmptyStringArray(JsonElement obj, string property, string folderName)
    {
        obj.TryGetProperty(property, out var value)
            .ShouldBeTrue($"template '{folderName}' is missing required array '{property}'");
        value.ValueKind.ShouldBe(JsonValueKind.Array, $"template '{folderName}' field '{property}' must be an array");

        var items = value.EnumerateArray().ToList();
        items.ShouldNotBeEmpty($"template '{folderName}' array '{property}' must not be empty");
        foreach (var item in items)
        {
            item.ValueKind.ShouldBe(JsonValueKind.String, $"template '{folderName}' array '{property}' must contain only strings");
            item.GetString().ShouldNotBeNullOrWhiteSpace($"template '{folderName}' array '{property}' must not contain empty strings");
        }
    }
}
