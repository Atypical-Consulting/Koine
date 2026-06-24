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
                m.Name, m.Type, index, IsAllowedInValueObject,
                DiagnosticCodes.ValueObjectReferencesEntity,
                (name, t) => $"value-object field '{name}' references '{t}'; a value object has no identity and must be composed only of primitives, enums, ID value objects, and other value objects",
                diagnostics);
        }
    }

    private static bool IsAllowedInValueObject(TypeKind kind) => kind switch
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
