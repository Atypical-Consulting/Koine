using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The application/CQRS slice of <see cref="CSharpEmitter"/> (R12): the context's
/// Unit of Work, application-service interfaces, read-model projections, query objects
/// and the generic query-handler contract. Split out as a partial to keep the
/// orchestrating emitter focused.
/// </summary>
public sealed partial class CSharpEmitter
{
    /// <summary>The using a Mapperly-mode read-model projection needs (issue #630 / W4).</summary>
    private static readonly string[] MapperlyUsing = { "Riok.Mapperly.Abstractions" };

    // ----------------------------------------------------------------------
    // Application services, read models, CQRS (R12)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits the context's <c>IUnitOfWork</c> (R12.1): a repository property per aggregate
    /// (in declaration order) plus <c>SaveChangesAsync</c>. A pure abstraction — no
    /// infrastructure type appears. A context that publishes integration events also declares the
    /// outbox <c>Enqueue</c> seam (R19), gated on exactly the condition
    /// <see cref="EmitUnitOfWorkImpl"/> uses for the concrete member, so the contract and its
    /// realization can never disagree — and a non-publishing context's interface is unchanged.
    /// </summary>
    private EmittedFile EmitUnitOfWork(EmitContext emit, string ns, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "Transactional boundary over this context's aggregate repositories.", "");
        sb.Append("public interface IUnitOfWork\n{\n");
        foreach (AggregateDecl agg in aggregates)
        {
            // The repository lives in the aggregate's namespace; when that is a module
            // sub-namespace (R13.3), fully-qualify it so the base-namespace UoW resolves it.
            var aggNs = ModelIndex.NamespaceOf(ContextOf(ns), agg.ModulePath);
            var repo = aggNs == ns ? $"I{agg.RootName}Repository" : $"{aggNs}.I{agg.RootName}Repository";
            sb.Append(Indent).Append(repo).Append(' ').Append(Pluralize(agg.RootName)).Append(" { get; }\n");
        }
        sb.Append('\n');

        // The outbox enqueue seam. Declared here (not only on the concrete UnitOfWork) so an
        // application handler holding the abstraction can hand its aggregate's published
        // integration events over BEFORE the commit — the flush then rides the same transaction.
        if (publishesEvents)
        {
            sb.Append(Indent).Append("void Enqueue(IIntegrationEvent integrationEvent);\n\n");
        }

        sb.Append(Indent).Append("Task<int> SaveChangesAsync(CancellationToken ct = default);\n");
        sb.Append("}\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Abstractions, "IUnitOfWork.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits a service's application boundary (R12.2): an <c>I&lt;Name&gt;</c> interface with one
    /// async method per use case (<c>Task</c> or <c>Task&lt;Result&gt;</c>), inputs mapped through
    /// the type mapper.
    /// </summary>
    private EmittedFile EmitApplicationService(EmitContext emit, ServiceDecl svc, string ns, CSharpTypeMapper typeMapper)
    {
        var iface = "I" + svc.Name;
        var sb = new StringBuilder();
        WriteXmlDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteXmlDoc(sb, uc.Doc, Indent);
            var ret = uc.ReturnType is null ? "Task" : $"Task<{typeMapper.Map(uc.ReturnType)}>";
            IEnumerable<string> args = uc.Parameters
                .Select(p => $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}")
                // The use case is an async boundary: flow cancellation, like every
                // other generated async seam (repositories, UoW, query handlers).
                .Append("CancellationToken ct = default");
            sb.Append(Indent).Append(ret).Append(' ').Append(CSharpNaming.ToPascalCase(uc.Name))
              .Append('(').Append(string.Join(", ", args)).Append(");\n");
        }

        sb.Append("}\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Services, $"{iface}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false), Kind: KindForFolder(KindFolder.Services));
    }

    /// <summary>
    /// Emits a read model (R12.3): a value-equal <c>sealed record</c> of the projected
    /// fields plus a static <c>To&lt;Name&gt;(this Source src)</c> mapper. Direct fields map to
    /// the source property; derived fields translate their projection (rooted at <c>src</c>).
    /// </summary>
    private EmittedFile EmitReadModel(
        EmitContext emit,
        ReadModelDecl rm,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        // A read model emits into the base context namespace, so `ns` is the context used
        // to resolve its source (R13.2) when a type name is shared across contexts.
        var context = ContextOf(ns);
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, index);
        var translator = new CSharpExpressionTranslator(index, sourceMembers, enumMemberToType, memberReceiver: "src", context: context, options: _options);

        // The source type (and thus a direct field's own declaration) may live in a DIFFERENT bounded
        // context than this read model (R12.3 cross-context projection) — resolve its owning context
        // once so a direct field's bare type can be qualified against ITS OWN home (#1702, mirrors #1638).
        var sourceContext = index.ResolveOwner(rm.SourceType, context).Owner ?? context;

        var fields = new List<(string CsType, string Prop, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var prop = CSharpNaming.ToPascalCase(f.Name);
            string csType, rhs;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member. Left bare, a
                // same-named but differently-kinded sibling type declared locally in this read model's
                // own context would win over a same-named `using` — so qualify against the source's
                // own owning context instead of relying on `context` here.
                csType = index.TryGetMemberType(context, rm.SourceType, f.Name, out TypeRef t)
                    ? typeMapper.Map(QualifyAgainstSource(t, index, sourceContext, context))
                    : "object";
                rhs = $"src.{prop}";
            }
            else
            {
                csType = typeMapper.Map(f.Type!);
                var expectedEnum = index.Classify(f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                rhs = translator.TranslateTopLevel(f.Projection, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
            }
            fields.Add((csType, prop, rhs));
        }

        var sb = new StringBuilder();
        WriteXmlDoc(sb, rm.Doc, "");
        sb.Append("public sealed record ").Append(rm.Name).Append('(');
        for (var i = 0; i < fields.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(fields[i].CsType).Append(' ').Append(fields[i].Prop);
        }

        sb.Append(");\n\n");

        // W4 (issue #630): --app-mapping mapperly emits a Riok.Mapperly source-generated mapper
        // instead of the hand-rolled projection. RefOnly keeps the stubbed hand-rolled form (a
        // reference surface has no generated bodies). Plain (the default) is unchanged/byte-identical.
        if (_options.Mapping == CSharpMappingMode.Mapperly && !RefOnly)
        {
            EmitMapperlyProjection(sb, rm, fields);
            var usesLinqMapperly = rm.Fields.Any(f => f.Projection is not null && ExprUsesLinq(f.Projection));
            return new EmittedFile(PathFor(emit, ns, KindFolder.ReadModels, $"{rm.Name}.cs"),
                Assemble(emit, ns, sb.ToString(), usesLinqMapperly, MapperlyUsing), Kind: KindForFolder(KindFolder.ReadModels));
        }

        WriteXmlDoc(sb, $"Projects {rm.SourceType} to {rm.Name}.", "");
        sb.Append("public static class ").Append(rm.Name).Append("Projection\n{\n");
        sb.Append(Indent).Append("public static ").Append(rm.Name).Append(" To").Append(rm.Name)
          .Append("(this ").Append(rm.SourceType).Append(" src)\n");
        if (RefOnly)
        {
            // The projection body is stubbed, so no LINQ is referenced (the record itself never uses it).
            WriteRefStubExpressionBody(sb);
            sb.Append("}\n");
            return new EmittedFile(PathFor(emit, ns, KindFolder.ReadModels, $"{rm.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false), Kind: KindForFolder(KindFolder.ReadModels));
        }

        sb.Append(Indent).Append(Indent).Append("=> new ").Append(rm.Name).Append('(');
        for (var i = 0; i < fields.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            sb.Append(fields[i].Rhs);
        }

        sb.Append(");\n");
        sb.Append("}\n");

        var usesLinq = rm.Fields.Any(f => f.Projection is not null && ExprUsesLinq(f.Projection));
        return new EmittedFile(PathFor(emit, ns, KindFolder.ReadModels, $"{rm.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq), Kind: KindForFolder(KindFolder.ReadModels));
    }

    /// <summary>
    /// Rewrites a read-model direct field's <see cref="TypeRef"/> so any BARE (unqualified) simple name
    /// within it is force-qualified to <paramref name="sourceContext"/> — the field was read off the
    /// read model's SOURCE type (R12.3), which may live in a DIFFERENT bounded context than the read
    /// model itself (<paramref name="emittingContext"/>). Left bare, <see cref="CSharpTypeMapper"/> would
    /// print the type name as-is and rely on a <c>using</c> to bring it into scope — but a same-named,
    /// differently-kinded sibling type declared LOCALLY in <paramref name="emittingContext"/> wins over
    /// any <c>using</c> under C#'s own name-resolution rules, silently rebinding the property to the
    /// wrong type (#1702, mirrors #1638). An already-explicit <see cref="TypeRef.Qualifier"/> (a genuine
    /// R13.2 cross-context reference) is left untouched. Recurses into List/Set/Map element/value types,
    /// since the same shadowing risk applies to a nested type reference just as much as a top-level one.
    /// </summary>
    private static TypeRef QualifyAgainstSource(TypeRef type, ModelIndex index, string sourceContext, string emittingContext)
    {
        TypeRef? element = type.Element is { } e ? QualifyAgainstSource(e, index, sourceContext, emittingContext) : null;
        TypeRef? value = type.Value is { } v ? QualifyAgainstSource(v, index, sourceContext, emittingContext) : null;
        TypeRef rewritten = ReferenceEquals(element, type.Element) && ReferenceEquals(value, type.Value)
            ? type
            : type with { Element = element, Value = value };

        if (rewritten.Qualifier is null
            && index.ResolveOwner(rewritten.Name, sourceContext) is { Owner: { } owner } && owner != emittingContext)
        {
            return rewritten with { Qualifier = owner };
        }

        return rewritten;
    }

    /// <summary>
    /// Emits a Riok.Mapperly source-generated projection (W4): a <c>[Mapper]</c> static partial class
    /// with a static partial <c>To&lt;Name&gt;(this Source)</c> extension method (so every call site is
    /// unchanged). Direct fields auto-map by name; each derived field has no like-named source member,
    /// so it is mapped from a private helper — wired via <c>[MapPropertyFromSource]</c> — whose body is
    /// the translated projection expression.
    /// </summary>
    private void EmitMapperlyProjection(
        StringBuilder sb,
        ReadModelDecl rm,
        IReadOnlyList<(string CsType, string Prop, string Rhs)> fields)
    {
        // `fields` is built in `rm.Fields` order, so a field is derived exactly when the like-indexed
        // ReadModelField carries a projection; collect those for the per-property mapping helpers.
        var derived = new List<(string CsType, string Prop, string Rhs)>();
        for (var i = 0; i < rm.Fields.Count; i++)
        {
            if (rm.Fields[i].Projection is not null)
            {
                derived.Add(fields[i]);
            }
        }

        WriteXmlDoc(sb, $"Projects {rm.SourceType} to {rm.Name} (Riok.Mapperly source-generated).", "");
        sb.Append("[Mapper]\n");
        sb.Append("public static partial class ").Append(rm.Name).Append("Projection\n{\n");

        foreach (var d in derived)
        {
            sb.Append(Indent).Append("[MapPropertyFromSource(nameof(").Append(rm.Name).Append('.').Append(d.Prop)
              .Append("), Use = nameof(Map").Append(d.Prop).Append("))]\n");
        }

        sb.Append(Indent).Append("public static partial ").Append(rm.Name).Append(" To").Append(rm.Name)
          .Append("(this ").Append(rm.SourceType).Append(" src);\n");

        foreach (var d in derived)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("private static ").Append(d.CsType).Append(" Map").Append(d.Prop)
              .Append('(').Append(rm.SourceType).Append(" src)\n");
            sb.Append(Indent).Append(Indent).Append("=> ").Append(d.Rhs).Append(";\n");
        }

        sb.Append("}\n");
    }

    /// <summary>
    /// The members a read model projects from (entities add the synthetic <c>id</c>, unless
    /// the entity already declares its own <c>id</c> member).
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

    /// <summary>
    /// Emits a query object (R12.4): a <c>sealed record</c> carrying the criteria, handled via
    /// the generic runtime <c>IQueryHandler&lt;TQuery,TResult&gt;</c> (named in its doc).
    /// </summary>
    private EmittedFile EmitQuery(EmitContext emit, QueryDecl q, string ns, CSharpTypeMapper typeMapper)
    {
        var isList = q.ResultType.Name == ModelIndex.ListTypeName;
        var resultName = isList ? q.ResultType.Element!.Name : q.ResultType.Name;
        var resultType = isList ? $"IReadOnlyList<{resultName}>" : resultName;

        var sb = new StringBuilder();
        WriteXmlDoc(sb, q.Doc ?? $"Query returning {resultType}; implement IQueryHandler<{q.Name}, {resultType}>.", "");
        // A query is a TypeDecl, so `@deprecated("…")` carries onto it exactly as it does onto a value
        // object or an event (R15.1); no-op for the un-annotated query every model had before.
        WriteObsolete(sb, q.Deprecated, "");
        var criteria = string.Join(", ", q.Criteria.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToPascalCase(p.Name)}"));
        sb.Append("public sealed record ").Append(q.Name).Append('(').Append(criteria).Append(");\n");

        return new EmittedFile(PathFor(emit, ns, KindFolder.Queries, $"{q.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false), Kind: KindForFolder(KindFolder.Queries));
    }

    /// <summary>True when the model declares any query object (gates the query-handler runtime type).</summary>
    private static bool HasQueries(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).OfType<QueryDecl>().Any();

    /// <summary>Emits the generic <c>IQueryHandler&lt;TQuery,TResult&gt;</c> once into Koine.Runtime (R12.4).</summary>
    private EmittedFile EmitQueryHandlerInterface(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Handles a query object, returning its typed result.</summary>\n");
        sb.Append("public interface IQueryHandler<TQuery, TResult>\n{\n");
        sb.Append(Indent).Append("Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IQueryHandler.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>A small English pluralizer for repository property names (Order -&gt; Orders, Category -&gt; Categories).</summary>
    private static string Pluralize(string name)
    {
        if (name.Length == 0)
        {
            return name;
        }

        if (name.EndsWith("s", StringComparison.Ordinal) || name.EndsWith("x", StringComparison.Ordinal)
                                                         || name.EndsWith("z", StringComparison.Ordinal) || name.EndsWith("ch", StringComparison.Ordinal)
                                                         || name.EndsWith("sh", StringComparison.Ordinal))
        {
            return name + "es";
        }

        if (name.Length >= 2 && char.ToLowerInvariant(name[^1]) == 'y'
                             && "aeiou".IndexOf(char.ToLowerInvariant(name[^2])) < 0)
        {
            return name[..^1] + "ies";
        }

        return name + "s";
    }
}
