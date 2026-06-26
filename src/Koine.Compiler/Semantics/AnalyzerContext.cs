using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// The context handed to every <see cref="IModelAnalyzer"/> (issue #69). It exposes the shared,
/// resolved <see cref="SemanticModel"/> (and through it the syntax <see cref="Model"/> and the one
/// <see cref="ModelIndex"/>), a <see cref="Report(Diagnostic)"/> sink that accumulates diagnostics in
/// emission order, and a few shared computations the built-in analyzers would otherwise each recompute
/// (the model-wide enum-member set and per-context <see cref="TypeResolver"/>s).
///
/// <para>One context instance is reused across all analyzers in a single validation pass, so the
/// derived artifacts (the enum-member set, resolver cache) are computed once. The diagnostic sink is
/// the analyzers' only output channel — there is no other side effect.</para>
/// </summary>
public sealed class AnalyzerContext
{
    private readonly Dictionary<string, TypeResolver> _resolvers = new(StringComparer.Ordinal);

    /// <summary>
    /// Creates a context over <paramref name="semantic"/> that reports into <paramref name="sink"/>,
    /// telling target-aware analyzers which <paramref name="enabledTargets"/> the compile is building
    /// for (issue #495). Callers with no target context pass <see cref="EmitTargetSet.All"/> (the
    /// conservative all-targets behaviour) explicitly — there is no silent default.
    /// </summary>
    internal AnalyzerContext(SemanticModel semantic, List<Diagnostic> sink, EmitTargetSet enabledTargets)
    {
        Semantic = semantic;
        Diagnostics = sink;
        EnabledTargets = enabledTargets;
    }

    /// <summary>The resolved, shared semantic view of the model (name/type resolution computed once).</summary>
    public SemanticModel Semantic { get; }

    /// <summary>
    /// The emit target(s) this compile is building for (issue #495) — a hint that lets a target-aware
    /// analyzer relax a conservative cross-target check. <see cref="EmitTargetSet.All"/> when the target
    /// is unknown (the editor/LSP path), which keeps the strict, all-targets behaviour.
    /// </summary>
    internal EmitTargetSet EnabledTargets { get; }

    /// <summary>The immutable syntax model under analysis.</summary>
    public KoineModel Model => Semantic.Model;

    /// <summary>The one name/type resolution index for the whole compilation.</summary>
    public ModelIndex Index => Semantic.Index;

    /// <summary>
    /// Every enum member name declared anywhere in the model — the set expression checks use to
    /// recognize a bare enum-member reference. Computed once and shared across analyzers.
    /// </summary>
    public IReadOnlySet<string> EnumMembers => field ??= CollectEnumMembers(Model);

    /// <summary>
    /// A <see cref="TypeResolver"/> scoped to <paramref name="context"/> (R13.2), cached so repeated
    /// requests for the same context reuse one resolver. Pass <c>null</c> for global resolution.
    /// </summary>
    public TypeResolver ResolverFor(string? context)
    {
        var key = context ?? "\0";
        if (!_resolvers.TryGetValue(key, out TypeResolver? resolver))
        {
            resolver = new TypeResolver(Index, context);
            _resolvers[key] = resolver;
        }

        return resolver;
    }

    /// <summary>Reports a diagnostic into the shared sink (the analyzers' only output channel).</summary>
    public void Report(Diagnostic diagnostic) => Diagnostics.Add(diagnostic);

    /// <summary>
    /// The mutable sink, exposed to the built-in analyzers so they can keep calling the existing
    /// helpers that take a <c>List&lt;Diagnostic&gt;</c> (byte-identical message/order). External
    /// analyzers use <see cref="Report(Diagnostic)"/>.
    /// </summary>
    internal List<Diagnostic> Diagnostics { get; }

    /// <summary>Collects every enum member name declared anywhere in the model.</summary>
    private static IReadOnlySet<string> CollectEnumMembers(KoineModel model)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                CollectEnumMembers(type, names);
            }
        }

        return names;
    }

    private static void CollectEnumMembers(TypeDecl type, HashSet<string> names)
    {
        switch (type)
        {
            case EnumDecl e:
                foreach (var member in e.MemberNames)
                {
                    names.Add(member);
                }

                break;
            case AggregateDecl agg:
                foreach (TypeDecl nested in agg.Types)
                {
                    CollectEnumMembers(nested, names);
                }

                break;
        }
    }
}
