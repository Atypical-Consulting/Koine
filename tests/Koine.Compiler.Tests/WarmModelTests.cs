using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Tests for <see cref="KoineCompilation"/> — the warm/incremental compilation snapshot
/// introduced in issue #70 (Tasks 1 + 2).
/// </summary>
public class WarmModelTests
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// <summary>
    /// Walks up from the test assembly output directory until it finds the repo root
    /// (the directory that contains the <c>examples/</c> folder).
    /// </summary>
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
        {
            dir = dir.Parent;
        }

        dir.ShouldNotBeNull("Could not locate the repo root (no 'Koine.slnx' ancestor found).");
        return dir.FullName;
    }

    /// <summary>
    /// Loads all <c>.koi</c> files from <c>templates/pizzeria/</c> as a list of
    /// <see cref="SourceFile"/>s in the order returned by the file system.
    /// </summary>
    private static IReadOnlyList<SourceFile> LoadPizzeriaFiles()
    {
        var modelsDir = Path.Combine(RepoRoot(), "templates", "pizzeria");
        Directory.Exists(modelsDir).ShouldBeTrue($"Pizzeria template directory not found: {modelsDir}");

        return Directory.EnumerateFiles(modelsDir, "*.koi", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();
    }

    /// <summary>
    /// Loads the billing starter (<c>templates/starters/billing/billing.koi</c>) as a single-file compilation.
    /// </summary>
    private static SourceFile BillingFile()
    {
        var path = Path.Combine(RepoRoot(), "templates", "starters", "billing", "billing.koi");
        File.Exists(path).ShouldBeTrue($"Billing starter not found: {path}");
        return new SourceFile(path, File.ReadAllText(path));
    }

    // -------------------------------------------------------------------------
    // 1. Behavior parity with KoineCompiler.Parse
    // -------------------------------------------------------------------------

    [Fact]
    public void BehaviorParity_PizzeriaTemplate_ContextNamesMatchKoineCompiler()
    {
        var files = LoadPizzeriaFiles();
        var comp = KoineCompilation.Create(files);

        var (legacyModel, _) = new KoineCompiler().Parse(files);

        // Context names in first-seen order must match exactly.
        comp.Model.Contexts.Count.ShouldBe(legacyModel!.Contexts.Count);
        for (var i = 0; i < comp.Model.Contexts.Count; i++)
        {
            comp.Model.Contexts[i].Name.ShouldBe(legacyModel.Contexts[i].Name);
        }
    }

    [Fact]
    public void BehaviorParity_PizzeriaTemplate_TypeCountsMatchKoineCompiler()
    {
        var files = LoadPizzeriaFiles();
        var comp = KoineCompilation.Create(files);

        var (legacyModel, _) = new KoineCompiler().Parse(files);

        // Each context must have the same number of types.
        for (var i = 0; i < comp.Model.Contexts.Count; i++)
        {
            comp.Model.Contexts[i].Types.Count.ShouldBe(
                legacyModel!.Contexts[i].Types.Count,
                $"Type count mismatch in context '{comp.Model.Contexts[i].Name}'");
        }
    }

    [Fact]
    public void BehaviorParity_PizzeriaTemplate_SyntaxDiagnosticsMatchKoineCompiler()
    {
        var files = LoadPizzeriaFiles();
        var comp = KoineCompilation.Create(files);

        var (_, legacyDiags) = new KoineCompiler().Parse(files);

        comp.SyntaxDiagnostics.Count.ShouldBe(legacyDiags.Count);
        for (var i = 0; i < comp.SyntaxDiagnostics.Count; i++)
        {
            comp.SyntaxDiagnostics[i].Message.ShouldBe(legacyDiags[i].Message);
            comp.SyntaxDiagnostics[i].Line.ShouldBe(legacyDiags[i].Line);
            comp.SyntaxDiagnostics[i].Column.ShouldBe(legacyDiags[i].Column);
        }
    }

    [Fact]
    public void BehaviorParity_Billing_ModelMatchesKoineCompiler()
    {
        var file = BillingFile();
        var files = new[] { file };

        var comp = KoineCompilation.Create(files);
        var (legacyModel, _) = new KoineCompiler().Parse(files);

        comp.Model.Contexts.Count.ShouldBe(legacyModel!.Contexts.Count);
        for (var i = 0; i < comp.Model.Contexts.Count; i++)
        {
            comp.Model.Contexts[i].Name.ShouldBe(legacyModel.Contexts[i].Name);
            comp.Model.Contexts[i].Types.Count.ShouldBe(legacyModel.Contexts[i].Types.Count);
        }
    }

    [Fact]
    public void BehaviorParity_Billing_SyntaxDiagnosticsMatchKoineCompiler()
    {
        var file = BillingFile();
        var files = new[] { file };

        var comp = KoineCompilation.Create(files);
        var (_, legacyDiags) = new KoineCompiler().Parse(files);

        comp.SyntaxDiagnostics.Count.ShouldBe(legacyDiags.Count);
    }

    // -------------------------------------------------------------------------
    // 2. Fingerprint determinism
    // -------------------------------------------------------------------------

    [Fact]
    public void Fingerprint_SameContent_EqualFingerprints()
    {
        var files = LoadPizzeriaFiles();

        var comp1 = KoineCompilation.Create(files);
        var comp2 = KoineCompilation.Create(files);

        comp1.Fingerprint.ShouldBe(comp2.Fingerprint);
    }

    [Fact]
    public void Fingerprint_DifferentContent_DifferentFingerprints()
    {
        var files = LoadPizzeriaFiles().ToList();
        var comp1 = KoineCompilation.Create(files);

        // Change the source of the first file.
        var editedFiles = files.ToList();
        editedFiles[0] = new SourceFile(editedFiles[0].Path, editedFiles[0].Source + "\n// edited");
        var comp2 = KoineCompilation.Create(editedFiles);

        comp1.Fingerprint.ShouldNotBe(comp2.Fingerprint);
    }

    [Fact]
    public void Fingerprint_IsOrderIndependent()
    {
        var files = LoadPizzeriaFiles().ToList();

        var comp1 = KoineCompilation.Create(files);

        // Shuffle: reverse order.
        var shuffled = files.AsEnumerable().Reverse().ToList();
        var comp2 = KoineCompilation.Create(shuffled);

        comp1.Fingerprint.ShouldBe(comp2.Fingerprint);
    }

    // -------------------------------------------------------------------------
    // 3. No-op WithDocument (same hash → returns `this`)
    // -------------------------------------------------------------------------

    [Fact]
    public void WithDocument_SameText_ReturnsSameInstance()
    {
        var files = LoadPizzeriaFiles().ToList();
        var parseCount = 0;

        KoineCompilation Create(IReadOnlyList<SourceFile> f) =>
            KoineCompilation.Create(f, sf =>
            {
                Interlocked.Increment(ref parseCount);
                return KoineCompilation.ParseUnit(sf);
            });

        var comp = Create(files);
        var countAfterCreate = parseCount;

        // Call WithDocument with identical text — must be a no-op.
        var same = comp.WithDocument(files[0].Path, files[0].Source);

        ReferenceEquals(comp, same).ShouldBeTrue("WithDocument with same text must return the same instance");
        parseCount.ShouldBe(countAfterCreate, "WithDocument with same text must trigger zero re-parses");
    }

    [Fact]
    public void WithDocument_SameText_ZeroReParses()
    {
        var files = LoadPizzeriaFiles().ToList();
        var counter = 0;

        Func<SourceFile, ParsedUnit> countingParser = sf =>
        {
            Interlocked.Increment(ref counter);
            return KoineCompilation.ParseUnit(sf);
        };

        var comp = KoineCompilation.Create(files, countingParser);
        var countAfterCreate = counter;

        // No-op calls for every file in the compilation.
        foreach (var f in files)
        {
            comp.WithDocument(f.Path, f.Source);
        }

        counter.ShouldBe(countAfterCreate, "WithDocument with same text for every file must trigger zero re-parses");
    }

    // -------------------------------------------------------------------------
    // 4. Single-file reparse on edit
    // -------------------------------------------------------------------------

    [Fact]
    public void WithDocument_ChangedText_ReparseExactlyOneFile()
    {
        var files = LoadPizzeriaFiles().ToList();
        files.Count.ShouldBeGreaterThan(1, "Need more than one file for this test");

        var counter = 0;
        Func<SourceFile, ParsedUnit> countingParser = sf =>
        {
            Interlocked.Increment(ref counter);
            return KoineCompilation.ParseUnit(sf);
        };

        var comp = KoineCompilation.Create(files, countingParser);
        var countAfterCreate = counter;

        // Edit a single file.
        var targetUri = files[1].Path;
        var editedText = files[1].Source + "\n// warm-compiler edit";
        var updated = comp.WithDocument(targetUri, editedText);

        (counter - countAfterCreate).ShouldBe(1, "Editing one file must trigger exactly one re-parse");

        // The updated snapshot is a different instance.
        ReferenceEquals(comp, updated).ShouldBeFalse();
    }

    [Fact]
    public void WithDocument_ChangedText_UpdatedModelReflectsEdit()
    {
        // Use a simple in-memory compilation so we can observe the exact change.
        const string uri1 = "file:///a.koi";
        const string uri2 = "file:///b.koi";

        const string src1 = "context Catalog { value Sku { code: String } }";
        const string src2 = "context Payments { value Amount { cents: Int } }";

        var files = new[]
        {
            new SourceFile(uri1, src1),
            new SourceFile(uri2, src2),
        };

        var comp = KoineCompilation.Create(files);
        comp.Model.Contexts.ShouldContain(c => c.Name == "Catalog");
        comp.Model.Contexts.ShouldContain(c => c.Name == "Payments");

        // Edit uri2 to rename the context.
        const string editedSrc2 = "context Shipping { value TrackingId { code: String } }";
        var updated = comp.WithDocument(uri2, editedSrc2);

        updated.Model.Contexts.ShouldContain(c => c.Name == "Catalog");
        updated.Model.Contexts.ShouldContain(c => c.Name == "Shipping");
        updated.Model.Contexts.ShouldNotContain(c => c.Name == "Payments");
    }

    // -------------------------------------------------------------------------
    // 5. WithoutDocument
    // -------------------------------------------------------------------------

    [Fact]
    public void WithoutDocument_AbsentUri_ReturnsSameInstance()
    {
        var files = LoadPizzeriaFiles().ToList();
        var comp = KoineCompilation.Create(files);

        var same = comp.WithoutDocument("file:///nonexistent.koi");

        ReferenceEquals(comp, same).ShouldBeTrue("WithoutDocument with an absent uri must return the same instance");
    }

    [Fact]
    public void WithoutDocument_PresentUri_DropsContextsFromModel()
    {
        const string uri1 = "file:///catalog.koi";
        const string uri2 = "file:///payments.koi";

        var files = new[]
        {
            new SourceFile(uri1, "context Catalog { value Sku { code: String } }"),
            new SourceFile(uri2, "context Payments { value Amount { cents: Int } }"),
        };

        var comp = KoineCompilation.Create(files);
        comp.Model.Contexts.Count.ShouldBe(2);
        comp.Model.Contexts.ShouldContain(c => c.Name == "Payments");

        var without = comp.WithoutDocument(uri2);

        without.Model.Contexts.Count.ShouldBe(1);
        without.Model.Contexts.ShouldNotContain(c => c.Name == "Payments");
        without.Model.Contexts.ShouldContain(c => c.Name == "Catalog");
    }

    [Fact]
    public void WithoutDocument_PresentUri_ReturnsNewInstance()
    {
        var files = LoadPizzeriaFiles().ToList();
        var comp = KoineCompilation.Create(files);

        // Remove a file that actually declares a context (not the context-map.koi file,
        // which is a top-level `contextmap` and contributes no context to the merged model).
        var contextFile = files.First(f => f.Path.EndsWith("ordering.koi", StringComparison.Ordinal));
        var without = comp.WithoutDocument(contextFile.Path);

        ReferenceEquals(comp, without).ShouldBeFalse();
        without.Model.Contexts.Count.ShouldBeLessThan(comp.Model.Contexts.Count,
            "Removing a file must reduce the number of merged contexts");
    }

    // -------------------------------------------------------------------------
    // 6. Documents property
    // -------------------------------------------------------------------------

    [Fact]
    public void Documents_ContainsOriginalSourceTexts()
    {
        var files = LoadPizzeriaFiles().ToList();
        var comp = KoineCompilation.Create(files);

        foreach (var f in files)
        {
            comp.Documents.ContainsKey(f.Path).ShouldBeTrue($"Documents must contain key '{f.Path}'");
            comp.Documents[f.Path].ShouldBe(f.Source);
        }
    }

    [Fact]
    public void Create_DuplicateUri_LastContentWins_AndStaysConsistent()
    {
        const string uri = "file:///dup.koi";
        const string first = "context Catalog { value Sku { code: String } }";
        const string second = "context Shipping { value TrackingId { code: String } }";

        var comp = KoineCompilation.Create(new[]
        {
            new SourceFile(uri, first),
            new SourceFile(uri, second),
        });

        // The last occurrence wins for content, and Documents/Model/SemanticModelFor never diverge.
        comp.Documents[uri].ShouldBe(second);
        comp.Model.Contexts.ShouldContain(c => c.Name == "Shipping");
        comp.Model.Contexts.ShouldNotContain(c => c.Name == "Catalog");
        comp.SemanticModelFor(uri)!.Model.Contexts.ShouldContain(c => c.Name == "Shipping");

        // A WithDocument back to the same (winning) text is a no-op (proves the unit matches Documents).
        ReferenceEquals(comp, comp.WithDocument(uri, second)).ShouldBeTrue();
    }

    // -------------------------------------------------------------------------
    // 7. SemanticModel is non-null and wraps Model
    // -------------------------------------------------------------------------

    [Fact]
    public void SemanticModel_IsNonNull()
    {
        var files = LoadPizzeriaFiles();
        var comp = KoineCompilation.Create(files);

        comp.SemanticModel.ShouldNotBeNull();
        ReferenceEquals(comp.SemanticModel.Model, comp.Model).ShouldBeTrue(
            "SemanticModel.Model must be the same instance as KoineCompilation.Model");
    }

    // -------------------------------------------------------------------------
    // 8. Task-3 parity: KoineCompiler rerouted through KoineCompilation
    // -------------------------------------------------------------------------

    /// <summary>
    /// Guards the null-file trap: when <see cref="KoineCompiler.Parse(string, string?)"/> is called
    /// with <c>file: null</c> (the default), every diagnostic it returns must have a null
    /// <see cref="Diagnostic.File"/> — no fabricated path must be substituted.
    /// </summary>
    [Fact]
    public void Parse_NullFile_DiagnosticsHaveNullFile()
    {
        // A source with a deliberate syntax error so at least one diagnostic is produced.
        const string badSource = "context Broken { value X { MISSING_COLON String } }";

        var compiler = new KoineCompiler();
        var (_, diagnostics) = compiler.Parse(badSource, file: null);

        diagnostics.ShouldNotBeEmpty("Expected at least one syntax diagnostic from the broken source");
        foreach (var diag in diagnostics)
        {
            diag.File.ShouldBeNull(
                $"Diagnostic '{diag.Message}' must carry a null File when Parse is called with file: null");
        }
    }

    /// <summary>
    /// End-to-end smoke test: the rerouted <see cref="KoineCompiler.Compile(string, Emit.IEmitter)"/>
    /// must still succeed on the billing example and produce a non-empty set of emitted files.
    /// </summary>
    [Fact]
    public void Compile_BillingExample_SucceedsWithNonEmptyFiles()
    {
        var billingSource = TestSupport.BillingFixture;
        var result = new KoineCompiler().Compile(billingSource, new CSharpEmitter());

        result.Success.ShouldBeTrue(
            "Billing example must compile successfully after Task-3 rerouting: " +
            string.Join("; ", result.Diagnostics.Select(d => d.ToString())));
        result.Files.ShouldNotBeEmpty("Compile must emit at least one C# file for the billing example");
    }
}
