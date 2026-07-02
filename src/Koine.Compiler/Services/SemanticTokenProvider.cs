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
///
/// <para>Bit 0 (<see cref="Declaration"/>) marks a declaration site. Bits 1–15 are the DDD
/// <em>concept kinds</em> ("Concept Colors", ADR 0004): a declaration name carries
/// <c>declaration | &lt;kind&gt;</c>, a reference carries <c>&lt;kind&gt;</c> alone, and base token
/// types (<see cref="SemanticTokenType.Type"/>/<see cref="SemanticTokenType.Enum"/>) are unchanged so
/// clients that don't understand the modifiers degrade to today's coloring. The order is an
/// <strong>append-only</strong> legend contract — never reorder or remove a bit; new kinds append at
/// higher bits.</para>
/// </summary>
public enum SemanticTokenModifier
{
    Declaration,
    Aggregate,
    Entity,
    ValueObject,
    Enumeration,
    DomainEvent,
    IntegrationEvent,
    Command,
    Query,
    ReadModel,
    Service,
    Repository,
    Policy,
    Factory,
    StateMachine,
    Specification,
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

    /// <summary>
    /// The legend modifier names, in <see cref="SemanticTokenModifier"/> order. Bit 0 is
    /// <c>declaration</c>; bits 1–15 are the DDD concept kinds (Concept Colors, ADR 0004).
    /// Append-only — the LSP shell advertises this verbatim as <c>legend.tokenModifiers</c>.
    /// </summary>
    public static readonly IReadOnlyList<string> TokenModifierNames =
        new[]
        {
            "declaration", "aggregate", "entity", "valueObject", "enumeration", "domainEvent",
            "integrationEvent", "command", "query", "readModel", "service", "repository", "policy",
            "factory", "stateMachine", "specification",
        };

    /// <summary>
    /// Classifies every default-channel identifier token in <paramref name="source"/> and
    /// returns the resulting <see cref="SemanticToken"/>s sorted by position. Returns an empty
    /// list when the document does not parse (graceful degradation).
    /// </summary>
    public IReadOnlyList<SemanticToken> Tokenize(string source)
    {
        (KoineModel? model, _) = _compiler.Parse(source);
        if (model is null)
        {
            return Array.Empty<SemanticToken>();
        }

        var index = new ModelIndex(model);

        // Declaration spans, by (1-based line, 0-based column), so a token at a declaration
        // site gets the right type AND the declaration modifier (e.g. the NAME in
        // `value Money { … }` or a member name in its body).
        IReadOnlyDictionary<(int, int), DeclKind> declarations = CollectDeclarations(index);

        // Member/property names declared anywhere (so a `field.` selector or an invariant
        // operand highlights as a property even though it is not a declared TYPE name).
        IReadOnlySet<string> propertyNames = CollectPropertyNames(index);

        // Concept-kind bit per declared type NAME (Concept Colors, ADR 0004), so both a
        // declaration and a reference to that name carry the kind. Primitives / collections /
        // ID types are not declared TypeDecls, so they carry no kind bit (the neutral type color).
        IReadOnlyDictionary<string, int> kindBits = CollectConceptKindBits(index);

        var tokens = new List<SemanticToken>();
        foreach (IToken tok in IdentifierTokens(source))
        {
            var text = tok.Text;
            if (string.IsNullOrEmpty(text))
            {
                continue;
            }

            var line = tok.Line;       // 1-based
            var col = tok.Column;      // 0-based
            Classification? classified = Classify(text, line, col, index, declarations, propertyNames, kindBits);
            if (classified is not { } c)
            {
                continue;
            }

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
        foreach (SemanticToken t in tokens)
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
        IReadOnlySet<string> propertyNames,
        IReadOnlyDictionary<string, int> kindBits)
    {
        var isDeclaration = declarations.TryGetValue((line, col), out DeclKind declKind);
        var declModifier = isDeclaration ? 1 << (int)SemanticTokenModifier.Declaration : 0;

        // The concept-kind bit rides on a type/enum name (declaration OR reference). Subordinate
        // tokens (property/parameter/enum-member) are not concepts, so they never carry a kind bit.
        var kindBit = kindBits.TryGetValue(text, out var bit) ? bit : 0;

        // A declaration site is authoritative about what it declares (a member name that
        // collides with a type name elsewhere still highlights as a property at its own
        // declaration, etc.).
        if (isDeclaration)
        {
            return declKind switch
            {
                DeclKind.Enum => new Classification(SemanticTokenType.Enum, declModifier | kindBit),
                DeclKind.EnumMember => new Classification(SemanticTokenType.EnumMember, declModifier),
                DeclKind.Property => new Classification(SemanticTokenType.Property, declModifier),
                DeclKind.Parameter => new Classification(SemanticTokenType.Parameter, declModifier),
                _ => new Classification(SemanticTokenType.Type, declModifier | kindBit),
            };
        }

        // Reference sites: classify by the model.
        if (index.IsEnumType(text))
        {
            return new Classification(SemanticTokenType.Enum, kindBit);
        }

        if (index.IsKnownType(text) || ModelIndex.Primitives.Contains(text)
                                    || text is ModelIndex.ListTypeName or ModelIndex.SetTypeName
                                        or ModelIndex.MapTypeName or ModelIndex.RangeTypeName)
        {
            return new Classification(SemanticTokenType.Type, kindBit);
        }

        if (index.EnumMemberToType.ContainsKey(text))
        {
            return new Classification(SemanticTokenType.EnumMember, 0);
        }

        if (propertyNames.Contains(text))
        {
            return new Classification(SemanticTokenType.Property, 0);
        }

        return null; // not something we highlight semantically (let the grammar handle it)
    }

    /// <summary>
    /// The concept-kind modifier bit for a declared type NAME → <c>(1 &lt;&lt; bit)</c>, for every
    /// declared type whose DDD kind maps to a concept color. Classification routes through
    /// <see cref="ModelIndex.Classify"/> — the compiler's single authority for "what kind is this type"
    /// — so the editor coloring can never disagree with how the validator/emitter classify the same
    /// name. Types with no concept kind (primitives, collections, generated ID value objects) never
    /// appear here and keep the neutral <see cref="SemanticTokenType.Type"/> color.
    /// </summary>
    private static IReadOnlyDictionary<string, int> CollectConceptKindBits(ModelIndex index)
    {
        var map = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (TypeDecl t in index.AllTypes())
        {
            SemanticTokenModifier? kind = index.Classify(t.Name) switch
            {
                TypeKind.Aggregate => SemanticTokenModifier.Aggregate,
                TypeKind.Entity => SemanticTokenModifier.Entity,
                TypeKind.Value => SemanticTokenModifier.ValueObject,
                TypeKind.Enum => SemanticTokenModifier.Enumeration,
                TypeKind.Event => SemanticTokenModifier.DomainEvent,
                TypeKind.IntegrationEvent => SemanticTokenModifier.IntegrationEvent,
                TypeKind.ReadModel => SemanticTokenModifier.ReadModel,
                TypeKind.Query => SemanticTokenModifier.Query,
                _ => null,
            };
            if (kind is { } k)
            {
                map[t.Name] = 1 << (int)k;
            }
        }

        return map;
    }

    private enum DeclKind { Type, Enum, EnumMember, Property, Parameter }

    /// <summary>
    /// Maps every declaration's NAME position (1-based line, 0-based column) to what it declares,
    /// so a token at that exact position is classified as a declaration. Every declaration now
    /// carries a real <see cref="KoineNode.NameSpan"/> (the identifier range), so the position is
    /// read directly from it — no source-line text search. Declarations with no name span
    /// (<see cref="SourceSpan.None"/>) are skipped.
    /// </summary>
    private static IReadOnlyDictionary<(int, int), DeclKind> CollectDeclarations(ModelIndex index)
    {
        var map = new Dictionary<(int, int), DeclKind>();

        void Add(SourceSpan nameSpan, DeclKind kind)
        {
            if (!nameSpan.IsNone)
            {
                map[(nameSpan.Line, nameSpan.Column - 1)] = kind; // SourceSpan.Column is 1-based
            }
        }

        foreach (TypeDecl t in index.AllTypes())
        {
            Add(t.NameSpan, t is EnumDecl ? DeclKind.Enum : DeclKind.Type);
            switch (t)
            {
                case ValueObjectDecl v:
                    foreach (Member m in v.Members)
                    {
                        Add(m.NameSpan, DeclKind.Property);
                    }

                    break;
                case EntityDecl e:
                    foreach (Member m in e.Members)
                    {
                        Add(m.NameSpan, DeclKind.Property);
                    }

                    foreach (CommandDecl c in e.Commands)
                    {
                        foreach (Param p in c.Parameters)
                        {
                            Add(p.NameSpan, DeclKind.Parameter);
                        }
                    }

                    foreach (FactoryDecl f in e.Factories)
                    {
                        foreach (Param p in f.Parameters)
                        {
                            Add(p.NameSpan, DeclKind.Parameter);
                        }
                    }

                    break;
                case EventDecl ev:
                    foreach (Member m in ev.Members)
                    {
                        Add(m.NameSpan, DeclKind.Property);
                    }

                    break;
                case IntegrationEventDecl ie:
                    foreach (Member m in ie.Members)
                    {
                        Add(m.NameSpan, DeclKind.Property);
                    }

                    break;
                case EnumDecl en:
                    foreach (EnumMember m in en.Members)
                    {
                        Add(m.NameSpan, DeclKind.EnumMember);
                    }

                    break;
            }
        }

        foreach (ContextNode ctx in index.Model.Contexts)
        {
            foreach (ServiceDecl svc in ctx.Services)
            {
                foreach (OperationDecl op in svc.Operations)
                {
                    foreach (Param p in op.Parameters)
                    {
                        Add(p.NameSpan, DeclKind.Parameter);
                    }
                }

                foreach (UseCaseDecl uc in svc.UseCases)
                {
                    foreach (Param p in uc.Parameters)
                    {
                        Add(p.NameSpan, DeclKind.Parameter);
                    }
                }
            }
        }

        return map;
    }

    /// <summary>Every member/property name declared on a value/entity type (for reference highlighting).</summary>
    private static IReadOnlySet<string> CollectPropertyNames(ModelIndex index)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (TypeDecl t in index.AllTypes())
        {
            foreach (var n in index.MemberNames(t.Name))
            {
                names.Add(n);
            }
        }

        return names;
    }

    /// <summary>The default-channel <see cref="KoineLexer.Identifier"/> tokens of a source (skips strings, regex, comments).</summary>
    private static IEnumerable<IToken> IdentifierTokens(string source)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();
        foreach (IToken? t in lexer.GetAllTokens())
        {
            if (t.Type == KoineLexer.Identifier)
            {
                yield return t;
            }
        }
    }
}
