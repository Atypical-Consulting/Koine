using Antlr4.Runtime;
using Koine.Compiler.Formatting;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Tests;

/// <summary>Epic R17.3 — <c>koine fmt</c>: canonical, idempotent, comment-preserving formatting.</summary>
public class R17FmtTests
{
    private static readonly KoineFormatter Fmt = new();

    // ---- properties over the whole fixture corpus --------------------------

    public static IEnumerable<object[]> AllFixtures()
    {
        var root = RepoRoot();
        foreach (var dir in new[] { "examples", "demo", "templates" })
        {
            foreach (var f in Directory.EnumerateFiles(Path.Combine(root, dir), "*.koi", SearchOption.AllDirectories))
            {
                yield return new object[] { f };
            }
        }
    }

    [Theory]
    [MemberData(nameof(AllFixtures))]
    public void Formatting_is_idempotent(string path)
    {
        var once = Fmt.Format(File.ReadAllText(path)).Text;
        var twice = Fmt.Format(once).Text;
        twice.ShouldBe(once);
    }

    [Theory]
    [MemberData(nameof(AllFixtures))]
    public void Formatting_preserves_the_code_token_stream(string path)
    {
        // The formatter must only touch whitespace: the default-channel token sequence
        // (type + exact text — so string/regex literals are byte-identical) is unchanged.
        var src = File.ReadAllText(path);
        var formatted = Fmt.Format(src).Text;
        CodeTokens(formatted).ShouldBe(CodeTokens(src));
    }

    [Theory]
    [MemberData(nameof(AllFixtures))]
    public void Formatting_preserves_every_comment(string path)
    {
        var src = File.ReadAllText(path);
        var formatted = Fmt.Format(src).Text;
        CommentCount(formatted).ShouldBe(CommentCount(src));
    }

    // ---- canonical style & --check semantics -------------------------------

    [Fact]
    public void Formats_messy_input_to_canonical_style()
    {
        const string messy =
            "context C {\n" +
            "value Money{\n" +
            "amount:Decimal\n" +
            "currency:   Currency\n" +
            "invariant amount>=0    \"neg\"\n" +
            "}\n" +
            "}\n";
        const string expected =
            "context C {\n" +
            "  value Money {\n" +
            "    amount:   Decimal\n" +
            "    currency: Currency\n" +
            "    invariant amount >= 0 \"neg\"\n" +
            "  }\n" +
            "}\n";
        Fmt.Format(messy).Text.ShouldBe(expected);
    }

    [Fact]
    public void Aligns_generic_and_optional_member_types()
    {
        const string messy =
            "context C {\n" +
            "entity Order identified by OrderId {\n" +
            "customer:CustomerId\n" +
            "lines:List<OrderLine>\n" +
            "note:String?\n" +
            "}\n" +
            "}\n";
        var formatted = Fmt.Format(messy).Text;
        formatted.ShouldContain("  customer: CustomerId");
        formatted.ShouldContain("  lines:    List<OrderLine>");
        formatted.ShouldContain("  note:     String?");
    }

    [Fact]
    public void Check_flags_unformatted_and_accepts_canonical()
    {
        const string messy = "context C {\n  value Money{amount:Decimal}\n}\n";
        Fmt.Format(messy).Changed.ShouldBeTrue();                 // messy → needs formatting (exit 1 under --check)
        var canonical = Fmt.Format(messy).Text;
        Fmt.Format(canonical).Changed.ShouldBeFalse();            // canonical → already formatted (exit 0)
    }

    [Fact]
    public void Preserves_doc_and_trailing_line_comments()
    {
        const string src =
            "context C {\n" +
            "  /// A monetary amount.\n" +
            "  value Money {\n" +
            "    amount: Decimal // the raw value\n" +
            "  }\n" +
            "}\n";
        var formatted = Fmt.Format(src).Text;
        formatted.ShouldContain("/// A monetary amount.");
        formatted.ShouldContain("// the raw value");
    }

    [Fact]
    public void Collapses_blank_runs_and_unhugs_braces()
    {
        const string src =
            "context C {\n" +
            "\n" +
            "\n" +
            "  value A { x: Int }\n" +
            "\n" +
            "\n" +
            "  value B { y: Int }\n" +
            "\n" +
            "}\n";
        var formatted = Fmt.Format(src).Text;
        formatted.ShouldNotContain("\n\n\n");          // no run of 2+ blank lines
        formatted.ShouldStartWith("context C {\n  value A"); // no blank hugging the opening brace
        formatted.ShouldEndWith("value B { y: Int }\n}\n");  // no blank hugging the closing brace
    }

    // ---- helpers -----------------------------------------------------------

    private static List<(int Type, string Text)> CodeTokens(string src) =>
        Lex(src)
            .Where(t => t.Type != TokenConstants.EOF && t.Channel == TokenConstants.DefaultChannel)
            .Select(t => (t.Type, t.Text))
            .ToList();

    private static int CommentCount(string src) =>
        Lex(src).Count(t => t.Type is KoineLexer.LINE_COMMENT or KoineLexer.BLOCK_COMMENT or KoineLexer.DocComment);

    private static IList<IToken> Lex(string src)
    {
        var lexer = new KoineLexer(new AntlrInputStream(src));
        lexer.RemoveErrorListeners();
        return lexer.GetAllTokens();
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "examples")))
        {
            dir = dir.Parent;
        }

        dir.ShouldNotBeNull();
        return dir.FullName;
    }
}
