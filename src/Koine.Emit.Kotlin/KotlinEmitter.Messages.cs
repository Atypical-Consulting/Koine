using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The events / repository slice of <see cref="KotlinEmitter"/>. A Koine <c>event</c> (and cross-boundary
/// <c>integration event</c>) emits as an immutable <c>data class</c> implementing the per-context
/// <c>DomainEvent</c> — events carry no invariants, so a plain data class is the idiomatic shape (a member-less
/// event becomes a plain <c>class</c>, since a Kotlin data class needs at least one component). Every event of
/// a context is collected into a <c>sealed interface DomainEvent</c>, the closed sum the entity slice's
/// recorded-events list (<c>MutableList&lt;DomainEvent&gt;</c>) is typed on — Kotlin infers the permitted
/// implementers from the shared package, so no <c>permits</c> clause is owed. An aggregate root's
/// <c>repository</c> block emits as a persistence-ignorant <c>interface</c> (<c>getById</c> returns the
/// nullable <c>Root?</c>, Kotlin's Optional), and any identity referenced in a context but not owned by a local
/// entity is materialized as a minimal branded <c>value class</c> so the reference resolves.
/// <para>
/// The event data class's primary constructor is the declared members <b>in declaration order</b>: the entity
/// slice lowers <c>emit E(a, b)</c> to a positional <c>E(a, b)</c>, so any reordering here would break those
/// constructions. Mirrors the Java sibling's <c>JavaEmitter.Events.cs</c> laid out the Kotlin way.
/// </para>
/// </summary>
public sealed partial class KotlinEmitter
{
    /// <summary>The mutating + query operations a repository exposes when none are listed (R11.3).</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    // ----------------------------------------------------------------------
    // Events + integration events -> data classes implementing DomainEvent
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a domain or integration event as an immutable <c>data class</c> whose components are the declared
    /// members <b>in declaration order</b> and which implements the per-context <c>DomainEvent</c> sealed
    /// interface. A member-less event becomes a plain <c>class</c> (a data class needs at least one component).
    /// The declaration order is load-bearing: the entity slice constructs an emitted event positionally.
    /// </summary>
    private EmittedFile EmitEvent(KotlinEmitContext emit, string context, string name, IReadOnlyList<Member> members)
    {
        var typeName = KotlinNaming.ToTypeName(name);
        var typeMapper = new KotlinTypeMapper(emit.Index, context, PackageFor);

        var sb = new StringBuilder();
        if (members.Count == 0)
        {
            // A Kotlin data class needs at least one primary-constructor parameter; a member-less event is a
            // plain class, still constructed positionally as `EventName()` by the entity slice.
            sb.Append("class ").Append(typeName).Append(" : DomainEvent\n");
            return TypeFile(context, typeName, sb.ToString());
        }

        sb.Append("data class ").Append(typeName).Append("(\n");
        foreach (Member m in members)
        {
            sb.Append(Indent).Append("val ").Append(KotlinNaming.ToMemberName(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(",\n");
        }

        sb.Append(") : DomainEvent\n");
        return TypeFile(context, typeName, sb.ToString());
    }

    // ----------------------------------------------------------------------
    // Per-context extras: the DomainEvent sum + foreign/unowned identity value classes
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits the per-context extras that are not a single top-level declaration: the <c>DomainEvent</c> sealed
    /// interface over the context's events, and a branded value class for every identity referenced in the
    /// context but not owned by a local entity (so a foreign <c>CustomerId</c> field type resolves). Called once
    /// per context after its declarations are dispatched by <see cref="EmitType"/>.
    /// </summary>
    private void EmitContextExtras(KotlinEmitContext emit, List<EmittedFile> files, ContextNode ctx)
    {
        if (EmitDomainEventInterface(ctx) is { } domainEvent)
        {
            files.Add(domainEvent);
        }

        foreach (var idName in OrderedUnownedIds(ctx, emit.Index))
        {
            files.Add(EmitUnownedId(emit, ctx.Name, idName));
        }
    }

    /// <summary>
    /// Emits the context-wide <c>sealed interface DomainEvent</c> — the closed sum the entity slice's
    /// recorded-events list is typed on — that every domain and integration event of the context implements.
    /// Returns <c>null</c> (no empty interface) when the context declares no events. Kotlin infers the permitted
    /// implementers from the shared package, so no explicit <c>permits</c> clause is written.
    /// </summary>
    private EmittedFile? EmitDomainEventInterface(ContextNode ctx)
    {
        var hasEvents = ctx.AllTypeDecls().Any(t => t is EventDecl or IntegrationEventDecl);
        if (!hasEvents)
        {
            return null;
        }

        var sb = new StringBuilder();
        WriteKdoc(sb, "Every domain event this context can raise — a sealed sum a recorded-events list can hold.", string.Empty);
        sb.Append("sealed interface DomainEvent\n");
        return TypeFile(ctx.Name, "DomainEvent", sb.ToString());
    }

    /// <summary>
    /// Emits a minimal branded identity <c>value class</c> for an id referenced in a context but not owned by a
    /// local entity (e.g. a foreign <c>CustomerId</c> used as a field type), so the reference resolves. The
    /// backing follows the owning entity when the model declares it anywhere, else defaults to a
    /// <c>java.util.UUID</c> brand (the Guid default). No validation — a re-materialized reference, not the
    /// owner's canonical identity.
    /// </summary>
    private EmittedFile EmitUnownedId(KotlinEmitContext emit, string context, string idName)
    {
        var typeName = KotlinNaming.ToTypeName(idName);
        var kotlinType = UnownedIdBackingType(emit, idName);

        var sb = new StringBuilder();
        WriteKdoc(sb, "A strongly-typed identity value referenced by this context but owned elsewhere.", string.Empty);
        sb.Append("@JvmInline\n");
        sb.Append("value class ").Append(typeName).Append("(val value: ").Append(kotlinType).Append(")\n");
        return TypeFile(context, typeName, sb.ToString());
    }

    /// <summary>The Kotlin backing type of an unowned identity: the owning entity's backing when the model declares one, else a <c>java.util.UUID</c> brand.</summary>
    private static string UnownedIdBackingType(KotlinEmitContext emit, string idName)
    {
        EntityDecl? owner = emit.Index.Model.Contexts
            .SelectMany(c => c.AllEntities())
            .FirstOrDefault(e => string.Equals(e.IdentityName, idName, StringComparison.Ordinal));
        return owner is null ? "java.util.UUID" : KotlinIdBacking(owner).KotlinType;
    }

    /// <summary>
    /// The identity types referenced in a context but not owned by any of its entities (e.g. a foreign
    /// <c>CustomerId</c> field type), in deterministic order — materialized as branded value classes so the
    /// references resolve.
    /// </summary>
    private static IEnumerable<string> OrderedUnownedIds(ContextNode ctx, ModelIndex index)
    {
        var owned = new HashSet<string>(ctx.AllEntities().Select(e => e.IdentityName), StringComparer.Ordinal);
        var seen = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var idName in index.IdTypeNames)
        {
            if (!owned.Contains(idName) && IsReferencedInContext(ctx, idName))
            {
                seen.Add(idName);
            }
        }

        return seen;
    }

    /// <summary>True when <paramref name="idName"/> is named by any type reference in the context (a field, event payload, command/factory parameter, or repository finder parameter).</summary>
    private static bool IsReferencedInContext(ContextNode ctx, string idName)
    {
        foreach (TypeDecl t in ctx.AllTypeDecls())
        {
            IEnumerable<TypeRef> types = t switch
            {
                ValueObjectDecl v => v.Members.Select(m => m.Type),
                EntityDecl e => e.Members.Select(m => m.Type)
                    .Concat(e.Commands.SelectMany(c => c.Parameters.Select(p => p.Type)))
                    .Concat(e.Factories.SelectMany(f => f.Parameters.Select(p => p.Type))),
                EventDecl ev => ev.Members.Select(m => m.Type),
                IntegrationEventDecl iev => iev.Members.Select(m => m.Type),
                AggregateDecl agg => (agg.Repository?.Finders ?? Array.Empty<FinderDecl>())
                    .SelectMany(f => f.Parameters.Select(p => p.Type)),
                _ => Array.Empty<TypeRef>(),
            };

            if (types.Any(tr => TypeRefMentions(tr, idName)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>True when a type reference names <paramref name="name"/> at the top level or in a type argument (list element, map key/value).</summary>
    private static bool TypeRefMentions(TypeRef type, string name) =>
        type.Name == name
        || (type.Element is not null && TypeRefMentions(type.Element, name))
        || (type.Value is not null && TypeRefMentions(type.Value, name));

    // ----------------------------------------------------------------------
    // Repositories -> interfaces (aggregate extras)
    // ----------------------------------------------------------------------

    /// <summary>Emits the aggregate root's persistence-ignorant repository <c>interface</c>; a no-op when the root cannot be resolved.</summary>
    private void EmitAggregateExtras(KotlinEmitContext emit, List<EmittedFile> files, string context, AggregateDecl agg)
    {
        if (EmitRepository(emit, context, agg) is { } repository)
        {
            files.Add(repository);
        }
    }

    /// <summary>
    /// Emits the <c>&lt;Root&gt;Repository</c> interface for an aggregate: the fundamental <c>getById</c> lookup
    /// returning the nullable <c>Root?</c> (Kotlin's Optional), the configured mutating operations (R11.3,
    /// default add/update/remove), and any declarative finders (a list finder returns <c>List&lt;Root&gt;</c>, a
    /// single finder <c>Root?</c>). Keyed on the root's branded ID. Returns <c>null</c> when the root cannot be
    /// resolved.
    /// </summary>
    private EmittedFile? EmitRepository(KotlinEmitContext emit, string context, AggregateDecl agg)
    {
        EntityDecl? root = agg.RootEntity();
        if (root is null)
        {
            return null;
        }

        var typeMapper = new KotlinTypeMapper(emit.Index, context, PackageFor);
        var rootName = KotlinNaming.ToTypeName(root.Name);
        var idType = KotlinNaming.ToTypeName(root.IdentityName);
        var iface = rootName + "Repository";
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();

        var sb = new StringBuilder();
        WriteKdoc(sb, "Persistence-ignorant repository contract for the " + rootName + " aggregate root.", string.Empty);
        sb.Append("interface ").Append(iface).Append(" {\n");

        var first = true;
        void Gap()
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
        }

        if (ops.Contains("getById"))
        {
            Gap();
            WriteKdoc(sb, "Loads the aggregate by its identity, or null if absent.", Indent);
            sb.Append(Indent).Append("fun getById(id: ").Append(idType).Append("): ").Append(rootName).Append("?\n");
        }

        if (ops.Contains("add"))
        {
            Gap();
            WriteKdoc(sb, "Persists a new aggregate.", Indent);
            sb.Append(Indent).Append("fun add(aggregate: ").Append(rootName).Append(")\n");
        }

        if (ops.Contains("update"))
        {
            Gap();
            WriteKdoc(sb, "Persists changes to an existing aggregate.", Indent);
            sb.Append(Indent).Append("fun update(aggregate: ").Append(rootName).Append(")\n");
        }

        if (ops.Contains("remove"))
        {
            Gap();
            WriteKdoc(sb, "Removes the aggregate with the given identity.", Indent);
            sb.Append(Indent).Append("fun remove(id: ").Append(idType).Append(")\n");
        }

        foreach (FinderDecl finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"List<{rootName}>" : $"{rootName}?";
            var method = KotlinNaming.ToMemberName(finder.Name);
            var paramList = string.Join(
                ", ", finder.Parameters.Select(p => KotlinNaming.ToMemberName(p.Name) + ": " + typeMapper.Map(p.Type)));
            sb.Append(Indent).Append("fun ").Append(method).Append('(').Append(paramList).Append("): ").Append(ret).Append('\n');
        }

        sb.Append("}\n");
        return TypeFile(context, iface, sb.ToString());
    }
}
