using System.Text;
using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>The file URI and 1-based span of a resolved declaration.</summary>
public sealed record DeclLocation(string Uri, SourceSpan Span);

/// <summary>
/// One reference to a name: its file URI plus the 1-based line and 0-based start/end
/// columns of the identifier token (a half-open <c>[StartColumn, EndColumn)</c> range,
/// so editors can highlight or rename the exact identifier).
/// </summary>
public sealed record Reference(string Uri, int Line, int StartColumn, int EndColumn);

/// <summary>
/// A workspace-wide declaration index built from a <c>uri → source</c> map. Each
/// document is parsed once; resolution is local-file-first, then a unique match
/// across the other files (ambiguity yields no result). Editor-agnostic — no LSP.
/// </summary>
public sealed class WorkspaceIndex
{
    private readonly Dictionary<string, SemanticModel> _byUri = new(StringComparer.Ordinal);
    private readonly IReadOnlyDictionary<string, string> _documents;

    /// <summary>
    /// Primary constructor: builds a thin query layer over a held <see cref="KoineCompilation"/>
    /// snapshot. No re-parse is triggered — each file's <see cref="SemanticModel"/> is already
    /// memoized in the snapshot and is simply reused here. Repeated calls with the SAME held
    /// compilation are therefore zero-parse and zero-rebind.
    /// </summary>
    public WorkspaceIndex(KoineCompilation compilation)
    {
        _documents = compilation.Documents;
        foreach (var uri in compilation.Uris)
        {
            var model = compilation.SemanticModelFor(uri);
            if (model is not null)
            {
                _byUri[uri] = model;
            }
        }
    }

    /// <summary>
    /// Compatibility constructor: delegates to <see cref="WorkspaceIndex(KoineCompilation)"/> by
    /// creating a fresh <see cref="KoineCompilation"/> from the provided document map. Behavior is
    /// identical to the original implementation — a full parse per call — preserving backward
    /// compatibility for <c>KoineLanguageService</c>'s documents-based overloads, the WASM path,
    /// and <c>WorkspaceIndexTests</c>.
    /// </summary>
    public WorkspaceIndex(IReadOnlyDictionary<string, string> documents)
        : this(KoineCompilation.Create(
            documents.Select(kv => new SourceFile(kv.Key, kv.Value)).ToList()))
    {
    }

    /// <summary>
    /// Resolves <paramref name="name"/> to a declaration location: the active file wins if it
    /// declares the name (or, when <paramref name="enclosingType"/> is given, if the name is a field
    /// of that type — in-expression navigation); otherwise a unique declaration among the other files;
    /// otherwise null (unknown or ambiguous across ≥2 other files).
    /// </summary>
    public DeclLocation? ResolveDefinition(string activeUri, string name, string? enclosingType = null, int? offset = null)
    {
        if (_byUri.TryGetValue(activeUri, out SemanticModel? active))
        {
            // Precise position→node resolution first (in-expression / spec-body navigation): the
            // innermost name-bearing node under the cursor, resolved through the Symbol layer.
            if (offset is { } off && active.DefinitionAt(off)?.DeclSpan is { } nodeSpan)
            {
                return new DeclLocation(activeUri, nodeSpan);
            }

            if (active.GetSymbol(name, enclosingType)?.DeclSpan is { } localSpan)
            {
                return new DeclLocation(activeUri, localSpan);
            }
        }

        DeclLocation? found = null;
        foreach ((var uri, SemanticModel sema) in _byUri)
        {
            if (string.Equals(uri, activeUri, StringComparison.Ordinal))
            {
                continue;
            }

            if (StrongSpan(sema, name) is { } span)
            {
                if (found is not null)
                {
                    return null; // ambiguous across files
                }

                found = new DeclLocation(uri, span);
            }
        }
        return found;
    }

    /// <summary>
    /// The span of a "strong" declaration of <paramref name="name"/> within one
    /// model: a declared type, an unambiguous enum member, a spec, or the entity that
    /// owns the ID type. Null otherwise (primitives/collections are not declarations).
    /// </summary>
    internal static SourceSpan? StrongSpan(SemanticModel sema, string name) => sema.GetSymbol(name)?.DeclSpan;

    /// <summary>
    /// Every reference to the symbol declared/used at <paramref name="offset"/> in
    /// <paramref name="activeUri"/>, across the workspace (the declaration's own name included).
    ///
    /// <para>The cursor is first resolved to a target <see cref="Symbol"/> (via the active
    /// document's <see cref="SemanticModel.DefinitionAt(int)"/>, falling back to
    /// <see cref="SemanticModel.GetSymbol(string, string?)"/> with the lexical
    /// <paramref name="enclosingType"/>). The two target kinds are then handled differently:</para>
    ///
    /// <para><b>Member target (a field):</b> fully resolved — file- and type-scoped. Each candidate
    /// token whose text equals the name is itself resolved in its own document, honoring its
    /// enclosing-type scope, and kept only when it resolves to the SAME member declaration. So
    /// renaming <c>amount</c> on type <c>Money</c> never touches an unrelated <c>amount</c> on type
    /// <c>Order</c>.</para>
    ///
    /// <para><b>Non-member target (type / enum-member / spec / ID):</b> a workspace-wide token-text
    /// match, MINUS any candidate token that, in its own document, is the name of a declaration in a
    /// DIFFERENT namespace than the target (a field/parameter/let-binding name, an enum-member name
    /// when the target is not an enum member, or a type-name when the target IS an enum member). This
    /// is a single-file role check, not cross-file resolution — so a cross-file <c>TypeRef</c> (which
    /// is not a declaration name and cannot be classified) is conservatively KEPT, preserving
    /// cross-file type rename. It prevents the corruption where renaming a type <c>Status</c> also
    /// rewrote a same-named enum member or field. Member-access selectors (the <c>total</c> in
    /// <c>order.total</c>) need receiver-type inference we do not have here and are out of scope.</para>
    /// </summary>
    public IReadOnlyList<Reference> FindReferences(string activeUri, string name, int? offset = null, string? enclosingType = null)
    {
        Symbol? target = ResolveTarget(activeUri, name, offset, enclosingType);
        if (target is null)
        {
            return Array.Empty<Reference>();
        }

        // A member is file- and type-scoped; everything else (type / enum member / spec / ID) is a
        // flat, globally-unique name, so a token-text match across the workspace is faithful — minus
        // same-named declaration names from a different namespace (handled below).
        if (target is MemberSymbol member)
        {
            return MemberReferences(activeUri, member);
        }

        // An enum member shares the same name across unrelated enums (Phase.Active vs State.Active),
        // so a flat text match would corrupt the sibling enum. Resolve each candidate to its owning
        // enum and keep only those that are the SAME declaration.
        if (target is EnumMemberSymbol enumMember)
        {
            return EnumMemberReferences(enumMember);
        }

        var refs = new List<Reference>();
        foreach (var (uri, text) in _documents)
        {
            _byUri.TryGetValue(uri, out SemanticModel? sema);
            foreach (IToken tok in IdentifierTokens(text))
            {
                if (string.Equals(tok.Text, name, StringComparison.Ordinal)
                    && !IsDifferentNamespaceDeclName(sema, tok, target))
                {
                    refs.Add(ToReference(uri, tok));
                }
            }
        }

        return refs;
    }

    /// <summary>
    /// True when <paramref name="tok"/> belongs, in its own document's <paramref name="sema"/>, to a
    /// DIFFERENT namespace than the non-member <paramref name="target"/> — so renaming the target must
    /// not rewrite it. The token's structural role is read from its own model:
    /// <list type="bullet">
    /// <item>a declaration NAME (<see cref="SemanticModel.DeclarationNameAt"/>) of a field /
    /// parameter / let-binding, or an enum member when the target is not one, or a type/spec name
    /// when the target IS an enum member — excluded;</item>
    /// <item>a <see cref="TypeRef"/> occurrence — kept for a type/spec/ID target (this is the
    /// cross-file type reference we must rename) but excluded for an enum-member target;</item>
    /// <item>anything else unclassifiable (an identifier-expression reference) — conservatively
    /// KEPT.</item>
    /// </list>
    /// </summary>
    private static bool IsDifferentNamespaceDeclName(SemanticModel? sema, IToken tok, Symbol target)
    {
        if (sema is null)
        {
            return false; // a file that failed to parse: keep, can't classify
        }

        var targetIsEnumMember = target is EnumMemberSymbol;

        if (sema.DeclarationNameAt(tok.StartIndex) is { } declName)
        {
            return declName switch
            {
                // Per-scope binding names are never in the type / enum-member namespace.
                Member or Param or LetBinding => true,
                // An enum member is the target's namespace only when the target itself is one.
                EnumMember => !targetIsEnumMember,
                // A declared type / spec name shares the target's namespace ONLY when the target is a
                // type/spec/ID — exclude it precisely when the target is an enum member.
                TypeDecl or SpecDecl => targetIsEnumMember,
                _ => false,
            };
        }

        // Not a declaration name. A type reference belongs to the type namespace, so it must be
        // excluded for an enum-member target (renaming the member must not touch a same-named type's
        // uses) but kept for a type/spec/ID target (the cross-file type reference to rename).
        return targetIsEnumMember && sema.NodeAt(tok.StartIndex) is TypeRef;
    }

    /// <summary>
    /// Resolves the rename/find-references target under the cursor to a <see cref="Symbol"/>:
    /// the precise position→node resolution first (so a field reference inside an expression
    /// resolves to its member, and a declaration site resolves to its OWN declaration even when its
    /// name collides with another — e.g. an enum member vs a same-named type), then the
    /// lexically-scoped name lookup. <c>null</c> when the cursor is not on a renameable name.
    /// </summary>
    private Symbol? ResolveTarget(string activeUri, string name, int? offset, string? enclosingType)
    {
        if (_byUri.TryGetValue(activeUri, out SemanticModel? active))
        {
            if (offset is { } off && active.DefinitionAt(off) is { } byOffset)
            {
                return byOffset;
            }

            // The cursor sits on a declaration's own name: resolve to THAT declaration by position,
            // so a same-named collision (enum member vs type) does not mis-target the rename.
            if (offset is { } declOff && active.DeclaredSymbolAt(declOff) is { } byDecl)
            {
                return byDecl;
            }

            if (active.GetSymbol(name, enclosingType) is { } byName)
            {
                return byName;
            }
        }

        // Fall back to the workspace-wide gate: a token whose declaration lives in another file
        // (e.g. a cross-file type reference) still names a renameable symbol.
        return _byUri.Values
            .Select(sema => sema.GetSymbol(name))
            .FirstOrDefault(s => s is not null);
    }

    /// <summary>
    /// References to a field <paramref name="member"/>, confined to the file that declares it:
    /// the declaration's own name plus every identifier token that resolves (in that file, with
    /// its own enclosing-type scope) to the SAME member declaration. Cross-file is impossible —
    /// a member only exists within its declaring type's file.
    /// </summary>
    private IReadOnlyList<Reference> MemberReferences(string activeUri, MemberSymbol member)
    {
        if (!_documents.TryGetValue(activeUri, out var text) || !_byUri.TryGetValue(activeUri, out SemanticModel? sema))
        {
            return Array.Empty<Reference>();
        }

        var refs = new List<Reference>();
        foreach (IToken tok in IdentifierTokens(text))
        {
            if (!string.Equals(tok.Text, member.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var tokOffset = tok.StartIndex;

            // The declaration's own name is always a reference (the DefinitionAt path resolves
            // expression references, not the declaration token itself).
            var isDecl = tokOffset >= member.DeclSpan.Offset
                && tokOffset < member.DeclSpan.Offset + member.DeclSpan.Length;
            if (isDecl || sema.DefinitionAt(tokOffset) is MemberSymbol m
                && string.Equals(m.OwnerType, member.OwnerType, StringComparison.Ordinal)
                && m.DeclSpan == member.DeclSpan)
            {
                refs.Add(ToReference(activeUri, tok));
            }
        }

        return refs;
    }

    /// <summary>
    /// References to an enum member, scoped to the SAME declaration: every identifier token whose
    /// text matches and which resolves (in its own document, by position) to an enum member of the
    /// same owning enum (compared by <see cref="Symbol.DeclSpan"/>). This keeps a rename of
    /// <c>Phase.Active</c> from touching an unrelated <c>State.Active</c>. The declaration token
    /// resolves via <see cref="SemanticModel.DeclaredSymbolAt"/>; in-expression references via
    /// <see cref="SemanticModel.DefinitionAt"/>. (Member-access selectors like <c>Phase.Active</c>
    /// need receiver typing we lack and are out of scope — see the class remarks.)
    /// </summary>
    private IReadOnlyList<Reference> EnumMemberReferences(EnumMemberSymbol target)
    {
        var refs = new List<Reference>();
        foreach (var (uri, text) in _documents)
        {
            if (!_byUri.TryGetValue(uri, out SemanticModel? sema))
            {
                continue;
            }

            foreach (IToken tok in IdentifierTokens(text))
            {
                if (!string.Equals(tok.Text, target.Name, StringComparison.Ordinal))
                {
                    continue;
                }

                var off = tok.StartIndex;
                Symbol? resolved = sema.DeclaredSymbolAt(off) ?? sema.DefinitionAt(off);
                if (resolved is EnumMemberSymbol em && em.DeclSpan == target.DeclSpan)
                {
                    refs.Add(ToReference(uri, tok));
                }
            }
        }

        return refs;
    }

    private static Reference ToReference(string uri, IToken tok) =>
        new(uri, tok.Line, tok.Column, tok.Column + (tok.Text?.Length ?? 0));

    /// <summary>
    /// True when <paramref name="name"/> names a strong, globally-unique declaration somewhere in
    /// the workspace (a declared type, an unambiguous enum member, or a spec). Note this does NOT
    /// gate member-field renames, which are resolved precisely (offset + enclosing type) by
    /// <see cref="FindReferences"/>; it is the model-wide name gate only.
    /// </summary>
    public bool IsRenameableName(string activeUri, string name) =>
        _byUri.Values.Any(sema => StrongSpan(sema, name) is not null);

    /// <summary>Validates a proposed rename target against the lexer's <c>Identifier</c> rule (<c>[a-zA-Z_]\w*</c>).</summary>
    public static bool IsValidIdentifier(string name) =>
        name.Length > 0
        && (char.IsLetter(name[0]) || name[0] == '_')
        && name.All(c => char.IsLetterOrDigit(c) || c == '_');

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

    /// <summary>
    /// Renders a hover card for <paramref name="name"/>: a strong declaration in the
    /// active file, else a unique strong declaration across other files, else a weak
    /// minimal card for primitives/collections/ID-convention names. Null if unknown.
    /// </summary>
    public string? ResolveHover(string activeUri, string name, string? enclosingType = null)
    {
        if (_byUri.TryGetValue(activeUri, out SemanticModel? active))
        {
            // In-expression member reference (field of the enclosing type): a precise card.
            if (active.GetSymbol(name, enclosingType) is MemberSymbol ms)
            {
                return $"**{ms.Name}** *(field of {ms.OwnerType})* : `{TypeLabel(ms.Member.Type)}`"
                    + (ms.Doc is { Length: > 0 } d ? "\n\n" + d : string.Empty);
            }

            if (StrongHover(active.Index, name) is { } local)
            {
                return local;
            }
        }

        string? found = null;
        foreach ((var uri, SemanticModel sema) in _byUri)
        {
            if (string.Equals(uri, activeUri, StringComparison.Ordinal))
            {
                continue;
            }

            if (StrongHover(sema.Index, name) is { } card)
            {
                if (found is not null)
                {
                    return null; // ambiguous across files
                }

                found = card;
            }
        }
        return found ?? WeakCard(name);
    }

    /// <summary>A markdown card for a "strong" declaration in one model, or null.</summary>
    internal static string? StrongHover(ModelIndex index, string name)
    {
        if (index.TryGetDecl(name, out TypeDecl decl))
        {
            var sb = new StringBuilder();
            sb.Append("**").Append(name).Append("** *(").Append(KindLabel(index.Classify(name))).Append(")*");
            AppendBody(sb, decl);
            if (decl.Doc is { Length: > 0 } doc)
            {
                sb.Append("\n\n").Append(doc);
            }

            return sb.ToString();
        }

        IReadOnlyList<string> owners = index.EnumsDeclaring(name);
        if (owners.Count == 1)
        {
            return $"**{name}** *(enum member of {owners[0]})*";
        }

        // Asymmetry vs StrongSpan (which returns null here): there is no single navigation
        // target for an ambiguous member, but hover can still show a useful informational
        // card. Keep this — do not "align" it with StrongSpan.
        if (owners.Count >= 2)
        {
            return $"**{name}** *(ambiguous enum member — declared in {string.Join(", ", owners)})*";
        }

        SpecDecl? spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null)
        {
            return $"**{name}** *(spec on {spec.TargetType})*";
        }

        EntityDecl? owner = index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null)
        {
            var sb = new StringBuilder();
            sb.Append("**").Append(name).Append("** *(identity of ").Append(owner.Name).Append(")*");
            AppendBody(sb, owner);
            return sb.ToString();
        }

        return null;
    }

    /// <summary>A minimal card for primitives, collection keywords, or ID-convention names.</summary>
    internal static string? WeakCard(string name)
    {
        if (ModelIndex.Primitives.Contains(name))
        {
            return $"**{name}** *(Primitive)*";
        }

        if (name is ModelIndex.ListTypeName or ModelIndex.SetTypeName or ModelIndex.MapTypeName or ModelIndex.RangeTypeName)
        {
            return $"**{name}** *({name})*";
        }

        if (ModelIndex.IsIdConvention(name))
        {
            return $"**{name}** *(ID value object)*";
        }

        return null;
    }

    private static string KindLabel(TypeKind kind) => kind switch
    {
        TypeKind.IdValueObject => "ID value object",
        _ => kind.ToString(),
    };

    private static string TypeLabel(TypeRef t)
    {
        var name = t.Element is null ? t.Name
            : t.Value is null ? $"{t.Name}<{TypeLabel(t.Element)}>"
            : $"{t.Name}<{TypeLabel(t.Element)}, {TypeLabel(t.Value)}>";
        return t.IsOptional ? name + "?" : name;
    }

    private static void AppendBody(StringBuilder sb, TypeDecl decl)
    {
        switch (decl)
        {
            case ValueObjectDecl v:
                foreach (Member m in v.Members)
                {
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                }

                break;
            case EntityDecl e:
                sb.Append("\n\nidentified by `").Append(e.IdentityName).Append("` (")
                  .Append(e.IdStrategy).Append(')');
                foreach (Member m in e.Members)
                {
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                }

                break;
            case EnumDecl en:
                sb.Append("\n\n").Append(string.Join(", ", en.MemberNames));
                break;
            case EventDecl ev:
                foreach (Member m in ev.Members)
                {
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                }

                break;
            case AggregateDecl agg:
                // Listing the aggregate's owned/nested types is intentionally omitted for now.
                sb.Append("\n\nroot `").Append(agg.RootName).Append('`');
                if (agg.IsVersioned)
                {
                    sb.Append(" *(versioned)*");
                }

                break;
        }
    }
}
