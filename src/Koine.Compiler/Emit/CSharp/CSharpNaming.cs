using System.Text;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// C#-specific identifier casing helpers. Kept here so the target-agnostic AST
/// stays free of language conventions.
/// </summary>
internal static class CSharpNaming
{
    /// <summary>Converts a name to PascalCase (used for property/type names).</summary>
    public static string ToPascalCase(string name)
    {
        if (string.IsNullOrEmpty(name))
            return name;
        var pascal = char.IsUpper(name[0]) ? name : char.ToUpperInvariant(name[0]) + name[1..];
        return Escape(pascal);
    }

    /// <summary>Converts a name to camelCase (used for constructor parameter names).</summary>
    public static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name))
            return name;
        var camel = char.IsLower(name[0]) ? name : char.ToLowerInvariant(name[0]) + name[1..];
        return Escape(camel);
    }

    /// <summary>Prefixes a C# reserved keyword with <c>@</c> so it is a valid identifier.</summary>
    private static string Escape(string identifier) =>
        Keywords.Contains(identifier) ? "@" + identifier : identifier;

    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
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
    };
}
