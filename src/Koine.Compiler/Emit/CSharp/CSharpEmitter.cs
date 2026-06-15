using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The C# backend. Turns a validated <see cref="KoineModel"/> into a set of C#
/// source files. All C#-specific decisions (naming, type mapping, expression
/// translation, codegen rules) live in this folder; the AST stays target-agnostic.
///
/// <para>Emission is deterministic (declaration order) so re-runs are byte-identical.
/// Every file ends with a single trailing newline; no timestamps are emitted.</para>
/// </summary>
public sealed class CSharpEmitter : IEmitter
{
    public string TargetName => "csharp";

    private const string Indent = "    ";

    // Value-object name -> scalar C# types ("int"/"decimal") it is multiplied by
    // in some derived expression. Drives scalar operator generation (see below).
    private IReadOnlyDictionary<string, IReadOnlySet<string>> _scalarNeeds =
        new Dictionary<string, IReadOnlySet<string>>();

    // Value-object names that are folded with `+` somewhere (e.g. `lines.sum(l => l.subtotal)`
    // over a Money field). Drives generation of an additive operator.
    private IReadOnlySet<string> _additiveNeeds = new HashSet<string>();

    // All context (namespace) names in the model. Every type in a context shares
    // the single namespace <Context>; aggregates are boundaries, not namespaces.
    private IReadOnlyList<string> _contextNames = Array.Empty<string>();

    // ID type name -> its declared identity strategy (R11.1). An ID referenced but
    // not owned by any entity (e.g. a foreign-context *Id) defaults to Guid.
    private IReadOnlyDictionary<string, (IdentityStrategy Strategy, string? Backing)> _idStrategies =
        new Dictionary<string, (IdentityStrategy, string?)>();

    // The model index, used by Assemble to compute precise cross-namespace usings (R13.2/R13.3).
    private ModelIndex _index = null!;

    public IReadOnlyList<EmittedFile> Emit(KoineModel model)
    {
        var index = new ModelIndex(model);
        _index = index;
        var typeMapper = new CSharpTypeMapper(index);
        var enumMemberToType = BuildEnumMemberMap(model);
        _scalarNeeds = BuildScalarOperatorNeeds(model, index);
        _additiveNeeds = BuildAdditiveOperatorNeeds(model, index);
        _contextNames = model.Contexts.Select(c => c.Name).ToList();
        _idStrategies = BuildIdentityStrategies(model);

        var files = new List<EmittedFile>();

        // 1. Runtime support, emitted once.
        files.Add(EmitRuntimeException());
        files.Add(EmitAggregateRootInterface());
        if (NeedsValueObjects(model))
            files.Add(EmitValueObjectBase());
        if (UsesRange(model))
            files.Add(EmitRange());
        if (HasEvents(model))
            files.Add(EmitDomainEventInterface());
        if (HasVersionedAggregate(model))
            files.Add(EmitConcurrencyConflictException());
        if (HasQueries(model))
            files.Add(EmitQueryHandlerInterface());

        // 2. Per-context user types. Aggregate-nested types are flattened into the
        //    context namespace; the aggregate boundary is marked via IAggregateRoot.
        foreach (var ctx in model.Contexts)
        {
            var idOwnership = BuildIdOwnership(ctx);

            foreach (var type in ctx.Types)
            {
                // A type emits into its context namespace, extended by its module path (R13.3).
                var ns = ModelIndex.NamespaceOf(ctx.Name, type.ModulePath);
                switch (type)
                {
                    case ValueObjectDecl vo:
                        files.Add(EmitValueObject(vo, ns, index, typeMapper, enumMemberToType));
                        break;
                    case EntityDecl entity:
                        EmitEntityAndId(files, entity, ns, isRoot: false, isVersioned: false, index, typeMapper, enumMemberToType);
                        break;
                    case EnumDecl @enum:
                        files.Add(EmitEnum(@enum, ns, index, typeMapper, enumMemberToType));
                        break;
                    case EventDecl @event:
                        files.Add(EmitEvent(@event, ns, index, typeMapper, enumMemberToType));
                        break;
                    case AggregateDecl agg:
                        EmitAggregate(files, agg, ns, index, typeMapper, enumMemberToType);
                        break;
                    case ReadModelDecl rm:
                        files.Add(EmitReadModel(rm, ns, index, typeMapper, enumMemberToType));
                        break;
                    case QueryDecl query:
                        files.Add(EmitQuery(query, ns, typeMapper));
                        break;
                }
            }

            // Emit any ID value objects that are referenced but NOT owned by an
            // entity (e.g. ProductId). Honor the owning entity's strategy when one is
            // known (a cross-context reference), else default to Guid.
            foreach (var idName in OrderedUnownedIds(ctx, index, idOwnership))
            {
                var (strategy, backing) = _idStrategies.TryGetValue(idName, out var s)
                    ? s : (IdentityStrategy.Guid, null);
                files.Add(EmitIdValueObject(idName, ctx.Name, strategy, backing));
            }

            // 3. R10 behavioral declarations: specifications, services, policies.
            var contextSpecs = ctx.Specs
                .Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs))
                .ToList();
            if (contextSpecs.Count > 0)
                files.Add(EmitSpecifications(ctx.Name, contextSpecs, index, typeMapper, enumMemberToType));
            foreach (var svc in ctx.Services)
            {
                // A service emits a stateless domain class for its pure operations (R10.2)
                // and/or an application-service interface for its use cases (R12.2).
                if (svc.Operations.Count > 0)
                    files.Add(EmitService(svc, ctx.Name, index, typeMapper, enumMemberToType));
                if (svc.UseCases.Count > 0)
                    files.Add(EmitApplicationService(svc, ctx.Name, typeMapper));
            }
            foreach (var policy in ctx.Policies)
                files.Add(EmitPolicy(policy, ctx.Name, index, enumMemberToType));

            // 4. The context's Unit of Work (R12.1): a transactional seam over its
            //    aggregate repositories. Emitted only when the context has aggregates whose
            //    root is an entity (only those produce a repository to expose).
            var aggregates = ctx.Types.OfType<AggregateDecl>()
                .Where(a => a.Types.OfType<EntityDecl>().Any(e => e.Name == a.RootName))
                .ToList();
            if (aggregates.Count > 0)
                files.Add(EmitUnitOfWork(ctx.Name, aggregates));
        }

        return files;
    }

    // ----------------------------------------------------------------------
    // Aggregates
    // ----------------------------------------------------------------------

    private void EmitAggregate(
        List<EmittedFile> files,
        AggregateDecl agg,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        // Nested types live in the enclosing context namespace (ns), not a sub-namespace.
        foreach (var type in agg.Types)
        {
            switch (type)
            {
                case ValueObjectDecl vo:
                    files.Add(EmitValueObject(vo, ns, index, typeMapper, enumMemberToType));
                    break;
                case EntityDecl entity:
                    var isRoot = entity.Name == agg.RootName;
                    EmitEntityAndId(files, entity, ns, isRoot, isRoot && agg.IsVersioned, index, typeMapper, enumMemberToType);
                    break;
                case EnumDecl @enum:
                    files.Add(EmitEnum(@enum, ns, index, typeMapper, enumMemberToType));
                    break;
                case EventDecl @event:
                    files.Add(EmitEvent(@event, ns, index, typeMapper, enumMemberToType));
                    break;
                case AggregateDecl nested:
                    // Nested aggregates are not part of v0 fixtures, but recurse safely.
                    EmitAggregate(files, nested, ns, index, typeMapper, enumMemberToType);
                    break;
            }
        }

        // The aggregate root's repository contract (R11.2/R11.3).
        if (EmitRepository(agg, ns, index, typeMapper) is { } repo)
            files.Add(repo);
    }

    // ----------------------------------------------------------------------
    // Repositories (R11.2 / R11.3)
    // ----------------------------------------------------------------------

    /// <summary>The mutating + query operations a repository exposes when none are listed.</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    /// <summary>
    /// Emits the <c>I&lt;Root&gt;Repository</c> interface for an aggregate: the
    /// fundamental <c>GetByIdAsync</c> lookup, the configured mutating operations
    /// (R11.3, default add/update/remove), and any declarative finders. Keyed on the
    /// root's ID value object. Returns <c>null</c> if the root cannot be resolved
    /// (already a validation error).
    /// </summary>
    private EmittedFile? EmitRepository(AggregateDecl agg, string ns, ModelIndex index, CSharpTypeMapper typeMapper)
    {
        var root = agg.Types.OfType<EntityDecl>().FirstOrDefault(e => e.Name == agg.RootName);
        if (root is null)
            return null;

        var rootName = root.Name;
        var idType = root.IdentityName;
        var ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        var finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var iface = $"I{rootName}Repository";

        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"Persistence-ignorant repository contract for the {rootName} aggregate root.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");

        var first = true;
        void Gap() { if (!first) sb.Append('\n'); first = false; }

        if (ops.Contains("getById"))
        {
            Gap();
            sb.Append(Indent).Append("Task<").Append(rootName).Append("?> GetByIdAsync(")
              .Append(idType).Append(" id, CancellationToken ct = default);\n");
        }

        foreach (var (op, verb) in new[] { ("add", "Add"), ("update", "Update"), ("remove", "Remove") })
            if (ops.Contains(op))
            {
                Gap();
                // A versioned aggregate enforces the expected Version on a state-changing save.
                if (agg.IsVersioned && op != "add")
                    sb.Append(Indent).Append("/// <summary>Enforces the aggregate's expected Version; ")
                      .Append("throws ConcurrencyConflictException on a stale write.</summary>\n");
                sb.Append(Indent).Append("Task ").Append(verb).Append("Async(")
                  .Append(rootName).Append(" aggregate, CancellationToken ct = default);\n");
            }

        foreach (var finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"Task<IReadOnlyList<{rootName}>>" : $"Task<{rootName}?>";
            var paramList = string.Join(", ", finder.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
            if (paramList.Length > 0)
                paramList += ", ";
            sb.Append(Indent).Append(ret).Append(' ')
              .Append(CSharpNaming.ToPascalCase(finder.Name)).Append("Async(")
              .Append(paramList).Append("CancellationToken ct = default);\n");
        }

        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/{iface}.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>Maps every owned ID type name to its declared identity strategy (R11.1).</summary>
    private static IReadOnlyDictionary<string, (IdentityStrategy Strategy, string? Backing)> BuildIdentityStrategies(KoineModel model)
    {
        var map = new Dictionary<string, (IdentityStrategy, string?)>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var t in AllTypeDecls(ctx))
                if (t is EntityDecl e)
                    map[e.IdentityName] = (e.IdStrategy, e.IdBackingType);
        return map;
    }

    /// <summary>True when any aggregate is declared <c>versioned</c> (gates the concurrency runtime type).</summary>
    private static bool HasVersionedAggregate(KoineModel model) =>
        model.Contexts.SelectMany(AllTypeDecls).OfType<AggregateDecl>().Any(a => a.IsVersioned);

    // ----------------------------------------------------------------------
    // Application services, read models, CQRS (R12)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits the context's <c>IUnitOfWork</c> (R12.1): a repository property per aggregate
    /// (in declaration order) plus <c>SaveChangesAsync</c>. A pure abstraction — no
    /// infrastructure type appears.
    /// </summary>
    private EmittedFile EmitUnitOfWork(string ns, IReadOnlyList<AggregateDecl> aggregates)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "Transactional boundary over this context's aggregate repositories.", "");
        sb.Append("public interface IUnitOfWork\n{\n");
        foreach (var agg in aggregates)
        {
            // The repository lives in the aggregate's namespace; when that is a module
            // sub-namespace (R13.3), fully-qualify it so the base-namespace UoW resolves it.
            var aggNs = ModelIndex.NamespaceOf(ContextOf(ns), agg.ModulePath);
            var repo = aggNs == ns ? $"I{agg.RootName}Repository" : $"{aggNs}.I{agg.RootName}Repository";
            sb.Append(Indent).Append(repo).Append(' ').Append(Pluralize(agg.RootName)).Append(" { get; }\n");
        }
        sb.Append('\n');
        sb.Append(Indent).Append("Task<int> SaveChangesAsync(CancellationToken ct = default);\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/IUnitOfWork.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits a service's application boundary (R12.2): an <c>I&lt;Name&gt;</c> interface with one
    /// async method per use case (<c>Task</c> or <c>Task&lt;Result&gt;</c>), inputs mapped through
    /// the type mapper.
    /// </summary>
    private EmittedFile EmitApplicationService(ServiceDecl svc, string ns, CSharpTypeMapper typeMapper)
    {
        var iface = "I" + svc.Name;
        var sb = new StringBuilder();
        WriteXmlDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");

        var first = true;
        foreach (var uc in svc.UseCases)
        {
            if (!first) sb.Append('\n');
            first = false;
            WriteXmlDoc(sb, uc.Doc, Indent);
            var ret = uc.ReturnType is null ? "Task" : $"Task<{typeMapper.Map(uc.ReturnType)}>";
            var paramList = string.Join(", ", uc.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
            sb.Append(Indent).Append(ret).Append(' ').Append(CSharpNaming.ToPascalCase(uc.Name))
              .Append('(').Append(paramList).Append(");\n");
        }

        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/{iface}.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits a read model (R12.3): a value-equal <c>sealed record</c> of the projected
    /// fields plus a static <c>To&lt;Name&gt;(this Source src)</c> mapper. Direct fields map to
    /// the source property; derived fields translate their projection (rooted at <c>src</c>).
    /// </summary>
    private EmittedFile EmitReadModel(
        ReadModelDecl rm,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        // A read model emits into the base context namespace, so `ns` is the context used
        // to resolve its source (R13.2) when a type name is shared across contexts.
        var context = ContextOf(ns);
        var sourceMembers = ReadModelSourceMembers(context, rm.SourceType, index);
        var translator = new CSharpExpressionTranslator(index, sourceMembers, enumMemberToType, memberReceiver: "src", context: context);

        var fields = new List<(string CsType, string Prop, string Rhs)>();
        foreach (var f in rm.Fields)
        {
            var prop = CSharpNaming.ToPascalCase(f.Name);
            string csType, rhs;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member.
                csType = index.TryGetMemberType(context, rm.SourceType, f.Name, out var t) ? typeMapper.Map(t) : "object";
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
        sb.Append("public sealed record ").Append(rm.Name).Append('(')
          .Append(string.Join(", ", fields.Select(f => $"{f.CsType} {f.Prop}"))).Append(");\n\n");

        WriteXmlDoc(sb, $"Projects {rm.SourceType} to {rm.Name}.", "");
        sb.Append("public static class ").Append(rm.Name).Append("Projection\n{\n");
        sb.Append(Indent).Append("public static ").Append(rm.Name).Append(" To").Append(rm.Name)
          .Append("(this ").Append(rm.SourceType).Append(" src) =>\n");
        sb.Append(Indent).Append(Indent).Append("new ").Append(rm.Name).Append('(')
          .Append(string.Join(", ", fields.Select(f => f.Rhs))).Append(");\n");
        sb.Append("}\n");

        var usesLinq = rm.Fields.Any(f => f.Projection is not null && ExprUsesLinq(f.Projection));
        return new EmittedFile($"{FolderFor(ns)}/{rm.Name}.cs", Assemble(ns, sb.ToString(), usesLinq));
    }

    /// <summary>
    /// The members a read model projects from (entities add the synthetic <c>id</c>, unless
    /// the entity already declares its own <c>id</c> member).
    /// </summary>
    private static IReadOnlyList<Member> ReadModelSourceMembers(string context, string sourceType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, sourceType, out var decl) && !index.TryGetDecl(sourceType, out decl))
            return Array.Empty<Member>();
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
    private EmittedFile EmitQuery(QueryDecl q, string ns, CSharpTypeMapper typeMapper)
    {
        var isList = q.ResultType.Name == ModelIndex.ListTypeName;
        var resultName = isList ? q.ResultType.Element!.Name : q.ResultType.Name;
        var resultType = isList ? $"IReadOnlyList<{resultName}>" : resultName;

        var sb = new StringBuilder();
        WriteXmlDoc(sb, q.Doc ?? $"Query returning {resultType}; implement IQueryHandler<{q.Name}, {resultType}>.", "");
        var criteria = string.Join(", ", q.Criteria.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToPascalCase(p.Name)}"));
        sb.Append("public sealed record ").Append(q.Name).Append('(').Append(criteria).Append(");\n");

        return new EmittedFile($"{FolderFor(ns)}/{q.Name}.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>True when the model declares any query object (gates the query-handler runtime type).</summary>
    private static bool HasQueries(KoineModel model) =>
        model.Contexts.SelectMany(AllTypeDecls).OfType<QueryDecl>().Any();

    /// <summary>Emits the generic <c>IQueryHandler&lt;TQuery,TResult&gt;</c> once into Koine.Runtime (R12.4).</summary>
    private EmittedFile EmitQueryHandlerInterface()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Handles a query object, returning its typed result.</summary>\n");
        sb.Append("public interface IQueryHandler<TQuery, TResult>\n{\n");
        sb.Append(Indent).Append("Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IQueryHandler.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>A small English pluralizer for repository property names (Order -&gt; Orders, Category -&gt; Categories).</summary>
    private static string Pluralize(string name)
    {
        if (name.Length == 0)
            return name;
        if (name.EndsWith("s", StringComparison.Ordinal) || name.EndsWith("x", StringComparison.Ordinal)
            || name.EndsWith("z", StringComparison.Ordinal) || name.EndsWith("ch", StringComparison.Ordinal)
            || name.EndsWith("sh", StringComparison.Ordinal))
            return name + "es";
        if (name.Length >= 2 && char.ToLowerInvariant(name[^1]) == 'y'
            && "aeiou".IndexOf(char.ToLowerInvariant(name[^2])) < 0)
            return name[..^1] + "ies";
        return name + "s";
    }

    // ----------------------------------------------------------------------
    // Value objects
    // ----------------------------------------------------------------------

    private EmittedFile EmitValueObject(
        ValueObjectDecl vo,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var translator = new CSharpExpressionTranslator(index, vo.Members, enumMemberToType, SpecBodiesFor(vo.Name, index), context: ContextOf(ns));

        var ctorParams = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, vo.Doc, "");
        sb.Append("public sealed class ").Append(vo.Name).Append(" : ValueObject\n");
        sb.Append("{\n");

        // Properties (one per member, in declaration order).
        foreach (var m in vo.Members)
        {
            if (MemberAnalysis.IsDerived(m, memberNames))
                continue; // derived emitted later as computed property
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Constructor.
        sb.Append('\n');
        WriteConstructor(sb, vo.Name, ctorParams, vo.Invariants, memberNames, translator, typeMapper, enumMemberToType, index);

        // Derived (computed) properties after the constructor.
        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(body).Append(";\n");
        }

        // A quantity (R9.2) gets explicit, unit-checked arithmetic instead of the
        // demand-driven scalar/additive heuristic (which is skipped for quantities to
        // avoid emitting a duplicate operator).
        if (vo.IsQuantity)
        {
            WriteQuantityOperators(sb, vo, index);
        }
        else
        {
            // Scalar arithmetic operators (v0 codegen rule): emitted only when this
            // value object is actually multiplied by a scalar in a derived expression.
            if (_scalarNeeds.TryGetValue(vo.Name, out var scalarTypes))
            {
                var numericFields = NumericFields(vo);
                if (numericFields.Count > 0)
                    WriteScalarOperators(sb, vo, numericFields, scalarTypes, typeMapper);
            }

            // Additive operator for value objects that are summed (e.g. lines.sum(l => l.subtotal)).
            if (_additiveNeeds.Contains(vo.Name))
            {
                var numericFields = NumericFields(vo);
                if (numericFields.Count > 0)
                    WriteAdditiveOperator(sb, vo, numericFields);
            }
        }

        // Structural value equality: the components are the non-derived fields.
        WriteEqualityComponents(sb, ctorParams);

        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{vo.Name}.cs",
            Assemble(ns, sb.ToString(), UsesLinq(vo.Members, vo.Invariants) || SpecBodiesUseLinq(vo.Name, index)));
    }

    /// <summary>
    /// Emits the <c>GetEqualityComponents()</c> override that drives the
    /// <see cref="ValueObject"/> base's structural equality: each non-derived field,
    /// in declaration order.
    /// </summary>
    private void WriteEqualityComponents(StringBuilder sb, IReadOnlyList<Member> members)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("protected override IEnumerable<object?> GetEqualityComponents()\n");
        sb.Append(Indent).Append("{\n");
        if (members.Count == 0)
        {
            // No fields => no components; `yield break;` keeps this a valid iterator.
            sb.Append(Indent).Append(Indent).Append("yield break;\n");
        }
        else
        {
            foreach (var m in members)
            {
                var prop = CSharpNaming.ToPascalCase(m.Name);
                // Collections must compare by element, not by reference: wrap them in
                // the base's structural helpers (ordered for lists, unordered for sets/maps).
                var component =
                    CSharpTypeMapper.IsList(m.Type) ? $"Ordered({prop})"
                    : CSharpTypeMapper.IsSet(m.Type) || CSharpTypeMapper.IsMap(m.Type) ? $"Unordered({prop})"
                    : prop;
                sb.Append(Indent).Append(Indent).Append("yield return ").Append(component).Append(";\n");
            }
        }
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Generates scalar multiply operators so value-object * scalar arithmetic
    /// compiles (e.g. <c>Money * int</c> for <c>subtotal = unitPrice * quantity</c>).
    /// Deliberate v0 codegen rule: scale every numeric field and carry the rest
    /// unchanged. The product is cast back to a narrower field type when needed
    /// (e.g. an <c>int</c> field multiplied by a <c>decimal</c> scalar).
    /// </summary>
    private void WriteScalarOperators(
        StringBuilder sb,
        ValueObjectDecl vo,
        IReadOnlyList<Member> numericFields,
        IReadOnlySet<string> scalarTypes,
        CSharpTypeMapper typeMapper)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Constructor args must be passed in the SAME order the constructor declares
        // its parameters (OrderCtorParams moves defaulted/optional fields last).
        var ctorMembers = OrderCtorParams(vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames))).ToList();
        var numericNames = new HashSet<string>(numericFields.Select(m => m.Name), StringComparer.Ordinal);

        // Deterministic order; only the scalar types actually used.
        foreach (var scalar in scalarTypes.OrderBy(s => s, StringComparer.Ordinal))
        {
            var args = string.Join(", ", ctorMembers.Select(m =>
            {
                var prop = $"left.{CSharpNaming.ToPascalCase(m.Name)}";
                if (!numericNames.Contains(m.Name))
                    return prop;
                var product = $"{prop} * right";
                // int field * decimal scalar yields decimal -> cast back to int.
                return typeMapper.Map(m.Type) == "int" && scalar == "decimal"
                    ? $"(int)({product})"
                    : product;
            }));

            sb.Append('\n').Append(Indent)
              .Append("public static ").Append(vo.Name).Append(" operator *(")
              .Append(vo.Name).Append(" left, ").Append(scalar).Append(" right) => new ")
              .Append(vo.Name).Append('(').Append(args).Append(");\n");
        }
    }

    /// <summary>
    /// Emits a quantity's unit-checked arithmetic (R9.2): <c>+</c>/<c>-</c> require the
    /// same unit (throwing <c>DomainInvariantViolationException</c> on a mismatch, since
    /// units are runtime enum values) and scalar <c>*</c>/<c>/</c> by <c>int</c>/<c>decimal</c>
    /// scale the amount and preserve the unit. Operators are emitted in a fixed order
    /// for byte-identical determinism.
    /// </summary>
    private void WriteQuantityOperators(StringBuilder sb, ValueObjectDecl vo, ModelIndex index)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var nonDerived = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var amount = nonDerived.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        var unit = nonDerived.FirstOrDefault(m => index.Classify(m.Type.Name) == TypeKind.Enum && !m.Type.IsOptional);
        if (amount is null || unit is null)
            return; // a malformed quantity is already a validation error; emit no operators

        var name = vo.Name;
        var amtProp = CSharpNaming.ToPascalCase(amount.Name);
        var unitProp = CSharpNaming.ToPascalCase(unit.Name);
        var ctorOrder = OrderCtorParams(nonDerived).ToList();

        // Build `new Name(...)` with the amount/unit values placed in constructor order.
        string Construct(string amtExpr, string unitExpr) =>
            $"new {name}(" + string.Join(", ", ctorOrder.Select(m =>
                ReferenceEquals(m, amount) ? amtExpr
                : ReferenceEquals(m, unit) ? unitExpr
                : "default!")) + ")";

        foreach (var (op, verb) in new[] { ("+", "add"), ("-", "subtract") })
        {
            sb.Append('\n').Append(Indent)
              .Append("public static ").Append(name).Append(" operator ").Append(op).Append('(')
              .Append(name).Append(" left, ").Append(name).Append(" right)\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("if (left.").Append(unitProp)
              .Append(" != right.").Append(unitProp).Append(")\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(name).Append("),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
              .Append("rule: \"cannot ").Append(verb).Append(" quantities of different units\");\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"left.{amtProp} {op} right.{amtProp}", $"left.{unitProp}")).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        // The amount is always Decimal, so scalar */÷ by int or decimal stays exact.
        foreach (var op in new[] { "*", "/" })
        foreach (var scalar in new[] { "int", "decimal" })
            sb.Append('\n').Append(Indent)
              .Append("public static ").Append(name).Append(" operator ").Append(op).Append('(')
              .Append(name).Append(" left, ").Append(scalar).Append(" right) => ")
              .Append(Construct($"left.{amtProp} {op} right", $"left.{unitProp}")).Append(";\n");
    }

    private static IReadOnlyList<Member> NumericFields(ValueObjectDecl vo)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        return vo.Members
            .Where(m => !MemberAnalysis.IsDerived(m, memberNames))
            .Where(m => m.Type.Name is "Int" or "Decimal")
            .ToList();
    }

    /// <summary>
    /// Generates a structural <c>+</c> operator so a value object can be folded by
    /// <c>sum</c> (e.g. <c>lines.sum(l =&gt; l.subtotal)</c> over <c>Money</c>). Adds
    /// every numeric field pairwise and carries the rest from the left operand,
    /// mirroring the scalar-operator heuristic.
    /// </summary>
    private void WriteAdditiveOperator(StringBuilder sb, ValueObjectDecl vo, IReadOnlyList<Member> numericFields)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Same ordering rule as the constructor (defaulted/optional fields last).
        var ctorMembers = OrderCtorParams(vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames))).ToList();
        var numericNames = new HashSet<string>(numericFields.Select(m => m.Name), StringComparer.Ordinal);

        var args = string.Join(", ", ctorMembers.Select(m =>
        {
            var prop = CSharpNaming.ToPascalCase(m.Name);
            return numericNames.Contains(m.Name)
                ? $"left.{prop} + right.{prop}"
                : $"left.{prop}";
        }));

        sb.Append('\n').Append(Indent)
          .Append("public static ").Append(vo.Name).Append(" operator +(")
          .Append(vo.Name).Append(" left, ").Append(vo.Name).Append(" right) => new ")
          .Append(vo.Name).Append('(').Append(args).Append(");\n");
    }

    /// <summary>
    /// Scans every member initializer for a value-object <c>sum</c> selector (e.g.
    /// <c>lines.sum(l =&gt; l.subtotal)</c> producing a <c>Money</c>) and records the
    /// value-object types that therefore need an additive operator.
    /// </summary>
    private static IReadOnlySet<string> BuildAdditiveOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var resolver = new TypeResolver(index);
        var needs = new HashSet<string>(StringComparer.Ordinal);

        foreach (var ctx in model.Contexts)
        foreach (var type in AllTypeDecls(ctx))
        {
            IReadOnlyList<Member>? members = type switch
            {
                ValueObjectDecl v => v.Members,
                EntityDecl e => e.Members,
                EventDecl ev => ev.Members,
                _ => null
            };
            if (members is null) continue;

            var scope = TypeScope.FromMembers(members);
            foreach (var m in members)
                if (m.Initializer is not null)
                    ScanForValueObjectSum(m.Initializer, scope, resolver, needs);

            // Command bodies and state-rule guards can also fold value objects with sum.
            if (type is EntityDecl entity)
            {
                foreach (var cmd in entity.Commands)
                {
                    var cmdScope = cmd.Parameters.Aggregate(scope, (s, p) => s.With(p.Name, p.Type));
                    foreach (var stmt in cmd.Body)
                    {
                        if (stmt is RequiresClause req) ScanForValueObjectSum(req.Condition, cmdScope, resolver, needs);
                        else if (stmt is Transition tr) ScanForValueObjectSum(tr.Value, cmdScope, resolver, needs);
                        else if (stmt is EmitClause em)
                            foreach (var arg in em.Args) ScanForValueObjectSum(arg.Value, cmdScope, resolver, needs);
                    }
                }
                foreach (var factory in entity.Factories)
                {
                    var factScope = factory.Parameters.Aggregate(scope, (s, p) => s.With(p.Name, p.Type));
                    foreach (var stmt in factory.Body)
                    {
                        if (stmt is RequiresClause req) ScanForValueObjectSum(req.Condition, factScope, resolver, needs);
                        else if (stmt is Initialization ini) ScanForValueObjectSum(ini.Value, factScope, resolver, needs);
                        else if (stmt is EmitClause em)
                            foreach (var arg in em.Args) ScanForValueObjectSum(arg.Value, factScope, resolver, needs);
                    }
                }
                foreach (var guard in StateGuards(entity))
                    ScanForValueObjectSum(guard, scope, resolver, needs);
            }
        }

        // Service operation bodies can also fold value objects with sum.
        foreach (var ctx in model.Contexts)
        foreach (var svc in ctx.Services)
        foreach (var op in svc.Operations)
            if (op.Body is not null)
            {
                var scope = new TypeScope(op.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
                ScanForValueObjectSum(op.Body, scope, resolver, needs);
            }

        // Spec conditions (rendered over the target type's members) can fold value objects too.
        foreach (var spec in AllSpecs(model))
            ScanForValueObjectSum(spec.Condition, TypeScope.FromMembers(SpecTargetMembers(spec.TargetType, index)), resolver, needs);

        return needs;
    }

    private static void ScanForValueObjectSum(Expr expr, TypeScope scope, TypeResolver resolver, HashSet<string> needs)
    {
        switch (expr)
        {
            case CallExpr call:
                if (call.Method == "sum" && call.Args is [LambdaExpr lambda])
                {
                    var element = TypeResolver.ElementOf(resolver.Infer(call.Target, scope));
                    if (element is not null)
                    {
                        var selector = resolver.Infer(lambda.Body, scope.With(lambda.Parameter, element));
                        if (resolver.IsValueLike(selector))
                            needs.Add(selector!.Name);
                    }
                }
                ScanForValueObjectSum(call.Target, scope, resolver, needs);
                foreach (var arg in call.Args) ScanForValueObjectSum(arg, scope, resolver, needs);
                break;
            case LambdaExpr l: ScanForValueObjectSum(l.Body, scope, resolver, needs); break;
            case BinaryExpr b:
                ScanForValueObjectSum(b.Left, scope, resolver, needs);
                ScanForValueObjectSum(b.Right, scope, resolver, needs);
                break;
            case UnaryExpr u: ScanForValueObjectSum(u.Operand, scope, resolver, needs); break;
            case MemberAccessExpr ma: ScanForValueObjectSum(ma.Target, scope, resolver, needs); break;
            case ConditionalExpr c:
                ScanForValueObjectSum(c.Condition, scope, resolver, needs);
                ScanForValueObjectSum(c.Then, scope, resolver, needs);
                ScanForValueObjectSum(c.Else, scope, resolver, needs);
                break;
            case GuardExpr g:
                ScanForValueObjectSum(g.Body, scope, resolver, needs);
                ScanForValueObjectSum(g.Condition, scope, resolver, needs);
                break;
            case MatchExpr mt: ScanForValueObjectSum(mt.Target, scope, resolver, needs); break;
        }
    }

    /// <summary>
    /// Scans every derived member initializer in the model for
    /// <c>value-object * scalar</c> multiplications and records, per value-object
    /// type, which scalar C# types ("int"/"decimal") it is multiplied by. Only
    /// those operators are generated, so we never emit spurious (or non-compiling)
    /// operators on value objects that are never multiplied.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var needs = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        foreach (var ctx in model.Contexts)
        foreach (var type in AllTypeDecls(ctx))
        {
            IReadOnlyList<Member>? members = type switch
            {
                ValueObjectDecl v => v.Members,
                EntityDecl e => e.Members,
                EventDecl ev => ev.Members,
                _ => null
            };
            if (members is null) continue;

            var memberTypes = members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
            foreach (var m in members)
                if (m.Initializer is not null)
                    ScanForScalarMul(m.Initializer, memberTypes, index, needs);

            // Command bodies and state-rule guards can also use value-object arithmetic.
            if (type is EntityDecl entity)
            {
                foreach (var (expr, scope) in CommandExpressions(entity, memberTypes))
                    ScanForScalarMul(expr, scope, index, needs);
                foreach (var (expr, scope) in FactoryExpressions(entity, memberTypes))
                    ScanForScalarMul(expr, scope, index, needs);
                foreach (var guard in StateGuards(entity))
                    ScanForScalarMul(guard, memberTypes, index, needs);
            }
        }

        // Service operation bodies can use value-object * scalar arithmetic.
        foreach (var ctx in model.Contexts)
        foreach (var svc in ctx.Services)
        foreach (var op in svc.Operations)
            if (op.Body is not null)
            {
                var scope = op.Parameters.ToDictionary(p => p.Name, p => p.Type, StringComparer.Ordinal);
                ScanForScalarMul(op.Body, scope, index, needs);
            }

        // Spec conditions over their target type's members can use value-object arithmetic.
        foreach (var spec in AllSpecs(model))
        {
            var scope = SpecTargetMembers(spec.TargetType, index).ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
            ScanForScalarMul(spec.Condition, scope, index, needs);
        }

        return needs.ToDictionary(kv => kv.Key, kv => (IReadOnlySet<string>)kv.Value, StringComparer.Ordinal);
    }

    /// <summary>Every spec declared in the model (context- and aggregate-scoped).</summary>
    private static IEnumerable<SpecDecl> AllSpecs(KoineModel model)
    {
        foreach (var ctx in model.Contexts)
        {
            foreach (var s in ctx.Specs) yield return s;
            foreach (var t in ctx.Types)
                if (t is AggregateDecl agg)
                    foreach (var s in agg.Specs) yield return s;
        }
    }

    /// <summary>
    /// Every expression appearing in an entity's commands (requires conditions and
    /// transition values), paired with a member-type map extended by that command's
    /// parameters — for the operator-need scans.
    /// </summary>
    /// <summary>The guard expressions of an entity's state-machine rules.</summary>
    private static IEnumerable<Expr> StateGuards(EntityDecl entity) =>
        entity.States.SelectMany(s => s.Rules).Where(r => r.Guard is not null).Select(r => r.Guard!);

    private static IEnumerable<(Expr Expr, IReadOnlyDictionary<string, TypeRef> Scope)> CommandExpressions(
        EntityDecl entity, IReadOnlyDictionary<string, TypeRef> memberTypes)
    {
        foreach (var cmd in entity.Commands)
        {
            var scope = new Dictionary<string, TypeRef>(memberTypes, StringComparer.Ordinal);
            foreach (var p in cmd.Parameters) scope[p.Name] = p.Type;

            foreach (var stmt in cmd.Body)
            {
                if (stmt is RequiresClause req) yield return (req.Condition, scope);
                else if (stmt is Transition tr) yield return (tr.Value, scope);
                else if (stmt is EmitClause em)
                    foreach (var arg in em.Args) yield return (arg.Value, scope);
            }
        }
    }

    /// <summary>
    /// Every expression in an entity's factories (requires conditions, initialization
    /// values, and emit payloads), paired with a member-type map extended by that
    /// factory's parameters — for the operator-need scans.
    /// </summary>
    private static IEnumerable<(Expr Expr, IReadOnlyDictionary<string, TypeRef> Scope)> FactoryExpressions(
        EntityDecl entity, IReadOnlyDictionary<string, TypeRef> memberTypes)
    {
        foreach (var factory in entity.Factories)
        {
            var scope = new Dictionary<string, TypeRef>(memberTypes, StringComparer.Ordinal);
            foreach (var p in factory.Parameters) scope[p.Name] = p.Type;

            foreach (var stmt in factory.Body)
            {
                if (stmt is RequiresClause req) yield return (req.Condition, scope);
                else if (stmt is Initialization ini) yield return (ini.Value, scope);
                else if (stmt is EmitClause em)
                    foreach (var arg in em.Args) yield return (arg.Value, scope);
            }
        }
    }

    private static void ScanForScalarMul(
        Expr expr,
        IReadOnlyDictionary<string, TypeRef> memberTypes,
        ModelIndex index,
        Dictionary<string, HashSet<string>> needs)
    {
        switch (expr)
        {
            case BinaryExpr b:
                if (b.Op == BinaryOp.Mul)
                {
                    var (lValue, lScalar) = InferOperand(b.Left, memberTypes, index);
                    var (rValue, rScalar) = InferOperand(b.Right, memberTypes, index);
                    if (lValue is not null && rScalar is not null) Record(needs, lValue, rScalar);
                    if (rValue is not null && lScalar is not null) Record(needs, rValue, lScalar);
                }
                ScanForScalarMul(b.Left, memberTypes, index, needs);
                ScanForScalarMul(b.Right, memberTypes, index, needs);
                break;
            case UnaryExpr u: ScanForScalarMul(u.Operand, memberTypes, index, needs); break;
            case MemberAccessExpr ma: ScanForScalarMul(ma.Target, memberTypes, index, needs); break;
            case CallExpr call:
                ScanForScalarMul(call.Target, memberTypes, index, needs);
                foreach (var arg in call.Args) ScanForScalarMul(arg, memberTypes, index, needs);
                break;
            case LambdaExpr lam: ScanForScalarMul(lam.Body, memberTypes, index, needs); break;
            case ConditionalExpr c:
                ScanForScalarMul(c.Condition, memberTypes, index, needs);
                ScanForScalarMul(c.Then, memberTypes, index, needs);
                ScanForScalarMul(c.Else, memberTypes, index, needs);
                break;
            case MatchExpr mt: ScanForScalarMul(mt.Target, memberTypes, index, needs); break;
            case GuardExpr g:
                ScanForScalarMul(g.Body, memberTypes, index, needs);
                ScanForScalarMul(g.Condition, memberTypes, index, needs);
                break;
        }
    }

    /// <summary>Shallowly infers whether an operand is a value object or a numeric scalar.</summary>
    private static (string? ValueObject, string? Scalar) InferOperand(
        Expr expr, IReadOnlyDictionary<string, TypeRef> memberTypes, ModelIndex index)
    {
        switch (expr)
        {
            case IdentifierExpr id when memberTypes.TryGetValue(id.Name, out var t):
                if (index.Classify(t.Name) == TypeKind.Value) return (t.Name, null);
                if (t.Name == "Int") return (null, "int");
                if (t.Name == "Decimal") return (null, "decimal");
                return (null, null);
            case LiteralExpr lit when lit.Kind == LiteralKind.Int: return (null, "int");
            case LiteralExpr lit when lit.Kind == LiteralKind.Decimal: return (null, "decimal");
            default: return (null, null);
        }
    }

    private static void Record(Dictionary<string, HashSet<string>> needs, string vo, string scalar)
    {
        if (!needs.TryGetValue(vo, out var set))
            needs[vo] = set = new HashSet<string>(StringComparer.Ordinal);
        set.Add(scalar);
    }

    // ----------------------------------------------------------------------
    // Entities + generated ID
    // ----------------------------------------------------------------------

    private void EmitEntityAndId(
        List<EmittedFile> files,
        EntityDecl entity,
        string ns,
        bool isRoot,
        bool isVersioned,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        files.Add(EmitEntity(entity, ns, isRoot, isVersioned, index, typeMapper, enumMemberToType));
        // The entity's ID value object lives in the context BASE namespace (R13.3) — not a
        // module sub-namespace — so any module's types can reference it via one `using`.
        // For a non-module entity the base namespace equals its own, so output is unchanged.
        files.Add(EmitIdValueObject(entity.IdentityName, ContextOf(ns), entity.IdStrategy, entity.IdBackingType));
    }

    private EmittedFile EmitEntity(
        EntityDecl entity,
        string ns,
        bool isRoot,
        bool isVersioned,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        // The translator also resolves the synthetic `id` (the entity's identity) so
        // command/emit expressions can reference it; it renders as the `Id` property.
        var scopeMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();
        var translator = new CSharpExpressionTranslator(index, scopeMembers, enumMemberToType, SpecBodiesFor(entity.Name, index), context: ContextOf(ns));

        var sb = new StringBuilder();

        WriteXmlDoc(sb, entity.Doc, "");
        sb.Append("public sealed class ").Append(entity.Name);
        if (isRoot)
            sb.Append(" : IAggregateRoot");
        sb.Append('\n');
        sb.Append("{\n");

        // Identity property first.
        sb.Append(Indent).Append("public ").Append(entity.IdentityName).Append(" Id { get; }\n");

        // Optimistic-concurrency token on a versioned aggregate's root (R11.4). Get-only
        // but settable at construction by the persistence layer (init); excluded from
        // identity equality, which is by Id alone.
        if (isVersioned)
        {
            sb.Append(Indent).Append("/// <summary>Optimistic-concurrency token, assigned by the persistence layer.</summary>\n");
            sb.Append(Indent).Append("public int Version { get; init; }\n");
        }

        // Non-derived member properties. A field mutated by a command gains a
        // private setter; all others stay get-only.
        var ctorMembers = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var mutated = MutatedFields(entity);

        foreach (var m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name))
              .Append(mutated.Contains(m.Name) ? " { get; private set; }" : " { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Constructor: identity param first, then members.
        sb.Append('\n');
        WriteEntityConstructor(sb, entity, ctorMembers, memberNames, translator, typeMapper, enumMemberToType, index);

        // Derived (computed) properties.
        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(body).Append(";\n");
        }

        // Domain-event recording (when any command or factory emits events).
        var hasEmits = EmitsEvents(entity);
        if (hasEmits)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("private readonly List<IDomainEvent> _domainEvents = new();\n");
            sb.Append(Indent).Append("public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents;\n");
            sb.Append(Indent).Append("public void ClearDomainEvents() => _domainEvents.Clear();\n");
        }

        // Commands: intention-revealing state-changing methods.
        foreach (var cmd in entity.Commands)
            WriteCommand(sb, entity, cmd, translator, typeMapper, index);

        // Factories: intention-revealing creation through validated static methods.
        foreach (var factory in entity.Factories)
            WriteFactory(sb, entity, factory, ctorMembers, memberNames, translator, typeMapper, index);

        // Identity-based equality.
        sb.Append('\n');
        sb.Append(Indent).Append("public bool Equals(").Append(entity.Name)
          .Append("? other) => other is not null && Id.Equals(other.Id);\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj) => Equals(obj as ")
          .Append(entity.Name).Append(");\n");
        sb.Append(Indent).Append("public override int GetHashCode() => Id.GetHashCode();\n");

        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{entity.Name}.cs",
            Assemble(ns, sb.ToString(), EntityUsesLinq(entity) || SpecBodiesUseLinq(entity.Name, index)));
    }

    /// <summary>
    /// Emits a strongly-typed identity value object per its strategy (R11.1):
    /// <list type="bullet">
    /// <item><b>Guid</b> (default): wraps a <c>Guid</c> with a client-side <c>New()</c>.</item>
    /// <item><b>Sequence</b>: wraps a store-assigned <c>long</c>; no <c>New()</c>.</item>
    /// <item><b>Natural(String)</b>: wraps a non-blank <c>string</c>, validated at
    /// construction; no <c>New()</c>. <b>Natural(Int)</b> wraps an <c>int</c>.</item>
    /// </list>
    /// All strategies have value equality on the wrapped <c>Value</c>.
    /// </summary>
    private EmittedFile EmitIdValueObject(
        string idName, string ns,
        IdentityStrategy strategy = IdentityStrategy.Guid, string? backing = null)
    {
        var backingType = strategy switch
        {
            IdentityStrategy.Sequence => "long",
            IdentityStrategy.Natural => backing == "Int" ? "int" : "string",
            _ => "Guid"
        };
        var validates = strategy == IdentityStrategy.Natural && backingType == "string";

        var sb = new StringBuilder();

        sb.Append("/// <summary>A strongly-typed identity value object.</summary>\n");
        sb.Append("public sealed class ").Append(idName).Append(" : ValueObject\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public ").Append(backingType).Append(" Value { get; }\n\n");

        if (validates)
        {
            // A natural string key cannot be blank — it is the aggregate's real-world identity.
            sb.Append(Indent).Append("public ").Append(idName).Append("(string value)\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("if (string.IsNullOrWhiteSpace(value))\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(idName).Append("),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("rule: \"identity value cannot be blank\");\n");
            sb.Append(Indent).Append(Indent).Append("Value = value;\n");
            sb.Append(Indent).Append("}\n\n");
        }
        else
        {
            sb.Append(Indent).Append("public ").Append(idName).Append('(').Append(backingType)
              .Append(" value) => Value = value;\n\n");
        }

        // Only a Guid identity is generated client-side; sequence/natural keys are
        // supplied by the store or the caller respectively.
        if (strategy == IdentityStrategy.Guid)
            sb.Append(Indent).Append("public static ").Append(idName).Append(" New() => new(Guid.NewGuid());\n\n");

        sb.Append(Indent).Append("protected override IEnumerable<object?> GetEqualityComponents()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("yield return Value;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{idName}.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    // ----------------------------------------------------------------------
    // Enums
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits an enum as a self-contained "smart enum": a sealed class with one
    /// static readonly instance per member, <c>Name</c>/<c>Value</c>, an <c>All</c>
    /// list, <c>FromName</c>/<c>FromValue</c> lookups, value equality and
    /// <c>==</c>/<c>!=</c>. No external dependency; members are referenced exactly
    /// like enum members (<c>OrderStatus.Cancelled</c>).
    /// </summary>
    private EmittedFile EmitEnum(
        EnumDecl @enum,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var name = @enum.Name;
        var sig = @enum.Signature;
        var hasData = @enum.HasAssociatedData;
        var sb = new StringBuilder();

        // Associated-data args are literal expressions; reuse the translator so string
        // escaping and the decimal `m` suffix match the rest of the emitted code.
        var translator = new CSharpExpressionTranslator(index, Array.Empty<Member>(), enumMemberToType);

        WriteXmlDoc(sb, @enum.Doc ?? "A type-safe smart enum: static instances with value equality.", "");
        sb.Append("public sealed class ").Append(name).Append(" : IEquatable<").Append(name).Append(">\n{\n");

        // One static readonly instance per member, in declaration order. When the enum
        // has a signature, each member also passes its associated-data values.
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            var member = @enum.Members[i];
            sb.Append(Indent).Append("public static readonly ").Append(name).Append(' ')
              .Append(member.Name).Append(" = new(\"").Append(member.Name).Append("\", ").Append(i);
            if (hasData)
                // Associated values are literals of a primitive field type (String/Int/
                // Decimal/Bool), validated upstream — render them directly.
                for (var j = 0; j < sig.Count && j < member.Args.Count; j++)
                    sb.Append(", ").Append(translator.TranslateTopLevel(
                        member.Args[j], CSharpExpressionTranslator.NameMode.Property));
            sb.Append(");\n");
        }

        sb.Append('\n');
        sb.Append(Indent).Append("public string Name { get; }\n");
        sb.Append(Indent).Append("public int Value { get; }\n");
        // Associated-data properties, in signature order.
        foreach (var p in sig)
            sb.Append(Indent).Append("public ").Append(typeMapper.Map(p.Type)).Append(' ')
              .Append(CSharpNaming.ToPascalCase(p.Name)).Append(" { get; }\n");
        sb.Append('\n');

        var ctorParams = "string name, int value";
        if (hasData)
            ctorParams += ", " + string.Join(", ", sig.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
        sb.Append(Indent).Append("private ").Append(name).Append('(').Append(ctorParams).Append(")\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("Name = name;\n");
        sb.Append(Indent).Append(Indent).Append("Value = value;\n");
        foreach (var p in sig)
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToPascalCase(p.Name)).Append(" = ")
              .Append(CSharpNaming.ToCamelCase(p.Name)).Append(";\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("public static IReadOnlyList<").Append(name).Append("> All { get; } = new[] { ")
          .Append(string.Join(", ", @enum.MemberNames)).Append(" };\n\n");

        sb.Append(Indent).Append("public static ").Append(name).Append(" FromName(string name) =>\n");
        sb.Append(Indent).Append(Indent).Append("All.FirstOrDefault(e => e.Name == name)\n");
        sb.Append(Indent).Append(Indent).Append("?? throw new ArgumentOutOfRangeException(nameof(name), $\"No ")
          .Append(name).Append(" with name '{name}'.\");\n\n");

        sb.Append(Indent).Append("public static ").Append(name).Append(" FromValue(int value) =>\n");
        sb.Append(Indent).Append(Indent).Append("All.FirstOrDefault(e => e.Value == value)\n");
        sb.Append(Indent).Append(Indent).Append("?? throw new ArgumentOutOfRangeException(nameof(value), $\"No ")
          .Append(name).Append(" with value {value}.\");\n\n");

        sb.Append(Indent).Append("public override string ToString() => Name;\n");
        sb.Append(Indent).Append("public bool Equals(").Append(name).Append("? other) => other is not null && Value == other.Value;\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj) => Equals(obj as ").Append(name).Append(");\n");
        sb.Append(Indent).Append("public override int GetHashCode() => Value;\n");
        sb.Append(Indent).Append("public static bool operator ==(").Append(name).Append("? left, ").Append(name)
          .Append("? right) => left is null ? right is null : left.Equals(right);\n");
        sb.Append(Indent).Append("public static bool operator !=(").Append(name).Append("? left, ").Append(name)
          .Append("? right) => !(left == right);\n");

        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{name}.cs", Assemble(ns, sb.ToString(), usesLinq: true));
    }

    // ----------------------------------------------------------------------
    // Domain events
    // ----------------------------------------------------------------------

    private static bool HasEvents(KoineModel model) =>
        model.Contexts.SelectMany(AllTypeDecls).Any(t => t is EventDecl);

    /// <summary>
    /// True when any field or command/factory parameter anywhere in the model
    /// references a <c>Range&lt;T&gt;</c>, gating emission of the runtime range type.
    /// </summary>
    private static bool UsesRange(KoineModel model)
    {
        foreach (var ctx in model.Contexts)
        foreach (var t in AllTypeDecls(ctx))
        {
            IReadOnlyList<Member>? members = t switch
            {
                ValueObjectDecl v => v.Members,
                EntityDecl e => e.Members,
                EventDecl ev => ev.Members,
                _ => null
            };
            if (members is not null && members.Any(m => TypeRefMentions(m.Type, ModelIndex.RangeTypeName)))
                return true;

            if (t is EntityDecl en)
            {
                var paramTypes = en.Commands.SelectMany(c => c.Parameters)
                    .Concat(en.Factories.SelectMany(f => f.Parameters))
                    .Select(p => p.Type);
                if (paramTypes.Any(pt => TypeRefMentions(pt, ModelIndex.RangeTypeName)))
                    return true;
            }
        }
        return false;
    }

    /// <summary>
    /// True when the model emits at least one value object: an explicit
    /// <c>value</c> type, or an entity (whose strongly-typed ID is a value object).
    /// Gates emission of the <see cref="ValueObject"/> base class.
    /// </summary>
    private static bool NeedsValueObjects(KoineModel model) =>
        model.Contexts.SelectMany(AllTypeDecls).Any(t => t is ValueObjectDecl or EntityDecl);

    /// <summary>
    /// Emits a domain event as an immutable <c>sealed record</c> implementing
    /// <c>IDomainEvent</c>, with get-only fields, value equality, and an
    /// <c>OccurredOn</c> timestamp defaulted at construction.
    /// </summary>
    private EmittedFile EmitEvent(
        EventDecl ev,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var translator = new CSharpExpressionTranslator(index, ev.Members, enumMemberToType, context: ContextOf(ns));
        var ctorMembers = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = ev.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, ev.Doc, "");
        sb.Append("public sealed record ").Append(ev.Name).Append(" : IDomainEvent\n{\n");

        foreach (var m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Occurrence metadata, defaulted at construction (part of value equality).
        sb.Append(Indent).Append("public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;\n");

        sb.Append('\n');
        WriteConstructor(sb, ev.Name, ctorMembers, Array.Empty<Invariant>(), memberNames, translator, typeMapper, enumMemberToType, index);

        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(body).Append(";\n");
        }

        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/{ev.Name}.cs",
            Assemble(ns, sb.ToString(), UsesLinq(ev.Members, Array.Empty<Invariant>())));
    }

    // ----------------------------------------------------------------------
    // R10 — specifications, services, policies
    // ----------------------------------------------------------------------

    /// <summary>The spec name -&gt; body map for a target type (for inlining references).</summary>
    private static IReadOnlyDictionary<string, Expr> SpecBodiesFor(string typeName, ModelIndex index)
    {
        var specs = index.SpecsFor(typeName);
        if (specs.Count == 0)
            return EmptySpecBodies;
        return specs.ToDictionary(kv => kv.Key, kv => kv.Value.Condition, StringComparer.Ordinal);
    }

    private static readonly IReadOnlyDictionary<string, Expr> EmptySpecBodies = new Dictionary<string, Expr>();

    /// <summary>
    /// True when any spec on <paramref name="typeName"/> uses a LINQ-backed op, so a file
    /// that inlines such a spec into an invariant/requires imports <c>System.Linq</c>.
    /// Every spec is checked individually, so composition is covered transitively.
    /// </summary>
    private static bool SpecBodiesUseLinq(string typeName, ModelIndex index) =>
        index.SpecsFor(typeName).Values.Any(s => ExprUsesLinq(s.Condition));

    /// <summary>The members in scope for a spec on <paramref name="typeName"/> (entities add a synthetic <c>id</c>), resolved in <paramref name="context"/> when shared across contexts.</summary>
    private static IReadOnlyList<Member> SpecTargetMembers(string typeName, ModelIndex index, string? context = null)
    {
        if (!(context is not null && index.TryGetDeclIn(context, typeName, out var decl)) && !index.TryGetDecl(typeName, out decl))
            return Array.Empty<Member>();
        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }

    /// <summary>
    /// Emits a context's reusable specifications as static boolean predicates in a
    /// <c>&lt;Context&gt;Specifications</c> class. Each predicate takes its target type as
    /// the parameter <c>x</c>; spec-to-spec references inline (R10.1).
    /// </summary>
    private EmittedFile EmitSpecifications(
        string ns,
        IReadOnlyList<SpecDecl> specs,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "Reusable domain specifications (predicates) for this context.", "");
        sb.Append("public static class ").Append(ns).Append("Specifications\n{\n");

        var first = true;
        var usesLinq = false;
        foreach (var spec in specs)
        {
            var members = SpecTargetMembers(spec.TargetType, index, ContextOf(ns));
            var translator = new CSharpExpressionTranslator(
                index, members, enumMemberToType, SpecBodiesFor(spec.TargetType, index), memberReceiver: "x", context: ContextOf(ns));
            var body = translator.TranslateTopLevel(spec.Condition, CSharpExpressionTranslator.NameMode.Property);

            if (!first) sb.Append('\n');
            first = false;
            WriteXmlDoc(sb, spec.Doc, Indent);
            sb.Append(Indent).Append("public static bool ").Append(CSharpNaming.ToPascalCase(spec.Name))
              .Append('(').Append(spec.TargetType).Append(" x) => ").Append(body).Append(";\n");
            usesLinq |= ExprUsesLinq(spec.Condition);
        }

        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/{ns}Specifications.cs", Assemble(ns, sb.ToString(), usesLinq));
    }

    /// <summary>
    /// Emits a domain service as a stateless class. Pure operations become
    /// expression-bodied methods; a bodyless operation is an <c>abstract</c> seam
    /// (which makes the whole class <c>abstract</c>).
    /// </summary>
    private EmittedFile EmitService(
        ServiceDecl svc,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var isAbstract = svc.Operations.Any(o => o.Body is null);
        var sb = new StringBuilder();

        WriteXmlDoc(sb, svc.Doc ?? "A stateless domain service.", "");
        sb.Append("public ").Append(isAbstract ? "abstract" : "sealed").Append(" class ").Append(svc.Name).Append("\n{\n");

        var translator = new CSharpExpressionTranslator(index, Array.Empty<Member>(), enumMemberToType, context: ContextOf(ns));
        var first = true;
        foreach (var op in svc.Operations)
        {
            if (!first) sb.Append('\n');
            first = false;
            WriteXmlDoc(sb, op.Doc, Indent);

            var ret = typeMapper.Map(op.ReturnType);
            var paramList = string.Join(", ", op.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
            var method = CSharpNaming.ToPascalCase(op.Name);

            if (op.Body is null)
            {
                sb.Append(Indent).Append("public abstract ").Append(ret).Append(' ')
                  .Append(method).Append('(').Append(paramList).Append(");\n");
            }
            else
            {
                foreach (var p in op.Parameters) translator.PushLocal(p.Name, p.Type);
                var expectedEnum = index.Classify(op.ReturnType.Name) == TypeKind.Enum ? op.ReturnType.Name : null;
                var body = translator.TranslateTopLevel(op.Body, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
                foreach (var p in op.Parameters) translator.PopLocal(p.Name);

                sb.Append(Indent).Append("public ").Append(ret).Append(' ')
                  .Append(method).Append('(').Append(paramList).Append(") => ").Append(body).Append(";\n");
            }
        }

        sb.Append("}\n");
        var usesLinq = svc.Operations.Any(o => o.Body is not null && ExprUsesLinq(o.Body));
        return new EmittedFile($"{FolderFor(ns)}/{svc.Name}.cs", Assemble(ns, sb.ToString(), usesLinq));
    }

    /// <summary>
    /// Emits a policy as a handler seam: an <c>I&lt;Name&gt;Policy</c> interface plus an
    /// <c>abstract partial</c> class whose <c>Handle</c> the consumer implements. The
    /// intended cross-aggregate reaction is recorded in a doc comment, never generated
    /// (honoring the no-imperative-logic stance).
    /// </summary>
    private EmittedFile EmitPolicy(
        PolicyDecl policy,
        string ns,
        ModelIndex index,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var policyType = CSharpNaming.ToPascalCase(policy.Name) + "Policy";
        var iface = "I" + policyType;

        // Render the reaction sketch with event fields rooted at the handler param `e`.
        var eventMembers = index.TryGetDecl(policy.EventName, out var ed) && ed is EventDecl ev
            ? ev.Members
            : Array.Empty<Member>();
        var translator = new CSharpExpressionTranslator(index, eventMembers, enumMemberToType, memberReceiver: "e", context: ContextOf(ns));
        var r = policy.Reaction;
        var argText = string.Join(", ", r.Args.Select(a =>
            $"{a.Parameter}: {translator.TranslateTopLevel(a.Value, CSharpExpressionTranslator.NameMode.Property)}"));
        var sketch = $"{r.TargetType}.{r.CommandName}({argText})";

        var sb = new StringBuilder();
        WriteXmlDoc(sb, policy.Doc ?? $"Reacts to {policy.EventName} via {policy.Name}.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");
        sb.Append(Indent).Append("void Handle(").Append(policy.EventName).Append(" e);\n");
        sb.Append("}\n\n");

        sb.Append("/// <summary>\n");
        sb.Append("/// Policy seam: when ").Append(EscapeXml(policy.EventName)).Append(" occurs, the intended reaction is\n");
        sb.Append("/// ").Append(EscapeXml(sketch)).Append(". Koine does not generate the cross-aggregate call\n");
        sb.Append("/// (no imperative logic in the model); implement Handle in a partial to wire it.\n");
        sb.Append("/// </summary>\n");
        sb.Append("public abstract partial class ").Append(policyType).Append(" : ").Append(iface).Append("\n{\n");
        sb.Append(Indent).Append("/// <remarks>Intended reaction: ").Append(EscapeXml(sketch)).Append(".</remarks>\n");
        sb.Append(Indent).Append("public abstract void Handle(").Append(policy.EventName).Append(" e);\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{policyType}.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    // ----------------------------------------------------------------------
    // Constructors + invariants
    // ----------------------------------------------------------------------

    private void WriteConstructor(
        StringBuilder sb,
        string typeName,
        IReadOnlyList<Member> ctorMembers,
        IReadOnlyList<Invariant> invariants,
        ISet<string> memberNames,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType,
        ModelIndex index)
    {
        sb.Append(Indent).Append("public ").Append(typeName).Append('(');
        sb.Append(string.Join(", ", OrderCtorParams(ctorMembers).Select(m => FormatParam(m, typeMapper, translator, index))));
        sb.Append(")\n");
        sb.Append(Indent).Append("{\n");

        WriteEnumDefaultCoalesce(sb, ctorMembers, translator, index);
        WriteInvariantGuards(sb, typeName, invariants, translator);
        if (invariants.Count > 0 && ctorMembers.Count > 0)
            sb.Append('\n');

        foreach (var m in ctorMembers)
            WriteAssignment(sb, m, typeMapper);

        sb.Append(Indent).Append("}\n");
    }

    private void WriteEntityConstructor(
        StringBuilder sb,
        EntityDecl entity,
        IReadOnlyList<Member> ctorMembers,
        ISet<string> memberNames,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType,
        ModelIndex index)
    {
        var allParams = new List<string> { $"{entity.IdentityName} id" };
        allParams.AddRange(OrderCtorParams(ctorMembers).Select(m => FormatParam(m, typeMapper, translator, index)));

        // When the entity declares a factory, construction is funneled through it:
        // the all-args constructor becomes private (callable only by the static
        // factory on the same class). Without a factory, it stays public (R8.2).
        var access = entity.Factories.Count > 0 ? "private" : "public";
        sb.Append(Indent).Append(access).Append(' ').Append(entity.Name).Append('(')
          .Append(string.Join(", ", allParams)).Append(")\n");
        sb.Append(Indent).Append("{\n");

        WriteEnumDefaultCoalesce(sb, ctorMembers, translator, index);
        WriteInvariantGuards(sb, entity.Name, entity.Invariants, translator);
        if (entity.Invariants.Count > 0)
            sb.Append('\n');

        sb.Append(Indent).Append(Indent).Append("Id = id;\n");
        foreach (var m in ctorMembers)
            WriteAssignment(sb, m, typeMapper);

        sb.Append(Indent).Append("}\n");
    }

    private string FormatParam(Member m, CSharpTypeMapper typeMapper, CSharpExpressionTranslator translator, ModelIndex index)
    {
        var csType = typeMapper.Map(m.Type);
        var paramName = CSharpNaming.ToCamelCase(m.Name);
        var param = $"{csType} {paramName}";

        // DEFAULT-valued members keep a C# default value.
        if (m.Initializer is not null)
        {
            // A smart-enum value is NOT a compile-time constant, so an enum-typed
            // default can't be a parameter default; the param becomes nullable and
            // the body coalesces to the real default (see WriteAssignment).
            if (index.Classify(m.Type.Name) == TypeKind.Enum)
            {
                var nullableType = csType.EndsWith('?') ? csType : csType + "?";
                return $"{nullableType} {paramName} = null";
            }

            var def = translator.Translate(m.Initializer, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            param += $" = {def}";
        }
        else if (m.Type.IsOptional)
        {
            // An optional field with no initializer defaults to null (omittable).
            param += " = null";
        }
        return param;
    }

    private void WriteAssignment(StringBuilder sb, Member m, CSharpTypeMapper typeMapper)
    {
        var prop = CSharpNaming.ToPascalCase(m.Name);
        var param = CSharpNaming.ToCamelCase(m.Name);
        sb.Append(Indent).Append(Indent).Append(prop).Append(" = ")
          .Append(CopyExpression(m.Type, param, typeMapper)).Append(";\n");
    }

    /// <summary>
    /// Emits <c>param ??= Enum.Default;</c> for each enum-typed defaulted member, so
    /// the (nullable) parameter holds its real default before invariant guards and
    /// assignments run. A smart-enum value can't be a compile-time parameter default.
    /// </summary>
    private void WriteEnumDefaultCoalesce(StringBuilder sb, IReadOnlyList<Member> ctorMembers,
        CSharpExpressionTranslator translator, ModelIndex index)
    {
        var any = false;
        foreach (var m in ctorMembers)
        {
            if (m.Initializer is null || index.Classify(m.Type.Name) != TypeKind.Enum)
                continue;
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToCamelCase(m.Name))
              .Append(" ??= ").Append(EnumDefaultValue(m, translator, index)).Append(";\n");
            any = true;
        }
        if (any)
            sb.Append('\n');
    }

    /// <summary>The qualified C# default value for an enum-typed defaulted member.</summary>
    private static string EnumDefaultValue(Member m, CSharpExpressionTranslator translator, ModelIndex index) =>
        m.Initializer is IdentifierExpr enumDefault
            ? $"{m.Type.Name}.{enumDefault.Name}"
            : translator.Translate(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, m.Type.Name);

    /// <summary>
    /// The right-hand side that assigns a parameter to its property, defensively
    /// copying mutable collections. An optional collection is copied only when
    /// non-null.
    /// </summary>
    private static string CopyExpression(TypeRef type, string param, CSharpTypeMapper typeMapper)
    {
        string? ctor = null;
        if (CSharpTypeMapper.IsList(type))
            ctor = $"new List<{typeMapper.Map(type.Element ?? ObjectType)}>";
        else if (CSharpTypeMapper.IsSet(type))
            ctor = $"new HashSet<{typeMapper.Map(type.Element ?? ObjectType)}>";
        else if (CSharpTypeMapper.IsMap(type))
            ctor = $"new Dictionary<{typeMapper.Map(type.Element ?? ObjectType)}, {typeMapper.Map(type.Value ?? ObjectType)}>";

        if (ctor is null)
            return param; // scalar: direct assignment

        var copy = $"{ctor}({param})";
        return type.IsOptional ? $"{param} is null ? null : {copy}" : copy;
    }

    private static readonly TypeRef ObjectType = new("object");

    /// <summary>
    /// Orders constructor parameters so those with a C# default value (constant
    /// defaults and optional <c>= null</c> fields) come last, as C# requires.
    /// Within each group declaration order is preserved (stable sort).
    /// </summary>
    private static IEnumerable<Member> OrderCtorParams(IEnumerable<Member> members) =>
        members.OrderBy(m => HasCtorDefault(m) ? 1 : 0);

    private static bool HasCtorDefault(Member m) => m.Initializer is not null || m.Type.IsOptional;

    private void WriteInvariantGuards(
        StringBuilder sb,
        string typeName,
        IReadOnlyList<Invariant> invariants,
        CSharpExpressionTranslator translator,
        CSharpExpressionTranslator.NameMode mode = CSharpExpressionTranslator.NameMode.Parameter)
    {
        var first = true;
        foreach (var inv in invariants)
        {
            if (!first)
                sb.Append('\n');
            first = false;
            WriteGuard(sb, typeName, inv.Condition, inv.Message ?? SynthesizeMessage(inv.Condition), translator, mode);
        }
    }

    /// <summary>
    /// Emits a single throwing guard: <c>if (!(cond)) throw DomainInvariantViolationException(...)</c>.
    /// Shared by constructor invariants (Parameter mode), command <c>requires</c>
    /// preconditions, and post-transition invariant re-checks (Property mode).
    /// </summary>
    private void WriteGuard(
        StringBuilder sb,
        string typeName,
        Expr condition,
        string rule,
        CSharpExpressionTranslator translator,
        CSharpExpressionTranslator.NameMode mode)
    {
        var ruleLiteral = "\"" + rule.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        if (condition is GuardExpr guard)
        {
            var cond = translator.TranslateTopLevel(guard.Condition, mode);
            var body = translator.TranslateTopLevel(guard.Body, mode);
            sb.Append(Indent).Append(Indent)
              .Append("if (").Append(cond).Append(" && !(").Append(body).Append("))\n");
        }
        else if (condition is MatchExpr)
        {
            // raw matches /pat/  ->  if (!Regex.IsMatch(raw, @"pat"))
            var cond = translator.Translate(condition, mode);
            sb.Append(Indent).Append(Indent).Append("if (!").Append(cond).Append(")\n");
        }
        else
        {
            var cond = translator.TranslateTopLevel(condition, mode);
            sb.Append(Indent).Append(Indent).Append("if (!(").Append(cond).Append("))\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("type: nameof(").Append(typeName).Append("),\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("rule: ").Append(ruleLiteral).Append(");\n");
    }

    /// <summary>The member names mutated by at least one command transition (get <c>private set</c>).</summary>
    private static ISet<string> MutatedFields(EntityDecl entity) =>
        new HashSet<string>(
            entity.Commands
                .SelectMany(c => c.Body)
                .OfType<Transition>()
                .Select(t => t.Field),
            StringComparer.Ordinal);

    /// <summary>Emits a command as a public method: preconditions, transitions, then an invariant re-check.</summary>
    private void WriteCommand(
        StringBuilder sb,
        EntityDecl entity,
        CommandDecl cmd,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        ModelIndex index)
    {
        var memberTypes = entity.Members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
        var paramList = string.Join(", ", cmd.Parameters.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));

        sb.Append('\n');
        WriteXmlDoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append("public void ").Append(CSharpNaming.ToPascalCase(cmd.Name))
          .Append('(').Append(paramList).Append(")\n");
        sb.Append(Indent).Append("{\n");

        // Command parameters are locals inside the body (members render as properties).
        foreach (var p in cmd.Parameters) translator.PushLocal(p.Name, p.Type);

        var requires = cmd.Body.OfType<RequiresClause>().ToList();
        var transitions = cmd.Body.OfType<Transition>().ToList();
        var emits = cmd.Body.OfType<EmitClause>().ToList();

        // 1. Preconditions — checked before any mutation.
        var firstGuard = true;
        foreach (var req in requires)
        {
            if (!firstGuard) sb.Append('\n');
            firstGuard = false;
            WriteGuard(sb, entity.Name, req.Condition, req.Message ?? SynthesizeMessage(req.Condition),
                translator, CSharpExpressionTranslator.NameMode.Property);
        }

        // 2. State transitions.
        if (requires.Count > 0 && transitions.Count > 0) sb.Append('\n');
        foreach (var tr in transitions)
        {
            var expectedEnum = memberTypes.TryGetValue(tr.Field, out var ft) && index.Classify(ft.Name) == TypeKind.Enum
                ? ft.Name : null;

            // A state machine on this field guards the (literal) target's reachability.
            if (expectedEnum is not null)
                WriteStateMachineGuard(sb, entity, tr, expectedEnum, translator, index, cmd.Parameters);

            var value = translator.TranslateTopLevel(tr.Value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToPascalCase(tr.Field))
              .Append(" = ").Append(value).Append(";\n");
        }

        // Translate the emit statements while parameters are still in scope (their
        // payloads may reference parameters); they are written AFTER the re-check so
        // an invalid post-state throws before any event is recorded.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index)).ToList();

        // Parameters leave scope BEFORE the re-check: entity invariants reference
        // only entity state, which must render as the just-assigned properties (not
        // a parameter that happens to share a field's name).
        foreach (var p in cmd.Parameters) translator.PopLocal(p.Name);

        // 3. Re-check every entity invariant after the state change.
        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            WriteInvariantGuards(sb, entity.Name, entity.Invariants, translator,
                CSharpExpressionTranslator.NameMode.Property);
        }

        // 4. Record domain events (only reached if preconditions + re-check pass).
        if (emitStatements.Count > 0)
        {
            sb.Append('\n');
            foreach (var stmt in emitStatements)
                sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits a reachability guard for a state-machine-governed transition with a
    /// literal target: the current state must be a source that can reach the target
    /// (optionally satisfying that rule's guard), else throw.
    /// </summary>
    private void WriteStateMachineGuard(
        StringBuilder sb, EntityDecl entity, Transition tr, string enumType,
        CSharpExpressionTranslator translator, ModelIndex index, IReadOnlyList<Param> commandParams)
    {
        var states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || tr.Value is not IdentifierExpr stateRef
            || !index.EnumsDeclaring(stateRef.Name).Contains(enumType))
            return; // no state machine, or a dynamic (non-literal) target

        var sources = states.Rules.Where(r => r.To.Contains(stateRef.Name)).ToList();
        if (sources.Count == 0)
            return; // unreachable target — already a semantic error (KOI0703)

        var prop = CSharpNaming.ToPascalCase(tr.Field);

        // A state-rule guard is validated against entity members only, so it must
        // render with command parameters out of scope: a parameter sharing a member's
        // name would otherwise shadow it (and be read instead of the persisted state).
        foreach (var p in commandParams) translator.PopLocal(p.Name);
        var conditions = sources.Select(r =>
        {
            var c = $"{prop} == {enumType}.{r.From}";
            if (r.Guard is not null)
                // Translate (not TranslateTopLevel) so a binary guard keeps its parentheses:
                // an OR guard must bind below the && that joins it to the source check.
                c = $"{c} && {translator.Translate(r.Guard, CSharpExpressionTranslator.NameMode.Property)}";
            return $"({c})";
        }).ToList();
        foreach (var p in commandParams) translator.PushLocal(p.Name);

        sb.Append(Indent).Append(Indent).Append("if (!(").Append(string.Join(" || ", conditions)).Append("))\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(entity.Name).Append("),\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("rule: \"illegal transition of ").Append(tr.Field).Append(" to ").Append(stateRef.Name).Append("\");\n");
    }

    /// <summary>
    /// Emits a factory as a <c>public static</c> method on the aggregate root:
    /// preconditions, an auto-generated identity, construction, then creation events.
    /// Identity is always generated (<c>OrderId.New()</c>); constructor arguments are
    /// drawn from <c>field &lt;- expr</c> initializations, falling back to the
    /// constructor's own defaults (or <c>default!</c> for a required, uninitialized
    /// field — already flagged by KOI0806).
    /// </summary>
    private void WriteFactory(
        StringBuilder sb,
        EntityDecl entity,
        FactoryDecl factory,
        IReadOnlyList<Member> ctorMembers,
        ISet<string> memberNames,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        ModelIndex index)
    {
        var paramList = string.Join(", ", factory.Parameters.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));

        sb.Append('\n');
        WriteXmlDoc(sb, factory.Doc, Indent);
        sb.Append(Indent).Append("public static ").Append(entity.Name).Append(' ')
          .Append(CSharpNaming.ToPascalCase(factory.Name))
          .Append('(').Append(paramList).Append(")\n");
        sb.Append(Indent).Append("{\n");

        // Factory scope: the synthetic `id` and the factory's parameters are locals
        // (entity members are not in scope — the aggregate does not exist yet).
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (var p in factory.Parameters) translator.PushLocal(p.Name, p.Type);

        var requires = factory.Body.OfType<RequiresClause>().ToList();
        var inits = factory.Body.OfType<Initialization>().ToList();
        var emits = factory.Body.OfType<EmitClause>().ToList();

        // 1. Auto-generated identity. Declared first so it is in scope for the
        //    preconditions and payloads (New() has no side effects). The aggregate is
        //    still not constructed until step 3, satisfying "checked before construction".
        sb.Append(Indent).Append(Indent).Append("var id = ").Append(entity.IdentityName).Append(".New();\n");

        // 2. Preconditions — checked before any state is constructed.
        if (requires.Count > 0) sb.Append('\n');
        var firstGuard = true;
        foreach (var req in requires)
        {
            if (!firstGuard) sb.Append('\n');
            firstGuard = false;
            WriteGuard(sb, entity.Name, req.Condition, req.Message ?? SynthesizeMessage(req.Condition),
                translator, CSharpExpressionTranslator.NameMode.Property);
        }
        if (requires.Count > 0) sb.Append('\n');

        // 3. Construct. Each ctor member draws its value, in priority order, from: an
        //    explicit `field <- expr` (named arg); a same-named parameter (auto-bind);
        //    the constructor's own default; or `default!` when required+unset (KOI0806).
        // First-wins on a (validation-rejected) duplicate init, so emission never throws.
        var initByField = new Dictionary<string, Expr>(StringComparer.Ordinal);
        foreach (var i in inits)
            initByField.TryAdd(i.Field, i.Value);
        var args = new List<string> { "id" };
        foreach (var m in ctorMembers)
        {
            var paramName = CSharpNaming.ToCamelCase(m.Name);
            if (initByField.TryGetValue(m.Name, out var value))
            {
                var expectedEnum = index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
                var rhs = translator.TranslateTopLevel(value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
                args.Add($"{paramName}: {rhs}");
            }
            else if (factory.Parameters.Any(p => MemberAnalysis.AutoBinds(p, m)))
            {
                args.Add($"{paramName}: {paramName}");
            }
            else if (!HasCtorDefault(m))
            {
                args.Add($"{paramName}: default!");
            }
            // else: omit — the constructor's C# default value supplies it.
        }
        sb.Append(Indent).Append(Indent).Append("var instance = new ").Append(entity.Name)
          .Append('(').Append(string.Join(", ", args)).Append(");\n");

        // 4. Record creation events (payloads may reference `id` and parameters).
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "instance.")).ToList();

        foreach (var p in factory.Parameters) translator.PopLocal(p.Name);
        translator.PopLocal("id");

        foreach (var stmt in emitStatements)
            sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');

        sb.Append(Indent).Append(Indent).Append("return instance;\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>True when any command or factory of the entity emits a domain event.</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>Builds the <c>[prefix]_domainEvents.Add(new EventName(...));</c> statement for an emit.</summary>
    private string BuildEmitStatement(EmitClause emit, CSharpExpressionTranslator translator, ModelIndex index, string targetPrefix = "")
    {
        if (!index.TryGetDecl(emit.EventName, out var decl) || decl is not EventDecl ev)
            return $"/* unknown event '{emit.EventName}' */";

        var eventMemberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Match the constructor's parameter order (OrderCtorParams moves defaulted/
        // optional fields last), not the declaration order, so positional args bind.
        var ctorFields = OrderCtorParams(ev.Members.Where(m => !MemberAnalysis.IsDerived(m, eventMemberNames))).ToList();
        var argByField = emit.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);

        var args = ctorFields.Select(f =>
        {
            if (!argByField.TryGetValue(f.Name, out var value))
                return "default!"; // validator guarantees presence; defensive
            var expectedEnum = index.Classify(f.Type.Name) == TypeKind.Enum ? f.Type.Name : null;
            return translator.TranslateTopLevel(value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
        });

        return $"{targetPrefix}_domainEvents.Add(new {ev.Name}({string.Join(", ", args)}));";
    }

    /// <summary>Synthesizes a readable rule message from an unmessaged invariant.</summary>
    private static string SynthesizeMessage(Expr condition) => SourceText(condition);

    private static string SourceText(Expr expr) => expr switch
    {
        IdentifierExpr id => id.Name,
        LiteralExpr lit => lit.Kind == LiteralKind.String ? $"\"{lit.Text}\"" : lit.Text,
        MemberAccessExpr ma => $"{SourceText(ma.Target)}.{ma.MemberName}",
        CallExpr c => $"{SourceText(c.Target)}.{c.Method}({string.Join(", ", c.Args.Select(SourceText))})",
        LambdaExpr l => $"{l.Parameter} => {SourceText(l.Body)}",
        ConditionalExpr cd => $"if {SourceText(cd.Condition)} then {SourceText(cd.Then)} else {SourceText(cd.Else)}",
        UnaryExpr u => (u.Op == UnaryOp.Not ? "not " : "-") + SourceText(u.Operand),
        BinaryExpr b => $"{SourceText(b.Left)} {SourceOp(b.Op)} {SourceText(b.Right)}",
        MatchExpr m => $"{SourceText(m.Target)} matches /{m.Pattern}/",
        GuardExpr g => $"{SourceText(g.Body)} when {SourceText(g.Condition)}",
        _ => "invariant"
    };

    private static string SourceOp(BinaryOp op) => op switch
    {
        BinaryOp.Or => "or",
        BinaryOp.And => "and",
        BinaryOp.Eq => "==",
        BinaryOp.Neq => "!=",
        BinaryOp.Lt => "<",
        BinaryOp.Le => "<=",
        BinaryOp.Gt => ">",
        BinaryOp.Ge => ">=",
        BinaryOp.Add => "+",
        BinaryOp.Sub => "-",
        BinaryOp.Mul => "*",
        BinaryOp.Div => "/",
        _ => "?"
    };

    // ----------------------------------------------------------------------
    // Runtime support
    // ----------------------------------------------------------------------

    private const string RuntimeNamespace = "Koine.Runtime";

    private EmittedFile EmitRuntimeException()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Thrown when a domain invariant or illegal state transition is violated.</summary>\n");
        sb.Append("public sealed class DomainInvariantViolationException : Exception\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public string TypeName { get; }\n");
        sb.Append(Indent).Append("public string Rule { get; }\n\n");
        sb.Append(Indent).Append("public DomainInvariantViolationException(string type, string rule)\n");
        sb.Append(Indent).Append(Indent)
          .Append(": base($\"Invariant violated on {type}: {rule}\") { TypeName = type; Rule = rule; }\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/DomainInvariantViolationException.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitAggregateRootInterface()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Marks an entity as the consistency boundary (root) of an aggregate.</summary>\n");
        sb.Append("public interface IAggregateRoot { }\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IAggregateRoot.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitDomainEventInterface()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>A fact that happened in the domain, recorded by an aggregate.</summary>\n");
        sb.Append("public interface IDomainEvent\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("DateTimeOffset OccurredOn { get; }\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IDomainEvent.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the optimistic-concurrency exception (R11.4) once into Koine.Runtime,
    /// mirroring <see cref="EmitRuntimeException"/>. A repository's update/remove
    /// contract throws it when a versioned aggregate is saved against a stale version.
    /// </summary>
    private EmittedFile EmitConcurrencyConflictException()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Thrown when a versioned aggregate is saved against a stale expected version.</summary>\n");
        sb.Append("public sealed class ConcurrencyConflictException : Exception\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public string TypeName { get; }\n");
        sb.Append(Indent).Append("public int ExpectedVersion { get; }\n");
        sb.Append(Indent).Append("public int ActualVersion { get; }\n\n");
        sb.Append(Indent).Append("public ConcurrencyConflictException(string type, int expected, int actual)\n");
        sb.Append(Indent).Append(Indent)
          .Append(": base($\"Concurrency conflict on {type}: expected version {expected}, found {actual}.\")\n");
        sb.Append(Indent).Append("{ TypeName = type; ExpectedVersion = expected; ActualVersion = actual; }\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/ConcurrencyConflictException.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the generic <c>Range&lt;T&gt;</c> value object once into Koine.Runtime: a
    /// closed interval over an orderable <c>T</c> with a <c>start &lt;= end</c> construction
    /// invariant, <c>Contains</c>/<c>Overlaps</c>, and structural equality.
    /// </summary>
    private EmittedFile EmitRange()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>A closed interval [Start, End] over an orderable type, with containment and overlap.</summary>\n");
        sb.Append("public sealed class Range<T> : IEquatable<Range<T>> where T : IComparable<T>\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public T Start { get; }\n");
        sb.Append(Indent).Append("public T End { get; }\n\n");
        sb.Append(Indent).Append("public Range(T start, T end)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("if (!(start.CompareTo(end) <= 0))\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: \"Range\",\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("rule: \"start must be less than or equal to end\");\n");
        sb.Append(Indent).Append(Indent).Append("Start = start;\n");
        sb.Append(Indent).Append(Indent).Append("End = end;\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("/// <summary>True when value lies within [Start, End] inclusive.</summary>\n");
        sb.Append(Indent).Append("public bool Contains(T value) =>\n");
        sb.Append(Indent).Append(Indent).Append("value.CompareTo(Start) >= 0 && value.CompareTo(End) <= 0;\n\n");
        sb.Append(Indent).Append("/// <summary>True when this range shares at least one point with other.</summary>\n");
        sb.Append(Indent).Append("public bool Overlaps(Range<T> other) =>\n");
        sb.Append(Indent).Append(Indent).Append("Start.CompareTo(other.End) <= 0 && other.Start.CompareTo(End) <= 0;\n\n");
        sb.Append(Indent).Append("public bool Equals(Range<T>? other) =>\n");
        sb.Append(Indent).Append(Indent).Append("other is not null\n");
        sb.Append(Indent).Append(Indent).Append("&& EqualityComparer<T>.Default.Equals(Start, other.Start)\n");
        sb.Append(Indent).Append(Indent).Append("&& EqualityComparer<T>.Default.Equals(End, other.End);\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj) => Equals(obj as Range<T>);\n");
        sb.Append(Indent).Append("public override int GetHashCode() => HashCode.Combine(Start, End);\n");
        sb.Append(Indent).Append("public static bool operator ==(Range<T>? left, Range<T>? right) =>\n");
        sb.Append(Indent).Append(Indent).Append("left is null ? right is null : left.Equals(right);\n");
        sb.Append(Indent).Append("public static bool operator !=(Range<T>? left, Range<T>? right) => !(left == right);\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/Range.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the canonical DDD <c>ValueObject</c> base class: structural equality
    /// driven by each derived type's <c>GetEqualityComponents()</c>. Value objects
    /// are immutable classes (not records) so every instance is funneled through a
    /// guarded constructor and can never exist in an invalid state.
    /// </summary>
    private EmittedFile EmitValueObjectBase()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Base class for value objects: equality by component value, not reference.</summary>\n");
        sb.Append("public abstract class ValueObject\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("/// <summary>The values that define this value object's identity, in order.</summary>\n");
        sb.Append(Indent).Append("protected abstract IEnumerable<object?> GetEqualityComponents();\n\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("if (obj is null || obj.GetType() != GetType())\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append("return GetEqualityComponents().SequenceEqual(((ValueObject)obj).GetEqualityComponents());\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var hash = new HashCode();\n");
        sb.Append(Indent).Append(Indent).Append("foreach (var component in GetEqualityComponents())\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("hash.Add(component);\n");
        sb.Append(Indent).Append(Indent).Append("return hash.ToHashCode();\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("public static bool operator ==(ValueObject? left, ValueObject? right) =>\n");
        sb.Append(Indent).Append(Indent).Append("left is null ? right is null : left.Equals(right);\n\n");
        sb.Append(Indent).Append("public static bool operator !=(ValueObject? left, ValueObject? right) => !(left == right);\n\n");
        // Collection-typed fields must contribute by their CONTENT, not the wrapper
        // reference. Lists compare order-sensitively; sets and maps order-insensitively.
        sb.Append(Indent).Append("/// <summary>Wraps an ordered collection (list) as a by-element equality component.</summary>\n");
        sb.Append(Indent).Append("protected static object? Ordered(System.Collections.IEnumerable? items) =>\n");
        sb.Append(Indent).Append(Indent).Append("items is null ? null : new SequenceComponent(items, ordered: true);\n\n");
        sb.Append(Indent).Append("/// <summary>Wraps an unordered collection (set/map) as a by-element equality component.</summary>\n");
        sb.Append(Indent).Append("protected static object? Unordered(System.Collections.IEnumerable? items) =>\n");
        sb.Append(Indent).Append(Indent).Append("items is null ? null : new SequenceComponent(items, ordered: false);\n\n");
        sb.Append(Indent).Append("private sealed class SequenceComponent\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("private readonly List<object?> _items = new();\n");
        sb.Append(Indent).Append(Indent).Append("private readonly bool _ordered;\n\n");
        sb.Append(Indent).Append(Indent).Append("public SequenceComponent(System.Collections.IEnumerable items, bool ordered)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("_ordered = ordered;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in items) _items.Add(item);\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (obj is not SequenceComponent other || _items.Count != other._items.Count)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return _ordered\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("? _items.SequenceEqual(other._items)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append(": _items.All(x => _items.Count(i => Equals(i, x)) == other._items.Count(i => Equals(i, x)));\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (_ordered)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("var hash = new HashCode();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in _items) hash.Add(item);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return hash.ToHashCode();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var acc = 0;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in _items) acc ^= item?.GetHashCode() ?? 0;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return acc;\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/ValueObject.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: true));
    }

    // ----------------------------------------------------------------------
    // File header (using block + namespace)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Wraps an emitted type body with the canonical generated-file preamble: an
    /// <c>&lt;auto-generated/&gt;</c> marker (so IDE/style analyzers skip the file),
    /// only the <c>using</c> directives the body actually needs, and the namespace.
    /// Usings are derived by scanning the body rather than a fixed block, so files
    /// carry no unused imports. LINQ is passed in because <c>.Count</c> (a property)
    /// and <c>.Count()</c> (a LINQ call) are not distinguishable by a token scan.
    /// </summary>
    private string Assemble(string ns, string body, bool usesLinq)
    {
        var usings = new List<string>();
        void Need(bool condition, string ns2) { if (condition && !usings.Contains(ns2)) usings.Add(ns2); }

        Need(body.Contains("Guid") || body.Contains("DateTimeOffset")
             || body.Contains("IEquatable") || body.Contains("new HashCode(") || body.Contains("HashCode.Combine")
             || body.Contains("IComparable")
             || body.Contains(": Exception") || body.Contains("ArgumentOutOfRangeException")
             || body.Contains("ArgumentNullException") || body.Contains("InvalidOperationException"), "System");
        Need(body.Contains("IEnumerable<") || body.Contains("IReadOnlyList<") || body.Contains("List<")
             || body.Contains("IReadOnlySet<") || body.Contains("HashSet<")
             || body.Contains("IReadOnlyDictionary<") || body.Contains("Dictionary<")
             || body.Contains("EqualityComparer<"), "System.Collections.Generic");
        Need(usesLinq, "System.Linq");
        // Repository contracts (R11.2/3) are async and take a CancellationToken.
        Need(body.Contains("Task"), "System.Threading.Tasks");
        Need(body.Contains("CancellationToken"), "System.Threading");
        Need(body.Contains("Regex"), "System.Text.RegularExpressions");
        Need(ns != "Koine.Runtime"
             && (body.Contains("ValueObject") || body.Contains("IAggregateRoot")
                 || body.Contains("IDomainEvent") || body.Contains("DomainInvariantViolationException")
                 || body.Contains("Range<")), "Koine.Runtime");

        // Cross-namespace user-type references (other contexts via imports, and other
        // modules of the same context) emit unqualified, so a precise `using` is added for
        // each referenced type's namespace (R13.2/R13.3). Qualified refs emit fully-qualified
        // and need none. The runtime files never reference user types.
        var context = ns.Split('.')[0];
        if (_contextNames.Contains(context))
            foreach (var (name, typeNs) in _index.VisibleTypeNamespaces(context))
                Need(typeNs != ns && ContainsWord(body, name), typeNs);

        var sb = new StringBuilder();
        sb.Append("// <auto-generated/>\n");
        // Generated files opt out of the project's nullable context, so re-enable it
        // explicitly — our signatures use nullable annotations (e.g. string?, object?).
        sb.Append("#nullable enable\n\n");
        foreach (var u in usings.OrderBy(UsingSortKey, StringComparer.Ordinal).ThenBy(u => u, StringComparer.Ordinal))
            sb.Append("using ").Append(u).Append(";\n");
        if (usings.Count > 0)
            sb.Append('\n');
        sb.Append("namespace ").Append(ns).Append(";\n\n");
        sb.Append(body);
        return sb.ToString();
    }

    /// <summary>True when <paramref name="word"/> appears in <paramref name="text"/> as a whole identifier (not a substring).</summary>
    private static bool ContainsWord(string text, string word)
    {
        var i = 0;
        while ((i = text.IndexOf(word, i, StringComparison.Ordinal)) >= 0)
        {
            var before = i == 0 || !IsIdentChar(text[i - 1]);
            var afterIdx = i + word.Length;
            var after = afterIdx >= text.Length || !IsIdentChar(text[afterIdx]);
            if (before && after)
                return true;
            i = afterIdx;
        }
        return false;
    }

    private static bool IsIdentChar(char c) => char.IsLetterOrDigit(c) || c == '_';

    // System and System.* sort before everything else, mirroring the default
    // "System directives first" using-ordering.
    private static string UsingSortKey(string ns) =>
        ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal) ? "0" + ns : "1" + ns;

    /// <summary>The declared enum type of an enum-typed member (hint for qualifying bare members), else null.</summary>
    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;

    /// <summary>True when any emitted expression for an entity (incl. commands) uses a LINQ-backed op.</summary>
    private static bool EntityUsesLinq(EntityDecl e) =>
        UsesLinq(e.Members, e.Invariants)
        || e.Commands.SelectMany(c => c.Body).Any(s => s switch
        {
            RequiresClause r => ExprUsesLinq(r.Condition),
            Transition t => ExprUsesLinq(t.Value),
            EmitClause em => em.Args.Any(a => ExprUsesLinq(a.Value)),
            _ => false
        })
        || e.Factories.SelectMany(f => f.Body).Any(s => s switch
        {
            RequiresClause r => ExprUsesLinq(r.Condition),
            Initialization i => ExprUsesLinq(i.Value),
            EmitClause em => em.Args.Any(a => ExprUsesLinq(a.Value)),
            _ => false
        })
        || e.States.SelectMany(s => s.Rules).Any(r => r.Guard is not null && ExprUsesLinq(r.Guard));

    /// <summary>True when any emitted expression for the type uses a LINQ-backed op.</summary>
    private static bool UsesLinq(IEnumerable<Member> members, IEnumerable<Invariant> invariants) =>
        members.Any(m => m.Initializer is not null && ExprUsesLinq(m.Initializer))
        || invariants.Any(inv => ExprUsesLinq(inv.Condition));

    private static bool ExprUsesLinq(Expr expr) => expr switch
    {
        CallExpr c => BuiltinOps.TakesLambda(c.Method) || c.Method == "contains"
                      || ExprUsesLinq(c.Target) || c.Args.Any(ExprUsesLinq),
        LambdaExpr l => ExprUsesLinq(l.Body),
        BinaryExpr b => ExprUsesLinq(b.Left) || ExprUsesLinq(b.Right),
        UnaryExpr u => ExprUsesLinq(u.Operand),
        MemberAccessExpr ma => ExprUsesLinq(ma.Target),
        ConditionalExpr cd => ExprUsesLinq(cd.Condition) || ExprUsesLinq(cd.Then) || ExprUsesLinq(cd.Else),
        GuardExpr g => ExprUsesLinq(g.Body) || ExprUsesLinq(g.Condition),
        MatchExpr m => ExprUsesLinq(m.Target),
        _ => false
    };

    /// <summary>Renders a target-agnostic doc string as a C# XML <c>&lt;summary&gt;</c>.</summary>
    private static void WriteXmlDoc(StringBuilder sb, string? doc, string indent)
    {
        if (string.IsNullOrEmpty(doc))
            return;

        var lines = doc.Split('\n');
        if (lines.Length == 1)
        {
            sb.Append(indent).Append("/// <summary>").Append(EscapeXml(lines[0])).Append("</summary>\n");
            return;
        }

        sb.Append(indent).Append("/// <summary>\n");
        foreach (var line in lines)
            sb.Append(indent).Append("/// ").Append(EscapeXml(line)).Append('\n');
        sb.Append(indent).Append("/// </summary>\n");
    }

    private static string EscapeXml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static void AppendComment(StringBuilder sb, string? comment)
    {
        if (!string.IsNullOrEmpty(comment))
            sb.Append("  // ").Append(comment);
    }

    /// <summary>Maps a namespace to its emit folder path.</summary>
    private static string FolderFor(string ns) => ns.Replace('.', '/');

    /// <summary>The bounded context owning a namespace (its first segment); the resolution scope for R13.2.</summary>
    private static string ContextOf(string ns)
    {
        var dot = ns.IndexOf('.');
        return dot < 0 ? ns : ns[..dot];
    }

    // ----------------------------------------------------------------------
    // ID ownership
    // ----------------------------------------------------------------------

    /// <summary>Map from an owned ID type name to the entity declaration that owns it.</summary>
    private static Dictionary<string, EntityDecl> BuildIdOwnership(ContextNode ctx)
    {
        var owned = new Dictionary<string, EntityDecl>(StringComparer.Ordinal);
        foreach (var e in AllEntities(ctx))
            owned[e.IdentityName] = e;
        return owned;
    }

    /// <summary>
    /// ID names referenced anywhere in the context that are not owned by an entity
    /// nor otherwise declared, in deterministic (sorted) order.
    /// </summary>
    private static IEnumerable<string> OrderedUnownedIds(
        ContextNode ctx,
        ModelIndex index,
        IReadOnlyDictionary<string, EntityDecl> owned)
    {
        var seen = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var idName in index.IdTypeNames)
        {
            if (owned.ContainsKey(idName))
                continue;
            // Only emit it if it is referenced within this context.
            if (IsReferencedInContext(ctx, idName))
                seen.Add(idName);
        }
        return seen;
    }

    private static bool IsReferencedInContext(ContextNode ctx, string idName) =>
        ModelIndex.AllTypeRefsIn(ctx).Any(tr => TypeRefMentions(tr, idName));

    private static bool TypeRefMentions(TypeRef type, string name)
    {
        if (type.Name == name) return true;
        return (type.Element is not null && TypeRefMentions(type.Element, name))
            || (type.Value is not null && TypeRefMentions(type.Value, name));
    }

    private static IEnumerable<EntityDecl> AllEntities(ContextNode ctx)
    {
        foreach (var t in AllTypeDecls(ctx))
            if (t is EntityDecl e)
                yield return e;
    }

    private static IEnumerable<TypeDecl> AllTypeDecls(ContextNode ctx)
    {
        foreach (var t in ctx.Types)
        {
            yield return t;
            if (t is AggregateDecl agg)
                foreach (var nested in agg.Types)
                    yield return nested;
        }
    }

    // ----------------------------------------------------------------------
    // Enum member map
    // ----------------------------------------------------------------------

    /// <summary>
    /// Maps every enum member name to its owning enum type name so identifiers
    /// like <c>Draft</c> render as <c>OrderStatus.Draft</c>.
    /// </summary>
    private static Dictionary<string, string> BuildEnumMemberMap(KoineModel model)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var t in AllTypeDecls(ctx))
                if (t is EnumDecl e)
                    foreach (var member in e.MemberNames)
                        map[member] = e.Name; // last writer wins; v0 assumes unique members
        return map;
    }
}
