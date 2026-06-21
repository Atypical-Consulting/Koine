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
}
