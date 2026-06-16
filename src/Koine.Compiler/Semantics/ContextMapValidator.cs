using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// R14 — strategic context map, shared kernel &amp; ACL. Split out of
/// <see cref="SemanticValidator"/>; the orchestrator calls
/// <see cref="Validate"/> in the same position as before, so diagnostic codes,
/// messages, and emission order are unchanged.
/// </summary>
internal static class ContextMapValidator
{
    /// <summary>
    /// Validates the strategic context map (R14.1/R14.2): both endpoints must be declared,
    /// no self-relation, no duplicate pair; a <c>shared-kernel { }</c> block is only valid on a
    /// shared-kernel relation (its types must be declared by a partner); an <c>acl { }</c> block
    /// is only valid on an anti-corruption-layer relation (its mappings must map a real upstream
    /// type to a real downstream type).
    /// </summary>
    public static void Validate(ContextMapNode map, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var seenPairs = new HashSet<(string, string)>();
        // Which (normalized) kernel pair first claimed each shared type, to flag conflicting kernels.
        var kernelOf = new Dictionary<string, (string, string)>(StringComparer.Ordinal);

        foreach (var r in map.Relations)
        {
            // 1. Endpoints declared.
            foreach (var endpoint in new[] { r.Upstream, r.Downstream })
            {
                if (!index.IsContext(endpoint))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ContextMapUnknownContext,
                        $"context-map relation names unknown context '{endpoint}'", r.Span));
                }
            }

            // 2. No self-relation.
            if (r.Upstream == r.Downstream)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SelfRelation,
                    $"context '{r.Upstream}' cannot be related to itself", r.Span));
            }

            // 3. No duplicate pair (order-normalized, so reversed bidirectional pairs collide too).
            var pair = string.CompareOrdinal(r.Upstream, r.Downstream) <= 0
                ? (r.Upstream, r.Downstream) : (r.Downstream, r.Upstream);
            if (!seenPairs.Add(pair) && r.Upstream != r.Downstream)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateContextRelation,
                    $"duplicate context-map relation between '{r.Upstream}' and '{r.Downstream}'", r.Span));
            }

            // 4. Block-vs-role agreement.
            if (r.SharedTypes.Count > 0 && r.Kind != ContextRelationKind.SharedKernel)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SharedTypesOnNonKernel,
                    $"'shared-kernel {{ }}' block is only valid on a shared-kernel relation ('{r.Upstream}' -> '{r.Downstream}' is {RoleName(r.Kind)})", r.Span));
            }

            if (r.AclMappings.Count > 0 && r.Kind != ContextRelationKind.AntiCorruptionLayer)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.AclOnNonAclRole,
                    $"'acl {{ }}' block is only valid on an anti-corruption-layer relation ('{r.Upstream}' -> '{r.Downstream}' is {RoleName(r.Kind)})", r.Span));
            }

            // 5. Shared-kernel membership: each listed type must be declared by a partner, and a
            //    type may belong to only one kernel (a second, conflicting pair is an error).
            if (r.Kind == ContextRelationKind.SharedKernel)
            {
                var kernelPair = string.CompareOrdinal(r.Upstream, r.Downstream) <= 0
                    ? (r.Upstream, r.Downstream) : (r.Downstream, r.Upstream);
                foreach (var t in r.SharedTypes)
                {
                    if (!index.DeclaresType(r.Upstream, t) && !index.DeclaresType(r.Downstream, t))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownSharedKernelType,
                            $"shared-kernel type '{t}' is declared by neither '{r.Upstream}' nor '{r.Downstream}'", r.Span));
                    }
                    else if (index.Classify(t) is TypeKind.Entity or TypeKind.Aggregate)
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SharedKernelNotShareable,
                            $"shared-kernel type '{t}' is an {(index.Classify(t) == TypeKind.Entity ? "entity" : "aggregate")}; a shared kernel may contain only value objects and enums (identity-bearing types belong to one context)", r.Span));
                    }
                    else if (kernelOf.TryGetValue(t, out var first) && first != kernelPair)
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SharedKernelTypeConflict,
                            $"type '{t}' is shared by more than one kernel ('{first.Item1}'/'{first.Item2}' and '{kernelPair.Item1}'/'{kernelPair.Item2}'); a type may belong to only one shared kernel", r.Span));
                    }
                    else
                    {
                        kernelOf[t] = kernelPair;
                    }
                }
            }

            // 6. ACL mappings: partner agreement, existence, and no duplicate upstream type.
            if (r.Kind == ContextRelationKind.AntiCorruptionLayer)
            {
                var seenUpstream = new HashSet<string>(StringComparer.Ordinal);
                foreach (var m in r.AclMappings)
                {
                    var ok = m.UpstreamContext == r.Upstream && m.LocalContext == r.Downstream
                             && index.DeclaresType(r.Upstream, m.UpstreamType)
                             && index.DeclaresType(r.Downstream, m.LocalType)
                             && seenUpstream.Add(m.UpstreamType);
                    if (!ok)
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.AclMappingType,
                            $"ACL mapping '{m.UpstreamContext}.{m.UpstreamType} -> {m.LocalContext}.{m.LocalType}' must map a distinct upstream '{r.Upstream}' type to a downstream '{r.Downstream}' type that both exist", m.Span));
                    }
                }
            }
        }
    }

    /// <summary>The original hyphenated spelling of a relation role (for diagnostic messages).</summary>
    private static string RoleName(ContextRelationKind kind) => kind switch
    {
        ContextRelationKind.Partnership => "partnership",
        ContextRelationKind.SharedKernel => "shared-kernel",
        ContextRelationKind.CustomerSupplier => "customer-supplier",
        ContextRelationKind.Conformist => "conformist",
        ContextRelationKind.AntiCorruptionLayer => "anti-corruption-layer",
        ContextRelationKind.OpenHost => "open-host",
        ContextRelationKind.PublishedLanguage => "published-language",
        _ => kind.ToString()
    };
}
