using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class SignatureHelpTests
{
    private static readonly KoineLanguageService Svc = new();
    private const string U = "file:///t.koi";

    private static IReadOnlyDictionary<string, string> Doc(string src) =>
        new Dictionary<string, string> { [U] = src };

    // An entity factory exposes a typed parameter list, matching the real grammar
    // (see demo/Shop.Domain/Models/payments.koi: `create authorize(order: OrderId, ...)`).
    private const string Src =
        "context C {\n" +
        "  aggregate A root E {\n" +
        "    entity E identified by EId {\n" +
        "      qty: Decimal\n" +
        "      create place(a: Decimal, b: Decimal) {\n" +
        "        qty <- a\n" +
        "      }\n" +
        "    }\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Inside_open_paren_returns_params_with_active_zero()
    {
        // Cursor just after `place(` — line index 4, just after the '(' at the call site.
        // Find the column of the '(' by locating "place(" in the line.
        var line = 4;
        var lineText = Src.Replace("\r\n", "\n").Split('\n')[line];
        var ch = lineText.IndexOf("place(", StringComparison.Ordinal) + "place(".Length;

        var help = Svc.SignatureHelpAt(Doc(Src), U, line, ch);

        help.ShouldNotBeNull();
        help.Signatures.Count.ShouldBe(1);
        var sig = help.Signatures[0];
        sig.Parameters.Count.ShouldBe(2);
        sig.Parameters[0].Label.ShouldContain("a");
        sig.Parameters[1].Label.ShouldContain("b");
        help.ActiveParameter.ShouldBe(0);
    }

    [Fact]
    public void After_first_comma_active_parameter_is_one()
    {
        var line = 4;
        var lineText = Src.Replace("\r\n", "\n").Split('\n')[line];
        // Place the cursor right after the comma in `place(a: Decimal, b: Decimal)`.
        var ch = lineText.IndexOf(',', StringComparison.Ordinal) + 1;

        var help = Svc.SignatureHelpAt(Doc(Src), U, line, ch);

        help.ShouldNotBeNull();
        help.ActiveParameter.ShouldBe(1);
    }

    [Fact]
    public void Unresolved_callee_returns_null()
    {
        var src =
            "context C {\n" +
            "  value V { x: Decimal }\n" +
            "}\n";
        // Cursor at a position with no enclosing call paren / no resolvable callee.
        var help = Svc.SignatureHelpAt(Doc(src), U, 1, 14);
        help.ShouldBeNull();
    }
}
