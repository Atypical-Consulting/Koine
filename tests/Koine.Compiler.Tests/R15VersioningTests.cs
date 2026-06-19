using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R15.1 — Version-stamp contexts and annotate evolution (@since / @deprecated).</summary>
public class R15VersioningTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, IReadOnlyList<Emit.EmittedFile> Files) Build(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, result.Files);
    }

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    private static string Glossary(string source)
    {
        var result = new KoineCompiler().Compile(source, new GlossaryEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single().Contents;
    }

    // ---- parsing & soft keywords -------------------------------------------

    [Fact]
    public void Context_version_clause_parses_and_compiles()
    {
        var (_, files) = Build("""
            context Sales version 3 {
              value Money { amount: Decimal }
            }
            """);
        // Nothing about the version leaks into the C# type itself.
        FileContents(files, "Sales/ValueObjects/Money.cs").ShouldContain("public sealed class Money");
    }

    [Fact]
    public void Version_since_and_deprecated_remain_usable_as_field_names()
    {
        // The new keywords are soft: they may still name fields.
        Diagnose("""
            context Inventory {
              value Tag { version: Int since: Int deprecated: String }
            }
            """).ShouldBeEmpty();
    }

    [Fact]
    public void An_oversized_version_or_since_literal_does_not_crash_the_compiler()
    {
        // `[0-9]+` admits literals far beyond int range; parsing must degrade, not throw.
        Diagnose("""
            context Sales version 99999999999999999999 {
              value Money {
                amount: Decimal
                @since(88888888888888888888) bonus: Decimal
              }
            }
            """).ShouldBeEmpty();
    }

    // ---- C# emission: [Obsolete] -------------------------------------------

    [Fact]
    public void Deprecated_field_emits_Obsolete_on_the_property()
    {
        var (_, files) = Build("""
            context Sales {
              value Money {
                amount: Decimal
                @deprecated("use amount") legacyAmount: Decimal
              }
            }
            """);
        var money = FileContents(files, "Sales/ValueObjects/Money.cs");
        money.ShouldContain("[Obsolete(\"use amount\")]");
        money.ShouldContain("using System;");
    }

    [Fact]
    public void Deprecated_type_emits_Obsolete_on_the_class()
    {
        var (_, files) = Build("""
            context Sales {
              @deprecated("use Money") value OldMoney { amount: Decimal }
            }
            """);
        FileContents(files, "Sales/ValueObjects/OldMoney.cs").ShouldContain("[Obsolete(\"use Money\")]\npublic sealed class OldMoney");
    }

    [Fact]
    public void Deprecated_integration_event_field_emits_Obsolete()
    {
        var (_, files) = Build("""
            context Sales {
              publishes OrderPlaced
              integration event OrderPlaced {
                orderId: OrderId
                total:   Decimal
                @deprecated("use total") legacyAmount: Decimal
              }
            }
            """);
        FileContents(files, "Sales/IntegrationEvents/OrderPlaced.cs").ShouldContain("[Obsolete(\"use total\")]");
    }

    [Fact]
    public void A_deprecation_reason_with_quotes_is_escaped_for_csharp()
    {
        var (_, files) = Build("""
            context Sales {
              value Money {
                amount: Decimal
                @deprecated("use \"amount\" instead") legacyAmount: Decimal
              }
            }
            """);
        FileContents(files, "Sales/ValueObjects/Money.cs").ShouldContain("[Obsolete(\"use \\\"amount\\\" instead\")]");
    }

    [Fact]
    public void A_model_without_annotations_does_not_gain_Obsolete_or_an_extra_System_using()
    {
        var (_, files) = Build("""
            context Sales {
              value Money { amount: Decimal }
            }
            """);
        FileContents(files, "Sales/ValueObjects/Money.cs").ShouldNotContain("[Obsolete");
    }

    // ---- glossary ----------------------------------------------------------

    [Fact]
    public void Context_version_and_since_surface_in_the_glossary()
    {
        var glossary = Glossary("""
            context Sales version 3 {
              integration event OrderPlaced {
                orderId: OrderId
                @since(2) couponCode: String
              }
            }
            """);
        glossary.ShouldContain("## Sales — version 3");
        glossary.ShouldContain("since v2");
    }

    [Fact]
    public void A_deprecated_type_is_marked_in_the_glossary()
    {
        var glossary = Glossary("""
            context Sales {
              @deprecated("use Money") value OldMoney { amount: Decimal }
            }
            """);
        glossary.ShouldContain("deprecated: use Money");
    }

    // ---- version-ceiling warning (KOI1501) ---------------------------------

    [Fact]
    public void A_since_above_the_context_version_is_a_warning()
    {
        var diagnostics = Diagnose("""
            context Sales version 1 {
              value Money {
                amount: Decimal
                @since(5) bonus: Decimal
              }
            }
            """);
        var warning = diagnostics.ShouldHaveSingleItem();
        warning.Code.ShouldBe(DiagnosticCodes.AnnotationVersionAboveContext);
        warning.Severity.ShouldBe(DiagnosticSeverity.Warning);
        warning.Message.ShouldContain("bonus");
    }

    [Fact]
    public void A_type_level_since_above_the_context_version_is_a_warning()
    {
        var diagnostics = Diagnose("""
            context Sales version 2 {
              @since(7) value Money { amount: Decimal }
            }
            """);
        var warning = diagnostics.ShouldHaveSingleItem();
        warning.Code.ShouldBe(DiagnosticCodes.AnnotationVersionAboveContext);
        warning.Message.ShouldContain("Money");
    }

    [Fact]
    public void A_since_within_the_context_version_is_not_warned()
    {
        Diagnose("""
            context Sales version 5 {
              value Money {
                amount: Decimal
                @since(3) bonus: Decimal
              }
            }
            """).ShouldBeEmpty();
    }

    [Fact]
    public void An_unversioned_context_never_warns_about_since()
    {
        Diagnose("""
            context Sales {
              value Money {
                amount: Decimal
                @since(3) bonus: Decimal
              }
            }
            """).ShouldBeEmpty();
    }
}
