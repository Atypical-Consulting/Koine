using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;
using Koine.Execution;

namespace Koine.Compiler.Tests;

/// <summary>
/// Covers <see cref="GeneratedAssemblyCompiler"/> — the Roslyn compile-and-load harness lifted out of
/// <see cref="TestSupport"/> into the product-side <c>Koine.Execution</c> assembly (issue #236) so
/// running emitted C# is a capability the compiler ships, not a trick only the test project knows.
/// The new degree of freedom over the old test-only helper is the caller-supplied
/// <see cref="AssemblyLoadContext"/>: a scenario runner must be able to load a generated model into a
/// COLLECTIBLE context and unload it afterwards, instead of leaking every compilation into
/// <see cref="AssemblyLoadContext.Default"/> for the life of the process.
/// </summary>
public class ExecutionHarnessTests
{
    /// <summary>The smallest model whose emitted C# has a member worth executing (a smart-enum accessor).</summary>
    private const string DemoSource = "context Demo { enum Color { Red, Green } }";

    private static IReadOnlyList<EmittedFile> EmitDemo()
    {
        var result = new KoineCompiler().Compile(DemoSource, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    [Fact]
    public void Compiles_emitted_code_into_a_caller_supplied_collectible_context_and_runs_it()
    {
        // The whole load/invoke cycle happens inside a non-inlined helper that hands back only a
        // WeakReference and a string, so no strong reference to the context (or to anything it
        // loaded) survives on this frame to keep it artificially alive across the collection below.
        var (contextRef, colorName) = LoadInvokeAndUnload(EmitDemo());

        colorName.ShouldBe("Red");

        for (var i = 0; contextRef.IsAlive && i < 20; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }

        contextRef.IsAlive.ShouldBeFalse(
            "the collectible load context was not reclaimed after Unload() — a scenario runner would leak "
            + "one generated assembly per run");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (WeakReference ContextRef, string ColorName) LoadInvokeAndUnload(IReadOnlyList<EmittedFile> files)
    {
        var context = new AssemblyLoadContext("koine-execution-tests", isCollectible: true);
        var (assembly, errors) = GeneratedAssemblyCompiler.Compile(files, loadContext: context);

        assembly.ShouldNotBeNull("generated C# failed to compile:\n" + string.Join("\n", errors));
        errors.ShouldBeEmpty();
        AssemblyLoadContext.GetLoadContext(assembly).ShouldBeSameAs(context);

        var color = assembly.GetType("Demo.Color")!;
        var red = color.GetField("Red", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
        var name = (string)color.GetProperty("Name")!.GetValue(red)!;

        context.Unload();
        return (new WeakReference(context), name);
    }

    [Fact]
    public void Defaults_to_the_default_load_context_when_none_is_supplied()
    {
        // TestSupport.Compile forwards without a context, so this default is what keeps every existing
        // Roslyn meta-test byte-behaviour-identical to before the extraction.
        var (assembly, errors) = GeneratedAssemblyCompiler.Compile(EmitDemo());

        assembly.ShouldNotBeNull("generated C# failed to compile:\n" + string.Join("\n", errors));
        AssemblyLoadContext.GetLoadContext(assembly).ShouldBeSameAs(AssemblyLoadContext.Default);
    }

    [Fact]
    public void Reports_compiler_errors_instead_of_throwing()
    {
        var (assembly, errors) = GeneratedAssemblyCompiler.Compile(
            [new EmittedFile("Broken.cs", "public class Broken { public int X => \"not an int\"; }")]);

        assembly.ShouldBeNull();
        errors.ShouldNotBeEmpty();
        errors.ShouldContain(e => e.Contains("CS0029", StringComparison.Ordinal));
    }
}
