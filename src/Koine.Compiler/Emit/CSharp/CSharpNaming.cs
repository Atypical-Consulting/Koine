using System.Collections.Concurrent;
using System.Collections.Frozen;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// C#-specific identifier casing helpers. Kept here so the target-agnostic AST
/// stays free of language conventions.
/// </summary>
internal static class CSharpNaming
{
    // The same member name is cased many times across one emit (property, ctor param, ToString,
    // equality, operators). Memoize the conversions that actually allocate a new string — names
    // already in the target case hit the fast path and never enter the cache, so no-ops add no
    // overhead. Conversion is a pure function of the name, so a shared cache stays correct and
    // keeps the emitter reentrant (ConcurrentDictionary).
    private static readonly ConcurrentDictionary<string, string> PascalCache = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, string> CamelCache = new(StringComparer.Ordinal);

    /// <summary>Converts a name to PascalCase (used for property/type names).</summary>
    public static string ToPascalCase(string name) =>
        string.IsNullOrEmpty(name) || char.IsUpper(name[0])
            ? Escape(name)
            : PascalCache.GetOrAdd(name, static n => Escape(WithFirstChar(n, char.ToUpperInvariant(n[0]))));

    /// <summary>Converts a name to camelCase (used for constructor parameter names).</summary>
    public static string ToCamelCase(string name) =>
        string.IsNullOrEmpty(name) || char.IsLower(name[0])
            ? Escape(name)
            : CamelCache.GetOrAdd(name, static n => Escape(WithFirstChar(n, char.ToLowerInvariant(n[0]))));

    /// <summary>
    /// Returns <paramref name="name"/> with its first character replaced by <paramref name="first"/>,
    /// in a single allocation. Avoids the boxing + substring that <c>first + name[1..]</c> incurs
    /// (<c>char + string</c> binds to <see cref="string.Concat(object?, object?)"/>, boxing the char).
    /// </summary>
    private static string WithFirstChar(string name, char first) =>
        string.Create(name.Length, (name, first), static (span, state) =>
        {
            state.name.CopyTo(span);
            span[0] = state.first;
        });

    /// <summary>
    /// Emits a name verbatim (preserving case) as a C# identifier, prefixing it with
    /// <c>@</c> when it is a reserved keyword. Use for identifiers whose spelling must be
    /// preserved exactly — e.g. an enum member, referenced as <c>OrderStatus.Member</c>.
    /// </summary>
    public static string EscapeIdentifier(string name) => Escape(name);

    /// <summary>Prefixes a C# reserved keyword with <c>@</c> so it is a valid identifier.</summary>
    private static string Escape(string identifier) =>
        Keywords.Contains(identifier) ? "@" + identifier : identifier;

    private static readonly FrozenSet<string> Keywords = new HashSet<string>(StringComparer.Ordinal)
    {
        "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked",
        "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else",
        "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for",
        "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock",
        "long", "namespace", "new", "null", "object", "operator", "out", "override", "params",
        "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short",
        "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
        "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual",
        "void", "volatile", "while"
    }.ToFrozenSet(StringComparer.Ordinal);
}
