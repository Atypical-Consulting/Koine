using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// End-to-end coverage tying the resilience spine (error recovery → partial model) to the fidelity
/// spine (self-describing tree → round-trip): a single broken file no longer blanks the workspace,
/// it still round-trips byte-for-byte, and the valid declarations it recovers still emit compiling C#.
/// </summary>
public class ResilienceEndToEndTests
{
    // A representative broken file: a typo inside `Money` (recovered), a fully-valid sibling `Email`,
    // plus comments and blank lines around an error region.
    private const string BrokenSource =
        "// leading comment\n" +
        "context Billing {\n" +
        "\n" +
        "  value Money { amount: Decimal whre amount >= 0 }\n" +
        "\n" +
        "  // the good one\n" +
        "  value Email { address: String }\n" +
        "}\n" +
        "// trailer\n";

    [Fact]
    public Task Partial_model_and_diagnostics_for_a_broken_file()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(BrokenSource);
        return Verify(RenderPartialModel(model!, diagnostics)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Round_trips_a_file_with_comments_blank_lines_and_an_error_region()
    {
        var (model, _) = new KoineCompiler().Parse(BrokenSource);
        var printer = new AstPrinter(BrokenSource);

        // Even with an error region inside it, the file reconstructs verbatim (the context's span
        // covers the recovered tokens; leading/trailing trivia carry the surrounding comments).
        var printed = string.Concat(model!.Contexts.Select(printer.Print));
        printed.ShouldBe(BrokenSource);
    }

    [Fact]
    public void Valid_subtree_of_a_partially_recovered_model_still_emits_compiling_csharp()
    {
        var (model, _) = new KoineCompiler().Parse(BrokenSource);
        ContextNode recovered = model!.Contexts.Single();

        // The valid `Email` value object recovered intact (`address: String`) despite the broken
        // sibling — proving recovery did not corrupt the good subtree.
        var email = recovered.Types.OfType<ValueObjectDecl>().Single(t => t.Name == "Email");
        email.Members.Single().Type.Name.ShouldBe("String");

        // Emit just that recovered subtree and confirm Roslyn compiles it clean: error recovery does
        // not corrupt downstream emission for the valid declarations.
        var goodModel = new KoineModel([new ContextNode(
            recovered.Name, [email], [], [], [], [], [], [], [])]);
        var files = new CSharpEmitter().Emit(goodModel);
        var (assembly, errors) = TestSupport.Compile(files);

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
        assembly!.GetType("Billing.Email").ShouldNotBeNull();
    }

    /// <summary>Renders a stable, reviewable textual summary of a recovered partial model + its diagnostics.</summary>
    private static string RenderPartialModel(KoineModel model, IReadOnlyList<Diagnostics.Diagnostic> diagnostics)
    {
        var sb = new StringBuilder();
        foreach (ContextNode ctx in model.Contexts)
        {
            sb.Append("context ").Append(ctx.Name).Append('\n');
            foreach (TypeDecl type in ctx.Types)
            {
                sb.Append("  ").Append(type.GetType().Name).Append(' ').Append(type.Name);
                if (type is ValueObjectDecl vo)
                {
                    sb.Append(" { ")
                      .Append(string.Join(", ", vo.Members.Select(m => m.Name + ": " + m.Type.Name)))
                      .Append(" }");
                }

                sb.Append('\n');
            }

            foreach (ErrorNode error in ctx.Errors)
            {
                sb.Append("  error '").Append(error.Text).Append("' missing=").Append(error.IsMissing).Append('\n');
            }
        }

        sb.Append("---- diagnostics ----\n");
        foreach (Diagnostics.Diagnostic d in diagnostics)
        {
            sb.Append(d.Code).Append(' ').Append(d.Severity).Append('\n');
        }

        return sb.ToString();
    }
}
