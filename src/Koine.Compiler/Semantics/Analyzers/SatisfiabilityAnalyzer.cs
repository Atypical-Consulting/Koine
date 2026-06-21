namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #69): the whole-model invariant-satisfiability pass over the lowered
/// bound IR (issue #73). Runs LAST, exactly where the pre-refactor <c>SemanticValidator.Validate</c>
/// invoked <see cref="SatisfiabilityChecker.Validate"/>, so diagnostic order is byte-identical. It
/// reuses the shared <see cref="Ast.SemanticModel"/> so the bound artifact is built once.
/// </summary>
internal sealed class SatisfiabilityAnalyzer : IModelAnalyzer
{
    public string Id => "koine.satisfiability";

    public void Analyze(AnalyzerContext context) =>
        SatisfiabilityChecker.Validate(context.Semantic, context.Diagnostics);
}
