using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the contract of the shared code-action helpers (#356) that replaced the byte-identical /
/// divergent copies in <see cref="RefactorService"/>, <see cref="KoineLanguageService"/>, and the
/// duplicate-rename quick fix: the offset→line/column map and identifier-boundary predicates
/// (<see cref="SourceTextGeometry"/>), the field-member projection, and the name uniquifier
/// (<see cref="ModelNavigation"/>). These assertions encode the single agreed behavior so the
/// consolidation stays behavior-preserving.
/// </summary>
public class SharedCodeActionHelpersTests
{
    [Fact]
    public void LineColumn_is_one_based_and_resets_the_column_after_each_newline()
    {
        const string text = "ab\ncde";
        SourceTextGeometry.LineColumn(text, 0).ShouldBe((1, 1));
        SourceTextGeometry.LineColumn(text, 2).ShouldBe((1, 3)); // the '\n'
        SourceTextGeometry.LineColumn(text, 3).ShouldBe((2, 1)); // first char of line 2
        SourceTextGeometry.LineColumn(text, 5).ShouldBe((2, 3));
    }

    [Fact]
    public void LineColumn_clamps_an_out_of_range_offset_to_the_end()
    {
        const string text = "ab\ncde";
        SourceTextGeometry.LineColumn(text, 999).ShouldBe(SourceTextGeometry.LineColumn(text, text.Length));
    }

    [Fact]
    public void IsWholeWordAt_rejects_a_substring_and_accepts_a_bordered_identifier()
    {
        SourceTextGeometry.IsWholeWordAt("MoneyBag", 0, "Money".Length).ShouldBeFalse(); // followed by 'B'
        SourceTextGeometry.IsWholeWordAt("BigMoney", 3, "Money".Length).ShouldBeFalse(); // preceded by 'g'
        SourceTextGeometry.IsWholeWordAt("a Money b", 2, "Money".Length).ShouldBeTrue();  // space on both sides
        SourceTextGeometry.IsWholeWordAt("Money", 0, "Money".Length).ShouldBeTrue();      // at both buffer ends
    }

    [Theory]
    [InlineData('a', true)]
    [InlineData('Z', true)]
    [InlineData('0', true)]
    [InlineData('_', true)]
    [InlineData(' ', false)]
    [InlineData('-', false)]
    [InlineData('.', false)]
    public void IsIdentifierChar_matches_letters_digits_and_underscore(char c, bool expected) =>
        SourceTextGeometry.IsIdentifierChar(c).ShouldBe(expected);

    [Fact]
    public void MembersOf_returns_the_fields_for_every_member_bearing_kind_including_integration_events()
    {
        // value / entity / event / integration event all carry a Members list; each must surface it.
        var src =
            "context C {\n" +
            "  value V { a: String }\n" +
            "  entity E identified by EId { b: String }\n" +
            "  event Ev { c: String }\n" +
            "  integration event Ie { d: String }\n" +
            "}\n";
        var types = Parse(src).Contexts[0].Types;

        types.Single(t => t.Name == "V").MembersOf().Select(m => m.Name).ShouldBe(["a"]);
        types.Single(t => t.Name == "E").MembersOf().Select(m => m.Name).ShouldBe(["b"]);
        types.Single(t => t.Name == "Ev").MembersOf().Select(m => m.Name).ShouldBe(["c"]);
        types.Single(t => t.Name == "Ie").MembersOf().Select(m => m.Name).ShouldBe(["d"]);
    }

    [Fact]
    public void MembersOf_returns_an_empty_list_for_a_kind_that_carries_no_fields()
    {
        var src =
            "context C {\n" +
            "  enum Color { Red Green }\n" +
            "}\n";
        TypeDecl color = Parse(src).Contexts[0].Types.Single(t => t.Name == "Color");

        IReadOnlyList<Member> members = color.MembersOf();
        members.ShouldNotBeNull(); // never null — callers iterate uniformly
        members.ShouldBeEmpty();
    }

    [Fact]
    public void UniqueName_returns_the_base_name_when_it_is_free()
    {
        var taken = new HashSet<string>(StringComparer.Ordinal) { "Other" };
        ModelNavigation.UniqueName("Money", taken).ShouldBe("Money");
    }

    [Fact]
    public void UniqueName_appends_the_first_free_numeric_suffix_when_the_base_name_is_taken()
    {
        var taken = new HashSet<string>(StringComparer.Ordinal) { "Money", "Money2" };
        ModelNavigation.UniqueName("Money", taken).ShouldBe("Money3");
    }

    private static KoineModel Parse(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return model;
    }
}
