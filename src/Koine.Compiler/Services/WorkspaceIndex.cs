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
    private readonly Dictionary<string, ModelIndex> _byUri = new(StringComparer.Ordinal);
    private readonly IReadOnlyDictionary<string, string> _documents;

    public WorkspaceIndex(IReadOnlyDictionary<string, string> documents)
    {
        // Re-parses every document eagerly. A fresh index is built per hover/definition
        // request today — fine at human (on-demand) speed; TODO: cache per (uri, content)
        // if this is ever wired to a per-keystroke feature.
        _documents = documents;
        var compiler = new KoineCompiler();
        foreach (var (uri, text) in documents)
        {
            var (model, _) = compiler.Parse(text);
            if (model is not null)
                _byUri[uri] = new ModelIndex(model); // a file that fails to parse is simply absent
        }
    }

    /// <summary>
    /// Resolves <paramref name="name"/> to a declaration location: the active file
    /// wins if it declares the name; otherwise a unique declaration among the other
    /// files; otherwise null (unknown or ambiguous across ≥2 other files).
    /// </summary>
    public DeclLocation? ResolveDefinition(string activeUri, string name)
    {
        if (_byUri.TryGetValue(activeUri, out var active) && StrongSpan(active, name) is { } localSpan)
            return new DeclLocation(activeUri, localSpan);

        DeclLocation? found = null;
        foreach (var (uri, index) in _byUri)
        {
            if (string.Equals(uri, activeUri, StringComparison.Ordinal))
                continue;
            if (StrongSpan(index, name) is { } span)
            {
                if (found is not null)
                    return null; // ambiguous across files
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
    internal static SourceSpan? StrongSpan(ModelIndex index, string name)
    {
        if (index.TryGetDecl(name, out var decl) && decl.Span != SourceSpan.None)
            return decl.Span;

        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1 && index.TryGetDecl(owners[0], out var ed) && ed is EnumDecl e)
        {
            var member = e.Members.FirstOrDefault(m => m.Name == name);
            if (member is not null && member.Span != SourceSpan.None)
                return member.Span;
        }

        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null && spec.Span != SourceSpan.None)
            return spec.Span;

        // ID type (e.g. ProductId) -> the entity that declares `identified by <name>`.
        // There is no standalone ID node, so navigation deliberately lands on the owning
        // entity's declaration. O(types) scan — fine for on-demand hover/definition;
        // TODO: precompute an identity-name -> entity map if this ever runs per keystroke.
        var owner = index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null && owner.Span != SourceSpan.None)
            return owner.Span;

        return null;
    }

    /// <summary>
    /// Every reference to <paramref name="name"/> across the workspace: each identifier
    /// token whose text equals the name, in any file. References are only returned when
    /// the name resolves to a strong declaration (a declared type, an unambiguous enum
    /// member, or a spec) somewhere in the workspace — otherwise the result is empty, so a
    /// random local variable never reports spurious "references". Koine type/enum/spec
    /// names are flat and globally unique within a model, so a token-text match is a
    /// faithful reference set; member-access selectors on unrelated receivers are the only
    /// possible false positive and are rare in practice.
    /// </summary>
    public IReadOnlyList<Reference> FindReferences(string activeUri, string name)
    {
        if (!IsRenameableName(activeUri, name))
            return Array.Empty<Reference>();

        var refs = new List<Reference>();
        foreach (var (uri, text) in _documents)
            foreach (var tok in IdentifierTokens(text))
                if (string.Equals(tok.Text, name, StringComparison.Ordinal))
                    refs.Add(new Reference(uri, tok.Line, tok.Column, tok.Column + (tok.Text?.Length ?? 0)));
        return refs;
    }

    /// <summary>
    /// True when <paramref name="name"/> names a strong, renameable declaration somewhere in
    /// the workspace (a declared type, an unambiguous enum member, or a spec) — the gate for
    /// both find-references and rename.
    /// </summary>
    public bool IsRenameableName(string activeUri, string name) =>
        _byUri.Values.Any(index => StrongSpan(index, name) is not null);

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
        foreach (var t in lexer.GetAllTokens())
            if (t.Type == KoineLexer.Identifier)
                yield return t;
    }

    /// <summary>
    /// Renders a hover card for <paramref name="name"/>: a strong declaration in the
    /// active file, else a unique strong declaration across other files, else a weak
    /// minimal card for primitives/collections/ID-convention names. Null if unknown.
    /// </summary>
    public string? ResolveHover(string activeUri, string name)
    {
        if (_byUri.TryGetValue(activeUri, out var active) && StrongHover(active, name) is { } local)
            return local;

        string? found = null;
        foreach (var (uri, index) in _byUri)
        {
            if (string.Equals(uri, activeUri, StringComparison.Ordinal))
                continue;
            if (StrongHover(index, name) is { } card)
            {
                if (found is not null)
                    return null; // ambiguous across files
                found = card;
            }
        }
        return found ?? WeakCard(name);
    }

    /// <summary>A markdown card for a "strong" declaration in one model, or null.</summary>
    internal static string? StrongHover(ModelIndex index, string name)
    {
        if (index.TryGetDecl(name, out var decl))
        {
            var sb = new StringBuilder();
            sb.Append("**").Append(name).Append("** *(").Append(KindLabel(index.Classify(name))).Append(")*");
            AppendBody(sb, decl);
            if (decl.Doc is { Length: > 0 } doc)
                sb.Append("\n\n").Append(doc);
            return sb.ToString();
        }

        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1)
            return $"**{name}** *(enum member of {owners[0]})*";
        // Asymmetry vs StrongSpan (which returns null here): there is no single navigation
        // target for an ambiguous member, but hover can still show a useful informational
        // card. Keep this — do not "align" it with StrongSpan.
        if (owners.Count >= 2)
            return $"**{name}** *(ambiguous enum member — declared in {string.Join(", ", owners)})*";

        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null)
            return $"**{name}** *(spec on {spec.TargetType})*";

        var owner = index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
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
            return $"**{name}** *(Primitive)*";
        if (name is ModelIndex.ListTypeName or ModelIndex.SetTypeName or ModelIndex.MapTypeName or ModelIndex.RangeTypeName)
            return $"**{name}** *({name})*";
        if (ModelIndex.IsIdConvention(name))
            return $"**{name}** *(ID value object)*";
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
                foreach (var m in v.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EntityDecl e:
                sb.Append("\n\nidentified by `").Append(e.IdentityName).Append("` (")
                  .Append(e.IdStrategy).Append(')');
                foreach (var m in e.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EnumDecl en:
                sb.Append("\n\n").Append(string.Join(", ", en.MemberNames));
                break;
            case EventDecl ev:
                foreach (var m in ev.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case AggregateDecl agg:
                // Listing the aggregate's owned/nested types is intentionally omitted for now.
                sb.Append("\n\nroot `").Append(agg.RootName).Append('`');
                if (agg.IsVersioned)
                    sb.Append(" *(versioned)*");
                break;
        }
    }
}
