using System.Buffers;
using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The C# backend. Turns a validated <see cref="KoineModel"/> into a set of C#
/// source files. All C#-specific decisions (naming, type mapping, expression
/// translation, codegen rules) live in this folder; the AST stays target-agnostic.
///
/// <para>Emission is deterministic (declaration order) so re-runs are byte-identical.
/// Every file ends with a single trailing newline; no timestamps are emitted.</para>
/// </summary>
public sealed partial class CSharpEmitter : IEmitter
{
    public string TargetName => "csharp";

    private const string Indent = "    ";

    private readonly CSharpEmitterOptions _options;

    /// <summary>The default emitter: no configured options, byte-identical historical output.</summary>
    public CSharpEmitter()
        : this(CSharpEmitterOptions.Empty)
    {
    }

    /// <summary>An emitter configured with R16.1 options (namespace remapping, Instant handling).</summary>
    internal CSharpEmitter(CSharpEmitterOptions options) => _options = options;

    /// <summary>
    /// Encodes every C# option that changes emitted bytes (instant mode, source maps, reference-only,
    /// and the sorted namespace remap pairs) into the cache fingerprint, so toggling any of them busts
    /// <see cref="Services.KoineCompiler"/>'s emit cache. The namespace pairs are ordered so equal maps
    /// always produce the same string regardless of insertion order.
    /// </summary>
    public string CacheDiscriminator
    {
        get
        {
            var map = string.Join(
                ",",
                _options.NamespaceMap
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => kv.Key + "=" + kv.Value));
            // Lower-cased so an explicit `--layers domain` produces the same discriminator as the
            // unconfigured default (which is the canonical lower-case "domain") for byte-identical output.
            var layers = _options.Layers is null
                ? "domain"
                : string.Join(",", _options.Layers.Select(l => l.ToString().ToLowerInvariant()).OrderBy(l => l, StringComparer.Ordinal));
            return string.Join(
                "|",
                GetType().FullName,
                "instant=" + _options.InstantMode,
                "sourceMaps=" + _options.EmitSourceMaps,
                "refOnly=" + _options.ReferenceOnly,
                "layers=" + layers,
                "mediatr=" + _options.ApplicationMediatr,
                "mapping=" + _options.Mapping,
                "ns=" + map);
        }
    }

    /// <summary>
    /// True when reference-only emit is requested (<see cref="CSharpEmitterOptions.ReferenceOnly"/>):
    /// every executable body is replaced with a <c>throw null!;</c> reference-assembly stub while all
    /// signatures, declarations, interfaces and attributes stay intact. Off by default, so the full
    /// emit path is byte-identical to the historical output.
    /// </summary>
    private bool RefOnly => _options.ReferenceOnly;

    /// <summary>
    /// Writes the canonical reference-assembly stub for a <em>block-bodied</em> member: the opening
    /// brace has already been written by the caller (so a stamped signature stays unchanged); this
    /// emits <c>throw null!;</c> indented one level past <paramref name="indentLevel"/> braces, then
    /// the closing brace. Used by every block-bodied ctor/method/operator when <see cref="RefOnly"/>.
    /// </summary>
    private static void WriteRefStubBlockBody(StringBuilder sb, int indentLevel = 1)
    {
        for (var i = 0; i < indentLevel + 1; i++)
        {
            sb.Append(Indent);
        }

        sb.Append("throw null!;\n");
        for (var i = 0; i < indentLevel; i++)
        {
            sb.Append(Indent);
        }

        sb.Append("}\n");
    }

    /// <summary>
    /// Writes the canonical reference-assembly stub for an <em>expression-bodied</em> member:
    /// <c>=&gt; throw null!;</c>, indented <paramref name="indentLevel"/> levels (the caller has
    /// already written the signature line up to and including its trailing newline). Used by every
    /// <c>=&gt; …;</c> member (derived properties, specs, services, projections, simple operators)
    /// when <see cref="RefOnly"/>.
    /// </summary>
    private static void WriteRefStubExpressionBody(StringBuilder sb, int indentLevel = 2)
    {
        for (var i = 0; i < indentLevel; i++)
        {
            sb.Append(Indent);
        }

        sb.Append("=> throw null!;\n");
    }

    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, null);

    public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
    {
        // Reuse the shared resolution when given (the normal pipeline path); fall back to building
        // our own only when invoked standalone (e.g. a direct emitter test).
        var sema = semantic ?? new SemanticModel(model);
        var index = sema.Index;
        var typeMapper = new CSharpTypeMapper(index, _options);
        Dictionary<string, string> enumMemberToType = BuildEnumMemberMap(model);

        // All per-run state lives in this immutable record, threaded through the emit
        // methods so the emitter holds no mutable per-model fields (it stays reentrant).
        var emit = new EmitContext(
            Index: index,
            ScalarNeeds: OperatorNeedsAnalyzer.BuildScalarOperatorNeeds(model, index),
            AdditiveNeeds: OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds(model, index),
            ContextNames: model.Contexts.Select(c => c.Name).ToList(),
            IdStrategies: BuildIdentityStrategies(model),
            Options: _options,
            Semantic: sema);

        var files = new List<EmittedFile>();

        // 1. Runtime support, emitted once.
        files.Add(EmitRuntimeException(emit));
        files.Add(EmitAggregateRootInterface(emit));
        // Value-object base is needed for declared value objects/entities AND for any generated
        // ID value object (e.g. an *Id referenced only by an integration event, R14.3).
        if (NeedsValueObjects(model) || index.IdTypeNames.Count > 0)
        {
            files.Add(EmitValueObjectBase(emit));
        }

        if (UsesRange(model))
        {
            files.Add(EmitRange(emit));
        }

        if (HasEvents(model))
        {
            files.Add(EmitDomainEventInterface(emit));
        }

        if (HasIntegrationEvents(model))
        {
            files.Add(EmitIntegrationEventInterface(emit));
        }

        if (HasVersionedAggregate(model))
        {
            files.Add(EmitConcurrencyConflictException(emit));
        }

        if (HasQueries(model))
        {
            files.Add(EmitQueryHandlerInterface(emit));
        }

        // 2. Per-context user types. Aggregate-nested types are flattened into the
        //    context namespace; the aggregate boundary is marked via IAggregateRoot.
        foreach (ContextNode ctx in model.Contexts)
        {
            Dictionary<string, EntityDecl> idOwnership = BuildIdOwnership(ctx);

            foreach (TypeDecl type in ctx.Types)
            {
                // A shared-kernel type (R14.2) is emitted once, by its owning context, into the
                // dedicated kernel namespace; any other partner skips it (it lives in the kernel).
                if (index.IsSharedKernelType(type.Name))
                {
                    if (index.KernelOwnerOfType(type.Name) != ctx.Name)
                    {
                        continue;
                    }
                }

                // A type emits into its context namespace, extended by its module path (R13.3),
                // unless it is a shared-kernel type redirected to the kernel namespace (R14.2).
                var ns = index.KernelNamespaceOfType(type.Name)
                         ?? ModelIndex.NamespaceOf(ctx.Name, type.ModulePath);
                switch (type)
                {
                    case ValueObjectDecl vo:
                        files.Add(EmitValueObject(emit, vo, ns, index, typeMapper, enumMemberToType));
                        break;
                    case EntityDecl entity:
                        EmitEntityAndId(emit, files, entity, ns, isRoot: false, isVersioned: false, index, typeMapper, enumMemberToType);
                        break;
                    case EnumDecl @enum:
                        files.Add(EmitEnum(emit, @enum, ns, index, typeMapper, enumMemberToType));
                        break;
                    case EventDecl @event:
                        files.Add(EmitEvent(emit, @event, ns, index, typeMapper, enumMemberToType));
                        break;
                    case IntegrationEventDecl @event:
                        files.Add(EmitIntegrationEvent(emit, @event, ns, index, typeMapper, enumMemberToType));
                        break;
                    case AggregateDecl agg:
                        EmitAggregate(emit, files, agg, ns, index, typeMapper, enumMemberToType);
                        break;
                    case ReadModelDecl rm:
                        files.Add(EmitReadModel(emit, rm, ns, index, typeMapper, enumMemberToType));
                        break;
                    case QueryDecl query:
                        files.Add(EmitQuery(emit, query, ns, typeMapper));
                        break;
                }
            }

            // Emit any ID value objects that are referenced but NOT owned by an
            // entity (e.g. ProductId). Honor the owning entity's strategy when one is
            // known (a cross-context reference), else default to Guid.
            foreach (var idName in OrderedUnownedIds(ctx, index, idOwnership))
            {
                (IdentityStrategy strategy, var backing) = emit.IdStrategies.TryGetValue(idName, out (IdentityStrategy Strategy, string? Backing) s)
                    ? s : (IdentityStrategy.Guid, null);
                files.Add(EmitIdValueObject(emit, idName, ctx.Name, strategy, backing));
            }

            // 3. R10 behavioral declarations: specifications, services, policies.
            var contextSpecs = ctx.Specs
                .Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs))
                .ToList();
            if (contextSpecs.Count > 0)
            {
                files.Add(EmitSpecifications(emit, ctx.Name, contextSpecs, index, enumMemberToType));
            }

            foreach (ServiceDecl svc in ctx.Services)
            {
                // A service emits a stateless domain class for its pure operations (R10.2)
                // and/or an application-service interface for its use cases (R12.2).
                if (svc.Operations.Count > 0)
                {
                    files.Add(EmitService(emit, svc, ctx.Name, index, typeMapper, enumMemberToType));
                }

                if (svc.UseCases.Count > 0)
                {
                    files.Add(EmitApplicationService(emit, svc, ctx.Name, typeMapper));
                }
            }
            foreach (PolicyDecl policy in ctx.Policies)
            {
                files.Add(EmitPolicy(emit, policy, ctx.Name, index, enumMemberToType));
            }

            // 4. Integration-event subscriber handler seams (R14.3): one IHandle<Event> per
            //    subscription. No handler is generated for events the context only publishes.
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                files.Add(EmitIntegrationEventHandler(emit, sub, ctx.Name, index));
            }

            // 5. The context's Unit of Work (R12.1): a transactional seam over its
            //    aggregate repositories. Emitted only when the context has aggregates whose
            //    root is an entity (only those produce a repository to expose).
            var aggregates = ctx.Types.OfType<AggregateDecl>()
                .Where(a => a.RootEntity() is not null)
                .ToList();
            if (aggregates.Count > 0)
            {
                files.Add(EmitUnitOfWork(emit, ctx.Name, aggregates));
            }
        }

        // 6. Anti-corruption-layer translator interfaces (R14.2): one per ACL relation that
        //    carries a mapping block. Emitted once, into the downstream context's namespace.
        if (model.ContextMap is { } map)
        {
            foreach (ContextRelation r in map.Relations)
            {
                if (r.Kind == ContextRelationKind.AntiCorruptionLayer && r.AclMappings.Count > 0)
                {
                    files.Add(EmitAclTranslator(emit, r, index));
                }
            }
        }

        // 7. The opt-in Application layer (issue #129): concrete handlers, validators, query
        //    handlers and the DI extension that implement the contracts emitted above. Gated on
        //    the `application` layer; off by default, so non-application output is unchanged.
        if (_options.EmitApplication)
        {
            foreach (ContextNode ctx in model.Contexts)
            {
                EmitApplicationLayer(emit, files, ctx, index, typeMapper, enumMemberToType);
            }
        }

        // 8. The opt-in EF Core Infrastructure layer (issue #128): a runnable realization of the
        //    contracts emitted above (DbContext, entity configurations, repositories, unit of work,
        //    transactional outbox + dispatcher, DI registration). Off by default, so the steps above
        //    are byte-identical to the historical emitter when the layer is not requested.
        if (_options.EmitsInfrastructure)
        {
            EmitInfrastructure(emit, model, files, typeMapper);
        }

        return files;
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
        EmitContext emit,
        EnumDecl @enum,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var name = @enum.Name;
        IReadOnlyList<Param> sig = @enum.Signature;
        var hasData = @enum.HasAssociatedData;
        var sb = new StringBuilder();

        // Associated-data args are literal expressions; reuse the translator so string
        // escaping and the decimal `m` suffix match the rest of the emitted code.
        var translator = new CSharpExpressionTranslator(index, Array.Empty<Member>(), enumMemberToType, options: _options);

        WriteXmlDoc(sb, @enum.Doc ?? "A type-safe smart enum: static instances with value equality.", "");
        WriteObsolete(sb, @enum.Deprecated, "");
        sb.Append("public sealed class ").Append(name).Append(" : IEquatable<").Append(name).Append(">\n{\n");

        // One static readonly instance per member, in declaration order. When the enum
        // has a signature, each member also passes its associated-data values.
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            sb.Append(Indent).Append("public static readonly ").Append(name).Append(' ')
              .Append(CSharpNaming.EscapeIdentifier(member.Name)).Append(" = new(\"").Append(member.Name).Append("\", ").Append(i);
            if (hasData)
            // Associated values are literals of a primitive field type (String/Int/
            // Decimal/Bool), validated upstream — render them directly.
            {
                for (var j = 0; j < sig.Count && j < member.Args.Count; j++)
                {
                    sb.Append(", ").Append(translator.TranslateTopLevel(
                        member.Args[j], CSharpExpressionTranslator.NameMode.Property));
                }
            }

            sb.Append(");\n");
        }

        sb.Append('\n');
        sb.Append(Indent).Append("public string Name { get; }\n");
        sb.Append(Indent).Append("public int Value { get; }\n");
        // Associated-data properties, in signature order.
        foreach (Param p in sig)
        {
            sb.Append(Indent).Append("public ").Append(typeMapper.Map(p.Type)).Append(' ')
              .Append(CSharpNaming.ToPascalCase(p.Name)).Append(" { get; }\n");
        }

        sb.Append('\n');

        var ctorParams = "string name, int value";
        if (hasData)
        {
            ctorParams += ", " + string.Join(", ", sig.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
        }

        sb.Append(Indent).Append("private ").Append(name).Append('(').Append(ctorParams).Append(")\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("Name = name;\n");
        sb.Append(Indent).Append(Indent).Append("Value = value;\n");
        foreach (Param p in sig)
        {
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToPascalCase(p.Name)).Append(" = ")
              .Append(CSharpNaming.ToCamelCase(p.Name)).Append(";\n");
        }

        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("public static IReadOnlyList<").Append(name).Append("> All { get; } = new[] { ")
          .Append(string.Join(", ", @enum.MemberNames.Select(CSharpNaming.EscapeIdentifier))).Append(" };\n\n");

        sb.Append(Indent).Append("public static ").Append(name).Append(" FromName(string name)\n");
        sb.Append(Indent).Append(Indent).Append("=> All.FirstOrDefault(e => e.Name == name)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("?? throw new ArgumentOutOfRangeException(nameof(name), $\"No ")
          .Append(name).Append(" with name '{name}'.\");\n\n");

        sb.Append(Indent).Append("public static ").Append(name).Append(" FromValue(int value)\n");
        sb.Append(Indent).Append(Indent).Append("=> All.FirstOrDefault(e => e.Value == value)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("?? throw new ArgumentOutOfRangeException(nameof(value), $\"No ")
          .Append(name).Append(" with value {value}.\");\n\n");

        // Non-throwing lookups (the .NET-canonical Try* shape) for parsing at domain
        // boundaries, where an unknown name/value is expected control flow, not an error.
        sb.Append(Indent).Append("public static bool TryFromName(string name, out ").Append(name).Append(" result)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("result = All.FirstOrDefault(e => e.Name == name)!;\n");
        sb.Append(Indent).Append(Indent).Append("return result is not null;\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("public static bool TryFromValue(int value, out ").Append(name).Append(" result)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("result = All.FirstOrDefault(e => e.Value == value)!;\n");
        sb.Append(Indent).Append(Indent).Append("return result is not null;\n");
        sb.Append(Indent).Append("}\n\n");

        // Exhaustive Match/Switch: one delegate per member, dispatched on the ordinal.
        // Adding a member becomes a compile error at every call site — the closed-set
        // safety a C# `enum` cannot give.
        var arms = @enum.Members.Select(m => CSharpNaming.ToCamelCase(m.Name)).ToList();

        sb.Append(Indent).Append("public TResult Match<TResult>(\n");
        for (var i = 0; i < arms.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append("Func<TResult> ").Append(arms[i])
              .Append(i < arms.Count - 1 ? ",\n" : ")\n");
        }

        sb.Append(Indent).Append(Indent).Append("=> Value switch\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        for (var i = 0; i < arms.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent).Append(i).Append(" => ").Append(arms[i]).Append("(),\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent).Append("_ => throw new InvalidOperationException($\"Unhandled ")
          .Append(name).Append(" '{Name}'.\")\n");
        sb.Append(Indent).Append(Indent).Append("};\n\n");

        sb.Append(Indent).Append("public void Switch(\n");
        for (var i = 0; i < arms.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append("Action ").Append(arms[i])
              .Append(i < arms.Count - 1 ? ",\n" : ")\n");
        }

        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("switch (Value)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        for (var i = 0; i < arms.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent).Append("case ").Append(i).Append(": ")
              .Append(arms[i]).Append("(); break;\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent).Append("default: throw new InvalidOperationException($\"Unhandled ")
          .Append(name).Append(" '{Name}'.\");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("public override string ToString()\n");
        sb.Append(Indent).Append(Indent).Append("=> Name;\n");
        sb.Append(Indent).Append("public bool Equals(").Append(name).Append("? other)\n");
        sb.Append(Indent).Append(Indent).Append("=> other is not null && Value == other.Value;\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append(Indent).Append("=> Equals(obj as ").Append(name).Append(");\n");
        sb.Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append(Indent).Append("=> Value;\n");
        sb.Append(Indent).Append("public static bool operator ==(").Append(name).Append("? left, ").Append(name)
          .Append("? right)\n");
        sb.Append(Indent).Append(Indent).Append("=> left is null ? right is null : left.Equals(right);\n");
        sb.Append(Indent).Append("public static bool operator !=(").Append(name).Append("? left, ").Append(name)
          .Append("? right)\n");
        sb.Append(Indent).Append(Indent).Append("=> !(left == right);\n");

        sb.Append("}\n");

        var contents = Assemble(emit, ns, sb.ToString(), usesLinq: true, @enum.Span, out var sourceMap);
        return new EmittedFile(PathFor(emit, ns, KindFolder.Enums, $"{name}.cs"), contents, sourceMap);
    }

    // ----------------------------------------------------------------------
    // Domain events
    // ----------------------------------------------------------------------

    private static bool HasEvents(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).Any(t => t is EventDecl);

    private static bool HasIntegrationEvents(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).Any(t => t is IntegrationEventDecl);

    /// <summary>
    /// True when any field or command/factory parameter anywhere in the model
    /// references a <c>Range&lt;T&gt;</c>, gating emission of the runtime range type.
    /// </summary>
    private static bool UsesRange(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl t in ctx.AllTypeDecls())
            {
                IReadOnlyList<Member>? members = t switch
                {
                    ValueObjectDecl v => v.Members,
                    EntityDecl e => e.Members,
                    EventDecl ev => ev.Members,
                    _ => null
                };
                if (members is not null && members.Any(m => TypeRefMentions(m.Type, ModelIndex.RangeTypeName)))
                {
                    return true;
                }

                if (t is EntityDecl en)
                {
                    IEnumerable<TypeRef> paramTypes = en.Commands.SelectMany(c => c.Parameters)
                        .Concat(en.Factories.SelectMany(f => f.Parameters))
                        .Select(p => p.Type);
                    if (paramTypes.Any(pt => TypeRefMentions(pt, ModelIndex.RangeTypeName)))
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /// <summary>
    /// True when the model emits at least one value object: an explicit
    /// <c>value</c> type, or an entity (whose strongly-typed ID is a value object).
    /// Gates emission of the <c>ValueObject</c> base class.
    /// </summary>
    private static bool NeedsValueObjects(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).Any(t => t is ValueObjectDecl or EntityDecl);

    /// <summary>
    /// Emits a domain event as an immutable <c>sealed record</c> implementing
    /// <c>IDomainEvent</c>, with get-only fields, value equality, and an
    /// <c>OccurredOn</c> timestamp defaulted at construction.
    /// </summary>
    private EmittedFile EmitEvent(
        EmitContext emit,
        EventDecl ev,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var translator = new CSharpExpressionTranslator(index, ev.Members, enumMemberToType, context: ContextOf(ns), options: _options);
        var ctorMembers = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = ev.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, ev.Doc, "");
        WriteObsolete(sb, ev.Deprecated, "");
        sb.Append("public sealed record ").Append(ev.Name).Append(" : IDomainEvent\n{\n");

        foreach (Member m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Occurrence metadata, defaulted at construction (part of value equality).
        // `init` keeps it immutable yet settable for reconstruction from an event store
        // or deterministic tests; `with` only ever produces a copy, never a mutation.
        sb.Append(Indent).Append("public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;\n");

        sb.Append('\n');
        WriteConstructor(sb, ev.Name, ctorMembers, Array.Empty<BoundInvariant>(), translator, typeMapper, index);

        foreach (Member m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append('\n');
            if (RefOnly)
            {
                WriteRefStubExpressionBody(sb);
                continue;
            }

            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append(Indent).Append(Indent).Append("=> ").Append(body).Append(";\n");
        }

        sb.Append("}\n");
        var contents = Assemble(emit, ns, sb.ToString(), UsesLinq(ev.Members, Array.Empty<Invariant>()), ev.Span, out var sourceMap);
        return new EmittedFile(PathFor(emit, ns, KindFolder.Events, $"{ev.Name}.cs"), contents, sourceMap);
    }

    /// <summary>
    /// Emits an integration event (R14.3): an immutable record marked <c>IIntegrationEvent</c>,
    /// mirroring <see cref="EmitEvent"/> but with the cross-boundary marker.
    /// </summary>
    private EmittedFile EmitIntegrationEvent(
        EmitContext emit,
        IntegrationEventDecl ev,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var translator = new CSharpExpressionTranslator(index, ev.Members, enumMemberToType, context: ContextOf(ns), options: _options);
        var ctorMembers = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = ev.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, ev.Doc, "");
        WriteObsolete(sb, ev.Deprecated, "");
        sb.Append("public sealed record ").Append(ev.Name).Append(" : IIntegrationEvent\n{\n");

        foreach (Member m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Occurrence metadata, defaulted at construction (part of value equality).
        // `init` keeps it immutable yet settable for reconstruction from an event store
        // or deterministic tests; `with` only ever produces a copy, never a mutation.
        sb.Append(Indent).Append("public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;\n");

        sb.Append('\n');
        WriteConstructor(sb, ev.Name, ctorMembers, Array.Empty<BoundInvariant>(), translator, typeMapper, index);

        foreach (Member m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append('\n');
            if (RefOnly)
            {
                WriteRefStubExpressionBody(sb);
                continue;
            }

            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append(Indent).Append(Indent).Append("=> ").Append(body).Append(";\n");
        }

        sb.Append("}\n");
        var contents = Assemble(emit, ns, sb.ToString(), UsesLinq(ev.Members, Array.Empty<Invariant>()), ev.Span, out var sourceMap);
        return new EmittedFile(PathFor(emit, ns, KindFolder.IntegrationEvents, $"{ev.Name}.cs"), contents, sourceMap);
    }

    /// <summary>
    /// Emits the subscriber handler seam for a subscription (R14.3): an <c>IHandle&lt;Event&gt;</c>
    /// interface in the subscriber's namespace, with a precise <c>using</c> to the publisher.
    /// </summary>
    private EmittedFile EmitIntegrationEventHandler(EmitContext emit, SubscribeDecl sub, string subscriberContext, ModelIndex index)
    {
        // Fully-qualify the event type with the publisher's namespace so it can never bind to a
        // same-named integration event the subscriber happens to declare locally (R14.3). The
        // publisher namespace honors any configured context→namespace remap (R16.1).
        var publisherNs = emit.RemapNamespace(index.NamespaceOfTypeIn(sub.Context, sub.EventName) ?? sub.Context);
        var eventType = publisherNs + "." + sub.EventName;

        // When the subscriber consumes the same event short name from two or more publishers (#420),
        // the bare IHandle<Event> seam would collide on one path — qualify it by the publisher context
        // (IHandle<Pub><Event>) so each subscription gets its own seam. The common single-publisher
        // case keeps the bare name, byte-identical to before.
        var seam = index.SubscriptionEventNameIsAmbiguous(subscriberContext, sub.EventName)
            ? "IHandle" + sub.Context + sub.EventName
            : "IHandle" + sub.EventName;
        var sb = new StringBuilder();

        sb.Append("/// <summary>Handles the ").Append(sub.Context).Append('.').Append(sub.EventName)
          .Append(" integration event published by context ").Append(sub.Context).Append(".</summary>\n");
        sb.Append("public interface ").Append(seam).Append("\n{\n");
        sb.Append(Indent).Append("Task Handle(").Append(eventType).Append(" theEvent, CancellationToken ct = default);\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(emit, subscriberContext, KindFolder.Abstractions, $"{seam}.cs"),
            Assemble(emit, subscriberContext, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the anti-corruption-layer translator interface (R14.2): <c>I&lt;Up&gt;To&lt;Down&gt;Translator</c>
    /// in the downstream context, with one fully-qualified <c>Translate</c> per ACL mapping.
    /// </summary>
    private EmittedFile EmitAclTranslator(EmitContext emit, ContextRelation r, ModelIndex index)
    {
        var iface = $"I{r.Upstream}To{r.Downstream}Translator";
        var sb = new StringBuilder();

        // Fully-qualify each mapped type with the namespace it ACTUALLY emits into (which may be a
        // module sub-namespace or a shared-kernel namespace), not the bare context name (R14.2),
        // honoring any configured context→namespace remap (R16.1).
        string Fqn(string context, string type) =>
            emit.RemapNamespace(index.NamespaceOfTypeIn(context, type) ?? context) + "." + type;

        sb.Append("/// <summary>Anti-corruption translator from upstream context ").Append(r.Upstream)
          .Append(" into ").Append(r.Downstream).Append(".</summary>\n");
        sb.Append("public interface ").Append(iface).Append("\n{\n");
        foreach (AclMapping m in r.AclMappings)
        {
            sb.Append(Indent)
              .Append(Fqn(m.LocalContext, m.LocalType))
              .Append(" Translate(")
              .Append(Fqn(m.UpstreamContext, m.UpstreamType))
              .Append(" source);\n");
        }

        sb.Append("}\n");

        return new EmittedFile(PathFor(emit, r.Downstream, KindFolder.Abstractions, $"{iface}.cs"),
            Assemble(emit, r.Downstream, sb.ToString(), usesLinq: false));
    }

    // ----------------------------------------------------------------------
    // Constructors + invariants
    // ----------------------------------------------------------------------

    private void WriteConstructor(
        StringBuilder sb,
        string typeName,
        IReadOnlyList<Member> ctorMembers,
        IReadOnlyList<BoundInvariant> invariants,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        ModelIndex index)
    {
        sb.Append(Indent).Append("public ").Append(typeName).Append('(');
        var firstParam = true;
        foreach (Member m in OrderCtorParams(ctorMembers))
        {
            if (!firstParam)
            {
                sb.Append(", ");
            }

            firstParam = false;
            AppendParam(sb, m, typeMapper, translator, index);
        }

        sb.Append(")\n");
        sb.Append(Indent).Append("{\n");

        if (RefOnly)
        {
            WriteRefStubBlockBody(sb);
            return;
        }

        WriteEnumDefaultCoalesce(sb, ctorMembers, translator, index);
        WriteInvariantGuards(sb, typeName, invariants, translator);
        if (invariants.Count > 0 && ctorMembers.Count > 0)
        {
            sb.Append('\n');
        }

        foreach (Member m in ctorMembers)
        {
            WriteAssignment(sb, m, typeMapper);
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// The value-object constructor (Commit 5): driven entirely from the lowered
    /// <see cref="BoundValueObject"/> projection. Parameter order comes from
    /// <see cref="BoundValueObject.CtorParams"/> (defaulted/optional last, owned by the lowerer rather than
    /// re-derived by <c>OrderCtorParams</c>); default dispositions from each <see cref="BoundField.DefaultKind"/>;
    /// assignments and enum-default coalesce from the stored fields in declaration order; and the guards from
    /// the folded <see cref="BoundValueObject.Invariants"/>. The emitted C# is byte-identical to the former
    /// raw-syntax path — only the source of the classification moved.
    /// </summary>
    private void WriteValueObjectConstructor(
        StringBuilder sb,
        string typeName,
        BoundValueObject bound,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        ModelIndex index)
    {
        var storedFields = bound.StoredFields.ToList();
        IReadOnlyList<BoundInvariant> invariants = bound.Invariants;

        // A value object that itself owns a value-object collection (a nested OwnsMany, issue #171) backs
        // it with a mutable list; the backing field drives the property declarations and assignments.
        var backedListFields = storedFields
            .Where(f => IsValueObjectList(((Member)f.Syntax).Type, index))
            .Select(f => f.Name)
            .ToHashSet(StringComparer.Ordinal);

        // A value object that owns any value object — a nested scalar value object (OwnsOne) or a
        // value-object collection (OwnsMany) — gains a parameterless constructor so EF can materialize it:
        // its owned navigation parameter can never bind, so EF constructs through this ctor and populates
        // members via field access (issue #276, generalizing #171's collection-only rule).
        if (storedFields.Any(f => OwnsValueObject(((Member)f.Syntax).Type, index)))
        {
            WritePersistenceConstructor(sb, typeName);
        }

        sb.Append(Indent).Append("public ").Append(typeName).Append('(');
        var firstParam = true;
        foreach (BoundField f in bound.CtorParams)
        {
            if (!firstParam)
            {
                sb.Append(", ");
            }

            firstParam = false;
            AppendParam(sb, f, typeMapper, translator, index);
        }

        sb.Append(")\n");
        sb.Append(Indent).Append("{\n");

        if (RefOnly)
        {
            WriteRefStubBlockBody(sb);
            return;
        }

        WriteEnumDefaultCoalesce(sb, storedFields, translator);
        WriteInvariantGuards(sb, typeName, invariants, translator);
        if (invariants.Count > 0 && storedFields.Count > 0)
        {
            sb.Append('\n');
        }

        foreach (BoundField f in storedFields)
        {
            WriteAssignment(sb, f, typeMapper, backed: backedListFields.Contains(f.Name));
        }

        sb.Append(Indent).Append("}\n");
    }

    private void WriteEntityConstructor(
        StringBuilder sb,
        EntityDecl entity,
        bool isRoot,
        IReadOnlyList<Member> ctorMembers,
        IReadOnlySet<string> backedListMembers,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        ModelIndex index)
    {
        // Value-object collections are backed by a mutable private list (issue #171); the all-args
        // constructor populates them via the backing field rather than the read-only property. The
        // backed-member set is classified once in EmitEntity and threaded in.

        // Every persisted aggregate root, and any entity that owns a value object (scalar OwnsOne or a
        // value-object collection), gets a parameterless constructor for the persistence layer: EF Core
        // materializes it through this ctor — an owned navigation can never bind as a constructor
        // parameter — then populates members from the store via field access (issue #276, generalizing
        // #171's value-object-collection rule).
        if (NeedsPersistenceConstructor(entity, isRoot, index))
        {
            WritePersistenceConstructor(sb, entity.Name);
        }

        // When the entity declares a factory, construction is funneled through it:
        // the all-args constructor becomes private (callable only by the static
        // factory on the same class). Without a factory, it stays public (R8.2).
        var access = entity.Factories.Count > 0 ? "private" : "public";
        sb.Append(Indent).Append(access).Append(' ').Append(entity.Name).Append('(');
        sb.Append(entity.IdentityName).Append(" id");
        foreach (Member m in OrderCtorParams(ctorMembers))
        {
            sb.Append(", ");
            AppendParam(sb, m, typeMapper, translator, index);
        }

        sb.Append(")\n");
        sb.Append(Indent).Append("{\n");

        if (RefOnly)
        {
            WriteRefStubBlockBody(sb);
            return;
        }

        WriteEnumDefaultCoalesce(sb, ctorMembers, translator, index);

        sb.Append(Indent).Append(Indent).Append("Id = id;\n");
        foreach (Member m in ctorMembers)
        {
            WriteAssignment(sb, m, typeMapper, backed: backedListMembers.Contains(m.Name));
        }

        // Invariants are validated once, through the shared CheckInvariants() method
        // (re-used after every state change), rather than inlined here. Checking after
        // assignment means the guards read the persisted properties, like the re-checks.
        if (entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            sb.Append(Indent).Append(Indent).Append("CheckInvariants();\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits the entity's single <c>CheckInvariants()</c> method: every invariant guard
    /// in one place, called by the constructor and re-invoked after each command's state
    /// change so the aggregate is valid at every observable point.
    /// </summary>
    private void WriteCheckInvariants(StringBuilder sb, EntityDecl entity, CSharpExpressionTranslator translator)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("/// <summary>Validates every invariant; run after construction and each state change.</summary>\n");
        sb.Append(Indent).Append("private void CheckInvariants()\n");
        sb.Append(Indent).Append("{\n");
        if (RefOnly)
        {
            WriteRefStubBlockBody(sb);
            return;
        }

        WriteInvariantGuards(sb, entity.Name, entity.Invariants, translator,
            CSharpExpressionTranslator.NameMode.Property);
        sb.Append(Indent).Append("}\n");
    }

    // Appends a constructor parameter directly to the builder (no intermediate per-param string
    // or string.Join). Output is byte-identical to the former string-returning FormatParam.
    private void AppendParam(StringBuilder sb, Member m, CSharpTypeMapper typeMapper, CSharpExpressionTranslator translator, ModelIndex index)
    {
        var csType = typeMapper.Map(m.Type);
        var paramName = CSharpNaming.ToCamelCase(m.Name);

        // DEFAULT-valued members keep a C# default value.
        if (m.Initializer is not null)
        {
            // A smart-enum value is NOT a compile-time constant, so an enum-typed
            // default can't be a parameter default; the param becomes nullable and
            // the body coalesces to the real default (see WriteAssignment).
            if (index.Classify(m.Type.Name) == TypeKind.Enum)
            {
                AppendNullable(sb, csType).Append(' ').Append(paramName).Append(" = null");
                return;
            }

            sb.Append(csType).Append(' ').Append(paramName).Append(" = ");
            sb.Append(translator.Translate(m.Initializer, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index)));
            return;
        }

        sb.Append(csType).Append(' ').Append(paramName);
        if (m.Type.IsOptional)
        {
            // An optional field with no initializer defaults to null (omittable).
            sb.Append(" = null");
        }
    }

    /// <summary>
    /// The value-object <see cref="BoundField"/> overload (Commit 5): the parameter's default disposition
    /// comes from the lowered <see cref="BoundField.DefaultKind"/> rather than re-classifying the member's
    /// initializer/optionality here. Byte-identical to the <see cref="Member"/> overload.
    /// </summary>
    private void AppendParam(StringBuilder sb, BoundField f, CSharpTypeMapper typeMapper, CSharpExpressionTranslator translator, ModelIndex index)
    {
        var m = (Member)f.Syntax;
        var csType = typeMapper.Map(m.Type);
        var paramName = CSharpNaming.ToCamelCase(f.Name);

        switch (f.DefaultKind)
        {
            // A smart-enum value is NOT a compile-time constant, so an enum-typed default can't be a
            // parameter default; the param becomes nullable and the body coalesces (WriteEnumDefaultCoalesce).
            case DefaultKind.EnumDefault:
                AppendNullable(sb, csType).Append(' ').Append(paramName).Append(" = null");
                break;
            case DefaultKind.ConstantDefault:
                sb.Append(csType).Append(' ').Append(paramName).Append(" = ");
                sb.Append(translator.Translate(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index)));
                break;
            case DefaultKind.OptionalNull:
                sb.Append(csType).Append(' ').Append(paramName).Append(" = null");
                break;
            default:
                sb.Append(csType).Append(' ').Append(paramName);
                break;
        }
    }

    // Appends a C# type, ensuring it is nullable (adds '?' unless already present).
    private static StringBuilder AppendNullable(StringBuilder sb, string csType) =>
        csType.EndsWith('?') ? sb.Append(csType) : sb.Append(csType).Append('?');

    private void WriteAssignment(StringBuilder sb, Member m, CSharpTypeMapper typeMapper, bool backed = false)
    {
        var param = CSharpNaming.ToCamelCase(m.Name);
        if (backed)
        {
            // A value-object collection backed by a mutable list (issue #171): copy the caller's
            // elements into the backing field (defensive copy preserved). An optional collection is
            // copied only when supplied, mirroring the read-only-copy shape's null guard.
            AppendBackingFieldPopulation(sb, m, param, typeMapper);
            return;
        }

        var prop = CSharpNaming.ToPascalCase(m.Name);
        sb.Append(Indent).Append(Indent).Append(prop).Append(" = ");
        AppendCopyExpression(sb, m.Type, param, typeMapper);
        sb.Append(";\n");
    }

    /// <summary>
    /// Populates a value-object collection's mutable backing field from its constructor parameter,
    /// preserving the defensive-copy semantics of the former read-only-copy assignment (issue #171).
    /// A required collection appends into the field-initialized list; an optional one assigns a fresh
    /// copy (or null) since its backing field is nullable and uninitialized.
    /// </summary>
    private static void AppendBackingFieldPopulation(StringBuilder sb, Member m, string param, CSharpTypeMapper typeMapper)
    {
        var field = BackingFieldName(m.Name);
        if (m.Type.IsOptional)
        {
            var elem = typeMapper.Map(m.Type.Element ?? ObjectType);
            sb.Append(Indent).Append(Indent).Append(field).Append(" = ").Append(param)
              .Append(" is null ? null : new List<").Append(elem).Append(">(").Append(param).Append(");\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append(field).Append(".AddRange(").Append(param).Append(");\n");
        }
    }

    /// <summary>
    /// The value-object <see cref="BoundField"/> overload (Commit 5): the defensive-copy decision is driven
    /// by the field's lowered <see cref="BoundField.CollectionShape"/> rather than re-classifying the type.
    /// Byte-identical to the <see cref="Member"/> overload.
    /// </summary>
    private void WriteAssignment(StringBuilder sb, BoundField f, CSharpTypeMapper typeMapper, bool backed = false)
    {
        var param = CSharpNaming.ToCamelCase(f.Name);
        if (backed)
        {
            // A nested value-object collection backed by a mutable list (issue #171): same defensive-copy
            // population as the entity overload, driven off the lowered field's syntactic member type.
            AppendBackingFieldPopulation(sb, (Member)f.Syntax, param, typeMapper);
            return;
        }

        var prop = CSharpNaming.ToPascalCase(f.Name);
        sb.Append(Indent).Append(Indent).Append(prop).Append(" = ");
        AppendCopyExpression(sb, f, param, typeMapper);
        sb.Append(";\n");
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
        foreach (Member m in ctorMembers)
        {
            if (m.Initializer is null || index.Classify(m.Type.Name) != TypeKind.Enum)
            {
                continue;
            }

            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToCamelCase(m.Name))
              .Append(" ??= ").Append(EnumDefaultValue(m, translator)).Append(";\n");
            any = true;
        }
        if (any)
        {
            sb.Append('\n');
        }
    }

    /// <summary>
    /// The value-object <see cref="BoundField"/> overload (Commit 5): emits the nullable-param coalesce for
    /// each enum-defaulted stored field, selected by <see cref="BoundField.DefaultKind"/> rather than
    /// re-classifying the member type. Byte-identical to the <see cref="Member"/> overload.
    /// </summary>
    private void WriteEnumDefaultCoalesce(StringBuilder sb, IReadOnlyList<BoundField> storedFields,
        CSharpExpressionTranslator translator)
    {
        var any = false;
        foreach (BoundField f in storedFields)
        {
            if (f.DefaultKind != DefaultKind.EnumDefault)
            {
                continue;
            }

            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToCamelCase(f.Name))
              .Append(" ??= ").Append(EnumDefaultValue((Member)f.Syntax, translator)).Append(";\n");
            any = true;
        }
        if (any)
        {
            sb.Append('\n');
        }
    }

    /// <summary>The qualified C# default value for an enum-typed defaulted member.</summary>
    private static string EnumDefaultValue(Member m, CSharpExpressionTranslator translator) =>
        m.Initializer is IdentifierExpr enumDefault
            ? $"{m.Type.Name}.{CSharpNaming.EscapeIdentifier(enumDefault.Name)}"
            : translator.Translate(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, m.Type.Name);

    /// <summary>
    /// The right-hand side that assigns a parameter to its property, defensively
    /// copying mutable collections AND wrapping the copy in a genuinely read-only
    /// view, so the exposed <c>IReadOnly*</c> property cannot be downcast back to its
    /// mutable backing store. An optional collection is copied only when non-null.
    /// <list type="bullet">
    /// <item>list -> <c>new List&lt;T&gt;(p).AsReadOnly()</c> (a <c>ReadOnlyCollection&lt;T&gt;</c>)</item>
    /// <item>set  -> <c>new ReadOnlySet&lt;T&gt;(new HashSet&lt;T&gt;(p))</c></item>
    /// <item>map  -> <c>new ReadOnlyDictionary&lt;K,V&gt;(new Dictionary&lt;K,V&gt;(p))</c></item>
    /// </list>
    /// </summary>
    private static void AppendCopyExpression(StringBuilder sb, TypeRef type, string param, CSharpTypeMapper typeMapper)
    {
        var isList = CSharpTypeMapper.IsList(type);
        var isSet = !isList && CSharpTypeMapper.IsSet(type);
        var isMap = !isList && !isSet && CSharpTypeMapper.IsMap(type);
        if (!isList && !isSet && !isMap)
        {
            sb.Append(param); // scalar: direct assignment
            return;
        }

        if (type.IsOptional)
        {
            sb.Append(param).Append(" is null ? null : ");
        }

        if (isList)
        {
            var elem = typeMapper.Map(type.Element ?? ObjectType);
            sb.Append("new List<").Append(elem).Append(">(").Append(param).Append(").AsReadOnly()");
        }
        else if (isSet)
        {
            var elem = typeMapper.Map(type.Element ?? ObjectType);
            sb.Append("new ReadOnlySet<").Append(elem).Append(">(new HashSet<").Append(elem).Append(">(").Append(param).Append("))");
        }
        else
        {
            var k = typeMapper.Map(type.Element ?? ObjectType);
            var v = typeMapper.Map(type.Value ?? ObjectType);
            sb.Append("new ReadOnlyDictionary<").Append(k).Append(", ").Append(v)
              .Append(">(new Dictionary<").Append(k).Append(", ").Append(v).Append(">(").Append(param).Append("))");
        }
    }

    /// <summary>
    /// The value-object <see cref="BoundField"/> overload (Commit 5): the list/set/map decision comes from
    /// the lowered <see cref="BoundField.CollectionShape"/> instead of re-classifying the type, while the
    /// element/value C# types and the optional-null guard are still rendered off the syntactic member type.
    /// Byte-identical to the <see cref="TypeRef"/> overload.
    /// </summary>
    private static void AppendCopyExpression(StringBuilder sb, BoundField f, string param, CSharpTypeMapper typeMapper)
    {
        var type = ((Member)f.Syntax).Type;
        if (f.CollectionShape is not (CollectionShape.List or CollectionShape.Set or CollectionShape.Map))
        {
            sb.Append(param); // scalar: direct assignment
            return;
        }

        if (type.IsOptional)
        {
            sb.Append(param).Append(" is null ? null : ");
        }

        switch (f.CollectionShape)
        {
            case CollectionShape.List:
                {
                    var elem = typeMapper.Map(type.Element ?? ObjectType);
                    sb.Append("new List<").Append(elem).Append(">(").Append(param).Append(").AsReadOnly()");
                    break;
                }
            case CollectionShape.Set:
                {
                    var elem = typeMapper.Map(type.Element ?? ObjectType);
                    sb.Append("new ReadOnlySet<").Append(elem).Append(">(new HashSet<").Append(elem).Append(">(").Append(param).Append("))");
                    break;
                }
            default: // Map
                {
                    var k = typeMapper.Map(type.Element ?? ObjectType);
                    var v = typeMapper.Map(type.Value ?? ObjectType);
                    sb.Append("new ReadOnlyDictionary<").Append(k).Append(", ").Append(v)
                      .Append(">(new Dictionary<").Append(k).Append(", ").Append(v).Append(">(").Append(param).Append("))");
                    break;
                }
        }
    }

    private static readonly TypeRef ObjectType = new("object");

    /// <summary>
    /// True when a member is a <c>List&lt;T&gt;</c> whose element is a value object — the shape the EF
    /// Core Infrastructure layer maps with <c>OwnsMany</c> (issue #171). Such a collection is backed by
    /// a mutable private <c>List&lt;T&gt;</c> so EF can materialize owned children into it, while the
    /// public surface stays a read-only <c>IReadOnlyList&lt;T&gt;</c>. Scalar (<c>String</c>/<c>Int</c>/…)
    /// and set/map collections are deliberately excluded — they keep the read-only-copy shape.
    /// </summary>
    internal static bool IsValueObjectList(TypeRef type, ModelIndex index) =>
        CSharpTypeMapper.IsList(type)
        && type.Element is { } element
        && index.Classify(element.Name) == TypeKind.Value;

    /// <summary>
    /// Classifies a member's type into the single <see cref="OwnedKind"/> that drives <b>both</b> the EF
    /// Core persistence-constructor gate (this domain emitter) and the EF mapping
    /// (<c>CSharpEmitter.Infrastructure</c>). The two decisions are the same domain question — <em>does
    /// this member own a value object, and how is it persisted?</em> — answered once here so the gate and
    /// the mapping can never drift (issue #344, deferred from the #276 review). The precedence mirrors the
    /// mapping exactly: a <c>List&lt;T&gt;</c> is a value-object collection (<c>OwnsMany</c>) when its
    /// element is a value object, otherwise an other collection (mapped by convention); a set/map is always
    /// an other collection; otherwise the scalar is classified by its declared kind — value object
    /// (<c>OwnsOne</c>), smart enum (<c>HasConversion</c>), foreign strongly-typed id (<c>HasConversion</c>),
    /// or plain primitive (<c>Property</c>).
    /// </summary>
    internal static OwnedKind ClassifyMember(TypeRef type, ModelIndex index)
    {
        if (CSharpTypeMapper.IsList(type))
        {
            return IsValueObjectList(type, index) ? OwnedKind.ValueObjectCollection : OwnedKind.OtherCollection;
        }

        if (CSharpTypeMapper.IsSet(type) || CSharpTypeMapper.IsMap(type))
        {
            return OwnedKind.OtherCollection;
        }

        return index.Classify(type.Name) switch
        {
            TypeKind.Value => OwnedKind.ScalarValueObject,
            TypeKind.Enum => OwnedKind.SmartEnum,
            _ => index.IdTypeNames.Contains(type.Name) ? OwnedKind.ForeignId : OwnedKind.Primitive,
        };
    }

    /// <summary>
    /// True when a member's type is an owned value object — a scalar value object the EF Core
    /// Infrastructure layer maps with <c>OwnsOne</c>, or a <c>List&lt;T&gt;</c> of value objects it maps
    /// with <c>OwnsMany</c> (issue #171). Scalars and set/map collections are deliberately excluded.
    /// Defined in terms of <see cref="ClassifyMember"/> so the ctor gate cannot diverge from the mapping.
    /// </summary>
    private static bool OwnsValueObject(TypeRef type, ModelIndex index) =>
        ClassifyMember(type, index) is OwnedKind.ScalarValueObject or OwnedKind.ValueObjectCollection;

    /// <summary>
    /// True when an entity needs the parameterless EF persistence constructor (issue #276, generalizing
    /// #171): it is a persisted aggregate root, or it owns any value object — a scalar value object
    /// (<c>OwnsOne</c>) or a value-object collection (<c>OwnsMany</c>). EF Core cannot bind an owned
    /// navigation as a constructor parameter, and a root's get-only members cannot be set after
    /// construction, so EF materializes through this ctor and then populates members via field access. An
    /// entity that is neither a root nor owns a value object keeps its all-args constructor alone,
    /// byte-identical to before; the #171 value-object-collection rule is now a subset of this predicate.
    /// </summary>
    private static bool NeedsPersistenceConstructor(EntityDecl entity, bool isRoot, ModelIndex index)
    {
        if (isRoot)
        {
            return true;
        }

        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        return entity.Members.Any(m => !MemberAnalysis.IsDerived(m, memberNames) && OwnsValueObject(m.Type, index));
    }

    /// <summary>The mutable backing field name for a value-object collection member (e.g. <c>_lines</c>).</summary>
    private static string BackingFieldName(string memberName) => "_" + CSharpNaming.ToCamelCase(memberName);

    /// <summary>
    /// Emits the parameterless constructor EF Core materializes an owner of a value-object collection
    /// through (issue #171): its collection parameter is a navigation and can never bind, so EF uses this
    /// ctor and then populates members from the store via their backing fields. CS8618 is suppressed for
    /// it — the "uninitialized non-nullable member" warning is a false positive under that flow.
    /// </summary>
    private void WritePersistenceConstructor(StringBuilder sb, string typeName)
    {
        sb.Append("#pragma warning disable CS8618 // EF Core populates members from the store after construction.\n");
        sb.Append(Indent).Append("private ").Append(typeName).Append("() { }\n");
        sb.Append("#pragma warning restore CS8618\n\n");
    }

    /// <summary>
    /// The members of an entity backed by a mutable list (issue #171): value-object collections that are
    /// not reassigned by a command (a reassigned field keeps the auto-property + read-only-copy shape, as
    /// the backing field has no replace path). Classified once and shared by the property declarations,
    /// the constructor assignments, and the parameterless-ctor gate so the three never drift.
    /// </summary>
    private static IReadOnlySet<string> BackedListMembers(IEnumerable<Member> ctorMembers, ModelIndex index, ISet<string> mutated) =>
        ctorMembers
            .Where(m => IsValueObjectList(m.Type, index) && !mutated.Contains(m.Name))
            .Select(m => m.Name)
            .ToHashSet(StringComparer.Ordinal);

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
        foreach (Invariant inv in invariants)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteGuard(sb, typeName, inv.Condition, inv.Message ?? SynthesizeMessage(inv.Condition), translator, mode);
        }
    }

    /// <summary>
    /// The value-object overload (Commit 4): drives the guards from the lowered
    /// <see cref="Ast.Bound.BoundInvariant"/> instead of the raw <see cref="Invariant"/>. The message is
    /// already final on the bound node (the <c>?? SourceText</c> default applied in the lowerer) and the
    /// condition is rendered from its <em>syntactic</em> origin
    /// (<see cref="Ast.Bound.BoundExpression.Syntax"/>), so the emitted C# is byte-identical to the
    /// raw-<see cref="Invariant"/> path. ADDITIVE: the entity-invariant / command-<c>requires</c>
    /// callers keep the raw-<see cref="Invariant"/> overload above.
    /// </summary>
    private void WriteInvariantGuards(
        StringBuilder sb,
        string typeName,
        IReadOnlyList<BoundInvariant> invariants,
        CSharpExpressionTranslator translator,
        CSharpExpressionTranslator.NameMode mode = CSharpExpressionTranslator.NameMode.Parameter)
    {
        var first = true;
        foreach (BoundInvariant inv in invariants)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteGuard(sb, typeName, inv, translator, mode);
        }
    }

    /// <summary>
    /// The value-object overload (Commit 4–6): renders a guard from a lowered
    /// <see cref="Ast.Bound.BoundInvariant"/>. The condition's resolved types are read from the lowered
    /// bound tree (Commit 6) — the translator no longer re-infers them — while the rendering structure
    /// walks the condition's syntactic origin (1:1 with the bound tree). The message is taken verbatim off
    /// the bound node (the C# default already applied in the lowerer). ADDITIVE: the raw-<see cref="Expr"/>
    /// overload below stays for entity/command callers.
    /// </summary>
    private void WriteGuard(
        StringBuilder sb,
        string typeName,
        BoundInvariant invariant,
        CSharpExpressionTranslator translator,
        CSharpExpressionTranslator.NameMode mode)
    {
        // Activate bound-tree type lookup for the whole condition, then render via the syntactic origin so
        // the existing guard/negation/match branches and translator are reused unchanged.
        translator.EnterBoundScope(invariant.Condition);
        try
        {
            WriteGuard(sb, typeName, (Expr)invariant.Condition.Syntax, invariant.Message, translator, mode);
        }
        finally
        {
            translator.ExitBoundScope();
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
            // Emit the idiomatic negation (`if (amount < 0)`, not `if (!(amount >= 0))`).
            var cond = translator.TranslateNegated(condition, mode);
            sb.Append(Indent).Append(Indent).Append("if (").Append(cond).Append(")\n");
        }

        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("type: nameof(").Append(typeName).Append("),\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("rule: ").Append(ruleLiteral).Append(");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
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

        // A declared return type renders the method as `public <T> Name(...)`; with no
        // declared type the command stays a `public void` (unchanged, backward-compatible).
        var returnTypeName = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : "void";

        sb.Append('\n');
        WriteXmlDoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append("public ").Append(returnTypeName).Append(' ').Append(CSharpNaming.ToPascalCase(cmd.Name))
          .Append('(').Append(paramList).Append(")\n");
        sb.Append(Indent).Append("{\n");

        if (RefOnly)
        {
            WriteRefStubBlockBody(sb);
            return;
        }

        // Command parameters are locals inside the body (members render as properties).
        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = cmd.Body.OfType<RequiresClause>().ToList();
        var transitions = cmd.Body.OfType<Transition>().ToList();
        var emits = cmd.Body.OfType<EmitClause>().ToList();
        ResultClause? result = cmd.Body.OfType<ResultClause>().FirstOrDefault();

        // 1. Preconditions — checked before any mutation.
        var firstGuard = true;
        foreach (RequiresClause req in requires)
        {
            if (!firstGuard)
            {
                sb.Append('\n');
            }

            firstGuard = false;
            WriteGuard(sb, entity.Name, req.Condition, req.Message ?? SynthesizeMessage(req.Condition),
                translator, CSharpExpressionTranslator.NameMode.Property);
        }

        // Positive renderings of the preconditions, used to suppress a state-machine
        // reachability guard that would merely restate one of them.
        var requiresConds = new HashSet<string>(
            requires.Select(r => translator.TranslateTopLevel(r.Condition, CSharpExpressionTranslator.NameMode.Property)),
            StringComparer.Ordinal);

        // 2. State transitions.
        if (requires.Count > 0 && transitions.Count > 0)
        {
            sb.Append('\n');
        }

        foreach (Transition tr in transitions)
        {
            var expectedEnum = memberTypes.TryGetValue(tr.Field, out TypeRef? ft) && index.Classify(ft.Name) == TypeKind.Enum
                ? ft.Name : null;

            // A state machine on this field guards the (literal) target's reachability —
            // unless that guard reduces to a single source check a precondition already
            // enforces, in which case it would be a verbatim duplicate.
            if (expectedEnum is not null
                && BuildStateMachineConditions(entity, tr, expectedEnum, translator, index, cmd.Parameters) is { } conds
                && !(conds.Count == 1 && requiresConds.Contains(conds[0].Positive)))
            {
                WriteStateMachineGuard(sb, entity, conds, tr.Field, ((IdentifierExpr)tr.Value).Name);
            }

            var value = translator.TranslateTopLevel(tr.Value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToPascalCase(tr.Field))
              .Append(" = ").Append(value).Append(";\n");
        }

        // Translate the result expression in the same scope as emit payloads (parameters
        // as locals, members as properties) so it can reference parameters, `id`, and
        // just-assigned fields. If the same value also appears as a WHOLE emit argument,
        // hoist it into a single `var __result` so it is computed once (single source of
        // truth). The match is per-argument and exact — not a substring of the rendered
        // statement — so a sibling argument sharing a prefix (e.g. `TaxRate` vs a `Tax`
        // result) is left untouched.
        string? resultExpr = result is null ? null
            : translator.TranslateTopLevel(
                result.Value, CSharpExpressionTranslator.NameMode.Property, cmd.ReturnType?.Name);

        // Translate the emit statements while parameters are still in scope (their
        // payloads may reference parameters); they are written AFTER the re-check so
        // an invalid post-state throws before any event is recorded.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "", resultExpr)).ToList();
        bool hoistResult = emitStatements.Any(s => s.Hoisted);

        // Parameters leave scope BEFORE the re-check: entity invariants reference
        // only entity state, which must render as the just-assigned properties (not
        // a parameter that happens to share a field's name).
        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        // 3. Re-check every entity invariant after the state change (one shared method).
        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            sb.Append(Indent).Append(Indent).Append("CheckInvariants();\n");
        }

        // 4. Compute the hoisted result (once) BEFORE the events so an emit payload can
        // carry the same value without recomputing it.
        if (hoistResult)
        {
            sb.Append('\n');
            sb.Append(Indent).Append(Indent).Append("var __result = ").Append(resultExpr).Append(";\n");
        }

        // 5. Record domain events (only reached if preconditions + re-check pass).
        if (emitStatements.Count > 0)
        {
            if (!hoistResult)
            {
                sb.Append('\n');
            }

            foreach (var stmt in emitStatements)
            {
                sb.Append(Indent).Append(Indent).Append(stmt.Text).Append('\n');
            }
        }

        // 6. Return the result value — the terminal statement, reached only from a
        // fully-valid, fully-eventful aggregate.
        if (result is not null)
        {
            sb.Append('\n');
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(hoistResult ? "__result" : resultExpr).Append(";\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits a reachability guard for a state-machine-governed transition with a
    /// literal target: the current state must be a source that can reach the target
    /// (optionally satisfying that rule's guard), else throw.
    /// </summary>
    /// <summary>One legal source of a transition: the positive reachability check and its negation.</summary>
    private readonly record struct StateSource(string Positive, string Negated);

    private List<StateSource>? BuildStateMachineConditions(
        EntityDecl entity, Transition tr, string enumType,
        CSharpExpressionTranslator translator, ModelIndex index, IReadOnlyList<Param> commandParams)
    {
        StatesDecl? states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || tr.Value is not IdentifierExpr stateRef
            || !index.EnumsDeclaring(stateRef.Name).Contains(enumType))
        {
            return null; // no state machine, or a dynamic (non-literal) target
        }

        var sources = states.Rules.Where(r => r.To.Contains(stateRef.Name)).ToList();
        if (sources.Count == 0)
        {
            return null; // unreachable target — already a semantic error (KOI0703)
        }

        var prop = CSharpNaming.ToPascalCase(tr.Field);

        // A state-rule guard is validated against entity members only, so it must
        // render with command parameters out of scope: a parameter sharing a member's
        // name would otherwise shadow it (and be read instead of the persisted state).
        foreach (Param p in commandParams)
        {
            translator.PopLocal(p.Name);
        }

        var conditions = sources.Select(r =>
        {
            var fromMember = CSharpNaming.EscapeIdentifier(r.From);
            var srcEq = $"{prop} == {enumType}.{fromMember}";
            if (r.Guard is null)
            // A bare source: its negation is the simple `!=` (no wrapping needed).
            {
                return new StateSource(srcEq, $"{prop} != {enumType}.{fromMember}");
            }

            // A guarded source: keep the binary guard's parentheses (Translate, not
            // TranslateTopLevel) so an OR guard binds below the && joining the source check.
            var positive = $"{srcEq} && {translator.Translate(r.Guard, CSharpExpressionTranslator.NameMode.Property)}";
            return new StateSource(positive, $"!({positive})");
        }).ToList();
        foreach (Param p in commandParams)
        {
            translator.PushLocal(p.Name);
        }

        return conditions;
    }

    /// <summary>
    /// Emits a reachability guard from prebuilt source conditions: the transition is
    /// illegal unless the current state is one of the legal sources. The check is the
    /// De Morgan negation — <c>!(a || b || c)</c> rendered as <c>!a &amp;&amp; !b &amp;&amp; !c</c> —
    /// so it reads as a plain "is none of these" test with no nested-paren negation.
    /// </summary>
    private void WriteStateMachineGuard(
        StringBuilder sb, EntityDecl entity, IReadOnlyList<StateSource> conditions, string field, string targetState)
    {
        var test = string.Join(" && ", conditions.Select(c => c.Negated));
        sb.Append(Indent).Append(Indent).Append("if (").Append(test).Append(")\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(entity.Name).Append("),\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("rule: \"illegal transition of ").Append(field).Append(" to ").Append(targetState).Append("\");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits a factory as a <c>public static</c> method on the aggregate root:
    /// preconditions, the new aggregate's identity, construction, then creation events.
    /// Identity is auto-generated (<c>OrderId.New()</c>) by default; when the factory supplies it as an
    /// explicit identity-typed parameter (#324, <see cref="MemberAnalysis.ExplicitIdParameter"/>) the
    /// synthetic <c>id</c> binds to that parameter instead (no <c>New()</c> — the only generator a
    /// non-Guid key has would be undefined). Constructor arguments are drawn from <c>field &lt;- expr</c>
    /// initializations, falling back to the constructor's own defaults (or <c>default!</c> for a
    /// required, uninitialized field — already flagged by KOI0806).
    /// </summary>
    private void WriteFactory(
        StringBuilder sb,
        EntityDecl entity,
        FactoryDecl factory,
        IReadOnlyList<Member> ctorMembers,
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

        if (RefOnly)
        {
            WriteRefStubBlockBody(sb);
            return;
        }

        // Factory scope: the synthetic `id` and the factory's parameters are locals
        // (entity members are not in scope — the aggregate does not exist yet).
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = factory.Body.OfType<RequiresClause>().ToList();
        var inits = factory.Body.OfType<Initialization>().ToList();
        var emits = factory.Body.OfType<EmitClause>().ToList();

        // 1. Identity, declared first so it is in scope for the preconditions and payloads (New()/the
        //    parameter have no side effects); the aggregate is still not constructed until step 3,
        //    satisfying "checked before construction". By default it is auto-generated
        //    (<Id>.New()). When the factory supplies the identity as an explicit identity-typed
        //    parameter (#324), bind the synthetic `id` to that parameter instead of minting: if the
        //    parameter is literally named `id` it already provides the local (emit nothing); otherwise
        //    alias it (`var id = bookId;`).
        FactoryIdBinding idBinding = FactoryIdBinding.ResolveFactoryId(entity, factory, CSharpNaming.ToCamelCase);
        switch (idBinding.Source)
        {
            case FactoryIdSource.Generate:
                sb.Append(Indent).Append(Indent).Append("var id = ").Append(entity.IdentityName).Append(".New();\n");
                break;
            case FactoryIdSource.Alias:
                sb.Append(Indent).Append(Indent).Append("var id = ").Append(idBinding.AliasFrom).Append(";\n");
                break;
            case FactoryIdSource.ParamProvidesIdDirectly:
                // The `id` parameter already provides the local — emit nothing.
                break;
        }

        // 2. Preconditions — checked before any state is constructed.
        if (requires.Count > 0)
        {
            sb.Append('\n');
        }

        var firstGuard = true;
        foreach (RequiresClause req in requires)
        {
            if (!firstGuard)
            {
                sb.Append('\n');
            }

            firstGuard = false;
            WriteGuard(sb, entity.Name, req.Condition, req.Message ?? SynthesizeMessage(req.Condition),
                translator, CSharpExpressionTranslator.NameMode.Property);
        }
        if (requires.Count > 0)
        {
            sb.Append('\n');
        }

        // 3. Construct. Each ctor member draws its value, in priority order, from: an
        //    explicit `field <- expr` (named arg); a same-named parameter (auto-bind);
        //    the constructor's own default; or `default!` when required+unset (KOI0806).
        // First-wins on a (validation-rejected) duplicate init, so emission never throws.
        var initByField = new Dictionary<string, Expr>(StringComparer.Ordinal);
        foreach (Initialization i in inits)
        {
            initByField.TryAdd(i.Field, i.Value);
        }

        var args = new List<string> { "id" };
        foreach (Member m in ctorMembers)
        {
            var paramName = CSharpNaming.ToCamelCase(m.Name);
            if (initByField.TryGetValue(m.Name, out Expr? value))
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
        // Factories have no `result` clause, so there is nothing to hoist — take the text only.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "instance.").Text).ToList();

        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        translator.PopLocal("id");

        foreach (var stmt in emitStatements)
        {
            sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');
        }

        sb.Append(Indent).Append(Indent).Append("return instance;\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>True when any command or factory of the entity emits a domain event.</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>
    /// Builds the <c>[prefix]_domainEvents.Add(new EventName(...));</c> statement for an emit. When
    /// <paramref name="hoistedResultExpr"/> is supplied, any argument whose WHOLE rendered form
    /// equals it is replaced with the <c>__result</c> local and <c>Hoisted</c> is returned true, so
    /// the caller knows to emit the <c>var __result = …;</c> binding (single source of truth).
    /// </summary>
    private (string Text, bool Hoisted) BuildEmitStatement(
        EmitClause emit, CSharpExpressionTranslator translator, ModelIndex index,
        string targetPrefix = "", string? hoistedResultExpr = null)
    {
        if (!index.TryGetDecl(emit.EventName, out TypeDecl decl) || decl is not EventDecl ev)
        {
            return ($"/* unknown event '{emit.EventName}' */", false);
        }

        var eventMemberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Match the constructor's parameter order (OrderCtorParams moves defaulted/
        // optional fields last), not the declaration order, so positional args bind.
        var ctorFields = OrderCtorParams(ev.Members.Where(m => !MemberAnalysis.IsDerived(m, eventMemberNames))).ToList();
        var argByField = emit.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);

        bool hoisted = false;
        var args = ctorFields.Select(f =>
        {
            if (!argByField.TryGetValue(f.Name, out Expr? value))
            {
                return "default!"; // validator guarantees presence; defensive
            }

            var expectedEnum = index.Classify(f.Type.Name) == TypeKind.Enum ? f.Type.Name : null;
            var rendered = translator.TranslateTopLevel(value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
            // Substitute the hoisted local only when the WHOLE argument is the result expression; a
            // substring match (a sibling argument sharing a prefix) must NOT be rewritten.
            if (hoistedResultExpr is not null && string.Equals(rendered, hoistedResultExpr, StringComparison.Ordinal))
            {
                hoisted = true;
                return "__result";
            }
            return rendered;
        }).ToList();

        return ($"{targetPrefix}_domainEvents.Add(new {ev.Name}({string.Join(", ", args)}));", hoisted);
    }

    /// <summary>
    /// Synthesizes a readable rule message from an unmessaged invariant. The Koine-source round-trip
    /// (<see cref="Ast.Bound.Lowerer.SourceText"/>) was relocated VERBATIM into <c>Ast/Bound/</c>
    /// (it renders Koine syntax only — target-agnostic) and is the C# message default the bound
    /// VO-invariant slice now produces; the still-syntactic entity-invariant / command-<c>requires</c>
    /// paths call it directly here.
    /// </summary>
    private static string SynthesizeMessage(Expr condition) => Lowerer.SourceText(condition);

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
    private string Assemble(EmitContext emit, string ns, string body, bool usesLinq) =>
        Assemble(emit, ns, body, usesLinq, declSpan: SourceSpan.None, out _);

    /// <summary>
    /// <see cref="Assemble(EmitContext, string, string, bool)"/> with explicit extra <c>using</c>s the
    /// body's token scan cannot infer: the opt-in Application layer's third-party imports (issue #129:
    /// FluentValidation, MediatR, DI) and the Infrastructure layer's EF Core / DI namespaces (issue #128).
    /// Source maps are not emitted for generated orchestration (it has no single <c>.koi</c> origin span).
    /// </summary>
    private string Assemble(EmitContext emit, string ns, string body, bool usesLinq, IEnumerable<string> extraUsings) =>
        Assemble(emit, ns, body, usesLinq, declSpan: SourceSpan.None, out _, extraUsings);

    /// <summary>
    /// <see cref="Assemble(EmitContext, string, string, bool)"/> with optional source-map output.
    /// When <see cref="CSharpEmitterOptions.EmitSourceMaps"/> is on AND <paramref name="declSpan"/>
    /// is a real source range, a <c>#line N "&lt;file&gt;"</c> directive is stamped immediately
    /// before the declaration body (so debuggers/stack traces attribute the body to its <c>.koi</c>
    /// origin), a <c>#line default</c> resumes generated-line numbering afterwards, and a single
    /// <see cref="SourceMapSegment"/> mapping the body's generated line range → <paramref name="declSpan"/>
    /// is returned via <paramref name="sourceMap"/>. Otherwise (the default) no directives are emitted
    /// and <paramref name="sourceMap"/> is <c>null</c>, so output is byte-identical to the historical
    /// emitter — the flag-off path never touches the builder.
    /// </summary>
    private string Assemble(
        EmitContext emit, string ns, string body, bool usesLinq,
        SourceSpan declSpan, out IReadOnlyList<SourceMapSegment>? sourceMap,
        IEnumerable<string>? extraUsings = null)
    {
        // Usings are derived from data — a UsingCollector that maps runtime/BCL markers and
        // cross-namespace user-type references to their namespaces — rather than a fixed block,
        // so files carry no unused imports.
        var collector = new UsingCollector();
        collector.CollectRuntimeNamespaces(ns, body, usesLinq);

        // The opt-in Application (issue #129) and Infrastructure (issue #128) layers reference
        // namespaces the marker scan can't derive — FluentValidation/MediatR/DI for application,
        // EF Core/DI for infrastructure — so callers pass them explicitly. Always null on the default
        // paths, so non-layered output stays byte-identical.
        if (extraUsings is not null)
        {
            foreach (var u in extraUsings)
            {
                collector.AddNamespace(u);
            }
        }

        // Cross-namespace user-type references (other contexts via imports, and other
        // modules of the same context) emit unqualified, so a precise `using` is added for
        // each referenced type's namespace (R13.2/R13.3). Qualified refs emit fully-qualified
        // and need none. The runtime files never reference user types.
        // The namespace this file emits into, after any configured context→namespace remap
        // (R16.1). Cross-context `using`s and the namespace declaration are computed against
        // the remapped form so a relocated context is referenced by its new namespace everywhere.
        var emittedNs = emit.RemapNamespace(ns);

        var context = ns.Split('.')[0];
        if (emit.ContextNames.Contains(context))
        {
            collector.CollectUserTypeNamespaces(emittedNs, body, RemapNamespaces(emit, emit.Index.VisibleTypeNamespaces(context)));
        }
        // A shared-kernel file lives in a synthetic namespace (not a real context); resolve its
        // cross-namespace references against its partner contexts' visible types (R14.2).
        else if (emit.Index.IsKernelNamespace(ns))
        {
            collector.CollectUserTypeNamespaces(emittedNs, body, RemapNamespaces(emit, emit.Index.KernelVisibleTypeNamespaces(ns)));
        }

        var sb = new StringBuilder();
        sb.Append("// <auto-generated/>\n");
        // Generated files opt out of the project's nullable context, so re-enable it
        // explicitly — our signatures use nullable annotations (e.g. string?, object?).
        sb.Append("#nullable enable\n\n");
        foreach (var u in collector.ToSortedUsings())
        {
            sb.Append("using ").Append(u).Append(";\n");
        }

        if (collector.Count > 0)
        {
            sb.Append('\n');
        }

        sb.Append("namespace ").Append(emittedNs).Append(";\n\n");

        // Source maps are off by default: the flag-off path appends the body verbatim and reports
        // no map, so emitted text stays byte-for-byte identical to the historical emitter.
        if (!emit.Options.EmitSourceMaps || declSpan.IsNone)
        {
            sb.Append(body);
            sourceMap = null;
            return sb.ToString();
        }

        // Source maps on: stamp a `#line` directive pointing the body's generated lines at the
        // declaration's `.koi` origin, then `#line default` so generated-only trailing lines aren't
        // misattributed, and record the body's generated line range as one segment.
        var sourceFile = declSpan.File ?? ns;
        // `#line` takes a C# string literal, so backslashes and quotes in the path must be escaped or
        // a Windows path (e.g. C:\models\x.koi) or a quoted path would produce uncompilable output.
        var sourceLiteral = sourceFile.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);

        // `CountLines` already returns the 1-based line the builder cursor is on (newlines + 1), i.e.
        // the line the `#line` directive itself is written on; the body therefore begins on the very
        // next line.
        var linesBefore = CountLines(sb);
        sb.Append("#line ").Append(declSpan.Line).Append(" \"").Append(sourceLiteral).Append("\"\n");
        var generatedStart = linesBefore + 1; // line after the directive (1-based)

        sb.Append(body);
        // Body line count: a body always ends with a trailing newline, so its rendered lines are the
        // newline count (the empty piece after the final '\n' is the next line, not part of the body).
        var bodyLines = CountNewlines(body);
        var generatedEnd = generatedStart + Math.Max(0, bodyLines - 1);

        sb.Append("#line default\n");

        sourceMap = new[]
        {
            new SourceMapSegment(generatedStart, generatedEnd, sourceFile, declSpan),
        };
        return sb.ToString();
    }

    /// <summary>1-based count of the line the builder is currently on (number of newlines + 1).</summary>
    private static int CountLines(StringBuilder sb) => CountNewlinesIn(sb) + 1;

    private static int CountNewlinesIn(StringBuilder sb)
    {
        var count = 0;
        for (var i = 0; i < sb.Length; i++)
        {
            if (sb[i] == '\n')
            {
                count++;
            }
        }

        return count;
    }

    private static int CountNewlines(string s)
    {
        var count = 0;
        foreach (var c in s)
        {
            if (c == '\n')
            {
                count++;
            }
        }

        return count;
    }

    /// <summary>
    /// Remaps the namespace values of a visible-type map through <see cref="EmitContext.RemapNamespace"/>
    /// (R16.1), so a cross-context <c>using</c> targets a relocated context's emitted namespace.
    /// The type names (keys) are unchanged. A no-op (returns the same entries) when no map is configured.
    /// </summary>
    private static IEnumerable<KeyValuePair<string, string>> RemapNamespaces(
        EmitContext emit, IEnumerable<KeyValuePair<string, string>> visibleTypes) =>
        // No remapping configured (the default): hand back the source untouched rather than
        // allocating an iterator that re-wraps every entry once per emitted file.
        emit.Options.NamespaceMap.Count == 0 ? visibleTypes : RemapNamespacesCore(emit, visibleTypes);

    private static IEnumerable<KeyValuePair<string, string>> RemapNamespacesCore(
        EmitContext emit, IEnumerable<KeyValuePair<string, string>> visibleTypes)
    {
        foreach (var (name, typeNs) in visibleTypes)
        {
            yield return new KeyValuePair<string, string>(name, emit.RemapNamespace(typeNs));
        }
    }

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

    private static bool ExprUsesLinq(Expr expr) => LinqUsageVisitor.Instance.Visit(expr);

    /// <summary>Renders a target-agnostic doc string as a C# XML <c>&lt;summary&gt;</c>.</summary>
    private static void WriteXmlDoc(StringBuilder sb, string? doc, string indent)
    {
        if (string.IsNullOrEmpty(doc))
        {
            return;
        }

        var lines = doc.Split('\n');
        if (lines.Length == 1)
        {
            sb.Append(indent).Append("/// <summary>").Append(EscapeXml(lines[0])).Append("</summary>\n");
            return;
        }

        sb.Append(indent).Append("/// <summary>\n");
        foreach (var line in lines)
        {
            sb.Append(indent).Append("/// ").Append(EscapeXml(line)).Append('\n');
        }

        sb.Append(indent).Append("/// </summary>\n");
    }

    private static readonly SearchValues<char> XmlEscapeChars = SearchValues.Create("&<>");

    private static string EscapeXml(string s) =>
        // Fast path (the common case): nothing to escape -> return as-is, no Replace allocations.
        s.AsSpan().IndexOfAny(XmlEscapeChars) < 0
            ? s
            : s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    /// <summary>
    /// Renders a target-agnostic <c>@deprecated("reason")</c> annotation (R15.1) as a C#
    /// <c>[Obsolete("reason")]</c> attribute on the following type or property. No-op when
    /// the declaration is not deprecated.
    /// </summary>
    private static void WriteObsolete(StringBuilder sb, string? reason, string indent)
    {
        if (string.IsNullOrEmpty(reason))
        {
            return;
        }

        sb.Append(indent).Append("[Obsolete(\"").Append(EscapeCSharpString(reason)).Append("\")]\n");
    }

    /// <summary>Escapes a string for embedding in a C# double-quoted literal.</summary>
    private static readonly SearchValues<char> CSharpStringEscapeChars = SearchValues.Create("\\\"\n\r\t");

    private static string EscapeCSharpString(string s) =>
        s.AsSpan().IndexOfAny(CSharpStringEscapeChars) < 0
            ? s
            : s.Replace("\\", "\\\\").Replace("\"", "\\\"")
               .Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");

    private static void AppendComment(StringBuilder sb, string? comment)
    {
        if (!string.IsNullOrEmpty(comment))
        {
            sb.Append("  // ").Append(comment);
        }
    }

    /// <summary>Maps a namespace to its emit folder path.</summary>
    private static string FolderFor(string ns) => ns.Replace('.', '/');

    /// <summary>
    /// Builds the output path for a generated file: the namespace folder, an
    /// optional DDD building-block subfolder (e.g. "Entities", "ValueObjects"),
    /// and the file name. An empty <paramref name="kindFolder"/> places the file
    /// at the namespace root — used for aggregate roots (the aggregate is the
    /// context's entry point) and for runtime support types. The folder reflects any
    /// configured context→namespace remap (R16.1), staying in step with the declaration.
    /// </summary>
    private static string PathFor(EmitContext emit, string ns, string kindFolder, string fileName)
    {
        var folder = FolderFor(emit.RemapNamespace(ns));
        return kindFolder.Length == 0
            ? $"{folder}/{fileName}"
            : $"{folder}/{kindFolder}/{fileName}";
    }

    /// <summary>The DDD building-block subfolders generated files are grouped into.</summary>
    private static class KindFolder
    {
        public const string Root = "";
        public const string Entities = "Entities";
        public const string ValueObjects = "ValueObjects";
        public const string Enums = "Enums";
        public const string Events = "Events";
        public const string IntegrationEvents = "IntegrationEvents";
        public const string ReadModels = "ReadModels";
        public const string Queries = "Queries";
        public const string Services = "Services";
        public const string Specifications = "Specifications";
        public const string Policies = "Policies";
        public const string Repositories = "Repositories";
        public const string Abstractions = "Abstractions";

        /// <summary>The opt-in Application layer (issue #129).</summary>
        public const string Application = "Application";

        /// <summary>The opt-in EF Core infrastructure layer (issue #128).</summary>
        public const string Infrastructure = "Infrastructure";
    }

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
        foreach (EntityDecl e in ctx.AllEntities())
        {
            owned[e.IdentityName] = e;
        }

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
            {
                continue;
            }

            // Only emit it if it is referenced within this context.
            if (IsReferencedInContext(ctx, idName))
            {
                seen.Add(idName);
            }
        }
        return seen;
    }

    private static bool IsReferencedInContext(ContextNode ctx, string idName) =>
        ModelIndex.AllTypeRefsIn(ctx).Any(tr => TypeRefMentions(tr, idName));

    private static bool TypeRefMentions(TypeRef type, string name)
    {
        if (type.Name == name)
        {
            return true;
        }

        return (type.Element is not null && TypeRefMentions(type.Element, name))
               || (type.Value is not null && TypeRefMentions(type.Value, name));
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
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl t in ctx.AllTypeDecls())
            {
                if (t is EnumDecl e)
                {
                    foreach (var member in e.MemberNames)
                    {
                        map[member] = e.Name; // last writer wins; v0 assumes unique members
                    }
                }
            }
        }

        return map;
    }
}

/// <summary>
/// How a persisted member is owned and mapped — the single classification both the domain
/// persistence-constructor gate and the infrastructure EF mapping consume, so they cannot drift
/// (issue #344). Produced by <see cref="CSharpEmitter.ClassifyMember"/>.
/// </summary>
internal enum OwnedKind
{
    /// <summary>A plain primitive scalar — mapped with an explicit <c>Property</c>.</summary>
    Primitive,

    /// <summary>A foreign strongly-typed id (e.g. <c>customer: CustomerId</c>) — mapped with a value <c>HasConversion</c>.</summary>
    ForeignId,

    /// <summary>A smart-enum scalar — mapped with the shared <c>ValueConverter</c> via <c>HasConversion</c>.</summary>
    SmartEnum,

    /// <summary>A scalar value object — mapped as an owned type with <c>OwnsOne</c>.</summary>
    ScalarValueObject,

    /// <summary>A <c>List&lt;T&gt;</c> of value objects — mapped as an owned collection with <c>OwnsMany</c> (issue #171).</summary>
    ValueObjectCollection,

    /// <summary>Any other collection (primitive list, set, or map) — mapped by EF Core convention.</summary>
    OtherCollection,
}
