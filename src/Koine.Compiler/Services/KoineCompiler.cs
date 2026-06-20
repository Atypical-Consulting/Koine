using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Semantics;

namespace Koine.Compiler.Services;

/// <summary>One source unit of a compilation: its (display) path and its text.</summary>
public readonly record struct SourceFile(string Path, string Source);

/// <summary>The outcome of a compilation: the model, all diagnostics, emitted files.</summary>
public sealed record CompileResult(
    KoineModel? Model,
    IReadOnlyList<Diagnostic> Diagnostics,
    IReadOnlyList<EmittedFile> Files)
{
    public bool Success => !Diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error);
}

/// <summary>
/// Orchestrates the strictly-layered pipeline:
/// source(s) → lexer/parser → model builder → merge → semantic validation → emitter.
/// Multiple <c>.koi</c> files compile into ONE model: contexts of the same name are
/// open/additive and their declarations are merged (R13.1).
/// All parse and merge logic is delegated to <see cref="KoineCompilation"/> so both
/// the warm (incremental) and cold paths share a single implementation.
/// </summary>
public sealed class KoineCompiler
{
    /// <summary>
    /// External semantic analyzers (issue #69) appended after the built-ins on every validation pass.
    /// Empty by default, so behavior is identical to today; the CLI loads these from the
    /// <c>analyzers</c> config key via <see cref="Semantics.AnalyzerLoader"/>.
    /// </summary>
    private readonly IReadOnlyList<IModelAnalyzer>? _externalAnalyzers;

    /// <summary>Creates a compiler that runs only the built-in analyzers (today's behavior).</summary>
    public KoineCompiler()
        : this(externalAnalyzers: null)
    {
    }

    /// <summary>
    /// Creates a compiler that, during semantic validation, runs the supplied external analyzers
    /// (issue #69) after the built-in ones. A null/empty list is identical to the default constructor.
    /// </summary>
    public KoineCompiler(IReadOnlyList<IModelAnalyzer>? externalAnalyzers)
    {
        _externalAnalyzers = externalAnalyzers;
    }

    /// <summary>A validator wired with this compiler's external analyzers (built-ins always run first).</summary>
    private SemanticValidator CreateValidator() => new(_externalAnalyzers);

    /// <summary>
    /// Lexes, parses, and builds the model for a single source. Returns syntax diagnostics only.
    /// Parsing is error-tolerant (R-resilience): even when the source has a syntax error, a
    /// <em>partial</em> model is built from ANTLR's recovered tree (so the valid declarations are
    /// still available) and returned alongside the syntax diagnostics, instead of a null model.
    /// When <paramref name="file"/> is <c>null</c> the diagnostics carry a null
    /// <see cref="Diagnostic.File"/> stamp — that null is preserved; no fabricated path is substituted.
    /// </summary>
    public (KoineModel? Model, IReadOnlyList<Diagnostic> Diagnostics) Parse(string source, string? file = null)
    {
        var unit = KoineCompilation.ParseUnit(source, file);
        return (KoineCompilation.Merge(unit.Contexts, unit.Relations), unit.Diagnostics);
    }

    /// <summary>
    /// Parses and merges many sources into a single model (R13.1). Every file is parsed;
    /// all syntax diagnostics (each naming its own file) are collected. Parsing is
    /// error-tolerant: good files contribute full contexts, broken files contribute the
    /// partial contexts recovered from their tree (plus their syntax diagnostics). The merged
    /// model is always returned (never blanked by one broken file), so a workspace with a typo
    /// in one file still surfaces the other files' declarations.
    /// </summary>
    public (KoineModel? Model, IReadOnlyList<Diagnostic> Diagnostics) Parse(IReadOnlyList<SourceFile> files)
    {
        var comp = KoineCompilation.Create(files);
        return (comp.Model, comp.SyntaxDiagnostics);
    }

    /// <summary>
    /// Parses and validates without emitting, returning all diagnostics. Parsing is
    /// error-tolerant, so even a source with a syntax error yields a partial model: the semantic
    /// validator runs over the valid parts and its diagnostics are combined with the syntax
    /// diagnostics (the syntax errors are never dropped). Used by editors (the LSP server), which
    /// can therefore answer semantic features over the valid parts of a broken file.
    /// When <paramref name="file"/> is <c>null</c> the diagnostics carry a null
    /// <see cref="Diagnostic.File"/> stamp — that null is preserved; no fabricated path is substituted.
    /// </summary>
    public IReadOnlyList<Diagnostic> Diagnose(string source, string? file = null)
    {
        var (model, syntax) = Parse(source, file);
        var semantic = CreateValidator().Validate(new SemanticModel(model!));
        return Combine(syntax, semantic);
    }

    /// <summary>
    /// Parses and validates a whole workspace as ONE model (like <see cref="Compile(IReadOnlyList{SourceFile}, IEmitter)"/>
    /// but without emitting), so cross-file errors surface. Returns every diagnostic; each
    /// carries its originating <see cref="Diagnostic.File"/> (when the model builder stamped one).
    /// Used by the LSP server to publish per-file diagnostics over the merged workspace.
    /// </summary>
    public IReadOnlyList<Diagnostic> DiagnoseWorkspace(IReadOnlyList<SourceFile> files)
        => DiagnoseWorkspace(KoineCompilation.Create(files));

    /// <summary>Validates an already-built workspace snapshot (no re-parse) and returns all diagnostics.</summary>
    public IReadOnlyList<Diagnostic> DiagnoseWorkspace(KoineCompilation compilation)
    {
        var semantic = CreateValidator().Validate(compilation.SemanticModel);
        return Combine(compilation.SyntaxDiagnostics, semantic);
    }

    /// <summary>Concatenates syntax then semantic diagnostics (syntax errors are never dropped).</summary>
    private static IReadOnlyList<Diagnostic> Combine(IReadOnlyList<Diagnostic> syntax, IReadOnlyList<Diagnostic> semantic)
    {
        if (syntax.Count == 0)
        {
            return semantic;
        }

        if (semantic.Count == 0)
        {
            return syntax;
        }

        var combined = new List<Diagnostic>(syntax.Count + semantic.Count);
        combined.AddRange(syntax);
        combined.AddRange(semantic);
        return combined;
    }

    /// <summary>Runs the full pipeline for a single source through the given emitter.</summary>
    public CompileResult Compile(string source, IEmitter emitter) =>
        Compile(source, emitter, DiagnosticFilterOptions.None);

    /// <summary>
    /// Runs the full pipeline for a single source, applying the diagnostic remap/suppression
    /// <paramref name="filterOptions"/> (config severity overrides + warnings-as-errors) plus any
    /// in-source <c># koine:disable</c> directives before <c>CompileResult.Success</c> is computed.
    /// </summary>
    public CompileResult Compile(string source, IEmitter emitter, DiagnosticFilterOptions filterOptions) =>
        Compile(new[] { new SourceFile("<source>", source) }, emitter, filterOptions);

    /// <summary>Runs the full pipeline over one or more sources through the given emitter.</summary>
    public CompileResult Compile(IReadOnlyList<SourceFile> files, IEmitter emitter) =>
        Compile(files, emitter, DiagnosticFilterOptions.None);

    /// <summary>
    /// Runs the full pipeline over one or more sources, applying the diagnostic remap/suppression
    /// <paramref name="filterOptions"/> (config severity overrides + warnings-as-errors) plus any
    /// in-source <c># koine:disable</c> directives so the returned <see cref="CompileResult.Diagnostics"/>
    /// are the effective (remapped) set and <see cref="CompileResult.Success"/> is computed from them.
    /// With <see cref="DiagnosticFilterOptions.None"/> (the default) behaviour is unchanged.
    /// </summary>
    public CompileResult Compile(IReadOnlyList<SourceFile> files, IEmitter emitter, DiagnosticFilterOptions filterOptions)
    {
        var comp = KoineCompilation.Create(files);

        // Parsing is now error-tolerant and returns a partial model even for broken input, but the
        // emit path must NOT regress: syntax diagnostics are always carried forward, and broken
        // input never emits. If there is any syntax error, bail before semantic validation/emission
        // (the partial model is intentionally never emitted) — CompileResult.Success then stays
        // false because the syntax error is a DiagnosticSeverity.Error.
        if (comp.SyntaxDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new CompileResult(comp.Model, Filter(comp.SyntaxDiagnostics, filterOptions, files), Array.Empty<EmittedFile>());
        }

        // Reuse the snapshot's single shared SemanticModel — build resolution once, reuse for
        // both validation and emission.
        var semantic = CreateValidator().Validate(comp.SemanticModel);
        var diagnostics = Filter(Combine(comp.SyntaxDiagnostics, semantic), filterOptions, files);

        // Success is computed from the *filtered* diagnostics (a config-promoted/warnings-as-errors
        // Error now blocks emit; a suppressed/dropped warning no longer does).
        if (diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new CompileResult(comp.Model, diagnostics, Array.Empty<EmittedFile>());
        }

        var emitted = emitter.Emit(comp.Model, comp.SemanticModel);
        return new CompileResult(comp.Model, diagnostics, emitted);
    }

    /// <summary>
    /// Applies the diagnostic filter (no-op for <see cref="DiagnosticFilterOptions.None"/> with no
    /// <c># koine:disable</c> directives), passing the source texts so the filter can scan them.
    /// </summary>
    private static IReadOnlyList<Diagnostic> Filter(
        IReadOnlyList<Diagnostic> diagnostics, DiagnosticFilterOptions filterOptions, IReadOnlyList<SourceFile> files)
    {
        var sources = new (string?, string)[files.Count];
        for (var i = 0; i < files.Count; i++)
        {
            sources[i] = (files[i].Path, files[i].Source);
        }

        return DiagnosticFilter.Apply(diagnostics, filterOptions, sources);
    }
}
