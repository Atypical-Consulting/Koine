using Koine.Compiler.Grammar;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class TokenLocatorTests
{
    [Fact]
    public void After_colon_and_space_preceding_is_colon_with_empty_partial()
    {
        var ctx = TokenLocator.Locate("value V {\n  amount: \n}\n", line: 1, character: 10);
        ctx.PrecedingToken.ShouldNotBeNull();
        ctx.PrecedingToken!.Type.ShouldBe(KoineLexer.COLON);
        ctx.Partial.ShouldBe("");
        ctx.CurrentToken.ShouldBeNull();
    }

    [Fact]
    public void Mid_identifier_yields_partial_prefix()
    {
        var ctx = TokenLocator.Locate("value V {\n  status: Dr\n}\n", line: 1, character: 12);
        ctx.CurrentToken.ShouldNotBeNull();
        ctx.Partial.ShouldBe("Dr");
    }

    [Fact]
    public void After_dot_preceding_is_dot()
    {
        var src = "entity E identified by EId {\n  invariant lines.\n}\n";
        var ctx = TokenLocator.Locate(src, line: 1, character: 18);
        ctx.PrecedingToken.ShouldNotBeNull();
        ctx.PrecedingToken!.Type.ShouldBe(KoineLexer.DOT);
        ctx.Partial.ShouldBe("");
    }

    [Fact]
    public void Cursor_inside_regex_is_flagged()
    {
        var src = "value V {\n  invariant raw matches /ab/\n}\n";
        var ctx = TokenLocator.Locate(src, line: 1, character: 26);
        ctx.InsideStringOrRegex.ShouldBeTrue();
    }

    [Fact]
    public void Enclosing_keyword_tracks_nesting()
    {
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var ctx = TokenLocator.Locate(src, line: 2, character: 4);
        ctx.EnclosingKeyword.ShouldBe("service");
    }

    [Fact]
    public void Top_level_has_no_enclosing_keyword()
    {
        var ctx = TokenLocator.Locate("\n", line: 0, character: 0);
        ctx.EnclosingKeyword.ShouldBeNull();
    }

    [Fact]
    public void Broken_document_does_not_throw()
    {
        var ctx = TokenLocator.Locate("context C { value {{{ : ", line: 0, character: 24);
        ctx.ShouldNotBeNull();
    }

    [Fact]
    public void Cursor_inside_doc_comment_is_flagged()
    {
        // /// docs ...   — completion is intentionally suppressed inside doc comments
        var src = "/// describes the value\nvalue V {\n}\n";
        var ctx = TokenLocator.Locate(src, line: 0, character: 8);
        ctx.InsideStringOrRegex.ShouldBeTrue();
    }

    [Fact]
    public void Token_before_preceding_is_two_tokens_back()
    {
        // "  x: String" — cursor inside "String": current=String, preceding=':', beforePreceding='x'
        var ctx = TokenLocator.Locate("value V {\n  x: String\n}\n", line: 1, character: 8);
        ctx.TokenBeforePreceding.ShouldNotBeNull();
        ctx.TokenBeforePreceding!.Text.ShouldBe("x");
    }

    [Fact]
    public void Partial_is_prefix_up_to_cursor_mid_token()
    {
        // "  status: Dr" — cursor between 'D' and 'r' (character 11) yields "D"
        var ctx = TokenLocator.Locate("value V {\n  status: Dr\n}\n", line: 1, character: 11);
        ctx.Partial.ShouldBe("D");
    }
}
