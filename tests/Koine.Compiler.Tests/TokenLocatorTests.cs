using Koine.Compiler.Grammar;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class TokenLocatorTests
{
    [Fact]
    public void After_colon_and_space_preceding_is_colon_with_empty_partial()
    {
        var ctx = TokenLocator.Locate("value V {\n  amount: \n}\n", line: 1, character: 10);
        Assert.NotNull(ctx.PrecedingToken);
        Assert.Equal(KoineLexer.COLON, ctx.PrecedingToken!.Type);
        Assert.Equal("", ctx.Partial);
        Assert.Null(ctx.CurrentToken);
    }

    [Fact]
    public void Mid_identifier_yields_partial_prefix()
    {
        var ctx = TokenLocator.Locate("value V {\n  status: Dr\n}\n", line: 1, character: 12);
        Assert.NotNull(ctx.CurrentToken);
        Assert.Equal("Dr", ctx.Partial);
    }

    [Fact]
    public void After_dot_preceding_is_dot()
    {
        var src = "entity E identified by EId {\n  invariant lines.\n}\n";
        var ctx = TokenLocator.Locate(src, line: 1, character: 18);
        Assert.NotNull(ctx.PrecedingToken);
        Assert.Equal(KoineLexer.DOT, ctx.PrecedingToken!.Type);
        Assert.Equal("", ctx.Partial);
    }

    [Fact]
    public void Cursor_inside_regex_is_flagged()
    {
        var src = "value V {\n  invariant raw matches /ab/\n}\n";
        var ctx = TokenLocator.Locate(src, line: 1, character: 26);
        Assert.True(ctx.InsideStringOrRegex);
    }

    [Fact]
    public void Enclosing_keyword_tracks_nesting()
    {
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var ctx = TokenLocator.Locate(src, line: 2, character: 4);
        Assert.Equal("service", ctx.EnclosingKeyword);
    }

    [Fact]
    public void Top_level_has_no_enclosing_keyword()
    {
        var ctx = TokenLocator.Locate("\n", line: 0, character: 0);
        Assert.Null(ctx.EnclosingKeyword);
    }

    [Fact]
    public void Broken_document_does_not_throw()
    {
        var ctx = TokenLocator.Locate("context C { value {{{ : ", line: 0, character: 24);
        Assert.NotNull(ctx);
    }
}
