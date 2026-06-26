namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #419): reports two specs in the same bounded context whose names would
/// normalize to the same emitted predicate (e.g. <c>IsActive</c> + <c>Active</c> → <c>isActive</c>),
/// which the spec emitters would otherwise emit as a duplicate predicate function/method. The check is
/// target-agnostic, so the collision is caught once for every emitter at validation time. Mirrors
/// <see cref="UniqueTypeNamesAnalyzer"/> in shape, delegating to
/// <see cref="SemanticValidator.ValidateUniqueSpecPredicateNames"/>.
/// </summary>
internal sealed class UniqueSpecPredicateNamesAnalyzer : IModelAnalyzer
{
    public string Id => "koine.unique-spec-predicate-names";

    public void Analyze(AnalyzerContext context) =>
        SemanticValidator.ValidateUniqueSpecPredicateNames(context.Model, context.Diagnostics);
}
