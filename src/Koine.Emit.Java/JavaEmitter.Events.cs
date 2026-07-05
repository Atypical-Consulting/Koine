using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The events / repository slice of <see cref="JavaEmitter"/> (issue #858, Task 7). A Koine
/// <c>event</c> (and cross-boundary <c>integration event</c>) emits as an immutable positional
/// <c>record</c> that <c>implements</c> the per-context <c>DomainEvent</c> — events carry no invariants,
/// so a plain data record is the idiomatic shape. Every event of a context is collected into a
/// <c>sealed interface DomainEvent permits …</c>, the closed sum the entity slice's recorded-events list
/// (<c>java.util.List&lt;DomainEvent&gt;</c>) is typed on. An aggregate root's <c>repository</c> block
/// emits as a persistence-ignorant <c>interface</c>, and any identity referenced in a context but not
/// owned by a local entity is materialized as a minimal branded <c>record</c> so the reference resolves.
/// <para>
/// The event record's canonical constructor is the declared members <b>in declaration order</b>: the
/// entity slice lowers <c>emit E(a, b)</c> to a positional <c>new E(a, b)</c> (arguments bound by field
/// in declaration order), so any reordering here would break those constructions. Mirrors the Rust
/// backend's <c>RustEmitter.Cqrs.cs</c> / <c>RustEmitter.Aggregates.cs</c> (a <c>DomainEvent</c> enum and
/// repository <c>trait</c>s) laid out the Java way: one public type per <c>.java</c> file, a sealed
/// interface instead of an enum, and fully-qualified stdlib types so no imports are owed.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>The mutating + query operations a repository exposes when none are listed (R11.3).</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    // ----------------------------------------------------------------------
    // Events + integration events -> records implementing DomainEvent
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a domain or integration event as an immutable positional <c>record</c> whose components are
    /// the declared members <b>in declaration order</b> and which <c>implements</c> the per-context
    /// <c>DomainEvent</c> sealed interface. Events carry no invariants, so the record needs no compact
    /// constructor. The declaration order is load-bearing: the entity slice constructs an emitted event
    /// positionally (<c>new E(a, b)</c>), so it must line up with these components.
    /// </summary>
    private EmittedFile EmitEvent(JavaEmitContext emit, string context, string name, string? doc, IReadOnlyList<Member> members)
    {
        var typeName = JavaNaming.Type(name);
        var typeMapper = new JavaTypeMapper(emit.Index);

        var sb = new StringBuilder();
        WriteJavadoc(sb, doc, string.Empty);
        var components = string.Join(
            ", ",
            members.Select(m => typeMapper.Map(m.Type) + " " + JavaNaming.Member(m.Name)));
        sb.Append("public record ").Append(typeName).Append('(').Append(components)
          .Append(") implements DomainEvent {}\n");
        return TypeFile(context, typeName, sb.ToString());
    }

    // ----------------------------------------------------------------------
    // Per-context extras: the DomainEvent sum + foreign/unowned identity records
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits the per-context extras that are not a single top-level declaration: the <c>DomainEvent</c>
    /// sealed interface over the context's events, and a branded record for every identity referenced in
    /// the context but not owned by a local entity (so a foreign <c>CustomerId</c> field type resolves).
    /// Called once per context after its declarations are dispatched by <see cref="EmitType"/>.
    /// </summary>
    private void EmitContextExtras(JavaEmitContext emit, List<EmittedFile> files, ContextNode ctx)
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
    /// Emits the context-wide <c>sealed interface DomainEvent permits E1, E2, …</c> — the closed sum the
    /// entity slice's recorded-events list is typed on — naming every domain and integration event of the
    /// context (each of which <c>implements DomainEvent</c>). Returns <c>null</c> (no empty interface) when
    /// the context declares no events. The Java analogue of the Rust backend's <c>DomainEvent</c> enum.
    /// </summary>
    private EmittedFile? EmitDomainEventInterface(ContextNode ctx)
    {
        var events = ctx.AllTypeDecls()
            .Where(t => t is EventDecl or IntegrationEventDecl)
            .Select(t => JavaNaming.Type(t.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (events.Count == 0)
        {
            return null;
        }

        var sb = new StringBuilder();
        WriteJavadoc(sb, "Every domain event this context can raise — a sealed sum a recorded-events list can hold.", string.Empty);
        sb.Append("public sealed interface DomainEvent permits ")
          .Append(string.Join(", ", events)).Append(" {}\n");
        return TypeFile(ctx.Name, "DomainEvent", sb.ToString());
    }

    /// <summary>
    /// Emits a minimal branded identity <c>record</c> for an id referenced in a context but not owned by a
    /// local entity (e.g. a foreign <c>CustomerId</c> used as a field type), so the reference resolves.
    /// The backing follows the owning entity when the model declares it anywhere, else defaults to a
    /// <c>java.util.UUID</c> brand (the Guid default). Mirrors the Rust backend's <c>EmitUnownedIdType</c>.
    /// </summary>
    private EmittedFile EmitUnownedId(JavaEmitContext emit, string context, string idName)
    {
        var typeName = JavaNaming.Type(idName);
        var javaType = UnownedIdBackingType(emit, idName);

        var sb = new StringBuilder();
        WriteJavadoc(sb, "A strongly-typed identity value referenced by this context but owned elsewhere.", string.Empty);
        sb.Append("public record ").Append(typeName).Append('(').Append(javaType).Append(" value) {}\n");
        return TypeFile(context, typeName, sb.ToString());
    }

    /// <summary>The Java backing type of an unowned identity: the owning entity's backing when the model declares one, else a <c>java.util.UUID</c> brand.</summary>
    private static string UnownedIdBackingType(JavaEmitContext emit, string idName)
    {
        EntityDecl? owner = emit.Index.Model.Contexts
            .SelectMany(c => c.AllEntities())
            .FirstOrDefault(e => string.Equals(e.IdentityName, idName, StringComparison.Ordinal));
        return owner is null ? "java.util.UUID" : JavaIdBacking(owner).JavaType;
    }

    /// <summary>
    /// The identity types referenced in a context but not owned by any of its entities (e.g. a foreign
    /// <c>CustomerId</c> field type), in deterministic order — materialized as branded records so the
    /// references resolve. Mirrors the Rust backend's <c>OrderedUnownedIds</c>.
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
                // A repository finder can name a foreign id in a parameter that appears nowhere else, and
                // the interface signature still needs the type to resolve (a stricter scan than Rust's).
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

    /// <summary>
    /// Emits the aggregate root's persistence-ignorant repository <c>interface</c> (the Rust backend's
    /// <c>EmitAggregateExtras</c> analogue). A no-op when the root cannot be resolved (already a validation
    /// error) or the aggregate declares no repository shape beyond the defaults.
    /// </summary>
    private void EmitAggregateExtras(JavaEmitContext emit, List<EmittedFile> files, string context, AggregateDecl agg)
    {
        if (EmitRepository(emit, context, agg) is { } repository)
        {
            files.Add(repository);
        }
    }

    /// <summary>
    /// Emits the <c>&lt;Root&gt;Repository</c> interface for an aggregate: the fundamental
    /// <c>getById</c> lookup returning <c>Optional</c>, the configured mutating operations (R11.3, default
    /// add/update/remove), and any declarative finders (a list finder returns
    /// <c>java.util.List&lt;Root&gt;</c>, a single finder <c>java.util.Optional&lt;Root&gt;</c>). Keyed on
    /// the root's branded ID. Returns <c>null</c> when the root cannot be resolved.
    /// </summary>
    private EmittedFile? EmitRepository(JavaEmitContext emit, string context, AggregateDecl agg)
    {
        EntityDecl? root = agg.RootEntity();
        if (root is null)
        {
            return null;
        }

        var typeMapper = new JavaTypeMapper(emit.Index);
        var rootName = JavaNaming.Type(root.Name);
        var idType = JavaNaming.Type(root.IdentityName);
        var iface = rootName + "Repository";
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();

        var sb = new StringBuilder();
        WriteJavadoc(sb, "Persistence-ignorant repository contract for the " + rootName + " aggregate root.", string.Empty);
        sb.Append("public interface ").Append(iface).Append(" {\n");

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
            WriteJavadoc(sb, "Loads the aggregate by its identity, if present.", Indent);
            sb.Append(Indent).Append("java.util.Optional<").Append(rootName).Append("> getById(")
              .Append(idType).Append(" id);\n");
        }

        if (ops.Contains("add"))
        {
            Gap();
            WriteJavadoc(sb, "Persists a new aggregate.", Indent);
            sb.Append(Indent).Append("void add(").Append(rootName).Append(" aggregate);\n");
        }

        if (ops.Contains("update"))
        {
            Gap();
            WriteJavadoc(sb, "Persists changes to an existing aggregate.", Indent);
            sb.Append(Indent).Append("void update(").Append(rootName).Append(" aggregate);\n");
        }

        if (ops.Contains("remove"))
        {
            Gap();
            WriteJavadoc(sb, "Removes the aggregate with the given identity.", Indent);
            sb.Append(Indent).Append("void remove(").Append(idType).Append(" id);\n");
        }

        foreach (FinderDecl finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"java.util.List<{rootName}>" : $"java.util.Optional<{rootName}>";
            var method = JavaNaming.Member(finder.Name);
            var paramList = string.Join(
                ", ",
                finder.Parameters.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));
            sb.Append(Indent).Append(ret).Append(' ').Append(method).Append('(').Append(paramList).Append(");\n");
        }

        sb.Append("}\n");
        return TypeFile(context, iface, sb.ToString());
    }
}
