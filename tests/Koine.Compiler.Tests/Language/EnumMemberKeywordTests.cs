using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression coverage for #1836: a keyword used as an enum member (or as the enum's own name)
/// left <c>BuildEnum</c> dereferencing a null <c>Identifier()</c> after ANTLR's error recovery,
/// throwing an unhandled <see cref="NullReferenceException"/> instead of degrading to a located
/// diagnostic. Same family as #1749's "<c>Diagnose()</c> must never throw" invariant.
/// </summary>
public class EnumMemberKeywordTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) =>
        new KoineCompiler().Diagnose(source, "repro.koi");

    [Theory]
    [InlineData("publish")]
    [InlineData("emit")]
    [InlineData("publishes")]
    [InlineData("command")]
    [InlineData("event")]
    public void A_keyword_used_as_an_enum_member_does_not_throw_and_reports_a_located_error(string keyword)
    {
        var source = $"context Ordering {{\n  enum Mode {{ {keyword} }}\n}}\n";

        var diagnostics = Should.NotThrow(() => Diagnose(source));

        diagnostics.ShouldContain(d => d.Severity == DiagnosticSeverity.Error && d.Line > 0);
    }

    [Fact]
    public void A_keyword_used_as_the_enums_own_name_does_not_throw_and_reports_a_located_error()
    {
        const string source = "context Ordering {\n  enum publish { A }\n}\n";

        var diagnostics = Should.NotThrow(() => Diagnose(source));

        diagnostics.ShouldContain(d => d.Severity == DiagnosticSeverity.Error && d.Line > 0);
    }

    [Fact]
    public void A_keyword_member_of_a_smart_enum_with_associated_data_does_not_throw()
    {
        const string source = """
            context Ordering {
              enum Currency(symbol: String) { publish("€") }
            }
            """;

        var diagnostics = Should.NotThrow(() => Diagnose(source));

        diagnostics.ShouldContain(d => d.Severity == DiagnosticSeverity.Error && d.Line > 0);
    }
}
