using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// #1848's cross-cutting invariant: <see cref="KoineCompiler.Compile(string, IEmitter)"/> must fail
/// loudly the moment ANY emitter produces two <see cref="EmittedFile"/> entries under the same
/// <see cref="EmittedFile.RelativePath"/> — a shape that is ALWAYS a defect (the second file would
/// silently overwrite the first on disk) and is otherwise invisible to a consumer that only writes to
/// disk. Exercised against a minimal fake emitter rather than a real one, so this test pins the
/// GUARD itself, independent of whether any real emitter currently has (or will ever again have) this
/// defect.
/// </summary>
public class DuplicateEmittedPathInvariantTests
{
    private const string MinimalFixture = """
        context Ordering {
          value OrderId { value: String }
        }
        """;

    /// <summary>An emitter that always emits two files under the same path, regardless of the model.</summary>
    private sealed class DuplicatePathEmitter : IEmitter
    {
        public string TargetName => "fake-duplicate";

        public IReadOnlyList<EmittedFile> Emit(KoineModel model) =>
        [
            new EmittedFile("Ordering/OrderId.txt", "first"),
            new EmittedFile("Ordering/OrderId.txt", "second"),
        ];
    }

    [Fact]
    public void Compile_throws_when_an_emitter_produces_duplicate_relative_paths()
    {
        var ex = Should.Throw<InvalidOperationException>(
            () => new KoineCompiler().Compile(MinimalFixture, new DuplicatePathEmitter()));

        ex.Message.ShouldContain("Ordering/OrderId.txt");
        ex.Message.ShouldContain("fake-duplicate");
    }
}
