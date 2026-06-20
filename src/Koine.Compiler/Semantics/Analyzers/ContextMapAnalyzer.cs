namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #69): the model-scoped strategic context map (R14.1/R14.2). Runs once,
/// before the per-context pass, exactly where the pre-refactor <c>SemanticValidator.Validate</c>
/// invoked <see cref="ContextMapValidator.Validate"/>, so diagnostic order is byte-identical. A model
/// with no context map produces nothing.
/// </summary>
internal sealed class ContextMapAnalyzer : IModelAnalyzer
{
    public string Id => "koine.context-map";

    public void Analyze(AnalyzerContext context)
    {
        if (context.Model.ContextMap is { } map)
        {
            ContextMapValidator.Validate(map, context.Index, context.Diagnostics);
        }
    }
}
