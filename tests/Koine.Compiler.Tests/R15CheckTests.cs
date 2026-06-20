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

    /// <summary>
    /// Asserts a breaking change with <paramref name="code"/> is present. Used for integration-event
    /// payload changes, which now ALSO carry an event-level <see cref="DiagnosticCodes.PublishedEventShapeChanged"/>
    /// summary (issue #73, A2) alongside the per-field code.
    /// </summary>
    private static void AssertBreakingIncludes(CompatibilityReport report, string code)
    {
        report.HasBreakingChanges.ShouldBeTrue();
        report.Changes.ShouldContain(c => c.Impact == CompatibilityImpact.Breaking && c.Code == code);
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
        AssertBreakingIncludes(report, DiagnosticCodes.PublishedFieldRemoved);
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
        AssertBreakingIncludes(report, DiagnosticCodes.PublishedFieldTypeChanged);
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
        AssertBreakingIncludes(report, DiagnosticCodes.PublishedFieldNowRequired);
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
        AssertBreakingIncludes(report, DiagnosticCodes.PublishedRequiredFieldAdded);
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
        // Enum-value removal carries its own code (KOI1516), distinct from a record field removal.
        AssertSingleBreaking(report, DiagnosticCodes.PublishedEnumMemberRemoved);
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

    // ---- issue #73, thread A: rename / enum-removal / event-shape detection ----

    [Fact]
    public void Compat_DetectsRename()
    {
        // `total: Decimal` renamed to `amount: Decimal` — a single rename, not a remove + add.
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                amount:  Decimal
                note:    String?
              }
            }
            """);
        // The rename is reported as ONE rename, subsuming the remove + add: neither a field-removed nor
        // a required-field-added change appears. (An integration event also carries the KOI1517
        // event-shape summary, so this is not asserted as the sole change.)
        AssertBreakingIncludes(report, DiagnosticCodes.PublishedMemberRenamed);
        report.Changes.ShouldNotContain(c => c.Code == DiagnosticCodes.PublishedFieldRemoved);
        report.Changes.ShouldNotContain(c => c.Code == DiagnosticCodes.PublishedRequiredFieldAdded);
    }

    [Fact]
    public void Compat_AmbiguousSameShape_IsNotReportedAsRename()
    {
        // Baseline's `total: Decimal` is removed while TWO same-shape fields (tax, fee) are added.
        // The pairing is ambiguous, so it must NOT be guessed as a rename — report remove + adds.
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                note:    String?
                tax:     Decimal
                fee:     Decimal
              }
            }
            """);
        report.Changes.ShouldNotContain(c => c.Code == DiagnosticCodes.PublishedMemberRenamed);
        report.Changes.ShouldContain(c => c.Code == DiagnosticCodes.PublishedFieldRemoved);      // total removed
        report.Changes.ShouldContain(c => c.Code == DiagnosticCodes.PublishedRequiredFieldAdded); // tax / fee added
    }

    [Fact]
    public void Compat_EnumMemberRemoval_DistinctCode()
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
        // Enum-value removal is its own code, NOT the record-field PublishedFieldRemoved.
        AssertSingleBreaking(report, DiagnosticCodes.PublishedEnumMemberRemoved);
        report.Changes.ShouldNotContain(c => c.Code == DiagnosticCodes.PublishedFieldRemoved);
    }

    [Fact]
    public void Compat_IntegrationEventPayloadChange_IsBreaking()
    {
        // Retyping a payload field changes the event's wire shape: the per-field code AND an
        // event-level KOI1517 shape-change summary, both breaking.
        var report = Check(Baseline, """
            context Sales {
              integration event OrderPlaced {
                orderId: OrderId
                total:   Int
                note:    String?
              }
            }
            """);
        AssertBreakingIncludes(report, DiagnosticCodes.PublishedEventShapeChanged);
        report.Changes.ShouldContain(c => c.Code == DiagnosticCodes.PublishedEventShapeChanged && c.Message.Contains("OrderPlaced"));
    }
}
