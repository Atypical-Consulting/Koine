namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #69): reports duplicate / reserved emittable type names across the whole
/// model. Runs FIRST, exactly where the pre-refactor <c>SemanticValidator.Validate</c> ran
/// <c>ValidateUniqueTypeNames</c>, so diagnostic order is byte-identical.
/// </summary>
internal sealed class UniqueTypeNamesAnalyzer : IModelAnalyzer
{
    public string Id => "koine.unique-type-names";

    public void Analyze(AnalyzerContext context) =>
        SemanticValidator.ValidateUniqueTypeNames(context.Model, context.Diagnostics);
}
