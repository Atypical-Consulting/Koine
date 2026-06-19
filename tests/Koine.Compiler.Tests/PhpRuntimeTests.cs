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
        Assert.NotNull(result.Model);
        return result.Files;
    }

    [Fact]
    public void TargetName_is_php()
    {
        Assert.Equal("php", new PhpEmitter().TargetName);
    }

    [Fact]
    public void Emit_contains_KoineRuntime_php()
    {
        var files = EmitTrivial();
        Assert.Contains(files, f => f.RelativePath == PhpRuntime.FileName);
    }

    [Fact]
    public void KoineRuntime_php_contains_DomainInvariantViolationException()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.Contains("DomainInvariantViolationException", runtime.Contents);
    }

    [Fact]
    public void KoineRuntime_php_contains_ConcurrencyConflictException()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.Contains("ConcurrencyConflictException", runtime.Contents);
    }

    [Fact]
    public void KoineRuntime_php_contains_Range()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.Contains("Range", runtime.Contents);
    }

    [Fact]
    public void KoineRuntime_php_contains_Decimal()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.Contains("Decimal", runtime.Contents);
    }

    [Fact]
    public void Emit_contains_composer_json()
    {
        var files = EmitTrivial();
        Assert.Contains(files, f => f.RelativePath == "composer.json");
    }

    [Fact]
    public void Emit_contains_phpstan_neon()
    {
        var files = EmitTrivial();
        Assert.Contains(files, f => f.RelativePath == "phpstan.neon");
    }

    [Fact]
    public void Composer_json_contains_PSR4_Koine_namespace()
    {
        var files = EmitTrivial();
        var composer = files.Single(f => f.RelativePath == "composer.json");
        Assert.Contains("Koine\\\\", composer.Contents);
    }

    [Fact]
    public void KoineRuntime_php_starts_with_php_open_tag()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.StartsWith("<?php", runtime.Contents);
    }

    [Fact]
    public void KoineRuntime_php_has_strict_types()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.Contains("declare(strict_types=1)", runtime.Contents);
    }

    [Fact]
    public void KoineRuntime_php_has_Koine_Runtime_namespace()
    {
        var files = EmitTrivial();
        var runtime = files.Single(f => f.RelativePath == PhpRuntime.FileName);
        Assert.Contains("namespace Koine\\Runtime", runtime.Contents);
    }
}
