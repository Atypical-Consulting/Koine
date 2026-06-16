using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Grammar;
using Koine.Compiler.Parsing;
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
/// </summary>
public sealed class KoineCompiler
{
    /// <summary>Lexes, parses, and builds the model for a single source. Returns syntax diagnostics only.</summary>
    public (KoineModel? Model, IReadOnlyList<Diagnostic> Diagnostics) Parse(string source, string? file = null)
    {
        var (contexts, relations, diagnostics) = ParseUnit(source, file);
        if (contexts is null)
            return (null, diagnostics);
        return (Merge(contexts, relations), diagnostics);
    }

    /// <summary>
    /// Parses and merges many sources into a single model (R13.1). Every file is parsed;
    /// all syntax diagnostics (each naming its own file) are collected. If any file has a
    /// syntax error, no model is produced.
    /// </summary>
    public (KoineModel? Model, IReadOnlyList<Diagnostic> Diagnostics) Parse(IReadOnlyList<SourceFile> files)
    {
        var diagnostics = new List<Diagnostic>();
        var contexts = new List<ContextNode>();
        var relations = new List<ContextRelation>();
        var anyFailed = false;

        foreach (var f in files)
        {
            var (parsed, parsedRelations, diags) = ParseUnit(f.Source, f.Path);
            diagnostics.AddRange(diags);
            if (parsed is null)
                anyFailed = true;
            else
            {
                contexts.AddRange(parsed);
                relations.AddRange(parsedRelations);
            }
        }

        return anyFailed ? (null, diagnostics) : (Merge(contexts, relations), diagnostics);
    }

    /// <summary>Parses one source unit into its raw (unmerged) contexts and context-map relations, or null on a syntax error.</summary>
    private static (IReadOnlyList<ContextNode>? Contexts, IReadOnlyList<ContextRelation> Relations, IReadOnlyList<Diagnostic> Diagnostics) ParseUnit(string source, string? file)
    {
        var input = new AntlrInputStream(source);
        var listener = new SyntaxErrorListener(file);

        var lexer = new KoineLexer(input);
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(listener);

        var tokens = new CommonTokenStream(lexer);
        var parser = new KoineParser(tokens);
        parser.RemoveErrorListeners();
        parser.AddErrorListener(listener);

        var tree = parser.program();
        if (listener.HasErrors)
            return (null, Array.Empty<ContextRelation>(), listener.Errors);

        var model = new KoineModelBuilderVisitor(tokens, file).BuildModel(tree);
        var relations = model.ContextMap?.Relations ?? Array.Empty<ContextRelation>();
        return (model.Contexts, relations, Array.Empty<Diagnostic>());
    }

    /// <summary>
    /// Merges same-named contexts into one (open/additive contexts, R13.1), preserving
    /// first-seen order. Declarations, imports, specs, services, policies, and integration-event
    /// publish/subscribe wiring concatenate; context-map relations from every file combine into one
    /// model-level map (R14).
    /// </summary>
    private static KoineModel Merge(IReadOnlyList<ContextNode> contexts, IReadOnlyList<ContextRelation> relations)
    {
        var order = new List<string>();
        var byName = new Dictionary<string, ContextNode>(StringComparer.Ordinal);

        foreach (var ctx in contexts)
        {
            if (byName.TryGetValue(ctx.Name, out var existing))
            {
                byName[ctx.Name] = existing with
                {
                    Imports = existing.Imports.Concat(ctx.Imports).ToList(),
                    Types = existing.Types.Concat(ctx.Types).ToList(),
                    Specs = existing.Specs.Concat(ctx.Specs).ToList(),
                    Services = existing.Services.Concat(ctx.Services).ToList(),
                    Policies = existing.Policies.Concat(ctx.Policies).ToList(),
                    ModuleNames = existing.ModuleNames.Concat(ctx.ModuleNames).ToList(),
                    Publishes = existing.Publishes.Concat(ctx.Publishes).ToList(),
                    Subscribes = existing.Subscribes.Concat(ctx.Subscribes).ToList(),
                    Doc = existing.Doc ?? ctx.Doc,
                    Version = existing.Version ?? ctx.Version
                };
            }
            else
            {
                order.Add(ctx.Name);
                byName[ctx.Name] = ctx;
            }
        }

        var map = relations.Count == 0 ? null : new ContextMapNode(relations.ToList());
        return new KoineModel(order.Select(n => byName[n]).ToList(), map);
    }

    /// <summary>
    /// Parses and validates without emitting, returning all diagnostics (syntax errors if
    /// parsing fails, otherwise semantic diagnostics). Used by editors (the LSP server).
    /// </summary>
    public IReadOnlyList<Diagnostic> Diagnose(string source, string? file = null)
    {
        var (model, syntax) = Parse(source, file);
        if (model is null)
            return syntax;
        return new SemanticValidator().Validate(model);
    }

    /// <summary>
    /// Parses and validates a whole workspace as ONE model (like <see cref="Compile(IReadOnlyList{SourceFile}, IEmitter)"/>
    /// but without emitting), so cross-file errors surface. Returns every diagnostic; each
    /// carries its originating <see cref="Diagnostic.File"/> (when the model builder stamped one).
    /// Used by the LSP server to publish per-file diagnostics over the merged workspace.
    /// </summary>
    public IReadOnlyList<Diagnostic> DiagnoseWorkspace(IReadOnlyList<SourceFile> files)
    {
        var (model, syntax) = Parse(files);
        if (model is null)
            return syntax;
        return new SemanticValidator().Validate(model);
    }

    /// <summary>Runs the full pipeline for a single source through the given emitter.</summary>
    public CompileResult Compile(string source, IEmitter emitter) =>
        Compile(new[] { new SourceFile("<source>", source) }, emitter);

    /// <summary>Runs the full pipeline over one or more sources through the given emitter.</summary>
    public CompileResult Compile(IReadOnlyList<SourceFile> files, IEmitter emitter)
    {
        var (model, syntax) = Parse(files);
        if (model is null)
            return new CompileResult(null, syntax, Array.Empty<EmittedFile>());

        var semantic = new SemanticValidator().Validate(model);
        if (semantic.Any(d => d.Severity == DiagnosticSeverity.Error))
            return new CompileResult(model, semantic, Array.Empty<EmittedFile>());

        var emitted = emitter.Emit(model);
        return new CompileResult(model, semantic, emitted);
    }
}
