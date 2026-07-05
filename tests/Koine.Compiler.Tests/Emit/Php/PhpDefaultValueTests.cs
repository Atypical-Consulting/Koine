using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #971 reachability probe: PHP only permits constant expressions in default-value
/// positions (constructor-promoted property defaults / plain parameter defaults). A member whose
/// initializer does NOT reference a sibling member is classified as a "constant default"
/// (<see cref="Koine.Compiler.Ast.MemberAnalysis.IsDerived"/> returns <c>false</c>) and is embedded
/// directly into that PHP default position by <c>PhpEmitter.WriteConstructor</c> /
/// <c>WriteEntityConstructor</c>. A bare <c>Decimal</c> literal default lowers to
/// <c>new \Koine\Runtime\Decimal('n')</c> — legal via PHP 8.1's "new in initializers". But a
/// <b>computed</b> Decimal-arithmetic default (e.g. <c>0.1 + 0.05</c>, whose operands are literals so
/// it never references a sibling) lowers through <see cref="PhpExpressionTranslator.WriteDecimalBinary"/>
/// to a <b>method-call chain</b> (<c>-&gt;add(...)</c>) — never a constant expression in PHP, not even
/// on the project's PHP 8.5 floor. This is genuinely reachable (confirmed by this probe), not merely
/// theoretical.
/// </summary>
public class PhpDefaultValueTests
{
    private const string NoInterpreterNotice =
        "No PHP interpreter available locally; syntax check not run. " +
        "Install PHP (or set KOINE_PHP) — CI runs this for real.";

    /// <summary>
    /// A bare Decimal-literal default is unaffected: it renders as a <c>new</c> expression, which
    /// PHP 8.1's "new in initializers" permits in a constant-required position. Pinned so the fix for
    /// the computed-arithmetic case below can't regress the already-valid literal path.
    /// </summary>
    [Fact]
    public void Bare_decimal_literal_default_emits_a_valid_new_expression()
    {
        const string src =
            "context Pricing {\n" +
            "  value Rate {\n" +
            "    amount: Decimal = 0.1\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var php = string.Join("\n", result.Files.Select(f => f.Contents));
        php.ShouldContain("$amount = new \\Koine\\Runtime\\Decimal('0.1')");

        var r = TestSupport.SyntaxCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoInterpreterNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The reachability probe (issue #971, Task 1): a value-object member whose default is
    /// <b>computed</b> Decimal arithmetic (<c>0.1 + 0.05</c>) — but does not reference any sibling
    /// member, so it is NOT classified as derived — must still emit valid PHP. Before the fix this
    /// lowered to <c>public readonly Decimal $amount = (new Decimal('0.1'))-&gt;add(new
    /// Decimal('0.05'))</c>, a method call in a PHP constant-required default position, which
    /// <c>php -l</c> rejects with "Constant expression contains invalid operations".
    /// </summary>
    [Fact]
    public void Computed_decimal_default_on_a_value_object_emits_valid_php()
    {
        const string src =
            "context Pricing {\n" +
            "  value Rate {\n" +
            "    amount: Decimal = 0.1 + 0.05\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Scope to the emitted VALUE OBJECT file — the shared KoineRuntime.php legitimately defines
        // its own `add()` method, so asserting over the whole file set would false-positive on that.
        var php = result.Files.Single(f => f.RelativePath.EndsWith("Rate.php")).Contents;
        php.ShouldNotContain("->add(");

        var r = TestSupport.SyntaxCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoInterpreterNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The same reachability probe on an <b>entity</b> constructor parameter default
    /// (<c>PhpEmitter.WriteEntityConstructor</c> — the sibling code path to the value-object
    /// constructor above), confirming the bug is not limited to value objects.
    /// </summary>
    [Fact]
    public void Computed_decimal_default_on_an_entity_emits_valid_php()
    {
        const string src =
            "context Pricing {\n" +
            "  entity Discount identified by DiscountId {\n" +
            "    rate: Decimal = 0.1 + 0.05\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var php = result.Files.Single(f => f.RelativePath.EndsWith("Discount.php")).Contents;
        php.ShouldNotContain("->add(");

        var r = TestSupport.SyntaxCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoInterpreterNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A computed default that DOES reference a sibling member is already routed through the
    /// derived-member getter path (never a constructor default at all) — this stays green
    /// unconditionally and pins that the fix for the non-sibling-referencing case above does not
    /// touch this already-correct path.
    /// </summary>
    [Fact]
    public void Computed_decimal_default_referencing_a_sibling_stays_a_getter()
    {
        const string src =
            "context Pricing {\n" +
            "  value Rate {\n" +
            "    base: Decimal\n" +
            "    surcharge: Decimal\n" +
            "    total: Decimal = base + surcharge\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var php = string.Join("\n", result.Files.Select(f => f.Contents));
        php.ShouldContain("public function total(): \\Koine\\Runtime\\Decimal");
        php.ShouldContain("return $this->base->add($this->surcharge);");
    }
}
