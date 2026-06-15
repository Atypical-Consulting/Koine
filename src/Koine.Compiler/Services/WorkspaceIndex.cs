using Koine.Compiler.Ast;

namespace Koine.Compiler.Services;

/// <summary>The file URI and 1-based span of a resolved declaration.</summary>
public sealed record DeclLocation(string Uri, SourceSpan Span);

/// <summary>
/// A workspace-wide declaration index built from a <c>uri → source</c> map. Each
/// document is parsed once; resolution is local-file-first, then a unique match
/// across the other files (ambiguity yields no result). Editor-agnostic — no LSP.
/// </summary>
public sealed class WorkspaceIndex
{
    private readonly Dictionary<string, ModelIndex> _byUri = new(StringComparer.Ordinal);

    public WorkspaceIndex(IReadOnlyDictionary<string, string> documents)
    {
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
            if (string.Equals(uri, activeUri, StringComparison.Ordinal)) continue;
            if (StrongSpan(index, name) is { } span)
            {
                if (found is not null) return null; // ambiguous across files
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

        // ID type -> the entity that declares `identified by <name>`.
        var owner = index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null && owner.Span != SourceSpan.None)
            return owner.Span;

        return null;
    }
}
