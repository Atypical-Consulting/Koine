using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Runs the #1849 cross-context policy fixture — two bounded contexts each declaring a same-named
/// <c>event Shipped</c> with a different payload, plus a <c>policy</c> reacting to the local one —
/// through every backend's <b>real toolchain</b>, in both context source orders.
/// </summary>
/// <remarks>
/// <para><b>Why this exists separately from
/// <see cref="PolicyCrossContextResolutionTests"/>.</b> That suite asserts on emitted <i>text</i>, which
/// is what pins the resolution. But #1739 relaxed a resolution rule, verified only what the validator
/// accepted, and shipped the regression #1797 had to fix — because "the compiler accepts it" and "the
/// generated artifact is valid" are different claims. A string assertion cannot make the second one:
/// only <c>tsc</c>, <c>mypy</c>, <c>phpstan</c>, <c>php -l</c>, <c>javac</c> and Roslyn can. So the
/// model that #1849 newly makes legal is proved to actually BUILD, not merely to validate.</para>
/// <para><b>TypeScript is the load-bearing case.</b> In four backends a policy's reaction is rendered
/// into a doc comment, so a mis-resolved trigger produces wrong documentation. In TypeScript it lands
/// in executable code — <c>reactionArgs</c> returns <c>{ orderId: event.orderId }</c> — so a flat
/// lookup emits <c>{ orderId: orderId }</c>, a reference to an identifier that is not in scope.
/// <c>tsc --strict</c> is the only gate in the repo that catches that.</para>
/// <para>Missing toolchains <b>skip</b> locally and <b>fail</b> in CI, which sets
/// <c>KOINE_REQUIRE_CONFORMANCE=1</c> — see <see cref="TestSupport.RequireOrSkip"/>. Rust and Kotlin
/// are absent by design: neither emitter emits policies at all.</para>
/// </remarks>
public class PolicyCrossContextConformanceTests
{
    private const string NoTsToolchainNotice =
        "No TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

    private const string NoPythonInterpreterNotice =
        "No Python interpreter available locally; syntax check not run. " +
        "Install Python 3 (or set KOINE_PYTHON) — CI runs this for real.";

    private const string NoPythonToolchainNotice =
        "No mypy toolchain available locally; type-check not run. " +
        "Install mypy (or set KOINE_MYPY) — CI runs this for real.";

    private const string NoPhpInterpreterNotice =
        "No PHP interpreter available locally; syntax check not run. " +
        "Install PHP (or set KOINE_PHP) — CI runs this for real.";

    private const string NoPhpToolchainNotice =
        "No PHP toolchain (phpstan) available locally; type-check not run. " +
        "Install phpstan (or set KOINE_PHPSTAN) — CI runs this for real.";

    private const string NoJavaToolchainNotice =
        "No JDK 17+ (javac) available locally; compile not run. " +
        "Install a JDK 17+ (or set KOINE_JAVAC) — CI runs this for real.";

    /// <summary>
    /// The #1849 fixture in the requested source order. <c>false</c> declares <c>Ordering</c> first —
    /// the order that a directory-mode build hits naturally (files are read alphabetically) and the
    /// one that was rejected outright before the fix.
    /// </summary>
    private static string Fixture(bool warehouseFirst) => warehouseFirst
        ? PolicyCrossContextResolutionTests.WarehouseFirstFixture
        : PolicyCrossContextResolutionTests.OrderingFirstFixture;

    private static IReadOnlyList<EmittedFile> Emit(string source, IEmitter emitter)
    {
        CompileResult result = new KoineCompiler().Compile(source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    // C#/Roslyn is deliberately NOT re-run here: PolicyCrossContextResolutionTests already compiles
    // this same fixture through TestSupport.Compile in both orders, and this class exists for the
    // toolchains a string assertion cannot reach.

    /// <summary>
    /// The one target whose policy reaction is executable rather than documentary — see the class
    /// remarks. A flat trigger lookup emits an out-of-scope identifier that only this gate catches.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_typescript_typechecks_under_strict(bool warehouseFirst)
    {
        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(Emit(Fixture(warehouseFirst), new TypeScriptEmitter()));
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoTsToolchainNotice);

        check.Ok.ShouldBeTrue("emitted TypeScript should type-check under tsc --strict:\n" + string.Join("\n", check.Errors));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_python_parses_and_typechecks_under_strict(bool warehouseFirst)
    {
        IReadOnlyList<EmittedFile> files = Emit(Fixture(warehouseFirst), new PythonEmitter());

        TestSupport.PythonCheck syntax = TestSupport.SyntaxCheckPython(files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoPythonInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted Python should parse (ast.parse):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PythonCheck types = TestSupport.TypeCheckPython(files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoPythonToolchainNotice);
        types.Ok.ShouldBeTrue("emitted Python should type-check under mypy --strict:\n" + string.Join("\n", types.Errors));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_php_lints_and_typechecks(bool warehouseFirst)
    {
        IReadOnlyList<EmittedFile> files = Emit(Fixture(warehouseFirst), new PhpEmitter());

        TestSupport.PhpCheck syntax = TestSupport.SyntaxCheckPhp(files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoPhpInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted PHP should lint (php -l):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PhpCheck types = TestSupport.TypeCheckPhp(files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoPhpToolchainNotice);
        types.Ok.ShouldBeTrue("emitted PHP should analyse cleanly under phpstan:\n" + string.Join("\n", types.Errors));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_java_compiles(bool warehouseFirst)
    {
        TestSupport.JavaCheck check = TestSupport.CompileJava(Emit(Fixture(warehouseFirst), new JavaEmitter()));
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoJavaToolchainNotice);

        check.Ok.ShouldBeTrue("emitted Java should compile under javac:\n" + string.Join("\n", check.Errors));
    }
}
