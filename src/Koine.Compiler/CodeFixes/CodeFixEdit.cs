using Koine.Compiler.Ast;

namespace Koine.Compiler.CodeFixes;

/// <summary>
/// A single text edit of a code fix: replace the source covered by <see cref="Range"/> (a 1-based,
/// end-EXCLUSIVE <see cref="SourceSpan"/>, whose <see cref="SourceSpan.Offset"/>/<see cref="SourceSpan.Length"/>
/// give the absolute slice) with <see cref="NewText"/>. A zero-width range is a pure insertion.
/// Editor- and target-agnostic; the LSP/WASM shells map it to an LSP <c>TextEdit</c>.
/// </summary>
public sealed record CodeFixEdit(SourceSpan Range, string NewText);
