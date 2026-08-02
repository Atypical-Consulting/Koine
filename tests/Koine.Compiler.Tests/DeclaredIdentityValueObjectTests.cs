using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression for issue #1848: an entity's identity type that the model declares EXPLICITLY
/// (<c>value OrderId { … }</c>) as well as via <c>identified by OrderId</c> must be emitted exactly
/// once. Every emitter synthesizes a conventional identity value object for <c>identified by</c>
/// unconditionally, without checking whether the model already declares one — so the explicit
/// declaration and the synthesized one both reach the output.
///
/// <para>Six of the seven emitters (all but Rust) emit one file per type, so the duplicate shows up
/// as two <see cref="EmittedFile"/> entries sharing the same <see cref="EmittedFile.RelativePath"/> —
/// invisible on disk (the second write silently overwrites the first) but fatal for a consumer of the
/// in-memory <c>CompileResult.Files</c> list, exactly what the Roslyn meta-test below is. Rust emits
/// one module per context rather than one file per type, so the duplicate instead lands as two
/// conflicting <c>struct OrderId</c> definitions in the SAME file — confirmed with a real
/// <c>cargo check</c> during triage (<c>error[E0428]: the name `OrderId` is defined multiple
/// times</c>), so despite the issue's original hypothesis, Rust is not immune and needs the same
/// gate.</para>
/// </summary>
public class DeclaredIdentityValueObjectTests
{
    private const string RustNoToolchainNotice =
        "No usable Rust toolchain (cargo/rustc) available; the repro crate was not compiled. " +
        "Install Rust — CI runs this for real.";

    /// <summary>The issue's minimal repro: <c>OrderId</c> is declared both as a <c>value</c> and as
    /// the entity's <c>identified by</c> type.</summary>
    private const string DeclaredIdentityFixture = """
        context Ordering {
          value OrderId { value: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              shipped: Bool = false
            }
          }
        }
        """;

    private static void AssertNoDuplicateRelativePaths(IReadOnlyList<EmittedFile> files)
    {
        var duplicates = files
            .GroupBy(f => f.RelativePath, StringComparer.Ordinal)
            .Where(g => g.Count() > 1)
            .Select(g => $"{g.Key} x{g.Count()}")
            .ToList();

        duplicates.ShouldBeEmpty(string.Join(", ", duplicates));
    }

    [Fact]
    public void CSharp_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertNoDuplicateRelativePaths(result.Files);
    }

    [Fact]
    public void CSharp_repro_model_compiles_via_roslyn()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The whole point of #1848: a passing on-disk `koine build` masks the duplicate (the second
        // file silently overwrites the first), so this must compile the IN-MEMORY file list, not a
        // directory written to disk.
        var (assembly, errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void TypeScript_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertNoDuplicateRelativePaths(result.Files);
    }

    [Fact]
    public void Python_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertNoDuplicateRelativePaths(result.Files);
    }

    [Fact]
    public void Php_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertNoDuplicateRelativePaths(result.Files);
    }

    [Fact]
    public void Java_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertNoDuplicateRelativePaths(result.Files);
    }

    [Fact]
    public void Kotlin_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        AssertNoDuplicateRelativePaths(result.Files);
    }

    /// <summary>
    /// Rust bundles one module per CONTEXT rather than one file per type, so the #1848 duplicate never
    /// shows up as a duplicate <see cref="EmittedFile.RelativePath"/> — it shows up as two conflicting
    /// <c>struct OrderId</c> definitions inside the ONE emitted <c>ordering.rs</c>. A `RelativePath`
    /// count would silently miss this, so assert on the type definition count directly.
    /// </summary>
    [Fact]
    public void Rust_emits_the_declared_identity_value_object_once()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var ordering = result.Files.Single(f => f.RelativePath.EndsWith("ordering.rs", StringComparison.Ordinal)).Contents;

        var definitionCount = System.Text.RegularExpressions.Regex.Matches(ordering, @"\bstruct\s+OrderId\b").Count;
        definitionCount.ShouldBe(1, ordering);
    }

    [Fact]
    public void Rust_repro_crate_compiles()
    {
        var result = new KoineCompiler().Compile(DeclaredIdentityFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, RustNoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
