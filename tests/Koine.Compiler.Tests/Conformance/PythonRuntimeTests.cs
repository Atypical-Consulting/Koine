using System.Linq;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Task 1 of the Python backend: the smallest end-to-end slice. Proves the emitter seam, the
/// CLI dispatch target name, and that the four project-root support files are emitted —
/// the fixed-string <c>koine_runtime.py</c> plus <c>mypy.ini</c>, <c>py.typed</c>, and
/// <c>pyproject.toml</c>. No domain construct is emitted yet, so a model with a single value
/// object must still produce exactly these root files.
/// </summary>
public class PythonRuntimeTests
{
    private static EmittedFile? Find(IReadOnlyList<EmittedFile> files, string path) =>
        files.FirstOrDefault(f => f.RelativePath == path);

    [Fact]
    public void Target_name_is_python()
    {
        Assert.Equal("python", new PythonEmitter().TargetName);
    }

    [Fact]
    public void Emits_runtime_and_root_support_files()
    {
        var result = new KoineCompiler().Compile("context C { value V { x: Int } }", new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        EmittedFile? runtime = Find(result.Files, "koine_runtime.py");
        Assert.NotNull(runtime);
        Assert.Contains("class DomainInvariantViolationError", runtime!.Contents);
        Assert.Contains("class ConcurrencyConflictError", runtime.Contents);
        Assert.Contains("class Range", runtime.Contents);

        Assert.NotNull(Find(result.Files, "mypy.ini"));
        Assert.NotNull(Find(result.Files, "py.typed"));
        Assert.NotNull(Find(result.Files, "pyproject.toml"));
    }
}
