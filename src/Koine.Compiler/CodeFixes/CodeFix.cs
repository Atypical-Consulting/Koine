namespace Koine.Compiler.CodeFixes;

/// <summary>
/// One offered code fix — a quick fix (from a diagnostic) or a refactor (from a selection). A
/// <see cref="Title"/> the editor shows, a hierarchical <see cref="Kind"/> matching the LSP
/// code-action kinds (<c>quickfix</c>, <c>refactor</c>, <c>refactor.extract</c>, …), and the ordered
/// <see cref="Edits"/> that apply it in the active document. Editor- and target-agnostic.
///
/// <para><see cref="EquivalenceKey"/> identifies fixes that are "the same" across different
/// diagnostics so they can be batched by a fix-all: two "Change to 'String'" fixes for two unknown-type
/// typos carry the SAME key and aggregate into one workspace edit. A <c>null</c> key opts a fix out of
/// fix-all batching (e.g. a one-off selection refactor).</para>
/// </summary>
public sealed record CodeFix(
    string Title,
    string Kind,
    string? EquivalenceKey,
    IReadOnlyList<CodeFixEdit> Edits);
