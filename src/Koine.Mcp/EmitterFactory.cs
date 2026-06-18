using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.TypeScript;

namespace Koine.Mcp;

/// <summary>
/// Selects an <see cref="IEmitter"/> by target name, mirroring the CLI's <c>build</c> command
/// (<c>RunBuild</c> in <c>src/Koine.Cli/Program.cs</c>). Kept as the single source of truth for the
/// supported targets so the MCP server and CLI never drift.
/// </summary>
internal static class EmitterFactory
{
    /// <summary>The output targets the server understands, in display order.</summary>
    public static readonly IReadOnlyList<string> Targets = new[] { "csharp", "typescript", "glossary", "docs" };

    /// <summary>
    /// Resolves an emitter for <paramref name="target"/> (case-insensitive; null/blank means
    /// <c>csharp</c>). Returns <c>false</c> with an actionable <paramref name="error"/> for an
    /// unknown target.
    /// </summary>
    public static bool TryCreate(string? target, out IEmitter emitter, out string? error)
    {
        var resolved = string.IsNullOrWhiteSpace(target) ? "csharp" : target.Trim().ToLowerInvariant();
        emitter = resolved switch
        {
            "csharp" => new CSharpEmitter(),
            "typescript" => new TypeScriptEmitter(),
            "glossary" => new GlossaryEmitter(),
            "docs" => new DocsEmitter(),
            _ => null!,
        };

        if (emitter is null)
        {
            error = $"unsupported target '{target}' (supported: {string.Join(", ", Targets)})";
            return false;
        }

        error = null;
        return true;
    }
}
