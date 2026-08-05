using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The application / CQRS slice of <see cref="PythonEmitter"/> (R12), the Python analogue of
/// <see cref="CSharp.CSharpEmitter"/>'s <c>CSharpEmitter.Cqrs.cs</c>: read models with their pure
/// projection mappers, and query objects handled through the generic <c>QueryHandler</c>
/// <c>Protocol</c> already shipped in <see cref="PyRuntime"/>. Self-contained, stdlib-only,
/// <c>mypy --strict</c>-clean output.
/// </summary>
public sealed partial class PythonEmitter
{
    // ----------------------------------------------------------------------
    // Read models — a frozen-dataclass DTO + a pure projection function
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a read model (R12.3): a flat <c>@dataclass(frozen=True)</c> DTO of the projected fields
    /// plus a module-level <c>def to_&lt;name&gt;(src: Src) -&gt; M:</c> projection — the Python analogue
    /// of the C# value-equal <c>record</c> + <c>static To&lt;Name&gt;(this Src src)</c> extension. A
    /// direct field copies the source member (<c>src.field</c>); a derived field translates its
    /// projection rooted at <c>src</c> (the <see cref="PythonExpressionTranslator"/>'s configurable
    /// receiver, the analogue of the C# <c>memberReceiver: "src"</c>).
    /// </summary>
    private EmittedFile EmitReadModel(PyEmitContext emit, ReadModelDecl rm, string ns, PythonTypeMapper typeMapper)
    {
        // The read model lives in the base context namespace, so resolve its source there (R13.2).
        var context = ContextOf(ns);
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, emit.Index);
        var translator = new PythonExpressionTranslator(
            emit.Index, sourceMembers, emit.EnumMemberToType, typeMapper, context, memberReceiver: "src",
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var name = PythonNaming.ToPascalCase(rm.Name);
        var sourceName = PythonNaming.ToPascalCase(rm.SourceType);

        // Per-symbol import hint for Assemble (issue #1701): a direct field's cross-type import must
        // resolve against the SOURCE type's own owning context, mirroring the ResolveOwner-based
        // Map/Classify fix below (#1638) — a sibling mechanism (the module's cross-type import list)
        // that fix didn't reach. Without a hint here, Assemble falls back to this read model's OWN
        // context, so a same-named-but-unrelated local type can silently shadow the source's real one.
        var symbolContext = new Dictionary<string, string>(StringComparer.Ordinal);

        // Each field carries its Python type annotation, snake_case attribute name, and the
        // projection expression (rooted at `src`) used in the mapper.
        var fields = new List<(string PyType, string Attr, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var attr = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(f.Name));
            string pyType, rhs;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member. The source type
                // (and thus this member's own declaration) may live in a DIFFERENT bounded context than
                // this read model (R12.3 cross-context projection) — classify/map a bare field type
                // against the SOURCE's own owning context, not this read model's, so a same-named but
                // differently-kinded sibling type declared locally here can't misclassify it (#1638).
                if (emit.Index.TryGetMemberType(context, rm.SourceType, f.Name, out TypeRef t))
                {
                    var ownerContext = emit.Index.ResolveOwner(rm.SourceType, context).Owner ?? context;
                    pyType = typeMapper.Map(t, ownerContext);
                    CollectImportHints(t, ownerContext, symbolContext);
                }
                else
                {
                    pyType = "object";
                }
                rhs = "src." + attr;
            }
            else
            {
                pyType = typeMapper.Map(f.Type!, context);
                var expectedEnum = emit.Index.Classify(f.Type!.Qualifier ?? context, f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                // A derived read-model field is reconciled against ITS OWN declared type (#1889),
                // through the same TranslateReconciled every sibling call site in this family already
                // uses. An Int-projected value on a Decimal-declared field previously emitted a bare
                // `total: Decimal` assigned `src.lines` (an int) — a real `mypy --strict` error. Rust
                // closed this call site at #1378.
                rhs = translator.TranslateReconciled(f.Projection, PythonExpressionTranslator.NameMode.Property, expectedEnum, f.Type!);
            }

            fields.Add((pyType, attr, rhs));
        }

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");
        WriteDoc(sb, rm.Doc, Indent);
        if (fields.Count == 0 && string.IsNullOrEmpty(rm.Doc))
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (var (pyType, attr, _) in fields)
        {
            sb.Append(Indent).Append(attr).Append(": ").Append(pyType).Append('\n');
        }

        // The pure projection: `def to_<name>(src: Src) -> M:` constructing the DTO by keyword,
        // each argument copying or translating the matching field. Mirrors the C# `To<Name>` mapper.
        var funcName = PythonNaming.EscapeIdentifier("to_" + PythonNaming.ToSnakeCase(rm.Name));
        sb.Append('\n').Append('\n');
        sb.Append("def ").Append(funcName).Append("(src: ").Append(sourceName).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append("\"\"\"Projects ").Append(sourceName).Append(" to ").Append(name).Append(".\"\"\"\n");
        sb.Append(Indent).Append("return ").Append(name).Append('(');
        if (fields.Count > 0)
        {
            sb.Append('\n');
            foreach (var (_, attr, rhs) in fields)
            {
                sb.Append(Indent).Append(Indent).Append(attr).Append('=').Append(rhs).Append(",\n");
            }
            sb.Append(Indent);
        }
        sb.Append(")\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.ReadModels, rm.Name),
            Assemble(emit, ns, sb.ToString(), name, symbolContext.Count > 0 ? symbolContext : null),
            Kind: KindForFolder(KindFolder.ReadModels));
    }

    /// <summary>
    /// Walks <paramref name="type"/> (recursing into a <c>List</c>/<c>Set</c>/<c>Map</c>/<c>Range</c>
    /// element/value) and records, for every named model type it finds, that its cross-type import
    /// must resolve against <paramref name="context"/> — the context the field's OWN declaration
    /// belongs to, not necessarily the emitting module's. A built-in scalar (<c>String</c>/<c>Int</c>/…)
    /// never needs an import and is skipped.
    /// </summary>
    private static void CollectImportHints(TypeRef type, string context, Dictionary<string, string> symbolContext)
    {
        switch (type.Name)
        {
            case "String":
            case "Int":
            case "Bool":
            case "Decimal":
            case "Instant":
            case "Uuid":
            case "Guid":
                return;
            case ModelIndex.ListTypeName:
            case ModelIndex.SetTypeName:
            case ModelIndex.RangeTypeName:
                if (type.Element is not null)
                {
                    CollectImportHints(type.Element, context, symbolContext);
                }
                return;
            case ModelIndex.MapTypeName:
                if (type.Element is not null)
                {
                    CollectImportHints(type.Element, context, symbolContext);
                }
                if (type.Value is not null)
                {
                    CollectImportHints(type.Value, context, symbolContext);
                }
                return;
            default:
                // A field's own declared type can carry an explicit `Context.Type` qualifier that
                // wins over the ambient context — the same `type.Qualifier ?? context` idiom every
                // other resolution call site in this emitter uses (e.g. PythonTypeMapper.MapBase,
                // PythonExpressionTranslator). Skipping it here would mis-hint a qualified reference.
                symbolContext[PythonNaming.ToPascalCase(type.Name)] = type.Qualifier ?? context;
                return;
        }
    }

    // ----------------------------------------------------------------------
    // Queries — a frozen-dataclass DTO + a QueryHandler Protocol seam
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a query object (R12.4): a frozen-dataclass DTO carrying the criteria plus a
    /// <c>&lt;Q&gt;Handler(QueryHandler[&lt;Q&gt;, &lt;Result&gt;], Protocol)</c> seam reusing the
    /// generic <c>QueryHandler</c> <c>Protocol</c> already shipped in <see cref="PyRuntime"/> — the
    /// Python analogue of the C# DTO handled via <c>IQueryHandler&lt;TQuery,TResult&gt;</c>. The result
    /// type maps through the shared <see cref="PythonTypeMapper"/>, so a <c>List&lt;M&gt;</c> result
    /// becomes <c>tuple[M, ...]</c> (the same immutable-sequence convention the repositories use), a
    /// single <c>M</c> stays <c>M</c>, and an optional single result is <c>M | None</c>.
    /// </summary>
    private EmittedFile EmitQuery(PyEmitContext emit, QueryDecl q, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(q.Name);
        var handlerName = name + "Handler";
        var context = ContextOf(ns);
        var resultType = typeMapper.Map(q.ResultType, context);

        // Per-criterion/result import hint for Assemble (issue #1742, the sixth call site of the
        // #1701/#1712/#1716/#1718 gap): a criterion parameter's or the result type's own import must
        // resolve against ITS declared type's context — the explicit `Context.Type` qualifier when
        // present, else this query's own context — not unconditionally this query's own context. Like
        // a repository or service (#1718), a query isn't tied to one entity's own field set, so it
        // gets its own dictionary built from scratch.
        var symbolContext = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Param p in q.Criteria)
        {
            CollectImportHints(p.Type, context, symbolContext);
        }
        CollectImportHints(q.ResultType, context, symbolContext);

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");
        WriteDoc(sb, q.Doc ?? $"Query returning {resultType}; handled by {handlerName}.", Indent);
        if (q.Criteria.Count == 0)
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (Param p in q.Criteria)
        {
            sb.Append(Indent).Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name)))
              .Append(": ").Append(typeMapper.Map(p.Type, context)).Append('\n');
        }

        // The handler seam: a Protocol specializing the generic QueryHandler. Including `Protocol` in
        // the bases keeps the specialization a structural protocol the consumer implements.
        sb.Append('\n').Append('\n');
        sb.Append("class ").Append(handlerName).Append('(')
          .Append("QueryHandler[").Append(name).Append(", ").Append(resultType).Append("], Protocol):\n");
        sb.Append(Indent).Append("\"\"\"Handles ").Append(name).Append(", returning ").Append(resultType).Append(".\"\"\"\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Queries, q.Name),
            Assemble(emit, ns, sb.ToString(), name, symbolContext),
            Kind: KindForFolder(KindFolder.Queries));
    }

    /// <summary>
    /// The members a read model projects from. An entity adds the synthetic <c>id</c> (unless it
    /// already declares one), mirroring the C# <c>ReadModelSourceMembers</c>.
    /// </summary>
    private static IReadOnlyList<Member> ReadModelSourceMembers(string context, string sourceType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, sourceType, out TypeDecl decl) && !index.TryGetDecl(sourceType, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Any(m => string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
                ? e.Members
                : e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }
}
