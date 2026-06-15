using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
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
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath == relativePath).Contents;
    }

    // ---- R4.1 doc comments -------------------------------------------------

    [Fact]
    public void Doc_comments_render_as_xml_summaries()
    {
        var money = Emit(Doced, new CSharpEmitter(), "Billing/Money.cs");

        Assert.Contains("/// <summary>A monetary amount in a specific currency.</summary>", money);
        // member doc + XML escaping of < > &
        Assert.Contains("/// <summary>The amount; never negative. Holds a List&lt;T&gt; &amp; co.</summary>", money);

        var currency = Emit(Doced, new CSharpEmitter(), "Billing/Currency.cs");
        Assert.Contains("/// <summary>Supported currencies.</summary>", currency);
    }

    [Fact]
    public void Doc_comments_do_not_break_compilation()
    {
        var result = new KoineCompiler().Compile(Doced, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Absent_doc_comment_emits_no_summary()
    {
        // `currency` has no doc; its property must not carry a <summary>.
        var money = Emit(Doced, new CSharpEmitter(), "Billing/Money.cs");
        var currencyProp = money.Split('\n').First(l => l.Contains("public Currency Currency"));
        Assert.DoesNotContain("<summary>", currencyProp);
    }

    [Fact]
    public void Ordinary_line_comments_are_not_captured()
    {
        const string src = "context C {\n  // not a doc comment\n  value V { x: Int }\n}\n";
        var v = Emit(src, new CSharpEmitter(), "C/V.cs");
        Assert.DoesNotContain("not a doc comment", v);
    }

    // ---- R4.2 glossary -----------------------------------------------------

    [Fact]
    public void Glossary_lists_contexts_types_kinds_docs_fields_and_rules()
    {
        var md = Emit(Doced, new GlossaryEmitter(), GlossaryEmitter.FileName);

        Assert.Contains("# Ubiquitous Language Glossary", md);
        Assert.Contains("## Billing", md);
        Assert.Contains("The billing bounded context.", md);   // context doc
        Assert.Contains("### Money — value", md);              // type + kind
        Assert.Contains("A monetary amount in a specific currency.", md); // type doc
        Assert.Contains("| amount | `Decimal` |", md);         // field + type
        Assert.Contains("### Currency — enum", md);
        Assert.Contains("Values: EUR, USD", md);
        Assert.Contains("**Business rules**", md);
        Assert.Contains("- a monetary amount cannot be negative", md); // invariant message
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
        Assert.Contains("### Order — aggregate (root: Order)", md);
        Assert.Contains("#### Order — entity", md);
        Assert.Contains("Identified by `OrderId`.", md);
    }

    [Fact]
    public void Glossary_is_byte_identical_on_reemit()
    {
        var first = Emit(Doced, new GlossaryEmitter(), GlossaryEmitter.FileName);
        var second = Emit(Doced, new GlossaryEmitter(), GlossaryEmitter.FileName);
        Assert.Equal(first, second);
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
        var v = Emit(src, new CSharpEmitter(), "C/V.cs");

        Assert.Contains("/// <summary>real doc for y</summary>", v);
        Assert.DoesNotContain("trailing on x", v);   // dropped, not mis-attached to y
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
        var v = Emit(src, new CSharpEmitter(), "C/V.cs");
        Assert.DoesNotContain("far away", v);
    }

    [Fact]
    public void Quadruple_slash_is_an_ordinary_comment_not_a_doc()
    {
        const string src =
            "context C {\n" +
            "  //// section divider, not a doc\n" +
            "  value V { x: Int }\n" +
            "}\n";
        var v = Emit(src, new CSharpEmitter(), "C/V.cs");
        Assert.DoesNotContain("<summary>", v);
        Assert.DoesNotContain("section divider", v);
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
        Assert.Contains("amount of &lt;Money&gt; &amp; co", md);
        Assert.DoesNotContain("<Money>", md);
    }
}
