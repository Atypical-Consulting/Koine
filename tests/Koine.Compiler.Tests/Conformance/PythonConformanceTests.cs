using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;
using Xunit.Abstractions;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Python backend. This exercises the
/// <see cref="TestSupport.TypeCheckPython"/> plumbing (write emitted <c>.py</c> → run
/// <c>mypy --strict</c>) plus the always-on <see cref="TestSupport.SyntaxCheckPython"/>
/// (<c>ast.parse</c> over every emitted module) so it is ready to validate the Python emitter as it
/// lands. When no <c>mypy</c>/Python toolchain is present locally the type-check is reported as
/// INCONCLUSIVE (a notice on the test output, no assertion) rather than failing — keeping
/// <c>dotnet test</c> green without a Python toolchain. It NEVER silently passes a real error: a real
/// error is only assertable when <c>mypy</c> is present, and then it IS asserted. CI is expected to
/// provide the toolchain and therefore actually run the check.
/// </summary>
/// <remarks>
/// Dynamic skip (<c>Assert.Skip</c>) is an xUnit v3 feature; on the v2 (2.9.x) runner here it is
/// reported as a failure, so an absent toolchain is surfaced as a logged inconclusive notice.
/// </remarks>
public class PythonConformanceTests
{
    private readonly ITestOutputHelper _output;

    public PythonConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no Python toolchain (mypy) available locally; type-check not run. " +
        "Install mypy (or set KOINE_MYPY) — CI runs this for real.";

    private const string NoInterpreterNotice =
        "INCONCLUSIVE: no Python interpreter available locally; syntax check not run. " +
        "Install Python 3.11+ (or set KOINE_PYTHON) — CI runs this for real.";

    /// <summary>Clean, <c>--strict</c>-correct Python must type-check (inconclusive if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_well_typed_python()
    {
        var files = new[]
        {
            new EmittedFile("ok.py", "def f(x: int) -> int:\n    return x\n"),
        };

        var r = TestSupport.TypeCheckPython(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(r.Ok, string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real <c>--strict</c> type error must be reported, not silently swallowed — this proves the
    /// harness is a genuine check (the analogue of the TypeScript negative fixture).
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_typed_python()
    {
        var files = new[]
        {
            // Returns a str from a function annotated to return int → a real mypy --strict error.
            new EmittedFile("bad.py", "def f(x: int) -> int:\n    return \"nope\"\n"),
        };

        var r = TestSupport.TypeCheckPython(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.False(r.Ok);
        Assert.NotEmpty(r.Errors);
    }

    /// <summary>A missing toolchain yields an inconclusive-shaped result rather than a false pass.</summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        Assert.False(TestSupport.PythonCheck.Skipped.ToolchainAvailable);
        Assert.False(TestSupport.PythonCheck.Skipped.Ok);
        Assert.Empty(TestSupport.PythonCheck.Skipped.Errors);
    }

    /// <summary>
    /// The always-on syntax gate: a snippet using 3.11+ syntax (a <c>match</c> statement and a
    /// PEP&#160;604 <c>int | None</c> union) must parse via <c>ast.parse</c>. Inconclusive (logged,
    /// not failed) only when no interpreter is present; with one it MUST parse cleanly.
    /// </summary>
    [Fact]
    public void Syntax_check_parses_well_formed_python()
    {
        var files = new[]
        {
            new EmittedFile("syntax.py",
                "def classify(x: int | None) -> str:\n" +
                "    match x:\n" +
                "        case None:\n" +
                "            return \"none\"\n" +
                "        case _:\n" +
                "            return \"some\"\n"),
        };

        var r = TestSupport.SyntaxCheckPython(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
            return;
        }

        Assert.True(r.Ok, string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The Task-5 acceptance check: the Python the emitter actually produces for the shared Phase-1
    /// fixture must parse (<c>ast.parse</c>) and type-check cleanly under <c>mypy --strict</c>. In this
    /// task only the regular value objects emit (the quantity/enum/entity/event constructs land
    /// later), so the tree is the runtime + root files + value-object modules + their <c>__init__.py</c>s
    /// — and it must be dangling-import-free and strict-clean. Inconclusive (logged, not failed) only
    /// when no toolchain is present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_python_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(PythonSnapshotTests.Fixture, new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(result.Files);
        if (!syntax.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
        }
        else
        {
            Assert.True(syntax.Ok, "emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));
        }

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(result.Files);
        if (!types.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(types.Ok, "emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }
}
