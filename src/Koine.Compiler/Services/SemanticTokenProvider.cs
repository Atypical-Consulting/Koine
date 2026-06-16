using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>
/// The semantic token types this provider emits, in legend order. The numeric value
/// of each enum member is its index in the LSP legend (so the LSP shell advertises
/// <c>TokenTypes.Names</c> as <c>legend.tokenTypes</c> and emits the enum's int value).
/// </summary>
public enum SemanticTokenType
{
    Type,
    Enum,
    EnumMember,
    Property,
    Keyword,
    Parameter,
}

/// <summary>
/// The semantic token modifiers this provider emits, as bit positions. A token's
/// modifier bitset is the OR of <c>(1 &lt;&lt; (int)modifier)</c> for each applied modifier.
/// </summary>
public enum SemanticTokenModifier
{
    Declaration,
}

/// <summary>
/// A single classified token at a 0-based <see cref="Line"/>/<see cref="StartChar"/> with a
/// <see cref="Length"/> (LSP positions), its <see cref="Type"/> and a <see cref="Modifiers"/>
/// bitset. Editor-agnostic — the LSP shell encodes a sorted list of these into the relative
/// (deltaLine/deltaStart/length/tokenType/tokenModifiers) integer stream the protocol requires.
/// </summary>
public readonly record struct SemanticToken(
    int Line,
    int StartChar,
    int Length,
    SemanticTokenType Type,
    int Modifiers);

/// <summary>
/// Computes full-document semantic tokens for a <c>.koi</c> source by lexing it for
/// identifier tokens and classifying each one against the parsed <see cref="ModelIndex"/>
/// (type / enum / enumMember / property), marking the token at a declaration span with the
/// <see cref="SemanticTokenModifier.Declaration"/> modifier. Declaration keywords
/// (<c>context</c>, <c>value</c>, …) are classified as <see cref="SemanticTokenType.Keyword"/>.
///
/// <para>Degrades gracefully: a document that does not parse yields an empty token list, so
/// the editor simply falls back to the regex grammar rather than showing wrong highlights.</para>
/// </summary>
public sealed class SemanticTokenProvider
{
    private readonly KoineCompiler _compiler;

    public SemanticTokenProvider() : this(new KoineCompiler()) { }
    public SemanticTokenProvider(KoineCompiler compiler) => _compiler = compiler;

    /// <summary>The legend token-type names, in <see cref="SemanticTokenType"/> order.</summary>
    public static readonly IReadOnlyList<string> TokenTypeNames =
        new[] { "type", "enum", "enumMember", "property", "keyword", "parameter" };

    /// <summary>The legend modifier names, in <see cref="SemanticTokenModifier"/> order.</summary>
    public static readonly IReadOnlyList<string> TokenModifierNames =
        new[] { "declaration" };

    /// <summary>
    /// Classifies every default-channel identifier token in <paramref name="source"/> and
    /// returns the resulting <see cref="SemanticToken"/>s sorted by position. Returns an empty
    /// list when the document does not parse (graceful degradation).
    /// </summary>
    public IReadOnlyList<SemanticToken> Tokenize(string source)
    {
        var (model, _) = _compiler.Parse(source);
        if (model is null)
            return Array.Empty<SemanticToken>();

        var index = new ModelIndex(model);
        var lines = SplitLines(source);

        // Declaration spans, by (1-based line, 0-based column), so a token at a declaration
        // site gets the right type AND the declaration modifier (e.g. the NAME in
        // `value Money { … }` or a member name in its body).
        var declarations = CollectDeclarations(index, lines);

        // Member/property names declared anywhere (so a `field.` selector or an invariant
        // operand highlights as a property even though it is not a declared TYPE name).
        var propertyNames = CollectPropertyNames(index);

        var tokens = new List<SemanticToken>();
        foreach (var tok in IdentifierTokens(source))
        {
            var text = tok.Text;
            if (string.IsNullOrEmpty(text))
                continue;

            var line = tok.Line;       // 1-based
            var col = tok.Column;      // 0-based
            var classified = Classify(text, line, col, index, declarations, propertyNames);
            if (classified is not { } c)
                continue;

            tokens.Add(new SemanticToken(line - 1, col, text.Length, c.Type, c.Modifiers));
        }

        // LSP requires tokens sorted by (line, startChar) ascending. Lexer order is already
        // source order, but sort defensively so the encoding contract holds regardless.
        tokens.Sort(static (a, b) =>
            a.Line != b.Line ? a.Line.CompareTo(b.Line) : a.StartChar.CompareTo(b.StartChar));
        return tokens;
    }

    /// <summary>
    /// Encodes a sorted token list into the LSP relative integer stream: five ints per token —
    /// deltaLine, deltaStartChar, length, tokenType, tokenModifiers — where deltas are relative
    /// to the previous token (deltaStartChar is relative to the previous token's start when on
    /// the same line, else absolute).
    /// </summary>
    public static IReadOnlyList<int> Encode(IReadOnlyList<SemanticToken> tokens)
    {
        var data = new List<int>(tokens.Count * 5);
        var prevLine = 0;
        var prevChar = 0;
        foreach (var t in tokens)
        {
            var deltaLine = t.Line - prevLine;
            var deltaChar = deltaLine == 0 ? t.StartChar - prevChar : t.StartChar;
            data.Add(deltaLine);
            data.Add(deltaChar);
            data.Add(t.Length);
            data.Add((int)t.Type);
            data.Add(t.Modifiers);
            prevLine = t.Line;
            prevChar = t.StartChar;
        }
        return data;
    }

    private readonly record struct Classification(SemanticTokenType Type, int Modifiers);

    private static Classification? Classify(
        string text,
        int line,
        int col,
        ModelIndex index,
        IReadOnlyDictionary<(int, int), DeclKind> declarations,
        IReadOnlySet<string> propertyNames)
    {
        var isDeclaration = declarations.TryGetValue((line, col), out var declKind);
        var declModifier = isDeclaration ? 1 << (int)SemanticTokenModifier.Declaration : 0;

        // A declaration site is authoritative about what it declares (a member name that
        // collides with a type name elsewhere still highlights as a property at its own
        // declaration, etc.).
        if (isDeclaration)
            return declKind switch
            {
                DeclKind.Enum => new Classification(SemanticTokenType.Enum, declModifier),
                DeclKind.EnumMember => new Classification(SemanticTokenType.EnumMember, declModifier),
                DeclKind.Property => new Classification(SemanticTokenType.Property, declModifier),
                DeclKind.Parameter => new Classification(SemanticTokenType.Parameter, declModifier),
                _ => new Classification(SemanticTokenType.Type, declModifier),
            };

        // Reference sites: classify by the model.
        if (index.IsEnumType(text))
            return new Classification(SemanticTokenType.Enum, 0);

        if (index.IsKnownType(text) || ModelIndex.Primitives.Contains(text)
            || text is ModelIndex.ListTypeName or ModelIndex.SetTypeName
                or ModelIndex.MapTypeName or ModelIndex.RangeTypeName)
            return new Classification(SemanticTokenType.Type, 0);

        if (index.EnumMemberToType.ContainsKey(text))
            return new Classification(SemanticTokenType.EnumMember, 0);

        if (propertyNames.Contains(text))
            return new Classification(SemanticTokenType.Property, 0);

        return null; // not something we highlight semantically (let the grammar handle it)
    }

    private enum DeclKind { Type, Enum, EnumMember, Property, Parameter }

    /// <summary>
    /// Maps every declaration's name position (1-based line, 0-based column) to what it
    /// declares, so a token at that exact position is classified as a declaration. Spans
    /// with no known position (<see cref="SourceSpan.None"/>) are skipped.
    ///
    /// <para>A member/parameter/enum-member span already points at its NAME, but a type/enum
    /// declaration's span points at the introducing KEYWORD (<c>value</c>, <c>enum</c>, …) —
    /// so for those we locate the declared name on the span's line at/after the keyword,
    /// matching how go-to-definition selects the name rather than the keyword.</para>
    /// </summary>
    private static IReadOnlyDictionary<(int, int), DeclKind> CollectDeclarations(ModelIndex index, string[] lines)
    {
        var map = new Dictionary<(int, int), DeclKind>();

        void Add(SourceSpan span, DeclKind kind)
        {
            if (span != SourceSpan.None)
                map[(span.Line, span.Column - 1)] = kind; // SourceSpan.Column is 1-based
        }

        // Adds a TYPE/ENUM declaration at its NAME: the span points at the keyword, so find
        // the declared name on that line at/after the keyword column.
        void AddNamed(SourceSpan span, string name, DeclKind kind)
        {
            if (span == SourceSpan.None)
                return;
            var line = span.Line - 1;      // 0-based
            var keywordCol = span.Column - 1;
            if (line < 0 || line >= lines.Length)
                return;
            var idx = lines[line].IndexOf(name, Math.Max(0, keywordCol), StringComparison.Ordinal);
            if (idx >= 0)
                map[(span.Line, idx)] = kind;
        }

        foreach (var t in index.AllTypes())
        {
            AddNamed(t.Span, t.Name, t is EnumDecl ? DeclKind.Enum : DeclKind.Type);
            switch (t)
            {
                case ValueObjectDecl v:
                    foreach (var m in v.Members) Add(m.Span, DeclKind.Property);
                    break;
                case EntityDecl e:
                    foreach (var m in e.Members) Add(m.Span, DeclKind.Property);
                    foreach (var c in e.Commands)
                        foreach (var p in c.Parameters) Add(p.Span, DeclKind.Parameter);
                    foreach (var f in e.Factories)
                        foreach (var p in f.Parameters) Add(p.Span, DeclKind.Parameter);
                    break;
                case EventDecl ev:
                    foreach (var m in ev.Members) Add(m.Span, DeclKind.Property);
                    break;
                case IntegrationEventDecl ie:
                    foreach (var m in ie.Members) Add(m.Span, DeclKind.Property);
                    break;
                case EnumDecl en:
                    foreach (var m in en.Members) Add(m.Span, DeclKind.EnumMember);
                    break;
            }
        }

        foreach (var ctx in index.Model.Contexts)
            foreach (var svc in ctx.Services)
            {
                foreach (var op in svc.Operations)
                    foreach (var p in op.Parameters) Add(p.Span, DeclKind.Parameter);
                foreach (var uc in svc.UseCases)
                    foreach (var p in uc.Parameters) Add(p.Span, DeclKind.Parameter);
            }

        return map;
    }

    /// <summary>Every member/property name declared on a value/entity type (for reference highlighting).</summary>
    private static IReadOnlySet<string> CollectPropertyNames(ModelIndex index)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var t in index.AllTypes())
            foreach (var n in index.MemberNames(t.Name))
                names.Add(n);
        return names;
    }

    private static string[] SplitLines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

    /// <summary>The default-channel <see cref="KoineLexer.Identifier"/> tokens of a source (skips strings, regex, comments).</summary>
    private static IEnumerable<IToken> IdentifierTokens(string source)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();
        foreach (var t in lexer.GetAllTokens())
            if (t.Type == KoineLexer.Identifier)
                yield return t;
    }
}
