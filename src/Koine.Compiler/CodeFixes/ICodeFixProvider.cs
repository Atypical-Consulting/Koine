namespace Koine.Compiler.CodeFixes;

/// <summary>
/// A pluggable source of <see cref="CodeFix"/>es — the public platform contract for Koine's quick fixes
/// and refactors (issue #69). A single contract serves both:
/// <list type="bullet">
///   <item><b>diagnostic-keyed quick fixes</b> — a provider declares the diagnostic code(s) it fixes via
///   <see cref="FixableDiagnosticCodes"/> and, when invoked with a <see cref="CodeFixContext.Diagnostic"/>
///   of a matching code, produces fixes from the structured diagnostic (span + <c>Suggestion</c>);</item>
///   <item><b>selection-driven refactors</b> — a provider with NO fixable codes (empty
///   <see cref="FixableDiagnosticCodes"/>) is offered against a <see cref="CodeFixContext.Selection"/> and
///   produces fixes only when the selection lands on an applicable construct.</item>
/// </list>
/// Providers are pure functions of the context — no editor or JSON concepts leak in — so any host
/// (the stdio LSP, the WASM bridge, a test) serializes the returned fixes uniformly.
/// </summary>
public interface ICodeFixProvider
{
    /// <summary>
    /// The diagnostic codes (e.g. <c>KOI0101</c>) this provider offers quick fixes for. A provider that
    /// is a pure refactor returns an empty set: it is driven by the selection, not by a diagnostic.
    /// </summary>
    IReadOnlyCollection<string> FixableDiagnosticCodes { get; }

    /// <summary>
    /// The fixes this provider offers for <paramref name="context"/>, or an empty list when none apply.
    /// A quick-fix provider should inspect <see cref="CodeFixContext.Diagnostic"/>; a refactor provider
    /// should inspect <see cref="CodeFixContext.Selection"/>.
    /// </summary>
    IReadOnlyList<CodeFix> GetFixes(CodeFixContext context);
}
