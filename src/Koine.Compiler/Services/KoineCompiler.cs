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
        var semantic = new SemanticValidator().Validate(new SemanticModel(model!));
        return Combine(syntax, semantic);
    }

    /// <summary>
    /// Parses and validates a whole workspace as ONE model (like <see cref="Compile(IReadOnlyList{SourceFile}, IEmitter)"/>
    /// but without emitting), so cross-file errors surface. Returns every diagnostic; each
    /// carries its originating <see cref="Diagnostic.File"/> (when the model builder stamped one).
    /// Used by the LSP server to publish per-file diagnostics over the merged workspace.
    /// </summary>
    public IReadOnlyList<Diagnostic> DiagnoseWorkspace(IReadOnlyList<SourceFile> files)
    {
        var comp = KoineCompilation.Create(files);
        var semantic = new SemanticValidator().Validate(comp.SemanticModel);
        return Combine(comp.SyntaxDiagnostics, semantic);
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
        Compile(new[] { new SourceFile("<source>", source) }, emitter);

    /// <summary>Runs the full pipeline over one or more sources through the given emitter.</summary>
    public CompileResult Compile(IReadOnlyList<SourceFile> files, IEmitter emitter)
    {
        var comp = KoineCompilation.Create(files);

        // Parsing is now error-tolerant and returns a partial model even for broken input, but the
        // emit path must NOT regress: syntax diagnostics are always carried forward, and broken
        // input never emits. If there is any syntax error, bail before semantic validation/emission
        // (the partial model is intentionally never emitted) — CompileResult.Success then stays
        // false because the syntax error is a DiagnosticSeverity.Error.
        if (comp.SyntaxDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new CompileResult(comp.Model, comp.SyntaxDiagnostics, Array.Empty<EmittedFile>());
        }

        // Reuse the snapshot's single shared SemanticModel — build resolution once, reuse for
        // both validation and emission.
        var semantic = new SemanticValidator().Validate(comp.SemanticModel);
        var diagnostics = Combine(comp.SyntaxDiagnostics, semantic);
        if (semantic.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new CompileResult(comp.Model, diagnostics, Array.Empty<EmittedFile>());
        }

        var emitted = emitter.Emit(comp.Model, comp.SemanticModel);
        return new CompileResult(comp.Model, diagnostics, emitted);
    }
}
