using Koine.Compiler.Ast;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Built-in analyzer (issue #69): the per-bounded-context semantic pass. It drives — IN ORDER, one
/// whole context at a time — context scoping, annotation-version checks, per-type validation, specs,
/// services, policies, and integration events. This interleaving is load-bearing: compiler
/// diagnostics are emitted in raw append order (they are NOT position-sorted before
/// snapshotting/output), so all of context A's diagnostics must precede all of context B's, exactly
/// as the pre-refactor <c>SemanticValidator.Validate</c> produced them. Splitting these concerns into
/// independent whole-model analyzers would reorder the output and break the Verify snapshots, so they
/// stay grouped behind this single driver.
/// </summary>
internal sealed class PerContextAnalyzer : IModelAnalyzer
{
    public string Id => "koine.per-context";

    public void Analyze(AnalyzerContext context)
    {
        ModelIndex index = context.Index;
        IReadOnlySet<string> enumMembers = context.EnumMembers;
        var diagnostics = context.Diagnostics;

        foreach (ContextNode ctx in context.Model.Contexts)
        {
            // A per-context resolver so a type name shared across contexts (R13.2) resolves
            // to THIS context's declaration when checking member access.
            TypeResolver resolver = context.ResolverFor(ctx.Name);

            SemanticValidator.ValidateContextScoping(ctx, index, diagnostics);
            SemanticValidator.ValidateAnnotationVersions(ctx, diagnostics);

            foreach (TypeDecl type in ctx.Types)
            {
                SemanticValidator.ValidateType(type, index, resolver, enumMembers, diagnostics);
            }

            SemanticValidator.ValidateSpecs(ctx, index, resolver, enumMembers, diagnostics);
            SemanticValidator.ValidateServices(ctx, index, resolver, enumMembers, diagnostics);
            SemanticValidator.ValidatePolicies(ctx, index, resolver, enumMembers, diagnostics);
            IntegrationEventValidator.Validate(ctx, index, context.Model.ContextMap is not null, diagnostics);
        }
    }
}
