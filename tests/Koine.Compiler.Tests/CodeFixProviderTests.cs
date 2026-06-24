using Koine.Compiler.Ast;
using Koine.Compiler.CodeFixes;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The public code-fix platform (issue #69, Task 4): the diagnostic-keyed "Change to 'X'" quick fix
/// and the fix-all batching, both driven by the STRUCTURED <see cref="Diagnostic.Suggestion"/> — never
/// the message prose.
/// </summary>
public class CodeFixProviderTests
{
    private static readonly KoineCompiler Compiler = new();
    private static readonly CodeFixService Service = new();

    /// <summary>Parses and semantically validates <paramref name="src"/>, returning the diagnostics.</summary>
    private static (KoineModel Model, IReadOnlyList<Diagnostic> Diagnostics) Validate(string src)
    {
        var (model, parseDiags) = Compiler.Parse(src);
        model.ShouldNotBeNull();
        var diags = parseDiags.Concat(new SemanticValidator().Validate(model)).ToList();
        return (model, diags);
    }

    [Fact]
    public void Change_to_provider_derives_the_fix_from_the_structured_suggestion_not_the_message()
    {
        // A typo'd type reference: "Strng" instead of "String".
        var src = "context C {\n  value V { x: Strng }\n}\n";
        var (model, diags) = Validate(src);

        var unknown = diags.Single(d => d.Code == DiagnosticCodes.UnknownType);
        unknown.Suggestion.ShouldBe("String");                 // the validator populated the structured field
        unknown.Message.ShouldContain("did you mean 'String'"); // and kept the prose unchanged

        // BLANK the message to prove the provider does NOT scrape the prose — the fix must still be
        // correct, derived only from the structured Suggestion and the diagnostic's span.
        var prose = unknown with { Message = string.Empty };

        var fix = Service.FixesForDiagnostic(src, model, prose).ShouldHaveSingleItem();
        fix.Title.ShouldBe("Change to 'String'");
        fix.Kind.ShouldBe("quickfix");

        var edit = fix.Edits.ShouldHaveSingleItem();
        edit.NewText.ShouldBe("String");
        // The edit span is the diagnostic's span (where "Strng" sits), so applying it fixes the source.
        var applied = src[..edit.Range.Offset] + edit.NewText + src[(edit.Range.Offset + edit.Range.Length)..];
        applied.ShouldBe("context C {\n  value V { x: String }\n}\n");
    }

    [Fact]
    public void Change_to_provider_also_fixes_an_unknown_field_typo_from_structured_data()
    {
        // A misspelled field reference in an invariant: "amont" for "amount". Pre-platform the LSP
        // offered a "Change to X" quickfix for this (by scraping the prose); the structured path must
        // keep offering it, so this guards against the regression of narrowing the fix to KOI0101 only.
        var src = "context C {\n  value V {\n    amount: Int\n    invariant amont > 0\n  }\n}\n";
        var (model, diags) = Validate(src);

        var unknownField = diags.Single(d => d.Code == DiagnosticCodes.UnknownField);
        unknownField.Suggestion.ShouldBe("amount");

        // Blank the message to prove the fix comes from the structured Suggestion, not the prose.
        var fix = Service.FixesForDiagnostic(src, model, unknownField with { Message = string.Empty })
            .ShouldHaveSingleItem();
        fix.Title.ShouldBe("Change to 'amount'");

        var edit = fix.Edits.ShouldHaveSingleItem();
        var applied = src[..edit.Range.Offset] + edit.NewText + src[(edit.Range.Offset + edit.Range.Length)..];
        applied.ShouldBe("context C {\n  value V {\n    amount: Int\n    invariant amount > 0\n  }\n}\n");
    }

    [Fact]
    public void Fix_all_aggregates_two_same_code_diagnostics_into_one_edit_set_by_equivalence_key()
    {
        // Two unknown-type typos of the SAME name in one document, both suggesting "String".
        var src = "context C {\n  value V { a: Strng, b: Strng }\n}\n";
        var (model, diags) = Validate(src);

        var unknowns = diags.Where(d => d.Code == DiagnosticCodes.UnknownType).ToList();
        unknowns.Count.ShouldBe(2);
        unknowns.ShouldAllBe(d => d.Suggestion == "String");

        // Fix-all collapses the per-diagnostic fixes that share an EquivalenceKey into ONE aggregated
        // CodeFix carrying BOTH edits.
        var fixAll = Service.FixAll(src, model, unknowns).ShouldHaveSingleItem();
        fixAll.EquivalenceKey.ShouldBe("ChangeTo:String");
        fixAll.Edits.Count.ShouldBe(2);
        fixAll.Edits.ShouldAllBe(e => e.NewText == "String");

        // Applying the aggregated edits (highest offset first) fixes BOTH occurrences.
        var applied = src;
        foreach (var edit in fixAll.Edits.OrderByDescending(e => e.Range.Offset))
        {
            applied = applied[..edit.Range.Offset] + edit.NewText + applied[(edit.Range.Offset + edit.Range.Length)..];
        }

        applied.ShouldBe("context C {\n  value V { a: String, b: String }\n}\n");
    }

    [Fact]
    public void Add_optional_marker_makes_the_field_optional_and_clears_the_KOI0401()
    {
        // 'b' is a non-optional Int whose initializer reads the optional sibling 'a' (Int?) with no
        // '??' fallback — the validator raises KOI0401 at 'b's member span.
        var src = "context C {\n  value V {\n    a: Int?\n    b: Int = a\n  }\n}\n";
        var (model, diags) = Validate(src);

        var optional = diags.Single(d => d.Code == DiagnosticCodes.OptionalAssignedToNonOptional);

        // Blank the message to prove the fix derives only from the structured span + model.
        var fix = Service.FixesForDiagnostic(src, model, optional with { Message = string.Empty })
            .ShouldHaveSingleItem();
        fix.Title.ShouldBe("Make 'b' optional");
        fix.Kind.ShouldBe("quickfix");

        var edit = fix.Edits.ShouldHaveSingleItem();
        edit.NewText.ShouldBe("?");
        var applied = src[..edit.Range.Offset] + edit.NewText + src[(edit.Range.Offset + edit.Range.Length)..];
        applied.ShouldBe("context C {\n  value V {\n    a: Int?\n    b: Int? = a\n  }\n}\n");

        // Re-validate: the KOI0401 is gone after applying the fix.
        var (_, afterDiags) = Validate(applied);
        afterDiags.ShouldNotContain(d => d.Code == DiagnosticCodes.OptionalAssignedToNonOptional);
    }

    [Fact]
    public void Rename_duplicate_member_renames_to_a_unique_name_and_clears_the_KOI0103()
    {
        // Two fields named 'x' on one value object: the second is a duplicate member (KOI0103).
        var src = "context C {\n  value V {\n    x: Int\n    x: String\n  }\n}\n";
        var (model, diags) = Validate(src);

        var dup = diags.Single(d => d.Code == DiagnosticCodes.DuplicateMember);

        var fix = Service.FixesForDiagnostic(src, model, dup with { Message = string.Empty })
            .ShouldHaveSingleItem();
        fix.Title.ShouldBe("Rename to 'x2'");
        fix.Kind.ShouldBe("quickfix");

        var edit = fix.Edits.ShouldHaveSingleItem();
        edit.NewText.ShouldBe("x2");
        var applied = src[..edit.Range.Offset] + edit.NewText + src[(edit.Range.Offset + edit.Range.Length)..];
        applied.ShouldBe("context C {\n  value V {\n    x: Int\n    x2: String\n  }\n}\n");

        var (_, afterDiags) = Validate(applied);
        afterDiags.ShouldNotContain(d => d.Code == DiagnosticCodes.DuplicateMember);
    }

    [Fact]
    public void Rename_duplicate_type_renames_to_a_unique_name_and_clears_the_KOI0102()
    {
        // Two value objects named 'V': the second is a duplicate type (KOI0102).
        var src = "context C {\n  value V { a: Int }\n  value V { b: Int }\n}\n";
        var (model, diags) = Validate(src);

        var dup = diags.Single(d => d.Code == DiagnosticCodes.DuplicateType);

        var fix = Service.FixesForDiagnostic(src, model, dup with { Message = string.Empty })
            .ShouldHaveSingleItem();
        fix.Title.ShouldBe("Rename to 'V2'");

        var edit = fix.Edits.ShouldHaveSingleItem();
        edit.NewText.ShouldBe("V2");
        var applied = src[..edit.Range.Offset] + edit.NewText + src[(edit.Range.Offset + edit.Range.Length)..];
        applied.ShouldBe("context C {\n  value V { a: Int }\n  value V2 { b: Int }\n}\n");

        var (_, afterDiags) = Validate(applied);
        afterDiags.ShouldNotContain(d => d.Code == DiagnosticCodes.DuplicateType);
    }

    [Fact]
    public void Rename_duplicate_enum_member_renames_the_last_occurrence_and_clears_the_KOI0104()
    {
        // An enum declaring 'Red' twice: KOI0104, whose span is the WHOLE enum (coarse). The fix
        // must rename the LAST occurrence of the duplicate name inside that span.
        var src = "context C {\n  enum Color { Red, Green, Red }\n}\n";
        var (model, diags) = Validate(src);

        var dup = diags.Single(d => d.Code == DiagnosticCodes.DuplicateEnumMember);

        var fix = Service.FixesForDiagnostic(src, model, dup with { Message = string.Empty })
            .ShouldHaveSingleItem();
        fix.Title.ShouldBe("Rename to 'Red2'");

        var edit = fix.Edits.ShouldHaveSingleItem();
        edit.NewText.ShouldBe("Red2");
        var applied = src[..edit.Range.Offset] + edit.NewText + src[(edit.Range.Offset + edit.Range.Length)..];
        applied.ShouldBe("context C {\n  enum Color { Red, Green, Red2 }\n}\n");

        var (_, afterDiags) = Validate(applied);
        afterDiags.ShouldNotContain(d => d.Code == DiagnosticCodes.DuplicateEnumMember);
    }
}
