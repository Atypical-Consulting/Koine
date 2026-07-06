using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Kotlin backend always ships the shared <c>koine.runtime</c> package (issue #1066): a single
/// <c>Runtime.kt</c> carrying <c>DomainException</c> (thrown by every generated invariant guard) and the
/// <c>Range&lt;T&gt;</c> interval type a Koine <c>Range&lt;T&gt;</c> field maps to. This suite locks that
/// even an empty model ships the runtime, mirroring the JVM sibling's <c>DomainException</c> guarantee.
/// </summary>
public class KotlinRuntimeTests
{
    private static IReadOnlyList<EmittedFile> EmptyEmit() =>
        new KotlinEmitter().Emit(new KoineModel(Array.Empty<ContextNode>(), ContextMap: null));

    private static string Runtime() =>
        EmptyEmit().Single(f => f.RelativePath == "koine/runtime/Runtime.kt").Contents;

    [Fact]
    public void Emit_of_any_model_ships_the_runtime_package()
    {
        EmptyEmit().ShouldContain(f => f.RelativePath == "koine/runtime/Runtime.kt");
    }

    [Fact]
    public void Runtime_declares_the_koine_runtime_package_and_DomainException()
    {
        var runtime = Runtime();

        runtime.ShouldContain("package koine.runtime");
        runtime.ShouldContain("class DomainException(message: String) : RuntimeException(message)");
    }

    [Fact]
    public void Runtime_declares_the_Range_interval_type()
    {
        var runtime = Runtime();

        runtime.ShouldContain("data class Range<T : Comparable<T>>(val start: T, val end: T)");
        runtime.ShouldContain("fun contains(value: T)");
        runtime.ShouldContain("fun overlaps(other: Range<T>)");
    }
}
