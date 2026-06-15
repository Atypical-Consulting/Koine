using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using Koine.Compiler.Emit;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Koine.Compiler.Tests;

/// <summary>Shared fixtures and a Roslyn-based compiler for emitter meta-tests.</summary>
public static class TestSupport
{
    /// <summary>The §4.2 acceptance fixture, copied next to the test assembly.</summary>
    public static string BillingFixture =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "billing.koi"));

    /// <summary>Reads a generated smart-enum member (a public static readonly field) by name.</summary>
    public static object EnumValue(Type enumType, string name) =>
        enumType.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

    /// <summary>Concatenates emitted files (path + contents), ordered by path, for snapshots.</summary>
    public static string Render(IEnumerable<EmittedFile> files)
    {
        var sb = new StringBuilder();
        foreach (var f in files.OrderBy(f => f.RelativePath, StringComparer.Ordinal))
        {
            sb.Append("// ==== ").Append(f.RelativePath).Append(" ====\n");
            sb.Append(f.Contents);
            if (!f.Contents.EndsWith('\n')) sb.Append('\n');
            sb.Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>
    /// Compiles emitted C# in-memory with Roslyn against the running framework's
    /// reference set. Returns the loaded assembly on success, or the error list.
    /// </summary>
    public static (Assembly? Assembly, IReadOnlyList<string> Errors) Compile(IEnumerable<EmittedFile> files)
    {
        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Contents, path: f.RelativePath))
            .ToList();

        var tpa = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            assemblyName: "KoineGenerated_" + Guid.NewGuid().ToString("N"),
            syntaxTrees: trees,
            references: tpa,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));

        using var ms = new MemoryStream();
        var result = compilation.Emit(ms);
        if (!result.Success)
        {
            var errors = result.Diagnostics
                .Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => d.ToString())
                .ToList();
            return (null, errors);
        }

        ms.Seek(0, SeekOrigin.Begin);
        var asm = AssemblyLoadContext.Default.LoadFromStream(ms);
        return (asm, Array.Empty<string>());
    }
}
