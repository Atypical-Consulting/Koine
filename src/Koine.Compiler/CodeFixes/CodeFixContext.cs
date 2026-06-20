using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.CodeFixes;

/// <summary>
/// Everything a <see cref="ICodeFixProvider"/> needs to produce fixes for one document. The same
/// context serves BOTH provider modes:
/// <list type="bullet">
///   <item><b>quick fixes</b> — keyed on a triggering <see cref="Diagnostic"/> (non-null) whose
///   <see cref="Diagnostic.Span"/> gives the edit span and whose <see cref="Diagnostic.Suggestion"/>
///   carries the structured replacement (never scraped from the message prose);</item>
///   <item><b>refactors</b> — driven by a <see cref="Selection"/> (non-null) over the
///   <see cref="SourceText"/>/<see cref="Model"/>, applicable only when the selection lands on an
///   eligible construct.</item>
/// </list>
/// A provider inspects whichever fields its mode needs and ignores the rest.
/// </summary>
public sealed class CodeFixContext
{
    public CodeFixContext(
        KoineCompiler compiler,
        string sourceText,
        KoineModel? model,
        Diagnostic? diagnostic,
        SelectionRange? selection)
    {
        Compiler = compiler;
        SourceText = sourceText;
        Model = model;
        Diagnostic = diagnostic;
        Selection = selection;
    }

    /// <summary>The compiler, so a provider can (re)parse the source when it needs a model.</summary>
    public KoineCompiler Compiler { get; }

    /// <summary>The full source text of the document the fix applies to.</summary>
    public string SourceText { get; }

    /// <summary>The parsed model of <see cref="SourceText"/>, when it parsed; otherwise <c>null</c>.</summary>
    public KoineModel? Model { get; }

    /// <summary>The triggering diagnostic for a quick fix, or <c>null</c> for a selection-driven refactor.</summary>
    public Diagnostic? Diagnostic { get; }

    /// <summary>The selection for a refactor, or <c>null</c> for a diagnostic-driven quick fix.</summary>
    public SelectionRange? Selection { get; }
}

/// <summary>An absolute, 0-based character selection range <c>[StartOffset, EndOffset)</c> over the source.</summary>
public sealed record SelectionRange(int StartOffset, int EndOffset);
