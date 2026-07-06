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
/// A preview of a rename: the proposed <paramref name="NewName"/> and the per-file groups of
/// occurrences it would rewrite. Files keep first-seen order, and occurrences keep their order
/// within a file, so an editor can render a stable, file-by-file diff before applying it.
/// </summary>
public sealed record RenamePreview(string NewName, IReadOnlyList<RenameFileChanges> Files);

/// <summary>The occurrences of a renamed name within a single file <paramref name="Uri"/>.</summary>
public sealed record RenameFileChanges(string Uri, IReadOnlyList<Reference> Occurrences);

/// <summary>
/// A single rename edit: the <paramref name="Occurrence"/> to rewrite and the <paramref name="NewText"/>
/// to write there. Unlike a bare rename (every occurrence of one symbol takes the SAME new name), this
/// pairs each occurrence with its own replacement, so one rename can rewrite different tokens to different
/// texts — e.g. renaming an aggregate root <c>Order</c>→<c>PurchaseOrder</c> while co-renaming its
/// convention-linked identity type <c>OrderId</c>→<c>PurchaseOrderId</c> in the same edit (#550).
/// </summary>
public sealed record RenameEdit(Reference Occurrence, string NewText);

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
    /// rewrote a same-named enum member or field.</para>
    ///
    /// <para>Member-access selectors DO participate. For a member target (the <c>amount</c> in
    /// <c>total.amount</c>) the binder types the receiver and interns the selector's
    /// <see cref="MemberSymbol"/>, so <see cref="IdentityReferences"/> reaches it by symbol identity (the
    /// receiver's resolved type must own the target member). For an enum-member target the qualified
    /// selector (the <c>Cancelled</c> in <c>RefundStatus.Cancelled</c>) binds to the interned
    /// <see cref="EnumMemberSymbol"/>, so <see cref="EnumMemberReferences"/> reaches it via
    /// <see cref="SemanticModel.ReferencedSymbolAt"/> and rewrites it while leaving a sibling enum's
    /// same-named bare member untouched. A selector whose receiver the binder cannot type stays unbound
    /// and is simply not rewritten.</para>
    /// </summary>
    public IReadOnlyList<Reference> FindReferences(string activeUri, string name, int? offset = null, string? enclosingType = null)
    {
        Symbol? target = ResolveTarget(activeUri, name, offset, enclosingType);
        if (target is null)
        {
            return Array.Empty<Reference>();
        }

        // A member or a behavior parameter is file-scoped and now carries interned identity plus
        // binding-table references (member-access selectors and parameter uses included), so it is
        // resolved precisely by symbol identity rather than the former token-text heuristic.
        if (target is MemberSymbol or ParameterSymbol)
        {
            return IdentityReferences(activeUri, target);
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
    /// True when renaming the symbol under the cursor in <paramref name="activeUri"/> to
    /// <paramref name="newName"/> would COLLIDE with an existing declaration in the SAME namespace —
    /// so the rename must be rejected. The check is keyed by the target's KIND, never by bare name, so
    /// an unrelated same-named declaration in a different namespace does NOT block the rename:
    /// <list type="bullet">
    /// <item><b>Type / spec / ID</b> (the type namespace): collides only with an existing
    /// type/spec/ID of <paramref name="newName"/> anywhere in the workspace — a same-named enum
    /// member or field never blocks it.</item>
    /// <item><b>Enum member:</b> collides only with a sibling member of the SAME owning enum — a
    /// same-named member in a different enum, or a same-named type, never blocks it.</item>
    /// <item><b>Member (field):</b> collides only with another member of the SAME owning type.</item>
    /// <item><b>Parameter / anything else:</b> never gated here (local scope; out of scope).</item>
    /// </list>
    /// Returns <c>false</c> when the cursor is not on a renameable symbol (the caller's other guards
    /// already handle that).
    /// </summary>
    public bool WouldCollide(string activeUri, string name, int? offset, string? enclosingType, string newName)
    {
        if (ResolveTarget(activeUri, name, offset, enclosingType) is not { } target)
        {
            return false;
        }

        switch (target)
        {
            // Type namespace: a declared type, a spec, or an ID value object all share one namespace.
            // Block only when newName already names one of those somewhere in the workspace.
            case TypeSymbol or SpecSymbol or IdValueObjectSymbol:
                return _byUri.Values.Any(sema =>
                    sema.GetSymbol(newName) is TypeSymbol or SpecSymbol or IdValueObjectSymbol);

            // Enum member: block only when the SAME owning enum already declares newName, looked up
            // within the model that OWNS the target (the active document) — so a same-simple-name
            // enum in a different R13.2 context cannot drive the collision decision.
            case EnumMemberSymbol enumMember:
                return _byUri.TryGetValue(activeUri, out SemanticModel? enumOwner)
                    && enumOwner.Index.EnumsDeclaring(newName).Contains(enumMember.EnumName);

            // Field: block only when the SAME owning type already declares a member newName, looked
            // up within the model that OWNS the target (the active document) — so a same-simple-name
            // type in a different context cannot drive the collision decision.
            case MemberSymbol member:
                return _byUri.TryGetValue(activeUri, out SemanticModel? memberOwner)
                    && memberOwner.Index.TryGetMemberType(member.OwnerType, newName, out _);

            default:
                return false; // parameters / locals: not gated
        }
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
    /// The resolved rename/find-references target under the cursor — the same precise
    /// position→symbol resolution <see cref="FindReferences"/> and <see cref="WouldCollide"/> use,
    /// surfaced so a caller can gate on the symbol's IDENTITY rather than its bare token text. The
    /// aggregate-root <c>&lt;Root&gt;Id</c> co-rename uses this to fire only on the root entity's own
    /// declaration, never a same-named non-root symbol (enum member, value object, …) — #621.
    /// </summary>
    internal Symbol? ResolveSymbol(string activeUri, string name, int? offset, string? enclosingType) =>
        ResolveTarget(activeUri, name, offset, enclosingType);

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

            // A bound reference the name path cannot classify — a member-access selector or a behavior
            // parameter use — still names a renameable symbol (read from the binding table by position).
            if (offset is { } refOff && active.ReferencedSymbolAt(refOff) is { } byReference)
            {
                return byReference;
            }
        }

        // Fall back to the workspace-wide gate: a token whose declaration lives in another file
        // (e.g. a cross-file type reference) still names a renameable symbol.
        return _byUri.Values
            .Select(sema => sema.GetSymbol(name))
            .FirstOrDefault(s => s is not null);
    }

    /// <summary>
    /// References to a file-scoped symbol (a field <see cref="MemberSymbol"/> or a behavior
    /// <see cref="ParameterSymbol"/>), resolved by interned identity rather than token-text heuristics:
    /// the declaration's own name plus every identifier token that, in the declaring file, binds to the
    /// SAME symbol — including member-access selectors (<c>total.amount</c>) and parameter uses, which
    /// the former <see cref="SemanticModel.DefinitionAt"/>-only path could not reach. The reverse lookup
    /// is keyed by <see cref="SymbolEqualityComparer"/> (interning makes that identity). Cross-file is
    /// impossible — a member/parameter only exists within its declaring type's/behavior's file.
    /// </summary>
    private IReadOnlyList<Reference> IdentityReferences(string activeUri, Symbol target)
    {
        if (!_documents.TryGetValue(activeUri, out var text) || !_byUri.TryGetValue(activeUri, out SemanticModel? sema))
        {
            return Array.Empty<Reference>();
        }

        var refs = new List<Reference>();
        foreach (IToken tok in IdentifierTokens(text))
        {
            if (!string.Equals(tok.Text, target.Name, StringComparison.Ordinal))
            {
                continue;
            }

            int off = tok.StartIndex;
            // The declaration's own name (DeclaredSymbolAt) or a bound reference (ReferencedSymbolAt),
            // kept only when it is the SAME interned symbol as the target.
            Symbol? resolved = sema.DeclaredSymbolAt(off) ?? sema.ReferencedSymbolAt(off);
            if (resolved is not null && SymbolEqualityComparer.Default.Equals(resolved, target))
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
    /// resolves via <see cref="SemanticModel.DeclaredSymbolAt"/>; bare in-expression references via
    /// <see cref="SemanticModel.DefinitionAt"/>; and a qualified <c>Phase.Active</c> selector via
    /// <see cref="SemanticModel.ReferencedSymbolAt"/> (the binder interns the selector's enum-member
    /// symbol). The same <see cref="Symbol.DeclSpan"/> equality used for the bare case keeps a
    /// sibling enum's same-named member from being rewritten.
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
                Symbol? resolved = sema.DeclaredSymbolAt(off) ?? sema.DefinitionAt(off) ?? sema.ReferencedSymbolAt(off);
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

    /// <summary>
    /// True when <paramref name="name"/> already names a type, spec, or ID value object anywhere in the
    /// workspace — the type-namespace collision check that gates a convention-linked <c>&lt;Root&gt;Id</c>
    /// co-rename (#550): if the proposed <c>&lt;NewRoot&gt;Id</c> would clash with an existing declaration,
    /// the Id is left as-is rather than colliding. Mirrors the type-namespace branch of <see cref="WouldCollide"/>.
    /// </summary>
    internal bool DeclaresTypeLike(string name) =>
        _byUri.Values.Any(sema => sema.GetSymbol(name) is TypeSymbol or SpecSymbol or IdValueObjectSymbol);

    /// <summary>Validates a proposed rename target against the lexer's <c>Identifier</c> rule (<c>[a-zA-Z_]\w*</c>).</summary>
    public static bool IsValidIdentifier(string name) =>
        name.Length > 0
        && (char.IsLetter(name[0]) || name[0] == '_')
        && name.All(SourceTextGeometry.IsIdentifierChar);

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
