using Antlr4.Runtime;
using Antlr4.Runtime.Atn;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Grammar;
using Koine.Compiler.Parsing;
using Koine.Compiler.Semantics;

namespace Koine.Compiler.Tests;

/// <summary>
/// Resilient syntax — validating a recovered PARTIAL model (Task 4). The semantic validator must
/// run over the recovery without throwing and without emitting spurious cascade diagnostics off the
/// error region (the empty-named placeholders / <see cref="ErrorNode"/> markers the builder fills in),
/// while still producing the full, correct semantic diagnostics for the genuinely-valid declarations.
/// </summary>
public class ResilienceValidatorTests
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

    // A leading `:` typo in `value Money` makes the first member unrecoverable: ANTLR recovers a
    // member whose TYPE is the empty-named placeholder `TypeRef("")`. The sibling `value Email`
    // parses cleanly but carries a real SEMANTIC error: an unknown type `Strng`. So validating the
    // recovered model must stay quiet over the error region yet still flag `Strng`.
    private const string PartialSource =
        "context Billing {\n" +
        "  value Money { : Decimal }\n" +          // syntax typo → recovered member with empty-named type placeholder
        "  value Email { address: Strng }\n" +     // VALID syntax, SEMANTIC error: unknown type 'Strng'
        "}\n";

    [Fact]
    public void Validating_a_recovered_partial_model_does_not_throw_and_reports_only_the_valid_siblings_semantic_error()
    {
        KoineModel model = BuildRecovered(PartialSource);

        // The recovery produced an empty-named placeholder member type and ErrorNode markers — the
        // very things that would, unguarded, trip a NRE or emit "unknown type ''". (Sanity-checking
        // the model proves the test exercises the recovery path, not a fully-valid parse.)
        ContextNode ctx = model.Contexts.Single();
        ctx.Errors.ShouldNotBeEmpty();
        ValueObjectDecl money = ctx.Types.OfType<ValueObjectDecl>().Single(v => v.Name == "Money");
        money.Members.ShouldContain(m => m.Type.Name.Length == 0, "expected an empty-named placeholder type");

        // Validating the partial model must not throw (the test running to completion proves no NRE).
        IReadOnlyList<Diagnostic> diagnostics = new SemanticValidator().Validate(new SemanticModel(model));

        // The valid sibling's genuine semantic error IS present — validation really ran over the recovery.
        diagnostics.ShouldContain(d =>
            d.Code == DiagnosticCodes.UnknownType && d.Message.Contains("'Strng'"));

        // No spurious cascade off the error region: in particular, no diagnostic reporting on the
        // empty-named placeholder ("unknown type ''"). Assert on the concrete set, not just a count.
        diagnostics.ShouldNotContain(d => d.Message.Contains("''"));
        diagnostics.ShouldNotContain(d => d.Message.Contains("'Decimal'")); // the placeholder member's name

        // The full diagnostic set is exactly the one genuine semantic error.
        Diagnostic only = diagnostics.ShouldHaveSingleItem();
        only.Code.ShouldBe(DiagnosticCodes.UnknownType);
        only.Message.ShouldContain("'Strng'");
    }

    // A duplicate entity field name is the single most common entity typo. It is validated-but-tolerated:
    // ValidateMembersAndInvariants reports KOI0103 yet keeps BOTH members, then ValidateStates runs for
    // every entity. Building its member lookup with `entity.Members.ToDictionary(m => m.Name, ...)` threw
    // ArgumentException on the collision; because built-in analyzers run unguarded, that crash aborted the
    // whole validate pass (and the LSP live-diagnostics loop), so the authored KOI0103 never surfaced. The
    // lookup must be built defensively (last-wins) so the duplicate yields a clean KOI0103, not a crash.
    private const string DuplicateFieldSource =
        "context C {\n" +
        "  entity E identified by EId {\n" +
        "    x: Int\n" +
        "    x: Int\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Validating_an_entity_with_a_duplicate_field_surfaces_KOI0103_instead_of_throwing()
    {
        KoineModel model = BuildRecovered(DuplicateFieldSource);

        // Validating must not throw (the test running to completion proves no ArgumentException from the
        // ValidateStates member lookup) and must surface the duplicate-member diagnostic authored for it.
        IReadOnlyList<Diagnostic> diagnostics = new SemanticValidator().Validate(new SemanticModel(model));

        diagnostics.ShouldContain(
            d => d.Code == DiagnosticCodes.DuplicateMember,
            "expected KOI0103 DuplicateMember for the duplicate field 'x'");
    }
}
