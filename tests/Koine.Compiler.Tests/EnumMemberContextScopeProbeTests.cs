using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1739, Task 1: pins the PRE-FIX behavior for the concrete repro found while establishing
/// whether a cross-context enum-member collision is actually observable (the issue was filed as an
/// enhancement — two earlier hand-built attempts both validated clean). It IS observable: both models
/// below are legal R13.2 code — <c>C</c> declares its own <c>Flag</c> enum with both compared members,
/// and imports nothing from <c>A</c>/<c>D</c>/<c>E</c> — yet <c>main</c> rejects them, because
/// <c>Red</c> and <c>Blue</c> are EACH independently ambiguous model-wide (declared by ≥2 enums), so
/// neither side's <c>ConcreteEnumType</c> single-owner short-circuit can rescue the other, and there is
/// no enum-typed <c>expected</c> (the containing expression is <c>Bool</c>-typed) to fall back on.
/// <c>KOI0210</c> is the more telling symptom: <c>Marker</c>/<c>Signal</c> have no relationship to this
/// code at all — they leak in purely because <c>_enumMemberToType</c>'s last-write-wins fallback picked
/// whichever enum happens to be declared LAST in the file for each member name.
/// <para>
/// THROWAWAY: superseded by the permanent context-scoping regression test in
/// <c>SemanticTests</c>/<c>ModelIndexClassifyTests</c> once Task 2/3 land (this file documents the
/// pre-fix state as of the issue's own investigation, not a contract to keep green).
/// </para>
/// </summary>
public class EnumMemberContextScopeProbeTests
{
    private const string BareComparisonOnANonEnumTypedField = """
        context A {
          enum Status { Red }
        }

        context C {
          enum Flag { Red, Blue }
          value V {
            ok: Bool = Red == Blue
          }
        }

        context D {
          enum Marker { Red }
        }

        context E {
          enum Signal { Blue }
        }
        """;

    private const string BareComparisonInAnInvariant = """
        context A {
          enum Status { Red }
        }

        context C {
          enum Flag { Red, Blue }
          entity Item identified by ItemId {
            tag: Flag = Red
            invariant Red != Blue "sanity check with no declared-type hint"
          }
        }

        context D {
          enum Marker { Red }
        }

        context E {
          enum Signal { Blue }
        }
        """;

    [Fact]
    public void PreFix_a_locally_unambiguous_comparison_is_wrongly_rejected_via_unrelated_contexts()
    {
        var result = new KoineCompiler().Compile(BareComparisonOnANonEnumTypedField, new CSharpEmitter());

        result.Success.ShouldBeFalse(
            "issue #1739 repro: Red == Blue is unambiguous from C's own perspective (only Flag declares " +
            "either member there) but main's context-blind EnumsDeclaring/EnumMemberToType still rejects it");
        var codes = result.Diagnostics.Select(d => d.Code).ToList();
        codes.ShouldContain("KOI0213");
        codes.ShouldContain("KOI0210");
        result.Diagnostics.ShouldContain(d => d.Message.Contains("Marker") && d.Message.Contains("Signal"));
    }

    [Fact]
    public void PreFix_the_same_shape_reproduces_inside_an_invariant()
    {
        var result = new KoineCompiler().Compile(BareComparisonInAnInvariant, new CSharpEmitter());

        result.Success.ShouldBeFalse("confirms the repro is not specific to value-member initializers");
        result.Diagnostics.Select(d => d.Code).ShouldContain("KOI0213");
    }
}
