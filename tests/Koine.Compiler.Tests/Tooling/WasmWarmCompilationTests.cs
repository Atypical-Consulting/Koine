using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Tests for the warm/incremental reconciliation that backs the stateless wasm interop (issue #334).
/// <see cref="KoineCompilation.Reconcile"/> is the pure, content-keyed seam that the browser-only
/// <c>CompilerInterop.GetWarmCompilation</c> (not referenceable from this test assembly) is built on:
/// it retains the prior snapshot's already-parsed units across calls and re-parses only changed files.
///
/// <para>The contract these tests pin: a warm snapshot reconciled across calls is <b>byte-identical</b>
/// to a cold <see cref="KoineCompilation.Create(System.Collections.Generic.IReadOnlyList{SourceFile})"/>
/// of the same final inputs (same <see cref="KoineCompilation.Fingerprint"/>, merged model, diagnostics
/// and emitted C#), so the cache can <b>never</b> change a handler's result vs the stateless path.</para>
/// </summary>
public class WasmWarmCompilationTests
{
    private const string UriA = "file:///a.koi";
    private const string UriB = "file:///b.koi";
    private const string UriC = "file:///c.koi";

    private const string SrcA = "context Catalog { value Sku { code: String } }";
    private const string SrcB = "context Payments { value Amount { cents: Int } }";
    private const string SrcC = "context Shipping { value Weight { grams: Int } }";

    // An edit of file B that stays valid (adds a field) — a realistic one-file keystroke.
    private const string EditedB = "context Payments { value Amount { cents: Int currency: String } }";

    private static SourceFile[] Workspace(string a, string b, string c) =>
    [
        new(UriA, a), new(UriB, b), new(UriC, c),
    ];

    // ---- Task 1: the cached (warm) path equals the stateless (cold) path --------------------------

    [Fact]
    public void Warm_AfterOneFileEdit_EqualsStatelessForSameInputs()
    {
        var first = Workspace(SrcA, SrcB, SrcC);
        var final = Workspace(SrcA, EditedB, SrcC);

        // Warm path: build over the first snapshot, then reconcile to the edited one (two successive
        // calls where exactly one file's text changed between them).
        var warm1 = KoineCompilation.Reconcile(null, first);
        var warm2 = KoineCompilation.Reconcile(warm1, final);

        // Stateless path: a cold build of the same final inputs.
        var cold = KoineCompilation.Create(final);

        // Same content fingerprint, same merged model, same diagnostics, same emitted C#.
        warm2.Fingerprint.ShouldBe(cold.Fingerprint);
        ContextNames(warm2).ShouldBe(ContextNames(cold));
        WorkspaceDiagnostics(warm2).ShouldBe(WorkspaceDiagnostics(cold));
        EmittedCSharp(warm2).ShouldBe(EmittedCSharp(cold));
    }

    // ---- Task 3: reuse / perf — only the edited file re-parses --------------------------------------

    [Fact]
    public void Warm_OneFileEdit_ReparsesExactlyTheEditedFile()
    {
        var counter = 0;
        Func<SourceFile, ParsedUnit> counting = sf =>
        {
            Interlocked.Increment(ref counter);
            return KoineCompilation.ParseUnit(sf);
        };

        // Build the first snapshot with a re-parse-counting parser; Reconcile carries it forward.
        var warm1 = KoineCompilation.Create(Workspace(SrcA, SrcB, SrcC), counting);
        var afterCreate = counter; // one parse per file

        var warm2 = KoineCompilation.Reconcile(warm1, Workspace(SrcA, EditedB, SrcC));

        (counter - afterCreate).ShouldBe(1, "editing exactly one file must re-parse exactly that file");
        ReferenceEquals(warm1, warm2).ShouldBeFalse("an edit must yield a new snapshot");
        warm2.Model.Contexts.ShouldContain(c => c.Name == "Payments", "the edit must be reflected");
    }

    [Fact]
    public void Warm_NoOpEdit_ReparsesNothing_AndReturnsSameSnapshot()
    {
        var counter = 0;
        Func<SourceFile, ParsedUnit> counting = sf =>
        {
            Interlocked.Increment(ref counter);
            return KoineCompilation.ParseUnit(sf);
        };

        var warm1 = KoineCompilation.Create(Workspace(SrcA, SrcB, SrcC), counting);
        var afterCreate = counter;

        // Re-call with byte-identical inputs — WithDocument returns `this` for every file.
        var warm2 = KoineCompilation.Reconcile(warm1, Workspace(SrcA, SrcB, SrcC));

        counter.ShouldBe(afterCreate, "re-calling with identical inputs must re-parse nothing");
        ReferenceEquals(warm1, warm2).ShouldBeTrue("identical inputs must return the same snapshot");
    }

    [Fact]
    public void Warm_RemovedFile_EqualsStateless_AndDropsItsContext()
    {
        var warm1 = KoineCompilation.Reconcile(null, Workspace(SrcA, SrcB, SrcC));

        // Close file B (WithoutDocument path).
        var remaining = new[] { new SourceFile(UriA, SrcA), new SourceFile(UriC, SrcC) };
        var warm2 = KoineCompilation.Reconcile(warm1, remaining);
        var cold = KoineCompilation.Create(remaining);

        warm2.Fingerprint.ShouldBe(cold.Fingerprint);
        ContextNames(warm2).ShouldBe(ContextNames(cold));
        warm2.Model.Contexts.ShouldNotContain(c => c.Name == "Payments");
    }

    [Fact]
    public void Warm_ReorderedFiles_EqualsStateless_AndReusesUnits()
    {
        var counter = 0;
        Func<SourceFile, ParsedUnit> counting = sf =>
        {
            Interlocked.Increment(ref counter);
            return KoineCompilation.ParseUnit(sf);
        };

        var warm1 = KoineCompilation.Create(Workspace(SrcA, SrcB, SrcC), counting);
        var afterCreate = counter;

        // Reorder the open set (C, A, B): WithDocument keeps existing positions, so the reconciled
        // context order would diverge from a cold build's first-seen order — the order-guard rebuilds
        // cold to restore it, but must still reuse the already-parsed units (a pure reorder changed no
        // content). The default-parser cold reference below doesn't touch the counter.
        var reordered = new[] { new SourceFile(UriC, SrcC), new SourceFile(UriA, SrcA), new SourceFile(UriB, SrcB) };
        var warm2 = KoineCompilation.Reconcile(warm1, reordered);
        var cold = KoineCompilation.Create(reordered);

        ContextNames(warm2).ShouldBe(ContextNames(cold)); // Shipping, Catalog, Payments — matches cold
        warm2.Fingerprint.ShouldBe(cold.Fingerprint);
        EmittedCSharp(warm2).ShouldBe(EmittedCSharp(cold));
        counter.ShouldBe(afterCreate, "a pure reorder (no content change) must re-parse nothing");
    }

    // ---- helpers --------------------------------------------------------------------------------

    private static IReadOnlyList<string> ContextNames(KoineCompilation c) =>
        c.Model.Contexts.Select(x => x.Name).ToList();

    /// <summary>The full validated workspace diagnostics, flattened to a stable comparable form —
    /// the exact path the <c>DiagnoseWorkspace</c> wasm handler runs.</summary>
    private static IReadOnlyList<string> WorkspaceDiagnostics(KoineCompilation c) =>
        new KoineCompiler().DiagnoseWorkspace(c)
            .Select(d => $"{d.Severity}|{d.Code}|{d.Line}:{d.Column}|{d.Message}")
            .ToList();

    /// <summary>The emitted C# (path + contents) for the snapshot, the strongest "no change to
    /// results" assertion — both warm and cold go through the same emitter the same way.</summary>
    private static IReadOnlyList<string> EmittedCSharp(KoineCompilation c) =>
        new CSharpEmitter().Emit(c.Model, c.SemanticModel)
            .Select(f => f.RelativePath + "\n" + f.Contents)
            .ToList();
}
