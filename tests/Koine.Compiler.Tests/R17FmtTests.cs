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
        foreach (var dir in new[] { "examples", "demo" })
            foreach (var f in Directory.EnumerateFiles(Path.Combine(root, dir), "*.koi", SearchOption.AllDirectories))
                yield return new object[] { f };
    }

    [Theory]
    [MemberData(nameof(AllFixtures))]
    public void Formatting_is_idempotent(string path)
    {
        var once = Fmt.Format(File.ReadAllText(path)).Text;
        var twice = Fmt.Format(once).Text;
        Assert.Equal(once, twice);
    }

    [Theory]
    [MemberData(nameof(AllFixtures))]
    public void Formatting_preserves_the_code_token_stream(string path)
    {
        // The formatter must only touch whitespace: the default-channel token sequence
        // (type + exact text — so string/regex literals are byte-identical) is unchanged.
        var src = File.ReadAllText(path);
        var formatted = Fmt.Format(src).Text;
        Assert.Equal(CodeTokens(src), CodeTokens(formatted));
    }

    [Theory]
    [MemberData(nameof(AllFixtures))]
    public void Formatting_preserves_every_comment(string path)
    {
        var src = File.ReadAllText(path);
        var formatted = Fmt.Format(src).Text;
        Assert.Equal(CommentCount(src), CommentCount(formatted));
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
        Assert.Equal(expected, Fmt.Format(messy).Text);
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
        Assert.Contains("  customer: CustomerId", formatted);
        Assert.Contains("  lines:    List<OrderLine>", formatted);
        Assert.Contains("  note:     String?", formatted);
    }

    [Fact]
    public void Check_flags_unformatted_and_accepts_canonical()
    {
        const string messy = "context C {\n  value Money{amount:Decimal}\n}\n";
        Assert.True(Fmt.Format(messy).Changed);                 // messy → needs formatting (exit 1 under --check)
        var canonical = Fmt.Format(messy).Text;
        Assert.False(Fmt.Format(canonical).Changed);            // canonical → already formatted (exit 0)
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
        Assert.Contains("/// A monetary amount.", formatted);
        Assert.Contains("// the raw value", formatted);
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
        Assert.DoesNotContain("\n\n\n", formatted);          // no run of 2+ blank lines
        Assert.StartsWith("context C {\n  value A", formatted); // no blank hugging the opening brace
        Assert.EndsWith("value B { y: Int }\n}\n", formatted);  // no blank hugging the closing brace
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
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
