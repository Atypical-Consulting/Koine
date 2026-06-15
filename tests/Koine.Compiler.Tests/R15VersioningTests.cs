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
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, result.Files);
    }

    private static string FileContents(IEnumerable<Emit.EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    private static string Glossary(string source)
    {
        var result = new KoineCompiler().Compile(source, new GlossaryEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
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
        Assert.Contains("public sealed class Money", FileContents(files, "Sales/Money.cs"));
    }

    [Fact]
    public void Version_since_and_deprecated_remain_usable_as_field_names()
    {
        // The new keywords are soft: they may still name fields.
        Assert.Empty(Diagnose("""
            context Inventory {
              value Tag { version: Int since: Int deprecated: String }
            }
            """));
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
        var money = FileContents(files, "Sales/Money.cs");
        Assert.Contains("[Obsolete(\"use amount\")]", money);
        Assert.Contains("using System;", money);
    }

    [Fact]
    public void Deprecated_type_emits_Obsolete_on_the_class()
    {
        var (_, files) = Build("""
            context Sales {
              @deprecated("use Money") value OldMoney { amount: Decimal }
            }
            """);
        Assert.Contains("[Obsolete(\"use Money\")]\npublic sealed class OldMoney", FileContents(files, "Sales/OldMoney.cs"));
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
        Assert.Contains("[Obsolete(\"use total\")]", FileContents(files, "Sales/OrderPlaced.cs"));
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
        Assert.Contains("[Obsolete(\"use \\\"amount\\\" instead\")]", FileContents(files, "Sales/Money.cs"));
    }

    [Fact]
    public void A_model_without_annotations_does_not_gain_Obsolete_or_an_extra_System_using()
    {
        var (_, files) = Build("""
            context Sales {
              value Money { amount: Decimal }
            }
            """);
        Assert.DoesNotContain("[Obsolete", FileContents(files, "Sales/Money.cs"));
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
        Assert.Contains("## Sales — version 3", glossary);
        Assert.Contains("since v2", glossary);
    }

    [Fact]
    public void A_deprecated_type_is_marked_in_the_glossary()
    {
        var glossary = Glossary("""
            context Sales {
              @deprecated("use Money") value OldMoney { amount: Decimal }
            }
            """);
        Assert.Contains("deprecated: use Money", glossary);
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
        var warning = Assert.Single(diagnostics);
        Assert.Equal(DiagnosticCodes.AnnotationVersionAboveContext, warning.Code);
        Assert.Equal(DiagnosticSeverity.Warning, warning.Severity);
        Assert.Contains("bonus", warning.Message);
    }

    [Fact]
    public void A_type_level_since_above_the_context_version_is_a_warning()
    {
        var diagnostics = Diagnose("""
            context Sales version 2 {
              @since(7) value Money { amount: Decimal }
            }
            """);
        var warning = Assert.Single(diagnostics);
        Assert.Equal(DiagnosticCodes.AnnotationVersionAboveContext, warning.Code);
        Assert.Contains("Money", warning.Message);
    }

    [Fact]
    public void A_since_within_the_context_version_is_not_warned()
    {
        Assert.Empty(Diagnose("""
            context Sales version 5 {
              value Money {
                amount: Decimal
                @since(3) bonus: Decimal
              }
            }
            """));
    }

    [Fact]
    public void An_unversioned_context_never_warns_about_since()
    {
        Assert.Empty(Diagnose("""
            context Sales {
              value Money {
                amount: Decimal
                @since(3) bonus: Decimal
              }
            }
            """));
    }
}
