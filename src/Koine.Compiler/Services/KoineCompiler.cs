using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Grammar;
using Koine.Compiler.Parsing;
using Koine.Compiler.Semantics;

namespace Koine.Compiler.Services;

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
/// source → lexer/parser → model builder → semantic validation → emitter.
/// </summary>
public sealed class KoineCompiler
{
    /// <summary>Lexes, parses, and builds the model. Returns syntax diagnostics only.</summary>
    public (KoineModel? Model, IReadOnlyList<Diagnostic> Diagnostics) Parse(string source)
    {
        var input = new AntlrInputStream(source);
        var listener = new SyntaxErrorListener();

        var lexer = new KoineLexer(input);
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(listener);

        var tokens = new CommonTokenStream(lexer);
        var parser = new KoineParser(tokens);
        parser.RemoveErrorListeners();
        parser.AddErrorListener(listener);

        var tree = parser.program();
        if (listener.HasErrors)
            return (null, listener.Errors);

        var model = new KoineModelBuilderVisitor(tokens).BuildModel(tree);
        return (model, Array.Empty<Diagnostic>());
    }

    /// <summary>
    /// Parses and validates without emitting, returning all diagnostics (syntax
    /// errors if parsing fails, otherwise semantic diagnostics). Used by editors
    /// (the LSP server) and by validate-only builds.
    /// </summary>
    public IReadOnlyList<Diagnostic> Diagnose(string source)
    {
        var (model, syntax) = Parse(source);
        if (model is null)
            return syntax;
        return new SemanticValidator().Validate(model);
    }

    /// <summary>Runs the full pipeline through the given emitter.</summary>
    public CompileResult Compile(string source, IEmitter emitter)
    {
        var (model, syntax) = Parse(source);
        if (model is null)
            return new CompileResult(null, syntax, Array.Empty<EmittedFile>());

        var semantic = new SemanticValidator().Validate(model);
        if (semantic.Any(d => d.Severity == DiagnosticSeverity.Error))
            return new CompileResult(model, semantic, Array.Empty<EmittedFile>());

        var files = emitter.Emit(model);
        return new CompileResult(model, semantic, files);
    }
}
