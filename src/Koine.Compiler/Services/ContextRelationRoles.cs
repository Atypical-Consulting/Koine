using Koine.Compiler.Ast;

namespace Koine.Compiler.Services;

/// <summary>Which end of a context-map relation a role is asked for.</summary>
internal enum ContextRelationEnd
{
    /// <summary>The left endpoint — <see cref="ContextRelation.Upstream"/>.</summary>
    Upstream,

    /// <summary>The right endpoint — <see cref="ContextRelation.Downstream"/>.</summary>
    Downstream,
}

/// <summary>
/// The strategic-DDD <b>role</b> each end of a context-map relation plays, derived purely from the
/// relation's <see cref="ContextRelationKind"/> (#483). The kind alone says which pattern is in play;
/// the roles say what each of the two contexts <em>is</em> under that pattern — the vocabulary a
/// reader of a context map actually speaks ("Ordering is the Customer of Menu, the Supplier").
///
/// <para>Derived here once, in the target-agnostic core, so the desktop LSP host
/// (<c>koine/contextMap</c>) and the in-browser WASM host project byte-identical role labels rather
/// than each re-rolling the mapping — the same shared-helper discipline as
/// <see cref="SourceTextGeometry"/>.</para>
///
/// <para>The two <em>symmetric</em> patterns — partnership and shared kernel — put both contexts on an
/// equal footing, so neither end plays an upstream/downstream role and both yield <c>null</c>. For the
/// asymmetric patterns the end that carries the pattern's name gets it (the downstream conforms, builds
/// the anti-corruption layer; the upstream is the supplier, the open host, the published language) and
/// the other end keeps the plain directional term.</para>
///
/// <para>Roles are a function of the kind only: a relation declared bidirectional (<c>&lt;-&gt;</c>)
/// still reports the roles of its declared endpoints.</para>
/// </summary>
internal static class ContextRelationRoles
{
    /// <summary>
    /// The role <paramref name="end"/> plays in a relation of <paramref name="kind"/>, or <c>null</c>
    /// when the pattern is symmetric and gives that end no distinct role.
    /// </summary>
    public static string? RoleOf(ContextRelationKind kind, ContextRelationEnd end) => (kind, end) switch
    {
        // Symmetric: peers, no upstream/downstream asymmetry to name.
        (ContextRelationKind.Partnership, _) => null,
        (ContextRelationKind.SharedKernel, _) => null,

        (ContextRelationKind.CustomerSupplier, ContextRelationEnd.Upstream) => "Supplier",
        (ContextRelationKind.CustomerSupplier, ContextRelationEnd.Downstream) => "Customer",

        (ContextRelationKind.Conformist, ContextRelationEnd.Upstream) => "Upstream",
        (ContextRelationKind.Conformist, ContextRelationEnd.Downstream) => "Conformist",

        (ContextRelationKind.AntiCorruptionLayer, ContextRelationEnd.Upstream) => "Upstream",
        (ContextRelationKind.AntiCorruptionLayer, ContextRelationEnd.Downstream) => "Anti-Corruption Layer",

        (ContextRelationKind.OpenHost, ContextRelationEnd.Upstream) => "Open Host Service",
        (ContextRelationKind.OpenHost, ContextRelationEnd.Downstream) => "Downstream",

        (ContextRelationKind.PublishedLanguage, ContextRelationEnd.Upstream) => "Published Language",
        (ContextRelationKind.PublishedLanguage, ContextRelationEnd.Downstream) => "Downstream",

        _ => null,
    };

    /// <summary>The <see cref="ContextRelationEnd.Upstream"/> role of <paramref name="relation"/>.</summary>
    public static string? UpstreamRole(ContextRelation relation) =>
        RoleOf(relation.Kind, ContextRelationEnd.Upstream);

    /// <summary>The <see cref="ContextRelationEnd.Downstream"/> role of <paramref name="relation"/>.</summary>
    public static string? DownstreamRole(ContextRelation relation) =>
        RoleOf(relation.Kind, ContextRelationEnd.Downstream);
}
