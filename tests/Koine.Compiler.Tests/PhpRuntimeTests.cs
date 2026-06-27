using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Tests for the PHP backend skeleton: <see cref="PhpEmitter"/> is wired as an
/// <c>IEmitter</c> and produces the root support files every generated PHP tree needs.
/// </summary>
public class PhpRuntimeTests
{
    private static IReadOnlyList<EmittedFile> EmitTrivial()
    {
        var result = new KoineCompiler().Compile(
            "context C { value V { x: Int } }",
            new PhpEmitter());
        result.Model.ShouldNotBeNull();
        return result.Files;
    }

    [Fact]
    public void TargetName_is_php()
    {
        new PhpEmitter().TargetName.ShouldBe("php");
    }

    [Fact]
    public void Emit_contains_KoineRuntime_php()
    {
        var files = EmitTrivial();
        files.ShouldContain(f => f.RelativePath == PhpRuntime.FileName);
    }

    [Fact]
    public void KoineRuntime_php_contains_DomainInvariantViolationException()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain("DomainInvariantViolationException");
    }

    [Fact]
    public void KoineRuntime_php_contains_ConcurrencyConflictException()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain("ConcurrencyConflictException");
    }

    [Fact]
    public void KoineRuntime_php_contains_Range()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain("Range");
    }

    [Fact]
    public void KoineRuntime_php_contains_Decimal()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain("Decimal");
    }

    // --- #601: the PHP translator lowers a Decimal/value-object collection fold
    // (.sum/.min/.max) to a runtime static call — `\Koine\Runtime\Decimal::sum/min/max(...)`.
    // Those helpers were never defined on the runtime `Decimal` class, so every emitted fold
    // fataled at runtime (`Call to undefined method ...::sum()`) and tripped phpstan
    // --level max (`staticMethod.notFound`). The runtime must declare all three. ---

    [Theory]
    [InlineData("public static function sum(array $values): self")]
    [InlineData("public static function min(array $values): self")]
    [InlineData("public static function max(array $values): self")]
    public void KoineRuntime_php_declares_static_Decimal_fold(string signature)
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain(signature);
    }

    [Fact]
    public void Emit_contains_composer_json()
    {
        var files = EmitTrivial();
        files.ShouldContain(f => f.RelativePath == "composer.json");
    }

    [Fact]
    public void Emit_contains_phpstan_neon()
    {
        var files = EmitTrivial();
        files.ShouldContain(f => f.RelativePath == "phpstan.neon");
    }

    [Fact]
    public void Composer_json_contains_PSR4_Koine_namespace()
    {
        var files = EmitTrivial();
        var composer = files.Single(f => f.RelativePath == "composer.json");
        composer.Contents.ShouldContain("Koine\\\\");
    }

    [Fact]
    public void KoineRuntime_php_starts_with_php_open_tag()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldStartWith("<?php");
    }

    [Fact]
    public void KoineRuntime_php_has_strict_types()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain("declare(strict_types=1)");
    }

    [Fact]
    public void KoineRuntime_php_has_Koine_Runtime_namespace()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        runtime.Contents.ShouldContain("namespace Koine\\Runtime");
    }

    // --- #616: invariant/requires messages must be emitted as single-quoted PHP
    // literals. PHP interpolates "$word" inside double-quoted strings, so a message
    // containing a '$' was being turned into a reference to an undefined variable
    // (wrong runtime text + phpstan level-max failure). Single quotes reproduce the
    // message verbatim and match the convention already used by the runtime and the
    // expression translator. ---

    /// <summary>Emits a value object whose single invariant carries <paramref name="koineMessage"/>
    /// (already escaped for the .koi string lexer) and returns the concatenated PHP output.</summary>
    private static string EmitValueWithInvariantMessage(string koineMessage)
    {
        var result = new KoineCompiler().Compile(
            "context Billing { value Money { amount: Decimal\n"
            + "  invariant amount >= 0 \"" + koineMessage + "\" } }",
            new PhpEmitter());
        result.Model.ShouldNotBeNull();
        return string.Concat(result.Files.Select(f => f.Contents));
    }

    [Fact]
    public void Invariant_message_with_dollar_is_single_quoted_not_interpolated()
    {
        var php = EmitValueWithInvariantMessage("amount must match $pattern");
        // single-quoted → PHP reproduces "$pattern" verbatim, no variable interpolation
        php.ShouldContain("'amount must match $pattern'");
        // the buggy double-quoted form let PHP interpolate the undefined $pattern
        php.ShouldNotContain("\"amount must match $pattern\"");
    }

    [Fact]
    public void Invariant_message_with_single_quote_is_escaped()
    {
        var php = EmitValueWithInvariantMessage("it's invalid");
        // inside a single-quoted PHP literal a literal apostrophe is written as \'
        php.ShouldContain("'it\\'s invalid'");
    }

    [Fact]
    public void Invariant_message_with_backslash_is_escaped()
    {
        // .koi source "a\\b" unescapes to the single backslash "a\b" in the model;
        // the PHP single-quoted literal must double it back to stay verbatim.
        var php = EmitValueWithInvariantMessage("a\\\\b");
        php.ShouldContain("'a\\\\b'");
    }
}
