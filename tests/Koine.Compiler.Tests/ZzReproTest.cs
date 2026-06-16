using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;
using Xunit;
using Xunit.Abstractions;

namespace Koine.Compiler.Tests;

public class ZzReproTest
{
    private readonly ITestOutputHelper _o;
    public ZzReproTest(ITestOutputHelper o) => _o = o;

    [Theory]
    [InlineData("context C { enum E { Other, Default } }", "default")]
    [InlineData("context C { enum E { Other, Klass } }", "class")]
    public void KeywordMember(string _, string kw)
    {
        var src = $"context C {{ enum E {{ Other, {kw} }} }}";
        var diags = new KoineCompiler().Diagnose(src);
        _o.WriteLine("DIAGS: " + string.Join("\n", diags.Select(d => d.ToString())));
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        _o.WriteLine("Compile.Success = " + result.Success);
        if (result.Success)
        {
            _o.WriteLine(TestSupport.Render(result.Files));
            var (asm, errors) = TestSupport.Compile(result.Files);
            _o.WriteLine("ROSLYN errors: " + string.Join("\n", errors));
            _o.WriteLine("Assembly null? " + (asm is null));
        }
    }
}
