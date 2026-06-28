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

    // ---- Navigation vs completion containment at the first column (#620) ----

    [Fact]
    public void Navigation_resolves_a_token_at_its_first_column()
    {
        // "  amount: Decimal" — 'amount' starts at column 2.
        var src = "value V {\n  amount: Decimal\n}\n";

        // Completion's (start, end] containment treats the first column as NOT inside
        // the token (the caret there belongs to whatever sits to its left).
        TokenLocator.Locate(src, line: 1, character: 2).CurrentToken.ShouldBeNull();

        // Navigation opts into inclusive-start [start, end] containment, so the same
        // first column now resolves the identifier under it.
        var nav = TokenLocator.Locate(src, line: 1, character: 2, navigation: true);
        nav.CurrentToken.ShouldNotBeNull();
        nav.CurrentToken!.Text.ShouldBe("amount");
    }

    [Fact]
    public void Navigation_resolves_a_single_character_identifier_on_its_only_glyph()
    {
        // "value V {" — the single-char type name 'V' sits at column 6. Its only inside
        // position under completion's (start, end] is its end (column 7), so its sole
        // glyph (column 6) is dead for navigation until inclusive-start containment.
        var src = "value V {\n}\n";

        TokenLocator.Locate(src, line: 0, character: 6).CurrentToken.ShouldBeNull();

        var nav = TokenLocator.Locate(src, line: 0, character: 6, navigation: true);
        nav.CurrentToken.ShouldNotBeNull();
        nav.CurrentToken!.Text.ShouldBe("V");
    }

    [Fact]
    public void Completion_containment_is_unchanged_inside_and_at_the_end_of_a_token()
    {
        // The default (navigation: false) call keeps completion's (start, end] bias: a caret
        // one column in resolves the token, and a caret at its end still belongs to it.
        var src = "value V {\n  amount: Decimal\n}\n"; // 'amount' spans columns [2, 8)

        TokenLocator.Locate(src, line: 1, character: 3).CurrentToken!.Text.ShouldBe("amount"); // one in
        TokenLocator.Locate(src, line: 1, character: 8).CurrentToken!.Text.ShouldBe("amount"); // at end
    }
}
