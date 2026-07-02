using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R4 — Ubiquitous Language Documentation &amp; Glossary.</summary>
public class R4DocsTests
{
    private const string Doced = """
        /// The billing bounded context.
        context Billing {
          /// Supported currencies.
          enum Currency { EUR, USD }

          /// A monetary amount in a specific currency.
          value Money {
            /// The amount; never negative. Holds a List<T> & co.
            amount: Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }
        }
        """;

    private static string Emit(string source, IEmitter emitter, string relativePath)
    {
        var result = new KoineCompiler().Compile(source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath == relativePath).Contents;
    }

    // ---- R4.1 doc comments -------------------------------------------------

    [Fact]
    public void Doc_comments_render_as_xml_summaries()
    {
        var money = Emit(Doced, new CSharpEmitter(), "Billing/ValueObjects/Money.cs");

        money.ShouldContain("/// <summary>A monetary amount in a specific currency.</summary>");
        // member doc + XML escaping of < > &
        money.ShouldContain("/// <summary>The amount; never negative. Holds a List&lt;T&gt; &amp; co.</summary>");

        var currency = Emit(Doced, new CSharpEmitter(), "Billing/Enums/Currency.cs");
        currency.ShouldContain("/// <summary>Supported currencies.</summary>");
    }

    [Fact]
    public void Doc_comments_do_not_break_compilation()
    {
        var result = new KoineCompiler().Compile(Doced, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Absent_doc_comment_emits_no_summary()
    {
        // `currency` has no doc; its property must not carry a <summary>.
        var money = Emit(Doced, new CSharpEmitter(), "Billing/ValueObjects/Money.cs");
        var currencyProp = money.Split('\n').First(l => l.Contains("public Currency Currency"));
        currencyProp.ShouldNotContain("<summary>");
    }

    [Fact]
    public void Ordinary_line_comments_are_not_captured()
    {
        const string src = "context C {\n  // not a doc comment\n  value V { x: Int }\n}\n";
        var v = Emit(src, new CSharpEmitter(), "C/ValueObjects/V.cs");
        v.ShouldNotContain("not a doc comment");
    }

    // ---- R4.2 glossary -----------------------------------------------------

    [Fact]
    public void Glossary_lists_contexts_types_kinds_docs_fields_and_rules()
    {
        var md = Emit(Doced, new GlossaryEmitter(), GlossaryEmitter.FileName);

        md.ShouldContain("# Ubiquitous Language Glossary");
        md.ShouldContain("## Billing");
        md.ShouldContain("The billing bounded context.");   // context doc
        md.ShouldContain("### Money — value");              // type + kind
        md.ShouldContain("A monetary amount in a specific currency."); // type doc
        md.ShouldContain("| amount | `Decimal` |");         // field + type
        md.ShouldContain("### Currency — enum");
        md.ShouldContain("Values: EUR, USD");
        md.ShouldContain("**Business rules**");
        md.ShouldContain("- a monetary amount cannot be negative"); // invariant message
    }

    [Fact]
    public void Glossary_renders_enum_associated_data()
    {
        // An enum carrying constant data (R9.1) must show its payload, not just bare member names —
        // aligning the glossary with the docs emitter.
        const string src =
            "context Catalog {\n" +
            "  enum Currency(symbol: String, decimals: Int) {\n" +
            "    EUR(\"€\", 2)\n" +
            "    USD(\"$\", 2)\n" +
            "  }\n" +
            "}\n";
        var md = Emit(src, new GlossaryEmitter(), GlossaryEmitter.FileName);
        md.ShouldContain("Values: EUR(\"€\", 2), USD(\"$\", 2)");
    }

    [Fact]
    public void Glossary_groups_nested_types_under_their_aggregate()
    {
        const string src =
            "context Ordering {\n" +
            "  aggregate Order root Order {\n" +
            "    entity Order identified by OrderId { customer: CustomerId }\n" +
            "  }\n" +
            "}\n";
        var md = Emit(src, new GlossaryEmitter(), GlossaryEmitter.FileName);
        md.ShouldContain("### Order — aggregate (root: Order)");
        md.ShouldContain("#### Order — entity");
        md.ShouldContain("Identified by `OrderId`.");
    }

    [Fact]
    public void Glossary_is_byte_identical_on_reemit()
    {
        var first = Emit(Doced, new GlossaryEmitter(), GlossaryEmitter.FileName);
        var second = Emit(Doced, new GlossaryEmitter(), GlossaryEmitter.FileName);
        second.ShouldBe(first);
    }

    // ---- regressions found by the R4 review --------------------------------

    [Fact]
    public void Trailing_doc_comment_is_not_attached_to_the_next_member()
    {
        const string src =
            "context C {\n" +
            "  value V {\n" +
            "    x: Int  /// trailing on x\n" +
            "    /// real doc for y\n" +
            "    y: Int\n" +
            "  }\n" +
            "}\n";
        var v = Emit(src, new CSharpEmitter(), "C/ValueObjects/V.cs");

        v.ShouldContain("/// <summary>real doc for y</summary>");
        v.ShouldNotContain("trailing on x");   // dropped, not mis-attached to y
    }

    [Fact]
    public void Doc_separated_by_a_blank_line_is_not_attached()
    {
        const string src =
            "context C {\n" +
            "  value V {\n" +
            "    /// far away\n" +
            "\n" +
            "    x: Int\n" +
            "  }\n" +
            "}\n";
        var v = Emit(src, new CSharpEmitter(), "C/ValueObjects/V.cs");
        v.ShouldNotContain("far away");
    }

    [Fact]
    public void Quadruple_slash_is_an_ordinary_comment_not_a_doc()
    {
        const string src =
            "context C {\n" +
            "  //// section divider, not a doc\n" +
            "  value V { x: Int }\n" +
            "}\n";
        var v = Emit(src, new CSharpEmitter(), "C/ValueObjects/V.cs");
        v.ShouldNotContain("<summary>");
        v.ShouldNotContain("section divider");
    }

    [Fact]
    public void Glossary_escapes_markdown_metacharacters()
    {
        const string src =
            "context G {\n" +
            "  value V {\n" +
            "    /// amount of <Money> & co\n" +
            "    a: Int\n" +
            "  }\n" +
            "}\n";
        var md = Emit(src, new GlossaryEmitter(), GlossaryEmitter.FileName);
        md.ShouldContain("amount of &lt;Money&gt; &amp; co");
        md.ShouldNotContain("<Money>");
    }
}
