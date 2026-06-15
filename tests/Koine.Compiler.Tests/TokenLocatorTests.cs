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

    [Fact]
    public void Cursor_inside_doc_comment_is_flagged()
    {
        // /// docs ...   — completion is intentionally suppressed inside doc comments
        var src = "/// describes the value\nvalue V {\n}\n";
        var ctx = TokenLocator.Locate(src, line: 0, character: 8);
        Assert.True(ctx.InsideStringOrRegex);
    }

    [Fact]
    public void Token_before_preceding_is_two_tokens_back()
    {
        // "  x: String" — cursor inside "String": current=String, preceding=':', beforePreceding='x'
        var ctx = TokenLocator.Locate("value V {\n  x: String\n}\n", line: 1, character: 8);
        Assert.NotNull(ctx.TokenBeforePreceding);
        Assert.Equal("x", ctx.TokenBeforePreceding!.Text);
    }

    [Fact]
    public void Partial_is_prefix_up_to_cursor_mid_token()
    {
        // "  status: Dr" — cursor between 'D' and 'r' (character 11) yields "D"
        var ctx = TokenLocator.Locate("value V {\n  status: Dr\n}\n", line: 1, character: 11);
        Assert.Equal("D", ctx.Partial);
    }
}
