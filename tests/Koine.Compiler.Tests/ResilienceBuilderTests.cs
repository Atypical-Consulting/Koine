using Antlr4.Runtime;
using Antlr4.Runtime.Atn;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;
using Koine.Compiler.Parsing;

namespace Koine.Compiler.Tests;

/// <summary>
/// Resilient syntax — the builder must surface ANTLR error-recovery points as target-agnostic
/// <see cref="ErrorNode"/> markers in the model instead of silently dropping them, while still
/// building every valid sibling declaration so one typo no longer blanks the whole file.
/// </summary>
public class ResilienceBuilderTests
{
    /// <summary>Replicates the LL + <see cref="DefaultErrorStrategy"/> recovery parse from KoineCompiler.ParseUnit.</summary>
    private static KoineModel BuildRecovered(string source, string file = "test.koi")
    {
        var input = new AntlrInputStream(source);
        var lexer = new KoineLexer(input);
        var tokens = new CommonTokenStream(lexer);
        var parser = new KoineParser(tokens);
        parser.ErrorHandler = new DefaultErrorStrategy();
        parser.Interpreter.PredictionMode = PredictionMode.LL;
        KoineParser.ProgramContext tree = parser.program();
        return new KoineModelBuilderVisitor(tokens, file).BuildModel(tree);
    }

    // One typo'd token (`whre` where `invariant` was meant) inside the first value object, with a
    // fully-valid sibling value object after it. ANTLR's recovery for this input (observed) reparses
    // `whre amount` as a member with a synthesized `<missing ':'>` token, then deletes the trailing
    // `>=` and `0` as error terminals.
    private const string TypoSource =
        "context Billing {\n" +
        "  value Money { amount: Decimal whre amount >= 0 }\n" +
        "  value Email { address: String }\n" +
        "}\n";

    [Fact]
    public void RecoveredTree_surfaces_error_markers_for_the_typo_region()
    {
        KoineModel model = BuildRecovered(TypoSource);

        ErrorNode[] errors = NodeWalker.Descendants(model).OfType<ErrorNode>().ToArray();

        // Recovery was surfaced rather than silently dropped.
        errors.ShouldNotBeEmpty();

        // The deleted `>=` and `0` tokens (around the typo) became error markers carrying their text.
        errors.ShouldContain(e => e.Text == ">=");
        errors.ShouldContain(e => e.Text == "0");
    }

    [Fact]
    public void RecoveredTree_marks_the_synthesized_missing_token()
    {
        KoineModel model = BuildRecovered(TypoSource);

        ErrorNode[] errors = NodeWalker.Descendants(model).OfType<ErrorNode>().ToArray();

        // ANTLR inserted a phantom `:` (single-token insertion) — surfaced as a zero-length, IsMissing marker.
        ErrorNode? missing = errors.FirstOrDefault(e => e.IsMissing);
        missing.ShouldNotBeNull();
        missing!.Span.Length.ShouldBe(0);
        missing.Text.ShouldContain("missing");
    }

    [Fact]
    public void ValidSibling_is_still_fully_built_despite_the_typo()
    {
        KoineModel model = BuildRecovered(TypoSource);

        // One typo no longer blanks the whole file: the sibling `value Email` is fully built.
        ValueObjectDecl email = NodeWalker.Descendants(model)
            .OfType<ValueObjectDecl>()
            .Single(v => v.Name == "Email");

        email.Members.ShouldHaveSingleItem();
        Member address = email.Members.Single();
        address.Name.ShouldBe("address");
        address.Type.Name.ShouldBe("String");
    }
}
