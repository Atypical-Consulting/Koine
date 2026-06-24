using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #296): enforces DDD <b>reference discipline</b> between the tactical
/// building blocks. The existing integration-event check (<see cref="DiagnosticCodes.IntegrationEventLeaksInternals"/>)
/// keeps reference types from crossing a context boundary; this analyzer applies the same idea to the
/// <em>internal</em> constructs, so a model that violates a tactical-DDD reference rule fails to compile:
/// <list type="bullet">
///   <item>a value object may be composed only of primitives, enums, ID value objects, and other value
///   objects — never an entity or aggregate (<see cref="DiagnosticCodes.ValueObjectReferencesEntity"/>);</item>
///   <item>an entity/aggregate-root field references another aggregate (or an entity in another
///   aggregate) by its identity, not directly (<see cref="DiagnosticCodes.EntityReferencesForeignAggregate"/>);</item>
///   <item>a command or factory parameter carries data and identities, not entity/aggregate references
///   (<see cref="DiagnosticCodes.CommandParameterReferencesEntity"/>);</item>
///   <item>a domain-event field carries data and identities, not entity/aggregate references
///   (<see cref="DiagnosticCodes.DomainEventReferencesEntity"/>);</item>
///   <item>an entity/aggregate-root member holds domain state, never a domain/integration event,
///   read model, or query (<see cref="DiagnosticCodes.EntityFieldReferencesMessageType"/>).</item>
/// </list>
/// Classification is by <see cref="ModelIndex.Classify(string)"/> (genuinely-unknown names are left to
/// <see cref="DiagnosticCodes.UnknownType"/>); collection element/value types are checked recursively.
/// TARGET-AGNOSTIC — it reports diagnostics only.
/// </summary>
internal sealed class ReferenceDisciplineAnalyzer : IModelAnalyzer
{
    public string Id => "koine.reference-discipline";

    public void Analyze(AnalyzerContext context)
    {
        ModelIndex index = context.Index;
        var diagnostics = context.Diagnostics;

        foreach (ContextNode ctx in context.Model.Contexts)
        {
            // Which aggregate (if any) owns each type in THIS context — drives the cross-aggregate
            // rule. Type names can repeat across contexts (R13.2), so the map is per-context.
            IReadOnlyDictionary<string, string> owningAggregate = BuildOwningAggregateMap(ctx);

            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                switch (type)
                {
                    case ValueObjectDecl vo:
                        CheckValueObject(vo, index, diagnostics);
                        break;
                    case EventDecl ev:
                        CheckDomainEvent(ev, index, diagnostics);
                        break;
                    case EntityDecl entity:
                        CheckEntityReferences(entity, owningAggregate, index, diagnostics);
                        CheckEntityBehaviors(entity, index, diagnostics);
                        break;
                }
            }
        }
    }

    /// <summary>
    /// Maps each type declared inside an aggregate (its root and children, recursively) to that
    /// aggregate's name, within a single context. A type absent from the map is un-aggregated.
    /// </summary>
    private static IReadOnlyDictionary<string, string> BuildOwningAggregateMap(ContextNode ctx)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TypeDecl t in ctx.Types)
        {
            if (t is AggregateDecl agg)
            {
                MapAggregateTypes(agg, map);
            }
        }

        return map;
    }

    private static void MapAggregateTypes(AggregateDecl agg, Dictionary<string, string> map)
    {
        foreach (TypeDecl t in agg.Types)
        {
            // A nested aggregate's inner types belong to the inner aggregate (its immediate owner).
            if (t is AggregateDecl nested)
            {
                map[nested.Name] = agg.Name;
                MapAggregateTypes(nested, map);
            }
            else
            {
                map[t.Name] = agg.Name;
            }
        }
    }

    /// <summary>
    /// An entity (or aggregate root) may own value objects, enums, primitives, and child entities of
    /// its <em>own</em> aggregate. It must reference any other aggregate — or an entity belonging to a
    /// different aggregate — by identity, not by a direct object reference (KOI1602). The check is
    /// conservative: it fires only when both endpoints resolve to two different, known aggregates (so
    /// same-aggregate children and un-aggregated entities never produce a false positive).
    /// </summary>
    private static void CheckEntityReferences(
        EntityDecl entity,
        IReadOnlyDictionary<string, string> owningAggregate,
        ModelIndex index,
        List<Diagnostic> diagnostics)
    {
        owningAggregate.TryGetValue(entity.Name, out string? declaringOwner);
        foreach (Member m in entity.Members)
        {
            CheckCrossAggregate(m.Name, m.Type, declaringOwner, owningAggregate, index, diagnostics);
        }
    }

    private static void CheckCrossAggregate(
        string memberName,
        TypeRef tr,
        string? declaringOwner,
        IReadOnlyDictionary<string, string> owningAggregate,
        ModelIndex index,
        List<Diagnostic> diagnostics)
    {
        TypeKind kind = index.Classify(tr.Name);

        // An entity holds domain state — value objects, enums, ids, and its own child entities. A
        // domain/integration event is an immutable record of what happened; a read model / query is a
        // CQRS read-side projection. None of those are state an entity should own as a field (KOI1605).
        // This is a different mistake from a cross-aggregate reference (KOI1602) — the fix isn't "use
        // its id", it's "don't hold it at all" — so it gets its own code and message.
        if (IsMessageOrReadModel(kind))
        {
            diagnostics.Add(Diagnostic.Error(
                DiagnosticCodes.EntityFieldReferencesMessageType,
                $"entity field '{memberName}' references {DescribeMessageKind(kind)} '{tr.Name}'; an entity holds domain state (value objects, enums, ids, child entities), not events, read models, or queries",
                tr.Span));
        }

        bool offends = kind == TypeKind.Aggregate
            || (kind == TypeKind.Entity
                && declaringOwner is not null
                && owningAggregate.TryGetValue(tr.Name, out string? targetOwner)
                && !string.Equals(targetOwner, declaringOwner, StringComparison.Ordinal));

        if (offends)
        {
            diagnostics.Add(Diagnostic.Error(
                DiagnosticCodes.EntityReferencesForeignAggregate,
                $"field '{memberName}' references '{tr.Name}', which belongs to another aggregate; reference other aggregates by their identity (e.g. an Id), not directly",
                tr.Span));
        }

        if (tr.Element is not null)
        {
            CheckCrossAggregate(memberName, tr.Element, declaringOwner, owningAggregate, index, diagnostics);
        }

        if (tr.Value is not null)
        {
            CheckCrossAggregate(memberName, tr.Value, declaringOwner, owningAggregate, index, diagnostics);
        }
    }

    /// <summary>
    /// A value object is identity-less and immutable: it may be composed only of primitives, enums,
    /// ID value objects, and other value objects (and collections of those). An entity, aggregate, or
    /// any other reference type smuggles identity and mutability into a value — KOI1601.
    /// </summary>
    private static void CheckValueObject(ValueObjectDecl vo, ModelIndex index, List<Diagnostic> diagnostics)
    {
        foreach (Member m in vo.Members)
        {
            CheckMemberType(
                m.Name, m.Type, index, IsAllowedAsData,
                DiagnosticCodes.ValueObjectReferencesEntity,
                (name, t) => $"value-object field '{name}' references '{t}'; a value object has no identity and must be composed only of primitives, enums, ID value objects, and other value objects",
                diagnostics);
        }
    }

    /// <summary>
    /// A domain event is an immutable record of what happened: its fields carry data and identities,
    /// not live entity/aggregate references (those would not serialize and would couple the event to a
    /// mutable object) — KOI1604.
    /// </summary>
    private static void CheckDomainEvent(EventDecl ev, ModelIndex index, List<Diagnostic> diagnostics)
    {
        foreach (Member m in ev.Members)
        {
            CheckMemberType(
                m.Name, m.Type, index, IsAllowedAsData,
                DiagnosticCodes.DomainEventReferencesEntity,
                (name, t) => $"domain-event field '{name}' references '{t}'; a domain event carries data and identities (e.g. an Id), not entity or aggregate references",
                diagnostics);
        }
    }

    /// <summary>
    /// A command or factory is a message/use-case: its parameters carry data and identities, not live
    /// entity/aggregate references — the caller passes an Id and the handler loads the aggregate (KOI1603).
    /// </summary>
    private static void CheckEntityBehaviors(EntityDecl entity, ModelIndex index, List<Diagnostic> diagnostics)
    {
        foreach (CommandDecl cmd in entity.Commands)
        {
            CheckParameters("command", cmd.Parameters, index, diagnostics);
        }

        foreach (FactoryDecl factory in entity.Factories)
        {
            CheckParameters("factory", factory.Parameters, index, diagnostics);
        }
    }

    private static void CheckParameters(
        string kind, IReadOnlyList<Param> parameters, ModelIndex index, List<Diagnostic> diagnostics)
    {
        foreach (Param p in parameters)
        {
            CheckMemberType(
                p.Name, p.Type, index, IsAllowedAsData,
                DiagnosticCodes.CommandParameterReferencesEntity,
                (name, t) => $"{kind} parameter '{name}' references '{t}'; a {kind} carries data and identities (e.g. an Id), not entity or aggregate references",
                diagnostics);
        }
    }

    /// <summary>
    /// The kinds allowed wherever a building block holds <em>data</em> (a value-object member, a
    /// domain-event field, or a command/factory parameter): primitives, enums, ID value objects, and
    /// other value objects, plus collections of those. Reference types (entity, aggregate, domain/
    /// integration event, read model, query) are not data and are rejected by the caller's rule.
    /// </summary>
    private static bool IsAllowedAsData(TypeKind kind) => kind switch
    {
        TypeKind.Primitive or TypeKind.List or TypeKind.Set or TypeKind.Map or TypeKind.Range => true,
        TypeKind.Enum or TypeKind.Value or TypeKind.IdValueObject => true,
        TypeKind.Unknown => true,   // genuinely-unknown names are reported as KOI0101 elsewhere
        _ => false                  // Entity, Aggregate, Event, IntegrationEvent, ReadModel, Query
    };

    /// <summary>
    /// The message / read-side kinds an entity or aggregate-root member must never be typed as: a
    /// domain or integration event (a record of what happened) and a read model or query (a CQRS
    /// read-side projection). Reported on an entity member as KOI1605.
    /// </summary>
    private static bool IsMessageOrReadModel(TypeKind kind) =>
        kind is TypeKind.Event or TypeKind.IntegrationEvent or TypeKind.ReadModel or TypeKind.Query;

    /// <summary>Names a message/read kind for the KOI1605 diagnostic message.</summary>
    private static string DescribeMessageKind(TypeKind kind) => kind switch
    {
        TypeKind.Event => "event",
        TypeKind.IntegrationEvent => "integration event",
        TypeKind.ReadModel => "read model",
        TypeKind.Query => "query",
        _ => "type"
    };

    /// <summary>
    /// Classifies <paramref name="tr"/> and reports <paramref name="code"/> when its kind is not
    /// allowed; recurses into a generic's element and value type arguments so a collection of a
    /// disallowed type (e.g. <c>List&lt;Order&gt;</c>) is caught at the offending argument's span.
    /// Modelled on <c>IntegrationEventValidator.CheckIntegrationEventFieldType</c>.
    /// </summary>
    private static void CheckMemberType(
        string memberName,
        TypeRef tr,
        ModelIndex index,
        Func<TypeKind, bool> allowed,
        string code,
        Func<string, string, string> describe,
        List<Diagnostic> diagnostics)
    {
        if (!allowed(index.Classify(tr.Name)))
        {
            diagnostics.Add(Diagnostic.Error(code, describe(memberName, tr.Name), tr.Span));
        }

        if (tr.Element is not null)
        {
            CheckMemberType(memberName, tr.Element, index, allowed, code, describe, diagnostics);
        }

        if (tr.Value is not null)
        {
            CheckMemberType(memberName, tr.Value, index, allowed, code, describe, diagnostics);
        }
    }
}
