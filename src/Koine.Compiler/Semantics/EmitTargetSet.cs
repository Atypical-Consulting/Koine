namespace Koine.Compiler.Semantics;

/// <summary>
/// The set of emit target(s) a validation pass knows it is building for (issue #495). Validation is
/// target-agnostic by default — most checks never look at this — but a few diagnostics can be made
/// <i>less</i> conservative when the compile commits to a specific target whose identifier rules don't
/// trip the check (today: <see cref="UniqueSpecPredicateNamesAnalyzer"/> / KOI1007).
///
/// <para>Only the shipped targets that actually emit <b>spec predicate functions/methods</b> are
/// modelled — C#, TypeScript and PHP. The other emitters (Python, Rust, Docs, Glossary, OpenAPI,
/// AsyncAPI) emit no per-spec predicate, so they can never produce a spec-predicate collision and do
/// not participate. <see cref="All"/> is the conservative default used whenever the target is unknown
/// (the LSP/editor path, or a build for a target not modelled here): assume every shipped predicate
/// emitter is in play, which reproduces the original always-strict behaviour exactly.</para>
///
/// <para>This lives in <c>Semantics/</c>, never in <c>Ast/</c>: the shared semantic model stays
/// target-agnostic. It is a <i>hint</i> threaded into the validator, not a concept the model carries.</para>
/// </summary>
[Flags]
internal enum EmitTargetSet
{
    /// <summary>No modelled predicate-emitting target — no enabled target can break, so a collision
    /// that survives only under the conservative cross-target fold is advisory (a warning).</summary>
    None = 0,

    /// <summary>The C# emitter: predicates are extension methods (<c>Name(this Target x)</c>),
    /// case-sensitive, separators kept, no <c>is</c> prefix. Distinguished by name <i>and</i> receiver
    /// type, so a folded pair never duplicates here unless it is already an exact same-target duplicate
    /// (which KOI1005 owns).</summary>
    CSharp = 1 << 0,

    /// <summary>The TypeScript emitter: predicates are <c>is&lt;Subject&gt;</c> module functions,
    /// case-sensitive and separators kept, but with a leading <c>Is</c> word stripped — so it collides
    /// on the <c>Is</c>-strip axis (<c>IsActive</c>+<c>Active</c>) yet not the underscore axis.</summary>
    TypeScript = 1 << 1,

    /// <summary>The PHP emitter: predicates are <c>is&lt;Subject&gt;</c> static methods, but PHP method
    /// names are case-insensitive and PHP's PascalCase folds underscores — the strictest fold of any
    /// shipped emitter, and exactly the key KOI1007 uses by default.</summary>
    Php = 1 << 2,

    /// <summary>Every shipped predicate-emitting target (C#, TypeScript, PHP) — the conservative
    /// default. Because PHP is enabled, the strict fold always breaks, so KOI1007 behaves exactly as it
    /// did before issue #495 (a hard error on every collision).</summary>
    All = CSharp | TypeScript | Php,
}
