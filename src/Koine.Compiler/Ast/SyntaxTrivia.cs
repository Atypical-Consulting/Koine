namespace Koine.Compiler.Ast;

/// <summary>
/// The kind of a <see cref="SyntaxTrivia"/> piece: the non-code text (whitespace, blank
/// lines, comments) that lives between tokens. Target-agnostic — trivia carries raw
/// source text, never a language-specific concept.
/// </summary>
public enum SyntaxTriviaKind
{
    /// <summary>Inline whitespace (spaces/tabs) and a single trailing newline.</summary>
    Whitespace,

    /// <summary>A run of one or more blank lines (whitespace containing two or more newlines).</summary>
    BlankLine,

    /// <summary>An ordinary <c>// …</c> line comment (rides the HIDDEN channel).</summary>
    LineComment,

    /// <summary>A <c>/* … */</c> block comment (rides the HIDDEN channel).</summary>
    BlockComment,

    /// <summary>A <c>/// …</c> doc comment (rides the DOC channel). Projected by <see cref="KoineNode.Doc"/>.</summary>
    Doc
}

/// <summary>
/// One piece of lossless trivia (whitespace, blank-line run, or comment) attached to a node
/// as <see cref="KoineNode.LeadingTrivia"/> or <see cref="KoineNode.TrailingTrivia"/>. The raw
/// <see cref="Text"/> is verbatim so an AST → source printer can reproduce the original layout
/// byte-for-byte (#5). Target-agnostic: no markup, no language-specific meaning.
/// </summary>
/// <param name="Kind">Classifies the trivia (whitespace, blank line, or a comment flavour).</param>
/// <param name="Text">The verbatim source text of the trivia (un-normalized).</param>
/// <param name="Span">The source range the trivia occupies.</param>
public readonly record struct SyntaxTrivia(SyntaxTriviaKind Kind, string Text, SourceSpan Span);
