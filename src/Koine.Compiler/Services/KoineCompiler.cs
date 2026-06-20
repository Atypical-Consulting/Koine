using Antlr4.Runtime;
using Antlr4.Runtime.Atn;
using Antlr4.Runtime.Misc;
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
    /// <summary>
    /// Lexes, parses, and builds the model for a single source. Returns syntax diagnostics only.
    /// Parsing is error-tolerant (R-resilience): even when the source has a syntax error, a
    /// <em>partial</em> model is built from ANTLR's recovered tree (so the valid declarations are
    /// still available) and returned alongside the syntax diagnostics, instead of a null model.
    /// </summary>
    public (KoineModel? Model, IReadOnlyList<Diagnostic> Diagnostics) Parse(string source, string? file = null)
    {
        var (contexts, relations, diagnostics) = ParseUnit(source, file);
        return (Merge(contexts, relations), diagnostics);
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
        var diagnostics = new List<Diagnostic>();
        var contexts = new List<ContextNode>();
        var relations = new List<ContextRelation>();

        foreach (var f in files)
        {
            var (parsed, parsedRelations, diags) = ParseUnit(f.Source, f.Path);
            diagnostics.AddRange(diags);
            contexts.AddRange(parsed);
            relations.AddRange(parsedRelations);
        }

        return (Merge(contexts, relations), diagnostics);
    }

    /// <summary>
    /// Parses one source unit into its raw (unmerged) contexts and context-map relations.
    /// Always returns the contexts built from the (possibly recovered) parse tree — even when
    /// <c>listener.HasErrors</c> — so a syntax error yields a partial model rather than nothing.
    /// </summary>
    private static (IReadOnlyList<ContextNode> Contexts, IReadOnlyList<ContextRelation> Relations, IReadOnlyList<Diagnostic> Diagnostics) ParseUnit(string source, string? file)
    {
        var input = new AntlrInputStream(source);
        var listener = new SyntaxErrorListener(file);

        var lexer = new KoineLexer(input);
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(listener);

        var tokens = new CommonTokenStream(lexer);
        var parser = new KoineParser(tokens);
        parser.RemoveErrorListeners();

        // Two-stage parsing (the canonical ANTLR speedup): try the cheap SLL prediction
        // mode first, suppressing diagnostics with a bail strategy. SLL parses the
        // overwhelming majority of inputs far cheaper than full adaptive LL(*); when it
        // cannot decide (a genuine syntax error, or a construct that needs full context)
        // it throws, and we re-parse once with full LL plus the real error listener — so
        // both the resulting tree and any reported diagnostics are identical to the
        // single-stage LL path the tests pin down.
        KoineParser.ProgramContext tree;
        parser.Interpreter.PredictionMode = PredictionMode.SLL;
        parser.ErrorHandler = new BailErrorStrategy();
        try
        {
            tree = parser.program();
        }
        catch (ParseCanceledException)
        {
            parser.Reset();
            parser.ErrorHandler = new DefaultErrorStrategy();
            parser.AddErrorListener(listener);
            parser.Interpreter.PredictionMode = PredictionMode.LL;
            tree = parser.program();
        }

        // Build the model from the (possibly recovered) tree regardless of syntax errors. The LL
        // re-parse path uses DefaultErrorStrategy, which recovers and always yields a tree; the
        // builder harvests skipped/missing tokens into ContextNode.Errors and keeps every valid
        // declaration it managed to parse. We return that partial model together with whatever
        // syntax diagnostics the listener collected (empty when the input was clean).
        var model = new KoineModelBuilderVisitor(tokens, file).BuildModel(tree);
        var relations = model.ContextMap?.Relations ?? Array.Empty<ContextRelation>();
        return (model.Contexts, relations, listener.Errors);
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
    /// Parses and validates without emitting, returning all diagnostics. Parsing is now
    /// error-tolerant, so even a source with a syntax error yields a partial model: the semantic
    /// validator runs over the valid parts and its diagnostics are combined with the syntax
    /// diagnostics (the syntax errors are never dropped). Used by editors (the LSP server), which
    /// can therefore answer semantic features over the valid parts of a broken file.
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
        var (model, syntax) = Parse(files);
        var semantic = new SemanticValidator().Validate(new SemanticModel(model!));
        return Combine(syntax, semantic);
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
        var (model, syntax) = Parse(files);

        // Parsing is now error-tolerant and returns a partial model even for broken input, but the
        // emit path must NOT regress: syntax diagnostics are always carried forward, and broken
        // input never emits. If there is any syntax error, bail before semantic validation/emission
        // (the partial model is intentionally never emitted) — CompileResult.Success then stays
        // false because the syntax error is a DiagnosticSeverity.Error.
        if (syntax.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new CompileResult(model, syntax, Array.Empty<EmittedFile>());
        }

        // Build the shared resolution once and reuse it for both validation and emission.
        var semanticModel = new SemanticModel(model!);
        var semantic = new SemanticValidator().Validate(semanticModel);
        var diagnostics = Combine(syntax, semantic);
        if (semantic.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new CompileResult(model, diagnostics, Array.Empty<EmittedFile>());
        }

        var emitted = emitter.Emit(model!, semanticModel);
        return new CompileResult(model, diagnostics, emitted);
    }
}
