using Koine.Compiler.Ast;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #1091): warns on an ambiguous multi-owner cross-context type reference,
/// running the focused <see cref="CrossContextTypeValidator"/> once per context. It reports only
/// warnings and is registered LAST among the built-ins, so a genuine model error (an unimported or
/// ambiguous reference from the reference-discipline / per-context passes) is reported first and this
/// advisory choice-of-owner note appends after — a model with no multi-owner cross-context reference
/// produces nothing, so it never perturbs existing diagnostic order.
/// </summary>
internal sealed class CrossContextTypeAnalyzer : IModelAnalyzer
{
    public string Id => "koine.cross-context-type";

    public void Analyze(AnalyzerContext context)
    {
        foreach (ContextNode ctx in context.Model.Contexts)
        {
            CrossContextTypeValidator.Validate(ctx, context.Index, context.Diagnostics);
        }
    }
}
