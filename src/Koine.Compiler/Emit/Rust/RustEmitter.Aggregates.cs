using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The aggregate/repository slice of <see cref="RustEmitter"/>. An aggregate's nested types are emitted
/// flat into the context module (handled by the dispatcher); this slice adds the aggregate root's
/// persistence-ignorant repository <c>trait</c> — the idiomatic Rust seam a hand-written adapter
/// implements. The trait exposes the fundamental <c>get</c> lookup keyed on the root's branded ID, the
/// configured mutating operations (default add→<c>save</c>/update/remove), and any declarative finders
/// (a list finder returns <c>Vec&lt;Root&gt;</c>, a single finder <c>Option&lt;Root&gt;</c>).
/// </summary>
public sealed partial class RustEmitter
{
    /// <summary>The mutating + query operations a repository exposes when none are listed.</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    private void EmitAggregateExtras(RustEmitContext emit, StringBuilder body, AggregateDecl agg, string context)
    {
        EntityDecl? root = agg.RootEntity();
        if (root is null)
        {
            return;
        }

        var typeMapper = new RustTypeMapper(emit.Index);
        var rootName = RustNaming.ToPascalCase(root.Name);
        var idType = RustNaming.ToPascalCase(root.IdentityName);
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();

        body.Append('\n');
        body.Append("/// Persistence-ignorant repository contract for the `").Append(rootName).Append("` aggregate root.\n");
        body.Append("pub trait ").Append(rootName).Append("Repository {\n");

        var first = true;
        void Gap()
        {
            if (!first)
            {
                body.Append('\n');
            }
            first = false;
        }

        if (ops.Contains("getById"))
        {
            Gap();
            body.Append(Indent).Append("/// Loads the aggregate by its identity, if present.\n");
            body.Append(Indent).Append("fn get(&self, id: &").Append(idType).Append(") -> Option<").Append(rootName).Append(">;\n");
        }

        if (ops.Contains("add"))
        {
            Gap();
            body.Append(Indent).Append("/// Persists a new aggregate.\n");
            body.Append(Indent).Append("fn save(&mut self, aggregate: ").Append(rootName).Append(");\n");
        }

        if (ops.Contains("update"))
        {
            Gap();
            body.Append(Indent).Append("/// Persists changes to an existing aggregate.\n");
            body.Append(Indent).Append("fn update(&mut self, aggregate: ").Append(rootName).Append(");\n");
        }

        if (ops.Contains("remove"))
        {
            Gap();
            body.Append(Indent).Append("/// Removes the aggregate with the given identity.\n");
            body.Append(Indent).Append("fn remove(&mut self, id: &").Append(idType).Append(");\n");
        }

        foreach (FinderDecl finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"Vec<{rootName}>" : $"Option<{rootName}>";
            var method = RustNaming.Field(finder.Name);
            var paramList = string.Join(", ", finder.Parameters.Select(p =>
                RustNaming.Field(p.Name) + ": " + RepoParamType(p.Type, typeMapper)));
            var sep = paramList.Length > 0 ? ", " : string.Empty;
            body.Append(Indent).Append("fn ").Append(method).Append("(&self").Append(sep).Append(paramList)
                .Append(") -> ").Append(ret).Append(";\n");
        }

        body.Append("}\n");
    }

    /// <summary>A finder parameter type: by value for Copy types, by shared reference otherwise.</summary>
    private static string RepoParamType(TypeRef type, RustTypeMapper typeMapper) =>
        typeMapper.IsCopy(type) ? typeMapper.Map(type) : "&" + typeMapper.Map(type);
}
