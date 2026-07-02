namespace Koine.Compiler;

/// <summary>
/// TypeScript-specific identifier casing helpers. Types are <c>PascalCase</c>,
/// members and parameters are <c>camelCase</c>. Unlike C#, TypeScript identifiers are
/// never escaped (a contextual keyword such as <c>type</c> is a legal member name), so
/// there is no escaping counterpart to <see cref="CSharp.CSharpNaming.EscapeIdentifier"/>.
/// Kept here so the target-agnostic AST stays free of language conventions.
/// </summary>
internal static class TypeScriptNaming
{
    /// <summary>Converts a name to PascalCase (type names, enum members).</summary>
    public static string ToPascalCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        return char.IsUpper(name[0]) ? name : char.ToUpperInvariant(name[0]) + name[1..];
    }

    /// <summary>Converts a name to camelCase (members, parameters, locals).</summary>
    public static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        return char.IsLower(name[0]) ? name : char.ToLowerInvariant(name[0]) + name[1..];
    }
}
