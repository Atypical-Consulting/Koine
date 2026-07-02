using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the per-emitter project extraction (issue #861): each emitter, its provider, and the shared
/// helpers must live in the assembly the layering assigns them, while the emit <b>contracts</b> stay in
/// <c>Koine.Compiler</c>. Namespaces are deliberately kept as <c>Koine.Compiler.Emit.*</c> (assembly
/// name != namespace), so these asserts read the runtime <c>Assembly.GetName().Name</c> rather than the
/// namespace to prove the physical split. If a type slides back into the wrong assembly (a stray
/// <c>&lt;Compile Include&gt;</c>, an accidental merge), one of these fails.
/// </summary>
public class EmitProjectStructureTests
{
    private static string AssemblyOf(Type t) => t.Assembly.GetName().Name!;

    [Fact]
    public void Shared_emitter_helpers_live_in_Koine_Emit_Common()
    {
        AssemblyOf(typeof(FactoryIdBinding)).ShouldBe("Koine.Emit.Common");
        AssemblyOf(typeof(FactoryIdSource)).ShouldBe("Koine.Emit.Common");
        AssemblyOf(typeof(MarkdownDoc)).ShouldBe("Koine.Emit.Common");
    }

    [Fact]
    public void ExprDescriber_stays_in_Koine_Compiler_because_a_core_service_consumes_it()
    {
        // ExprDescriber is used by Services/ModelRoundTripService (a core, non-emit consumer), so it
        // cannot drop below the compiler into Koine.Emit.Common without a reference cycle. It stays in
        // Koine.Compiler (made public) and the extracted Docs/Glossary emitters consume it from there.
        AssemblyOf(typeof(ExprDescriber)).ShouldBe("Koine.Compiler");
    }

    [Theory]
    [InlineData(typeof(Emit.CSharp.CSharpEmitter), "Koine.Emit.CSharp")]
    [InlineData(typeof(CSharpEmitterProvider), "Koine.Emit.CSharp")]
    [InlineData(typeof(Emit.TypeScript.TypeScriptEmitter), "Koine.Emit.TypeScript")]
    [InlineData(typeof(TypeScriptEmitterProvider), "Koine.Emit.TypeScript")]
    [InlineData(typeof(Emit.Python.PythonEmitter), "Koine.Emit.Python")]
    [InlineData(typeof(PythonEmitterProvider), "Koine.Emit.Python")]
    [InlineData(typeof(Emit.Php.PhpEmitter), "Koine.Emit.Php")]
    [InlineData(typeof(PhpEmitterProvider), "Koine.Emit.Php")]
    [InlineData(typeof(Emit.Rust.RustEmitter), "Koine.Emit.Rust")]
    [InlineData(typeof(RustEmitterProvider), "Koine.Emit.Rust")]
    [InlineData(typeof(Emit.Glossary.GlossaryEmitter), "Koine.Emit.Glossary")]
    [InlineData(typeof(GlossaryEmitterProvider), "Koine.Emit.Glossary")]
    [InlineData(typeof(Emit.Docs.DocsEmitter), "Koine.Emit.Docs")]
    [InlineData(typeof(DocsEmitterProvider), "Koine.Emit.Docs")]
    [InlineData(typeof(Emit.AsyncApi.AsyncApiEmitter), "Koine.Emit.AsyncApi")]
    [InlineData(typeof(AsyncApiEmitterProvider), "Koine.Emit.AsyncApi")]
    [InlineData(typeof(Emit.OpenApi.OpenApiEmitter), "Koine.Emit.OpenApi")]
    [InlineData(typeof(OpenApiEmitterProvider), "Koine.Emit.OpenApi")]
    public void Each_emitter_and_its_provider_live_in_their_own_assembly(Type type, string expectedAssembly)
    {
        AssemblyOf(type).ShouldBe(expectedAssembly);
    }

    [Theory]
    [InlineData(typeof(IEmitter))]
    [InlineData(typeof(IEmitterProvider))]
    [InlineData(typeof(EmitterOptions))]
    [InlineData(typeof(EmittedFile))]
    [InlineData(typeof(EmitTargetInfo))]
    [InlineData(typeof(SourceMapSegment))]
    [InlineData(typeof(EmitterRegistry))]
    [InlineData(typeof(EmitterLoader))]
    public void Emit_contracts_stay_in_Koine_Compiler(Type contract)
    {
        // The orchestrator (Services/KoineCompiler) consumes IEmitter, so the contracts cannot move
        // below the compiler. They stay in Koine.Compiler and keep its PublicAPI baseline.
        AssemblyOf(contract).ShouldBe("Koine.Compiler");
    }

    [Fact]
    public void Built_in_provider_registration_lives_in_the_Koine_Emit_All_aggregator()
    {
        AssemblyOf(typeof(BuiltInEmitterProviders)).ShouldBe("Koine.Emit.All");
    }
}
