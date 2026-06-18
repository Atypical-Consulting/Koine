using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Guards the byte-identical-emission invariant: compiling the same source twice with two
/// independent <see cref="PythonEmitter"/> instances must produce character-for-character identical
/// output. The runtime is a fixed string constant and type iteration follows declaration order, so
/// this must hold by construction; the test makes it machine-enforced.
/// </summary>
public class PythonDeterminismTests
{
    /// <summary>
    /// Compiles <see cref="PythonSnapshotTests.Fixture"/> twice with two fresh emitter instances
    /// and asserts the rendered outputs are byte-identical.
    /// </summary>
    [Fact]
    public void Emitting_twice_is_byte_identical()
    {
        var compiler = new KoineCompiler();

        var result1 = compiler.Compile(PythonSnapshotTests.Fixture, new PythonEmitter());
        Assert.True(result1.Success,
            "First compile failed: " + string.Join("\n", result1.Diagnostics.Select(d => d.ToString())));

        var result2 = compiler.Compile(PythonSnapshotTests.Fixture, new PythonEmitter());
        Assert.True(result2.Success,
            "Second compile failed: " + string.Join("\n", result2.Diagnostics.Select(d => d.ToString())));

        var rendered1 = TestSupport.Render(result1.Files);
        var rendered2 = TestSupport.Render(result2.Files);

        Assert.Equal(rendered1, rendered2);
    }
}
