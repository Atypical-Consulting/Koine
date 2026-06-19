using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R15.2 — Backward-compatibility check of published surfaces against a baseline.</summary>
public class R15CheckTests
{
    private static KoineModel Model(string source)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(source);
        (model is not null).ShouldBeTrue(string.Join("\n", diagnostics.Select(d => d.ToString())));
        return model!;
    }

    private static CompatibilityReport Check(string baseline, string current) =>
        new CompatibilityChecker().Check(Model(baseline), Model(current));

    // A published integration event with a required and an optional field.
    private const string Baseline = """
        context Sales {
          integration event OrderPlaced {
            orderId: OrderId
            total:   Decimal
            note:    String?
          }
        }
        """;

    private static void AssertSingleBreaking(CompatibilityReport report, string code)
    {
        report.HasBreakingChanges.ShouldBeTrue();
        var breaking = report.Changes.Where(c => c.Impact == CompatibilityImpact.Breaking).ToList();
        var change = breaking.ShouldHaveSingleItem();
        change.Code.ShouldBe(code);
    }

    // ---- breaking changes --------------------------------------------------

    [Fact]
    public void Removing_a_published_event_is_breaking()
    {
        var report = Check(Baseline, "context Sales { }");
        AssertSingleBreaking(report, DiagnosticCodes.PublishedTypeRemoved);
        report.Changes[0].Message.ShouldContain("OrderPlaced");
    }

    [Fact]
    public void Removing_a_published_field_is_breaking()
    {
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                note:    String?
              }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedFieldRemoved);
        report.Changes[0].Message.ShouldContain("total");
    }

    [Fact]
    public void Changing_a_published_field_type_is_breaking()
    {
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                total:   Int
                note:    String?
              }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedFieldTypeChanged);
    }

    [Fact]
    public void Making_an_optional_field_required_is_breaking()
    {
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                total:   Decimal
                note:    String
              }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedFieldNowRequired);
    }

    [Fact]
    public void Adding_a_required_field_is_breaking()
    {
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                total:   Decimal
                note:    String?
                tax:     Decimal
              }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedRequiredFieldAdded);
    }

    // ---- additive (non-breaking) -------------------------------------------

    [Fact]
    public void Adding_an_optional_field_is_not_breaking()
    {
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                total:   Decimal
                note:    String?
                tax:     Decimal?
              }
            }
            """);
        report.HasBreakingChanges.ShouldBeFalse();
        report.Changes.ShouldContain(c => c.Impact == CompatibilityImpact.NonBreaking && c.Message.Contains("tax"));
    }

    [Fact]
    public void Adding_a_new_event_is_not_breaking()
    {
        var report = Check(Baseline, Baseline + """

            context Sales {
              integration event OrderShipped { orderId: OrderId }
            }
            """);
        report.HasBreakingChanges.ShouldBeFalse();
        report.Changes.ShouldContain(c => c.Message.Contains("OrderShipped"));
    }

    [Fact]
    public void Identical_models_report_no_changes()
    {
        Check(Baseline, Baseline).Changes.ShouldBeEmpty();
    }

    [Fact]
    public void A_change_to_an_internal_type_is_ignored()
    {
        var baseline = """
            context Sales {
              integration event OrderPlaced { orderId: OrderId }
              value Internal { a: Decimal b: Decimal }
            }
            """;
        var current = """
            context Sales {
              integration event OrderPlaced { orderId: OrderId }
              value Internal { a: Decimal }
            }
            """;
        Check(baseline, current).Changes.ShouldBeEmpty();
    }

    // ---- shared-kernel & open-host surfaces --------------------------------

    private const string SharedKernel = """
        context Sales {
          value Money { amount: Decimal currency: String }
        }
        context Billing { }
        contextmap {
          Sales <-> Billing : shared-kernel { Money }
        }
        """;

    [Fact]
    public void Removing_a_field_from_a_shared_kernel_type_is_breaking()
    {
        var report = Check(SharedKernel, """
            context Sales {
              value Money { amount: Decimal }
            }
            context Billing { }
            contextmap {
              Sales <-> Billing : shared-kernel { Money }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedFieldRemoved);
        report.Changes[0].Message.ShouldContain("shared-kernel");
    }

    [Fact]
    public void Removing_a_shared_kernel_type_is_breaking()
    {
        var report = Check(SharedKernel, """
            context Sales { }
            context Billing { }
            contextmap {
              Sales <-> Billing : shared-kernel { Money }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedTypeRemoved);
    }

    [Fact]
    public void An_open_host_value_object_field_made_required_is_breaking()
    {
        const string baseline = """
            context Sales {
              value Address { city: String zip: String? }
            }
            context Shipping { }
            contextmap { Sales -> Shipping : open-host }
            """;
        var report = Check(baseline, """
            context Sales {
              value Address { city: String zip: String }
            }
            context Shipping { }
            contextmap { Sales -> Shipping : open-host }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedFieldNowRequired);
    }

    [Fact]
    public void A_value_object_in_a_plain_context_is_not_a_published_surface()
    {
        // No relation makes Sales an open host, so Address is internal: removing it is ignored.
        const string baseline = """
            context Sales {
              value Address { city: String }
            }
            """;
        Check(baseline, "context Sales { }").Changes.ShouldBeEmpty();
    }

    // ---- enums on a shared kernel ------------------------------------------

    private const string SharedEnum = """
        context Sales {
          enum Currency { EUR USD }
        }
        context Billing { }
        contextmap {
          Sales <-> Billing : shared-kernel { Currency }
        }
        """;

    [Fact]
    public void Removing_a_value_from_a_published_enum_is_breaking()
    {
        var report = Check(SharedEnum, """
            context Sales {
              enum Currency { EUR }
            }
            context Billing { }
            contextmap {
              Sales <-> Billing : shared-kernel { Currency }
            }
            """);
        AssertSingleBreaking(report, DiagnosticCodes.PublishedFieldRemoved);
    }

    [Fact]
    public void Adding_a_value_to_a_published_enum_is_not_breaking()
    {
        var report = Check(SharedEnum, """
            context Sales {
              enum Currency { EUR USD GBP }
            }
            context Billing { }
            contextmap {
              Sales <-> Billing : shared-kernel { Currency }
            }
            """);
        report.HasBreakingChanges.ShouldBeFalse();
        report.Changes.ShouldContain(c => c.Message.Contains("GBP"));
    }
}
