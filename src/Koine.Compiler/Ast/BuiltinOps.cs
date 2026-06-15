namespace Koine.Compiler.Ast;

/// <summary>
/// The central, target-agnostic whitelist of built-in operations the expression
/// sublanguage understands, grouped by the kind of receiver they apply to. Both
/// the semantic checker and every emitter consult this registry so the language
/// surface is defined in exactly one place (roadmap R1.2 / R1.3).
///
/// <para>An operation is either written WITHOUT parentheses (a "member op", e.g.
/// <c>raw.trim</c>, <c>lines.count</c>) or WITH parentheses (a "call op", e.g.
/// <c>code.startsWith("X")</c>, <c>lines.all(l =&gt; …)</c>).</para>
/// </summary>
public static class BuiltinOps
{
    // ---- Member ops (no parentheses) --------------------------------------

    /// <summary>No-arg string operations: <c>raw.trim</c>, <c>raw.length</c>, …</summary>
    public static readonly IReadOnlySet<string> StringMemberOps =
        new HashSet<string>(StringComparer.Ordinal) { "length", "trim", "lower", "upper", "isBlank" };

    /// <summary>No-arg collection operations: <c>lines.count</c>, <c>lines.isEmpty</c>, …</summary>
    public static readonly IReadOnlySet<string> CollectionMemberOps =
        new HashSet<string>(StringComparer.Ordinal) { "count", "isEmpty", "isNotEmpty" };

    /// <summary>Presence checks on an optional field: <c>nickname.isPresent</c> / <c>.isNone</c>.</summary>
    public static readonly IReadOnlySet<string> OptionalMemberOps =
        new HashSet<string>(StringComparer.Ordinal) { "isPresent", "isNone" };

    // ---- Call ops (with parentheses) --------------------------------------

    /// <summary>String operations taking a single string argument and returning Bool.</summary>
    public static readonly IReadOnlySet<string> StringCallOps =
        new HashSet<string>(StringComparer.Ordinal) { "startsWith", "endsWith", "contains" };

    /// <summary>Collection predicates taking a lambda and returning Bool.</summary>
    public static readonly IReadOnlySet<string> CollectionPredicateOps =
        new HashSet<string>(StringComparer.Ordinal) { "all", "any", "none", "distinctBy" };

    /// <summary>Collection aggregations taking a lambda; result follows the selector.</summary>
    public static readonly IReadOnlySet<string> CollectionAggregateOps =
        new HashSet<string>(StringComparer.Ordinal) { "sum", "min", "max" };

    /// <summary>Collection membership: <c>tags.contains(x)</c>, returning Bool.</summary>
    public static readonly IReadOnlySet<string> CollectionElementCallOps =
        new HashSet<string>(StringComparer.Ordinal) { "contains" };

    /// <summary>True when <paramref name="name"/> is any known no-parens member op.</summary>
    public static bool IsMemberOp(string name) =>
        StringMemberOps.Contains(name) || CollectionMemberOps.Contains(name) || OptionalMemberOps.Contains(name);

    /// <summary>True when <paramref name="name"/> is any known call (parens) op.</summary>
    public static bool IsCallOp(string name) =>
        StringCallOps.Contains(name)
        || CollectionPredicateOps.Contains(name)
        || CollectionAggregateOps.Contains(name)
        || CollectionElementCallOps.Contains(name);

    /// <summary>A call op whose single argument is a lambda selector/predicate.</summary>
    public static bool TakesLambda(string name) =>
        CollectionPredicateOps.Contains(name) || CollectionAggregateOps.Contains(name);
}
