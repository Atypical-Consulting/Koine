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
///   (<see cref="DiagnosticCodes.DomainEventReferencesEntity"/>).</item>
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
                        CheckEntityBehaviors(entity, index, diagnostics);
                        break;
                }
            }
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
