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
        // Reference rules (KOI1601–KOI1604) are added in the following tasks.
    }
}
